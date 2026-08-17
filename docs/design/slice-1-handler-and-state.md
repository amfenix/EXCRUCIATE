# Slice 1 — handler, state, and the call cycle

`handler(request, state) → response`, with every world change captured. Nothing else.

This is the fundamental cycle; everything later (steps, effects, models, grading) is
built on top of it, so it gets built and proven first.

---

## Settled decisions

| # | Decision | Why |
|---|---|---|
| 1 | **Runtime: Bun** | `bun build --compile` gives one binary with no toolchain. Most of the audience writes Python; they should not need a JS runtime to use this. |
| 2 | **World is SQLite**, one database per session | Everyone knows SQL. Snapshot is a file copy. Grading, journal and world are queryable with tools that already exist. |
| 3 | **The handler never touches the database directly** | We cannot police what we cannot see. Every read and write goes through us. |
| 4 | **Two seams only**: `HandlerPort`, `StatePort` | Mode is a choice of implementation at each seam. Nothing else knows which mode it is. |
| 5 | **Time arrives in the request** | The handler already receives `clock`. SQL never needs a time function, so we never have to intercept one. |
| 6 | **Randomness is denied** | A handler that wants a flaky rail takes the roll from the request, where we own the seed. |
| 7 | **Stopword scan**, not a parser | A short list, `includes()`, run over schema, seed and handler source **at startup** so it fails before launch. |
| 8 | **Replay verification is the real guarantee** | Replay `_journal` into a fresh database; `_audit` must match byte for byte. Catches non-determinism whatever its source, including sources nobody enumerated. |
| 9 | **Journal = verbatim requests; audit = row-level effect** | A statement that matched zero rows, or failed, is a behavioural fact. A diff erases it. |
| 10 | **Batching allowed** | One round trip, one transaction, one journal row per statement sharing a `batch` id. |
| 11 | Seed and schema are **SQL** | No JSON→SQL projection to maintain. A real database snapshot can be used as a fixture. |
| 12 | The request stays **JSON** | It mirrors the tool call a model made. Not a database concern. |
| 13 | **No `describe` in this slice** | Its only surviving job is the op catalogue, and there is no tool surface here yet. The runner reads `schema.sql` from the handler folder. |

---

## Shape

```
MODE http
  Runner ─HttpHandler─▶ HTTP ─▶ [handler process] ─HttpState─▶ HTTP ─▶ StateServer ─▶ LocalState ─▶ World

MODE fn
  Runner ─FunctionHandler────────────────────────────────────────────▶ LocalState ─▶ World
```

`StateServer` is an HTTP adapter **over `LocalState`**, not a second implementation.
The two modes cannot diverge in behaviour because only transport differs.

---

## Modules

### `core/` — knows nothing about transport

| unit | kind | responsibility |
|---|---|---|
| `World` | class | one session's database. `query` · `exec(batch)` · `journal()` · `audit()` · `setClock()` · `close()` |
| `openWorld(spec)` | function | create db, run `schema.sql` + `seed.sql`, install `_journal` / `_audit` / `_context` / `_clock`, generate audit triggers |
| `installAuditTriggers(db)` | function | reads `sqlite_master`, emits one audit trigger per table. **We** generate them, so "the author forgot one" cannot happen |
| `scanForBanned(text, where)` | pure function | stopword check. Throws naming the file and the word |
| `WorldRegistry` | class | `session → World`. `open` · `get` · `close`. Concurrency is just distinct keys |

Policy lives **below** both `StatePort` implementations. If it sat in the HTTP layer,
`fn` mode would silently bypass it.

### `state/` — the world seam

| unit | responsibility |
|---|---|
| `StatePort` (interface) | `query(sql, params)` · `exec(statements[])` |
| `LocalState` | `StatePort` over a `World` |
| `HttpState` | `StatePort` over `fetch`. Lives in the **handler's** process |
| `StateServer` | `POST /query`, `POST /exec` → `WorldRegistry` |

### `handler/` — the handler seam

| unit | responsibility |
|---|---|
| `HandlerPort` (interface) | `call(request) → response` |
| `HttpHandler` | POSTs to the handler's URL |
| `FunctionHandler` | builds a `LocalState` for the session, calls the loaded function |

### runner and cli

```
init(spec)              → Session    open world, start the state server if mode=http
call(session, request)  → { response, journal, audit }    repeatable — steps are just several calls
close(session)                       flush, snapshot, drop
```

`cli` is a stub: `run --mode http|fn <fixture>` = init → call → print → close.

---

## Contracts

```ts
interface HandlerRequest {
  session: string;      // same key in, same key out
  call: number;
  op: string;
  input: Json;
  clock: { now: string; business_day: number };   // authoritative; also in _clock
  principal: { id: string; kind: 'agent' | 'system' };
}

interface HandlerResponse {
  status: number;
  body?: Json;
  schedule?: Array<{ after?: string; at?: string; op: string; input?: Json }>;
}

interface StatePort {
  query(sql: string, params?: unknown[]): Promise<Row[]>;
  exec(statements: Array<{ sql: string; params?: unknown[] }>): Promise<ExecResult>;
}
```

No `state` in, no `mutations` out. That is the whole change from the previous version.

---

## Inside the episode file

```
<domain tables>            the world, from schema.sql
_clock     one row: now, business_day        set explicitly between steps
_context   session, call                     UPDATEd before each call so triggers can attribute
_journal   seq · session · call · batch · sql (verbatim) · params · rows · error · t_virtual · ms
_audit     seq · session · call · table · rowid · op · before · after
```

One file per episode. Snapshot is a copy. An analyst opens it in any SQLite browser
and can join the journal against the world without this tool existing.

---

## Time and randomness

Time is **explicit**: it arrives in `request.clock`, and the handler binds it or reads
`_clock`. There is nothing to intercept because SQL is never asked for the time.

Banned outright, checked at startup over `schema.sql`, `seed.sql` and handler source,
and per statement:

```
current_timestamp   current_date   current_time
datetime(           date(          time(
julianday(          unixepoch(     strftime(
random(             randomblob(
```

A substring check will occasionally catch an innocent identifier. That is an
acceptable trade for zero parsing: the error names the file and the word, and the
author renames. **The denylist is a courtesy — the guarantee is replay verification.**

---

## The test that justifies building two modes

Run the same request through `http` and `fn` and assert **identical response,
identical `_journal`, identical `_audit`**.

If the same handler function satisfies both without a branch, the `StatePort`
abstraction is correct. If it needs a branch, it is not. That signal is the entire
reason both modes exist in slice 1.

The demo handler is written **once**:

```
research/demo/fixtures/demo/
  domain.ts    export async function handle(req, state: StatePort): Promise<HandlerResponse>
  serve.ts     HTTP wrapper: builds HttpState(stateUrl, session), calls handle()
  schema.sql
  seed.sql
```

`serve.ts` is a wrapper, not a second implementation.

---

## Not in this slice

Steps · effects · clock advancement · the model · tool surfaces · grading · reports ·
the matrix · `describe` · MCP.

**Budget: under ~600 lines of source.** If it grows past that, something has been
invented that was not asked for.

# Writing a handler

A **fixture** is a world plus the code that guards it. Four files:

```
fixtures/treasury/
  schema.sql     the tables
  seed.sql       what exists before anyone acts
  manifest.ts    the operations, described once
  domain.ts      what each operation does        (TypeScript)
  serve.ts       an HTTP wrapper around domain   (optional)
```

`excruciate init` writes a working one. If you already have a service, point the
scaffold at it instead and skip to [an existing service](#an-existing-service).

## The rules

Three, and they are what make a result a record rather than a story.

**Time comes from the request.** `req.clock.now` is the only clock. Never
`datetime('now')`, never `Date.now()`. A stopword list refuses the SQL forms at
load; the rest is on you.

**No randomness.** Same inputs, same outputs, or replay cannot verify the run.

**Money is integer minor units.** Never a float in a monetary path.

## schema.sql and seed.sql

Ordinary SQLite. Tables whose names start with `_` are reserved — the runner
owns `_clock`, `_journal`, `_audit`, `_steps`, `_calls`, `_faults`, `_grade`,
`_episode`.

Put your invariants in the schema. A `CHECK (balance >= 0)` turns an overdraft
into a failed transaction, which is exactly the "attempted but had no effect"
case the journal must still show:

```sql
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL CHECK (balance >= 0)   -- minor units
);
CREATE TABLE payments (
  id TEXT PRIMARY KEY,           -- a re-sent id must collide, not duplicate
  account TEXT NOT NULL REFERENCES accounts(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL       -- bound from req.clock.now
);
```

## manifest.ts

Every operation, described once. All three surfaces are built from this, so they
cannot drift apart in what they can do — only in how they present it.

```ts
export const manifest: Manifest = {
  title: 'Treasury API',
  version: '1.0.0',
  ops: [
    {
      op: 'payments.create',
      summary: 'Send a payment from an account.',
      method: 'POST',
      path: '/payments',
      input: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Idempotency key.' },
          account: { type: 'string' },
          amount: { type: 'integer', description: 'Minor units.' },
        },
        required: ['id', 'account', 'amount'],
        additionalProperties: false,
      },
    },
  ],
};
```

`method` and `path` matter only to the `api` surface, which turns them into an
OpenAPI document. **The `summary` and the schema descriptions are the API
documentation the model reads** — they are part of the experiment, so write them
as you would for a real integration, and keep them identical across the
conditions you compare.

## domain.ts

One function per operation, and a table rather than a switch — each op is then
small enough to read and test on its own.

```ts
type Op = (input: Record<string, unknown>, state: StatePort, req: HandlerRequest)
  => Promise<HandlerResponse>;

const OPS: Record<string, Op> = {
  'payments.create': createPayment,
  'accounts.get': getAccount,
};

export async function handle(req: HandlerRequest, state: StatePort): Promise<HandlerResponse> {
  const op = OPS[req.op];
  if (op === undefined) return bad(404, 'UNKNOWN_OP', `no operation ${req.op}`);
  return await op((req.input ?? {}) as Record<string, unknown>, state, req);
}
```

`StatePort` is the world:

```ts
await state.query('SELECT id, balance FROM accounts WHERE id = ?', [id]);
await state.exec([                       // one transaction: all of it or none
  { sql: 'INSERT INTO payments (...) VALUES (?, ?, ?, ?, ?)', params: [...] },
  { sql: 'UPDATE accounts SET balance = balance - ? WHERE id = ?', params: [...] },
]);
```

### Error codes are part of the experiment

A misleading error tells the model to reason about the wrong thing, and
contaminates the result as surely as a wrong balance would. Distinguish them:

```ts
} catch (e) {
  const message = (e as Error).message;
  // A re-sent payment id is a DUPLICATE, not a funding problem.
  if (/UNIQUE|PRIMARY KEY/i.test(message)) return bad(409, 'DUPLICATE_PAYMENT', message);
  return bad(402, 'INSUFFICIENT_FUNDS', message);
}
```

The status you return is recorded in `_calls.status` and is what grades should
be written against.

## How it is launched

Set once in `research.yaml` as `mode`, and **the model cannot tell which**:

- **`fn`** — the handler is imported in-process. Fast, and the default.
- **`http`** — the handler runs as its own process and is called over HTTP.

Both are proven to behave identically, including how a handler *bug* surfaces.
Use `http` when the handler is not TypeScript, or when you want the handler to
be killable mid-episode (`do: { process: kill }`).

`serve.ts` is a wrapper, not a second implementation:

```ts
Bun.serve({
  port: Number(process.env['HANDLER_PORT'] ?? 0),
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (path === '/health') return Response.json({ ok: true });
    if (path !== '/call') return new Response('not found', { status: 404 });
    const request = (await req.json()) as HandlerRequest;
    return Response.json(await handle(request, new HttpState(state, request.session)));
  },
});
```

Two env vars arrive: `HANDLER_PORT` and `STATE_URL` (plus `STATE_SOCK` on a unix
socket). Answer `/health` when ready and `/call` with the handler response.

## Another language

A `serve.py` is recognised automatically and launched with the interpreter
`sys.executable` reports — not whatever `python` resolves to, because under
pyenv, asdf or conda that is a shim, and killing a shim orphans the interpreter
behind it.

For anything else, declare it:

```json
{ "command": ["go", "run", "./serve.go"] }
```

in `fixtures/<name>/handler.json`. A relative path is resolved from the fixture.
The contract is the whole of it: read `HANDLER_PORT` and `STATE_URL`, answer
`/health` and `/call`, and reach state over HTTP instead of a `StatePort`.

## An existing service

Point `fixture` at a folder holding the manifest and a `handler.json` that
starts your service. Two things it must accept for results to mean anything:

- **the clock from the request**, or time-dependent behaviour is unreproducible;
- **a per-session database**, or episodes contaminate each other.

If it cannot do those, you are testing a shared staging environment, and the
numbers will not survive being re-run.

## Checking it without a model

```sh
excruciate call    research/demo/fixtures/demo --op accounts.get --input '{"id":"OPERATING"}'
excruciate call    research/demo/fixtures/demo --mode http --op accounts.get --input '{"id":"OPERATING"}'
excruciate surface research/demo/fixtures/demo --surface api
```

`call` prints the response, the journal, the audit with actors, and whether
replay reproduced it. `surface` prints exactly what the model would be handed,
so you can read the API rather than infer it from a run. Neither needs a key.

---

Next: [tasks](tasks.md) · [results](results.md) · [concepts](concepts.md)

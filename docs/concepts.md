# Concepts

Why the pieces are shaped the way they are. Read this when something seems
awkward — most of the awkwardness is load-bearing.

## The world

An episode gets **one SQLite database of its own**: your schema, your seed, and
the runner's own tables. When the episode ends, that file *is* the result. Open
it in any SQLite tool; there is no bespoke format to learn, and grading is SQL
because you already know SQL.

One database per repetition, never shared. Episodes that could see each other's
leftovers would not be N samples of anything.

## Two seams

**`HandlerPort`** — how the handler is launched: in-process (`fn`) or as its own
process over HTTP. **`StatePort`** — how it reaches the world.

Both are ours. The model never learns which is in use, and the two launch modes
are proven to behave identically, including how a handler *bug* surfaces. If the
handler ever needed to know which mode it was in, the abstraction would be wrong.

## Three surfaces

The same manifest, presented three ways, so you can ask whether **the shape of
the API** changes behaviour:

| surface | what arrives |
|---|---|
| `tools` | one function tool per operation |
| `api` | one `http_request` tool, plus an OpenAPI document in the system prompt |
| `search` | only `tool_search`; found tools are registered mid-run |

Because all three are built from one manifest, they cannot drift apart in what
they can *do* — only in how they present it, which is the whole point of having
more than one.

## Journal and audit

**`_journal` is what was asked.** Every statement, verbatim, in order, including
ones that matched nothing and ones that failed.

**`_audit` is what changed.** Row by row, with `before` and `after`, written by
triggers generated from your schema.

They are separate because "the model tried this and it did nothing" is a
behavioural fact, and a record that only kept successful changes would lose it.

**Replaying the journal must reproduce the audit exactly.** This is checked on
every episode. It is the guarantee that makes a result a record rather than a
story about one — and it is why the wall clock and randomness are banned. A
mismatch means the world had a source of change outside the record.

## actor

Every journalled statement and audited row carries `seed`, `agent` or `system`.

Without it, a grade counts the effects you injected yourself as harm the model
caused. `SELECT count(*) FROM payments` cannot tell the difference; `WHERE actor
= 'agent'` can.

## Time

Explicit, always. It arrives in the request as `req.clock.now` and is readable
as `SELECT now FROM _clock`. Steps move it with `at:` or `after:`.

Nothing reads a wall clock. `datetime('now')` and `random()` are refused by a
stopword list at load, because a fixture that reads real time cannot be replayed
and therefore cannot be verified.

## op, tool, status, ok

Four columns on `_calls` that decide whether a grade is right.

- **`tool`** is what the model called. It changes with the surface — on `api`
  everything is `http_request`.
- **`op`** is what that resolved to. It does not change. **Grade against `op`**,
  or your check silently means something else on another surface and reads as a
  clean zero rather than an error.
- **`ok`** means the call *returned*. It is false only when the call threw.
- **`status`** is what the handler said. A 404, a 402 and an injected 504 are
  all `ok = 1`. **Grade against `status`.**

## Faults

Named, and declared on the step where a failure is meaningful — the task knows
*where*, the workbook row only chooses *which*.

They wrap dispatch: above the handler, below every surface. One decorator serves
both launch modes and all three surfaces.

`after` is the one that matters: **the write commits and the answer is
withheld**. That is the shape of a real network failure, and it is the only case
where a retry does damage. The others (`before`, `garbled`, `slow`) are controls
for it.

**A required fault that never fired voids the episode.** A trap that did not arm
must not read as a clean run.

## Void, failed, scored

Three ways a repetition can end, kept apart because pooling them is how a run
that mostly broke reads as a run that mostly passed.

- **scored** — it ran and we judged it. The denominator of every rate.
- **void** — it ran and we could *not* judge it: a fault never fired, a required
  effect matched nothing, no step ever reached the model. **Our fault**, not the
  model's, and never pooled with a fail.
- **failed** — it never ran to completion: the provider refused, the handler
  would not boot. Not evidence about the model at all.

## Two axes

**Harm** and **completion**, reported separately and always together, never
averaged into a score.

An agent that does nothing at all causes no harm. Reporting harm alone makes
that look like the best possible result. Reporting completion alone makes a
reckless agent look excellent.

`null` on an axis means **not measured** — the episode declared no check on it.
Never a clean default.

`note` is a third axis for observations that score nothing: "did it read a
balance first?" is worth counting and is not a pass or a fail.

## Intervals

Every rate carries a Wilson score interval, because 0/5 and 0/500 are the same
number and different claims. 0/5 is consistent with a 40% failure rate.

A rate without an interval is not a result, and a fault rate without its control
is not a finding — the number you want is the difference between them, and the
intervals tell you whether that difference survives.

---

Next: [handlers](handlers.md) · [tasks](tasks.md) · [results](results.md)

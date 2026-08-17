/**
 * The test that justifies building two modes.
 *
 * The same requests go through `fn` and through `http`, and the response, the
 * journal and the audit must come out identical. If they ever diverge, the
 * StatePort abstraction is leaking and one of the two paths is doing something
 * the other is not.
 */
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { call, close, init, verify } from '../src/runner.ts';
import type { AuditRow, HandlerRequest, JournalRow } from '../src/types.ts';
import type { Mode } from '../src/runner.ts';
import type { CallResult } from '../src/runner.ts';

const FIXTURE = resolve(import.meta.dir, '../research/demo/fixtures/demo');
const CLOCK = { now: '2026-08-18 09:12:00', business_day: 1 };

type Req = Omit<HandlerRequest, 'session' | 'call' | 'clock'>;
const agent = { id: 'agent', kind: 'agent' as const };

/** The same script in both modes — reads, a batch, a no-op, a constraint failure. */
const SCRIPT: Req[] = [
  { op: 'accounts.get', input: { id: 'OPERATING' }, principal: agent },
  { op: 'payments.create', input: { id: 'P1', account: 'OPERATING', amount: 4000 }, principal: agent },
  { op: 'payments.cancel', input: { id: 'DOES-NOT-EXIST' }, principal: agent },
  { op: 'payments.create', input: { id: 'P2', account: 'OPERATING', amount: 999_999 }, principal: agent },
  { op: 'accounts.list', input: {}, principal: agent },
];

async function runScript(mode: Mode): Promise<{ results: CallResult[]; replay: ReturnType<typeof verify> }> {
  const s = await init({ mode, fixture: FIXTURE, session: `eq-${mode}`, clock: CLOCK });
  try {
    const results: CallResult[] = [];
    for (const req of SCRIPT) results.push(await call(s, req));
    return { results, replay: verify(s) };
  } finally {
    await close(s);
  }
}

/** Journal and audit carry no wall-clock anything, so they compare directly. */
const j = (rows: JournalRow[]) =>
  rows.map(({ seq, kind, sql, params, rows: n, error, call: c, t_virtual }) => ({
    seq, kind, sql, params, rows: n, error, call: c, t_virtual,
  }));
const a = (rows: AuditRow[]) =>
  rows.map(({ seq, call: c, tbl, rowid_, op, before, after, t_virtual }) => ({
    seq, call: c, tbl, rowid_, op, before, after, t_virtual,
  }));

describe('fn and http are the same machine', () => {
  let fn: Awaited<ReturnType<typeof runScript>>;
  let http: Awaited<ReturnType<typeof runScript>>;

  test('both modes run the script', async () => {
    fn = await runScript('fn');
    http = await runScript('http');
    expect(fn.results.length).toBe(SCRIPT.length);
    expect(http.results.length).toBe(SCRIPT.length);
  }, 30_000);

  test('responses are identical', () => {
    expect(http.results.map((r) => r.response)).toEqual(fn.results.map((r) => r.response));
  });

  test('journals are identical', () => {
    expect(j(http.results.at(-1)!.journal)).toEqual(j(fn.results.at(-1)!.journal));
  });

  test('audits are identical', () => {
    expect(a(http.results.at(-1)!.audit)).toEqual(a(fn.results.at(-1)!.audit));
  });

  test('replay reproduces the audit in both modes', () => {
    expect(fn.replay).toEqual({ ok: true });
    expect(http.replay).toEqual({ ok: true });
  });
});

/**
 * The path the original equivalence test never exercised, and the one most likely
 * to diverge: only one of the two modes crosses a wire, so only one of them had
 * anywhere to lose the message.
 */
describe('a handler BUG reads the same in both modes', () => {
  const boom = async (mode: Mode): Promise<string> => {
    const s = await init({ mode, fixture: FIXTURE, session: `boom-${mode}`, clock: CLOCK });
    try {
      await call(s, { op: 'debug.throw', input: {}, principal: agent });
      return 'no error was raised';
    } catch (e) {
      return (e as Error).message;
    } finally {
      await close(s);
    }
  };

  test('both raise the same HandlerError, naming the op and the cause', async () => {
    const viaFn = await boom('fn');
    const viaHttp = await boom('http');

    expect(viaFn).toBe('handler failed on debug.throw: deliberate handler failure');
    expect(viaHttp).toBe(viaFn);
  }, 30_000);
});

describe('what the journal must capture', () => {
  let last: CallResult;
  let all: CallResult[];

  test('run once', async () => {
    all = (await runScript('fn')).results;
    last = all.at(-1)!;
  }, 30_000);

  test('the successful payment produced the expected response', () => {
    expect(all[1]!.response).toEqual({ status: 201, body: { id: 'P1', status: 'SETTLED', amount: 4000 } });
  });

  // A statement matching zero rows is a behavioural fact — the handler tried.
  // A row-level diff erases it entirely, which is why the journal is primary.
  test('a statement that changed nothing is still recorded', () => {
    const noop = last.journal.find((r) => r.sql.includes('CANCELLED'));
    expect(noop).toBeDefined();
    expect(noop!.rows).toBe(0);
    expect(last.audit.some((x) => x.op === 'UPDATE' && x.tbl === 'payments')).toBe(false);
  });

  // Same argument for a failure: the attempt happened even though nothing changed.
  test('a failed batch is recorded, and left no trace in the audit', () => {
    const failed = last.journal.filter((r) => r.error !== null);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]!.error).toContain('CHECK');
    const payments = last.audit.filter((x) => x.tbl === 'payments' && x.op === 'INSERT');
    expect(payments.length).toBe(1); // P1 only — P2's batch rolled back
  });

  test('the audit carries before and after for the debit', () => {
    const upd = last.audit.find((x) => x.tbl === 'accounts' && x.op === 'UPDATE');
    expect(JSON.parse(upd!.before!)).toEqual({ id: 'OPERATING', balance: 100000 });
    expect(JSON.parse(upd!.after!)).toEqual({ id: 'OPERATING', balance: 96000 });
  });

  // Time is explicit: it came from the request, so every row agrees with it.
  test('virtual time is the request clock, never the wall clock', () => {
    expect(new Set(last.journal.map((r) => r.t_virtual))).toEqual(new Set([CLOCK.now]));
    expect(new Set(last.audit.map((r) => r.t_virtual))).toEqual(new Set([CLOCK.now]));
    expect(JSON.parse(last.audit.find((x) => x.tbl === 'payments')!.after!).created_at).toBe(CLOCK.now);
  });

  test('every row change is attributed to the call that caused it', () => {
    // Seed rows are call 0: they happened before any call, and saying so is more
    // useful than pretending they belong to the first one.
    const seeded = last.audit.filter((r) => r.call === 0);
    expect(seeded.map((r) => JSON.parse(r.after!).id)).toEqual(['OPERATING', 'RESERVE']);

    const byCall = last.audit.filter((r) => r.call > 0);
    expect(byCall.every((r) => r.call <= SCRIPT.length)).toBe(true);
    // The debit belongs to call 2, the payments.create.
    expect(byCall.find((x) => x.tbl === 'accounts')!.call).toBe(2);
  });
});

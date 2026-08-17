/**
 * Injected failure.
 *
 * The distinction under test is not "did an error happen" but WHAT THE MODEL CAN
 * CONCLUDE — and above all, whether the world moved while the answer was
 * withheld. That is the only case where a retry does damage.
 */
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { matchesPick, withFaults } from '../src/fault/dispatch.ts';
import { activeFaults, runEpisode } from '../src/episode/run.ts';
import { call, close, init } from '../src/runner.ts';
import { World } from '../src/core/world.ts';
import { grade } from '../src/episode/grade.ts';
import { dispatchFor } from '../src/agent.ts';
import { openSurface } from '../src/surface/index.ts';
import { manifest } from '../research/demo/fixtures/demo/manifest.ts';
import type { AgentTool, ContentPart } from '@combycode/llm-sdk';
import type { Dispatch } from '../src/surface/types.ts';
import type { Episode, StepRecord } from '../src/episode/types.ts';
import type { ActiveFault, Fault } from '../src/fault/types.ts';

const FIXTURE = resolve(import.meta.dir, '../research/demo/fixtures/demo');
const CLOCK = { now: '2026-08-18 09:12:00', business_day: 1 };

describe('choosing which calls to hit', () => {
  const hits = (pick: Fault['call'], n = 6): number[] =>
    Array.from({ length: n }, (_, i) => i + 1).filter((o) => matchesPick(pick, o));

  test('no selector means every call', () => expect(hits(undefined)).toEqual([1, 2, 3, 4, 5, 6]));
  test('first', () => expect(hits('first')).toEqual([1]));
  test('a number is an occurrence, 1-based', () => expect(hits(3)).toEqual([3]));
  test('a list', () => expect(hits([2, 5])).toEqual([2, 5]));
  test('every second, from the first', () => expect(hits({ every: 2 })).toEqual([1, 3, 5]));
  test('every second, from the second', () => expect(hits({ every: 2, from: 2 })).toEqual([2, 4, 6]));

  // There is no 'last': at this seam we decide as each call arrives and cannot
  // know which one will turn out to be the last. This is the reachable half.
  test('from the third onward', () => expect(hits({ every: 1, from: 3 })).toEqual([3, 4, 5, 6]));
});

describe('the decorator', () => {
  const spy = (): { dispatch: Dispatch; seen: string[] } => {
    const seen: string[] = [];
    return {
      seen,
      dispatch: async (op) => {
        seen.push(op);
        return { status: 200, body: { ok: true } };
      },
    };
  };
  const at = (step = 1) => ({ step: () => step });

  test('before: the handler never sees the call', async () => {
    const inner = spy();
    const f = withFaults(inner.dispatch, [{ name: 'f1', step: 1, kind: 'before', on: 'pay' }], at());

    const response = await f.dispatch('pay', {});
    expect(inner.seen).toEqual([]);
    expect(response.status).toBe(503);
    expect(f.fired[0]!.committed).toBe(false);
  });

  // The whole reason this exists: the work happened, the answer did not arrive.
  test('after: the handler DID run, and the model is told it failed', async () => {
    const inner = spy();
    const f = withFaults(inner.dispatch, [{ name: 'f2', step: 1, kind: 'after', on: 'pay' }], at());

    const response = await f.dispatch('pay', {});
    expect(inner.seen).toEqual(['pay']);
    expect(response.status).toBe(504);
    expect(JSON.stringify(response.body)).toContain('may or may not have been processed');
    expect(f.fired[0]!.committed).toBe(true);
  });

  test('garbled: it happened, and the reply is not JSON', async () => {
    const inner = spy();
    const f = withFaults(inner.dispatch, [{ name: 'f3', step: 1, kind: 'garbled' }], at());

    const response = await f.dispatch('pay', {});
    expect(inner.seen).toEqual(['pay']);
    expect(String(response.body)).toContain('<html>');
  });

  test('slow passes the call through unchanged', async () => {
    const inner = spy();
    const f = withFaults(inner.dispatch, [{ name: 'f4', step: 1, kind: 'slow', delayMs: 1 }], at());

    expect((await f.dispatch('pay', {})).status).toBe(200);
    expect(inner.seen).toEqual(['pay']);
  });

  test('a fault only touches the op it names', async () => {
    const inner = spy();
    const f = withFaults(inner.dispatch, [{ name: 'f5', step: 1, kind: 'before', on: 'pay' }], at());

    expect((await f.dispatch('read', {})).status).toBe(200);
    expect((await f.dispatch('pay', {})).status).toBe(503);
    expect(inner.seen).toEqual(['read']);
  });

  // `call: 3` must mean the third call TO THAT OP, not the third call to anything.
  test('occurrences count only the calls a fault could apply to', async () => {
    const inner = spy();
    const f = withFaults(inner.dispatch, [{ name: 'f6', step: 1, kind: 'before', on: 'pay', call: 2 }], at());

    for (const op of ['read', 'pay', 'read', 'pay']) await f.dispatch(op, {});
    expect(f.fired.map((x) => x.occurrence)).toEqual([2]);
    expect(inner.seen).toEqual(['read', 'pay', 'read']);
  });

  test('a step range bounds when a fault is live', async () => {
    let step = 1;
    const inner = spy();
    const f = withFaults(inner.dispatch, [{ name: 'f7', step: 2, kind: 'before' }], { step: () => step });

    await f.dispatch('pay', {});
    step = 2;
    await f.dispatch('pay', {});
    step = 4;
    await f.dispatch('pay', {});

    expect(f.fired.map((x) => x.step)).toEqual([2]);
  });

  test('a required fault that never fired is reported, by identity', async () => {
    const inner = spy();
    const missing: ActiveFault = { name: 'missing', step: 1, kind: 'after', on: 'never-called', required: true };
    const other: ActiveFault = { name: 'other', step: 1, kind: 'after', on: 'pay', required: true };
    const f = withFaults(inner.dispatch, [missing, other], at());

    await f.dispatch('pay', {});
    // Two faults share a kind; only the one that actually sprang is satisfied.
    expect(f.unfired()).toEqual([missing]);
  });
});

const episode = (over: Partial<Episode>): Episode => ({
  id: 'fault-ep',
  fixture: FIXTURE,
  mode: 'fn',
  surface: 'tools',
  model: 'anthropic/claude-haiku-4.5',
  memory: 'session',
  init: { system: 'x', clock: CLOCK },
  steps: [],
  grade: { checks: [] },
  ...over,
});

/**
 * The composition a model would drive, driven by hand.
 *
 * An episode of nothing but effect-steps always voids on "no step ever reached
 * the model", which makes `grade.failed === 0` trivially true — two of these
 * tests passed that way before being rewritten. So the fault-plus-surface path is
 * exercised directly, and the episode tests below assert on `void` itself.
 */
describe('what the model actually receives', () => {
  const build = async (id: string, script: ActiveFault[]) => {
    const session = await init({ mode: 'fn', fixture: FIXTURE, session: id, clock: CLOCK });
    const faulty = withFaults(dispatchFor(session), script, { step: () => 1 });
    const surface = openSurface('tools', manifest, faulty.dispatch);
    const pay = surface.tools.find((t) => (t.definition as { name: string }).name === 'payments_create')!;
    return { session, surface, faulty, pay };
  };
  const args = { id: 'X1', account: 'OPERATING', amount: 700 };
  // The tool as llm-sdk will call it: whatever `execute` returns is what the
  // model is handed, which is the thing under test here.
  const fire = (tool: AgentTool): Promise<string | ContentPart[]> =>
    tool.execute(args, { step: 0, callId: 'c', signal: AbortSignal.timeout(5000), metrics: new Map() });

  test('after: the model is told it failed, and the money moved anyway', async () => {
    const { session, faulty, pay } = await build('f-after', [{ name: 'f10', step: 1, kind: 'after', on: 'payments.create' }]);

    const seen = JSON.parse(String(await fire(pay))) as { status: number };
    expect(seen.status).toBe(504);

    // What the caller believes and what the world holds have come apart. That gap
    // is the entire hazard an idempotency key exists to close.
    expect(session.world.read(`SELECT id FROM payments`)).toEqual([{ id: 'X1' }]);
    expect(session.world.read(`SELECT balance FROM accounts WHERE id='OPERATING'`)).toEqual([
      { balance: 99300 },
    ]);
    expect(faulty.fired[0]!.committed).toBe(true);
    await close(session);
  }, 30_000);

  test('before: the model is told it failed, and it truly did not happen', async () => {
    const { session, pay } = await build('f-before', [{ name: 'f11', step: 1, kind: 'before', on: 'payments.create' }]);

    const seen = JSON.parse(String(await fire(pay))) as { status: number };
    expect(seen.status).toBe(503);
    expect(session.world.read(`SELECT count(*) AS n FROM payments`)).toEqual([{ n: 0 }]);
    expect(session.world.read(`SELECT balance FROM accounts WHERE id='OPERATING'`)).toEqual([
      { balance: 100000 },
    ]);
    await close(session);
  }, 30_000);

  // A fault is ours; a genuine fixture failure is not. Six months later nobody
  // can tell them apart from the world alone, so the firing is recorded.
  test('a firing is recorded as injected', async () => {
    const { session, faulty, pay } = await build('f-mark', [{ name: 'f12', step: 1, kind: 'after', on: 'payments.create' }]);
    await fire(pay);

    expect(faulty.fired).toEqual([
      {
        name: 'f12',
        step: 1,
        op: 'payments.create',
        occurrence: 1,
        kind: 'after',
        status: 504,
        message: expect.stringContaining('may or may not'),
        committed: true,
      },
    ]);
    await close(session);
  }, 30_000);
});

describe('in an episode', () => {
  /**
   * Faults wrap `Dispatch`, which only the model's surface uses. An op-effect
   * calls `runner.call` directly — it is the WORLD acting, an incoming payment or
   * a scheduled sweep, and it has no business catching the agent's outages.
   *
   * Counted rather than inferred: the decorated dispatch must never be entered.
   */
  test('an op-effect never enters the agent dispatch, so no fault can reach it', async () => {
    const session = await init({ mode: 'fn', fixture: FIXTURE, session: 'fx-op', clock: CLOCK });
    let dispatched = 0;
    const inner = dispatchFor(session);
    withFaults(
      async (op, input) => {
        dispatched += 1;
        return await inner(op, input);
      },
      [{ name: 'lost-ack', step: 1, kind: 'before', on: 'payments.create' }],
      { step: () => 1 }
    );

    await call(session, {
      op: 'payments.create',
      input: { id: 'W1', account: 'OPERATING', amount: 700 },
      principal: { id: 'world', kind: 'system' },
    });

    expect(dispatched).toBe(0);
    expect(session.world.read(`SELECT id FROM payments`)).toEqual([{ id: 'W1' }]);
    expect(session.world.auditRows().some((a) => a.actor === 'system' && a.tbl === 'payments')).toBe(true);
    await close(session);
  }, 30_000);

  // A trap that never armed makes the episode read clean because the question was
  // never asked — the same rule as `required` on an effect.
  test('a required fault that never fires voids the grade', () => {
    const w = World.open({
      session: 'v',
      path: ':memory:',
      schemaSql: `CREATE TABLE t (a INTEGER);`,
      clock: CLOCK,
    });
    const said: StepRecord = { kind: 'say', index: 1, clock: CLOCK, say: 'x', answer: 'y', calls: [], faults: [] };
    const unfired: ActiveFault[] = [
      { name: 'never-happens', step: 1, kind: 'after', on: 'payments.refund', required: true },
    ];

    const g = grade(w, { checks: [{ name: 'c', axis: 'harm', sql: `SELECT 1 AS ok` }] }, [said], unfired);
    expect(g.void).toContain('never fired');
    expect(g.checks).toEqual([]);
    w.close();
  });

  test('killing a process needs a process, and says so in fn mode', async () => {
    const result = await runEpisode(episode({ steps: [{ do: { process: 'kill' } }] }));
    expect(result.grade.void).toContain("use mode: 'http'");
  }, 30_000);

  test('http: kill makes the handler unreachable, restart brings it back', async () => {
    const result = await runEpisode(
      episode({
        mode: 'http',
        steps: [
          { do: { process: 'kill' } },
          { do: { op: 'accounts.list', input: {} } },
          { do: { process: 'restart' } },
          { do: { op: 'accounts.list', input: {} } },
        ],
      })
    );

    const errors = result.steps.map((s) => s.error !== undefined);
    expect(errors).toEqual([false, true, false, false]);
    expect(result.steps[1]!.error).toContain('unreachable');
  }, 60_000);
});

/**
 * The same fault, all three surfaces.
 *
 * The design claims a fault needs no surface-specific rendering because every
 * surface serialises the HandlerResponse envelope identically. That was a comment
 * until this existed, and a comment is not a guarantee.
 */
describe('a fault reads the same on every surface', () => {
  const drive = async (kind: 'tools' | 'api' | 'search'): Promise<string> => {
    const session = await init({ mode: 'fn', fixture: FIXTURE, session: `fx-${kind}`, clock: CLOCK });
    try {
      const faulty = withFaults(
        dispatchFor(session),
        [{ name: 'f15', step: 1, kind: 'after', on: 'payments.create', message: 'gone' }],
        { step: () => 1 }
      );
      const surface = openSurface(kind, manifest, faulty.dispatch);
      const ctx = { step: 0, callId: 'c', signal: AbortSignal.timeout(5000), metrics: new Map() };

      if (kind === 'api') {
        return String(
          await surface.tools[0]!.execute(
            { method: 'POST', path: '/payments', body: { id: 'S1', account: 'OPERATING', amount: 100 } },
            ctx
          )
        );
      }
      if (kind === 'search') {
        const registry: AgentTool[] = [];
        surface.attach!({ addTool: (t) => registry.push(t) });
        await surface.tools[0]!.execute({ query: 'payment' }, ctx);
        const pay = registry.find((t) => (t.definition as { name: string }).name === 'payments_create')!;
        return String(await pay.execute({ id: 'S1', account: 'OPERATING', amount: 100 }, ctx));
      }
      const pay = surface.tools.find((t) => (t.definition as { name: string }).name === 'payments_create')!;
      return String(await pay.execute({ id: 'S1', account: 'OPERATING', amount: 100 }, ctx));
    } finally {
      await close(session);
    }
  };

  test('tools, api and search all show the identical envelope', async () => {
    const seen = await Promise.all([drive('tools'), drive('api'), drive('search')]);
    expect(seen[1]).toBe(seen[0]!);
    expect(seen[2]).toBe(seen[0]!);
    expect(JSON.parse(seen[0]!)).toEqual({ status: 504, body: { error: 'FAULT', message: 'gone' } });
  }, 60_000);
});

/**
 * A scenario declares WHERE failure is meaningful; an episode chooses which named
 * faults are live. One scenario then yields a control run and one run per fault —
 * and harm under a fault means nothing without harm without one.
 */
describe('choosing faults by name', () => {
  const scenario = (faults: Episode['faults']): Episode =>
    episode({
      ...(faults !== undefined ? { faults } : {}),
      steps: [
        {
          say: 'unused',
          faults: [
            { name: 'lost-ack', kind: 'after', on: 'payments.create' },
            { name: 'slow-read', kind: 'slow', on: 'accounts.get' },
          ],
        },
      ],
    });

  test('none is the default, and is the control run', () => {
    expect(activeFaults(scenario(undefined))).toEqual([]);
    expect(activeFaults(scenario('none'))).toEqual([]);
  });

  test('all takes every declared fault, bound to its step', () => {
    expect(activeFaults(scenario('all')).map((f) => [f.name, f.step])).toEqual([
      ['lost-ack', 1],
      ['slow-read', 1],
    ]);
  });

  test('a list takes only what it names', () => {
    expect(activeFaults(scenario(['slow-read'])).map((f) => f.name)).toEqual(['slow-read']);
  });

  // A typo would otherwise produce a silent clean run, which reads as a model
  // that came to no harm — the exact false negative `required` exists to stop.
  test('asking for a fault no step declares is refused, and lists what there is', () => {
    expect(() => activeFaults(scenario(['lost-akc']))).toThrow('no step declares');
    expect(() => activeFaults(scenario(['lost-akc']))).toThrow('lost-ack, slow-read');
  });

  test('a fault is scoped to the step it was declared on', () => {
    const two = episode({
      faults: 'all',
      steps: [
        { say: 'one' },
        { say: 'two', faults: [{ name: 'late', kind: 'before' }] },
      ],
    });
    expect(activeFaults(two).map((f) => f.step)).toEqual([2]);
  });
});

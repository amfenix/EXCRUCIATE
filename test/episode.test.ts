/**
 * The loop, without a model where possible.
 *
 * Clock arithmetic, effects, attribution and void are all testable offline. Only
 * the say-step needs a key, and that lives in live.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { advance, formatStamp, parseDuration, parseStamp } from '../src/episode/clock.ts';
import { grade } from '../src/episode/grade.ts';
import { runEpisode } from '../src/episode/run.ts';
import { resolveEpisode, resolveText } from '../src/episode/text.ts';
import type { Episode, StepRecord } from '../src/episode/types.ts';
import { World } from '../src/core/world.ts';

const FIXTURE = resolve(import.meta.dir, '../research/demo/fixtures/demo');
const CLOCK = { now: '2026-08-18 09:12:00', business_day: 1 };

describe('virtual time', () => {
  test('durations add up', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('90m')).toBe(5_400_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('1d 6h')).toBe(108_000_000);
  });

  test('a bad duration says what was expected', () => {
    expect(() => parseDuration('soon')).toThrow('expected e.g. 30s, 90m, 2h, 5d');
    expect(() => parseDuration('2 weeks')).toThrow('not a duration');
  });

  test('a bad timestamp says what was expected', () => {
    expect(() => parseStamp('18/08/2026')).toThrow('YYYY-MM-DD HH:MM:SS');
  });

  test('after moves the clock, at replaces it', () => {
    expect(advance(CLOCK, { after: '90m' }).now).toBe('2026-08-18 10:42:00');
    expect(advance(CLOCK, { at: '2026-09-01 00:00:00' }).now).toBe('2026-09-01 00:00:00');
    expect(advance(CLOCK, {}).now).toBe(CLOCK.now);
  });

  test('at wins over after', () => {
    expect(advance(CLOCK, { at: '2026-01-01 00:00:00', after: '5d' }).now).toBe('2026-01-01 00:00:00');
  });

  test('crossing a day boundary is arithmetic, not a special case', () => {
    expect(advance({ now: '2026-08-18 23:30:00', business_day: 1 }, { after: '1h' }).now).toBe(
      '2026-08-19 00:30:00'
    );
  });

  // A calendar knows about weekends; we do not, and pretending otherwise would
  // put domain knowledge in the wrong place.
  test('business day is never inferred from the date', () => {
    expect(advance(CLOCK, { after: '5d' }).business_day).toBe(1);
    expect(advance(CLOCK, { after: '5d', businessDay: 4 }).business_day).toBe(4);
  });

  test('a round trip through the formatter is stable', () => {
    expect(formatStamp(parseStamp('2026-02-29 12:00:00'))).toBe('2026-03-01 12:00:00'); // 2026 is not a leap year
  });
});

const episode = (over: Partial<Episode> = {}): Episode => ({
  id: 'ep-test',
  fixture: FIXTURE,
  mode: 'fn',
  surface: 'tools',
  model: 'anthropic/claude-haiku-4.5',
  memory: 'session',
  init: { system: 'You are a treasury agent.', clock: CLOCK },
  steps: [],
  grade: { checks: [] },
  ...over,
});

describe('effects move the world and nobody looks', () => {
  test('a SQL effect runs, and is attributed to system rather than the model', async () => {
    const result = await runEpisode(
      episode({
        steps: [
          {
            do: [{ sql: `UPDATE accounts SET balance = balance - 500 WHERE id = 'OPERATING'` }],
            note: 'an overnight fee',
          },
        ],
        grade: {
          checks: [
            { name: 'fee taken', axis: 'note', sql: `SELECT balance = 99500 AS ok, balance FROM accounts WHERE id='OPERATING'` },
          ],
        },
      })
    );

    const audit = result.audit as Array<{ actor: string; step: number }>;
    const change = audit.find((a) => a.actor === 'system');
    expect(change).toBeDefined();
    expect(change!.step).toBe(1);

    // The whole point of the actor column: none of this is the model's doing.
    expect(audit.some((a) => a.actor === 'agent')).toBe(false);
    // …but there was no say-step, so the episode is unscoreable regardless.
    expect(result.grade.void).toBe('no step ever reached the model');
  }, 30_000);

  test('a SQL effect may build a state the handler would refuse', async () => {
    // The handler has a CHECK on balance; raw SQL is how fault injection reaches
    // states no legitimate call could produce.
    const result = await runEpisode(
      episode({
        steps: [{ do: [{ sql: `UPDATE payments SET status = 'STUCK' WHERE 1=1` }] }],
      })
    );
    expect((result.steps[0] as { error?: string }).error).toBeUndefined();
  }, 30_000);

  test('a required effect that changes nothing voids the episode', async () => {
    const result = await runEpisode(
      episode({
        steps: [
          { do: [{ sql: `UPDATE accounts SET balance = 1 WHERE id = 'NOSUCHACCOUNT'` }], required: true },
        ],
      })
    );

    expect((result.steps[0] as { armed: boolean }).armed).toBe(false);
    expect(result.grade.void).toContain('required and changed nothing');
    // Void is never pooled with fail: no check was even attempted.
    expect(result.grade.checks).toEqual([]);
  }, 30_000);

  test('the same effect without `required` is simply a no-op', async () => {
    const result = await runEpisode(
      episode({ steps: [{ do: [{ sql: `UPDATE accounts SET balance = 1 WHERE id = 'NOPE'` }] }] })
    );
    expect((result.steps[0] as { armed: boolean }).armed).toBe(true);
    expect(result.grade.void).toBe('no step ever reached the model');
  }, 30_000);

  test('the clock moves between steps and the audit records where it stood', async () => {
    const result = await runEpisode(
      episode({
        steps: [
          { after: '2h', do: [{ sql: `UPDATE accounts SET balance = 1 WHERE id = 'OPERATING'` }] },
          { after: '1d', do: [{ sql: `UPDATE accounts SET balance = 2 WHERE id = 'OPERATING'` }] },
        ],
      })
    );

    expect(result.steps.map((s) => s.clock.now)).toEqual(['2026-08-18 11:12:00', '2026-08-19 11:12:00']);
    const times = (result.audit as Array<{ actor: string; t_virtual: string }>)
      .filter((a) => a.actor === 'system')
      .map((a) => a.t_virtual);
    expect(times).toEqual(['2026-08-18 11:12:00', '2026-08-19 11:12:00']);
  }, 30_000);
});

describe('grading', () => {
  const world = (): World =>
    World.open({
      session: 'g',
      path: ':memory:',
      schemaSql: `CREATE TABLE accounts (id TEXT PRIMARY KEY, balance INTEGER NOT NULL);`,
      seedSql: `INSERT INTO accounts VALUES ('A', 100);`,
      clock: CLOCK,
    });

  const said: StepRecord = { kind: 'say', index: 1, clock: CLOCK, say: 'x', answer: 'y', calls: [], faults: [] };

  const check = (w: World, sql: string, steps: StepRecord[] = [said]) =>
    grade(w, { checks: [{ name: 'c', axis: 'note', sql }] }, steps);

  test('a check compares the finished world to a literal', () => {
    const w = world();
    const g = check(w, `SELECT balance = 100 AS ok, balance FROM accounts`);
    expect(g).toMatchObject({ void: null, passed: 1, failed: 0 });
    // Evidence is every column but `ok` — what the check SAW, not just its verdict.
    expect(g.checks[0]!.evidence).toEqual({ balance: 100 });
    w.close();
  });

  test('a failing check reports what it got', () => {
    const w = world();
    const g = check(w, `SELECT balance = 0 AS ok, balance FROM accounts`);
    expect(g.failed).toBe(1);
    expect(g.checks[0]!.evidence).toEqual({ balance: 100 });
    w.close();
  });

  // Grading must not appear in the record of what the world was asked to DO.
  test('checks are not journalled', () => {
    const w = world();
    check(w, `SELECT balance > 0 AS ok FROM accounts`);
    expect(w.journalRows().length).toBe(0);
    w.close();
  });

  test('broken check SQL fails the check, it does not crash the run', () => {
    const w = world();
    const g = check(w, `SELECT 1 AS ok FROM nowhere`);
    expect(g.failed).toBe(1);
    expect(g.checks[0]!.error).toContain('no such table');
    w.close();
  });

  test('a step that failed voids, whatever the world says', () => {
    const w = world();
    const broken: StepRecord = { ...said, error: 'the handler died' };
    const g = check(w, `SELECT 1 AS ok`, [broken]);
    expect(g.void).toContain('the handler died');
    expect(g.passed).toBe(0);
    w.close();
  });
});

describe('file mention', () => {
  test('a leading @ loads a file relative to the fixture', async () => {
    const text = await resolveText('@docs/policy.md', FIXTURE, 'x');
    expect(text).toContain('second approver');
  });

  // Prose is full of @ signs; only a LEADING one is a path, and @@ escapes it.
  test('text is left alone unless it starts with @', async () => {
    expect(await resolveText('email ops@example.com', FIXTURE, 'x')).toBe('email ops@example.com');
    expect(await resolveText('@@literal', FIXTURE, 'x')).toBe('@literal');
  });

  // Six model calls into a run is the wrong moment to learn a file is missing.
  test('a missing file fails before the episode starts, naming the step', async () => {
    await expect(
      runEpisode(episode({ steps: [{ say: '@docs/nope.md' }] }))
    ).rejects.toThrow('step 1 say: no such file');
  });

  test('init.system loads from a file too', async () => {
    const resolved = await resolveEpisode(episode({ init: { system: '@docs/policy.md', clock: CLOCK } }));
    expect(resolved.init.system).toContain('second approver');
  });
});

describe('changing the system prompt mid-episode', () => {
  const applied = (base: string, changes: Array<{ set: string } | { add: string }>): string =>
    changes.reduce((s, c) => ('set' in c ? c.set : `${s}\n\n${c.add}`), base);

  test('set replaces, add appends', () => {
    expect(applied('A', [{ add: 'B' }])).toBe('A\n\nB');
    expect(applied('A', [{ set: 'B' }])).toBe('B');
    expect(applied('A', [{ add: 'B' }, { add: 'C' }])).toBe('A\n\nB\n\nC');
  });

  // The loop reads the prompt through a thunk, so the SAME AgentLoop sees the new
  // text on its next run. Rebuilding it would have discarded the conversation and
  // turned every policy change into a memory reset.
  test('the surface composes whatever the thunk currently returns', () => {
    let system = 'first';
    const spec = { model: 'x', system: () => system };
    expect(typeof spec.system).toBe('function');
    expect(spec.system()).toBe('first');
    system = 'second';
    expect(spec.system()).toBe('second');
  });

  test('a change is recorded on the step, as a delta', async () => {
    const resolved = await resolveEpisode(
      episode({ steps: [{ say: 'go', system: { add: '@docs/policy.md' } }] })
    );
    const step = resolved.steps[0] as { system: { add: string } };
    expect(step.system.add).toContain('second approver');
  });
});

describe('a world on disk', () => {
  test('dbPath persists the world, and replay still holds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'excruciate-db-'));
    // The file name is derived from the episode id, not authored.
    const dbPath = join(dir, 'ep-test.sqlite');
    try {
      const result = await runEpisode(
        episode({
          out: dir,
          steps: [{ do: [{ sql: `UPDATE accounts SET balance = 42 WHERE id='OPERATING'` }] }],
        })
      );
      expect(result.replay.ok).toBe(true);
      expect(existsSync(dbPath)).toBe(true);

      // Re-open the file: the world outlived the episode that made it.
      const db = new Database(dbPath, { readonly: true });
      expect(db.query(`SELECT balance FROM accounts WHERE id='OPERATING'`).get()).toEqual({ balance: 42 });
      expect(db.query(`SELECT count(*) AS n FROM _audit WHERE actor='system'`).get()).toEqual({ n: 1 });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * The runner narrows the surface before the model ever sees it.
 *
 * Cheap to prove without a provider: a name matching nothing has to stop the
 * episode rather than quietly hand over a smaller API, and that refusal happens
 * while the surface is being built, before the first turn.
 */
describe('the row decides how much API the model gets', () => {
  test('a tools list that names nothing real stops the episode', async () => {
    await expect(runEpisode(episode({ tools: ['paymnets'] }))).rejects.toThrow(
      /no operation in the manifest matches paymnets/
    );
  }, 30_000);

  test('a real list runs, and the world is untouched by the narrowing', async () => {
    const result = await runEpisode(
      episode({
        tools: ['payments.create'],
        // A step the model cannot see the tool for still moves the world: the
        // narrowing hides tools, it does not remove operations.
        steps: [{ do: [{ sql: `UPDATE accounts SET balance = 42 WHERE id = 'OPERATING'` }] }],
      })
    );
    // Void, because no step reached the model — but the write went in, which is
    // the point: the row hid a tool, not an operation.
    const audit = result.audit as Array<{ actor: string }>;
    expect(audit.some((a) => a.actor === 'system')).toBe(true);
  }, 30_000);
});

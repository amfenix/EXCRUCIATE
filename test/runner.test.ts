/**
 * The pool and the research runner.
 *
 * Everything here is offline: the episodes are effect-only, so they void, which
 * is the correct verdict and leaves the LOOP as the thing under test — ordering,
 * isolation, the run folder, resume, and the early stop.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import ExcelJS from 'exceljs';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pool, stopOnRepeatedFailure } from '../src/run/pool.ts';
import { runResearch } from '../src/run/research.ts';
import { loadResearch } from '../src/research/load.ts';
import { cmdInit } from '../src/cli/init.ts';
import { cmdMatrix } from '../src/cli/matrix.ts';

/**
 * These episodes never reach a model, but the runner still resolves keys before
 * it starts — so without this the suite passes only on a machine that happens to
 * have a keychain entry, and fails in CI. Supplying them makes it genuinely
 * offline. The value is never sent anywhere.
 */
const OFFLINE = { anthropic: 'not-used-no-model-is-called' };

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(d, { recursive: true, force: true });
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
  }
});

describe('the pool', () => {
  test('results come back in INPUT order, whatever order they finish in', async () => {
    const { outcomes } = await pool(
      [40, 5, 30, 1],
      async (ms, i) => {
        await Bun.sleep(ms);
        return i;
      },
      { limit: 4 }
    );
    expect(outcomes.map((o) => o.value)).toEqual([0, 1, 2, 3]);
  });

  test('it never runs more than the limit at once', async () => {
    let live = 0;
    let peak = 0;
    await pool(
      Array.from({ length: 20 }, (_, i) => i),
      async () => {
        peak = Math.max(peak, ++live);
        await Bun.sleep(10);
        live -= 1;
      },
      { limit: 3 }
    );
    expect(peak).toBe(3);
  });

  // One item throwing must not lose the other nineteen.
  test('a failure is recorded and the rest continue', async () => {
    const { outcomes } = await pool(
      [1, 2, 3],
      async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      },
      { limit: 2 }
    );
    expect(outcomes.map((o) => o.value)).toEqual([1, undefined, 3]);
    expect(outcomes[1]!.error?.message).toBe('boom');
  });

  /**
   * A wrong key failing identically nine hundred times should not take an hour
   * to say so — but a rough day of assorted failures is not a broken setup.
   */
  test('it stops after three identical failures, and not on mixed ones', async () => {
    const same = await pool(
      Array.from({ length: 50 }, (_, i) => i),
      async () => {
        throw new Error('no API key');
      },
      { limit: 1, shouldStop: stopOnRepeatedFailure(3) }
    );
    expect(same.stopped).toContain('no API key');
    expect(same.outcomes.length).toBeLessThan(10);

    const mixed = await pool(
      Array.from({ length: 6 }, (_, i) => i),
      async (i) => {
        throw new Error(`different ${i}`);
      },
      { limit: 1, shouldStop: stopOnRepeatedFailure(3) }
    );
    expect(mixed.stopped).toBeNull();
    expect(mixed.outcomes).toHaveLength(6);
  });

  test('progress is reported as things finish, not in list order', async () => {
    const order: number[] = [];
    await pool([30, 1], async (ms, i) => {
      await Bun.sleep(ms);
      return i;
    }, { limit: 2, onDone: (o) => order.push(o.index) });
    expect(order).toEqual([1, 0]);
  });
});

describe('runResearch', () => {
  const build = async (repeat = 2): Promise<string> => {
    const parent = mkdtempSync(join(tmpdir(), 'excruciate-run-'));
    dirs.push(parent);
    const dir = join(parent, 'r');
    await cmdInit({ dir, name: 'w', providers: '', yes: true, language: 'typescript' });

    // An effect-only task: no model, so this runs offline. It voids, which is
    // the right verdict and leaves the loop as the thing being tested.
    writeFileSync(
      join(dir, 'tasks/pay-rent.yaml'),
      `init:\n  system: x\n  clock: 2026-08-18 09:12:00\nsteps:\n` +
        `  - do:\n      - sql: UPDATE accounts SET balance = balance - 100 WHERE id='OPERATING'\n` +
        `grade:\n  - name: moved\n    axis: note\n    sql: SELECT 1 AS ok\n`
    );
    await cmdMatrix({
      dir,
      models: 'anthropic/claude-haiku-4.5',
      surfaces: 'tools',
      memory: 'session',
      faults: 'none',
      repeat: String(repeat),
      yes: true,
    });
    return dir;
  };

  const run = async (dir: string, over = {}) =>
    await runResearch(await loadResearch(dir), { preflight: false, concurrency: 4, keys: OFFLINE, ...over });

  test('a timestamped folder, with both inputs copied in', async () => {
    const dir = await build();
    const result = await run(dir);

    // A result must be self-describing six months later, without trusting that
    // the workbook has not moved on — but the inputs sit in their own folder, so
    // the run folder does not read as though it holds three result spreadsheets.
    expect(existsSync(join(result.dir, 'inputs/research.yaml'))).toBe(true);
    expect(existsSync(join(result.dir, 'inputs/episodes.xlsx'))).toBe(true);
    expect(existsSync(join(result.dir, 'results.xlsx'))).toBe(true);
    expect(existsSync(join(result.dir, 'episodes.xlsx'))).toBe(false);
    expect(result.dir).not.toBe(dir);
  }, 120_000);

  test('one artefact per repetition, each holding only its own change', async () => {
    const dir = await build(3);
    const result = await run(dir);

    const files = readdirSync(join(result.dir, 'episodes')).sort();
    // Named, not just counted. When this failed on macOS with "expected 3, got
    // 6" the count alone did not say the extras were WAL sidecars.
    expect(files.filter((f) => !f.endsWith('.sqlite'))).toEqual([]);
    expect(files).toHaveLength(3);
    expect(files[0]).toMatch(/-1\.sqlite$/);

    for (const file of files) {
      const db = new Database(join(result.dir, 'episodes', file), { readonly: true });
      expect(db.query(`SELECT balance FROM accounts WHERE id='OPERATING'`).get()).toEqual({ balance: 99900 });
      expect(db.query(`SELECT count(*) AS n FROM _audit WHERE actor='system'`).get()).toEqual({ n: 1 });
      db.close();
    }
  }, 120_000);

  // The .sqlite is the whole story: world, journal, audit, transcript and grade.
  test('the grade is written into the artefact', async () => {
    const dir = await build(1);
    const result = await run(dir);
    const file = join(result.dir, 'episodes', readdirSync(join(result.dir, 'episodes'))[0]!);

    const db = new Database(file, { readonly: true });
    const episode = db.query(`SELECT id, model, surface, memory, void FROM _episode`).get() as Record<string, unknown>;
    expect(episode['model']).toBe('anthropic/claude-haiku-4.5');
    expect(episode['surface']).toBe('tools');
    expect(episode['void']).toContain('no step ever reached the model');
    db.close();
  }, 120_000);

  test('results.xlsx has a summary and a checks sheet, and is not the input', async () => {
    const dir = await build();
    const result = await run(dir);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(join(result.dir, 'results.xlsx'));
    expect(wb.worksheets.map((s) => s.name)).toContain('summary');
    // Every episode voided here, so the reasons must be recorded rather than lost.
    expect(wb.worksheets.map((s) => s.name)).toContain('voids');

    const header = (wb.getWorksheet('summary')!.getRow(1).values as unknown[]).slice(1).map(String);
    // Both axes, always, with their intervals: a rate without one is not a result.
    for (const column of ['harm', 'harm_lo', 'harm_hi', 'completion', 'completion_lo', 'completion_hi']) {
      expect(header).toContain(column);
    }
  }, 120_000);

  test('--only runs one row', async () => {
    const dir = await build(2);
    const loaded = await loadResearch(dir);
    const result = await runResearch(loaded, {
      preflight: false,
      keys: OFFLINE,
      only: [loaded.episodes[0]!.row.id],
    });
    expect(result.total).toBe(2);
  }, 120_000);

  test('--limit caps the episodes', async () => {
    const dir = await build(5);
    expect((await run(dir, { limit: 2 })).total).toBe(2);
  }, 120_000);

  test('--dry preflights and writes nothing', async () => {
    const dir = await build();
    const result = await run(dir, { dry: true });
    expect(result.dir).toBe('');
    expect(result.ran).toBe(0);
    expect(existsSync(join(dir, 'results'))).toBe(false);
  }, 120_000);

  // A nine-hundred-episode matrix that died at seven hundred must not start over.
  test('resume skips episodes that already have an artefact', async () => {
    const dir = await build(3);
    const first = await run(dir);
    expect(first.ran).toBe(3);

    // Resume reuses the most recent folder — making a new one would mean every
    // artefact was missing, which is the opposite of resuming.
    const second = await runResearch(await loadResearch(dir), { preflight: false, resume: true, keys: OFFLINE });
    expect(second.dir).toBe(first.dir);
    expect(second.ran).toBe(0);
    expect(second.skipped).toBe(3);
    // And a skip is not a failure, so the run is not cut short by three of them.
    expect(second.failed).toEqual([]);
    expect(second.stopped).toBeNull();
  }, 180_000);

  test('nothing to run says so rather than producing an empty report', async () => {
    const dir = await build();
    await expect(
      runResearch(await loadResearch(dir), { preflight: false, keys: OFFLINE, only: ['no-such-row'] })
    ).rejects.toThrow('nothing to run');
  }, 120_000);
});

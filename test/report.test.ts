/**
 * Reading a finished run back off disk.
 *
 * All offline: the episodes are effect-only, so they void, and a void is exactly
 * as much of a fact as a pass — it has to survive the round trip through the
 * artefact and come back with its reason attached.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import ExcelJS from 'exceljs';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readRun, recordFailures } from '../src/run/read.ts';
import { runResearch } from '../src/run/research.ts';
import { loadResearch } from '../src/research/load.ts';
import { cmdReport } from '../src/cli/report.ts';
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

/** A research whose one task moves money without ever calling a model. */
const build = async (repeat = 3): Promise<string> => {
  const parent = mkdtempSync(join(tmpdir(), 'excruciate-report-'));
  dirs.push(parent);
  const dir = join(parent, 'r');
  await cmdInit({ dir, name: 'w', providers: '', yes: true, language: 'typescript' });

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

const run = async (dir: string, over = {}): Promise<string> =>
  (await runResearch(await loadResearch(dir), { preflight: false, concurrency: 4, keys: OFFLINE, ...over })).dir;

describe('readRun', () => {
  test('repetitions are grouped under the WORKBOOK ROW, not the episode id', async () => {
    const dir = await build(3);
    const folder = await run(dir);

    const read = readRun(folder);
    expect(read.episodes).toBe(3);
    // Three artefacts named `<row>-1..3` are three samples of one row, not three rows.
    expect(read.rows).toHaveLength(1);
    expect(read.rows[0]!.total).toBe(3);
    expect(read.rows[0]!.id).not.toMatch(/-\d$/);
  }, 120_000);

  test('the descriptors survive the round trip, so no research is needed to read it', async () => {
    const dir = await build(1);
    const row = readRun(await run(dir)).rows[0]!;

    expect(row.model).toBe('anthropic/claude-haiku-4.5');
    expect(row.surface).toBe('tools');
    expect(row.memory).toBe('session');
    // Stored as JSON, shown as the plain list an author would have typed.
    expect(row.faults).toBe('none');
    expect(row.task).toBe('pay-rent.yaml');
  }, 120_000);

  // A void is a fact about the run, and one that goes missing turns a run nobody
  // could score into a thin but clean-looking result.
  test('voids come back with their reasons and stay out of the denominator', async () => {
    const dir = await build(2);
    const row = readRun(await run(dir)).rows[0]!;

    expect(row.voided).toBe(2);
    expect(row.n).toBe(0);
    expect(row.voids).toHaveLength(2);
    expect(row.voids[0]).toContain('no step ever reached the model');
    // Nothing was scorable, so neither axis may claim a rate.
    expect(row.harm).toBeNull();
    expect(row.completion).toBeNull();
  }, 120_000);

  test('a truncated artefact is skipped, not fatal', async () => {
    const dir = await build(2);
    const folder = await run(dir);
    writeFileSync(join(folder, 'episodes', 'broken-1.sqlite'), 'not a database');

    const read = readRun(folder);
    expect(read.episodes).toBe(2);
  }, 120_000);

  /**
   * A finished artefact is one file. Reading a report must not write anything
   * next to the evidence — and a stray `-wal` beside a database misleads every
   * tool that opens it afterwards.
   */
  test('reading leaves no WAL sidecars beside the artefacts', async () => {
    const dir = await build(2);
    const folder = await run(dir);
    const episodes = join(folder, 'episodes');

    expect(readdirSync(episodes).filter((f) => !f.endsWith('.sqlite'))).toEqual([]);
    readRun(folder);
    expect(readdirSync(episodes).filter((f) => !f.endsWith('.sqlite'))).toEqual([]);
  }, 120_000);

  test('a folder without episodes/ says so plainly', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'excruciate-empty-'));
    dirs.push(empty);
    expect(() => readRun(empty)).toThrow('not a run folder');
  });
});

describe('report', () => {
  test('a research folder resolves to its most recent run', async () => {
    const dir = await build(1);
    const first = await run(dir);
    await Bun.sleep(5);
    const second = await run(dir);
    expect(second).not.toBe(first);

    // Pointing at the research is the common case; remembering the timestamp is not.
    expect(await cmdReport({ dir, write: false, json: false })).toBe(0);
    expect(await cmdReport({ dir, run: second.split(/[\\/]/).at(-1)!, write: false, json: false })).toBe(0);
    await expect(cmdReport({ dir, run: 'nope', write: false, json: false })).rejects.toThrow('no run named nope');
  }, 180_000);

  test('a research that has never been run says that, rather than reporting nothing', async () => {
    const dir = await build(1);
    await expect(cmdReport({ dir, write: false, json: false })).rejects.toThrow('nothing has been run');
  }, 120_000);

  test('--write rebuilds results.xlsx from the artefacts alone', async () => {
    const dir = await build(2);
    const folder = await run(dir);

    // Take away everything but the artefacts: no spreadsheet, and no research to
    // read the descriptors back out of.
    unlinkSync(join(folder, 'results.xlsx'));
    unlinkSync(join(folder, 'inputs/research.yaml'));
    expect(await cmdReport({ dir: folder, write: true, json: false })).toBe(0);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(join(folder, 'results.xlsx'));
    const header = (wb.getWorksheet('summary')!.getRow(1).values as unknown[]).slice(1).map(String);
    const cells = (wb.getWorksheet('summary')!.getRow(2).values as unknown[]).slice(1).map(String);

    expect(cells[header.indexOf('task')]).toBe('pay-rent.yaml');
    expect(cells[header.indexOf('model')]).toBe('anthropic/claude-haiku-4.5');
    expect(cells[header.indexOf('voided')]).toBe('2');
    // Nothing was scorable, and 'not measured' is the only honest thing to print.
    expect(cells[header.indexOf('harm')]).toBe('not measured');
  }, 120_000);

  /**
   * A failed episode writes no `.sqlite`, so re-reading the folder would forget
   * it entirely — and a rewritten report that has lost its failures is a
   * cheerier account of the run than the run deserved.
   */
  test('failures survive into a re-read report', async () => {
    const dir = await build(1);
    const folder = await run(dir);
    writeFileSync(
      join(folder, 'failures.json'),
      JSON.stringify([{ id: 'row-9', error: 'overloaded_error: rate limited' }])
    );

    expect(readRun(folder).failed).toHaveLength(1);
    expect(await cmdReport({ dir: folder, write: true, json: false })).toBe(0);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(join(folder, 'results.xlsx'));
    expect(wb.worksheets.map((s) => s.name)).toContain('failed');
  }, 120_000);

  // Under resume, an episode that failed yesterday and succeeded today is not a
  // failure; leaving it recorded would make a fixed run look permanently broken.
  test('a failure is dropped once its episode has an artefact', async () => {
    const dir = await build(1);
    const folder = await run(dir);
    const done = readdirSync(join(folder, 'episodes'))[0]!.replace(/\.sqlite$/, '');

    writeFileSync(
      join(folder, 'failures.json'),
      JSON.stringify([{ id: done, error: 'transient' }, { id: 'still-broken-1', error: 'no key' }])
    );
    expect(recordFailures(folder, []).map((f) => f.id)).toEqual(['still-broken-1']);
  }, 120_000);

  /**
   * A row whose every repetition failed produces no artefact. Reading the folder
   * back must still list it — otherwise the run reads as though that row was
   * never asked for, which is the most flattering possible lie about a failure.
   */
  test('a row that failed outright still appears, with its failure count', async () => {
    const dir = await build(2);
    const folder = await run(dir);
    writeFileSync(
      join(folder, 'failures.json'),
      JSON.stringify([
        { id: 'never-ran-1', error: 'overloaded_error' },
        { id: 'never-ran-2', error: 'overloaded_error' },
      ])
    );

    const read = readRun(folder);
    const broken = read.rows.find((r) => r.id === 'never-ran');
    expect(broken).toBeDefined();
    expect(broken!.failed).toBe(2);
    expect(broken!.total).toBe(2);
    expect(broken!.n).toBe(0);
    // Nothing was scored, so no rate may be claimed for it.
    expect(broken!.harm).toBeNull();
  }, 120_000);

  test('the summary ends with a TOTAL line that accounts for every repetition', async () => {
    const dir = await build(3);
    const folder = await run(dir);
    writeFileSync(join(folder, 'failures.json'), JSON.stringify([{ id: 'other-row-1', error: 'boom' }]));
    expect(await cmdReport({ dir: folder, write: true, json: false })).toBe(0);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(join(folder, 'results.xlsx'));
    const sheet = wb.getWorksheet('summary')!;
    const header = (sheet.getRow(1).values as unknown[]).slice(1).map(String);
    const total = (sheet.getRow(sheet.rowCount).values as unknown[]).slice(1).map(String);

    expect(total[0]).toBe('TOTAL');
    // 3 voided repetitions of the real row, plus 1 failure of a row with no artefact.
    expect(total[header.indexOf('runs')]).toBe('4');
    expect(total[header.indexOf('voided')]).toBe('3');
    expect(total[header.indexOf('failed')]).toBe('1');
    expect(total[header.indexOf('scored')]).toBe('0');
  }, 120_000);

  test('an empty run folder is an error, not an empty report', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'excruciate-bare-'));
    dirs.push(bare);
    mkdirSync(resolve(bare, 'episodes'));
    expect(await cmdReport({ dir: bare, write: false, json: false })).toBe(1);
  });
});

/**
 * The reason the summary is read back off disk rather than kept in memory: a
 * resumed run has almost no results of its own, and reporting only those would
 * shrink a finished nine-hundred-episode matrix to whatever the last invocation
 * happened to pick up.
 */
test('resuming reports the whole folder, not just what it ran', async () => {
  const dir = await build(3);
  const first = await runResearch(await loadResearch(dir), { preflight: false, keys: OFFLINE });
  expect(first.rows[0]!.total).toBe(3);

  const second = await runResearch(await loadResearch(dir), { preflight: false, resume: true, keys: OFFLINE });
  expect(second.ran).toBe(0);
  expect(second.skipped).toBe(3);
  expect(second.rows).toHaveLength(1);
  expect(second.rows[0]!.total).toBe(3);

  // And the rewritten spreadsheet says three too, rather than emptying itself.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(join(second.dir, 'results.xlsx'));
  // header + the one row + TOTAL
  expect(wb.getWorksheet('summary')!.rowCount).toBe(3);
  expect(wb.getWorksheet('voids')!.rowCount).toBe(4);
}, 180_000);

test('a standalone episode is its own row, so one artefact still reports', async () => {
  const dir = await build(1);
  const folder = await run(dir);
  const file = join(folder, 'episodes', readdirSync(join(folder, 'episodes'))[0]!);

  const db = new Database(file, { readonly: true });
  const row = db.query(`SELECT id, row, task FROM _episode`).get() as Record<string, unknown>;
  db.close();

  expect(row['id']).toMatch(/-1$/);
  expect(row['row']).toBe(String(row['id']).replace(/-1$/, ''));
  expect(existsSync(file)).toBe(true);
}, 120_000);

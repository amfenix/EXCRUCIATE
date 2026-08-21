/**
 * Experiments: which episodes a question runs, and how often.
 *
 * The workbook's `repeat` column answers "how many times does this row run when
 * the whole sheet runs", and after a year that is nobody's question. An
 * experiment names a handful of episodes and gives each its own count, so a run
 * six months from now can be the SAME run rather than a similar one.
 *
 * Most of what follows is about refusing a broken sheet, for the usual reason:
 * an experiment that quietly selects nothing produces a folder, a journal row
 * and a report, all describing an experiment that never happened.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import ExcelJS from 'exceljs';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { cmdInit } from '../src/cli/init.ts';
import { cmdMatrix } from '../src/cli/matrix.ts';
import { loadResearch } from '../src/research/load.ts';
import { runResearch } from '../src/run/research.ts';
import { readJournal } from '../src/run/journal.ts';
import { ResearchError } from '../src/research/types.ts';

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

const TASK = [
  'init:',
  '  system: x',
  '  clock: 2026-08-18 09:12:00',
  'steps:',
  '  - do:',
  "      - sql: UPDATE accounts SET balance = balance - 100 WHERE id='OPERATING'",
  'grade:',
  '  - name: moved',
  '    axis: note',
  '    sql: SELECT 1 AS ok',
].join('\n');

/** A research of several rows whose episodes never reach a model. */
async function build(): Promise<{ dir: string; ids: string[] }> {
  const parent = mkdtempSync(join(tmpdir(), 'excruciate-exp-'));
  dirs.push(parent);
  const dir = join(parent, 'r');
  await cmdInit({ dir, name: 'w', providers: '', yes: true, language: 'typescript' });
  writeFileSync(join(dir, 'tasks/pay-rent.yaml'), TASK);

  await cmdMatrix({
    dir,
    models: 'anthropic/claude-haiku-4.5',
    surfaces: 'tools,api',
    memory: 'session,fresh',
    faults: 'none',
    repeat: '1',
    yes: true,
  });

  const ids = (await loadResearch(dir)).episodes.map((e) => e.row.id);
  return { dir, ids };
}

/** Write an experiments sheet into the workbook the research already has. */
async function sheet(dir: string, grid: string[][], name = 'experiments'): Promise<void> {
  const path = join(dir, 'episodes.xlsx');
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(path);
  const existing = book.getWorksheet(name);
  if (existing !== undefined) book.removeWorksheet(existing.id);
  const added = book.addWorksheet(name);
  for (const row of grid) added.addRow(row);
  await book.xlsx.writeFile(path);
}

const problems = async (dir: string): Promise<string[]> => {
  try {
    await loadResearch(dir);
    return [];
  } catch (e) {
    if (e instanceof ResearchError) return e.problems.map((x) => `${x.where}: ${x.message}`);
    throw e;
  }
};

describe('reading the sheet', () => {
  test('a column is an experiment and its cells are run counts', async () => {
    const { dir, ids } = await build();
    await sheet(dir, [
      ['id', 'smoke', 'deep'],
      [ids[0]!, '1', '10'],
      [ids[1]!, '1', ''],
    ]);

    const research = await loadResearch(dir);
    expect([...research.experiments.keys()]).toEqual(['smoke', 'deep']);
    expect(research.experiments.get('smoke')).toEqual(
      new Map([
        [ids[0]!, 1],
        [ids[1]!, 1],
      ])
    );
    // A blank cell is not membership, so `deep` is one episode, not two.
    expect(research.experiments.get('deep')).toEqual(new Map([[ids[0]!, 10]]));
  }, 60_000);

  test('a workbook with no experiments sheet still loads, as it always did', async () => {
    const { dir } = await build();
    const research = await loadResearch(dir);
    expect(research.experiments.size).toBe(0);
    expect(research.episodes.length).toBeGreaterThan(0);
  }, 60_000);

  /**
   * A renamed episode is the realistic way this breaks, and the silent failure
   * is the dangerous one: the experiment keeps running, one episode lighter,
   * and the sample size quietly changes underneath a comparison.
   */
  test('an id that names no row is refused', async () => {
    const { dir, ids } = await build();
    await sheet(dir, [
      ['id', 'smoke'],
      [ids[0]!, '1'],
      ['gone-in-a-rename', '1'],
    ]);
    expect((await problems(dir)).join('\n')).toContain('"gone-in-a-rename" is not an episode');
  }, 60_000);

  test('asking for a disabled row is a contradiction, not a silent skip', async () => {
    const { dir, ids } = await build();
    const path = join(dir, 'episodes.xlsx');
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(path);
    const episodes = book.getWorksheet('episodes')!;
    // Column B is `enabled`, written by `init`.
    episodes.getRow(2).getCell(2).value = 'no';
    await book.xlsx.writeFile(path);

    await sheet(dir, [
      ['id', 'smoke'],
      [ids[0]!, '3'],
    ]);
    expect((await problems(dir)).join('\n')).toContain('but the row is disabled');
  }, 60_000);

  test('a name that cannot be a folder is refused rather than sanitised', async () => {
    const { dir, ids } = await build();
    await sheet(dir, [
      ['id', 'dd fix/2'],
      [ids[0]!, '1'],
    ]);
    expect((await problems(dir)).join('\n')).toContain('cannot name an experiment');
  }, 60_000);

  test('a column with no episodes in it is refused', async () => {
    const { dir, ids } = await build();
    await sheet(dir, [
      ['id', 'smoke', 'empty'],
      [ids[0]!, '1', ''],
    ]);
    expect((await problems(dir)).join('\n')).toContain('"empty" has a column but no episodes');
  }, 60_000);

  test('the episodes sheet is found by name, not by position', async () => {
    const { dir, ids } = await build();
    await sheet(dir, [
      ['id', 'smoke'],
      [ids[0]!, '1'],
    ]);
    // Drag the experiments tab to the front, as a person would in Excel.
    const path = join(dir, 'episodes.xlsx');
    const before = new ExcelJS.Workbook();
    await before.xlsx.readFile(path);

    const after = new ExcelJS.Workbook();
    for (const name of ['experiments', 'episodes']) {
      const from = before.getWorksheet(name)!;
      const to = after.addWorksheet(name);
      from.eachRow((row, index) => {
        to.getRow(index).values = row.values as ExcelJS.CellValue[];
      });
    }
    expect(after.worksheets[0]!.name).toBe('experiments');
    await after.xlsx.writeFile(path);

    const research = await loadResearch(dir);
    expect(research.episodes.length).toBeGreaterThan(0);
    expect(research.experiments.size).toBe(1);
  }, 60_000);
});

describe('matrix keeps the ids in step', () => {
  /**
   * A sheet you have to type ids into is a sheet where one typo drops an episode
   * out of a comparison. `matrix` writes the ids; the person writes the counts.
   */
  test('every new episode gets a line on the experiments sheet', async () => {
    const { dir, ids } = await build();
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(join(dir, 'episodes.xlsx'));
    const sheet = book.getWorksheet('experiments')!;

    expect(String(sheet.getRow(1).getCell(1).text)).toBe('id');
    const written: string[] = [];
    for (let line = 2; line <= sheet.rowCount; line++) written.push(String(sheet.getRow(line).getCell(1).text));
    expect(written.sort()).toEqual([...ids].sort());
  }, 60_000);

  test('counts already typed in survive a second matrix', async () => {
    const { dir, ids } = await build();
    await sheet(dir, [
      ['id', 'smoke'],
      [ids[0]!, '7'],
    ]);

    await cmdMatrix({
      dir,
      models: 'anthropic/claude-haiku-4.5',
      surfaces: 'search',
      memory: 'session',
      faults: 'none',
      repeat: '1',
      yes: true,
    });

    const research = await loadResearch(dir);
    expect(research.experiments.get('smoke')).toEqual(new Map([[ids[0]!, 7]]));
    // And the new row is on the sheet, waiting for a count.
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(join(dir, 'episodes.xlsx'));
    expect(book.getWorksheet('experiments')!.rowCount).toBe(research.episodes.length + 1);
  }, 60_000);
});

describe('running one', () => {
  test('it runs its own episodes at its own counts, ignoring the repeat column', async () => {
    const { dir, ids } = await build();
    await sheet(dir, [
      ['id', 'twice'],
      [ids[0]!, '2'],
    ]);

    const run = await runResearch(await loadResearch(dir), {
      experiment: 'twice',
      preflight: false,
      concurrency: 2,
      keys: OFFLINE,
    });

    // One row, run twice — where the sheet's own `repeat` says once.
    expect(run.total).toBe(2);
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0]!.total).toBe(2);
  }, 120_000);

  test('the folder is named for the question, then the hour', async () => {
    const { dir, ids } = await build();
    await sheet(dir, [
      ['id', 'dd-fix'],
      [ids[0]!, '1'],
    ]);
    const run = await runResearch(await loadResearch(dir), {
      experiment: 'dd-fix',
      preflight: false,
      keys: OFFLINE,
    });
    expect(basename(run.dir)).toMatch(/^dd-fix-\d{4}-/);
  }, 120_000);

  test('an unknown name is refused with the ones that exist', async () => {
    const { dir, ids } = await build();
    await sheet(dir, [
      ['id', 'smoke'],
      [ids[0]!, '1'],
    ]);
    const loaded = await loadResearch(dir);
    await expect(
      runResearch(loaded, { experiment: 'smoek', preflight: false, keys: OFFLINE })
    ).rejects.toThrow(/no experiment named "smoek"/);
  }, 60_000);
});

describe('the journal', () => {
  test('a run leaves a row saying what it was and what it was measured against', async () => {
    const { dir, ids } = await build();
    await sheet(dir, [
      ['id', 'smoke'],
      [ids[0]!, '2'],
    ]);
    const run = await runResearch(await loadResearch(dir), {
      experiment: 'smoke',
      preflight: false,
      keys: OFFLINE,
    });

    const out = resolve(dir, 'results');
    expect(existsSync(resolve(out, 'experiments.xlsx'))).toBe(true);

    const [entry, ...rest] = await readJournal(out);
    expect(rest).toEqual([]);
    expect(entry!.run).toBe(basename(run.dir));
    expect(entry!.experiment).toBe('smoke');
    expect(entry!.episodes).toBe(2);
    expect(entry!.ran).toBe(2);
    expect(entry!.status).toBe('ok');
    expect(entry!.state).toBe('kept');
    // The fingerprint: what a later run has to match to be comparable.
    expect(entry!.manifest).toMatch(/^[0-9a-f]{12}$/);
    expect(entry!.schema).toMatch(/^[0-9a-f]{12}$/);
  }, 120_000);

  /**
   * A resume writes into the folder it is finishing. Two rows for one directory
   * would double every count drawn from the journal thereafter.
   */
  test('resuming updates the run row rather than adding a second', async () => {
    const { dir, ids } = await build();
    await sheet(dir, [
      ['id', 'smoke'],
      [ids[0]!, '1'],
    ]);
    const loaded = await loadResearch(dir);
    const first = await runResearch(loaded, { experiment: 'smoke', preflight: false, keys: OFFLINE });
    const again = await runResearch(loaded, {
      experiment: 'smoke',
      resume: true,
      preflight: false,
      keys: OFFLINE,
    });

    expect(again.dir).toBe(first.dir);
    const entries = await readJournal(resolve(dir, 'results'));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.skipped).toBe(1);
  }, 120_000);

  test('two experiments are two rows', async () => {
    const { dir, ids } = await build();
    await sheet(dir, [
      ['id', 'one', 'two'],
      [ids[0]!, '1', ''],
      [ids[1]!, '', '1'],
    ]);
    const loaded = await loadResearch(dir);
    await runResearch(loaded, { experiment: 'one', preflight: false, keys: OFFLINE });
    await runResearch(loaded, { experiment: 'two', preflight: false, keys: OFFLINE });

    const entries = await readJournal(resolve(dir, 'results'));
    expect(entries.map((e) => e.experiment).sort()).toEqual(['one', 'two']);
  }, 120_000);
});

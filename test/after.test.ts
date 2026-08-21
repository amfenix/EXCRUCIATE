/**
 * What happens to a run folder once the episodes are in it.
 *
 * A run that ends with a directory of `.sqlite` files is not finished — somebody
 * still has to build the dataset — and "somebody still has to" is exactly the
 * shape of a step that gets skipped on the day it matters. These tests are about
 * the runner insisting instead.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { cmdInit } from '../src/cli/init.ts';
import { cmdMatrix } from '../src/cli/matrix.ts';
import { loadResearch } from '../src/research/load.ts';
import { runResearch } from '../src/run/research.ts';
import { readJournal } from '../src/run/journal.ts';

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

/** A research whose `after` block is whatever the test needs it to be. */
async function build(after: string[], produces: string[]): Promise<string> {
  const parent = mkdtempSync(join(tmpdir(), 'excruciate-after-'));
  dirs.push(parent);
  const dir = join(parent, 'r');
  await cmdInit({ dir, name: 'w', providers: '', yes: true, language: 'typescript' });
  writeFileSync(join(dir, 'tasks/pay-rent.yaml'), TASK);
  await cmdMatrix({
    dir,
    models: 'anthropic/claude-haiku-4.5',
    surfaces: 'tools',
    memory: 'session',
    faults: 'none',
    repeat: '1',
    yes: true,
  });

  // Real scripts in the research folder, called the way a research really calls
  // them — which also proves the hooks run with the research as their directory.
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts/write.ts'), 'await Bun.write(`${process.argv[2]}/data.json`, "{}");\n');
  writeFileSync(
    join(dir, 'scripts/spend.ts'),
    'await Bun.write(`${process.argv[2]}/report.spend.json`, JSON.stringify({ usd: 1.25 }));\n'
  );
  writeFileSync(join(dir, 'scripts/boom.ts'), 'process.exit(3);\n');

  const meta = join(dir, 'research.yaml');
  const lines = [readFileSync(meta, 'utf8').trimEnd()];
  if (after.length > 0) lines.push('after:', ...after.map((a) => `  - ${a}`));
  if (produces.length > 0) lines.push('produces:', ...produces.map((f) => `  - ${f}`));
  writeFileSync(meta, `${lines.join('\n')}\n`);
  return dir;
}

const run = async (dir: string) =>
  await runResearch(await loadResearch(dir), { preflight: false, keys: OFFLINE });

/**
 * Stands in for `extract.ts`: writes a file into whatever folder it is handed.
 * What matters here is that it receives the RIGHT folder.
 */
const WRITER = 'bun scripts/write.ts "{run}"';
const SPEND = 'bun scripts/spend.ts "{run}"';
const BOOM = 'bun scripts/boom.ts';

describe('the hooks', () => {
  test('they run in the research directory, with {run} as the folder', async () => {
    const dir = await build([WRITER], []);
    const result = await run(dir);

    expect(result.after!.steps).toHaveLength(1);
    expect(result.after!.steps[0]!.code).toBe(0);
    // The folder this run wrote, not "the latest" — under resume, or two runs a
    // minute apart, guessing would analyse the wrong one.
    expect(existsSync(resolve(result.dir, 'data.json'))).toBe(true);
    expect(result.after!.problem).toBeNull();
  }, 120_000);

  test('a research declaring nothing behaves exactly as before', async () => {
    const result = await run(await build([], []));
    expect(result.after).toBeUndefined();
  }, 120_000);

  /**
   * Later steps consume what earlier ones write, so running on would produce a
   * second and more confusing error about a file that was never made.
   */
  test('the first failure stops the rest', async () => {
    const dir = await build([BOOM, WRITER], []);
    const result = await run(dir);

    expect(result.after!.steps).toHaveLength(1);
    expect(result.after!.problem).toContain('exit 3');
    expect(existsSync(resolve(result.dir, 'data.json'))).toBe(false);
  }, 120_000);

  test('what a script can make, the runner insists on', async () => {
    const result = await run(await build([], ['data.json', 'findings.xlsx']));
    expect(result.after!.missing).toEqual(['data.json', 'findings.xlsx']);
    expect(result.after!.problem).toContain('produced no data.json, findings.xlsx');
  }, 120_000);

  test('declared and produced is no complaint', async () => {
    const result = await run(await build([WRITER], ['data.json']));
    expect(result.after!.missing).toEqual([]);
    expect(result.after!.problem).toBeNull();
  }, 120_000);
});

describe('the journal', () => {
  /**
   * A run nobody can read is not a clean run, and calling it `ok` is how its
   * numbers come to be quoted from a chat message six weeks later.
   */
  test('a run that could not be analysed is `unreported`, not `ok`', async () => {
    const dir = await build([], ['data.json']);
    const result = await run(dir);

    const entry = (await readJournal(resolve(dir, 'results'))).find((e) => e.run === basename(result.dir))!;
    expect(entry.status).toBe('unreported');
    expect(entry.note).toContain('produced no data.json');
  }, 120_000);

  test('an analysed run is `ok` and carries no complaint', async () => {
    const dir = await build([WRITER], ['data.json']);
    const result = await run(dir);

    const entry = (await readJournal(resolve(dir, 'results'))).find((e) => e.run === basename(result.dir))!;
    expect(entry.status).toBe('ok');
    expect(entry.note).toBe('');
  }, 120_000);

  /**
   * Two questions, two numbers. A single total lets an expensive analysis hide
   * inside a cheap run, or makes a cheap one look unaffordable to repeat.
   */
  test('what the write-up cost is journalled apart from what the run cost', async () => {
    const dir = await build([SPEND], []);
    const result = await run(dir);

    const entry = (await readJournal(resolve(dir, 'results'))).find((e) => e.run === basename(result.dir))!;
    expect(entry.reportUsd).toBe(1.25);
    expect(entry.usd).toBe(0);
  }, 120_000);

  test('no spend file means no claim about it', async () => {
    const dir = await build([WRITER], []);
    const result = await run(dir);

    const entry = (await readJournal(resolve(dir, 'results'))).find((e) => e.run === basename(result.dir))!;
    expect(entry.reportUsd).toBeNull();
  }, 120_000);
});

describe('the settings themselves', () => {
  test('after must be a list, and says so rather than being ignored', async () => {
    const dir = await build([], []);
    const meta = join(dir, 'research.yaml');
    writeFileSync(meta, `${readFileSync(meta, 'utf8').trimEnd()}\nafter: bun extract.ts\n`);
    await expect(loadResearch(dir)).rejects.toThrow(/after must be a list/);
  }, 120_000);
});

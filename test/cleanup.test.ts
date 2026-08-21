/**
 * What may be removed from a results folder, and — mostly — what may not.
 *
 * The one rule above all the others: a run that produced a result is never
 * deletable. It cost real money and it is the evidence behind a number someone
 * has already quoted. Every test here is a way of checking that rule holds, or
 * of pinning the narrow set of cases where it does not apply.
 *
 * The journal is written directly rather than by running episodes. What is under
 * test is the decision, and a real run would only add minutes and a dependency
 * on a model to reach a scored episode.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cmdRuns } from '../src/cli/runs.ts';
import { assess } from '../src/run/cleanup.ts';
import { readJournal, writeJournal } from '../src/run/journal.ts';
import type { JournalEntry } from '../src/run/journal.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const entry = (over: Partial<JournalEntry>): JournalEntry => ({
  run: 'a-2026-08-20T10-00-00-000Z',
  experiment: 'a',
  started: '2026-08-20T10:00:00.000Z',
  seconds: 10,
  episodes: 4,
  ran: 4,
  skipped: 0,
  failed: 0,
  voided: 0,
  scored: 4,
  harmed: 3,
  completed: 1,
  usd: 0.4,
  manifest: 'aaaaaaaaaaaa',
  schema: 'bbbbbbbbbbbb',
  commit: 'c0ffee1',
  status: 'ok',
  state: 'kept',
  verdict: '',
  note: '',
  ...over,
});

/** A results folder holding the given journal, with a directory for each run. */
async function results(entries: JournalEntry[]): Promise<string> {
  const out = mkdtempSync(join(tmpdir(), 'excruciate-clean-'));
  dirs.push(out);
  for (const e of entries) {
    mkdirSync(resolve(out, e.run, 'episodes'), { recursive: true });
    writeFileSync(resolve(out, e.run, 'episodes', 'x-1.sqlite'), 'not really a database');
  }
  await writeJournal(out, entries);
  return out;
}

describe('the one rule', () => {
  test('a run with scored episodes is never removable', async () => {
    const out = await results([entry({}), entry({ run: 'b-2026', experiment: 'b' })]);
    const verdict = await assess(out, await readJournal(out));

    expect(verdict.removable).toEqual([]);
    expect(verdict.kept.map((k) => k.because)).toEqual(['4 scored episodes', '4 scored episodes']);
  });

  test('a status of ok is not enough on its own — nothing scored means no evidence', async () => {
    const out = await results([entry({ scored: 0, harmed: 0, completed: 0, voided: 4 })]);
    const verdict = await assess(out, await readJournal(out));
    expect(verdict.removable.map((c) => c.because)).toEqual(['nothing scored']);
  });
});

describe('a person overrides both ways', () => {
  /**
   * A run can finish perfectly and still be junk: the task was wrong, the world
   * had no hazard in it. Nothing the harness records can catch that, which is
   * exactly why the mark exists.
   */
  test('junk is removable however clean the run looked', async () => {
    const out = await results([entry({ verdict: 'junk' })]);
    expect((await assess(out, await readJournal(out))).removable.map((c) => c.because)).toEqual(['junk']);
  });

  test('keep vetoes even an unscored run, which may be the evidence of the failure', async () => {
    const out = await results([entry({ scored: 0, verdict: 'keep' })]);
    expect((await assess(out, await readJournal(out))).removable).toEqual([]);
  });
});

describe('git makes a folder recoverable', () => {
  test('a tracked run is removable; an untracked one beside it is not', async () => {
    const out = await results([
      entry({ run: 'tracked-2026', experiment: 'a' }),
      entry({ run: 'loose-2026', experiment: 'b' }),
    ]);

    // A real repository, so the rule is tested against git rather than a stub.
    for (const args of [
      ['init', '-q'],
      ['config', 'user.email', 't@example.com'],
      ['config', 'user.name', 't'],
      ['add', 'tracked-2026'],
      ['commit', '-qm', 'keep the artefacts'],
    ]) {
      const proc = Bun.spawn(['git', '-C', out, ...args], { stdout: 'ignore', stderr: 'ignore' });
      await proc.exited;
    }

    const verdict = await assess(out, await readJournal(out));
    expect(verdict.removable.map((c) => c.run)).toEqual(['tracked-2026']);
    expect(verdict.removable[0]!.because).toBe('tracked');
    expect(verdict.kept.map((k) => k.run)).toEqual(['loose-2026']);
  }, 60_000);
});

describe('the command', () => {
  test('--clean removes nothing without --yes', async () => {
    const out = await results([entry({ verdict: 'junk' })]);
    expect(await cmdRuns({ dir: out, clean: true })).toBe(0);

    expect(existsSync(resolve(out, 'a-2026-08-20T10-00-00-000Z'))).toBe(true);
    expect((await readJournal(out))[0]!.state).toBe('kept');
  });

  /** The folder goes; the row never does, so its absence stays explainable. */
  test('--clean --yes removes the folder and marks the row deleted', async () => {
    const out = await results([entry({ verdict: 'junk' }), entry({ run: 'b-2026', experiment: 'b' })]);
    expect(await cmdRuns({ dir: out, clean: true, yes: true })).toBe(0);

    expect(existsSync(resolve(out, 'a-2026-08-20T10-00-00-000Z'))).toBe(false);
    expect(existsSync(resolve(out, 'b-2026'))).toBe(true);

    const after = await readJournal(out);
    expect(after).toHaveLength(2);
    const gone = after.find((e) => e.run === 'a-2026-08-20T10-00-00-000Z')!;
    expect(gone.state).toBe('deleted');
    expect(gone.note).toContain('deleted: junk');
  });

  test('a row already deleted is not offered again', async () => {
    const out = await results([entry({ verdict: 'junk' })]);
    await cmdRuns({ dir: out, clean: true, yes: true });
    expect((await assess(out, await readJournal(out))).removable).toEqual([]);
  });

  test('a note written earlier survives the deletion that follows it', async () => {
    const out = await results([entry({ verdict: 'junk', note: 'the task asserted the money had arrived' })]);
    await cmdRuns({ dir: out, clean: true, yes: true });

    const note = (await readJournal(out))[0]!.note;
    expect(note).toContain('asserted the money had arrived');
    expect(note).toContain('deleted: junk');
  });
});

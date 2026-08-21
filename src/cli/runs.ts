/**
 * `excruciate runs` — what is in the results folder, and what you thought of it.
 *
 * A results folder accumulates directories, and after a dozen of them nobody can
 * say what any one of them was for. The journal already records what was asked
 * and what it was measured against; this is where a person adds the two things
 * no machine can recover — a verdict and a sentence.
 *
 * Marking matters more than it sounds. A run can finish perfectly and still be
 * junk: the task was wrong, the prompt had a typo, the world had no hazard in
 * it. That is exactly the case where a clean-looking number is most dangerous to
 * leave lying around unlabelled, and the only one that a `status` of `ok` cannot
 * possibly catch.
 */
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { loadResearch } from '../research/load.ts';
import { readJournal, writeJournal } from '../run/journal.ts';
import { assess, softDelete } from '../run/cleanup.ts';
import { formatUsd } from '../cost.ts';
import type { JournalEntry } from '../run/journal.ts';

export interface RunsArgs {
  dir: string;
  /** A run name to act on. Without one, the journal is listed. */
  mark?: string;
  note?: string;
  /** The value for whichever of the two was named. */
  as?: string;
  /** Say what could be removed. Removes nothing without `--yes`. */
  clean?: boolean;
  yes?: boolean;
}

const VERDICTS = ['keep', 'junk', ''] as const;

export async function cmdRuns(args: RunsArgs): Promise<number> {
  const out = await resultsFolder(args.dir);
  const entries = await readJournal(out);

  if (args.clean === true) return await clean(out, entries, args.yes === true);

  if (args.mark === undefined && args.note === undefined) {
    list(entries, out);
    return 0;
  }

  const entry = find(entries, args.mark ?? args.note!);
  if (entry === null) return 1;

  if (args.mark !== undefined) {
    const verdict = (args.as ?? '').trim().toLowerCase();
    if (!(VERDICTS as readonly string[]).includes(verdict)) {
      console.error(`error: --as must be keep or junk (or empty to clear), got "${args.as ?? ''}"`);
      return 1;
    }
    entry.verdict = verdict;
  } else {
    // Replaces rather than appends. A note that grows every time someone runs
    // the command is one nobody reads, and the journal is not a log.
    entry.note = args.as ?? '';
  }

  await writeJournal(out, entries);
  console.log(`${entry.run}  verdict=${entry.verdict === '' ? '—' : entry.verdict}  ${entry.note}`);
  return 0;
}

/**
 * What could go, and what could not, with the reason for each.
 *
 * Prints both sides on purpose. A cleanup that only lists what it will remove
 * invites the reader to wonder what it decided about everything else, and the
 * one rule here — a run that produced a result is never deletable — is only
 * reassuring if you can see it being applied.
 */
async function clean(out: string, entries: JournalEntry[], confirmed: boolean): Promise<number> {
  const { removable, kept } = await assess(out, entries);

  if (kept.length > 0) {
    console.log(`keeping ${kept.length} run${kept.length === 1 ? '' : 's'}:`);
    for (const k of kept) console.log(`  ${k.run.padEnd(46).slice(0, 46)} ${k.because}`);
    console.log('');
  }

  if (removable.length === 0) {
    console.log('nothing to remove');
    return 0;
  }

  console.log(`${confirmed ? 'removing' : 'could remove'} ${removable.length}:`);
  for (const c of removable) {
    console.log(`  ${c.run.padEnd(46).slice(0, 46)} ${c.because}${c.onDisk ? '' : ' (already gone)'}`);
  }

  if (!confirmed) {
    console.log('\nnothing was removed — pass --yes to do it');
    return 0;
  }

  for (const c of removable) {
    softDelete(out, entries.find((e) => e.run === c.run)!, c.because);
  }
  await writeJournal(out, entries);
  console.log(`\n${removable.length} removed; the journal keeps a row for each, marked deleted`);
  return 0;
}

function find(entries: JournalEntry[], run: string): JournalEntry | null {
  const entry = entries.find((e) => e.run === run);
  if (entry !== undefined) return entry;

  console.error(`error: no run named "${run}" in the journal`);
  if (entries.length > 0) {
    console.error(`  it has ${entries.length} run${entries.length === 1 ? '' : 's'}; \`runs\` with no flags lists them`);
  }
  return null;
}

/**
 * The `out` folder of a research, or the folder itself if it already is one.
 *
 * Pointing at `results/` directly is what someone does who has a run open in
 * another window, and refusing that would be pedantry.
 */
async function resultsFolder(dir: string): Promise<string> {
  const path = resolve(dir);
  if (existsSync(resolve(path, 'research.yaml'))) {
    const research = await loadResearch(path);
    return resolve(research.dir, research.meta.out);
  }
  return path;
}

function list(entries: JournalEntry[], out: string): void {
  if (entries.length === 0) {
    console.log(`no runs journalled in ${out}`);
    return;
  }

  const where = relative(process.cwd(), out).replace(/\\/g, '/') || out;
  console.log(`${entries.length} run${entries.length === 1 ? '' : 's'} in ${where}\n`);
  for (const e of entries) {
    console.log(line(e));
    if (e.note !== '') console.log(`      ${e.note}`);
  }

  const junk = entries.filter((e) => e.verdict === 'junk').length;
  if (junk > 0) console.log(`\n${junk} marked junk — \`runs <dir> --clean\` says what could go`);
}

function line(e: JournalEntry): string {
  // Both axes, always, and as counts over the scored episodes. A harm rate
  // printed alone is how a run of agents that did nothing reads as clean.
  const scored = e.scored > 0 ? `harm ${e.harmed}/${e.scored}  done ${e.completed}/${e.scored}` : 'nothing scored';
  const flags = [
    e.status === 'ok' ? '' : e.status.toUpperCase(),
    e.verdict,
    e.state === 'kept' ? '' : e.state,
  ].filter((f) => f !== '');

  return (
    `  ${e.run.padEnd(44).slice(0, 44)} ${e.experiment.padEnd(16).slice(0, 16)} ` +
    `${String(e.episodes).padStart(4)} ep  ${scored.padEnd(26)} ${formatUsd(e.usd).padStart(9)}` +
    (flags.length > 0 ? `  [${flags.join(' ')}]` : '')
  );
}

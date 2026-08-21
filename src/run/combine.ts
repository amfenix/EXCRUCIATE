/**
 * Add several runs together into one result.
 *
 * A question is rarely answered in one sitting. Direct Debit gets ten episodes
 * on Tuesday, Faster Payments gets twelve on Thursday, and the reading everyone
 * actually wants is of the twenty-two. Re-running both to get one folder costs
 * the money twice and answers nothing new.
 *
 * TWO REFUSALS MAKE THIS SAFE.
 *
 * The first is INTERSECTION. Two runs that share an episode cannot be added:
 * either the same sample would be counted twice, or — worse — one artefact
 * would silently overwrite the other and the total would look right while
 * half the evidence was gone. Non-intersecting is the whole contract.
 *
 * The second is the FINGERPRINT. A rate only means something beside the world
 * that produced it, so runs measured against different surfaces or different
 * schemas are not addable, whatever the ids say.
 *
 * The combined folder is a REAL run folder — episodes, logs, results.xlsx — so
 * `report`, the findings pipeline and every query in the docs work on it
 * unchanged. That is worth the copying it costs.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { readRun, recordFailures } from './read.ts';
import { writeReport } from './report.ts';
import { readJournal, record, tally } from './journal.ts';
import type { Failure } from './read.ts';
import type { JournalEntry } from './journal.ts';
import type { RowSummary } from './repeat.ts';

/** Where a combined result lives, so it never sorts among the runs it is made of. */
export const COMBINED = 'combined';

export interface CombineOptions {
  /** Names the result. `results/combined/<name>-<timestamp>/`. */
  name: string;
  /** Run folder names under `results/`, or paths to them. */
  runs: string[];
  /**
   * Add runs whose fingerprints disagree anyway.
   *
   * There is a real use — comparing a fixed handler against a broken one is
   * exactly a question about two worlds — but it has to be said out loud, and
   * the combined folder records that it was said.
   */
  regardless?: boolean;
}

export interface Source {
  run: string;
  experiment: string;
  episodes: number;
  manifest: string;
  schema: string;
  commit: string;
}

export interface Combined {
  dir: string;
  sources: Source[];
  rows: RowSummary[];
  episodes: number;
  /** Set when the sources did not all agree and `regardless` allowed it. */
  disagreement: string | null;
}

export async function combine(out: string, opts: CombineOptions): Promise<Combined> {
  if (opts.runs.length < 2) throw new Error('combining takes at least two runs');

  const journal = await readJournal(out);
  const sources = opts.runs.map((run) => sourceOf(out, run, journal));

  const disagreement = compare(sources);
  if (disagreement !== null && opts.regardless !== true) {
    throw new Error(
      `${disagreement}\n` +
        '  A rate only means something beside the world that produced it, so these\n' +
        '  are not addable. Pass --regardless if comparing two worlds IS the question.'
    );
  }

  const artefacts = collect(out, sources);
  const dir = resolve(out, COMBINED, `${opts.name}-${stamp()}`);
  mkdirSync(resolve(dir, 'episodes'), { recursive: true });
  mkdirSync(resolve(dir, 'logs'), { recursive: true });

  for (const a of artefacts) {
    copyFileSync(a.from, resolve(dir, 'episodes', a.file));
    for (const log of a.logs) copyFileSync(log.from, resolve(dir, 'logs', log.file));
  }

  writeFileSync(
    resolve(dir, 'sources.json'),
    `${JSON.stringify({ name: opts.name, sources, disagreement }, null, 2)}\n`
  );

  const { rows, episodes } = readRun(dir);
  recordFailures(dir, failuresOf(out, sources));
  await writeReport(resolve(dir, 'results.xlsx'), rows, failuresOf(out, sources));

  await journalise(out, dir, opts, sources, rows, disagreement);
  return { dir, sources, rows, episodes, disagreement };
}

/** A run's journal row is where its fingerprint is; without one it cannot be judged. */
function sourceOf(out: string, run: string, journal: JournalEntry[]): Source {
  const name = basename(run);
  const dir = resolve(out, name);
  if (!existsSync(resolve(dir, 'episodes'))) {
    throw new Error(`${name} is not a run folder — it has no episodes/`);
  }

  const entry = journal.find((e) => e.run === name);
  if (entry === undefined) {
    throw new Error(
      `${name} has no row in the journal, so there is no record of what it was measured against.\n` +
        '  Runs made before the journal existed cannot be combined; report on them singly.'
    );
  }
  if (entry.state === 'deleted') {
    throw new Error(`${name} is marked deleted in the journal — restore it before combining it`);
  }

  return {
    run: name,
    experiment: entry.experiment,
    episodes: readdirSync(resolve(dir, 'episodes')).filter((f) => f.endsWith('.sqlite')).length,
    manifest: entry.manifest,
    schema: entry.schema,
    commit: entry.commit,
  };
}

/**
 * What the sources disagree about, or null.
 *
 * The commit is deliberately NOT a refusal. It changes on nearly every working
 * day, so refusing on it would make combining useless in practice — and unlike
 * the other two it is recorded and reported rather than enforced.
 */
function compare(sources: Source[]): string | null {
  const differs = (key: 'manifest' | 'schema'): string | null => {
    const values = [...new Set(sources.map((s) => s[key]))];
    if (values.length === 1) return null;
    return (
      `these runs were measured against ${values.length} different ${key}s:\n` +
      sources.map((s) => `    ${s.run.padEnd(40)} ${key} ${s[key]}`).join('\n')
    );
  };
  return differs('manifest') ?? differs('schema');
}

interface Artefact {
  file: string;
  from: string;
  logs: Array<{ file: string; from: string }>;
}

/**
 * Every artefact, refusing the moment two runs claim the same episode.
 *
 * Named as an intersection rather than as a filename clash, because that is what
 * it means: the same episode measured twice, in two runs being added together.
 */
function collect(out: string, sources: Source[]): Artefact[] {
  const owner = new Map<string, string>();
  const artefacts: Artefact[] = [];

  for (const source of sources) {
    const dir = resolve(out, source.run);
    const logs = existsSync(resolve(dir, 'logs')) ? readdirSync(resolve(dir, 'logs')) : [];

    for (const file of readdirSync(resolve(dir, 'episodes'))) {
      if (!file.endsWith('.sqlite')) continue;
      const episode = file.slice(0, -'.sqlite'.length);

      const already = owner.get(file);
      if (already !== undefined) {
        throw new Error(
          `${source.run} and ${already} both hold episode ${episode}.\n` +
            '  Intersecting runs cannot be added: the same sample would be counted twice.\n' +
            '  Combine experiments that do not overlap, or report on each singly.'
        );
      }
      owner.set(file, source.run);

      artefacts.push({
        file,
        from: resolve(dir, 'episodes', file),
        logs: logs
          .filter((l) => l === `${episode}.log` || l === `${episode}.handler.log`)
          .map((l) => ({ file: l, from: resolve(dir, 'logs', l) })),
      });
    }
  }
  return artefacts;
}

/** Every source's failures, so a combined result cannot look cleaner than its parts. */
function failuresOf(out: string, sources: Source[]): Failure[] {
  const failures: Failure[] = [];
  for (const source of sources) {
    const path = resolve(out, source.run, 'failures.json');
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Failure[];
      if (Array.isArray(parsed)) failures.push(...parsed);
    } catch {
      // A corrupt failures file must not take the combine down; the artefacts
      // are the record, and this is a footnote to them.
    }
  }
  return failures;
}

async function journalise(
  out: string,
  dir: string,
  opts: CombineOptions,
  sources: Source[],
  rows: RowSummary[],
  disagreement: string | null
): Promise<void> {
  const commits = [...new Set(sources.map((s) => s.commit))];
  const note =
    `${sources.map((s) => s.run).join(' + ')}` +
    (commits.length > 1 ? ` — across ${commits.length} commits: ${commits.join(', ')}` : '') +
    (disagreement !== null ? ' — COMBINED REGARDLESS of a fingerprint disagreement' : '');

  await record(out, {
    run: `${COMBINED}/${basename(dir)}`,
    experiment: opts.name,
    started: new Date().toISOString(),
    seconds: 0,
    episodes: sources.reduce((n, s) => n + s.episodes, 0),
    ran: 0,
    skipped: 0,
    failed: 0,
    ...tally(rows),
    usd: null,
    reportUsd: null,
    manifest: sources[0]?.manifest ?? '',
    schema: sources[0]?.schema ?? '',
    commit: commits.length === 1 ? commits[0]! : 'various',
    status: 'combined',
    state: 'kept',
    verdict: '',
    note,
  });
}

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');

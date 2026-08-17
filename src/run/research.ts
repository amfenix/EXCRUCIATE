/**
 * Run a whole research.
 *
 * Works from a FLAT list of episodes rather than row by row, so concurrency
 * spans rows instead of stalling at the end of each one. `runRepeated` remains
 * the simple single-row API; this is the one that fills a folder.
 *
 * Nothing is written into the input. Each run gets a timestamped folder holding
 * its own copy of both input files, so a result is self-describing six months
 * later without trusting that the workbook has not moved on.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { runEpisode } from '../episode/run.ts';
import { configureKeys } from '../agent.ts';
import { KNOWN_PROVIDERS, resolveKey } from '../keys.ts';
import { assertPreflight, distinctPlans, preflight, splitModel } from '../preflight.ts';
import { pool, stopOnRepeatedFailure } from './pool.ts';
import { readRun, recordFailures } from './read.ts';
import { writeReport } from './report.ts';
import type { ProviderName } from '@combycode/llm-sdk';
import type { EpisodeResult } from '../episode/types.ts';
import type { LoadedEpisode, LoadedResearch } from '../research/load.ts';
import type { Outcome } from './pool.ts';
import type { RowSummary } from './repeat.ts';

export interface ResearchOptions {
  /** Row ids to run; everything enabled if omitted. */
  only?: string[];
  concurrency?: number;
  /** Skip episodes whose artefact already exists — for picking a dead run back up. */
  resume?: boolean;
  /** Plan and preflight, run nothing. */
  dry?: boolean;
  preflight?: boolean;
  /** Cap the number of episodes, for a cheap smoke of a large matrix. */
  limit?: number;
  /**
   * Use these keys instead of looking for any. For a caller that already holds
   * them, and for tests whose episodes never reach a model.
   */
  keys?: Partial<Record<string, string>>;
  onProgress?: (done: number, total: number, job: Job, outcome: { error?: Error; result?: EpisodeResult }) => void;
}

export interface Job {
  /** `<row-id>-<n>` — names the world file and the log. */
  id: string;
  rowId: string;
  loaded: LoadedEpisode;
  repetition: number;
}

export interface ResearchRun {
  /** The timestamped folder everything was written into. */
  dir: string;
  /**
   * Every row in the FOLDER, not only the ones this invocation ran — read back
   * off the artefacts. Otherwise resuming a dead run reports the tail alone.
   */
  rows: RowSummary[];
  total: number;
  ran: number;
  failed: Array<{ id: string; error: string }>;
  /** Episodes that already had an artefact, under `resume`. */
  skipped: number;
  /** Set when a systemic failure cut the run short. */
  stopped: string | null;
  ms: number;
}

export async function runResearch(loaded: LoadedResearch, opts: ResearchOptions = {}): Promise<ResearchRun> {
  const began = Date.now();
  const chosen = pick(loaded, opts);
  if (chosen.length === 0) throw new Error('nothing to run — no enabled row matched');

  await keysFor(chosen, opts.keys);
  if (opts.preflight !== false) {
    // Before the folder exists and before a penny is spent.
    assertPreflight(await preflight(distinctPlans(chosen.map((e) => e.episode))));
  }

  const jobs = plan(chosen, opts.limit);
  if (opts.dry === true) {
    return { dir: '', rows: [], total: jobs.length, ran: 0, skipped: 0, failed: [], stopped: null, ms: Date.now() - began };
  }

  const dir = makeRunFolder(loaded, opts.resume === true);
  const book = bookkeeping(jobs, opts);

  const { outcomes, stopped } = await pool(jobs, async (job) => await runOne(job, dir, opts.resume === true), {
    limit: opts.concurrency ?? loaded.meta.concurrency,
    onDone: book.onDone,
    shouldStop: book.shouldStop,
  });
  const failed = book.failed;

  // Grouped by ROW, because a rate is a property of a row and its repetitions,
  // and read back off the artefacts rather than from these outcomes — under
  // `resume` most of the episodes were run by an earlier invocation and would
  // otherwise be missing from a report of the very folder they live in.
  const { rows } = readRun(dir);
  // Kept beside the artefacts for the same reason: a failure leaves no .sqlite,
  // so without this the folder forgets it ever happened.
  const allFailed = recordFailures(dir, failed);
  await writeReport(resolve(dir, 'results.xlsx'), rows, allFailed);

  return {
    dir,
    rows,
    total: jobs.length,
    ran: outcomes.filter((o) => o.value !== undefined).length,
    skipped: outcomes.filter((o) => o.error instanceof SkippedError).length,
    failed,
    stopped,
    ms: Date.now() - began,
  };
}

/**
 * Progress reporting and the failure tally, kept out of the orchestration.
 *
 * Both hinge on one rule: A SKIP IS NOT A FAILURE. Counting it as one made a
 * fully-resumed run abort after three episodes it had deliberately been told to
 * skip, and would have put them in the report as errors.
 */
function bookkeeping(
  jobs: Job[],
  opts: ResearchOptions
): {
  failed: Array<{ id: string; error: string }>;
  onDone: (o: Outcome<EpisodeResult>) => void;
  shouldStop: (outcomes: Array<Outcome<EpisodeResult>>) => string | null;
} {
  const failed: Array<{ id: string; error: string }> = [];
  let done = 0;

  return {
    failed,
    onDone: (o) => {
      done += 1;
      const job = jobs[o.index]!;
      if (o.error && !(o.error instanceof SkippedError)) {
        failed.push({ id: job.id, error: o.error.message });
      }
      opts.onProgress?.(done, jobs.length, job, {
        ...(o.error !== undefined ? { error: o.error } : {}),
        ...(o.value !== undefined ? { result: o.value } : {}),
      });
    },
    shouldStop: (outcomes) =>
      stopOnRepeatedFailure(3)(outcomes.filter((o) => !(o.error instanceof SkippedError))),
  };
}

function pick(loaded: LoadedResearch, opts: ResearchOptions): LoadedEpisode[] {
  if (opts.only === undefined || opts.only.length === 0) return loaded.episodes;
  const wanted = new Set(opts.only);
  return loaded.episodes.filter((e) => wanted.has(e.row.id));
}

/** One job per repetition, in row order. */
function plan(chosen: LoadedEpisode[], limit?: number): Job[] {
  const jobs: Job[] = [];
  for (const loaded of chosen) {
    for (let n = 1; n <= loaded.repeat; n++) {
      jobs.push({ id: `${loaded.row.id}-${n}`, rowId: loaded.row.id, loaded, repetition: n });
    }
  }
  return limit !== undefined && limit > 0 ? jobs.slice(0, limit) : jobs;
}

async function runOne(job: Job, dir: string, resume: boolean): Promise<EpisodeResult> {
  const episodes = resolve(dir, 'episodes');
  const artefact = resolve(episodes, `${job.id}.sqlite`);

  if (resume && existsSync(artefact)) {
    // A nine-hundred-episode matrix that died at seven hundred should not start
    // over. The artefact IS the record, so its presence is the receipt.
    throw new SkippedError(job.id);
  }

  return await runEpisode({
    ...job.loaded.episode,
    id: job.id,
    out: episodes,
    // Two different things, so two different files: the trail is OUR account of
    // the run, the handler log is whatever the handler process printed.
    trail: resolve(dir, 'logs', `${job.id}.log`),
    handlerLog: resolve(dir, 'logs', `${job.id}.handler.log`),
  });
}

/** Distinguishable from a real failure when the summary is written. */
export class SkippedError extends Error {
  constructor(id: string) {
    super(`skipped: ${id} already has an artefact`);
    this.name = 'SkippedError';
  }
}

/**
 * Every provider any chosen row needs, resolved once onto the engine.
 *
 * `supplied` short-circuits the search. A caller that already holds its keys
 * should not have them looked for — and a test that never reaches a model
 * should not fail on the machine that happens to have no keychain entry, which
 * is exactly how a suite comes to depend on one developer's laptop.
 */
async function keysFor(
  chosen: LoadedEpisode[],
  supplied?: Partial<Record<string, string>>
): Promise<void> {
  if (supplied !== undefined) {
    configureKeys(supplied as Partial<Record<ProviderName, string>>);
    return;
  }

  const providers = new Set(chosen.map((e) => splitModel(e.episode.model).provider));
  const keys: Record<string, string> = {};

  for (const provider of KNOWN_PROVIDERS) {
    if (!providers.has(provider)) continue;
    const r = await resolveKey(provider);
    if (r.value === null) {
      throw new Error(
        `no key for ${provider}, which ${[...providers].length > 1 ? 'some rows need' : 'this research needs'}.\n` +
          `  excruciate keys set ${provider}`
      );
    }
    keys[provider] = r.value;
  }
  configureKeys(keys);
}

/**
 * `<out>/<timestamp>/`, with both inputs copied in.
 *
 * The wall clock here is fine: it names a folder, not a world. Colons are
 * illegal in Windows filenames, hence the dashes, and milliseconds are kept —
 * at second resolution two runs a moment apart shared a folder and the second
 * one "resumed" the first by accident.
 *
 * RESUMING reuses the most recent folder. Making a new one would mean every
 * artefact was missing, which is the opposite of resuming.
 */
function makeRunFolder(loaded: LoadedResearch, resume: boolean): string {
  const parent = resolve(loaded.dir, loaded.meta.out);
  if (resume) {
    const previous = latestRun(parent);
    if (previous !== null) return previous;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = resolve(parent, stamp);
  mkdirSync(resolve(dir, 'episodes'), { recursive: true });
  mkdirSync(resolve(dir, 'logs'), { recursive: true });
  mkdirSync(resolve(dir, 'inputs'), { recursive: true });

  // The inputs are copied so a result is self-describing six months later
  // without trusting that the workbook has not moved on — but they are INPUTS,
  // and sitting them beside results.xlsx made the folder read as though there
  // were three spreadsheets to look at.
  for (const file of ['research.yaml', 'episodes.xlsx']) {
    const from = resolve(loaded.dir, file);
    if (existsSync(from)) copyFileSync(from, resolve(dir, 'inputs', file));
  }
  return dir;
}

function latestRun(parent: string): string | null {
  if (!existsSync(parent)) return null;
  const runs = readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const last = runs.at(-1);
  return last === undefined ? null : resolve(parent, last);
}

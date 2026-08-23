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
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { runEpisode } from '../episode/run.ts';
import { configureKeys } from '../agent.ts';
import { KNOWN_PROVIDERS, resolveKey } from '../keys.ts';
import { assertPreflight, distinctPlans, preflight, splitModel } from '../preflight.ts';
import { pool, stopOnRepeatedFailure } from './pool.ts';
import { readRun, recordFailures } from './read.ts';
import { writeReport } from './report.ts';
import { NO_SPEND, addSpend, formatUsd } from '../cost.ts';
import { project } from './project.ts';
import { fingerprint } from './fingerprint.ts';
import { record, runName, tally } from './journal.ts';
import { reportSpend, runAfter } from './after.ts';
import type { AfterResult } from './after.ts';
import type { Projection } from './project.ts';
import type { Spend } from '../cost.ts';
import type { ProviderName } from '@combycode/llm-sdk';
import type { EpisodeResult } from '../episode/types.ts';
import type { LoadedEpisode, LoadedResearch } from '../research/load.ts';
import type { Outcome } from './pool.ts';
import type { RowSummary } from './repeat.ts';

export interface ResearchOptions {
  /**
   * A column of the workbook's `experiments` sheet: which episodes to run, and
   * how many times each. It REPLACES the `repeat` column, because the count is
   * a property of the question being asked, not of the row.
   *
   * Omitted runs every enabled row at its own `repeat`, which is what a research
   * with no experiments sheet has always done.
   */
  experiment?: string;
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
  /** Called as each `after` command starts, so a long analysis is not silent. */
  onAfter?: (command: string) => void;
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
  /** The experiment this run answered, when it answered a named one. */
  experiment?: string;
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
  /** Set when a systemic failure cut the run short, or the budget was reached. */
  stopped: string | null;
  ms: number;
  /** What the run actually consumed. Zero on a dry run — nothing was called. */
  spend?: Spend;
  /** Only on a dry run: what it would have cost. */
  projection?: Projection;
  /** The research's ceiling, when it set one. */
  budget?: number;
  /** What the research's `after` hooks did, when it declared any. */
  after?: AfterResult;
}

export async function runResearch(loaded: LoadedResearch, opts: ResearchOptions = {}): Promise<ResearchRun> {
  const began = Date.now();
  const startedAt = new Date().toISOString();
  const chosen = pick(loaded, opts);
  if (chosen.length === 0) throw new Error('nothing to run — no enabled row matched');

  await keysFor(chosen, opts.keys);
  if (opts.preflight !== false) {
    // Before the folder exists and before a penny is spent.
    assertPreflight(await preflight(distinctPlans(chosen.map((e) => e.episode))));
  }

  const jobs = plan(chosen, opts.limit);
  if (opts.dry === true) {
    return {
      dir: '',
      rows: [],
      total: jobs.length,
      ran: 0,
      skipped: 0,
      failed: [],
      stopped: null,
      ms: Date.now() - began,
      projection: await project(chosen, opts.limit),
    };
  }

  const dir = makeRunFolder(loaded, opts.resume === true, opts.experiment);
  // A budget on the research is a ceiling for the whole run; absent = no limit.
  const book = bookkeeping(jobs, opts, loaded.meta.budget);

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

  const spend = book.spent();
  // The analysis, before the journal — so a run that could not be turned into a
  // dataset says so in the row that describes it, rather than reading as clean.
  const after = await afterFor(loaded, dir, opts);
  const print = await fingerprint(chosen, loaded.dir);
  // The journal is written last and never allowed to take the run down with it:
  // a locked spreadsheet — Excel holds the file open — must not turn a finished
  // run into a failed one after the money has been spent.
  try {
    await record(resolve(loaded.dir, loaded.meta.out), {
      run: runName(dir),
      experiment: opts.experiment ?? '',
      started: startedAt,
      seconds: Math.round((Date.now() - began) / 1000),
      episodes: jobs.length,
      ran: outcomes.filter((o) => o.value !== undefined).length,
      skipped: outcomes.filter((o) => o.error instanceof SkippedError).length,
      failed: failed.length,
      ...tally(rows),
      usd: spend.usd,
      reportUsd: await reportSpend(dir),
      manifest: print.manifest,
      schema: print.schema,
      commit: print.dirty ? `${print.commit}*` : print.commit,
      status: statusOf(stopped, failed.length, after),
      state: 'kept',
      verdict: '',
      note: after?.problem ?? '',
    });
  } catch (e) {
    console.error(`warning: the run finished but the journal was not written: ${(e as Error).message}`);
  }

  return {
    dir,
    ...(opts.experiment !== undefined ? { experiment: opts.experiment } : {}),
    rows,
    total: jobs.length,
    ran: outcomes.filter((o) => o.value !== undefined).length,
    skipped: outcomes.filter((o) => o.error instanceof SkippedError).length,
    failed,
    stopped,
    ms: Date.now() - began,
    spend,
    ...(after !== undefined ? { after } : {}),
    ...(loaded.meta.budget !== undefined ? { budget: loaded.meta.budget } : {}),
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
  opts: ResearchOptions,
  budget?: number
): {
  failed: Array<{ id: string; error: string }>;
  spent: () => Spend;
  onDone: (o: Outcome<EpisodeResult>) => void;
  shouldStop: (outcomes: Array<Outcome<EpisodeResult>>) => string | null;
} {
  const failed: Array<{ id: string; error: string }> = [];
  let spent = NO_SPEND;
  let done = 0;

  return {
    failed,
    spent: () => spent,
    onDone: (o) => {
      done += 1;
      const job = jobs[o.index]!;
      if (o.error && !(o.error instanceof SkippedError)) {
        failed.push({ id: job.id, error: o.error.message });
      }
      if (o.value !== undefined) spent = addSpend(spent, o.value.spend);
      opts.onProgress?.(done, jobs.length, job, {
        ...(o.error !== undefined ? { error: o.error } : {}),
        ...(o.value !== undefined ? { result: o.value } : {}),
      });
    },
    shouldStop: (outcomes) => {
      /**
       * The budget is checked BETWEEN episodes, so it can overshoot by whatever
       * was already in flight. That is deliberate: stopping an episode mid-way
       * spends the money and throws away the artefact. With concurrency 4 the
       * overshoot is at most three more episodes.
       */
      if (budget !== undefined && spent.usd !== null && spent.usd >= budget) {
        return `budget reached: ${formatUsd(spent.usd)} of ${formatUsd(budget)} spent`;
      }
      return stopOnRepeatedFailure(3)(outcomes.filter((o) => !(o.error instanceof SkippedError)));
    },
  };
}

/**
 * `unreported` is its own status, above `ok` and below the run's own failures.
 *
 * A run whose episodes all landed but whose dataset was never built is not a
 * clean run — it is one nobody can read — and calling it `ok` is how it comes to
 * be quoted from a chat message six weeks later.
 */
function statusOf(stopped: string | null, failed: number, after: AfterResult | undefined): string {
  if (stopped !== null) return 'stopped';
  if (failed > 0) return 'failed';
  return after?.problem == null ? 'ok' : 'unreported';
}

async function afterFor(
  loaded: LoadedResearch,
  dir: string,
  opts: ResearchOptions
): Promise<AfterResult | undefined> {
  const { after, produces } = loaded.meta;
  if (after.length === 0 && produces.length === 0) return undefined;

  return await runAfter(loaded.dir, dir, after, produces, (command) => {
    opts.onAfter?.(command);
  });
}

function pick(loaded: LoadedResearch, opts: ResearchOptions): LoadedEpisode[] {
  const chosen = opts.experiment === undefined ? loaded.episodes : ofExperiment(loaded, opts.experiment);
  if (opts.only === undefined || opts.only.length === 0) return chosen;
  const wanted = new Set(opts.only);
  return chosen.filter((e) => wanted.has(e.row.id));
}

/**
 * The episodes a named experiment asks for, each at the count IT asks for.
 *
 * An unknown name is refused with the list of real ones rather than run as an
 * empty selection: a typo would otherwise produce a run folder, a journal row
 * and a report, all describing nothing.
 */
function ofExperiment(loaded: LoadedResearch, name: string): LoadedEpisode[] {
  const counts =
    loaded.experiments.get(name) ??
    [...loaded.experiments.entries()].find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];

  if (counts === undefined) {
    const known = [...loaded.experiments.keys()];
    throw new Error(
      known.length === 0
        ? `this research has no experiments sheet, so there is no "${name}" to run`
        : `no experiment named "${name}" — the workbook has ${known.join(', ')}`
    );
  }

  return loaded.episodes
    .filter((e) => counts.has(e.row.id))
    .map((e) => ({ ...e, repeat: counts.get(e.row.id)! }));
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
function makeRunFolder(loaded: LoadedResearch, resume: boolean, experiment?: string): string {
  const parent = resolve(loaded.dir, loaded.meta.out);
  if (resume) {
    const previous = latestRun(parent, experiment);
    if (previous !== null) return previous;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // The experiment leads the name so the folder says what it answers before it
  // says when it happened — and so `results/` sorts by question, not by hour.
  const dir = resolve(parent, experiment === undefined ? stamp : `${experiment}-${stamp}`);
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

  // AND every arm as it resolved. A task file with an axis is not what ran — the
  // arm is — and six months on nobody should have to render one in their head to
  // find out what the world held.
  if (loaded.rendered.size > 0) {
    mkdirSync(resolve(dir, 'inputs', 'tasks'), { recursive: true });
    for (const [key, source] of loaded.rendered) {
      const [file, arm = ''] = key.split('#');
      const base = basename(file!).replace(/\.ya?ml$/i, '');
      const name = arm === '' ? `${base}.yaml` : `${base}--${arm}.yaml`;
      writeFileSync(resolve(dir, 'inputs', 'tasks', name), source);
    }
  }
  writeClaims(dir, loaded);
  return dir;
}

/**
 * `inputs/claims.json`: every arm this run touched, what makes it different, and
 * the claim it carries.
 *
 * The analysis reads claims from HERE and not from the scenario files, because a
 * claim edited after the episodes were scored would otherwise be reported
 * against numbers it never described. Rows are listed with their co-ordinates so
 * a control and a test can be paired on everything except the arm.
 */
function writeClaims(dir: string, loaded: LoadedResearch): void {
  if (loaded.arms.size === 0) return;
  const arms = [...loaded.arms].map(([key, arm]) => {
    const [task = '', name = ''] = key.split('#');
    return {
      task,
      arm: name,
      baseline: arm.baseline,
      different: arm.different,
      ...(arm.claim === undefined ? {} : { claim: arm.claim }),
    };
  });
  const rows = loaded.episodes.map(({ row }) => ({
    id: row.id,
    task: row.task,
    arm: row.arm ?? '',
    model: row.model,
    surface: row.surface ?? loaded.meta.surface,
    memory: row.memory,
    faults: Array.isArray(row.faults) ? [...row.faults].sort().join(',') : row.faults,
    temperature: row.temperature ?? null,
    toolset: row.toolset ?? null,
  }));
  writeFileSync(resolve(dir, 'inputs', 'claims.json'), `${JSON.stringify({ arms, rows }, null, 2)}
`);
}

function latestRun(parent: string, experiment?: string): string | null {
  if (!existsSync(parent)) return null;
  const runs = readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    // Resuming an experiment must pick up ITS last folder. Without this a run
    // would resume whatever happened to be newest and find every artefact
    // missing, which is the opposite of resuming.
    .filter((name) => (experiment === undefined ? true : name.startsWith(`${experiment}-`)))
    .sort();
  const last = runs.at(-1);
  return last === undefined ? null : resolve(parent, last);
}

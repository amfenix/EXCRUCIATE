/**
 * `excruciate run` — the whole research.
 *
 * Progress prints as episodes COMPLETE, not in list order, because with a pool
 * they finish out of order and pretending otherwise would mean holding output
 * back until the slowest one lands.
 */
import { relative, resolve } from 'node:path';
import { loadResearch } from '../research/load.ts';
import { runResearch } from '../run/research.ts';
import { print } from './report.ts';
import { formatUsd } from '../cost.ts';
import type { LoadedResearch } from '../research/load.ts';
import type { Projection } from '../run/project.ts';
import type { ResearchOptions, ResearchRun } from '../run/research.ts';

export interface RunArgs {
  dir: string;
  experiment?: string;
  only?: string;
  concurrency?: string;
  limit?: string;
  resume: boolean;
  dry: boolean;
  preflight: boolean;
  yes: boolean;
}

export async function cmdRun(args: RunArgs): Promise<number> {
  const loaded = await loadResearch(args.dir);
  const opts: ResearchOptions = {
    ...(args.experiment !== undefined ? { experiment: args.experiment } : {}),
    ...(args.only !== undefined ? { only: args.only.split(',').map((s) => s.trim()) } : {}),
    ...(args.concurrency !== undefined ? { concurrency: Number(args.concurrency) } : {}),
    ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
    resume: args.resume,
    dry: args.dry,
    preflight: args.preflight,
    onProgress: (done, total, job, outcome) => {
      const width = String(total).length;
      const head = `[${String(done).padStart(width)}/${total}] ${job.id.padEnd(34).slice(0, 34)}`;

      if (outcome.error) {
        console.log(`${head} FAILED  ${outcome.error.message.split('\n')[0]}`);
        return;
      }
      const g = outcome.result!.grade;
      const calls = outcome.result!.steps.reduce((n, s) => n + (s.kind === 'say' ? s.calls.length : 0), 0);
      const verdict =
        g.void !== null
          ? `void: ${g.void.slice(0, 40)}`
          : `harm=${word(g.harmed)} done=${word(g.completed)} ${calls} calls`;
      console.log(`${head} ${verdict}`);
    },
  };

  // What this invocation is about, before it starts: an experiment's own counts
  // replace the `repeat` column, so the sheet's totals would be the wrong ones.
  const scope =
    args.experiment === undefined
      ? scopeOf(loaded.episodes.length, loaded.episodes.reduce((n, e) => n + e.repeat, 0))
      : experimentScope(loaded, args.experiment);
  console.log(`${loaded.meta.name}: ${scope}\n`);

  const run = await runResearch(loaded, opts);

  if (args.dry) {
    // Preflight still runs — it is the only thing that catches a rejected
    // temperature, and it costs one call per distinct configuration.
    console.log(`dry: ${run.total} episodes would run. Configuration accepted by the provider.`);
    projection(run.projection, loaded.meta.budget);
    return 0;
  }

  summarise(run, loaded.dir);
  return run.failed.length > 0 || run.stopped !== null ? 1 : 0;
}

const word = (v: boolean | null): string => (v === null ? '—' : v ? 'yes' : 'no');

const scopeOf = (rows: number, episodes: number): string =>
  `${rows} row${rows === 1 ? '' : 's'}, ${episodes} episode${episodes === 1 ? '' : 's'}`;

/** Named but absent is the runner's complaint, and a better one; stay quiet. */
function experimentScope(loaded: LoadedResearch, name: string): string {
  const counts = loaded.experiments.get(name);
  if (counts === undefined) return `experiment ${name}`;
  const episodes = [...counts.values()].reduce((n, c) => n + c, 0);
  return `experiment ${name} — ${scopeOf(counts.size, episodes)}`;
}

/**
 * What it would cost, with the reasoning shown.
 *
 * Printed as an over-estimate on purpose, and said so: a projection that reads
 * low gets believed and then resented. The assumptions are listed because a
 * number without them cannot be argued with, only trusted or ignored.
 */
function projection(p: Projection | undefined, budget: number | undefined): void {
  if (p === undefined) return;

  console.log(`\nprojected cost   ${formatUsd(p.usd)}   for ${p.episodes} episode${p.episodes === 1 ? '' : 's'}`);
  for (const row of p.rows) {
    console.log(`  ${row.id.padEnd(34).slice(0, 34)} ${String(row.episodes).padStart(4)} × ${formatUsd(row.usd === null ? null : row.usd / row.episodes)}   ${formatUsd(row.usd)}`);
  }

  if (p.unpriced.length > 0) {
    console.log(`\n  NOT IN THE TOTAL — the catalog prices no: ${p.unpriced.join(', ')}`);
  }

  console.log('\n  read this as an upper bound:');
  for (const a of p.assumptions) console.log(`    · ${a}`);

  if (budget !== undefined && p.usd !== null) {
    console.log(
      p.usd > budget
        ? `\n  OVER BUDGET — projected ${formatUsd(p.usd)} against a ceiling of ${formatUsd(budget)}.` +
            `\n  The run would stop partway. Raise the budget or cut the matrix.`
        : `\n  within the ${formatUsd(budget)} budget`
    );
  }
}

/** Exactly what `report` prints, plus what this invocation itself did. */
function summarise(run: ResearchRun, from: string): void {
  const episodes = run.rows.reduce((n, r) => n + r.total, 0);
  // Under resume most of the folder was run by someone else, earlier. Saying
  // "12 episodes" over a summary of 900 would be a lie about the sample size.
  const now = run.skipped > 0 ? ` (${run.ran} this run, ${run.skipped} already done)` : '';
  const cost = run.spend === undefined ? '' : `, ${formatUsd(run.spend.usd)}`;
  console.log(`\nran ${run.ran} episode${run.ran === 1 ? '' : 's'}${now} in ${Math.round(run.ms / 1000)}s${cost}\n`);

  if (run.stopped !== null) {
    // A run cut short must never be read as a run that finished clean.
    console.log(`STOPPED EARLY — ${run.stopped}\n`);
  }
  if (run.budget !== undefined && run.spend?.usd != null) {
    console.log(`budget   ${formatUsd(run.spend.usd)} of ${formatUsd(run.budget)}\n`);
  }

  print(run.dir, run.rows, episodes);

  if (run.failed.length > 0) {
    console.log(`\n  ${run.failed.length} episode${run.failed.length === 1 ? '' : 's'} failed:`);
    for (const f of run.failed.slice(0, 5)) console.log(`    ${f.id}  ${f.error.split('\n')[0]}`);
  }

  console.log(`\n${relative(from, resolve(run.dir, 'results.xlsx')).replace(/\\/g, '/')}`);
}

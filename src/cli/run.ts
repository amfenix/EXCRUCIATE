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
import type { ResearchOptions, ResearchRun } from '../run/research.ts';

export interface RunArgs {
  dir: string;
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

  const enabled = loaded.episodes.length;
  const episodes = loaded.episodes.reduce((n, e) => n + e.repeat, 0);
  console.log(`${loaded.meta.name}: ${enabled} row${enabled === 1 ? '' : 's'}, ${episodes} episodes\n`);

  const run = await runResearch(loaded, opts);

  if (args.dry) {
    // Preflight still runs — it is the only thing that catches a rejected
    // temperature, and it costs one call per distinct configuration.
    console.log(`dry: ${run.total} episodes would run. Configuration accepted by the provider.`);
    return 0;
  }

  summarise(run, loaded.dir);
  return run.failed.length > 0 || run.stopped !== null ? 1 : 0;
}

const word = (v: boolean | null): string => (v === null ? '—' : v ? 'yes' : 'no');

/** Exactly what `report` prints, plus what this invocation itself did. */
function summarise(run: ResearchRun, from: string): void {
  const episodes = run.rows.reduce((n, r) => n + r.total, 0);
  // Under resume most of the folder was run by someone else, earlier. Saying
  // "12 episodes" over a summary of 900 would be a lie about the sample size.
  const now = run.skipped > 0 ? ` (${run.ran} this run, ${run.skipped} already done)` : '';
  console.log(`\nran ${run.ran} episode${run.ran === 1 ? '' : 's'}${now} in ${Math.round(run.ms / 1000)}s\n`);

  if (run.stopped !== null) {
    // A run cut short must never be read as a run that finished clean.
    console.log(`STOPPED EARLY — ${run.stopped}\n`);
  }

  print(run.dir, run.rows, episodes);

  if (run.failed.length > 0) {
    console.log(`\n  ${run.failed.length} episode${run.failed.length === 1 ? '' : 's'} failed:`);
    for (const f of run.failed.slice(0, 5)) console.log(`    ${f.id}  ${f.error.split('\n')[0]}`);
  }

  console.log(`\n${relative(from, resolve(run.dir, 'results.xlsx')).replace(/\\/g, '/')}`);
}

/**
 * `excruciate report` — say again what a finished run found.
 *
 * Re-reads the artefacts; runs nothing and calls no provider. That makes it the
 * thing to reach for after a run died halfway, after `results.xlsx` was closed
 * over or lost, or simply months later when the numbers are wanted again.
 *
 * The argument is either a run folder or a research folder, because remembering
 * which is the one with the timestamp in it is not a skill worth demanding.
 */
import { existsSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { readRun } from '../run/read.ts';
import { writeReport } from '../run/report.ts';
import { parseResearch } from '../research/meta.ts';
import { Problems } from '../research/parse.ts';
import { formatBounds, formatRate } from '../run/wilson.ts';
import { formatTokens, formatUsd, sumSpend } from '../cost.ts';
import type { Spend } from '../cost.ts';
import type { Rate } from '../run/wilson.ts';
import type { RowSummary } from '../run/repeat.ts';

export interface ReportArgs {
  /** A run folder, or a research folder whose latest run is wanted. */
  dir: string;
  /** Report on this run instead of the latest. */
  run?: string;
  /** Rewrite results.xlsx from the artefacts. */
  write: boolean;
  json: boolean;
}

export async function cmdReport(args: ReportArgs): Promise<number> {
  const dir = await locate(resolve(args.dir), args.run);
  const folder = readRun(dir);

  if (folder.episodes === 0) {
    console.error(`no episodes in ${dir} — the run wrote no artefacts`);
    return 1;
  }

  if (args.json) {
    console.log(JSON.stringify(folder, null, 2));
  } else {
    print(folder.dir, folder.rows, folder.episodes);
    if (folder.failed.length > 0) {
      console.log(`\n  ${folder.failed.length} episode${folder.failed.length === 1 ? '' : 's'} failed:`);
      for (const f of folder.failed.slice(0, 5)) console.log(`    ${f.id}  ${f.error.split('\n')[0]}`);
    }
  }

  if (args.write) {
    const path = resolve(dir, 'results.xlsx');
    // The failures go back in. A rewritten report that quietly loses them would
    // be a cheerier account of the run than the run deserved.
    await writeReport(path, folder.rows, folder.failed);
    console.log(`\nwrote ${relative(process.cwd(), path).replace(/\\/g, '/')}`);
  }
  return 0;
}

/**
 * Resolve what the user pointed at.
 *
 * A run folder has `episodes/`. A research folder has `research.yaml`, and its
 * runs live under whatever `out` says — which has to be read, not assumed,
 * because the author may have moved it.
 */
async function locate(dir: string, wanted?: string): Promise<string> {
  if (!existsSync(dir)) throw new Error(`no such folder: ${dir}`);

  if (wanted !== undefined) {
    const named = resolve(dir, wanted);
    if (existsSync(resolve(named, 'episodes'))) return named;
    // Also accept the run's bare name against the research's out folder.
    const under = resolve(await outOf(dir), wanted);
    if (existsSync(resolve(under, 'episodes'))) return under;
    throw new Error(`no run named ${wanted} under ${dir}`);
  }

  if (existsSync(resolve(dir, 'episodes'))) return dir;

  const out = await outOf(dir);
  const latest = runsUnder(out).at(-1);
  if (latest === undefined) {
    throw new Error(`no runs under ${out} — nothing has been run from this research yet`);
  }
  return latest;
}

async function outOf(dir: string): Promise<string> {
  const yaml = resolve(dir, 'research.yaml');
  if (!existsSync(yaml)) {
    throw new Error(`${dir} is neither a run folder (no episodes/) nor a research folder (no research.yaml)`);
  }
  // Only `out` is wanted, and a report should still work on a research whose
  // yaml has since been edited into something the loader would reject — so the
  // problems are collected and dropped rather than raised.
  const meta = parseResearch(await Bun.file(yaml).text(), new Problems());
  return resolve(dir, meta.out);
}

/** Timestamped names sort lexicographically into chronological order. */
function runsUnder(out: string): string[] {
  if (!existsSync(out)) return [];
  return readdirSync(out, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(resolve(out, e.name, 'episodes')))
    .map((e) => e.name)
    .sort()
    .map((name) => resolve(out, name));
}

/** `4 of 5 harmed   0.800  [0.376, 0.964]` — the count and the claim together. */
const axisLine = (rate: Rate | null, word: string): string =>
  rate === null ? 'not measured' : `${rate.count} of ${rate.n} ${word}   ${formatBounds(rate)}`;

const spendLine = (spend: Spend): string =>
  `${formatTokens(spend.inputTokens + spend.outputTokens)} tokens  ${formatUsd(spend.usd)}`;

export function print(dir: string, rows: RowSummary[], _episodes: number): void {
  const sum = (pick: (r: RowSummary) => number): number => rows.reduce((n, r) => n + pick(r), 0);
  const spend = sumSpend(rows.map((r) => r.spend));
  console.log(`${relative(process.cwd(), dir).replace(/\\/g, '/')}`);
  console.log(
    `${rows.length} row${rows.length === 1 ? '' : 's'}, ${sum((r) => r.total)} repetitions: ` +
      `${sum((r) => r.n)} scored, ${sum((r) => r.voided)} void, ${sum((r) => r.failed)} failed` +
      `   —   ${formatTokens(spend.inputTokens)} in + ${formatTokens(spend.outputTokens)} out, ${formatUsd(spend.usd)}`
  );

  for (const row of rows) {
    console.log(`\n  ${row.id}   ${row.n}/${row.total} scored   ${spendLine(row.spend)}`);
    // Both axes always, and always with the interval. 0/5 and 0/500 are the same
    // number and different claims — and the counts beside them, because "4 of 5
    // runs were harmed" is the sentence a reader can act on.
    console.log(`    harm        ${axisLine(row.harm, 'harmed')}`);
    console.log(`    completion  ${axisLine(row.completion, 'completed')}`);
    for (const check of row.perCheck) {
      console.log(`    ${check.axis.padEnd(11)} ${check.name.padEnd(28)} ${formatRate(check)}`);
    }
    // A row that mostly voided or failed must not read as a thin but clean one.
    if (row.voided > 0) console.log(`    VOID        ${row.voided}/${row.total}  ${row.voids[0]!.slice(0, 56)}`);
    if (row.failed > 0) console.log(`    FAILED      ${row.failed}/${row.total}  never produced a result`);
  }
}

/**
 * `excruciate combine` — add several runs into one result.
 *
 * The output is a real run folder, so `report` and every query in the docs work
 * on it unchanged. What makes it trustworthy is what it refuses: runs that share
 * an episode, and runs measured against different worlds.
 */
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { loadResearch } from '../research/load.ts';
import { combine } from '../run/combine.ts';
import { print } from './report.ts';

export interface CombineArgs {
  dir: string;
  name?: string;
  runs?: string;
  regardless: boolean;
}

export async function cmdCombine(args: CombineArgs): Promise<number> {
  if (args.name === undefined) {
    console.error('error: combine needs --name, which names the result');
    return 1;
  }
  if (args.runs === undefined) {
    console.error('error: combine needs --runs a,b — the run folders to add together');
    return 1;
  }

  const out = await resultsFolder(args.dir);
  const runs = args.runs
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r !== '');

  try {
    const result = await combine(out, { name: args.name, runs, regardless: args.regardless });

    console.log(`${args.name}: ${result.episodes} episodes from ${result.sources.length} runs\n`);
    for (const s of result.sources) {
      console.log(`  ${s.run.padEnd(44).slice(0, 44)} ${String(s.episodes).padStart(4)} ep  ${s.commit}`);
    }
    if (result.disagreement !== null) {
      // Loudly, and in the folder too. A combined result that crossed worlds
      // must never be read as one that did not.
      console.log(`\nCOMBINED REGARDLESS — ${result.disagreement.split('\n')[0]}`);
    }
    console.log('');

    print(result.dir, result.rows, result.episodes);
    console.log(`\n${relative(process.cwd(), resolve(result.dir, 'results.xlsx')).replace(/\\/g, '/')}`);
    return 0;
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }
}

async function resultsFolder(dir: string): Promise<string> {
  const path = resolve(dir);
  if (existsSync(resolve(path, 'research.yaml'))) {
    const research = await loadResearch(path);
    return resolve(research.dir, research.meta.out);
  }
  return path;
}

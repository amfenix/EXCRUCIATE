/**
 * What happens to a run folder once the episodes are in it.
 *
 * A run that ends with a directory of `.sqlite` files is not finished. Somebody
 * still has to extract the dataset, build the readable spreadsheet and write the
 * report — and "somebody still has to" is exactly the shape of a step that gets
 * skipped on the day it matters, leaving a folder nobody can read and a number
 * that lives only in a chat message.
 *
 * So the research declares it:
 *
 *     after:
 *       - bun scripts/extract.ts {run}
 *       - bun scripts/readable.ts {run}
 *     produces:
 *       - data.json
 *       - findings.xlsx
 *
 * `after` runs in the research directory with `{run}` substituted, and `produces`
 * is checked once they have. What a script can make, the runner now insists on.
 *
 * WHAT IS DELIBERATELY NOT HERE: the report itself. Prose is written by a model,
 * not by a hook, and a `produces: [report.html]` that failed on every automated
 * run would be noise within a week. `runs` says which folders have no report
 * instead — pressure, rather than a gate nothing can pass.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface AfterResult {
  /** Commands that ran, in order, with what each returned. */
  steps: Array<{ command: string; code: number; ms: number }>;
  /** Declared in `produces` and not in the folder once the hooks were done. */
  missing: string[];
  /** The first thing that went wrong, for the journal and the exit code. */
  problem: string | null;
}

export async function runAfter(
  dir: string,
  runDir: string,
  commands: string[],
  produces: string[],
  onStep?: (command: string) => void
): Promise<AfterResult> {
  const steps: AfterResult['steps'] = [];
  let problem: string | null = null;

  for (const template of commands) {
    // `{run}` is the run folder, absolute. A hook that had to guess which folder
    // it was analysing would guess "the latest", and under `--resume` or two
    // runs a minute apart that is the wrong one.
    const command = template.replaceAll('{run}', runDir);
    onStep?.(command);

    const began = Date.now();
    const code = await execute(command, dir);
    steps.push({ command, code, ms: Date.now() - began });

    if (code !== 0) {
      // Stop at the first failure: the later steps consume what the earlier ones
      // write, so running them on would only produce a second, more confusing
      // error about a file that was never made.
      problem = `after step failed (exit ${code}): ${template}`;
      break;
    }
  }

  const missing = problem === null ? produces.filter((f) => !existsSync(resolve(runDir, f))) : [];
  if (problem === null && missing.length > 0) {
    problem = `the run produced no ${missing.join(', ')} — declared in \`produces\``;
  }
  return { steps, missing, problem };
}

/**
 * Through Bun's own shell, not the platform's.
 *
 * These are commands a person wrote in their own research file, so they contain
 * quotes and pipes as such commands do — and a research must run the same on
 * every machine. Handing the string to `cmd /c` did neither: it passed the
 * quotes through literally, so a hook received `"C:\…\run"` with the quotation
 * marks still attached and wrote its output to a path that could not exist.
 */
async function execute(command: string, cwd: string): Promise<number> {
  const result = await Bun.$`${{ raw: command }}`.cwd(cwd).nothrow();
  return result.exitCode;
}

/**
 * What the reporting cost, if whoever built it said so.
 *
 * Kept apart from the run's own spend rather than added to it. They answer
 * different questions — what the experiment cost to measure, and what it cost to
 * write up — and a single total lets an expensive analysis hide inside a cheap
 * run, or make a cheap one look unaffordable to repeat.
 */
export async function reportSpend(runDir: string): Promise<number | null> {
  const path = resolve(runDir, 'report.spend.json');
  if (!existsSync(path)) return null;

  try {
    const parsed = (await Bun.file(path).json()) as { usd?: unknown };
    return typeof parsed.usd === 'number' && Number.isFinite(parsed.usd) ? parsed.usd : null;
  } catch {
    return null;
  }
}

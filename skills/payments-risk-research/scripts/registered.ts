/**
 * Refuse a research whose tasks are not registered in `cases.xlsx`.
 *
 * WHY THIS EXISTS. `cases.xlsx` is where a case is described in business terms:
 * what the agent is asked to do, where in the flow it sits, what counts as harm.
 * `episodes.xlsx` is the matrix that runs. Nothing connected the two, so they
 * drifted — twice, in the same week, in opposite directions:
 *
 *   · someone asked for "a smoke test" with a model that had not been tried
 *     before. The assistant scaffolded a fresh task from the generic template
 *     and pointed the run at that instead of at an existing case. The task was
 *     described nowhere, nobody had read it, and its invented prose did not
 *     match the fixture's seed data — so the run measured the scaffold, and the
 *     result looked like a fact about the new model. It was not.
 *
 *   · this skill's own author rebuilt a matrix into a six-model sweep, updated
 *     `episodes.xlsx` and `hypotheses.yaml`, and left `cases.xlsx` describing
 *     the conditions of the previous experiment and a task prompt that had been
 *     deliberately abandoned.
 *
 * Both are the same failure: a run whose business meaning is recorded nowhere.
 * A reader of the spreadsheet then learns the wrong thing about what was tested,
 * which is worse than learning nothing.
 *
 * This is a lint, not a grader. It never looks at results.
 *
 *   bun registered.ts <research-dir>
 */
import ExcelJS from 'exceljs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

interface Problem {
  where: string;
  message: string;
}

interface Sheet {
  headers: string[];
  rows: string[][];
}

const yaml = (path: string): Record<string, unknown> =>
  (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML.parse(
    readFileSync(path, 'utf8')
  ) as Record<string, unknown>;

/** `TC-FP-02` out of `TC-FP-02 — funding the account fires…`, else null. */
const caseIdOf = (taskName: string): string | null =>
  /^\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)/.exec(taskName)?.[1] ?? null;

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && 'text' in v) return String((v as { text: unknown }).text).trim();
  return String(v).trim();
};

/** Read a sheet as rows of trimmed strings, with the header row separated out. */
async function sheet(file: string, name: string): Promise<Sheet | null> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(name);
  if (!ws) return null;

  const rows: string[][] = [];
  let headers: string[] = [];
  ws.eachRow((row, i) => {
    const values = (row.values as unknown[]).slice(1).map(cell);
    if (i === 1) headers = values;
    else if (values.some((v) => v !== '')) rows.push(values);
  });
  return { headers, rows };
}

/** Every live row must appear in the `conditions` sheet. */
function unregisteredRows(live: string[][], idC: number, described: Set<string>): Problem[] {
  return live
    .filter((r) => !described.has(r[idC] ?? ''))
    .map((r) => ({
      where: r[idC] ?? '(no id)',
      message:
        'runs but is not in the `conditions` sheet of cases.xlsx. Add a row: ' +
        'what is different, why it is in the matrix, which hypothesis it serves.',
    }));
}

/** One task, resolved to the case id it claims. */
function taskProblem(task: string, usedBy: string, tasksDir: string, cases: Set<string>): Problem | null {
  const taskPath = resolve(tasksDir, task);
  if (!existsSync(taskPath)) {
    return { where: task, message: `is referenced by ${usedBy} but does not exist in tasks/` };
  }

  const name = String(yaml(taskPath)['name'] ?? '');
  if (name === '') {
    return { where: task, message: 'has no `name:` — a task nobody can name is a task nobody described' };
  }

  const id = caseIdOf(name);
  if (id === null) {
    return {
      where: task,
      message: `name "${name}" does not begin with a case id such as TC-FP-02, so it cannot be matched to cases.xlsx`,
    };
  }
  if (!cases.has(id)) {
    return {
      where: task,
      message: `is case ${id}, which is not in the \`cases\` sheet of cases.xlsx. Describe it before running it.`,
    };
  }
  return null;
}

/** Every task a live row points at must be described in `cases`. */
function unregisteredTasks(
  live: string[][],
  cols: { id: number; task: number },
  tasksDir: string,
  cases: Set<string>
): { problems: Problem[]; seen: Set<string> } {
  const problems: Problem[] = [];
  const seen = new Set<string>();

  for (const r of live) {
    const task = r[cols.task] ?? '';
    if (task === '' || seen.has(task)) continue;
    seen.add(task);

    const problem = taskProblem(task, r[cols.id] ?? '(no id)', tasksDir, cases);
    if (problem !== null) problems.push(problem);
  }
  return { problems, seen };
}

/**
 * Is this research somewhere its results will be found again?
 *
 * Asked for "a smoke test with a new model", an assistant scaffolded a research
 * into a scratch directory and ran it there. The task was a template, the
 * results landed in the system temp folder, and on macOS they were not even
 * visible without turning on hidden files. Nothing in the output said anything
 * was wrong — the run simply happened somewhere nobody would look.
 */
function strayLocation(dir: string): string[] {
  const stray: string[] = [];
  const full = resolve(dir);

  if (full.toLowerCase().startsWith(resolve(tmpdir()).toLowerCase())) {
    stray.push(`${full}\n    is inside the system temp directory — results written here are lost`);
  }

  let at = full;
  while (!existsSync(join(at, '.git'))) {
    const up = dirname(at);
    if (up === at) {
      stray.push(`${full}\n    is not inside a git working tree — a research belongs in the repository`);
      break;
    }
    at = up;
  }
  return stray;
}

/** A warning block, or nothing at all when there is nothing to say. */
function warn(items: string[], noun: string, tail: string): void {
  if (items.length === 0) return;
  console.warn(`\nwarning: ${items.length} ${noun}${items.length === 1 ? '' : 's'} ${tail}`);
  for (const item of items) console.warn(`  ${item}`);
}

function report(
  problems: Problem[],
  live: number,
  tasks: number,
  stale: string[],
  orphans: string[],
  stray: string[]
): void {
  // First, because everything below is about a research that may be in the
  // wrong place entirely.
  warn(stray, 'location problem', '— this run will be hard to find again:');

  if (problems.length > 0) {
    console.error(`${problems.length} problem${problems.length === 1 ? '' : 's'}:\n`);
    for (const p of problems) console.error(`  ${p.where}\n    ${p.message}\n`);
  } else {
    console.log(`ok  ${live} live rows, ${tasks} tasks, all registered in cases.xlsx`);
  }

  warn(
    stale,
    'row',
    'described in cases.xlsx no longer runs — delete or mark them, or the spreadsheet ' +
      'describes an experiment nobody performed:'
  );
  warn(orphans.map((f) => basename(f)), 'task file', 'in tasks/ that no live row uses — check none is a leftover scaffold:');
}

/** Read the two workbooks, or explain which one is missing and stop. */
async function load(dir: string): Promise<{ episodes: Sheet; cases: Sheet | null; conditions: Sheet | null }> {
  const episodesFile = resolve(dir, 'episodes.xlsx');
  const casesFile = resolve(dir, 'cases.xlsx');

  if (!existsSync(episodesFile)) {
    console.error(`episodes.xlsx is missing from ${dir}`);
    process.exit(2);
  }
  if (!existsSync(casesFile)) {
    console.error(`cases.xlsx is missing from ${dir}`);
    console.error('  Every task a research runs must be described there in business terms.');
    process.exit(2);
  }

  const episodes = await sheet(episodesFile, 'episodes');
  if (!episodes) {
    console.error('episodes.xlsx has no `episodes` sheet');
    process.exit(2);
  }
  return {
    episodes,
    cases: await sheet(casesFile, 'cases'),
    conditions: await sheet(casesFile, 'conditions'),
  };
}

async function main(): Promise<void> {
  const dir = resolve(process.argv[2] ?? '.');
  const tasksDir = resolve(dir, 'tasks');
  const { episodes, cases, conditions } = await load(dir);

  const problems: Problem[] = [];
  if (!cases) problems.push({ where: 'cases.xlsx', message: 'has no `cases` sheet' });
  if (!conditions) problems.push({ where: 'cases.xlsx', message: 'has no `conditions` sheet' });

  const col = (h: string): number => episodes.headers.indexOf(h);
  const cols = { id: col('id'), enabled: col('enabled'), task: col('task') };

  const registeredCases = new Set((cases?.rows ?? []).map((r) => r[0] ?? '').filter(Boolean));
  const describedRows = new Set((conditions?.rows ?? []).map((r) => r[0] ?? '').filter(Boolean));

  const live = episodes.rows.filter((r) => (r[cols.enabled] ?? '').toLowerCase() !== 'no');
  const liveIds = new Set(live.map((r) => r[cols.id] ?? ''));

  problems.push(...unregisteredRows(live, cols.id, describedRows));
  const { problems: taskProblems, seen } = unregisteredTasks(live, cols, tasksDir, registeredCases);
  problems.push(...taskProblems);

  // Conditions describing rows that no longer run — the drift that made this script.
  const stale = [...describedRows].filter((id) => !liveIds.has(id));
  // Tasks sitting in tasks/ that nothing runs — usually a scaffold left behind.
  const orphans = existsSync(tasksDir)
    ? readdirSync(tasksDir).filter((f) => /\.ya?ml$/.test(f) && !seen.has(f))
    : [];

  report(problems, live.length, seen.size, stale, orphans, strayLocation(dir));
  process.exit(problems.length > 0 ? 1 : 0);
}

await main();

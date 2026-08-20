/**
 * `excruciate matrix` — fill the workbook from the task files.
 *
 * It reads the tasks, so it already knows every case and, crucially, every fault
 * each one declares BY NAME. Then it asks what to vary and writes the
 * cross-product as rows.
 *
 * Two opinions are built in, both overridable:
 *
 *   THE CONTROL COMES FREE. Select any fault and `faults: none` is added for the
 *   same combination. A harm rate under a fault means nothing without the rate
 *   without it, and forgetting the control is the easiest way to produce a number
 *   that looks like a finding.
 *
 *   IDS ARE DERIVED AND STABLE, so running this again ADDS what is new and leaves
 *   every existing row alone — including ones you disabled or annotated.
 */
import ExcelJS from 'exceljs';
import { readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseResearch } from '../research/meta.ts';
import { parseTask } from '../research/task.ts';
import { Problems } from '../research/parse.ts';
import { ResearchError } from '../research/types.ts';
import { HEADER } from './init.ts';
import { normalise } from '../research/columns.ts';
import { chooseMany, interactive, line, slug } from './prompt.ts';
import type { Task } from '../research/types.ts';

const SURFACES = ['tools', 'api', 'search'] as const;
const MEMORIES = ['session', 'fresh'] as const;

export interface MatrixArgs {
  dir: string;
  tasks?: string;
  models?: string;
  surfaces?: string;
  memory?: string;
  faults?: string;
  tools?: string;
  temperature?: string;
  thinking?: string;
  repeat?: string;
  yes: boolean;
}

interface Cell {
  task: string;
  model: string;
  surface: string;
  memory: string;
  faults: string;
  tools: string;
  temperature: string;
  thinking: string;
}

export async function cmdMatrix(args: MatrixArgs): Promise<number> {
  const dir = resolve(args.dir);
  const p = new Problems();
  const meta = parseResearch(await Bun.file(resolve(dir, 'research.yaml')).text(), p);
  if (!p.ok) throw new ResearchError(p.list);

  const taskDir = resolve(dir, meta.tasks);
  const files = readdirSync(taskDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  if (files.length === 0) {
    console.error(`error: no task files in ${taskDir}`);
    return 1;
  }

  const tasks = new Map<string, Task>();
  for (const file of files) tasks.set(file, parseTask(await Bun.file(resolve(taskDir, file)).text(), file, p));
  if (!p.ok) throw new ResearchError(p.list);

  const cells = await plan(args, meta.surface, files, tasks);
  if (cells.length === 0) {
    console.error('error: nothing selected');
    return 1;
  }

  const repeat = args.repeat ?? (await line('Repetitions per row?', '20'));
  const book = resolve(dir, 'episodes.xlsx');
  const { added, kept } = await append(book, cells, repeat);

  console.log(`\n${book}`);
  console.log(`  ${added.length} row${added.length === 1 ? '' : 's'} added, ${kept} left alone`);
  for (const id of added.slice(0, 12)) console.log(`    ${id}`);
  if (added.length > 12) console.log(`    … and ${added.length - 12} more`);

  const runs = added.length * Number(repeat);
  console.log(`\n  ${added.length} × ${repeat} = ${runs} model runs when enabled`);
  return 0;
}

/** What varies. One array per column of the matrix, in the order they cross. */
interface Axes {
  tasks: string[];
  models: string[];
  surfaces: string[];
  memories: string[];
  temperatures: string[];
  thinkings: string[];
}

async function plan(
  args: MatrixArgs,
  defaultSurface: string,
  files: string[],
  tasks: Map<string, Task>
): Promise<Cell[]> {
  const axes = await axesOf(args, defaultSurface, files);
  const cells: Cell[] = [];
  // Faults are per-task — each case declares its own by name — so they cross
  // inside the loop rather than being one more axis of the whole matrix.
  for (const task of axes.tasks) {
    const faultSets = await faultSetsFor(task, args, tasks);
    cells.push(...cellsFor(task, faultSets, await toolSetsFor(task, args, tasks), axes));
  }
  return cells;
}

/** Every axis, from a flag if given and from a question if not. */
async function axesOf(args: MatrixArgs, defaultSurface: string, files: string[]): Promise<Axes> {
  const pick = async (
    flag: string | undefined,
    question: string,
    options: readonly string[],
    fallback: readonly string[]
  ): Promise<string[]> => (flag !== undefined ? split(flag) : await chooseMany(question, options, fallback));

  const temperatures = args.temperature !== undefined ? split(args.temperature) : [''];
  return {
    tasks: await pick(args.tasks, 'Cases?', files, files),
    models: args.models !== undefined ? split(args.models) : [await askModel()],
    surfaces: await pick(args.surfaces, 'Surfaces?', SURFACES, [defaultSurface]),
    memories: await pick(args.memory, 'Memory?', MEMORIES, ['session']),
    temperatures,
    // Exclusive by construction: the pairing is refused at load, so the matrix
    // must not be able to build a row that will be rejected.
    thinkings: temperatures.some((t) => t !== '')
      ? ['']
      : args.thinking !== undefined
        ? split(args.thinking)
        : [''],
  };
}

/**
 * The tool lists to run one task under. Blank — nothing chosen — is the whole API.
 *
 * Per-task, like faults, because a task declares its own lists by name. Unlike
 * faults nothing is added for free: there is no baseline every narrow surface
 * has to be read against, so choosing `minimal` gives you `minimal` and adding
 * rows nobody asked for would be its own surprise. Run matrix again without
 * `--tools` to get the whole-API rows alongside them.
 */
async function toolSetsFor(task: string, args: MatrixArgs, tasks: Map<string, Task>): Promise<string[]> {
  const declared = Object.keys(tasks.get(task)?.tools ?? {});
  if (declared.length === 0) return [''];

  const wanted =
    args.tools !== undefined
      ? split(args.tools).filter((t) => declared.includes(t))
      : await chooseMany(`Tool lists for ${task}?`, declared, []);

  return wanted.length === 0 ? [''] : [...new Set(wanted)];
}

/** The faults to run for one task, with the control always included. */
async function faultSetsFor(task: string, args: MatrixArgs, tasks: Map<string, Task>): Promise<string[]> {
  const declared = declaredFaults(tasks.get(task));
  const wanted =
    args.faults !== undefined
      ? split(args.faults).filter((f) => f === 'none' || declared.includes(f))
      : await chooseMany(`Faults for ${task}?`, declared, declared);

  // The control, always, whenever a fault was chosen. A harm rate under a fault
  // means nothing without the rate without it.
  return [...new Set(['none', ...wanted])];
}

const cellsFor = (task: string, faultSets: string[], toolSets: string[], axes: Axes): Cell[] =>
  product([
    axes.models,
    axes.surfaces,
    axes.memories,
    axes.temperatures,
    axes.thinkings,
    faultSets,
    toolSets,
  ]).map(([model, surface, memory, temperature, thinking, faults, tools]) => ({
    task,
    model: model!,
    surface: surface!,
    memory: memory!,
    temperature: temperature!,
    thinking: thinking!,
    faults: faults!,
    tools: tools!,
  }));

/**
 * Cartesian product, in axis order.
 *
 * This replaced six nested loops. Adding an axis is now an entry in a list
 * rather than another level of indentation — which is what six nested loops
 * were quietly charging for.
 */
export const product = <T>(axes: T[][]): T[][] =>
  axes.reduce<T[][]>((rows, axis) => rows.flatMap((row) => axis.map((value) => [...row, value])), [[]]);

const split = (flag: string): string[] => flag.split(',').map((s) => s.trim());

const declaredFaults = (task: Task | undefined): string[] => [
  ...new Set((task?.steps ?? []).flatMap((s) => ('faults' in s ? (s.faults ?? []).map((f) => f.name) : []))),
];

async function askModel(): Promise<string> {
  if (!interactive()) return 'anthropic/claude-haiku-4.5';
  console.error('\n(catalog ids — `excruciate models` lists them)');
  return await line('Model?', 'anthropic/claude-haiku-4.5');
}

/** Stable, and legal as a filename: an id names the artefact. */
const idOf = (c: Cell): string =>
  slug(
    [
      basename(c.task).replace(/\.ya?ml$/, ''),
      c.model.split('/').pop() ?? c.model,
      c.surface,
      c.memory,
      c.temperature === '' ? '' : `t${c.temperature}`,
      c.thinking === '' ? '' : c.thinking,
      c.faults === 'none' ? 'clean' : c.faults.replace(/,/g, '+'),
      c.tools,
    ]
      .filter((part) => part !== '')
      .join('__')
  );

/**
 * One cell's worth of every column, keyed by NORMALISED column name.
 *
 * A column the matrix has no opinion about — `fixture`, `notes` — is simply
 * absent, so an existing value in that column is left alone.
 */
function valuesFor(cell: Cell, id: string, repeat: string): Record<string, string> {
  return {
    id,
    enabled: 'yes',
    task: cell.task,
    model: cell.model,
    surface: cell.surface,
    temperature: cell.temperature,
    thinking: cell.thinking,
    memory: cell.memory,
    faults: cell.faults,
    tools: cell.tools,
    repeat,
  };
}

/**
 * Add what is new, touch nothing else.
 *
 * A row someone disabled or annotated is a decision, and rewriting it would
 * throw that away silently.
 */
async function append(
  path: string,
  cells: Cell[],
  repeat: string
): Promise<{ added: string[]; kept: number }> {
  const wb = new ExcelJS.Workbook();
  let sheet: ExcelJS.Worksheet;
  try {
    await wb.xlsx.readFile(path);
    sheet = wb.worksheets[0]!;
  } catch {
    sheet = wb.addWorksheet('episodes');
    sheet.addRow(HEADER);
  }

  const columns = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, i) => columns.set(normalise(String(cell.text)), i));

  const existing = new Set<string>();
  for (let line = 2; line <= sheet.rowCount; line++) {
    const id = String(sheet.getRow(line).getCell(columns.get('id') ?? 1).text).trim();
    if (id !== '') existing.add(id);
  }

  const added: string[] = [];
  for (const cell of cells) {
    const id = idOf(cell);
    if (existing.has(id)) continue;
    existing.add(id);
    added.push(id);

    // BY NAME, against the header actually present. Writing a positional array
    // meant this list and the header had to agree by eye, and they stopped
    // agreeing — two supported columns went missing and every value after them
    // landed one cell to the left.
    const values = valuesFor(cell, id, repeat);
    const row = sheet.addRow([]);
    for (const [name, index] of columns) {
      const value = values[name];
      if (value !== undefined) row.getCell(index).value = value;
    }
    row.commit();
  }

  if (added.length > 0) await wb.xlsx.writeFile(path);
  return { added, kept: existing.size - added.length };
}

export const _internal = { idOf, declaredFaults };

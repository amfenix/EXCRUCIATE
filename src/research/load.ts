/**
 * Read a research folder and prove it will run, before anything is spent.
 *
 * Everything checkable is checked here: the settings, every row, every task file,
 * every fault name, every `@file`, and every grading query prepared against the
 * real world. Only two things are left for the runner — the provider preflight,
 * which costs money, and the model's behaviour, which is the point.
 *
 * DISABLED ROWS ARE VALIDATED TOO. A row that is off should still be correct, or
 * it breaks on the day someone turns it on — which is always a day when they are
 * in a hurry.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { World } from '../core/world.ts';
import { validateChecks } from '../episode/grade.ts';
import { activeFaults } from '../episode/run.ts';
import { validateStatic } from '../preflight.ts';
import { fileRefsOf } from '../episode/text.ts';
import { Problems } from './parse.ts';
import { parseResearch } from './meta.ts';
import { parseTask } from './task.ts';
import { manifestFor, narrow } from '../surface/manifest.ts';
import { readWorkbook } from './workbook.ts';
import { ResearchError } from './types.ts';
import type { Episode, Init } from '../episode/types.ts';
import type { Manifest } from '../surface/types.ts';
import type { EpisodeRow, Research, Task } from './types.ts';

export interface LoadedEpisode {
  row: EpisodeRow;
  episode: Episode;
  repeat: number;
  /** Kept so a surface restriction can be checked against the row. */
  task: Task | undefined;
}

export interface LoadedResearch {
  dir: string;
  meta: Research;
  /** Enabled rows only — but every row was validated. */
  episodes: LoadedEpisode[];
  disabled: EpisodeRow[];
}

export interface LoadOptions {
  /** Defaults to `research.yaml` and `episodes.xlsx` in the folder. */
  meta?: string;
  workbook?: string;
}

export async function loadResearch(dir: string, opts: LoadOptions = {}): Promise<LoadedResearch> {
  const root = resolve(dir);
  const p = new Problems();

  const metaPath = resolve(root, opts.meta ?? 'research.yaml');
  const bookPath = resolve(root, opts.workbook ?? 'episodes.xlsx');
  for (const path of [metaPath, bookPath]) {
    if (!existsSync(path)) p.add(basename(path), `not found at ${path}`);
  }
  if (!p.ok) throw new ResearchError(p.list);

  const meta = parseResearch(await Bun.file(metaPath).text(), p);
  const rows = await readWorkbook(bookPath, p);
  if (!p.ok) throw new ResearchError(p.list);

  const tasks = await readTasks(root, meta, rows, p);
  const built = rows.map((row) => build(root, meta, row, tasks.get(row.task), p));

  validateAll(built, p);
  await validateToolsets(built, p);
  if (!p.ok) throw new ResearchError(p.list);

  return {
    dir: root,
    meta,
    episodes: built.filter((b) => b.row.enabled),
    disabled: built.filter((b) => !b.row.enabled).map((b) => b.row),
  };
}

/** Each task file is read once, however many rows point at it. */
async function readTasks(
  root: string,
  meta: Research,
  rows: EpisodeRow[],
  p: Problems
): Promise<Map<string, Task>> {
  const tasks = new Map<string, Task>();
  for (const name of new Set(rows.map((r) => r.task).filter((t) => t !== ''))) {
    const path = resolve(root, meta.tasks, name);
    if (!existsSync(path)) {
      p.add(`task ${name}`, `not found at ${path}`);
      continue;
    }
    tasks.set(name, parseTask(await Bun.file(path).text(), `task ${name}`, p));
  }
  return tasks;
}

function build(
  root: string,
  meta: Research,
  row: EpisodeRow,
  task: Task | undefined,
  p: Problems
): LoadedEpisode {
  const episode: Episode = {
    id: row.id,
    fixture: resolve(root, row.fixture ?? meta.fixture),
    // Prompts and policies live with the research; the fixture is only the world.
    root,
    mode: meta.mode,
    // The row wins; the research only supplies a default.
    surface: row.surface ?? meta.surface,
    model: row.model,
    memory: row.memory,
    faults: row.faults,
    tools: toolsFor(row, task, p),
    // Carried into the artefact so a run folder can be reported on by itself.
    row: { id: row.id, task: row.task, ...(row.notes !== undefined ? { notes: row.notes } : {}) },
    init: initFor(row, task, p),
    steps: task?.steps ?? [],
    grade: task?.grade ?? { checks: [] },
    ...(row.temperature !== undefined ? { temperature: row.temperature } : {}),
    ...(row.thinking !== undefined ? { thinking: row.thinking } : {}),
    ...(row.resetTools !== undefined ? { resetToolsOnFresh: row.resetTools } : {}),
    ...(row.parallelToolCalls !== undefined ? { parallelToolCalls: row.parallelToolCalls } : {}),
    ...(task?.maxSteps !== undefined ? { maxSteps: task.maxSteps } : {}),
  };
  return { row, episode, repeat: row.repeat, task };
}

/**
 * The row may name a system prompt the task declares; otherwise the task's own.
 *
 * An undeclared name is a problem rather than a silent fallback to the default
 * prompt: a ladder rung that quietly ran the wrong prompt would read as a model
 * result, which is the failure this column exists to make visible.
 */
function initFor(row: EpisodeRow, task: Task | undefined, p: Problems): Init {
  const base = task?.init ?? { system: '', clock: { now: '2000-01-01 00:00:00', business_day: 1 } };
  if (row.prompt === undefined || task === undefined) return base;

  const declared = task.prompts ?? {};
  if (row.prompt in declared) return { ...base, system: declared[row.prompt]! };

  const names = Object.keys(declared);
  p.add(
    `row ${row.line} (${row.id || 'no id'})`,
    names.length === 0
      ? `prompt names "${row.prompt}", but task ${row.task} declares no prompts`
      : `prompt names "${row.prompt}", which task ${row.task} does not declare \u2014 it has ${names.join(', ')}`
  );
  return base;
}

/**
 * The row names a list; the task file declares it. Here the two meet.
 *
 * An undeclared name is a problem rather than a quiet fallback to everything: a
 * typo that widened the surface back to the whole API would show up as a model
 * difference, which is the failure this column exists to make visible.
 */
function toolsFor(row: EpisodeRow, task: Task | undefined, p: Problems): 'all' | string[] {
  if (row.toolset === undefined) return 'all';
  // A missing task file is already reported; saying it twice helps nobody.
  if (task === undefined) return 'all';

  const declared = task.tools ?? {};
  const list = declared[row.toolset];
  if (list !== undefined) return list;

  const names = Object.keys(declared);
  p.add(
    `row ${row.line} (${row.id || 'no id'})`,
    names.length === 0
      ? `tools names "${row.toolset}", but task ${row.task} declares no tool lists`
      : `tools names "${row.toolset}", which task ${row.task} does not declare \u2014 it has ${names.join(', ')}`
  );
  return 'all';
}

/**
 * Prove every declared list names operations the fixture really has.
 *
 * The runner would refuse anyway, but that is one episode into a paid run. Every
 * list is checked, not only the ones rows currently use — same reason disabled
 * rows are validated: a list is wrong on the day someone names it, and that is
 * always a day when they are in a hurry.
 */
async function validateToolsets(built: LoadedEpisode[], p: Problems): Promise<void> {
  const manifests = new Map<string, Manifest | null>();
  const done = new Set<string>();

  for (const { row, episode, task } of built) {
    if (task?.tools === undefined) continue;
    // One task against one fixture is one check, however many rows say so.
    const key = `${row.task}\u0000${episode.fixture}`;
    if (done.has(key)) continue;
    done.add(key);

    if (!manifests.has(episode.fixture)) {
      let manifest: Manifest | null = null;
      // A fixture that will not load at all is already reported by validateRow.
      try {
        manifest = await manifestFor(episode.fixture);
      } catch {
        manifest = null;
      }
      manifests.set(episode.fixture, manifest);
    }

    const manifest = manifests.get(episode.fixture) ?? null;
    if (manifest === null) continue;

    for (const [name, ops] of Object.entries(task.tools)) {
      collect(p, `task ${row.task}`, () => void narrow(manifest, ops, `tools list "${name}"`));
    }
  }
}

function validateAll(built: LoadedEpisode[], p: Problems): void {
  // One world per fixture, reused: opening a SQLite database per row would be
  // wasteful and would say nothing extra.
  const worlds = new Map<string, World | null>();
  for (const entry of built) validateRow(entry, worlds, p);
  for (const world of worlds.values()) world?.close();
}

function validateRow({ row, episode, task }: LoadedEpisode, worlds: Map<string, World | null>, p: Problems): void {
  const where = `row ${row.line} (${row.id || 'no id'})`;

  // A task that only makes sense on one surface says so; running it elsewhere
  // would produce a number rather than an answer.
  if (task?.surfaces !== undefined && !task.surfaces.includes(episode.surface)) {
    p.add(where, `task ${row.task} runs only on ${task.surfaces.join(', ')} — this row asks for ${episode.surface}`);
  }

  if (!existsSync(episode.fixture)) {
    p.add(where, `fixture not found: ${episode.fixture}`);
    return;
  }

  collect(p, where, () => validateStatic(episode));
  // A misspelt fault name would otherwise produce a silent clean run, which
  // reads as a model that came to no harm.
  collect(p, where, () => activeFaults(episode));

  for (const ref of fileRefsOf(episode)) {
    if (!existsSync(resolve(episode.root ?? episode.fixture, ref.path))) {
      p.add(where, `${ref.where}: no such file: ${ref.path}`);
    }
  }

  const world = worldFor(episode.fixture, worlds, p, where);
  if (world !== null) collect(p, where, () => validateChecks(world, episode.grade));
}

/**
 * Run one check, recording its complaint rather than throwing.
 *
 * The whole point of the loader is to say EVERYTHING that is wrong at once —
 * one throwing check would hide the other eight hundred rows.
 */
function collect(p: Problems, where: string, check: () => void): void {
  try {
    check();
  } catch (e) {
    p.add(where, (e as Error).message);
  }
}

/**
 * A throwaway world, just so grading SQL can be prepared against a real schema.
 *
 * Cached per fixture: the point is to catch a typo'd column, and opening one
 * database per row would say nothing extra.
 */
function worldFor(fixture: string, cache: Map<string, World | null>, p: Problems, where: string): World | null {
  if (cache.has(fixture)) return cache.get(fixture)!;

  let world: World | null = null;
  try {
    world = World.open({
      session: 'validate',
      path: ':memory:',
      schemaSql: readFileSync(resolve(fixture, 'schema.sql'), 'utf8'),
      clock: { now: '2000-01-01 00:00:00', business_day: 1 },
    });
  } catch (e) {
    p.add(where, `fixture will not open: ${(e as Error).message}`);
  }
  cache.set(fixture, world);
  return world;
}

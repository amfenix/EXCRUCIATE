/**
 * Rebuild a run's summary from the artefacts on disk.
 *
 * The `.sqlite` files are the source of truth, not `results.xlsx`. That matters
 * twice: a report can be regenerated after the spreadsheet is lost or the format
 * changes, and — the reason this exists — a RESUMED run must report every
 * episode, not only the ones the last invocation happened to execute.
 *
 * Nothing here needs the research folder. A run directory is self-describing.
 */
import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { wilson } from './wilson.ts';
import type { Axis } from '../episode/types.ts';
import type { Rate } from './wilson.ts';
import type { CheckRate, RowSummary } from './repeat.ts';

interface Artefact {
  row: string;
  id: string;
  model: string;
  surface: string;
  memory: string;
  faults: string;
  task: string;
  notes: string;
  void: string | null;
  harmed: number | null;
  completed: number | null;
  checks: Array<{ name: string; axis: Axis; ok: number }>;
}

export interface RunFolder {
  dir: string;
  rows: RowSummary[];
  episodes: number;
  /** Episodes that never produced an artefact, so nothing else records them. */
  failed: Failure[];
}

export interface Failure {
  id: string;
  error: string;
}

const FAILURES = 'failures.json';

export function readRun(dir: string): RunFolder {
  const episodesDir = resolve(dir, 'episodes');
  if (!existsSync(episodesDir)) throw new Error(`${dir} is not a run folder — it has no episodes/`);

  const artefacts = readdirSync(episodesDir)
    .filter((f) => f.endsWith('.sqlite'))
    .map((f) => read(resolve(episodesDir, f)))
    .filter((a): a is Artefact => a !== null);

  const failed = readFailures(dir);

  const byRow = new Map<string, Artefact[]>();
  for (const a of artefacts) {
    const list = byRow.get(a.row);
    if (list) list.push(a);
    else byRow.set(a.row, [a]);
  }

  // A row whose every repetition failed has NO artefact, and would otherwise
  // vanish from the report entirely — the run would read as though that row was
  // never asked for. Its failures are what put it back.
  const failuresByRow = new Map<string, number>();
  for (const f of failed) {
    const row = rowOf(f.id);
    failuresByRow.set(row, (failuresByRow.get(row) ?? 0) + 1);
    if (!byRow.has(row)) byRow.set(row, []);
  }

  return {
    dir,
    episodes: artefacts.length,
    rows: [...byRow.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, group]) => summarise(id, group, failuresByRow.get(id) ?? 0)),
    failed,
  };
}

/** An episode id is `<row>-<n>` by construction. */
const rowOf = (episodeId: string): string => episodeId.replace(/-\d+$/, '');

/**
 * A failed episode writes no artefact, so unless the failures are kept beside
 * them a re-read of the folder is quietly cheerier than the run was. They live
 * in a small JSON file for exactly that reason.
 */
export function readFailures(dir: string): Failure[] {
  const path = resolve(dir, FAILURES);
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? (parsed as Failure[]) : [];
  } catch {
    return [];
  }
}

/**
 * Merge this invocation's failures into the folder's record and return the lot.
 *
 * Anything that has since produced an artefact is dropped: under `resume` an
 * episode that failed yesterday and succeeded today is not a failure, and
 * leaving it in would make a fixed run look permanently broken.
 */
export function recordFailures(dir: string, failed: Failure[]): Failure[] {
  const episodes = resolve(dir, 'episodes');
  const byId = new Map(readFailures(dir).map((f) => [f.id, f]));
  for (const f of failed) byId.set(f.id, f);

  const merged = [...byId.values()].filter((f) => !existsSync(resolve(episodes, `${f.id}.sqlite`)));
  if (merged.length > 0 || existsSync(resolve(dir, FAILURES))) {
    writeFileSync(resolve(dir, FAILURES), JSON.stringify(merged, null, 2));
  }
  return merged;
}

function read(path: string): Artefact | null {
  // Read-only, as a reader should be. `World.close` leaves the artefact on a
  // rollback journal, so opening it creates no `-shm`/`-wal` for us to litter the
  // folder with. An artefact from a KILLED run is still in WAL mode and will
  // produce sidecars here — accepted, because the alternative is a report tool
  // that can write to the evidence.
  //
  // Opening is inside the try: a file truncated by a killed run fails here, not
  // at the first query.
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const episode = db.query(`SELECT * FROM _episode`).get() as Record<string, unknown> | null;
    if (episode === null) return null;

    const checks = db
      .query<{ name: string; axis: Axis; ok: number }, []>(`SELECT name, axis, ok FROM _grade ORDER BY rowid`)
      .all();

    return {
      // An artefact written before `row` existed still groups correctly: the id
      // is `<row>-<n>` by construction, so the suffix comes off.
      row: String(episode['row'] ?? String(episode['id']).replace(/-\d+$/, '')),
      id: String(episode['id']),
      model: String(episode['model']),
      surface: String(episode['surface']),
      memory: String(episode['memory']),
      // Stored as JSON so an array of names round-trips; shown as a plain list.
      faults: unjson(episode['faults']),
      task: String(episode['task'] ?? ''),
      notes: String(episode['notes'] ?? ''),
      void: (episode['void'] as string | null) ?? null,
      harmed: (episode['harmed'] as number | null) ?? null,
      completed: (episode['completed'] as number | null) ?? null,
      checks,
    };
  } catch {
    // A half-written artefact from a killed run is not a reason to lose the rest.
    return null;
  } finally {
    db?.close();
  }
}

function unjson(value: unknown): string {
  if (typeof value !== 'string') return 'none';
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.join(',') : String(parsed);
  } catch {
    return value;
  }
}

/** The same arithmetic as `summarise`, over rows read back rather than held. */
function summarise(id: string, group: Artefact[], failed: number): RowSummary {
  const scored = group.filter((a) => a.void === null);
  // A row where EVERY repetition failed has no artefact to describe itself with.
  const first: Partial<Artefact> = group[0] ?? {};

  const axis = (pick: (a: Artefact) => number | null): Rate | null => {
    const measured = scored.filter((a) => pick(a) !== null);
    return measured.length === 0 ? null : wilson(measured.filter((a) => pick(a) === 1).length, measured.length);
  };

  const seen = new Map<string, { axis: Axis; passed: number; n: number }>();
  for (const artefact of scored) {
    for (const check of artefact.checks) {
      const entry = seen.get(check.name) ?? { axis: check.axis, passed: 0, n: 0 };
      entry.n += 1;
      if (check.ok === 1) entry.passed += 1;
      seen.set(check.name, entry);
    }
  }
  const perCheck: CheckRate[] = [...seen].map(([name, e]) => ({ name, axis: e.axis, ...wilson(e.passed, e.n) }));

  return {
    id,
    model: first.model ?? '',
    surface: first.surface ?? '',
    memory: first.memory ?? '',
    faults: first.faults ?? '',
    task: first.task ?? '',
    notes: first.notes ?? '',
    // Attempted, not merely recorded: a failure produced no artefact but was
    // still a repetition someone paid for and is owed an accounting of.
    total: group.length + failed,
    voided: group.length - scored.length,
    failed,
    n: scored.length,
    voids: group.filter((a) => a.void !== null).map((a) => a.void!),
    harm: axis((a) => a.harmed),
    completion: axis((a) => a.completed),
    perCheck,
  };
}

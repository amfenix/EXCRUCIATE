/**
 * The `experiments` sheet: which episodes a named experiment runs, and how often.
 *
 * The workbook's `repeat` column says how many times a row runs when the whole
 * sheet runs. That is the wrong unit once a research is a year old: by then the
 * sheet holds every episode ever written, and a question is asked of a HANDFUL
 * of them — "the two Direct Debit cases, ten times each, after the day-3 fix".
 *
 * So an experiment is a column. Its header is the name, its cells are run counts,
 * and a blank cell means the episode is not in it:
 *
 *     id                    smoke   dd-fix   ladder-a1
 *     fp01-sonnet5-short      1                    3
 *     dd01-sonnet5-short              10
 *
 * Naming the episodes in the sheet rather than on the command line is what makes
 * a run repeatable six months later, and what lets `combine` decide whether two
 * results may be added together — see `src/run/combine.ts`.
 */
import type { Problems } from './parse.ts';
import { integer, isBlank, text } from './parse.ts';
import type { EpisodeRow } from './types.ts';

/** Experiment name to the episodes it runs, each with its own count. */
export type Experiments = Map<string, Map<string, number>>;

/**
 * Names a folder, so it has to survive being one: no spaces, no separators, no
 * dots to be mistaken for an extension. Refused rather than sanitised, because
 * a sanitised name is one nobody can find again by searching for what they typed.
 */
const NAME = /^[a-z0-9][a-z0-9_-]*$/i;

export function parseExperiments(
  grid: Array<Array<string>>,
  rows: EpisodeRow[],
  p: Problems,
  where: string
): Experiments {
  const experiments: Experiments = new Map();
  if (grid.length === 0) return experiments;

  const header = grid[0] ?? [];
  if (text(header[0]).toLowerCase() !== 'id') {
    p.add(where, 'the first column must be headed "id" — the rest are experiment names');
    return experiments;
  }

  const names = columnsOf(header, p, where);
  for (const name of names.values()) experiments.set(name, new Map());

  const known = new Map(rows.map((r) => [r.id, r]));
  const seen = new Set<string>();

  for (let line = 1; line < grid.length; line++) {
    const row = grid[line] ?? [];
    if (row.every((c) => text(c) === '')) continue;
    readRow(row, `${where} row ${line + 1}`, names, known, seen, experiments, p);
  }

  for (const [name, episodes] of experiments) {
    if (episodes.size === 0) p.add(where, `experiment "${name}" has a column but no episodes`);
  }
  return experiments;
}

/** Column index to experiment name, refusing anything that cannot name a folder. */
function columnsOf(header: string[], p: Problems, where: string): Map<number, string> {
  const names = new Map<number, string>();
  for (let col = 1; col < header.length; col++) {
    const name = text(header[col]);
    if (name === '') continue;
    if (!NAME.test(name)) {
      p.add(where, `"${name}" cannot name an experiment — it names a folder, so use letters, digits, - and _`);
      continue;
    }
    if ([...names.values()].some((n) => n.toLowerCase() === name.toLowerCase())) {
      p.add(where, `experiment "${name}" appears twice`);
      continue;
    }
    names.set(col, name);
  }
  return names;
}

function readRow(
  row: string[],
  at: string,
  names: Map<number, string>,
  known: Map<string, EpisodeRow>,
  seen: Set<string>,
  experiments: Experiments,
  p: Problems
): void {
  const id = text(row[0]);
  if (id === '') {
    p.add(at, 'has counts but no episode id');
    return;
  }
  if (seen.has(id)) {
    p.add(at, `episode "${id}" appears twice — one row per episode, one column per experiment`);
    return;
  }
  seen.add(id);

  const episode = known.get(id);
  if (episode === undefined) {
    // The sheet is the record of what was asked; an id that names nothing means
    // an episode was renamed and an experiment now runs less than its author
    // believes it does.
    p.add(at, `"${id}" is not an episode in this workbook`);
    return;
  }

  for (const [col, name] of names) {
    const cell = text(row[col]);
    if (isBlank(cell)) continue;

    const count = integer(p, at, name, cell, 0);
    if (count <= 0) continue;
    if (!episode.enabled) {
      // Asked for and switched off is a contradiction, and the silent
      // resolution — running nothing — reads as an experiment with no result.
      p.add(at, `experiment "${name}" asks for "${id}" ${count}×, but the row is disabled`);
      continue;
    }
    experiments.get(name)!.set(id, count);
  }
}

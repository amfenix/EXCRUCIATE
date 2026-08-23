/**
 * The episodes sheet: one row, one episode.
 *
 * Every cell is read as TEXT, never as a typed value. A spreadsheet will happily
 * decide that `4.5` is a number, that `0` is a number, and that a date-looking
 * string is a date — and which of those it decides depends on the application
 * that last saved the file. Reading `cell.text` and parsing ourselves means the
 * workbook behaves the same whether it came from Excel, LibreOffice or a script.
 */
import ExcelJS from 'exceljs';
import { basename } from 'node:path';
import {
  bool,
  decimal,
  faults,
  integer,
  isBlank,
  oneOf,
  promptName,
  required,
  text,
  thinking,
  toolset,
} from './parse.ts';
import { KNOWN_COLUMNS, REQUIRED_COLUMNS, normalise } from './columns.ts';
import { parseExperiments } from './experiments.ts';
import type { Experiments } from './experiments.ts';
import type { Problems } from './parse.ts';
import type { EpisodeRow } from './types.ts';

/** Reads one column of one row, as text, blank when the column is absent. */
type Cell = (name: string) => string;

/** The sheet that holds the experiments, by name rather than by position. */
export const EXPERIMENTS_SHEET = 'experiments';

export interface Workbook {
  rows: EpisodeRow[];
  /** Empty when the workbook has no experiments sheet, which is the old shape. */
  experiments: Experiments;
}

export async function readWorkbook(path: string, p: Problems, label = basename(path)): Promise<Workbook> {
  const book = await openBook(path, p, label);
  if (book === null) return { rows: [], experiments: new Map() };

  const sheet = episodesSheet(book, p, label);
  if (sheet === null) return { rows: [], experiments: new Map() };

  const columns = headerOf(sheet, p, label);
  // A header we could not read makes every row meaningless.
  if (columns === null) return { rows: [], experiments: new Map() };

  // Zero rows is not a fault: a freshly scaffolded research has none until
  // `matrix` fills them. Having nothing to RUN is the runner's complaint.
  const rows = dataRows(sheet, columns, p, label);

  const second = book.worksheets.find((w) => normalise(w.name) === EXPERIMENTS_SHEET);
  const experiments =
    second === undefined
      ? new Map()
      : parseExperiments(gridOf(second), rows, p, `${label} ${EXPERIMENTS_SHEET}`);

  return { rows, experiments };
}

async function openBook(path: string, p: Problems, label: string): Promise<ExcelJS.Workbook | null> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(path);
  } catch (e) {
    p.add(label, `could not be read as a workbook: ${(e as Error).message}`);
    return null;
  }
  return workbook;
}

/**
 * The episodes sheet is the one named `episodes`, or failing that the first one
 * that is not the experiments sheet.
 *
 * Position alone was enough while there was only ever one sheet. It stopped
 * being enough the moment a second could exist: a workbook whose author dragged
 * the experiments tab to the front would have had every episode read out of it.
 */
export function episodesSheetOf(book: ExcelJS.Workbook): ExcelJS.Worksheet | undefined {
  const named = book.worksheets.find((w) => normalise(w.name) === 'episodes');
  return named ?? book.worksheets.find((w) => normalise(w.name) !== EXPERIMENTS_SHEET);
}

function episodesSheet(book: ExcelJS.Workbook, p: Problems, label: string): ExcelJS.Worksheet | null {
  const sheet = episodesSheetOf(book);
  if (!sheet) {
    p.add(label, book.worksheets.length === 0 ? 'has no sheets' : 'has no episodes sheet');
    return null;
  }
  return sheet;
}

/** A sheet as plain text, so the experiments parser never meets a cell object. */
function gridOf(sheet: ExcelJS.Worksheet): string[][] {
  const grid: string[][] = [];
  for (let line = 1; line <= sheet.rowCount; line++) {
    const row = sheet.getRow(line);
    const cells: string[] = [];
    for (let col = 1; col <= sheet.columnCount; col++) cells.push(text(row.getCell(col).text));
    grid.push(cells);
  }
  return grid;
}

/** Column name to index, or null when the header itself is unusable. */
function headerOf(sheet: ExcelJS.Worksheet, p: Problems, label: string): Map<string, number> | null {
  // Count OUR problems, not the shared list's: `p` may already carry complaints
  // from research.yaml, and consulting `p.ok` made the workbook silently skip
  // itself whenever the meta was also broken — so half the report went missing
  // exactly when the most was wrong.
  const before = p.list.length;
  const columns = new Map<string, number>();

  sheet.getRow(1).eachCell((cell, index) => {
    const name = normalise(String(cell.text ?? ''));
    if (name === '') return;
    if (columns.has(name)) p.add(`${label} header`, `column "${name}" appears twice`);
    if (!KNOWN_COLUMNS.has(name)) p.add(`${label} header`, `unknown column "${cell.text}"`);
    columns.set(name, index);
  });

  for (const name of REQUIRED_COLUMNS) {
    if (!columns.has(name)) p.add(`${label} header`, `missing required column "${name}"`);
  }
  return p.list.length > before ? null : columns;
}

function dataRows(
  sheet: ExcelJS.Worksheet,
  columns: Map<string, number>,
  p: Problems,
  label: string
): EpisodeRow[] {
  const rows: EpisodeRow[] = [];
  const seen = new Set<string>();

  for (let line = 2; line <= sheet.rowCount; line++) {
    const row = sheet.getRow(line);
    const cell: Cell = (name) => (columns.has(name) ? text(row.getCell(columns.get(name)!).text) : '');

    // A blank line is where someone stopped typing, not an episode.
    if (KNOWN_VALUES.every((name) => cell(name) === '')) continue;

    const where = `${label} row ${line}`;
    const id = required(p, where, 'id', cell('id'));
    if (id !== '' && seen.has(id)) p.add(where, `duplicate id "${id}" — ids name the artefact files`);
    seen.add(id);

    rows.push(rowOf(cell, p, where, line, id));
  }
  return rows;
}

/**
 * One row. Every optional column is SPREAD IN ONLY WHEN PRESENT — under
 * `exactOptionalPropertyTypes` a blank cell must leave the key off entirely
 * rather than set it to undefined, which is a different thing downstream.
 */
const rowOf = (cell: Cell, p: Problems, where: string, line: number, id: string): EpisodeRow => ({
  id,
  line,
  enabled: bool(p, where, 'enabled', cell('enabled'), true),
  task: required(p, where, 'task', cell('task')),
  ...(isBlank(cell('arm')) ? {} : { arm: text(cell('arm')) }),
  model: required(p, where, 'model', cell('model')),
  memory: oneOf(p, where, 'memory', cell('memory'), ['session', 'fresh'] as const, 'session'),
  ...(isBlank(cell('surface'))
    ? {}
    : { surface: oneOf(p, where, 'surface', cell('surface'), ['tools', 'api', 'search'] as const, 'tools') }),
  faults: faults(p, where, cell('faults')),
  ...(isBlank(cell('tools')) ? {} : { toolset: toolset(p, where, cell('tools'))! }),
  ...(isBlank(cell('prompt')) ? {} : { prompt: promptName(p, where, cell('prompt'))! }),
  repeat: integer(p, where, 'repeat', cell('repeat'), 1),
  ...(isBlank(cell('temperature')) ? {} : { temperature: decimal(p, where, 'temperature', cell('temperature'))! }),
  ...(isBlank(cell('thinking')) ? {} : { thinking: thinking(p, where, cell('thinking'))! }),
  ...(isBlank(cell('resettools')) ? {} : { resetTools: bool(p, where, 'resetTools', cell('resettools'), false) }),
  ...(isBlank(cell('paralleltoolcalls'))
    ? {}
    : { parallelToolCalls: bool(p, where, 'parallelToolCalls', cell('paralleltoolcalls'), true) }),
  ...(isBlank(cell('fixture')) ? {} : { fixture: cell('fixture') }),
  ...(isBlank(cell('notes')) ? {} : { notes: cell('notes') }),
});

const KNOWN_VALUES = [...KNOWN_COLUMNS];

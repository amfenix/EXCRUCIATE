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
import { bool, decimal, faults, integer, isBlank, oneOf, required, text, thinking } from './parse.ts';
import { KNOWN_COLUMNS, REQUIRED_COLUMNS, normalise } from './columns.ts';
import type { Problems } from './parse.ts';
import type { EpisodeRow } from './types.ts';

/** Reads one column of one row, as text, blank when the column is absent. */
type Cell = (name: string) => string;

export async function readWorkbook(path: string, p: Problems, label = basename(path)): Promise<EpisodeRow[]> {
  const sheet = await openSheet(path, p, label);
  if (sheet === null) return [];

  const columns = headerOf(sheet, p, label);
  // A header we could not read makes every row meaningless.
  if (columns === null) return [];

  // Zero rows is not a fault: a freshly scaffolded research has none until
  // `matrix` fills them. Having nothing to RUN is the runner's complaint.
  return dataRows(sheet, columns, p, label);
}

async function openSheet(path: string, p: Problems, label: string): Promise<ExcelJS.Worksheet | null> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(path);
  } catch (e) {
    p.add(label, `could not be read as a workbook: ${(e as Error).message}`);
    return null;
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) {
    p.add(label, 'has no sheets');
    return null;
  }
  return sheet;
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
  model: required(p, where, 'model', cell('model')),
  memory: oneOf(p, where, 'memory', cell('memory'), ['session', 'fresh'] as const, 'session'),
  ...(isBlank(cell('surface'))
    ? {}
    : { surface: oneOf(p, where, 'surface', cell('surface'), ['tools', 'api', 'search'] as const, 'tools') }),
  faults: faults(p, where, cell('faults')),
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

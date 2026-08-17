/**
 * `results.xlsx` — one line per WORKBOOK ROW, plus a TOTAL.
 *
 * A row here is a row there: the cumulative result of its N repetitions. The
 * per-run detail lives in `episodes/<row>-<n>.sqlite`, where the world, journal,
 * audit, transcript and grade sit together and any SQLite tool can ask about
 * them. Duplicating that here would only give it a second place to be wrong.
 *
 * Every repetition is accounted for, and the three ways one ends are kept apart:
 *
 *   scored  we ran it and judged it            -> the denominator of every rate
 *   void    we ran it and could not judge it   -> our fault, excluded
 *   failed  it never ran to completion at all  -> harness or provider, excluded
 *
 * Pooling any of those together is how a run that mostly broke reads as a run
 * that mostly passed.
 */
import ExcelJS from 'exceljs';
import { wilson } from './wilson.ts';
import type { Rate } from './wilson.ts';
import type { RowSummary } from './repeat.ts';

const SUMMARY = [
  'id',
  'task',
  'model',
  'surface',
  'memory',
  'faults',
  'runs',
  'scored',
  'voided',
  'failed',
  'harm',
  'harm_lo',
  'harm_hi',
  'completion',
  'completion_lo',
  'completion_hi',
  'notes',
];

const CHECKS = ['id', 'check', 'axis', 'passed', 'n', 'rate', 'lo', 'hi'];

const cells = (rate: Rate | null): Array<number | string> =>
  rate === null ? ['not measured', '', ''] : [round(rate.rate), round(rate.lo), round(rate.hi)];

const round = (n: number): number => Math.round(n * 1000) / 1000;

export interface Failure {
  id: string;
  error: string;
}

export async function writeReport(path: string, rows: RowSummary[], failed: Failure[]): Promise<void> {
  const wb = new ExcelJS.Workbook();
  summarySheet(wb, rows);
  checksSheet(wb, rows);

  // A run that half failed must not read as a run that half succeeded.
  if (failed.length > 0) {
    const sheet = wb.addWorksheet('failed');
    sheet.addRow(['episode', 'error']);
    for (const f of failed) sheet.addRow([f.id, f.error]);
    bold(sheet);
  }

  const voids = rows.flatMap((row) => row.voids.map((reason) => [row.id, reason]));
  if (voids.length > 0) {
    const sheet = wb.addWorksheet('voids');
    sheet.addRow(['id', 'why it could not be scored']);
    for (const v of voids) sheet.addRow(v);
    bold(sheet);
  }

  await wb.xlsx.writeFile(path);
}

function summarySheet(wb: ExcelJS.Workbook, rows: RowSummary[]): void {
  const sheet = wb.addWorksheet('summary');
  sheet.addRow(SUMMARY);

  for (const row of rows) {
    sheet.addRow([
      row.id,
      row.task,
      row.model,
      row.surface,
      row.memory,
      row.faults,
      row.total,
      row.n,
      row.voided,
      row.failed,
      ...cells(row.harm),
      ...cells(row.completion),
      row.notes,
    ]);
  }

  if (rows.length > 0) sheet.addRow(totalRow(rows));
  bold(sheet);
  if (rows.length > 0) sheet.getRow(rows.length + 2).font = { bold: true };
  sheet.getColumn(1).width = 34;
  sheet.getColumn(3).width = 28;
  sheet.getColumn(SUMMARY.length).width = 50;
}

/**
 * The last line: every repetition, and both axes POOLED over the rows.
 *
 * Pooled from the underlying counts rather than averaged over rates — averaging
 * a rate from 5 runs with one from 500 would weigh them equally and is simply
 * the wrong number. It is still a mixture of different conditions, which is why
 * it is labelled TOTAL and not reported as a finding.
 */
function totalRow(rows: RowSummary[]): Array<string | number> {
  const sum = (pick: (r: RowSummary) => number): number => rows.reduce((n, r) => n + pick(r), 0);
  const pooled = (pick: (r: RowSummary) => Rate | null): Rate | null => {
    const measured = rows.map(pick).filter((r): r is Rate => r !== null);
    if (measured.length === 0) return null;
    return wilson(
      measured.reduce((n, r) => n + r.count, 0),
      measured.reduce((n, r) => n + r.n, 0)
    );
  };

  return [
    'TOTAL',
    `${rows.length} row${rows.length === 1 ? '' : 's'}`,
    '',
    '',
    '',
    '',
    sum((r) => r.total),
    sum((r) => r.n),
    sum((r) => r.voided),
    sum((r) => r.failed),
    ...cells(pooled((r) => r.harm)),
    ...cells(pooled((r) => r.completion)),
    'pooled across rows — read the per-row lines for a finding',
  ];
}

/** Which check fails is nearly always more use than the rollup that hides it. */
function checksSheet(wb: ExcelJS.Workbook, rows: RowSummary[]): void {
  const sheet = wb.addWorksheet('checks');
  sheet.addRow(CHECKS);
  for (const row of rows) {
    for (const check of row.perCheck) {
      sheet.addRow([
        row.id,
        check.name,
        check.axis,
        check.count,
        check.n,
        round(check.rate),
        round(check.lo),
        round(check.hi),
      ]);
    }
  }
  bold(sheet);
  sheet.getColumn(1).width = 34;
  sheet.getColumn(2).width = 30;
}

const bold = (sheet: ExcelJS.Worksheet): void => {
  sheet.getRow(1).font = { bold: true };
};

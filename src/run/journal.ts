/**
 * `results/experiments.xlsx` — one row per run, appended as runs happen.
 *
 * A results folder accumulates timestamped directories, and after a dozen of
 * them nobody can say what any one of them was FOR. The journal is the index:
 * what was asked, when, against which world, what it cost, and what came back.
 *
 * It is a record, not a cache. Every number in it can be recomputed from the
 * artefacts, and `readRun` remains the source of truth for anything that
 * matters. What cannot be recomputed is the intent — the experiment name, the
 * note someone wrote afterwards — and that is what this file is really holding.
 */
import ExcelJS from 'exceljs';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { RowSummary } from './repeat.ts';

export interface JournalEntry {
  /** The run folder's name, and the key everything else joins on. */
  run: string;
  /** Blank when the whole sheet ran rather than a named experiment. */
  experiment: string;
  started: string;
  seconds: number;
  /** Planned, then what actually happened to each. */
  episodes: number;
  ran: number;
  skipped: number;
  failed: number;
  voided: number;
  /** Episodes, not rows: the two axes as counts over the whole run. */
  harmed: number;
  completed: number;
  scored: number;
  usd: number | null;
  /**
   * What the write-up cost, kept apart from what the experiment cost.
   *
   * They answer different questions, and a single total lets an expensive
   * analysis hide inside a cheap run — or make a cheap one look unaffordable
   * to repeat.
   */
  reportUsd: number | null;
  manifest: string;
  schema: string;
  /** Suffixed `*` when the tree was dirty — the commit is then only a hint. */
  commit: string;
  /** `ok`, `stopped`, or `failed`. */
  status: string;
  /** `kept` or `deleted`. A soft delete never removes the row. */
  state: string;
  /**
   * A person's judgement of the result: blank, `keep` or `junk`.
   *
   * Separate from `status`, which is how the RUN ended, and from `state`, which
   * is whether the folder is still there. A run can finish perfectly and still
   * be junk — the task was wrong, the prompt had a typo — and that is exactly
   * the case where the number is most dangerous to leave lying around unlabelled.
   */
  verdict: string;
  note: string;
}

const SHEET = 'runs';

const COLUMNS: Array<{ key: keyof JournalEntry; header: string; width: number }> = [
  { key: 'run', header: 'run', width: 34 },
  { key: 'experiment', header: 'experiment', width: 18 },
  { key: 'started', header: 'started', width: 21 },
  { key: 'seconds', header: 'seconds', width: 9 },
  { key: 'episodes', header: 'episodes', width: 9 },
  { key: 'ran', header: 'ran', width: 7 },
  { key: 'skipped', header: 'skipped', width: 8 },
  { key: 'failed', header: 'failed', width: 8 },
  { key: 'voided', header: 'voided', width: 8 },
  { key: 'scored', header: 'scored', width: 8 },
  { key: 'harmed', header: 'harmed', width: 8 },
  { key: 'completed', header: 'completed', width: 10 },
  { key: 'usd', header: 'usd', width: 9 },
  { key: 'reportUsd', header: 'report usd', width: 11 },
  { key: 'manifest', header: 'manifest', width: 14 },
  { key: 'schema', header: 'schema', width: 14 },
  { key: 'commit', header: 'commit', width: 12 },
  { key: 'status', header: 'status', width: 9 },
  { key: 'state', header: 'state', width: 9 },
  { key: 'verdict', header: 'verdict', width: 9 },
  { key: 'note', header: 'note', width: 46 },
];

export const journalPath = (out: string): string => resolve(out, 'experiments.xlsx');

/**
 * Counts over EPISODES, from the row summaries.
 *
 * Rows are the unit everywhere else, because a rate belongs to a row. Here the
 * unit is the episode, because the question the journal answers is "how big was
 * this run and how much of it landed", and a row of ten is not one of anything.
 */
export function tally(rows: RowSummary[]): Pick<JournalEntry, 'harmed' | 'completed' | 'scored' | 'voided'> {
  let harmed = 0;
  let completed = 0;
  let scored = 0;
  let voided = 0;
  for (const row of rows) {
    voided += row.voided;
    scored += row.n;
    harmed += row.harm?.count ?? 0;
    completed += row.completion?.count ?? 0;
  }
  return { harmed, completed, scored, voided };
}

export async function readJournal(out: string): Promise<JournalEntry[]> {
  const path = journalPath(out);
  if (!existsSync(path)) return [];

  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(path);
  const sheet = book.getWorksheet(SHEET) ?? book.worksheets[0];
  if (sheet === undefined) return [];

  // By HEADER, not by position: a column added later must not shift what an
  // older file's cells mean.
  const at = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, index) => at.set(String(cell.text ?? '').trim().toLowerCase(), index));

  const entries: JournalEntry[] = [];
  for (let line = 2; line <= sheet.rowCount; line++) {
    const row = sheet.getRow(line);
    const cell = (name: string): string =>
      at.has(name) ? String(row.getCell(at.get(name)!).text ?? '').trim() : '';
    if (cell('run') === '') continue;

    const number = (name: string): number => {
      const n = Number(cell(name));
      return Number.isFinite(n) ? n : 0;
    };
    entries.push({
      run: cell('run'),
      experiment: cell('experiment'),
      started: cell('started'),
      seconds: number('seconds'),
      episodes: number('episodes'),
      ran: number('ran'),
      skipped: number('skipped'),
      failed: number('failed'),
      voided: number('voided'),
      scored: number('scored'),
      harmed: number('harmed'),
      completed: number('completed'),
      usd: cell('usd') === '' ? null : number('usd'),
      reportUsd: cell('report usd') === '' ? null : number('report usd'),
      manifest: cell('manifest'),
      schema: cell('schema'),
      commit: cell('commit'),
      status: cell('status') === '' ? 'ok' : cell('status'),
      state: cell('state') === '' ? 'kept' : cell('state'),
      verdict: cell('verdict'),
      note: cell('note'),
    });
  }
  return entries;
}

/**
 * Add a run, or replace the row a re-run of the same folder already has.
 *
 * Replacing matters for `--resume`: it writes into the folder it is finishing,
 * and two journal rows for one directory would make every later count double.
 * The note, state and verdict of the earlier row are kept — they are a person's
 * judgement, and a resume is not new information about any of them.
 */
export async function record(out: string, entry: JournalEntry): Promise<void> {
  const entries = await readJournal(out);
  const existing = entries.findIndex((e) => e.run === entry.run);
  if (existing >= 0) {
    const was = entries[existing]!;
    entries[existing] = { ...entry, note: was.note, state: was.state, verdict: was.verdict };
  } else {
    entries.push(entry);
  }
  await writeJournal(out, entries);
}

export async function writeJournal(out: string, entries: JournalEntry[]): Promise<void> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(SHEET);
  sheet.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  for (const entry of entries) sheet.addRow(entry);
  await book.xlsx.writeFile(journalPath(out));
}

/** The folder name, however the caller happens to be holding the path. */
export const runName = (dir: string): string => basename(dir);

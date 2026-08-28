/**
 * What to run next, and how many times — computed from the run you already have.
 *
 * A screening pass measures every line at one repetition per model. That is
 * enough to separate a near-total effect from none and nothing finer, and the
 * question it leaves is which lines are worth paying to sharpen.
 *
 * THE ANSWER IS NOT THE SAME FOR EVERY LINE, and it is not "all of them".
 *
 *   · A line that came back 0 of 8 or 8 of 8 sits at the edge, where a
 *     proportion has almost no variance. Repetitions there buy precision on a
 *     number that is already as certain as this design can make it. What limits
 *     such a line is not its own spread but the RULE OF THREE: with no events in
 *     n episodes the true rate can still be as high as about 3/n, so its n sets
 *     the floor on the smallest effect anyone may claim against it.
 *
 *   · A line that came back near the middle — 4 of 8 — is where the variance
 *     lives, and where repetitions actually narrow something. The number needed
 *     for a half-width w is n ≈ 3.84·p(1−p)/w².
 *
 * So the control and the condition of the same case usually want DIFFERENT
 * counts, and the workbook already says so: an experiment is a column of
 * per-episode counts, not one number for the sheet. This writes that column.
 *
 *   bun plan.ts <run-dir> [--resolution 0.1] [--write <experiment>]
 *               [--condition N] [--control M] [--min 1]
 *
 * `--condition` / `--control` set flat counts and skip the arithmetic, for when
 * the decision has already been made and only the column is wanted.
 */
import ExcelJS from 'exceljs';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Dataset, PooledRow, Rate } from './extract.ts';

const RUN = resolve(process.argv[2] ?? '.');
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const num = (name: string, fallback: number): number => {
  const v = arg(name);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** The half-width we want on a rate that is not at an edge. */
const RESOLUTION = num('resolution', 0.1);
/** Never fewer than this many per model: one model's behaviour is not eight. */
const MIN_PER_MODEL = num('min', 1);
const FLAT_CONDITION = arg('condition') === undefined ? null : num('condition', 1);
const FLAT_CONTROL = arg('control') === undefined ? null : num('control', 1);
const WRITE = arg('write');

const data = JSON.parse(readFileSync(resolve(RUN, 'data.json'), 'utf8')) as Dataset;
if (data.pooledRows === undefined) {
  console.error('error: this data.json has no `pooledRows`. Re-run extract.ts.');
  process.exit(1);
}

// ------------------------------------------------------------ which is which

interface ClaimArm {
  task: string;
  arm: string;
  baseline: boolean;
  claim?: { id: string };
}
const claimsPath = resolve(RUN, 'inputs', 'claims.json');
const declared = new Map<string, ClaimArm>();
if (existsSync(claimsPath)) {
  for (const a of JSON.parse(readFileSync(claimsPath, 'utf8')).arms as ClaimArm[]) {
    declared.set(`${a.task}#${a.arm}`, a);
  }
}

const hasFault = (l: PooledRow): boolean => l.faults !== 'none' && l.faults !== '"none"';
const faultedArms = new Set(data.pooledRows.filter(hasFault).map((l) => `${l.task}#${l.arm}`));
const isControl = (l: PooledRow): boolean => {
  if (hasFault(l)) return false;
  if (faultedArms.has(`${l.task}#${l.arm}`)) return true;
  return declared.get(`${l.task}#${l.arm}`)?.claim === undefined;
};

// ---------------------------------------------------------------- the sizing

/**
 * Episodes needed for a rate observed at `p`.
 *
 * At an edge the binomial half-width is zero and the formula would say one
 * episode, which is nonsense: what an all-or-nothing line actually needs is
 * enough episodes that the rule of three puts its ceiling below the effect
 * anybody wants to claim against it. Those are two different questions and the
 * two branches here are them.
 */
function needed(p: number, w: number): { n: number; why: string } {
  const edge = p <= 0.0001 || p >= 0.9999;
  if (edge) return { n: Math.ceil(3 / w), why: `at the edge — 3/w so its ceiling clears ${(w * 100).toFixed(0)}%` };
  return { n: Math.ceil((3.8415 * p * (1 - p)) / (w * w)), why: `p=${p.toFixed(2)} — 3.84·p(1−p)/w²` };
}

const perModel = (n: number, models: number): number =>
  Math.max(MIN_PER_MODEL, Math.ceil(n / Math.max(models, 1)));

interface Row {
  line: PooledRow;
  control: boolean;
  models: number;
  reps: number;
  why: string;
}

const worst = (a: Rate, b: Rate): Rate => {
  // The axis that needs the most is the one that decides the line: a control
  // whose harm is flat at zero but whose completion sits at 0.375 is not a
  // cheap line, and reading only the harm axis is how it looks like one.
  const distance = (r: Rate): number => 0.5 - Math.abs(r.rate - 0.5);
  return distance(a) >= distance(b) ? a : b;
};

const rows: Row[] = data.pooledRows.map((line) => {
  const control = isControl(line);
  const models = new Set(line.models.map((m) => m.model)).size;
  const flat = control ? FLAT_CONTROL : FLAT_CONDITION;
  if (flat !== null) {
    return { line, control, models, reps: flat, why: 'set by hand' };
  }
  const axis = worst(line.harm, line.completion);
  const { n, why } = needed(axis.rate, RESOLUTION);
  return { line, control, models, reps: perModel(n, models), why };
});

// ------------------------------------------------------------------- report

const name = (l: PooledRow): string =>
  `${l.task.replace(/\.yaml$/, '')}${l.arm === '' ? '' : ` · ${l.arm}`}${hasFault(l) ? ' · fault' : ''}`;

const pad = (s: string, n: number): string => s.padEnd(n);
console.log(
  FLAT_CONDITION === null
    ? `plan at ±${(RESOLUTION * 100).toFixed(0)}% — ${data.pooledRows.length} lines\n`
    : `plan: condition ×${FLAT_CONDITION}, control ×${FLAT_CONTROL ?? 1} per model — ${data.pooledRows.length} lines\n`
);
console.log(`${pad('line', 34)} ${pad('role', 10)} ${pad('harm', 9)} ${pad('done', 9)} reps  why`);
for (const r of [...rows].sort((a, b) => b.reps - a.reps || name(a.line).localeCompare(name(b.line)))) {
  const h = `${r.line.harm.count}/${r.line.harm.n}`;
  const d = `${r.line.completion.count}/${r.line.completion.n}`;
  console.log(
    `${pad(name(r.line), 34)} ${pad(r.control ? 'control' : 'condition', 10)} ${pad(h, 9)} ${pad(d, 9)} ${String(r.reps).padStart(4)}  ${r.why}`
  );
}

const episodes = rows.reduce((n, r) => n + r.reps * r.models, 0);
console.log(`\n${episodes} episodes if this is run as it stands.`);

// -------------------------------------------------------------- the column

if (WRITE === undefined) {
  console.log('Pass --write <experiment> to put these counts in the workbook.');
  process.exit(0);
}

const book = resolve(RUN, '..', '..', 'episodes.xlsx');
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(book);
const sheet = wb.getWorksheet('experiments');
if (sheet === undefined) {
  console.error(`error: ${book} has no \`experiments\` sheet`);
  process.exit(1);
}

const repsOf = new Map<string, number>();
for (const r of rows) {
  for (const m of r.line.models) {
    repsOf.set(`${r.line.task}#${r.line.arm}#${r.line.faults}#${m.model}`, r.reps);
  }
}
const rowReps = new Map<string, number>();
for (const row of data.rows) {
  const faults = row.faults === '' ? 'none' : row.faults;
  const n = repsOf.get(`${row.task}#${row.arm}#${faults}#${row.model}`);
  if (n !== undefined) rowReps.set(row.id, n);
}

const header = sheet.getRow(1);
const heads = (header.values as unknown[]).map((v) => String(v ?? '').trim());
let col = heads.indexOf(WRITE);
if (col < 0) {
  col = sheet.columnCount + 1;
  header.getCell(col).value = WRITE;
  header.getCell(col).font = { bold: true };
}

let written = 0;
sheet.eachRow((row, i) => {
  if (i === 1) return;
  const id = String(row.getCell(1).value ?? '');
  const n = rowReps.get(id);
  if (n !== undefined) {
    row.getCell(col).value = n;
    written += 1;
  }
});

await wb.xlsx.writeFile(book);
console.log(`\nexperiment "${WRITE}": ${written} rows written to ${book}`);

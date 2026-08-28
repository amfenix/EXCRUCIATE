/**
 * The research in the words a payments person uses.
 *
 * `overview.ts` is the engineering view — task files, arm names, catalogue ids,
 * row counts. This is the same corpus with all of that taken out, because none
 * of it is a fact about payments:
 *
 *   · a claim id like `H-FP05-AVAILABLE` is our handle for joining a claim to
 *     its numbers, and a reader never needs it
 *   · a case id like `TC-FP-05` is a filename, uppercased
 *   · a catalogue number points into the failure-hypothesis matrix, which is a
 *     working document
 *   · an arm name like `payroll` is the value of an axis; the readable form is
 *     the sentence saying what that value changes
 *
 * What is left is: the rail, the job, what could go wrong, the one thing that
 * differs on this line, what it is meant to prove, and what happened.
 *
 * THE WORDS, since they were slippery until they were pinned down:
 *
 *   TASK       the file — the world, the steps, the graders. One block here.
 *   SCENARIO   one condition of a task: a line under it. What makes it its own
 *              scenario is said in words, because it is usually a fact about the
 *              world — a balance, a clock, a consent state — and only rarely an
 *              injected failure. 489 of 517 rows inject nothing at all.
 *   EPISODE    one scenario, run once, by one model.
 *   RUNS       how many episodes stand behind a line.
 *
 *   bun summary.ts <research-dir> [--out summary.xlsx] [--drop "Method, Method"]
 */
import ExcelJS from 'exceljs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const prose = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();
const yaml = (s: string): unknown => (Bun as unknown as { YAML: { parse(t: string): unknown } }).YAML.parse(s);

interface Arm {
  name: string;
  baseline: boolean;
  different: string;
  claim?: { kind: string; text: string; refutes: string };
}
interface Scenario { file: string; title: string; arms: Arm[] }

function axisSource(source: string): string | null {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => /^axis:/.test(l));
  if (start < 0) return null;
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const bare = line.trim() !== '' && !/^\s*#/.test(line);
    if (bare && line.length - line.trimStart().length === 0) break;
    out.push(line);
  }
  return ['axis:', ...out].join('\n');
}

function armsOf(src: string): Arm[] {
  const block = axisSource(src);
  const take = (c: Record<string, unknown> | undefined) =>
    c === undefined ? undefined : { kind: String(c['kind'] ?? ''), text: prose(c['text']), refutes: prose(c['refutes']) };
  if (block === null) {
    const doc = yaml(src) as Record<string, unknown> | null;
    return [{ name: '', baseline: true, different: '', ...(take(doc?.['claim'] as never) ? { claim: take(doc?.['claim'] as never)! } : {}) }];
  }
  const doc = yaml(block) as { axis?: Record<string, Record<string, Record<string, unknown>>> };
  const out: Arm[] = [];
  for (const values of Object.values(doc.axis ?? {})) {
    for (const [name, body] of Object.entries(values)) {
      const claim = take(body['claim'] as never);
      out.push({
        name,
        baseline: body['baseline'] === true,
        different: prose(body['different']),
        ...(claim ? { claim } : {}),
      });
    }
  }
  return out;
}

function readScenarios(dir: string): Scenario[] {
  const tasks = resolve(dir, 'tasks');
  return readdirSync(tasks)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((file) => {
      const src = readFileSync(resolve(tasks, file), 'utf8');
      return {
        file,
        // The line after the case id in `name:` is how a person says what the
        // scenario is, and for a single-arm case it is its only description.
        title: prose((/^name:[ \t]+(.*)$/m.exec(src)?.[1] ?? '').replace(/^\s*[A-Z][A-Z0-9-]*\s*[—-]\s*/, '')),
        arms: armsOf(src),
      };
    });
}

interface CaseInfo { method: string; job: string; harm: string }
async function readCases(dir: string): Promise<Map<string, CaseInfo>> {
  const out = new Map<string, CaseInfo>();
  const path = resolve(dir, 'cases.xlsx');
  if (!existsSync(path)) return out;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.getWorksheet('cases');
  if (ws === undefined) return out;
  const head: string[] = [];
  ws.getRow(1).eachCell((c, i) => (head[i - 1] = String(c.value ?? '').trim()));
  const at = (n: string) => head.indexOf(n) + 1;
  ws.eachRow((r, i) => {
    if (i === 1) return;
    const cell = (n: string) => (at(n) === 0 ? '' : prose(r.getCell(at(n)).value));
    out.set(String(r.getCell(1).value ?? '').trim(), {
      method: cell('method'),
      job: cell('business task given to the agent'),
      harm: cell('harm predicate'),
    });
  });
  return out;
}

interface Where { task: string; arm: string; fault: string }
async function readRows(dir: string): Promise<Map<string, Where>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(resolve(dir, 'episodes.xlsx'));
  const ws = wb.getWorksheet('episodes');
  const out = new Map<string, Where>();
  if (ws === undefined) return out;
  const head: string[] = [];
  ws.getRow(1).eachCell((c, i) => (head[i - 1] = String(c.value ?? '').trim()));
  const at = (n: string) => head.indexOf(n) + 1;
  ws.eachRow((r, i) => {
    if (i === 1) return;
    const id = String(r.getCell(1).value ?? '').trim();
    if (id === '') return;
    out.set(id, {
      task: String(r.getCell(at('task')).value ?? '').trim(),
      arm: at('arm') === 0 ? '' : String(r.getCell(at('arm')).value ?? '').trim(),
      // A clean run and a fault-injected one are two scenarios, not one. Keying
      // without this pooled TC-FP-01's control INTO its own test condition and
      // reported the blend as a rate.
      fault: String(r.getCell(at('faults')).value ?? 'none').trim() || 'none',
    });
  });
  return out;
}

interface Tally { eps: number; harm: number; harmN: number; done: number; doneN: number }
interface Measured { id: string; n?: number; harm?: { count: number; n: number } | null; completion?: { count: number; n: number } | null }

/** Row ids that were renamed, so their history follows them to the new address. */
function aliasing(results: string): (id: string) => string {
  const path = resolve(results, 'renamed-rows.json');
  const renamed: Record<string, string> = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>)
    : {};
  return (id: string) => {
    const direct = renamed[id];
    if (direct !== undefined) return direct;
    const p = id.replace(/^ddo04-([a-z0-9]+)-cancel$/, 'ddo05-$1').replace(/^ddo01-([a-z0-9]+)$/, 'ddo01-$1-late');
    return renamed[p] ?? p;
  };
}

/**
 * Every run, folded onto the arm each row belongs to today.
 *
 * Newest wins where a row was measured more than once: a scenario fixed after an
 * earlier run should read as fixed, and adding the two would count one sample
 * twice.
 */
function readRuns(dir: string, rows: Map<string, Where>): Map<string, Tally> {
  const results = resolve(dir, 'results');
  const seen = new Map<string, Tally>();
  if (!existsSync(results)) return seen;
  const alias = aliasing(results);

  const latest = new Map<string, Measured>();
  for (const d of readdirSync(results).sort()) {
    const f = resolve(results, d, 'data.json');
    if (!existsSync(f)) continue;
    const j = JSON.parse(readFileSync(f, 'utf8')) as { rows?: Measured[] };
    for (const r of j.rows ?? []) latest.set(alias(String(r.id)), r);
  }

  for (const [id, r] of latest) {
    const where = rows.get(id);
    if (where !== undefined) add(seen, `${where.task}#${where.arm}#${where.fault}`, r);
  }
  return seen;
}

/** One row's measurement, added to its arm's running total. */
function add(seen: Map<string, Tally>, key: string, r: Measured): void {
  const t = seen.get(key) ?? { eps: 0, harm: 0, harmN: 0, done: 0, doneN: 0 };
  t.eps += Number(r.n) || 0;
  if (r.harm != null) {
    t.harm += r.harm.count;
    t.harmN += r.harm.n;
  }
  if (r.completion != null) {
    t.done += r.completion.count;
    t.doneN += r.completion.n;
  }
  seen.set(key, t);
}

/** The injected failures an arm was actually run with, in a stable order. */
function faultsOf(rows: Map<string, Where>, task: string, arm: string): string[] {
  const found = new Set<string>();
  for (const w of rows.values()) if (w.task === task && w.arm === arm) found.add(w.fault);
  return found.size === 0 ? ['none'] : [...found].sort();
}

// ---------------------------------------------------------------- writing

const INK = '1F2933';
const QUIET = '7B8794';
const BAND = 'E4E7EB';
const RULE = 'CBD2D9';
const ALARM = 'A61B1B';
const GOOD = '35635A';

const fill = (argb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb } });
const rate = (c: number, n: number): number | string => (n === 0 ? '–' : c / n);

/**
 * Two kinds of row share this sheet, and no column serves both.
 *
 * A TASK row carries what is true of every line under it — the job, what counts
 * as harm. A SCENARIO row carries what makes that line its own: the failure
 * injected into it, what is different about its world, what it should prove.
 * Sharing a column between the two is how a header stops being true.
 */
const COLUMNS: Array<[string, number]> = [
  ['Payment rail', 22],
  ['Task ID', 13],
  ['Category', 40],
  ['Scenario', 24],
  ['What is different on this line', 52],
  ['What we expect to go wrong', 62],
  ['What would prove us wrong', 50],
  ['What the operator asks for', 50],
  ['What counts as harm', 42],
  ['Runs', 7],
  ['Harmed', 9],
  ['Job done', 10],
];
/** Filled on a task row, empty on the lines beneath it. */
const TASK_ONLY: [id: number, category: number, job: number, harm: number] = [2, 3, 8, 9];
/** Filled on a scenario row. */
const LINE_PROSE: [first: number, last: number] = [4, 7];
/** The condition, and the injected failure where there is one. */
const scenarioOf = (arm: string, fault: string): string => {
  const condition = arm === '' ? '' : arm;
  if (fault === 'none') return condition === '' ? '—' : condition;
  return condition === '' ? fault : `${condition} · ${fault}`;
};
const NUMERIC: [runs: number, harm: number, done: number] = [10, 11, 12];

/** Loud when it is bad. Harm rising is bad; the job NOT being done is bad. */
function paintRate(cell: ExcelJS.Cell, kind: 'harm' | 'done'): void {
  cell.alignment = { horizontal: 'right', vertical: 'top' };
  cell.numFmt = '0%';
  const v = cell.value;
  if (typeof v !== 'number') {
    cell.font = { size: 10, color: { argb: QUIET } };
    return;
  }
  const bad = kind === 'harm' ? v >= 0.5 : v <= 0.34;
  const fine = kind === 'harm' ? v === 0 : v === 1;
  cell.font = { size: 10, bold: bad, color: { argb: bad ? ALARM : fine ? GOOD : INK } };
}

const caseOf = (f: string) => f.replace(/\.yaml$/, '').toUpperCase();

function heading(ws: ExcelJS.Worksheet, dir: string): void {
  const title = ws.addRow([`${basename(resolve(dir))} — what we put in front of an agent, and what happened`]);
  title.font = { bold: true, size: 14, color: { argb: INK } };
  title.height = 22;
  const note = ws.addRow([
    'One block per task, one line per condition of it, each run against eleven models. The line marked as the control is the same job with the one thing put right; the others are measured against it. Collapse the outline to browse by rail.',
  ]);
  note.font = { size: 9, color: { argb: QUIET } };
  ws.addRow([]);

  const header = ws.addRow(COLUMNS.map(([name]) => name));
  header.font = { bold: true, size: 10, color: { argb: INK } };
  header.eachCell((c) => {
    c.border = { bottom: { style: 'medium', color: { argb: INK } } };
    c.alignment = { vertical: 'bottom', wrapText: true };
  });
  for (const i of NUMERIC) header.getCell(i).alignment = { horizontal: 'right', vertical: 'bottom', wrapText: true };
  ws.views = [{ state: 'frozen', xSplit: 3, ySplit: header.number }];
}

/** What this line is meant to prove — or that it is the thing others prove against. */
function proving(arm: Arm): string {
  if (arm.claim !== undefined) return arm.claim.text;
  return arm.baseline ? 'Nothing. This is the control the others are measured against.' : '';
}

/** The block header: everything true of every line beneath it. */
function taskRow(ws: ExcelJS.Worksheet, caseId: string, title: string, info: CaseInfo | undefined): void {
  const r = ws.addRow([]);
  r.getCell(TASK_ONLY[0]).value = caseId;
  r.getCell(TASK_ONLY[1]).value = title;
  r.getCell(TASK_ONLY[2]).value = info?.job ?? '';
  r.getCell(TASK_ONLY[3]).value = info?.harm ?? '';
  r.outlineLevel = 1;
  r.font = { size: 10, color: { argb: INK } };
  r.getCell(TASK_ONLY[0]).font = { size: 10, bold: true, color: { argb: INK } };
  r.getCell(TASK_ONLY[1]).font = { size: 11, bold: true, color: { argb: INK } };
  r.getCell(TASK_ONLY[1]).alignment = { wrapText: true, vertical: 'top' };
  for (const i of [TASK_ONLY[2], TASK_ONLY[3]]) {
    r.getCell(i).font = { size: 9, color: { argb: QUIET } };
    r.getCell(i).alignment = { wrapText: true, vertical: 'top' };
  }
  r.eachCell({ includeEmpty: true }, (c) => {
    c.border = { top: { style: 'thin', color: { argb: RULE } } };
  });
}

interface LineArgs {
  arm: Arm;
  fault: string;
  tally: Tally | undefined;
}

function line(ws: ExcelJS.Worksheet, a: LineArgs): void {
  const { arm, tally: t } = a;
  const r = ws.addRow([
    '',
    '',
    '',
    scenarioOf(arm.name, a.fault),
    arm.name === '' ? 'nothing — this task has only the one condition' : arm.different,
    proving(arm),
    arm.claim?.refutes ?? '',
    '',
    '',
    t?.eps ?? 0,
    rate(t?.harm ?? 0, t?.harmN ?? 0),
    rate(t?.done ?? 0, t?.doneN ?? 0),
  ]);
  r.outlineLevel = 2;
  paintLine(r, a.fault === 'none', (t?.eps ?? 0) === 0);
  paintRate(r.getCell(NUMERIC[1]), 'harm');
  paintRate(r.getCell(NUMERIC[2]), 'done');
}

/** Everything about how a line reads, so `line` only decides what it says. */
function paintLine(r: ExcelJS.Row, clean: boolean, unrun: boolean): void {
  // A line carrying an injected failure is rarer and worth seeing; the rest is
  // an address and can recede.
  r.getCell(LINE_PROSE[0]).font = { size: 9, color: { argb: clean ? QUIET : INK }, bold: !clean };
  r.getCell(LINE_PROSE[0]).alignment = { vertical: 'top' };

  // Only "what we expect to go wrong" is full strength; the rest is the context
  // that makes it legible.
  for (let i = LINE_PROSE[0] + 1; i <= LINE_PROSE[1]; i += 1) {
    r.getCell(i).alignment = { wrapText: true, vertical: 'top' };
    r.getCell(i).font = { size: 9, color: { argb: i === 6 ? INK : QUIET } };
  }

  r.getCell(NUMERIC[0]).alignment = { horizontal: 'right', vertical: 'top' };
  r.getCell(NUMERIC[0]).font = { size: 10, color: { argb: unrun ? QUIET : INK } };
  r.eachCell({ includeEmpty: true }, (c) => {
    c.border = { top: { style: 'hair', color: { argb: RULE } } };
  });
}

/**
 * Scenarios under their payment rail, minus any rail the caller dropped.
 *
 * A rail is dropped when it has nothing to say — Bacs here has two tasks with no
 * conditions and nothing to compare them against, so its lines would be four
 * columns of prose and no answer.
 */
function group(
  scenarios: Scenario[],
  cases: Map<string, CaseInfo>,
  drop: string[]
): { byMethod: Map<string, Scenario[]>; dropped: number } {
  const byMethod = new Map<string, Scenario[]>();
  let dropped = 0;
  for (const s of scenarios) {
    const method = cases.get(caseOf(s.file))?.method ?? '(no case row)';
    if (drop.some((d) => method.toLowerCase() === d.toLowerCase())) {
      dropped += 1;
      continue;
    }
    if (!byMethod.has(method)) byMethod.set(method, []);
    byMethod.get(method)!.push(s);
  }
  return { byMethod, dropped };
}

export async function summary(dir: string, out: string, drop: string[]): Promise<{ lines: number; dropped: number }> {
  const scenarios = readScenarios(dir);
  const cases = await readCases(dir);
  const rows = await readRows(dir);
  const runs = readRuns(dir, rows);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'excruciate summary';
  const ws = wb.addWorksheet('what we test', { properties: { defaultRowHeight: 15 } });
  ws.columns = COLUMNS.map(([, width]) => ({ width }));
  heading(ws, dir);

  const { byMethod, dropped } = group(scenarios, cases, drop);
  let lines = 0;
  for (const [method, list] of [...byMethod].sort()) {
    const band = ws.addRow([method]);
    band.font = { bold: true, size: 11, color: { argb: INK } };
    band.height = 19;
    band.outlineLevel = 0;
    band.eachCell({ includeEmpty: true }, (c) => { c.fill = fill(BAND); });

    for (const s of [...list].sort((a, b) => a.file.localeCompare(b.file))) {
      taskRow(ws, caseOf(s.file), s.title, cases.get(caseOf(s.file)));
      for (const arm of s.arms) {
        for (const fault of faultsOf(rows, s.file, arm.name)) {
          lines += 1;
          line(ws, { arm, fault, tally: runs.get(`${s.file}#${arm.name}#${fault}`) });
        }
      }
    }
  }

  await wb.xlsx.writeFile(out);
  return { lines, dropped };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (dir === undefined) {
    console.error('usage: bun summary.ts <research-dir> [--out summary.xlsx] [--drop "A, B"]');
    process.exit(1);
  }
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? undefined : args[at + 1];
  };
  const out = resolve(flag('out') ?? resolve(dir, 'summary.xlsx'));
  const drop = (flag('drop') ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  const { lines, dropped } = await summary(resolve(dir), out, drop);
  console.log(`${lines} lines${dropped > 0 ? `, ${dropped} scenarios dropped` : ''} → ${out}`);
}

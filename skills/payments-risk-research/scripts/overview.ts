/**
 * The whole research on one page: what exists, what has run, and what it did.
 *
 *   payment system → case → arm → claim → episodes → harm and completion
 *
 * WHY THIS IS NOT A REPORT. A report argues; this counts. It answers the
 * questions you ask before deciding what to spend next — which arms have never
 * run, which claims have no baseline to compare against, which pairs already
 * separate and which are flat — and every figure is read out of the artefacts,
 * so none of it can drift from what actually happened.
 *
 * RATES ARE POOLED ACROSS EVERY RUN the folder holds, of every vintage. That is
 * the right default for "what have we seen so far" and the wrong one for a
 * finding: two runs either side of a handler change are not one sample. The
 * runs column is there so a suspiciously round rate can be traced back.
 *
 *   bun overview.ts <research-dir> [--out overview.xlsx]
 */
import ExcelJS from 'exceljs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';

// ---------------------------------------------------------------- reading

interface Arm {
  name: string;
  baseline: boolean;
  different: string;
  claim?: { id: string; kind: string };
}

interface Scenario {
  file: string;
  catalogue: string[];
  arms: Arm[];
}

const yaml = (s: string): unknown => (Bun as unknown as { YAML: { parse(t: string): unknown } }).YAML.parse(s);

/** The `axis:` block alone: the body is not valid YAML until an arm renders it. */
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

function readScenarios(dir: string): Scenario[] {
  const tasks = resolve(dir, 'tasks');
  return readdirSync(tasks)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((file) => {
      const src = readFileSync(resolve(tasks, file), 'utf8');
      return {
        file,
        catalogue: (/^# Catalogue: (.*)$/m.exec(src)?.[1] ?? '').match(/H-\d+/g) ?? [],
        arms: armsOf(src),
      };
    });
}

/** A scenario's arms: its axis values, or the one nameless arm it has instead. */
function armsOf(src: string): Arm[] {
  const block = axisSource(src);
  if (block === null) {
    const doc = yaml(src) as Record<string, unknown> | null;
    const claim = doc?.['claim'] as { id: string; kind: string } | undefined;
    return [{ name: '', baseline: true, different: '', ...(claim ? { claim } : {}) }];
  }
  const doc = yaml(block) as { axis?: Record<string, Record<string, Record<string, unknown>>> };
  const out: Arm[] = [];
  for (const values of Object.values(doc.axis ?? {})) {
    for (const [name, body] of Object.entries(values)) {
      const claim = body['claim'] as { id: string; kind: string } | undefined;
      out.push({
        name,
        baseline: body['baseline'] === true,
        different: String(body['different'] ?? ''),
        ...(claim ? { claim: { id: claim.id, kind: claim.kind } } : {}),
      });
    }
  }
  return out;
}

interface Where { task: string; arm: string }

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
    });
  });
  return out;
}

async function readMethods(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const path = resolve(dir, 'cases.xlsx');
  if (!existsSync(path)) return out;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.getWorksheet('cases');
  if (ws === undefined) return out;
  const head: string[] = [];
  ws.getRow(1).eachCell((c, i) => (head[i - 1] = String(c.value ?? '').trim()));
  const col = head.indexOf('method') + 1;
  ws.eachRow((r, i) => {
    if (i === 1) return;
    out.set(String(r.getCell(1).value ?? '').trim(), String(r.getCell(col).value ?? '').trim());
  });
  return out;
}

interface Tally { runs: Set<string>; eps: number; harm: number; harmN: number; done: number; doneN: number }

/**
 * Every run in the folder, folded onto the arm each row belongs to TODAY.
 *
 * Row ids are the join, because they survive a scenario being renamed or split
 * — which is how the history of a case that became two cases stays attached to
 * the right halves.
 */
function readRuns(dir: string, rows: Map<string, Where>, alias: (id: string) => string) {
  const seen = new Map<string, Tally>();
  const orphans = new Map<string, number>();
  const results = resolve(dir, 'results');
  if (!existsSync(results)) return { seen, orphans };

  for (const d of readdirSync(results).sort()) {
    const f = resolve(results, d, 'data.json');
    if (!existsSync(f)) continue;
    const j = JSON.parse(readFileSync(f, 'utf8')) as { rows?: Measured[] };
    for (const r of j.rows ?? []) fold(seen, orphans, rows, alias(String(r.id)), r, d);
  }
  return { seen, orphans };
}

interface Measured {
  id: string;
  n?: number;
  // NULL, not absent, when a row graded nothing on that axis — a void episode
  // leaves the key in place with nothing behind it.
  harm?: { count: number; n: number } | null;
  completion?: { count: number; n: number } | null;
}

function fold(
  seen: Map<string, Tally>,
  orphans: Map<string, number>,
  rows: Map<string, Where>,
  id: string,
  r: Measured,
  run: string
): void {
  const where = rows.get(id);
  if (where === undefined) {
    orphans.set(id, (orphans.get(id) ?? 0) + (Number(r.n) || 0));
    return;
  }
  const key = `${where.task}#${where.arm}`;
  const t = seen.get(key) ?? { runs: new Set<string>(), eps: 0, harm: 0, harmN: 0, done: 0, doneN: 0 };
  t.runs.add(run);
  t.eps += Number(r.n) || 0;
  if (r.harm != null) { t.harm += r.harm.count; t.harmN += r.harm.n; }
  if (r.completion != null) { t.done += r.completion.count; t.doneN += r.completion.n; }
  seen.set(key, t);
}

// ---------------------------------------------------------------- writing

const INK = '1F2933';
const QUIET = '7B8794';
const BAND = 'E4E7EB';
const RULE = 'CBD2D9';
const ALARM = 'A61B1B';
const WARN = '8A5A00';

const fill = (argb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb } });

/** A rate as a fraction, or nothing at all — never a zero standing in for "unmeasured". */
const rate = (c: number, n: number): number | string => (n === 0 ? '–' : c / n);

function sheet(wb: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: 2 }],
    properties: { defaultRowHeight: 16 },
  });
  ws.columns = [
    { key: 'a', width: 24 },
    { key: 'b', width: 15 },
    { key: 'c', width: 16 },
    { key: 'd', width: 24 },
    { key: 'e', width: 22 },
    { key: 'f', width: 7 },
    { key: 'g', width: 9 },
    { key: 'h', width: 7 },
    { key: 'i', width: 9 },
    { key: 'j', width: 11 },
    { key: 'k', width: 78 },
  ];
  return ws;
}

function header(ws: ExcelJS.Worksheet, title: string, subtitle: string): void {
  const t = ws.addRow([title]);
  t.font = { bold: true, size: 14, color: { argb: INK } };
  t.height = 22;
  const s = ws.addRow([subtitle]);
  s.font = { size: 9, color: { argb: QUIET } };
  s.height = 14;
  ws.addRow([]);

  const h = ws.addRow([
    'Payment system', 'Case', 'Arm', 'Claim', 'Catalogue',
    'Rows', 'Episodes', 'Runs', 'Harm', 'Completed',
    'What this arm changes',
  ]);
  h.font = { bold: true, size: 10, color: { argb: INK } };
  h.eachCell((c) => {
    c.border = { bottom: { style: 'medium', color: { argb: INK } } };
    c.alignment = { vertical: 'bottom' };
  });
  for (const i of [6, 7, 8, 9, 10]) h.getCell(i).alignment = { horizontal: 'right', vertical: 'bottom' };
  ws.views = [{ state: 'frozen', ySplit: h.number }];
}

/** The method band: a payment system, and everything under it. */
function methodRow(ws: ExcelJS.Worksheet, method: string): void {
  const m = ws.addRow([method]);
  m.font = { bold: true, size: 11, color: { argb: INK } };
  m.height = 20;
  m.outlineLevel = 0;
  m.eachCell({ includeEmpty: true }, (c) => {
    c.fill = fill(BAND);
  });
}

function caseRow(ws: ExcelJS.Worksheet, id: string, catalogue: string[]): void {
  const c = ws.addRow(['', id, '', '', catalogue.join(' ')]);
  c.font = { bold: true, size: 10, color: { argb: INK } };
  c.getCell(5).font = { size: 9, color: { argb: QUIET } };
  c.outlineLevel = 1;
  c.eachCell({ includeEmpty: true }, (cell) => {
    cell.border = { top: { style: 'hair', color: { argb: RULE } } };
  });
}

/**
 * How a rate is coloured: loudly when it is bad, quietly when it is nothing.
 *
 * Harm rising is bad; completion FALLING is bad. Colouring them by the same
 * rule would make a case that stops the job being done look healthy.
 */
function paintRate(cell: ExcelJS.Cell, kind: 'harm' | 'done'): void {
  cell.alignment = { horizontal: 'right' };
  cell.numFmt = '0%';
  const v = cell.value;
  if (typeof v !== 'number') {
    cell.font = { size: 10, color: { argb: QUIET } };
    return;
  }
  if (kind === 'harm') {
    cell.font = { size: 10, bold: v >= 0.5, color: { argb: v >= 0.5 ? ALARM : v > 0 ? WARN : QUIET } };
  } else {
    cell.font = { size: 10, bold: v <= 0.34, color: { argb: v <= 0.34 ? ALARM : v < 1 ? INK : QUIET } };
  }
}

/**
 * What an arm claims, in the space of one cell.
 *
 * An arm with no claim and no baseline flag is left BLANK rather than labelled:
 * it is an arm nothing is asking a question about, and saying so quietly is how
 * that shows up in a scan of the column.
 */
function claimLabel(arm: Arm): string {
  if (arm.claim === undefined) return arm.baseline ? 'baseline' : '';
  return `${arm.claim.id}${arm.claim.kind === 'conditional' ? '  (conditional)' : ''}`;
}

function armRow(ws: ExcelJS.Worksheet, arm: Arm, planned: number, t: Tally | undefined): void {
  const claim = claimLabel(arm);
  const r = ws.addRow([
    '',
    '',
    arm.name === '' ? '(single arm)' : arm.name,
    claim,
    '',
    planned,
    t?.eps ?? 0,
    t?.runs.size ?? 0,
    rate(t?.harm ?? 0, t?.harmN ?? 0),
    rate(t?.done ?? 0, t?.doneN ?? 0),
    arm.different,
  ]);
  r.outlineLevel = 2;
  r.font = { size: 10, color: { argb: INK } };
  r.getCell(3).font = { size: 10, color: { argb: INK }, italic: arm.baseline };
  r.getCell(4).font = { size: 9, color: { argb: arm.claim ? INK : QUIET } };
  r.getCell(11).font = { size: 9, color: { argb: QUIET } };

  for (const i of [6, 7, 8]) {
    r.getCell(i).alignment = { horizontal: 'right' };
    r.getCell(i).font = { size: 10, color: { argb: r.getCell(i).value === 0 ? QUIET : INK } };
  }
  paintRate(r.getCell(9), 'harm');
  paintRate(r.getCell(10), 'done');
}

function footer(
  ws: ExcelJS.Worksheet,
  cases: number,
  arms: number,
  rows: number,
  episodes: number,
  orphans: Map<string, number>
): void {
  ws.addRow([]);
  const total = ws.addRow(['', '', '', '', '', rows, episodes, '', '', '', `${cases} cases · ${arms} arms`]);
  total.font = { bold: true, size: 10, color: { argb: INK } };
  total.getCell(6).alignment = { horizontal: 'right' };
  total.getCell(7).alignment = { horizontal: 'right' };
  total.getCell(11).font = { size: 9, color: { argb: QUIET } };
  total.eachCell({ includeEmpty: true }, (c) => {
    c.border = { top: { style: 'medium', color: { argb: INK } } };
  });

  if (orphans.size === 0) return;
  ws.addRow([]);
  const n = [...orphans.values()].reduce((a, b) => a + b, 0);
  const o = ws.addRow([
    '', '', '', '', '', '', '', '', '', '',
    `${n} episodes on ${orphans.size} row ids the workbook no longer has, attributed to nothing: ${[...orphans.keys()].sort().join(', ')}`,
  ]);
  o.font = { size: 9, italic: true, color: { argb: WARN } };
}

/**
 * Row ids that were renamed, so their history follows them.
 *
 * A row id is an address, and these two moved: TC-DDO-04's cancellation arm
 * became TC-DDO-05 when the case split on its instruction, and TC-DDO-01's rows
 * gained an arm suffix when its three worlds became arms of one scenario. The
 * episodes behind them measured the same thing before and after, so folding
 * them onto the new address recovers real history rather than inventing it.
 *
 * Rows that were DELETED are deliberately not aliased anywhere. They show up in
 * the footer as episodes attributed to nothing, which is what they are.
 */
const alias = (id: string): string =>
  id
    .replace(/^ddo04-([a-z0-9]+)-cancel$/, 'ddo05-$1')
    .replace(/^ddo01-([a-z0-9]+)$/, 'ddo01-$1-late');

export async function overview(dir: string, out: string): Promise<{ arms: number; episodes: number }> {
  const scenarios = readScenarios(dir);
  const rows = await readRows(dir);
  const methods = await readMethods(dir);
  const { seen, orphans } = readRuns(dir, rows, alias);

  const planned = new Map<string, number>();
  for (const w of rows.values()) {
    const k = `${w.task}#${w.arm}`;
    planned.set(k, (planned.get(k) ?? 0) + 1);
  }

  const caseOf = (file: string) => file.replace(/\.yaml$/, '').toUpperCase();
  const byMethod = new Map<string, Scenario[]>();
  for (const s of scenarios) {
    const m = methods.get(caseOf(s.file)) ?? '(no case row)';
    if (!byMethod.has(m)) byMethod.set(m, []);
    byMethod.get(m)!.push(s);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'excruciate overview';
  const ws = sheet(wb, 'overview');
  header(
    ws,
    `${basename(resolve(dir))} — cases, arms and everything measured so far`,
    'Rates pool every run in the folder, of every vintage. An em dash means nothing has run, which is not the same as a rate of zero.'
  );

  let armCount = 0;
  let epCount = 0;
  for (const [method, list] of [...byMethod].sort()) {
    methodRow(ws, method);
    for (const s of [...list].sort((a, b) => a.file.localeCompare(b.file))) {
      caseRow(ws, caseOf(s.file), s.catalogue);
      for (const arm of s.arms) {
        const key = `${s.file}#${arm.name}`;
        const t = seen.get(key);
        armCount += 1;
        epCount += t?.eps ?? 0;
        armRow(ws, arm, planned.get(key) ?? 0, t);
      }
    }
  }

  footer(ws, scenarios.length, armCount, rows.size, epCount, orphans);
  await wb.xlsx.writeFile(out);
  return { arms: armCount, episodes: epCount };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (dir === undefined) {
    console.error('usage: bun overview.ts <research-dir> [--out overview.xlsx]');
    process.exit(1);
  }
  const at = args.indexOf('--out');
  const out = resolve(at === -1 ? resolve(dir, 'overview.xlsx') : args[at + 1]!);
  const { arms, episodes } = await overview(resolve(dir), out);
  console.log(`${arms} arms, ${episodes} episodes → ${out}`);
}

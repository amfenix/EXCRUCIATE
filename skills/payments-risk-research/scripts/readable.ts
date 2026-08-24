/**
 * `data.json` → `findings.xlsx`, in the language of the business rather than the
 * runner.
 *
 * `results.xlsx` is the runner's account of a run: row ids, surfaces, memory
 * modes. This is the same run described as a payments person would describe it,
 * and it is the report's data layer — produced first, so the spreadsheet and the
 * report cannot disagree.
 *
 * Three sheets, because there are three questions:
 *
 *   findings   what happened, per condition, against its control
 *   episodes   what happened in ONE run, with the agent's own words and the
 *              path to its trail — the end-user's way into the evidence
 *   glossary   what the words mean, and how to read an interval
 *
 * Every figure here comes from the dataset. Nothing is computed a second time in
 * a different way, and nothing is typed.
 *
 *   bun readable.ts <data.json> [--hypotheses h.yaml] [--out findings.xlsx]
 *                   [--money <measure>] [--minor-units]
 */
import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Dataset, Label, Rate } from './extract.ts';

/** How to render a measured quantity — pence and pounds are not the same column. */
interface Money {
  measure: string | undefined;
  minorUnits: boolean;
}

const bounds = (r: Rate | null): string =>
  r === null ? 'not measured' : `${r.rate.toFixed(3)} [${r.lo.toFixed(3)}, ${r.hi.toFixed(3)}]`;

const counted = (r: Rate | null): string => (r === null ? '' : `${r.count} of ${r.n}`);

const money = (value: number, m: Money): number => tidy(m.minorUnits ? value / 100 : value);

/**
 * Six decimal places on money. `0.040617999999999994` in a cell undoes the
 * credibility of every honest figure beside it, and a millionth of a dollar is
 * far below anything measured here.
 */
const tidy = (n: number): number => Math.round(n * 1e6) / 1e6;

const usd = (value: number | null): string | number => (value === null ? 'not priced' : tidy(value));

const trim = (text: string, at = 300): string =>
  text.length <= at ? text : `${text.slice(0, at).trimEnd()}…`;

/**
 * Cell helpers, so the row builders below read as the spreadsheet's columns and
 * nothing else. A blank is deliberate wherever a number would be a lie: an axis
 * nobody measured has no count, and `0` there reads as "no run was harmed".
 */
type Cell = string | number;

const yesNo = (value: boolean | null): Cell => (value === null ? '' : value ? 'yes' : 'no');

const passed = (r: Rate | null): Cell => (r === null ? '' : r.count);

const failedOf = (r: Rate | null): Cell => (r === null ? '' : r.n - r.count);

/** The money column exists only when a measure was named; then it is one cell. */
const moneyCells = (m: Money, value: number | undefined): Cell[] =>
  m.measure === undefined ? [] : [value === undefined ? '' : money(value, m)];

const moneyHead = (m: Money): string[] =>
  m.measure === undefined ? [] : [m.minorUnits ? 'money moved' : m.measure];

/**
 * A row nobody labelled falls back to its id and its fault list: visibly
 * unlabelled beats silently renamed. Labels belong to the ROW, never to its role
 * in a hypothesis — the same row is one hypothesis's control and another's test,
 * and "the control" is not a description of anything.
 */
const labelOf = (labels: Record<string, Label>, id: string): Label =>
  labels[id] ?? { method: '', scenario: '', condition: '' };

function findingsSheet(wb: ExcelJS.Workbook, data: Dataset, m: Money): void {
  const sheet = wb.addWorksheet('findings');
  const header = [
    'payment method',
    'scenario',
    'what happened to it',
    'runs',
    'scored',
    'void',
    'failed',
    'harmed',
    'unharmed',
    'harm rate [95% CI]',
    'completed',
    'incomplete',
    ...moneyHead(m),
    'cost to measure (USD)',
    'appears in',
    'row id',
  ];
  sheet.addRow(header);

  for (const row of data.rows) {
    const moved = m.measure === undefined ? undefined : row.measures[m.measure];
    const label = labelOf(data.labels, row.id);
    sheet.addRow([
      label.method,
      label.scenario,
      label.condition === '' ? row.faults : label.condition,
      row.total,
      row.n,
      row.voided,
      row.failed,
      passed(row.harm),
      failedOf(row.harm),
      bounds(row.harm),
      passed(row.completion),
      failedOf(row.completion),
      ...moneyCells(m, moved?.total),
      usd(row.spend.usd),
      data.comparisons.filter((c) => c.control === row.id || c.test === row.id).map((c) => c.id).join(', '),
      row.id,
    ]);
  }

  bold(sheet);
  widths(sheet, [18, 26, 40, 7, 8, 7, 8, 9, 11, 22, 11, 12, 14, 18, 14, 26]);
}

/**
 * The comparisons, which are the only lines here that are findings.
 *
 * A separate sheet because a condition on its own is a number: what a reader
 * should carry away is the difference from the control, and whether the
 * intervals allow it to be called a difference at all.
 *
 * BOTH AXES, ALWAYS. A trap that stops the job being done without breaking
 * anything moves completion and leaves harm flat — seven of this corpus's
 * twenty-one claims are that shape, and a sheet showing harm alone reports them
 * as "no — intervals overlap" while completion runs 11 of 11 down to 0 of 11.
 */
function comparisonSheet(wb: ExcelJS.Workbook, data: Dataset, m: Money): void {
  if (data.comparisons.length === 0) return;
  const sheet = wb.addWorksheet('comparisons');

  sheet.addRow([
    'hypothesis',
    'the claim',
    'condition',
    'control harmed',
    'condition harmed',
    'harm separable?',
    'control completed',
    'condition completed',
    'completion separable?',
    ...(m.measure === undefined ? [] : ['excess per run', 'excess total']),
    'control row',
    'condition row',
  ]);

  for (const c of data.comparisons) {
    const excess = m.measure === undefined ? undefined : c.measures[m.measure];
    sheet.addRow([
      c.id,
      c.claim,
      c.condition,
      counted(c.harm.control),
      counted(c.harm.test),
      c.harm.separable ? 'yes' : 'no — intervals overlap',
      counted(c.completion.control),
      counted(c.completion.test),
      c.completion.separable ? 'yes' : 'no — intervals overlap',
      ...moneyCells(m, excess?.excessPerRun),
      ...moneyCells(m, excess?.excess),
      c.control,
      c.test,
    ]);
  }

  bold(sheet);
  widths(sheet, [12, 46, 30, 15, 17, 18, 17, 19, 21, 15, 14, 26, 26]);
}

/** One row per repetition: the way in to a single run. */
function episodesSheet(wb: ExcelJS.Workbook, data: Dataset, m: Money): void {
  const sheet = wb.addWorksheet('episodes');
  sheet.addRow([
    'run',
    'what happened to it',
    'harmed',
    'completed',
    'not scored because',
    'what it did',
    ...moneyHead(m),
    'what it told the operator',
    'full trail',
  ]);

  for (const row of data.rows) {
    for (const episode of row.episodes) {
      const moved = m.measure === undefined ? undefined : episode.measures[m.measure];
      const last = episode.answers.at(-1);
      const label = labelOf(data.labels, row.id);
      sheet.addRow([
        episode.id,
        label.condition === '' ? row.faults : label.condition,
        yesNo(episode.harmed),
        yesNo(episode.completed),
        episode.void ?? '',
        episode.calls.join('  →  '),
        ...moneyCells(m, moved),
        trim(String(last?.answer ?? '').replace(/\s+/g, ' ')),
        episode.trail,
      ]);
    }
  }

  bold(sheet);
  widths(sheet, [26, 30, 8, 11, 34, 46, 14, 80, 34]);
}

function glossarySheet(wb: ExcelJS.Workbook, data: Dataset, m: Money): void {
  const sheet = wb.addWorksheet('glossary');
  sheet.addRow(['term', 'what it means']);

  const entries: Array<[string, string]> = [
    ['harmed', 'The run did damage: the harm check found something the agent should not have done.'],
    [
      'completed',
      'The run did the job it was asked to do. Reported separately from harm and never averaged with it — an agent that does nothing at all scores zero harm.',
    ],
    [
      'void',
      'The run happened but could not be judged, so it is excluded from every rate. Usually a trap that never armed. Our fault, not the model’s.',
    ],
    ['failed', 'The run never completed at all — harness or provider. Also excluded, and counted separately.'],
    [
      'harm rate [95% CI]',
      'The proportion of scored runs that did damage, with a Wilson interval. 0 of 5 is 0.000 [0.000, 0.434] — consistent with a true rate as high as 43%, so it does not mean "never".',
    ],
    [
      'separable at this N?',
      'Whether the two intervals fail to overlap. "No" means the difference cannot be claimed at this sample size, however different the two rates look.',
    ],
    [
      'what it did',
      'The operations the agent called, in order, with what each answered. 504 is the injected failure; 201 is a payment created.',
    ],
    [
      'full trail',
      'Path inside the run folder to the readable record of that one run: what was said, every call, every row that changed, and the grade.',
    ],
  ];

  if (m.measure !== undefined) {
    entries.splice(4, 0, [
      m.minorUnits ? 'money moved' : m.measure,
      m.minorUnits
        ? 'Measured from the audit trail: money the agent itself moved, in major units. Compare it against the control — the excess is what the failure cost.'
        : `Measured from the audit trail by the "${m.measure}" query in the hypothesis file.`,
    ]);
  }

  for (const entry of entries) sheet.addRow(entry);

  sheet.addRow([]);
  sheet.addRow(['run', data.run.name]);
  sheet.addRow(['model', data.rows[0]?.model ?? '']);
  sheet.addRow(['episodes', `${data.run.episodes} (${data.run.scored} scored, ${data.run.voided} void, ${data.run.failed} failed)`]);
  sheet.addRow(['cost of the evidence', usd(data.run.spend.usd)]);

  bold(sheet);
  widths(sheet, [26, 110]);
}

const bold = (sheet: ExcelJS.Worksheet): void => {
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
};

function widths(sheet: ExcelJS.Worksheet, columns: number[]): void {
  columns.forEach((width, i) => {
    sheet.getColumn(i + 1).width = width;
  });
}

export async function write(path: string, data: Dataset, m: Money): Promise<void> {
  const wb = new ExcelJS.Workbook();

  comparisonSheet(wb, data, m);
  findingsSheet(wb, data, m);
  episodesSheet(wb, data, m);
  glossarySheet(wb, data, m);

  await wb.xlsx.writeFile(path);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const input = args.find((a) => !a.startsWith('--'));
  if (input === undefined) {
    console.error(
      'usage: bun readable.ts <data.json> [--out findings.xlsx] [--money <measure>] [--minor-units]'
    );
    process.exit(1);
  }

  const flag = (name: string): string | undefined => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? undefined : args[at + 1];
  };

  const data = JSON.parse(readFileSync(resolve(input), 'utf8')) as Dataset;
  // Default to the only measure there is: with one, guessing is not guessing.
  const measure = flag('money') ?? (data.measureNames.length === 1 ? data.measureNames[0] : undefined);
  const out = resolve(flag('out') ?? resolve(data.run.dir, 'findings.xlsx'));

  await write(out, data, { measure, minorUnits: args.includes('--minor-units') });
  console.log(`${data.rows.length} conditions, ${data.run.episodes} runs → ${out}`);
  if (measure === undefined && data.measureNames.length > 1) {
    console.log(`no money column: pass --money <${data.measureNames.join(' | ')}>`);
  }
}

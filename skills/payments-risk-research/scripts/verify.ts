/**
 * Refuse a report containing a number that is not in the dataset.
 *
 * The rule this enforces is the one the whole loop rests on: the scripts produce
 * the figures, the agent produces the words. That rule is worth nothing unless
 * something checks it, because a fabricated number is indistinguishable from a
 * real one by eye — it is the right shape, in the right place, in a sentence that
 * reads well.
 *
 * Every number in the page's visible text must be derivable from `data.json`.
 * Anything else is either a mistake or an invention, and both should stop the
 * publish.
 *
 * NOT checked: `<style>`, `<script>`, `<pre>` and `<code>`. Those hold CSS, bar
 * widths and SQL — machinery, not claims. A claim in a code block is not a claim
 * anyone reads as one.
 *
 *   bun verify.ts <report.html> <data.json> [--allow 1000,25000]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { wilson } from './extract.ts';
import type { Dataset, Rate } from './extract.ts';

/** Numbers a report may state without the dataset: structural, not measured. */
const STRUCTURAL = new Set([0, 1, 2, 3, 4, 5, 95, 100]);

/**
 * Every way one dataset number may honestly appear in prose.
 *
 * A rate of 0.8 is legitimately written `0.800`, `0.8`, `80`, or `80.0`; money in
 * pence is written in pounds. Being generous here is right: the check exists to
 * catch numbers with no basis at all, not to police rounding.
 */
function spellings(value: number): number[] {
  if (!Number.isFinite(value)) return [];
  const out = new Set<number>([value]);

  for (const places of [0, 1, 2, 3, 4, 6]) out.add(Number(value.toFixed(places)));
  // A proportion read as a percentage.
  if (value >= 0 && value <= 1) {
    for (const places of [0, 1, 2]) out.add(Number((value * 100).toFixed(places)));
  }
  // Minor units read as major, which is how money is written for people.
  if (Number.isInteger(value) && Math.abs(value) >= 100) {
    for (const places of [0, 2]) out.add(Number((value / 100).toFixed(places)));
  }
  // Token counts abbreviated: 58925 → 58.9k → 59k.
  if (Math.abs(value) >= 1000) {
    out.add(Number((value / 1000).toFixed(1)));
    out.add(Number((value / 1000).toFixed(0)));
  }
  return [...out];
}

/**
 * Every number in the dataset, whatever its depth — including the ones written
 * INSIDE its strings.
 *
 * A claim registered as "the rail answers 201 with an id and the payment is
 * ER_INVALID" puts a 201 in the report the moment the report quotes the claim.
 * That figure was not typed by hand; it was carried from the dataset, and
 * flagging it teaches an author to reach for `--allow` as a matter of routine —
 * which is the one habit this whole check exists to prevent.
 */
function numbersIn(value: unknown, into: Set<number>): void {
  if (typeof value === 'string') {
    // NO LEADING SIGN when reading a string: a hyphen inside `gemini-2.5-pro`
    // or `2026-08-24` is punctuation, and reading it as a minus collects -2.5
    // for a page that prints 2.5.
    for (const m of value.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
      const n = Number(m[0].replace(/,/g, ''));
      if (Number.isFinite(n)) into.add(n);
    }
    return;
  }
  if (typeof value === 'number') {
    into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) numbersIn(item, into);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) numbersIn(item, into);
  }
}

/**
 * Derived quantities a report is expected to state, which the dataset holds only
 * as parts: "5 of 5" is two numbers, "14 of 25" pools across rows, and a
 * difference between a condition and its control is the finding itself.
 */
function derived(data: Dataset): number[] {
  const out: number[] = [];
  const rows = data.rows;

  for (const row of rows) {
    for (const rate of [row.harm, row.completion, ...row.checks]) {
      if (rate === null) continue;
      out.push(rate.n - rate.count);
    }
    for (const measure of Object.values(row.measures)) {
      out.push(measure.total, measure.mean, measure.median, measure.min, measure.max);
    }
  }

  // Pooled counts and their interval, which is what a TOTAL line reports.
  for (const pick of [(r: (typeof rows)[number]) => r.harm, (r: (typeof rows)[number]) => r.completion]) {
    out.push(...pooled(rows.map(pick)));
  }

  // A hypothesis's two rows pooled: "10 of 10 across both surfaces" is a claim a
  // report makes, and it is honest — the two rows are the ones it named.
  for (const c of data.comparisons) {
    out.push(...pooled([c.harm.control, c.harm.test]));
  }

  // Totals of every measure across the whole run, and every comparison's excess.
  for (const name of data.measureNames) {
    out.push(rows.reduce((n, r) => n + (r.measures[name]?.total ?? 0), 0));
  }
  for (const c of data.comparisons) {
    for (const m of Object.values(c.measures)) out.push(m.excess, m.excessPerRun, m.test - m.control);
  }
  return out;
}

/** Every number a pooled rate puts on the page. */
function pooled(rates: Array<Rate | null>): number[] {
  const measured = rates.filter((r): r is Rate => r !== null);
  if (measured.length === 0) return [];

  const r = wilson(
    measured.reduce((n, x) => n + x.count, 0),
    measured.reduce((n, x) => n + x.n, 0)
  );
  return [r.count, r.n, r.n - r.count, r.rate, r.lo, r.hi];
}

/** Strip the machinery, keep what a reader actually reads. */
function visibleText(html: string): string {
  return html
    .replace(/<(style|script|pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
}

/** True when the digits are glued to a name: a run id, a model, a version. */
function identifier(text: string, at: number, length: number): boolean {
  const before = text.slice(Math.max(0, at - 1), at);
  const after = text.slice(at + length, at + length + 1);
  // A HYPHEN BETWEEN TWO DIGIT GROUPS JOINS THEM, it does not negate the second.
  // Without this the last element of a sort code `04-13-07` or a date
  // `2026-08-18` escapes as -7 and -18 — numbers nobody wrote and nobody can
  // correct, which is how a reader learns to ignore this tool.
  if (text[at] === '-' && /\d/.test(before)) return true;
  return /[A-Za-z\-:/]/.test(before) || /[A-Za-z\-:/]/.test(after);
}

export interface Result {
  ok: boolean;
  checked: number;
  unmatched: Array<{ value: number; context: string }>;
}

export function verify(html: string, data: Dataset, allow: number[] = []): Result {
  const allowed = new Set<number>();
  const collected = new Set<number>();
  numbersIn(data, collected);

  for (const value of [...collected, ...derived(data), ...allow, ...STRUCTURAL]) {
    for (const spelling of spellings(value)) allowed.add(spelling);
  }

  const text = visibleText(html);
  const unmatched: Result['unmatched'] = [];
  let checked = 0;

  // A number as a reader meets it: 1,234.56 · 0.800 · 43% · £25.00
  const pattern = /-?\d[\d,]*(?:\.\d+)?/g;
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[0].replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    // Digits inside an identifier are not claims: `claude-haiku-4.5` and
    // `2026-08-17T14-12-48-482Z` are names that happen to contain numerals, and
    // flagging them teaches the reader to ignore this tool's output.
    if (identifier(text, match.index ?? 0, match[0].length)) continue;
    checked += 1;
    if (allowed.has(value)) continue;

    const at = match.index ?? 0;
    unmatched.push({
      value,
      context: text
        .slice(Math.max(0, at - 60), at + match[0].length + 60)
        .replace(/\s+/g, ' ')
        .trim(),
    });
  }

  return { ok: unmatched.length === 0, checked, unmatched };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const [report, dataset] = args.filter((a) => !a.startsWith('--'));
  if (report === undefined || dataset === undefined) {
    console.error('usage: bun verify.ts <report.html> <data.json> [--allow 1000,25000]');
    process.exit(1);
  }

  const at = args.indexOf('--allow');
  const allow =
    at === -1
      ? []
      : (args[at + 1] ?? '')
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n));

  const result = verify(
    readFileSync(resolve(report), 'utf8'),
    JSON.parse(readFileSync(resolve(dataset), 'utf8')) as Dataset,
    allow
  );

  if (result.ok) {
    console.log(`${result.checked} numbers checked, all present in the dataset.`);
    process.exit(0);
  }

  console.error(`${result.unmatched.length} of ${result.checked} numbers are not in the dataset:\n`);
  for (const miss of result.unmatched) console.error(`  ${String(miss.value).padEnd(12)} …${miss.context}…`);
  console.error(
    '\nEach one is a figure nobody measured. Correct it, or — if it is deliberate arithmetic\n' +
      'whose basis the report states in words — pass it to --allow.'
  );
  process.exit(1);
}

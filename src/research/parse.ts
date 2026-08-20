/**
 * Turning strings into values, with somewhere to point when they are wrong.
 *
 * Every cell of the workbook arrives as text and every YAML scalar may too, so
 * one set of parsers serves both. Each collects into a shared problem list rather
 * than throwing: a research with eight mistakes should report eight, not make
 * someone find them one run at a time.
 */
import type { ThinkingConfig } from '@combycode/llm-sdk';
import type { Problem } from './types.ts';

export class Problems {
  readonly list: Problem[] = [];

  add(where: string, message: string): void {
    this.list.push({ where, message });
  }

  get ok(): boolean {
    return this.list.length === 0;
  }
}

const TRUE = new Set(['yes', 'y', 'true', '1', 'on']);
const FALSE = new Set(['no', 'n', 'false', '0', 'off']);

export const isBlank = (value: unknown): boolean =>
  value === undefined || value === null || String(value).trim() === '';

export function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

export function required(p: Problems, where: string, field: string, value: unknown): string {
  const v = text(value);
  if (v === '') p.add(where, `${field} is required`);
  return v;
}

export function bool(p: Problems, where: string, field: string, value: unknown, fallback: boolean): boolean {
  if (isBlank(value)) return fallback;
  const v = text(value).toLowerCase();
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  p.add(where, `${field} must be yes or no, got "${v}"`);
  return fallback;
}

export function integer(
  p: Problems,
  where: string,
  field: string,
  value: unknown,
  fallback: number,
  min = 1
): number {
  if (isBlank(value)) return fallback;
  const n = Number(text(value));
  if (!Number.isInteger(n) || n < min) {
    p.add(where, `${field} must be a whole number of at least ${min}, got "${text(value)}"`);
    return fallback;
  }
  return n;
}

export function decimal(p: Problems, where: string, field: string, value: unknown): number | undefined {
  if (isBlank(value)) return undefined;
  const n = Number(text(value));
  if (!Number.isFinite(n)) {
    p.add(where, `${field} must be a number, got "${text(value)}"`);
    return undefined;
  }
  return n;
}

export function oneOf<T extends string>(
  p: Problems,
  where: string,
  field: string,
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  if (isBlank(value)) return fallback;
  const v = text(value).toLowerCase() as T;
  if (allowed.includes(v)) return v;
  p.add(where, `${field} must be one of ${allowed.join(', ')} — got "${text(value)}"`);
  return fallback;
}

const EFFORTS = ['low', 'medium', 'high', 'max'] as const;

/** `off` | `low` | `medium` | `high` | `max`, or blank for the provider default. */
export function thinking(p: Problems, where: string, value: unknown): ThinkingConfig | undefined {
  if (isBlank(value)) return undefined;
  const v = text(value).toLowerCase();
  if (v === 'off') return { mode: 'off' };
  if ((EFFORTS as readonly string[]).includes(v)) {
    return { mode: 'on', effort: v as (typeof EFFORTS)[number] };
  }
  p.add(where, `thinking must be off, ${EFFORTS.join(', ')} or blank — got "${text(value)}"`);
  return undefined;
}

/**
 * Which named tool list from the task file the model is shown.
 *
 * The cell holds ONE NAME, not a list of operations. A fixture with forty-four
 * operations does not fit in a spreadsheet cell, and pasting the same twelve
 * names down sixty rows is how two rows end up quietly different from each
 * other. The lists live in the task file under `tools:`, named once and
 * reviewed alongside the task they belong to — exactly as faults are.
 *
 * BLANK IS THE ONLY WAY TO SAY "the whole API", and it is enough. There is no
 * `all` keyword: two spellings of one thing are two things to keep in step, and
 * the word would be ambiguous the moment a task declared a list called `all`.
 * A workbook without the column behaves as it always did.
 */
export function toolset(p: Problems, where: string, value: unknown): string | undefined {
  if (isBlank(value)) return undefined;
  const v = text(value);
  if (v.includes(',')) {
    p.add(where, `tools names one list declared in the task file, not a list of operations \u2014 got "${v}"`);
    return undefined;
  }
  return v;
}

/**
 * `none` | `all` | `a, b`.
 *
 * Blank means `none`, deliberately: the control run is what every fault result
 * has to be read against, so it is the thing you get by not deciding.
 */
export function faults(p: Problems, where: string, value: unknown): 'none' | 'all' | string[] {
  if (isBlank(value)) return 'none';
  const v = text(value);
  const lower = v.toLowerCase();
  if (lower === 'none') return 'none';
  if (lower === 'all') return 'all';

  const names = v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (names.length === 0) {
    p.add(where, `faults must be none, all, or a comma-separated list — got "${v}"`);
    return 'none';
  }
  return names;
}

/** `YYYY-MM-DD HH:MM:SS`, checked here so a bad clock fails at load. */
export function stamp(p: Problems, where: string, field: string, value: unknown): string {
  const v = text(value);
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(v)) {
    p.add(where, `${field} must look like 2026-08-18 09:12:00 — got "${v}"`);
    return '2000-01-01 00:00:00';
  }
  return v.replace('T', ' ');
}

/**
 * Virtual time arithmetic.
 *
 * Parsing a given timestamp and adding a given duration is deterministic — it
 * reads no wall clock, so replay still holds. Everything is UTC; the world has no
 * timezone and inventing one would be a source of drift nobody asked for.
 */
import type { Clock } from '../types.ts';
import type { StepCommon } from './types.ts';

const STAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;
const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseStamp(stamp: string): number {
  const m = STAMP.exec(stamp.trim());
  if (!m) throw new Error(`not a timestamp: "${stamp}" — expected YYYY-MM-DD HH:MM:SS`);
  const [, y, mo, d, h, mi, s] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

export function formatStamp(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

/** '90m', '2h', '5d', '30s' — and combinations: '1d 6h'. */
export function parseDuration(text: string): number {
  const parts = text.trim().toLowerCase().match(/\d+\s*[smhd]/g);
  if (!parts || parts.join('').replace(/\s/g, '') !== text.trim().toLowerCase().replace(/\s/g, '')) {
    throw new Error(`not a duration: "${text}" — expected e.g. 30s, 90m, 2h, 5d`);
  }
  return parts.reduce((total, part) => {
    const unit = part.trim().slice(-1);
    return total + Number(part.slice(0, -1)) * UNITS[unit]!;
  }, 0);
}

/**
 * Where the clock stands for a step. `at` wins over `after`; both are optional,
 * and a step that says neither runs at the time the last one left behind.
 */
export function advance(current: Clock, step: StepCommon): Clock {
  let now = current.now;
  if (step.at !== undefined) now = formatStamp(parseStamp(step.at));
  else if (step.after !== undefined) now = formatStamp(parseStamp(current.now) + parseDuration(step.after));

  // Deliberately NOT derived from the date: business days skip weekends and
  // holidays, which is domain knowledge belonging to the fixture, not to us.
  return { now, business_day: step.businessDay ?? current.business_day };
}

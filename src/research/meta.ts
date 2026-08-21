/**
 * `research.yaml` — everything that is true of every episode.
 *
 * Parsed with `Bun.YAML`, which is built in and follows YAML 1.2, so `on:`,
 * `yes` and an unquoted timestamp all stay strings. That is worth knowing: under
 * YAML 1.1 the first two would have become booleans.
 */
import { integer, isBlank, oneOf, required, text, bool } from './parse.ts';
import type { Problems } from './parse.ts';
import type { Research } from './types.ts';

const SURFACES = ['tools', 'api', 'search'] as const;
const MODES = ['fn', 'http'] as const;

export function parseResearch(source: string, p: Problems, where = 'research.yaml'): Research {
  let doc: Record<string, unknown>;
  try {
    const parsed = (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML.parse(source);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      p.add(where, 'the file must be a YAML mapping of settings');
      return fallback();
    }
    doc = parsed as Record<string, unknown>;
  } catch (e) {
    p.add(where, `not valid YAML: ${(e as Error).message}`);
    return fallback();
  }

  const research: Research = {
    name: required(p, where, 'name', doc['name']),
    surface: oneOf(p, where, 'surface', doc['surface'], SURFACES, 'tools'),
    mode: oneOf(p, where, 'mode', doc['mode'], MODES, 'fn'),
    fixture: required(p, where, 'fixture', doc['fixture']),
    tasks: text(doc['tasks']) === '' ? 'tasks' : text(doc['tasks']),
    out: text(doc['out']) === '' ? 'results' : text(doc['out']),
    concurrency: integer(p, where, 'concurrency', doc['concurrency'], 1),
    preflight: bool(p, where, 'preflight', doc['preflight'], true),
    ...(text(doc['toolTimeout']) !== '' ? { toolTimeout: text(doc['toolTimeout']) } : {}),
    // Absent means no ceiling. A budget of 0 is a real instruction — "run
    // nothing" — so blankness is what turns it off, not the value zero.
    ...budgetOf(p, where, doc['budget']),
    after: lines(p, where, 'after', doc['after']),
    produces: lines(p, where, 'produces', doc['produces']),
  };

  for (const key of Object.keys(doc)) {
    if (!KNOWN.has(key)) p.add(where, `unknown setting "${key}" — a typo here is silently ignored otherwise`);
  }
  return research;
}

const KNOWN = new Set([
  'name',
  'surface',
  'mode',
  'fixture',
  'tasks',
  'out',
  'toolTimeout',
  'concurrency',
  'preflight',
  'budget',
  'after',
  'produces',
]);

const fallback = (): Research => ({
  name: '',
  surface: 'tools',
  mode: 'fn',
  fixture: '',
  tasks: 'tasks',
  out: 'results',
  concurrency: 1,
  preflight: true,
  after: [],
  produces: [],
});

/** A list of strings, refusing anything that is not one — a typo here is silent. */
function lines(p: Problems, where: string, key: string, value: unknown): string[] {
  if (isBlank(value)) return [];
  if (!Array.isArray(value)) {
    p.add(where, `${key} must be a list, got ${typeof value}`);
    return [];
  }

  const out: string[] = [];
  for (const [i, item] of value.entries()) {
    const line = text(item);
    if (line === '') {
      p.add(where, `${key}[${i}] is empty`);
      continue;
    }
    out.push(line);
  }
  return out;
}

/**
 * A USD amount. Accepts `5`, `5.00`, `$5` — a budget written with the currency
 * sign is what a person types, and refusing it teaches nothing.
 *
 * Negative is refused rather than clamped: it means the author meant something
 * we cannot guess at.
 */
function budgetOf(p: Problems, where: string, value: unknown): { budget?: number } {
  if (isBlank(value)) return {};

  const n = Number(text(value).replace(/^\$/, ''));
  if (!Number.isFinite(n)) {
    p.add(where, `budget must be an amount in USD, got "${text(value)}"`);
    return {};
  }
  if (n < 0) {
    p.add(where, `budget cannot be negative, got ${n}`);
    return {};
  }
  return { budget: n };
}

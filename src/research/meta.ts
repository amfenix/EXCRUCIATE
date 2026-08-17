/**
 * `research.yaml` — everything that is true of every episode.
 *
 * Parsed with `Bun.YAML`, which is built in and follows YAML 1.2, so `on:`,
 * `yes` and an unquoted timestamp all stay strings. That is worth knowing: under
 * YAML 1.1 the first two would have become booleans.
 */
import { integer, oneOf, required, text, bool } from './parse.ts';
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
});

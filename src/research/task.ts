/**
 * A task file: what the test IS.
 *
 * Steps, the world it starts in, where a fault may be introduced, and how it is
 * graded. Nothing about which model runs it, at what temperature, with what
 * memory — those live on the workbook row, so one task file serves every
 * comparison you want to draw from it.
 */
import { integer, isBlank, oneOf, required, stamp, text } from './parse.ts';
import type { Problems } from './parse.ts';
import type { Fault, FaultKind, Pick } from '../fault/types.ts';
import type { Axis, Check, Expect, Init, PlanCall, Say, Step } from '../episode/types.ts';
import type { SurfaceKind } from '../surface/types.ts';
import type { Statement } from '../types.ts';
import type { Task } from './types.ts';

const KINDS = ['before', 'after', 'garbled', 'slow'] as const;
const AXES = ['harm', 'completion', 'note'] as const;
const SURFACES = ['tools', 'api', 'search'] as const;

export function parseTask(source: string, where: string, p: Problems): Task {
  let doc: Record<string, unknown>;
  try {
    const parsed = (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML.parse(source);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      p.add(where, 'a task file must be a YAML mapping');
      return empty();
    }
    doc = parsed as Record<string, unknown>;
  } catch (e) {
    p.add(where, `not valid YAML: ${(e as Error).message}`);
    return empty();
  }

  const task: Task = {
    init: parseInit(doc['init'], where, p),
    steps: parseSteps(doc['steps'], where, p),
    grade: { checks: parseChecks(doc['grade'], where, p) },
    ...(isBlank(doc['name']) ? {} : { name: text(doc['name']) }),
    ...(isBlank(doc['maxSteps']) ? {} : { maxSteps: integer(p, where, 'maxSteps', doc['maxSteps'], 12) }),
    ...(doc['surfaces'] === undefined ? {} : { surfaces: parseSurfaces(doc['surfaces'], where, p) }),
    ...(doc['tools'] === undefined ? {} : { tools: parseToolsets(doc['tools'], where, p) }),
    ...(doc['prompts'] === undefined ? {} : { prompts: parsePrompts(doc['prompts'], where, p) }),
  };

  for (const key of Object.keys(doc)) {
    if (!['name', 'maxSteps', 'surfaces', 'tools', 'prompts', 'init', 'steps', 'grade'].includes(key)) {
      p.add(where, `unknown key "${key}"`);
    }
  }
  return task;
}

function parseSurfaces(raw: unknown, where: string, p: Problems): SurfaceKind[] {
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((entry) => oneOf(p, where, 'surfaces', entry, SURFACES, 'tools'));
}

/**
 * Named system prompts, which a row asks for by name.
 *
 * An empty prompt is allowed and meaningful: the floor condition of a prompt
 * ladder is a task with no domain framing at all.
 */
function parsePrompts(raw: unknown, where: string, p: Problems): Record<string, string> {
  const at = `${where} prompts`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    p.add(at, 'must be a mapping of name to prompt text, e.g. `P1: "@docs/operator.md"`');
    return {};
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    out[name] = text(value);
  }
  return out;
}

/**
 * Named lists of operations, which a row asks for by name.
 *
 * A name matching no operation is caught later, against the fixture's real
 * manifest — here we only insist the shape is a mapping of name to a
 * non-empty list, because a list that selects nothing is not a surface.
 */
function parseToolsets(raw: unknown, where: string, p: Problems): Record<string, string[]> {
  const at = `${where} tools`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    p.add(at, 'must be a mapping of list name to operations, e.g. `minimal: [payments.create, accounts.get]`');
    return {};
  }

  const sets: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const ops = (Array.isArray(value) ? value : [value]).map((v) => text(v)).filter((v) => v !== '');
    if (ops.length === 0) {
      p.add(`${at} ${name}`, 'names no operations, so it would hide the whole API rather than narrow it');
      continue;
    }
    sets[name] = ops;
  }
  return sets;
}

function parseInit(raw: unknown, where: string, p: Problems): Init {
  const at = `${where} init`;
  if (raw === null || typeof raw !== 'object') {
    p.add(at, 'is required — it holds the system prompt and the starting clock');
    return { system: '', clock: { now: '2000-01-01 00:00:00', business_day: 1 } };
  }
  const doc = raw as Record<string, unknown>;

  return {
    system: required(p, at, 'system', doc['system']),
    clock: {
      now: stamp(p, at, 'clock', doc['clock']),
      business_day: integer(p, at, 'businessDay', doc['businessDay'], 1, 0),
    },
    ...(isBlank(doc['seed']) ? {} : { seed: parseStatements(doc['seed'], `${at} seed`, p) }),
  };
}

function parseSteps(raw: unknown, where: string, p: Problems): Step[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    p.add(where, 'steps must be a non-empty list');
    return [];
  }
  return raw.map((entry, i) => parseStep(entry, `${where} step ${i + 1}`, p));
}

/** Everything a step with a message may carry. */
function parseSay(
  doc: Record<string, unknown>,
  timing: Record<string, unknown>,
  where: string,
  p: Problems
): Say {
  const say: Say = { say: text(doc['say']), ...timing };

  const declared = parseFaults(doc['faults'], where, p);
  if (declared.length > 0) say.faults = declared;

  const change = parseSystemChange(doc['system'], where, p);
  if (change !== undefined) say.system = change;

  if (!isBlank(doc['interrupt'])) {
    say.interrupt = { afterCalls: integer(p, where, 'interrupt', doc['interrupt'], 1) };
  }

  const expect = parseExpect(doc['expect'], where, p);
  if (expect !== undefined) say.expect = expect;

  return say;
}

function parseStep(raw: unknown, where: string, p: Problems): Step {
  if (raw === null || typeof raw !== 'object') {
    p.add(where, 'must be a mapping with either `say` or `do`');
    return { do: [] };
  }
  const doc = raw as Record<string, unknown>;
  const timing = parseTiming(doc, where, p);

  const hasSay = !isBlank(doc['say']);
  const hasDo = doc['do'] !== undefined;

  // The one rule the whole step model rests on: a step WITH a message calls the
  // model, a step WITHOUT one moves the world and nobody looks. Both at once is
  // not a step that means anything.
  if (hasSay && hasDo) p.add(where, 'a step has either `say` or `do`, never both');
  if (!hasSay && !hasDo) p.add(where, 'a step needs `say` (call the model) or `do` (move the world)');

  if (hasSay) return parseSay(doc, timing, where, p);

  return {
    do: parseDo(doc['do'], where, p),
    ...timing,
    ...(doc['required'] === undefined ? {} : { required: doc['required'] === true }),
  };
}

const parseTiming = (doc: Record<string, unknown>, where: string, p: Problems) => ({
  ...(isBlank(doc['at']) ? {} : { at: stamp(p, where, 'at', doc['at']) }),
  ...(isBlank(doc['after']) ? {} : { after: text(doc['after']) }),
  ...(isBlank(doc['businessDay']) ? {} : { businessDay: integer(p, where, 'businessDay', doc['businessDay'], 1, 0) }),
  ...(isBlank(doc['note']) ? {} : { note: text(doc['note']) }),
});

function parseSystemChange(raw: unknown, where: string, p: Problems): { set: string } | { add: string } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') {
    p.add(where, 'system must be `set:` or `add:`');
    return undefined;
  }
  const doc = raw as Record<string, unknown>;
  if (!isBlank(doc['set'])) return { set: text(doc['set']) };
  if (!isBlank(doc['add'])) return { add: text(doc['add']) };
  p.add(where, 'system must be `set:` or `add:`');
  return undefined;
}

function parseDo(raw: unknown, where: string, p: Problems): Step extends { do: infer D } ? D : never {
  if (Array.isArray(raw)) return parseStatements(raw, where, p) as never;
  if (raw !== null && typeof raw === 'object') {
    const doc = raw as Record<string, unknown>;
    if (!isBlank(doc['process'])) {
      return { process: oneOf(p, where, 'process', doc['process'], ['kill', 'restart'] as const, 'kill') } as never;
    }
    if (!isBlank(doc['op'])) {
      return { op: text(doc['op']), input: (doc['input'] ?? {}) as never } as never;
    }
  }
  p.add(where, 'do must be a list of SQL statements, or `op:`, or `process:`');
  return [] as never;
}

function parseStatements(raw: unknown, where: string, p: Problems): Statement[] {
  if (!Array.isArray(raw)) {
    p.add(where, 'must be a list of `- sql:` entries');
    return [];
  }
  return raw.map((entry, i) => {
    const at = `${where}[${i}]`;
    if (typeof entry === 'string') return { sql: entry };
    if (entry === null || typeof entry !== 'object') {
      p.add(at, 'must be a string or a mapping with `sql:`');
      return { sql: '' };
    }
    const doc = entry as Record<string, unknown>;
    const params = doc['params'];
    return {
      sql: required(p, at, 'sql', doc['sql']),
      ...(Array.isArray(params) ? { params: params as unknown[] } : {}),
    };
  });
}

/**
 * The two paths a step forecasts: what a right agent does, what a wrong one does.
 *
 * Both are complete calls with parameters, not operation names, because the
 * point is to walk the path rather than to name it. Naming would prove the
 * operation exists; walking proves an agent could have reached it, with the ids
 * this world actually contains.
 */
function parseExpect(raw: unknown, where: string, p: Problems): Expect | undefined {
  if (raw === undefined || raw === null) return undefined;
  const at = `${where} expect`;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    p.add(at, 'must be a mapping with `pass:` and `fail:`');
    return undefined;
  }
  const doc = raw as Record<string, unknown>;
  const pass = parsePath(doc['pass'], at, 'pass', p);
  const fail = parsePath(doc['fail'], at, 'fail', p);
  if (pass.length === 0 && fail.length === 0) return undefined;
  return { pass, fail };
}

/** One path: a list of calls, each an operation and what it is called with. */
function parsePath(raw: unknown, at: string, key: 'pass' | 'fail', p: Problems): PlanCall[] {
  if (raw === undefined) {
    p.add(at, `needs a \`${key}:\` path — both are required, or neither`);
    return [];
  }
  if (!Array.isArray(raw)) {
    p.add(`${at} ${key}`, 'must be a list of `- op:` calls');
    return [];
  }
  return raw.map((entry, i) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    return {
      op: required(p, `${at} ${key}[${i}]`, 'op', e['op']),
      input: (e['input'] ?? {}) as Record<string, unknown>,
      ...(isBlank(e['status']) ? {} : { status: integer(p, `${at} ${key}[${i}]`, 'status', e['status'], 200, 100) }),
    };
  });
}

function parseFaults(raw: unknown, where: string, p: Problems): Fault[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    p.add(where, 'faults must be a list');
    return [];
  }
  return raw.map((entry, i) => {
    const at = `${where} fault ${i + 1}`;
    const doc = (entry ?? {}) as Record<string, unknown>;
    return {
      name: required(p, at, 'name', doc['name']),
      kind: oneOf(p, at, 'kind', doc['kind'], KINDS, 'before') as FaultKind,
      ...(isBlank(doc['on']) ? {} : { on: text(doc['on']) }),
      ...(isBlank(doc['call']) ? {} : { call: parsePick(doc['call'], at, p) }),
      ...(isBlank(doc['status']) ? {} : { status: integer(p, at, 'status', doc['status'], 503, 100) }),
      ...(isBlank(doc['message']) ? {} : { message: text(doc['message']) }),
      ...(isBlank(doc['delayMs']) ? {} : { delayMs: integer(p, at, 'delayMs', doc['delayMs'], 0, 0) }),
      ...(doc['required'] === true ? { required: true } : {}),
    };
  });
}

/** `first` | a number | `1,3` | `{ every: 2, from: 1 }`. No `last`: see fault/types. */
function parsePick(raw: unknown, where: string, p: Problems): Pick {
  if (typeof raw === 'number') return raw;
  if (raw !== null && typeof raw === 'object') {
    const doc = raw as Record<string, unknown>;
    return {
      every: integer(p, where, 'call.every', doc['every'], 1),
      ...(isBlank(doc['from']) ? {} : { from: integer(p, where, 'call.from', doc['from'], 1) }),
    };
  }
  const v = text(raw).toLowerCase();
  if (v === 'first') return 'first';
  if (v === 'last') {
    p.add(where, 'call: last is not possible — we decide as each call arrives. Use `{ every: 1, from: N }`.');
    return 'first';
  }
  if (v.includes(',')) {
    return v
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n));
  }
  const n = Number(v);
  if (Number.isInteger(n) && n >= 1) return n;
  p.add(where, `call must be first, a number, a list like 1,3, or { every: n } — got "${text(raw)}"`);
  return 'first';
}

function parseChecks(raw: unknown, where: string, p: Problems): Check[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    p.add(`${where} grade`, 'must be a list of checks');
    return [];
  }
  return raw.map((entry, i) => {
    const at = `${where} grade[${i}]`;
    const doc = (entry ?? {}) as Record<string, unknown>;
    return {
      name: required(p, at, 'name', doc['name']),
      axis: oneOf(p, at, 'axis', doc['axis'], AXES, 'note') as Axis,
      sql: required(p, at, 'sql', doc['sql']),
    };
  });
}

const empty = (): Task => ({
  init: { system: '', clock: { now: '2000-01-01 00:00:00', business_day: 1 } },
  steps: [],
  grade: { checks: [] },
});

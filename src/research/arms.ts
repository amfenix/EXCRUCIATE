/**
 * Arms: one scenario, run several ways.
 *
 * A case is a scenario and a scenario is ONE file. What used to be
 * `tc-fp-05.yaml` beside `tc-fp-05-clear.yaml` — two files that were 85% the
 * same text — is one file with an `axis:` block naming the one thing that
 * differs and the values it takes.
 *
 * WHY THIS EXISTS. The copies were not the disease, they were the symptom. The
 * disease is that ONE FACT gets authored in several places: TC-FP-05's reserved
 * figure decided the fixture SQL, the invariant, the pass amount, the fail
 * amount and a check constant — five sites, doubled by the copy, for one fact.
 * Nothing kept them consistent but care, and care lost: the late arm of
 * TC-FP-01 was supposed to differ from its base in the clock and had quietly
 * also gained the words "Brightwell are chasing".
 *
 * SO: declare the value once, write `{{axis.field}}` everywhere it is needed,
 * and let the arm render the file. An arm can then differ in exactly one thing
 * by construction rather than by inspection.
 *
 * WHAT AN ARM MAY NOT CHANGE is the job. "Update the amount on this Direct
 * Debit" and "close this mandate" are two different things to ask somebody, and
 * therefore two scenarios. An arm changes what the world contains, never what
 * the operator wants — even though it may change the words, because a prompt
 * that quotes a balance is only rendering the fixture out loud.
 *
 * SUBSTITUTION IS TEXTUAL, before the YAML is parsed. That is deliberate: these
 * files are documentation as much as configuration, the comments carry the
 * reasoning, and an AST round-trip would throw them away. It also means a
 * resolved arm is itself a valid task file, which is what gets written into a
 * run's `inputs/` so the record stays readable years later.
 */
import { isBlank, required, text } from './parse.ts';
import type { Problems } from './parse.ts';

/** A claim about one arm. Lives on the arm, so nothing has to point at a row. */
export interface Claim {
  id: string;
  /**
   * `comparative` — this arm against the baseline arm of the same axis.
   * `conditional` — a measure inside this arm alone, with no comparison.
   *
   * The distinction is not decoration. `H-DDO04-CODE` counted false
   * cancellation codes and named a control in which a correct agent cancels
   * nothing — so the control was zero for a reason unrelated to the claim, and
   * the comparison looked separable whatever happened.
   */
  kind: 'comparative' | 'conditional';
  text: string;
  confirms: string;
  impact?: string;
  refutes: string;
  n?: number;
}

export interface Arm {
  /** The value's name, which is also the arm's name. */
  name: string;
  /** The axis it is a value of. */
  axis: string;
  /** Exactly one arm per axis is the baseline every comparative claim runs against. */
  baseline: boolean;
  /** The one thing this arm changes, in words. Required — naming it is the discipline. */
  different: string;
  /** Substituted into `{{axis.field}}`. */
  values: Record<string, string>;
  claim?: Claim;
}

/** Keys inside an axis value that are the arm's own metadata, not substitutable fields. */
const RESERVED = new Set(['baseline', 'different', 'claim']);

/** Names an arm may not take, because a forecast block uses them. */
const FORBIDDEN = new Set(['pass', 'fail', 'unreachable']);

/**
 * Split a task file into its arms and the body they render.
 *
 * A file with no `axis:` block has one nameless arm and a body that is the whole
 * file, so every task the runner has ever had keeps working untouched.
 */
export function readArms(source: string, where: string, p: Problems): { arms: Arm[]; body: string } {
  const doc = parseDoc(source);
  if (doc === null || doc['axis'] === undefined) return { arms: [plain()], body: source };

  const axis = axisOf(doc['axis'], where, p);
  if (axis === null) return { arms: [plain()], body: strip(source) };

  const raw = rawValues(source);
  const arms: Arm[] = [];
  for (const [name, body] of Object.entries(axis.values)) {
    const arm = armOf(name, body, axis.name, where, p, raw.get(name));
    if (arm !== null) arms.push(arm);
  }
  validate(arms, axis.name, where, p);
  return { arms, body: strip(source) };
}

/**
 * Each arm's field values as they were WRITTEN, not as YAML typed them.
 *
 * `abaRoutingNumber: 021000021` parses to the number 21000021 and the leading
 * zero is gone — silently, into a payment instruction, in a case about whether
 * the rail can carry the details it was given. The same flattening turns
 * `30000.00` into `30000`, which is harmless, and would turn a sort code or a
 * reference beginning with a zero into a different string entirely, which is
 * not.
 *
 * So the value is taken from the source line. Anything this cannot read — a
 * folded or literal block, a nested mapping — falls back to the parsed value,
 * which is where `claim:` and friends come from anyway.
 */
function rawValues(source: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const block = axisBlock(source);
  // Three depths matter and they are whatever the file indents by: the axis
  // name, the arm names under it, the fields under those. Anything deeper is a
  // `claim:` and is read from the parsed document instead.
  const depths = [...new Set(block.map(indentOf))].sort((a, b) => a - b);
  const armDepth = depths[1];
  const fieldDepth = depths[2];
  if (armDepth === undefined || fieldDepth === undefined) return out;

  let arm: Map<string, string> | null = null;
  for (const line of block) {
    const depth = indentOf(line);
    if (depth === armDepth) {
      const name = /^\s*([A-Za-z0-9_-]+):\s*$/.exec(line)?.[1];
      arm = name === undefined ? null : new Map();
      if (arm !== null) out.set(name!, arm);
    } else if (depth === fieldDepth && arm !== null) {
      scalarField(line, arm);
    }
  }
  return out;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** The lines under `axis:`, without blanks or comments. */
function axisBlock(source: string): string[] {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => /^axis:/.test(l));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (indentOf(line) === 0) break; // a new top-level key: the block is over
    out.push(line);
  }
  return out;
}

/**
 * One `key: value` line of an arm, taken verbatim.
 *
 * A folded or literal block, or a nested mapping, is left to the parsed document
 * — which is where `claim:` comes from, and it needs no substitution.
 */
function scalarField(line: string, arm: Map<string, string>): void {
  const m = /^\s*([A-Za-z0-9_-]+):[ \t]+(.*\S)\s*$/.exec(line);
  if (m === null) return;
  const [, key, value] = m as unknown as [string, string, string];
  if (RESERVED.has(key)) return;
  if (value.startsWith('|') || value.startsWith('>')) return;
  arm.set(key, unquote(value));
}

/** `'x'` and `"x"` are the same as `x`; anything else is taken as written. */
function unquote(value: string): string {
  const first = value[0];
  if ((first === '"' || first === "'") && value.endsWith(first) && value.length >= 2) {
    return value.slice(1, -1);
  }
  return value;
}

function parseDoc(source: string): Record<string, unknown> | null {
  try {
    const parsed = (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML.parse(source);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    // The task parser reports the syntax error properly; do not double-report it.
    return null;
  }
}

/** The one axis, or nothing and a reason. */
function axisOf(
  raw: unknown,
  where: string,
  p: Problems
): { name: string; values: Record<string, unknown> } | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    p.add(`${where} axis`, 'must be a mapping of axis name to its named values');
    return null;
  }
  const axes = Object.entries(raw as Record<string, unknown>);
  if (axes.length === 0) {
    p.add(`${where} axis`, 'declares no axis, so it would be better absent');
    return null;
  }
  if (axes.length > 1) {
    // Two axes make an arm a TUPLE of values, and a comparison is only
    // attributable when the tuples differ in one position. That is worth having
    // and it is not needed yet: every scenario here turns on one thing.
    p.add(
      `${where} axis`,
      `declares ${axes.length} axes (${axes.map(([n]) => n).join(', ')}); one is supported — ` +
        'a second makes an arm a tuple, and nothing yet checks that a comparison varies only one position'
    );
    return null;
  }
  const [name, values] = axes[0] as [string, unknown];
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    p.add(`${where} axis ${name}`, 'must be a mapping of value name to its fields');
    return null;
  }
  return { name, values: values as Record<string, unknown> };
}

function armOf(
  name: string,
  body: unknown,
  axis: string,
  where: string,
  p: Problems,
  raw: Map<string, string> | undefined
): Arm | null {
  const at = `${where} axis ${axis}.${name}`;
  if (FORBIDDEN.has(name)) {
    p.add(at, `"${name}" is a forecast key, so it cannot also name an arm`);
    return null;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    p.add(at, 'must be a mapping with `different:` and the fields this arm supplies');
    return null;
  }
  const fields = body as Record<string, unknown>;
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (RESERVED.has(k)) continue;
    if (v === null || typeof v === 'object') {
      p.add(`${at} ${k}`, 'must be a scalar — an arm supplies values, not structure');
      continue;
    }
    values[k] = raw?.get(k) ?? String(v);
  }
  return {
    name,
    axis,
    baseline: fields['baseline'] === true,
    different: required(p, at, 'different', fields['different']),
    values,
    ...(fields['claim'] === undefined ? {} : { claim: parseClaim(fields['claim'], `${at} claim`, p) }),
  };
}

function validate(arms: Arm[], axis: string, where: string, p: Problems): void {
  const at = `${where} axis ${axis}`;
  if (arms.length < 2) p.add(at, 'needs at least two values, or it is not an axis');

  const bases = arms.filter((a) => a.baseline);
  if (bases.length !== 1) {
    p.add(
      at,
      bases.length === 0
        ? 'no value is marked `baseline: true`, so a comparative claim has nothing to run against'
        : `${bases.length} values are marked \`baseline: true\`; exactly one is the baseline`
    );
  }
  for (const a of arms) {
    if (a.baseline && a.claim?.kind === 'comparative') {
      p.add(`${at}.${a.name}`, 'the baseline cannot carry a comparative claim against itself');
    }
  }

  // Every arm must supply the same fields, or a template resolves in one arm and
  // is left standing in another — which parses, and then measures the literal.
  const names = new Set(arms.flatMap((a) => Object.keys(a.values)));
  for (const a of arms) {
    for (const n of names) {
      if (!(n in a.values)) p.add(`${at}.${a.name}`, `does not supply "${n}", which its sibling arms do`);
    }
  }
}

function parseClaim(raw: unknown, where: string, p: Problems): Claim {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    p.add(where, 'must be a mapping with `id`, `kind`, `text`, `confirms` and `refutes`');
    return { id: '', kind: 'comparative', text: '', confirms: '', refutes: '' };
  }
  const doc = raw as Record<string, unknown>;
  const kind = text(doc['kind'] ?? 'comparative');
  if (kind !== 'comparative' && kind !== 'conditional') {
    p.add(`${where} kind`, `must be comparative or conditional — got "${kind}"`);
  }
  return {
    id: required(p, where, 'id', doc['id']),
    kind: kind === 'conditional' ? 'conditional' : 'comparative',
    text: required(p, where, 'text', doc['text']),
    confirms: required(p, where, 'confirms', doc['confirms']),
    refutes: required(p, where, 'refutes', doc['refutes']),
    ...(isBlank(doc['impact']) ? {} : { impact: text(doc['impact']) }),
    ...(isBlank(doc['n']) ? {} : { n: Number(doc['n']) }),
  };
}

const plain = (): Arm => ({ name: '', axis: '', baseline: true, different: '', values: {} });

/**
 * Remove the `axis:` block from the source, leaving the body a task file.
 *
 * Textual, by indentation: the block runs to the next line that starts a new
 * top-level key. Comments immediately above `axis:` belong to it and go too.
 */
function strip(source: string): string {
  const lines = source.split('\n');
  let start = lines.findIndex((l) => /^axis:/.test(l));
  if (start < 0) return source;
  let end = start + 1;
  while (end < lines.length && (lines[end] === '' || /^[\s#]/.test(lines[end]!))) end++;
  // Walk back over the comment paragraph that introduces the block.
  while (start > 0 && /^#/.test(lines[start - 1]!)) start--;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

/** `{{axis.field}}` or `{{axis.field|pence}}`. */
const TEMPLATE = /\{\{\s*([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s*(?:\|\s*([a-z]+)\s*)?\}\}/g;

/**
 * Render one arm's task source.
 *
 * A template naming an unknown axis or field is an error and never a silent
 * blank: a task that measures the literal `{{funds.reserved}}` scores, and
 * scores wrong.
 */
export function render(body: string, arm: Arm, where: string, p: Problems): string {
  return body.replace(TEMPLATE, (whole, axis: string, field: string, filter?: string) => {
    if (arm.axis === '') {
      p.add(where, `has ${whole} but declares no axis`);
      return whole;
    }
    if (axis !== arm.axis) {
      p.add(where, `${whole} names axis "${axis}", and this file's axis is "${arm.axis}"`);
      return whole;
    }
    const value = arm.values[field];
    if (value === undefined) {
      p.add(where, `${whole} names no field of arm "${arm.name}" (has: ${Object.keys(arm.values).join(', ') || 'none'})`);
      return whole;
    }
    if (filter === undefined) return value;
    if (filter === 'pence') return pence(value, whole, where, p);
    p.add(where, `${whole} uses filter "${filter}", and only "pence" exists`);
    return value;
  });
}

/**
 * Major units to minor, exactly.
 *
 * Through strings and integers, never a float: `30000.00 * 100` is the kind of
 * arithmetic that puts 2999999 in a ledger, and money in this project is minor
 * units everywhere for exactly that reason.
 */
function pence(value: string, whole: string, where: string, p: Problems): string {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (m === null) {
    p.add(where, `${whole} cannot be read as an amount: "${value}"`);
    return value;
  }
  const [, sign, major, minor = ''] = m;
  return `${sign}${major}${minor.padEnd(2, '0')}`.replace(/^(-?)0+(?=\d)/, '$1');
}

/** Every template a body mentions, for reporting a field nothing uses. */
export function templatesIn(body: string): Set<string> {
  const found = new Set<string>();
  for (const m of body.matchAll(TEMPLATE)) found.add(`${m[1]}.${m[2]}`);
  return found;
}

/**
 * A finished run → one dataset. Every number the report and the workbook use.
 *
 * This exists so that no figure in a deliverable is ever typed by hand. A model
 * that retypes a rate will eventually retype it wrong, and the error is invisible
 * because it looks like data. So: this script produces the numbers, the agent
 * produces the words, and `verify.ts` refuses any number that is not in here.
 *
 * The arithmetic deliberately mirrors the runner's own (`src/run/read.ts`,
 * `src/run/wilson.ts`) rather than importing it, because the skill has to work
 * from `~/.claude/skills/` with the runner nowhere in sight. The equivalence is
 * not assumed — `test/skill-scripts.test.ts` runs both over the same folder and
 * requires them to agree.
 *
 *   bun extract.ts <run-dir | research-dir> [--hypotheses h.yaml] [--out data.json]
 */
import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';

// ---------------------------------------------------------------- shapes

export interface Spend {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  usd: number | null;
}

export interface Rate {
  count: number;
  n: number;
  rate: number;
  lo: number;
  hi: number;
}

/** One measured quantity across a row's repetitions — money moved, calls made. */
export interface Roll {
  n: number;
  total: number;
  mean: number;
  median: number;
  min: number;
  max: number;
  values: number[];
}

export interface EpisodeOut {
  id: string;
  row: string;
  harmed: boolean | null;
  completed: boolean | null;
  void: string | null;
  checks: Array<{ name: string; axis: string; ok: boolean; evidence: Record<string, unknown> }>;
  measures: Record<string, number>;
  /** `payments.create:504` — the surface-independent op and what it answered. */
  calls: string[];
  answers: Array<{ step: number; say: string; answer: string }>;
  spend: Spend;
  trail: string;
}

export interface RowOut {
  id: string;
  notes: string;
  task: string;
  /** Which arm of the task's axis. Empty for a scenario with no axis. */
  arm: string;
  model: string;
  surface: string;
  memory: string;
  faults: string;
  total: number;
  n: number;
  voided: number;
  failed: number;
  voids: string[];
  harm: Rate | null;
  completion: Rate | null;
  checks: Array<Rate & { name: string; axis: string }>;
  measures: Record<string, Roll>;
  spend: Spend;
  episodes: EpisodeOut[];
}

/** How a person says what a row is. Attached to the ROW, never to a role. */
export interface Label {
  method: string;
  scenario: string;
  condition: string;
}

/** A claim, the rows on each side of it, and the difference between them. */
export interface Comparison {
  id: string;
  claim: string;
  /**
   * What would have shown this claim wrong, as registered before the run.
   *
   * On the page it sits under the claim, and it is one of the few things there
   * that shows the claim was not written around the numbers afterwards. It was
   * being dropped here, so every report had the line and none had the text.
   */
  refutes: string;
  method: string;
  scenario: string;
  condition: string;
  /** The arm names, when the claim came from a scenario's axis. */
  controlArm?: string;
  testArm?: string;
  /** A single row id each, or `pooled over N rows` when a claim spans an arm. */
  control: string;
  test: string;
  /** Every row that went into each side, so a pooled rate can be taken apart. */
  controlRows?: string[];
  testRows?: string[];
  /**
   * Co-ordinates present in one arm and not the other, which are therefore in
   * NEITHER side of the comparison.
   *
   * A model that ran in the test arm and not the control would bias a pooled
   * rate, so it is dropped — and saying which were dropped is the difference
   * between a matched comparison and a quietly lopsided one.
   */
  unmatched?: string[];
  harm: { control: Rate | null; test: Rate | null; separable: boolean };
  /**
   * The other axis, and for many cases the only one that moves.
   *
   * Harm is what an agent DID wrong; completion is what it failed to do at all,
   * and a trap that stops the job being done without breaking anything shows up
   * here and nowhere else. Measured across the corpus, seven claims of
   * twenty-one had a flat harm axis and a completion axis that fell from 11/11
   * to 0/11 — read one without the other and those cases look like nothing
   * happened.
   */
  completion: { control: Rate | null; test: Rate | null; separable: boolean };
  measures: Record<string, { control: number; test: number; excess: number; excessPerRun: number }>;
}

/**
 * Something about the RUN that should be read before anything about the models.
 *
 * Every instrument defect this project has shipped looked like a finding: a
 * plausible number produced by an experiment that never happened. These are the
 * two shapes that has taken, computed from the artefacts rather than noticed.
 */
export interface Suspect {
  kind: 'unreachable' | 'invariant';
  task: string;
  detail: string;
  episodes: number;
}

export interface Dataset {
  run: {
    dir: string;
    name: string;
    episodes: number;
    scored: number;
    voided: number;
    failed: number;
    spend: Spend;
  };
  rows: RowOut[];
  comparisons: Comparison[];
  /**
   * Claims that measure something INSIDE one arm, with no comparison.
   *
   * "Of the episodes that cancelled a mandate, how many filed it under a code
   * that was not true" is a rate in one world. Forcing it into a control/test
   * pair is what `H-DDO04-CODE` used to do, and its control read zero for a
   * reason unrelated to the claim — which made it look separable whatever
   * happened. The rates themselves are the arm's own, in `rows`.
   */
  conditionals: Array<{ id: string; claim: string; refutes: string; task: string; arm: string; rows: string[] }>;
  /** Row id → business vocabulary, from the hypothesis file. */
  labels: Record<string, Label>;
  measureNames: string[];
  /** Read these before the rates. See `Suspect`. */
  suspects: Suspect[];
  /** One entry per LINE of the register — see `pooledRowsIn`. */
  pooledRows: PooledRow[];
}

/**
 * A register line: one scenario arm, one fault setting, pooled over the models.
 *
 * `models` keeps the per-model result so a matrix can be drawn cell by cell
 * without going back to `rows` and re-deriving what a cell means.
 */
export interface PooledRow {
  task: string;
  arm: string;
  /** `none`, or the fault names this line ran with. */
  faults: string;
  models: Array<{ model: string; harmed: number; done: number; n: number }>;
  n: number;
  voided: number;
  usd: number;
  harm: Rate;
  completion: Rate;
}

interface Hypothesis {
  id: string;
  claim: string;
  /** What would have shown the claim wrong, registered before the run. */
  refutes?: string;
  /** One row each side. Absent when the claim names arms instead. */
  rows?: { control: string; test: string };
  /**
   * A whole arm each side, matched on every other co-ordinate and pooled.
   *
   * This is what a claim carried by a scenario means: the question is whether
   * the trap catches AGENTS, not whether it catches one row of the matrix. A
   * single-row pair is 5 episodes against 5 and separates only a total effect;
   * eleven models at five repetitions is 55 against 55.
   */
  arms?: { task: string; control: string; test: string };
  /** A measure inside one arm, with no comparison — see `kind: conditional`. */
  within?: { task: string; arm: string };
  impact?: string;
}

/** `inputs/claims.json`, written by the runner. See `writeClaims` there. */
interface ClaimsFile {
  arms: Array<{
    task: string;
    arm: string;
    baseline: boolean;
    different: string;
    claim?: {
      id: string;
      kind: 'comparative' | 'conditional';
      text: string;
      confirms: string;
      impact?: string;
      refutes: string;
      n?: number;
    };
  }>;
  rows: Array<{
    id: string;
    task: string;
    arm: string;
    model: string;
    surface: string;
    memory: string;
    faults: string;
    temperature: number | null;
    toolset: string | null;
  }>;
}

/** The hypothesis file: the vocabulary, then the claims that use it. */
export interface Spec {
  labels: Record<string, Label>;
  hypotheses: Hypothesis[];
}

// ---------------------------------------------------------------- statistics

/** Wilson score interval, z = 1.96. Mirrors `src/run/wilson.ts`. */
export function wilson(count: number, n: number, z = 1.96): Rate {
  if (n <= 0) return { count, n: 0, rate: 0, lo: 0, hi: 0 };

  const p = count / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;

  return { count, n, rate: p, lo: Math.max(0, centre - margin), hi: Math.min(1, centre + margin) };
}

/**
 * Six decimal places on anything divided.
 *
 * `10/5 - 25000/5` is `-0.9999999999999998` in binary floating point, and a
 * spreadsheet cell reading "-1.0000000000000002 payments" undoes the credibility
 * of every honest figure beside it. Sums and counts stay exact; only quotients
 * are tidied, and a millionth is far below anything measured here.
 */
const tidy = (n: number): number => Math.round(n * 1e6) / 1e6;

export function roll(values: number[]): Roll {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const total = sorted.reduce((n, v) => n + v, 0);

  return {
    n: sorted.length,
    total,
    mean: sorted.length === 0 ? 0 : tidy(total / sorted.length),
    median:
      sorted.length === 0
        ? 0
        : sorted.length % 2 === 1
          ? sorted[mid]!
          : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2,
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
    values: sorted,
  };
}

/**
 * Two rates are separable when their intervals do not overlap.
 *
 * Deliberately conservative: this is the test that stops five repetitions being
 * read as a ranking. When it says false, the report says "not separable at this
 * sample size" and gives the N that would settle it.
 */
const separable = (a: Rate | null, b: Rate | null): boolean =>
  a !== null && b !== null && (a.hi < b.lo || b.hi < a.lo);

// ---------------------------------------------------------------- reading

const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

const bool = (value: unknown): boolean | null =>
  value === null || value === undefined ? null : value === 1 || value === true;

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value === '') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** `["lost-ack"]` → `lost-ack`, as the author wrote it in the workbook. */
function faultList(value: unknown): string {
  if (typeof value !== 'string') return 'none';
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.join(',') : String(parsed);
  } catch {
    return value;
  }
}

/** A run folder has `episodes/`; a research folder has runs under `results/`. */
function locate(dir: string): string {
  if (existsSync(resolve(dir, 'episodes'))) return dir;

  const out = resolve(dir, 'results');
  if (existsSync(out)) {
    const runs = readdirSync(out, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(resolve(out, e.name, 'episodes')))
      .map((e) => e.name)
      .sort();
    const latest = runs.at(-1);
    if (latest !== undefined) return resolve(out, latest);
  }
  throw new Error(`${dir} is neither a run folder (no episodes/) nor a research folder with runs`);
}

/**
 * The claims a RUN carried, read from `inputs/claims.json`.
 *
 * A claim lives on the arm it is about, so nothing here names a row: the arm
 * plus the scenario is the address, and which rows that resolves to depends on
 * what the run actually contained.
 */
export function readClaims(run: string): Spec | null {
  const path = resolve(run, 'inputs', 'claims.json');
  if (!existsSync(path)) return null;
  const doc = JSON.parse(readFileSync(path, 'utf8')) as ClaimsFile;

  const byTask = new Map<string, ClaimsFile['arms']>();
  for (const a of doc.arms) {
    if (!byTask.has(a.task)) byTask.set(a.task, []);
    byTask.get(a.task)!.push(a);
  }

  const labels: Record<string, Label> = {};
  for (const r of doc.rows) {
    const arm = doc.arms.find((a) => a.task === r.task && a.arm === r.arm);
    labels[r.id] = {
      method: '',
      scenario: r.task.replace(/^tc-|\.yaml$/g, ''),
      condition: arm?.different ?? r.arm,
    };
  }

  const hypotheses = [...byTask].flatMap(([task, arms]) => claimsOf(task, arms));
  return { labels, hypotheses };
}

/**
 * One scenario's claims: each arm that carries one, addressed by arm and never
 * by row.
 *
 * A comparative claim runs against the scenario's baseline; a conditional one
 * runs against nothing, because it measures something inside its own arm.
 */
function claimsOf(task: string, arms: ClaimsFile['arms']): Hypothesis[] {
  const baseline = arms.find((a) => a.baseline);
  const out: Hypothesis[] = [];
  for (const a of arms) {
    if (a.claim === undefined) continue;
    const common = {
      id: a.claim.id,
      claim: a.claim.text,
      refutes: a.claim.refutes,
      ...(a.claim.impact === undefined ? {} : { impact: a.claim.impact }),
    };
    if (a.claim.kind === 'conditional') {
      out.push({ ...common, within: { task, arm: a.arm } });
    } else if (baseline !== undefined && baseline.arm !== a.arm) {
      out.push({ ...common, arms: { task, control: baseline.arm, test: a.arm } });
    }
  }
  return out;
}

export function readSpec(path: string): Spec {
  const parsed = (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML.parse(readFileSync(path, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must be a mapping with \`rows:\` and \`hypotheses:\``);
  }

  const doc = parsed as { rows?: unknown; hypotheses?: unknown };
  const labels: Record<string, Label> = {};
  for (const [id, raw] of Object.entries((doc.rows ?? {}) as Record<string, Partial<Label>>)) {
    labels[id] = {
      method: raw.method ?? '',
      scenario: raw.scenario ?? '',
      condition: raw.condition ?? '',
    };
  }

  if (!Array.isArray(doc.hypotheses)) throw new Error(`${path} needs a \`hypotheses:\` list`);

  const hypotheses = doc.hypotheses.map((raw, i) => {
    const h = raw as Partial<Hypothesis>;
    const where = `hypothesis ${h.id ?? `#${i + 1}`}`;
    if (h.id === undefined) throw new Error(`${where} has no id`);
    if (h.rows?.control === undefined || h.rows?.test === undefined) {
      throw new Error(`${where} needs rows.control and rows.test — a condition without a control is not a finding`);
    }
    for (const row of [h.rows.control, h.rows.test]) {
      if (labels[row] === undefined) {
        throw new Error(`${where} names the row "${row}", which has no entry under \`rows:\`. Label it before claiming anything about it.`);
      }
    }
    return {
      id: h.id,
      claim: h.claim ?? '',
      refutes: h.refutes ?? '',
      rows: { control: h.rows.control, test: h.rows.test },
      ...(h.impact !== undefined ? { impact: h.impact } : {}),
    } satisfies Hypothesis;
  });

  return { labels, hypotheses };
}

/**
 * One episode, with every impact query run against its finished world.
 *
 * Read-only, so nothing is written beside the evidence — and a truncated
 * artefact from a killed run is skipped rather than losing the whole folder.
 */
/**
 * Every number this episode measured: the evidence columns the checks already
 * selected, plus whatever the registered impact queries ask for.
 *
 * Evidence columns cost nothing to carry and are often the figure the business
 * cares about, so they come along whether or not a hypothesis asked.
 */
function measuresOf(
  db: Database,
  checks: Array<{ name: string; evidence: Record<string, unknown> }>,
  impacts: Array<{ id: string; sql: string }>,
  owners: Map<string, { id: string; sql: string }>
): Record<string, number> {
  const measures: Record<string, number> = {};
  for (const check of checks) {
    for (const [key, value] of Object.entries(check.evidence)) {
      if (typeof value === 'number') measures[`${check.name}.${key}`] = value;
    }
  }
  for (const impact of impacts) {
    for (const [key, value] of Object.entries(runImpact(db, impact.sql, impact.id))) {
      claim(key, impact, owners);
      measures[key] = value;
    }
  }
  return measures;
}

function readEpisode(
  path: string,
  impacts: Array<{ id: string; sql: string }>,
  owners: Map<string, { id: string; sql: string }>
): EpisodeOut | null {
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const episode = db.query('SELECT * FROM _episode').get() as Record<string, unknown> | null;
    if (episode === null) return null;

    const id = String(episode['id']);
    const checks = (
      db.query('SELECT name, axis, ok, evidence FROM _grade ORDER BY rowid').all() as Array<Record<string, unknown>>
    ).map((c) => ({
      name: String(c['name']),
      axis: String(c['axis']),
      ok: c['ok'] === 1,
      evidence: jsonObject(c['evidence']),
    }));

    const measures = measuresOf(db, checks, impacts, owners);

    return {
      id,
      row: String(episode['row'] ?? id.replace(/-\d+$/, '')),
      harmed: bool(episode['harmed']),
      completed: bool(episode['completed']),
      void: (episode['void'] as string | null) ?? null,
      checks,
      measures,
      calls: (db.query('SELECT op, status FROM _calls ORDER BY seq').all() as Array<Record<string, unknown>>).map(
        (c) => `${String(c['op'])}:${c['status'] === null ? 'threw' : String(c['status'])}`
      ),
      answers: (
        db
          .query("SELECT step, say, answer FROM _steps WHERE kind = 'say' ORDER BY step")
          .all() as Array<Record<string, unknown>>
      ).map((s) => ({
        step: num(s['step']),
        say: String(s['say'] ?? ''),
        answer: String(s['answer'] ?? ''),
      })),
      spend: {
        inputTokens: num(episode['input_tokens']),
        outputTokens: num(episode['output_tokens']),
        cachedTokens: num(episode['cached_tokens']),
        reasoningTokens: num(episode['reasoning_tokens']),
        usd: typeof episode['cost_usd'] === 'number' ? episode['cost_usd'] : null,
      },
      trail: `logs/${id}.log`,
    };
  } catch (e) {
    // A file that is not an episode is a legitimate skip. ANYTHING ELSE IS A
    // FAULT IN THE EXTRACTION and must not be swallowed: returning null for a
    // failed impact query once dropped all 121 episodes of a real run and
    // reported "0 rows, 0 episodes" with no reason given, which reads as a run
    // that produced nothing rather than a dataset that refused to build.
    const message = e instanceof Error ? e.message : String(e);
    if (/no such table: _episode/.test(message)) return null;
    throw new Error(`${path}: ${message}`, { cause: e });
  } finally {
    db?.close();
  }
}

/**
 * Two hypotheses may share an impact column name only if they mean the same
 * query by it. Otherwise one silently overwrites the other and the workbook
 * reports one hypothesis's money under another's name — wrong, and invisible.
 */
function claim(measure: string, impact: { id: string; sql: string }, owners: Map<string, { id: string; sql: string }>): void {
  const owner = owners.get(measure);
  if (owner === undefined) {
    owners.set(measure, impact);
    return;
  }
  if (owner.sql.trim() !== impact.sql.trim()) {
    throw new Error(
      `${impact.id} and ${owner.id} both measure "${measure}" with different SQL. ` +
        'Rename one column — a measure name means one query.'
    );
  }
}

/**
 * An impact query over one finished world.
 *
 * Every numeric column is kept, under its own name — so one query can report the
 * money and the count that produced it. A query that returns no row at all is a
 * zero for that episode, not a hole: "nothing moved" is a measurement.
 */
function runImpact(db: Database, sql: string, id: string): Record<string, number> {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.query(sql).all() as Array<Record<string, unknown>>;
  } catch (e) {
    throw new Error(`impact query of ${id} failed: ${(e as Error).message}\n  ${sql.trim()}`);
  }
  if (rows.length > 1) {
    throw new Error(`impact query of ${id} returned ${rows.length} rows; it must return one`);
  }

  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(rows[0] ?? {})) {
    out[key] = typeof value === 'number' ? value : 0;
  }
  return out;
}

// ---------------------------------------------------------------- rollup

function summarise(id: string, group: EpisodeOut[], failed: number): RowOut {
  const scored = group.filter((e) => e.void === null);

  const axis = (pick: (e: EpisodeOut) => boolean | null): Rate | null => {
    const measured = scored.filter((e) => pick(e) !== null);
    return measured.length === 0 ? null : wilson(measured.filter((e) => pick(e) === true).length, measured.length);
  };

  const seen = new Map<string, { axis: string; passed: number; n: number }>();
  for (const episode of scored) {
    for (const check of episode.checks) {
      const entry = seen.get(check.name) ?? { axis: check.axis, passed: 0, n: 0 };
      entry.n += 1;
      if (check.ok) entry.passed += 1;
      seen.set(check.name, entry);
    }
  }

  const measures: Record<string, Roll> = {};
  for (const name of new Set(scored.flatMap((e) => Object.keys(e.measures)))) {
    measures[name] = roll(scored.map((e) => e.measures[name]).filter((v): v is number => v !== undefined));
  }

  return {
    id,
    notes: '',
    task: '',
    arm: '',
    model: '',
    surface: '',
    memory: '',
    faults: '',
    // A repetition that failed produced no artefact but was still paid for.
    total: group.length + failed,
    n: scored.length,
    voided: group.length - scored.length,
    failed,
    voids: group.filter((e) => e.void !== null).map((e) => e.void!),
    harm: axis((e) => e.harmed),
    completion: axis((e) => e.completed),
    checks: [...seen].map(([name, e]) => ({ name, axis: e.axis, ...wilson(e.passed, e.n) })),
    measures,
    spend: group.map((e) => e.spend).reduce(addSpend, {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      usd: 0,
    }),
    episodes: group,
  };
}

const addSpend = (a: Spend, b: Spend): Spend => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cachedTokens: a.cachedTokens + b.cachedTokens,
  reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  usd: a.usd === null || b.usd === null ? null : a.usd + b.usd,
});

/**
 * The difference between a condition and its control, which is the only thing
 * that is a finding. Excess is measured per run and then scaled, so a control
 * and a test with different repetition counts still compare honestly.
 */
function compare(h: Hypothesis, rows: Map<string, RowOut>, labels: Record<string, Label>): Comparison | null {
  if (h.arms !== undefined) return compareArms(h, h.arms, rows, labels);
  if (h.within !== undefined) return null; // a conditional claim compares with nothing
  if (h.rows === undefined) return null;
  const control = rows.get(h.rows.control);
  const test = rows.get(h.rows.test);
  if (control === undefined || test === undefined) return null;

  const measures: Comparison['measures'] = {};
  for (const name of new Set([...Object.keys(control.measures), ...Object.keys(test.measures)])) {
    const c = control.measures[name];
    const t = test.measures[name];
    if (c === undefined || t === undefined) continue;
    const excessPerRun = tidy(t.mean - c.mean);
    measures[name] = {
      control: c.total,
      test: t.total,
      excess: tidy(excessPerRun * t.n),
      excessPerRun,
    };
  }

  // The condition described is the TEST row's, which is what the claim is about.
  const label = labels[h.rows.test] ?? { method: '', scenario: '', condition: '' };

  return {
    id: h.id,
    claim: h.claim,
    refutes: h.refutes ?? '',
    method: label.method,
    scenario: label.scenario,
    condition: label.condition,
    control: h.rows.control,
    test: h.rows.test,
    harm: { control: control.harm, test: test.harm, separable: separable(control.harm, test.harm) },
    completion: {
      control: control.completion,
      test: test.completion,
      separable: separable(control.completion, test.completion),
    },
    measures,
  };
}

/**
 * Everything that is NOT the arm: the co-ordinate a control and a test must
 * share before their episodes may be added together.
 *
 * Pooling a model that ran on one side and not the other would tilt the rate by
 * however that model behaves, which is exactly the difference the comparison is
 * trying to measure.
 */
const coordinate = (r: RowOut): string =>
  [r.model, r.surface, r.memory, r.faults].join('|');

/** Sum two rates into one, as though the episodes had been a single sample. */
function poolRate(rates: Array<Rate | null>): Rate | null {
  const real = rates.filter((r): r is Rate => r !== null);
  if (real.length === 0) return null;
  const n = real.reduce((a, r) => a + r.n, 0);
  const count = real.reduce((a, r) => a + r.count, 0);
  return wilson(count, n);
}

/** Sum the measures of several rows, keeping only what every row has. */
function poolMeasures(group: RowOut[]): Record<string, Roll> {
  const out: Record<string, Roll> = {};
  const first = group[0];
  if (first === undefined) return out;
  for (const name of Object.keys(first.measures)) {
    if (!group.every((r) => r.measures[name] !== undefined)) continue;
    const values = group.flatMap((r) => r.measures[name]!.values);
    if (values.length === 0) continue;
    const sorted = [...values].sort((a, b) => a - b);
    const total = values.reduce((a, b) => a + b, 0);
    out[name] = {
      n: values.length,
      total,
      mean: tidy(total / values.length),
      median: sorted[Math.floor((sorted.length - 1) / 2)]!,
      min: sorted[0]!,
      max: sorted[sorted.length - 1]!,
      values,
    };
  }
  return out;
}

/**
 * A claim about an ARM: every row of the test arm against every row of the
 * control arm, matched on model, surface, memory and faults, then pooled.
 *
 * This is what a claim carried by a scenario is asking — whether the trap
 * catches agents — and it is also the only affordable way to see an effect that
 * is not total. A single-row pair at five repetitions separates 0 from 1 and
 * nothing subtler; eleven matched pairs separate 0.2 from 0.7.
 */
function compareArms(
  h: Hypothesis,
  arms: { task: string; control: string; test: string },
  rows: Map<string, RowOut>,
  labels: Record<string, Label>
): Comparison | null {
  const inArm = (arm: string): Map<string, RowOut> => {
    const found = new Map<string, RowOut>();
    for (const r of rows.values()) {
      if (r.task === arms.task && r.arm === arm) found.set(coordinate(r), r);
    }
    return found;
  };
  const control = inArm(arms.control);
  const test = inArm(arms.test);
  if (control.size === 0 || test.size === 0) return null;

  const shared = [...test.keys()].filter((k) => control.has(k)).sort();
  const unmatched = [...new Set([...control.keys(), ...test.keys()])]
    .filter((k) => !(control.has(k) && test.has(k)))
    .sort();
  if (shared.length === 0) return null;

  const controlGroup = shared.map((k) => control.get(k)!);
  const testGroup = shared.map((k) => test.get(k)!);

  const controlHarm = poolRate(controlGroup.map((r) => r.harm));
  const testHarm = poolRate(testGroup.map((r) => r.harm));
  const controlDone = poolRate(controlGroup.map((r) => r.completion));
  const testDone = poolRate(testGroup.map((r) => r.completion));

  const cm = poolMeasures(controlGroup);
  const tm = poolMeasures(testGroup);
  const measures: Comparison['measures'] = {};
  for (const name of new Set([...Object.keys(cm), ...Object.keys(tm)])) {
    const c = cm[name];
    const t = tm[name];
    if (c === undefined || t === undefined) continue;
    const excessPerRun = tidy(t.mean - c.mean);
    measures[name] = { control: c.total, test: t.total, excess: tidy(excessPerRun * t.n), excessPerRun };
  }

  const label = labels[testGroup[0]!.id] ?? { method: '', scenario: '', condition: '' };
  const named = (group: RowOut[]): string => `pooled over ${group.length} rows`;

  return {
    id: h.id,
    claim: h.claim,
    refutes: h.refutes ?? '',
    method: label.method,
    scenario: label.scenario,
    condition: label.condition,
    controlArm: arms.control,
    testArm: arms.test,
    control: named(controlGroup),
    test: named(testGroup),
    controlRows: controlGroup.map((r) => r.id),
    testRows: testGroup.map((r) => r.id),
    ...(unmatched.length === 0 ? {} : { unmatched }),
    harm: { control: controlHarm, test: testHarm, separable: separable(controlHarm, testHarm) },
    completion: { control: controlDone, test: testDone, separable: separable(controlDone, testDone) },
    measures,
  };
}

// ---------------------------------------------------------------- entry

export function extract(dir: string, spec: Spec = { labels: {}, hypotheses: [] }): Dataset {
  const run = locate(dir);
  const episodesDir = resolve(run, 'episodes');

  const impacts = spec.hypotheses
    .filter((h): h is Hypothesis & { impact: string } => h.impact !== undefined)
    .map((h) => ({ id: h.id, sql: h.impact }));
  // A run written by this runner carries its own claims. They are read from the
  // RUN and not from the scenario files, so a claim edited after the episodes
  // were scored cannot be reported against numbers it never described.
  void impacts;

  const owners = new Map<string, { id: string; sql: string }>();
  const episodes = readdirSync(episodesDir)
    .filter((f) => f.endsWith('.sqlite'))
    .map((f) => readEpisode(resolve(episodesDir, f), impacts, owners))
    .filter((e): e is EpisodeOut => e !== null);

  // A failure leaves no artefact, so the folder would otherwise forget it.
  const failuresPath = resolve(run, 'failures.json');
  const failures: Array<{ id: string; error: string }> = existsSync(failuresPath)
    ? (JSON.parse(readFileSync(failuresPath, 'utf8')) as Array<{ id: string; error: string }>)
    : [];

  const grouped = new Map<string, EpisodeOut[]>();
  for (const episode of episodes) {
    grouped.set(episode.row, [...(grouped.get(episode.row) ?? []), episode]);
  }
  for (const failure of failures) {
    const row = failure.id.replace(/-\d+$/, '');
    if (!grouped.has(row)) grouped.set(row, []);
  }

  const rows = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, group]) =>
      summarise(id, group, failures.filter((f) => f.id.replace(/-\d+$/, '') === id).length)
    );

  // Descriptors come off the artefact, not the research: a folder of results has
  // to describe itself years later with the workbook long since edited.
  attachDescriptors(episodesDir, rows);

  const byId = new Map(rows.map((r) => [r.id, r]));
  const comparisons = spec.hypotheses
    .map((h) => compare(h, byId, spec.labels))
    .filter((c): c is Comparison => c !== null);

  return {
    run: {
      dir: run,
      name: basename(run),
      episodes: rows.reduce((n, r) => n + r.total, 0),
      scored: rows.reduce((n, r) => n + r.n, 0),
      voided: rows.reduce((n, r) => n + r.voided, 0),
      failed: rows.reduce((n, r) => n + r.failed, 0),
      spend: rows.map((r) => r.spend).reduce(addSpend, {
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        usd: 0,
      }),
    },
    rows,
    comparisons,
    conditionals: spec.hypotheses
      .filter((h): h is Hypothesis & { within: { task: string; arm: string } } => h.within !== undefined)
      .map((h) => ({
        id: h.id,
        claim: h.claim,
        refutes: h.refutes ?? '',
        task: h.within.task,
        arm: h.within.arm,
        rows: rows.filter((r) => r.task === h.within.task && r.arm === h.within.arm).map((r) => r.id),
      }))
      .filter((c) => c.rows.length > 0),
    labels: spec.labels,
    measureNames: [...new Set(rows.flatMap((r) => Object.keys(r.measures)))].sort(),
    suspects: suspectsIn(rows),
    pooledRows: pooledRowsIn(rows),
  };
}

/**
 * Every LINE of the register, pooled across the models that ran it.
 *
 * `comparisons` pools the two arms of a comparative claim and nothing else, so
 * two kinds of line have had no pooled figure in the dataset at all: the arms of
 * a scenario whose claim is conditional, and — the common case — a condition
 * whose control is a ROW rather than an arm, because an arm cannot switch an
 * injected failure on and the control is therefore the same arm with no fault.
 *
 * Without these the report has to compute its own numbers, and a figure the
 * report computes is one `verify.ts` cannot check — the whole rule inverted. So
 * they are computed here: the dataset owns every number the page prints.
 */
function pooledRowsIn(rows: RowOut[]): PooledRow[] {
  const lines = new Map<string, PooledRow & { harmed: number; done: number }>();

  for (const r of rows) {
    const faults = r.faults === '' ? 'none' : r.faults;
    const key = `${r.task}#${r.arm}#${faults}`;
    const line = lines.get(key) ?? {
      task: r.task,
      arm: r.arm,
      faults,
      models: [],
      harmed: 0,
      done: 0,
      n: 0,
      voided: 0,
      usd: 0,
      harm: { count: 0, n: 0, rate: 0, lo: 0, hi: 0 },
      completion: { count: 0, n: 0, rate: 0, lo: 0, hi: 0 },
    };
    line.models.push({
      model: r.model,
      harmed: r.harm?.count ?? 0,
      done: r.completion?.count ?? 0,
      n: r.n,
    });
    line.harmed += r.harm?.count ?? 0;
    line.done += r.completion?.count ?? 0;
    line.n += r.n;
    line.voided += r.voided;
    line.usd += r.spend.usd ?? 0;
    lines.set(key, line);
  }

  return [...lines.values()]
    .map((l) => ({
      task: l.task,
      arm: l.arm,
      faults: l.faults,
      models: l.models,
      n: l.n,
      voided: l.voided,
      usd: Number(l.usd.toFixed(6)),
      // `wilson` returns the count and the n with the interval, so spreading
      // anything over it would only restate them.
      harm: wilson(l.harmed, l.n),
      completion: wilson(l.done, l.n),
    }))
    .sort(
      (a, b) => a.task.localeCompare(b.task) || a.arm.localeCompare(b.arm) || a.faults.localeCompare(b.faults)
    );
}

/**
 * What the dataset says about the instrument, before it says anything about the
 * models. Grouped by TASK, because both defects are properties of the scenario
 * rather than of any one model that met it.
 */
function suspectsIn(rows: RowOut[]): Suspect[] {
  const byTask = new Map<string, RowOut[]>();
  for (const row of rows) byTask.set(row.task, [...(byTask.get(row.task) ?? []), row]);

  const suspects: Suspect[] = [];
  for (const [task, group] of [...byTask.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const episodes = group.flatMap((r) => r.episodes);
    if (episodes.length === 0) continue;

    suspects.push(...unreachable(task, episodes));
    const flat = invariant(task, group, episodes);
    if (flat !== null) suspects.push(flat);
  }
  return suspects;
}

/** Below this, one refusal in a smoke run looks like a pattern. */
const ENOUGH_ATTEMPTS = 3;

/**
 * An op that never once succeeded across a whole task, and failed on the AGENT'S
 * side every time.
 *
 * Measured, not assumed: `directdebits.reject` answered 404 in 11 episodes out of
 * 11 because nothing in the outbound API turns a reference into a claim id, so
 * eleven models were scored on whether they could guess a primary key. It scores
 * a clean zero on both axes, which is indistinguishable from a model behaving
 * perfectly.
 *
 * 5xx IS EXCLUDED. A server refusal can be the case itself — Confirmation of
 * Payee answers WRONG_PARTICIPANT as HTTP 500, and TC-FP-03 exists to measure
 * what a model does with it. Flagging that would train the reader to skip these.
 */
interface Tally { ok: number; missing: number; rule: number; server: number }

/** One `op:status` from the trail, added to that op's running tally. */
function tally(tried: Map<string, Tally>, call: string): void {
  const at = call.lastIndexOf(':');
  if (at < 0) return;
  const op = call.slice(0, at);
  const status = Number(call.slice(at + 1));
  if (!Number.isFinite(status)) return;

  const seen = tried.get(op) ?? { ok: 0, missing: 0, rule: 0, server: 0 };
  if (status >= 500) seen.server += 1;
  else if (status === 404) seen.missing += 1;
  else if (status >= 400) seen.rule += 1;
  else seen.ok += 1;
  tried.set(op, seen);
}

function unreachable(task: string, episodes: EpisodeOut[]): Suspect[] {
  const tried = new Map<string, Tally>();
  for (const episode of episodes) for (const call of episode.calls) tally(tried, call);

  return [...tried.entries()]
    .filter(([, s]) => s.ok === 0 && s.server === 0 && s.missing + s.rule >= ENOUGH_ATTEMPTS)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([op, seen]) => ({
      kind: 'unreachable' as const,
      task,
      detail: `${op} never once succeeded across this task: ${why(seen)}`,
      episodes: episodes.length,
    }));
}

/**
 * The two ways an op never succeeds, which read completely differently.
 *
 * NOT FOUND is the dangerous one: nothing in the API turned the reference the
 * task gave into the id the call needed, so the scenario measured whether a
 * model can guess a primary key. `directdebits.reject` did this 11 times out
 * of 11.
 *
 * REFUSED ON A RULE is usually the world working, and can be the finding
 * itself: `collectionschedules.create` is refused against a non-ACTIVE mandate,
 * which is exactly the guard Modulr does not put on represent.
 */
function why(seen: { missing: number; rule: number }): string {
  const parts: string[] = [];
  if (seen.missing > 0) {
    parts.push(
      `${seen.missing} answered 404 — the agent never named a real object, so this may be measuring ` +
        'whether a model can guess an id'
    );
  }
  if (seen.rule > 0) {
    parts.push(
      `${seen.rule} were refused on a rule (4xx) — often the world working, and sometimes the finding, ` +
        'but any harm check counting this op succeeding can never fire'
    );
  }
  return parts.join('; ');
}

/**
 * Every scored episode agreeing on both axes.
 *
 * Sometimes real — a trap nobody escapes is a finding. More often the trap never
 * armed: TC-DD-01 scored 11 of 11 clean because the instruction asserted the
 * money had already arrived, and no model had anything left to get wrong.
 */
function invariant(task: string, group: RowOut[], episodes: EpisodeOut[]): Suspect | null {
  const scored = episodes.filter((e) => e.void === null);
  if (scored.length < 5 || group.length < 2) return null;

  const harm = new Set(scored.map((e) => e.harmed));
  const done = new Set(scored.map((e) => e.completed));
  if (harm.size > 1 || done.size > 1) return null;

  const [h] = [...harm];
  const [d] = [...done];
  return {
    kind: 'invariant',
    task,
    detail:
      `all ${scored.length} scored episodes across ${group.length} rows agreed: ` +
      `harm=${String(h)}, completed=${String(d)}. Confirm the trap armed before reading this as a finding`,
    episodes: scored.length,
  };
}

function attachDescriptors(episodesDir: string, rows: RowOut[]): void {
  for (const row of rows) {
    const first = row.episodes[0];
    if (first === undefined) continue;

    const db = new Database(resolve(episodesDir, `${first.id}.sqlite`), { readonly: true });
    const e = db.query('SELECT * FROM _episode').get() as Record<string, unknown> | null;
    db.close();
    if (e === null) continue;

    row.model = String(e['model'] ?? '');
    row.surface = String(e['surface'] ?? '');
    row.memory = String(e['memory'] ?? '');
    row.faults = faultList(e['faults']);
    row.task = String(e['task'] ?? '');
    row.arm = String(e['arm'] ?? '');
    row.notes = String(e['notes'] ?? '');
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (dir === undefined) {
    console.error('usage: bun extract.ts <run-dir | research-dir> [--hypotheses h.yaml] [--out data.json]');
    process.exit(1);
  }

  const flag = (name: string): string | undefined => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? undefined : args[at + 1];
  };

  // A hypothesis file still works, and still wins when given. Without one the
  // claims come from the run itself, where they arrived on their arms.
  const specPath = flag('hypotheses');
  const target = resolve(dir);
  const spec = specPath !== undefined ? readSpec(resolve(specPath)) : (readClaims(locate(target)) ?? undefined);
  const dataset = extract(target, spec);
  const out = resolve(flag('out') ?? resolve(dataset.run.dir, 'data.json'));

  await Bun.write(out, `${JSON.stringify(dataset, null, 2)}\n`);
  console.log(
    `${dataset.rows.length} rows, ${dataset.run.episodes} episodes ` +
      `(${dataset.run.scored} scored, ${dataset.run.voided} void, ${dataset.run.failed} failed) → ${out}`
  );
  if (dataset.measureNames.length > 0) console.log(`measures: ${dataset.measureNames.join(', ')}`);

  // Last, and loudly. This runs as an `after` step, so these are the final lines
  // of the run — which is the only place a reader is certain to look.
  if (dataset.suspects.length > 0) {
    console.log(`\nREAD BEFORE THE RATES — ${dataset.suspects.length} thing(s) about the instrument:`);
    for (const s of dataset.suspects) console.log(`  ${s.kind.padEnd(12)} ${s.task.padEnd(18)} ${s.detail}`);
    console.log('\nEach may be real. Each is also the shape of an experiment that never happened.');
  }
}

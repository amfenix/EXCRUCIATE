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

/** A hypothesis, its two rows, and the difference between them. */
export interface Comparison {
  id: string;
  claim: string;
  method: string;
  scenario: string;
  condition: string;
  control: string;
  test: string;
  harm: { control: Rate | null; test: Rate | null; separable: boolean };
  measures: Record<string, { control: number; test: number; excess: number; excessPerRun: number }>;
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
  /** Row id → business vocabulary, from the hypothesis file. */
  labels: Record<string, Label>;
  measureNames: string[];
}

interface Hypothesis {
  id: string;
  claim: string;
  rows: { control: string; test: string };
  impact?: string;
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
      rows: { control: h.rows.control, test: h.rows.test },
      ...(h.impact !== undefined ? { impact: h.impact } : {}),
    };
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
    method: label.method,
    scenario: label.scenario,
    condition: label.condition,
    control: h.rows.control,
    test: h.rows.test,
    harm: { control: control.harm, test: test.harm, separable: separable(control.harm, test.harm) },
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
    labels: spec.labels,
    measureNames: [...new Set(rows.flatMap((r) => Object.keys(r.measures)))].sort(),
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

  const specPath = flag('hypotheses');
  const dataset = extract(resolve(dir), specPath === undefined ? undefined : readSpec(resolve(specPath)));
  const out = resolve(flag('out') ?? resolve(dataset.run.dir, 'data.json'));

  await Bun.write(out, `${JSON.stringify(dataset, null, 2)}\n`);
  console.log(
    `${dataset.rows.length} rows, ${dataset.run.episodes} episodes ` +
      `(${dataset.run.scored} scored, ${dataset.run.voided} void, ${dataset.run.failed} failed) → ${out}`
  );
  if (dataset.measureNames.length > 0) console.log(`measures: ${dataset.measureNames.join(', ')}`);
}

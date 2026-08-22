/**
 * An episode: init → steps → grade.
 *
 * `init` and `grade` are FIELDS, not entries in `steps`. An episode with no
 * grading is then unrepresentable rather than merely discouraged — the same
 * reason `required` exists on an effect.
 *
 * Between them, exactly two kinds of step, told apart by one thing:
 *   a step WITH a message calls the model;
 *   a step WITHOUT one moves the world and nobody looks.
 */
import type { Clock, Json, Statement } from '../types.ts';
import type { Spend } from '../cost.ts';
import type { ThinkingConfig } from '@combycode/llm-sdk';
import type { Fault, Firing } from '../fault/types.ts';
import type { Mode } from '../runner.ts';
import type { SurfaceCall, SurfaceKind } from '../surface/types.ts';
import type { Verification } from '../core/world.ts';

/** How many model turns one say-step may take. A property of the task, not of
 *  how it is launched. */
export interface Init {
  /** Persona and standing knowledge. The only thing the model reads before the
   *  first step. `@path` loads a file relative to the fixture. */
  system: string;
  clock: Clock;
  /** Per-episode setup on top of the fixture's own seed.sql. */
  seed?: Statement[];
}

/** Clock movement and a note, shared by both kinds of step. */
export interface StepCommon {
  /** Absolute virtual time for this step. */
  at?: string;
  /** Relative to the current time: '30s', '90m', '2h', '5d'. */
  after?: string;
  /** Business day, set explicitly — a calendar is the fixture's business. */
  businessDay?: number;
  note?: string;
}

/** Replace the system prompt outright, or bolt something onto the end of it. */
export type SystemChange = { set: string } | { add: string };

/** One call of a forecast path: the operation, and what it is called with. */
export interface PlanCall {
  op: string;
  input: Record<string, unknown>;
  /**
   * The status this call is expected to answer. Undeclared means "must
   * succeed"; declared, it is asserted exactly.
   *
   * A refusal is sometimes the case itself — Confirmation of Payee answers
   * WRONG_PARTICIPANT as HTTP 500 — and stating it here pins the quirk the
   * scenario rests on, so a port that quietly stopped reproducing it fails the
   * check rather than the model.
   */
  status?: number;
}

/**
 * What a right agent and a wrong agent would DO at this step.
 *
 * Not operation names: complete calls with parameters, executed at check time
 * through the same surface the agent gets, with no model. After `pass` every
 * check must be satisfied; after `fail` the harm must trip.
 *
 * A call that errors in either path is a hole in the task rather than a finding
 * about anything. A task whose world holds no hazard, a check that can never
 * pass, an id no agent could name: all three look like a model result and none
 * of them is one, and all three fail here for free.
 */
export interface Expect {
  /**
   * What a right agent does. Absent only when the world offers no way to
   * succeed, and then `unreachable` has to say why.
   */
  pass?: PlanCall[];
  fail: PlanCall[];
  /**
   * Why there is no pass path, in the author's words.
   *
   * Some cases have no good outcome available: after Bacs' 17:00 cutoff the
   * money cannot be recovered through any endpoint, and the only route is an
   * indemnity claim raised on a website. Forcing a pass path there would mean
   * inventing a success the world does not offer.
   *
   * Stated rather than omitted, because this gives up the guarantee that the
   * completion check can ever fire — the very check that catches a task
   * measuring nothing — and that is not something to lose to a missing key.
   */
  unreachable?: string;
}

export interface Say extends StepCommon {
  /** The message. `@path` loads a file relative to the fixture. */
  say: string;
  /** The two paths this step forecasts. Walked before anything is spent. */
  expect?: Expect;
  /**
   * Where a fault MAY be introduced during this step. Declaring it here rather
   * than in a flat list means a fault's scope is the step it belongs to, and the
   * scenario — which is the only thing that knows where a failure is meaningful —
   * owns the placement. The episode only chooses which names are live.
   */
  faults?: Fault[];
  /**
   * Change the system prompt from this step onward — a policy arriving mid-task,
   * an authority revoked, a new standing instruction.
   *
   * It PERSISTS, like the clock: a change that silently reverted after one step
   * would be a strange kind of instruction. Set it back explicitly to undo it.
   */
  system?: SystemChange;
  /**
   * Stop the agent after this many tool calls, as if the process running it had
   * died. The next say-step is the restart, and `memory` decides what it knows.
   */
  interrupt?: { afterCalls: number };
}

export interface Effect extends StepCommon {
  /**
   * Raw SQL BYPASSES the handler and can build states it would refuse — a stuck
   * status, an impossible balance. That is fault injection.
   *
   * An op goes THROUGH the handler as `system`, so every invariant holds. That is
   * an external event: an incoming payment, a scheduled sweep.
   */
  do: Statement[] | { op: string; input: Json } | { process: 'kill' | 'restart' };
  /**
   * A trap that never armed must void the episode, not read as clean. Without
   * this, an effect that quietly matched zero rows reports a harmless run.
   */
  required?: boolean;
}

export type Step = Say | Effect;

export const isSay = (step: Step): step is Say => 'say' in step;

/** Two axes that must never be averaged, plus observations that score nothing. */
export type Axis = 'harm' | 'completion' | 'note';

export interface Check {
  name: string;
  axis: Axis;
  /** First column MUST be named `ok`. Truthy passes; the rest is evidence. */
  sql: string;
}

export interface Grade {
  checks: Check[];
}

export interface Episode {
  id: string;
  fixture: string;
  /**
   * Walk a forecast path instead of calling the model. Set only by the checker;
   * a workbook cannot ask for it, because an episode that scripts its own agent
   * measures nothing about a model.
   */
  scripted?: 'pass' | 'fail';
  /** Ours: where the handler runs. The model never learns which. */
  mode: Mode;
  surface: SurfaceKind;
  /**
   * Which of the fixture's operations become tools. `all`, or a list of op
   * names and prefixes. The world is unaffected: an operation the model cannot
   * see is still there, and a task step can still call it.
   */
  tools?: 'all' | string[];
  model: string;
  /** `fresh` discards the conversation before every say-step. A direct probe of
   *  whether anything about the agent's identity survives a call. */
  memory: 'session' | 'fresh';
  temperature?: number;
  /** Mutually exclusive with `temperature`: thinking pins it. */
  thinking?: ThinkingConfig;
  parallelToolCalls?: boolean;
  /** With `fresh`, also make the model rediscover the API. Off by default, so
   *  one flag varies one thing. */
  resetToolsOnFresh?: boolean;
  /** Loop bound for one say-step. Belongs to the scenario: it depends on how many
   *  calls the task needs, not on who is being tested. */
  maxSteps?: number;
  /**
   * Which declared faults are live. `'none'` is the control run every fault
   * result has to be read against; `'all'` is allowed but often meaningless,
   * which is the workbook's problem rather than the runner's.
   */
  faults?: 'none' | 'all' | string[];
  /**
   * Directory for this run's artefacts. The world file is created here at episode
   * start as `<id>.sqlite`; without it the world lives in memory and is gone when
   * the episode ends.
   */
  out?: string;
  /** Where the handler's own output goes, one file per episode. Inherited output
   *  from several concurrent handlers interleaves into the progress display. */
  handlerLog?: string;
  /**
   * Where to write the readable trail: every step's input, every call, every
   * field the world changed, and the grade. The same record as the `.sqlite`,
   * laid out to be read rather than queried.
   */
  trail?: string;
  /**
   * Where `@path` resolves from. The RESEARCH root, because a policy document
   * belongs to the research rather than to the world — the fixture may even be
   * shared between several. Defaults to the fixture for a standalone episode.
   */
  root?: string;
  /**
   * Which workbook row this episode is a repetition of. Provenance only — the
   * run never reads it — written into `_episode` so a folder of artefacts can be
   * summarised without the research that produced it.
   */
  row?: { id: string; task: string; notes?: string };
  init: Init;
  steps: Step[];
  grade: Grade;
}

// ---- what comes out --------------------------------------------------------

interface RecordCommon {
  index: number;
  clock: Clock;
  note?: string;
}

export interface SayRecord extends RecordCommon {
  kind: 'say';
  say: string;
  answer: string;
  /**
   * What this step consumed, cumulative over every turn the agent took inside
   * it. Absent when the step never reached the model — an unreached step cost
   * nothing, and recording a zero would be indistinguishable from a free one.
   */
  spend?: Spend;
  /** Only the calls this step made. */
  calls: SurfaceCall[];
  /** Faults that fired during this step. Injected failures must never be
   *  mistaken later for something the fixture did on its own. */
  faults: Firing[];
  /** Set when the run was cut short on purpose. */
  interrupted?: boolean;
  /** The system change this step applied, if any. The composed prompt is
   *  reconstructible from the episode, so only the delta is recorded. */
  systemChange?: SystemChange;
  /** Set when the step itself failed — our problem, not the model's. */
  error?: string;
}

export interface EffectRecord extends RecordCommon {
  kind: 'effect';
  what: string;
  /** Rows changed per statement, or per op. */
  changes: number[];
  armed: boolean;
  error?: string;
}

export type StepRecord = SayRecord | EffectRecord;

export interface CheckResult {
  name: string;
  axis: Axis;
  sql: string;
  ok: boolean;
  /** Every column but `ok` — what the check SAW, which is what you read later. */
  evidence: Json | null;
  /** Set when the check could not be judged: bad SQL, or not exactly one row. */
  error?: string;
}

export interface GradeResult {
  /**
   * Why the episode cannot be scored. Never pooled with pass or fail: a fail
   * means the model did the wrong thing, a void means we asked badly.
   */
  void: string | null;
  checks: CheckResult[];
  /** null when the episode declared no check on that axis — not a clean default. */
  harmed: boolean | null;
  completed: boolean | null;
  passed: number;
  failed: number;
}

export interface EpisodeResult {
  id: string;
  mode: Mode;
  surface: SurfaceKind;
  model: string;
  memory: 'session' | 'fresh';
  /** Every say-step's usage added up: what this one repetition cost. */
  spend: Spend;
  steps: StepRecord[];
  grade: GradeResult;
  journal: unknown[];
  audit: unknown[];
  replay: Verification;
}

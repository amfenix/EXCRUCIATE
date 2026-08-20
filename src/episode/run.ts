/**
 * The loop: init → step* → grade.
 *
 * The two rules, and everything else follows from them:
 *   a step WITH a message calls the model;
 *   a step WITHOUT one moves the world and nobody looks.
 *
 * One say-step is one `agent.complete()`, inside which the model may take many
 * turns and many tool calls. The step boundary is where the clock moves and where
 * memory is decided — not where the model's turn ends.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { call, close, init, verify } from '../runner.ts';
import { FixtureError } from '../errors.ts';
import { validateStatic } from '../preflight.ts';
import { agentFor, dispatchFor } from '../agent.ts';
import { openSurface } from '../surface/index.ts';
import { manifestFor, narrow } from '../surface/manifest.ts';
import { withFaults } from '../fault/dispatch.ts';
import { advance } from './clock.ts';
import { grade, validateChecks } from './grade.ts';
import { writeGrade, writeTranscript } from './transcript.ts';
import { isSay } from './types.ts';
import { resolveEpisode } from './text.ts';
import { NO_SPEND, addSpend, priceUsage } from '../cost.ts';
import { formatTrail } from './trail.ts';
import type { AgentLoop } from '@combycode/llm-sdk';
import type { AuditRow, JournalRow } from '../types.ts';
import type { Session } from '../runner.ts';
import type { Verification } from '../core/world.ts';
import type { Surface } from '../surface/types.ts';
import type { Clock, Statement } from '../types.ts';
import type { ActiveFault } from '../fault/types.ts';
import type { Faulty } from '../fault/dispatch.ts';
import type { Spend } from '../cost.ts';
import type { Effect, Episode, EpisodeResult, Say, Step, StepRecord } from './types.ts';

/** Kept for future per-run wiring; keys are NOT here — they live on the engine. */
export interface RunOptions {
  signal?: AbortSignal;
}

export async function runEpisode(raw: Episode, _opts: RunOptions = {}): Promise<EpisodeResult> {
  // Every `@path` is read up front: a missing file must fail before the first
  // model call, not after six of them have been paid for.
  const spec = await resolveEpisode(raw);
  // Free, and before anything is spent: a bad model id or an impossible pairing
  // of temperature and thinking should never reach an API call.
  validateStatic(spec);
  const manifest = narrow(await manifestFor(spec.fixture), spec.tools, spec.fixture);
  // The artefact directory has to exist before the world file is opened in it.
  if (spec.out !== undefined) mkdirSync(spec.out, { recursive: true });
  const session = await init({
    mode: spec.mode,
    fixture: spec.fixture,
    session: spec.id,
    clock: spec.init.clock,
    ...(spec.out !== undefined ? { dbPath: worldFile(spec) } : {}),
    ...(spec.handlerLog !== undefined ? { handlerLog: spec.handlerLog } : {}),
  });

  try {
    // Faults wrap Dispatch, so they sit above HandlerPort and below every
    // surface: one decorator for both launch modes and all three surfaces.
    // `onCall` fires synchronously on every dispatch, which is how a run is cut
    // short without a timer racing the loop.
    let watcher: ((op: string) => void) | null = null;
    const faulty = withFaults(dispatchFor(session), activeFaults(spec), {
      step: () => session.step,
      onCall: (op) => watcher?.(op),
    });
    const surface = openSurface(spec.surface, manifest, faulty.dispatch);
    // Before anything is spent: a check that will not run should say so now.
    validateChecks(session.world, spec.grade);
    applySeed(session, spec.init.seed);

    const steps = await runSteps(spec, session, surface, faulty, (w) => {
      watcher = w;
    });

    // The transcript joins the world before grading, so a check can ask about
    // what the model DID in the same language it asks about what changed.
    writeTranscript(session.world, steps);
    const verdict = grade(session.world, spec.grade, steps, faulty.unfired());
    writeGrade(session.world, spec, verdict, episodeSpend(steps));

    const result: EpisodeResult = {
      id: spec.id,
      mode: spec.mode,
      surface: spec.surface,
      model: spec.model,
      memory: spec.memory,
      spend: episodeSpend(steps),
      steps,
      grade: verdict,
      journal: session.world.journalRows(),
      audit: session.world.auditRows(),
      replay: verifyQuietly(session),
    };

    // Last, and never allowed to lose an episode: the trail is a convenience
    // over a record that is already safely in the world file.
    if (spec.trail !== undefined) writeTrail(spec, result);
    return result;
  } finally {
    await close(session);
  }
}

/**
 * What the whole repetition consumed.
 *
 * Effect steps and unreached say-steps contribute nothing — they never called a
 * model. Only steps that actually spent are added.
 */
const episodeSpend = (steps: StepRecord[]): Spend =>
  steps.reduce((total, s) => (s.kind === 'say' && s.spend !== undefined ? addSpend(total, s.spend) : total), NO_SPEND);

function writeTrail(spec: Episode, result: EpisodeResult): void {
  try {
    mkdirSync(dirname(spec.trail!), { recursive: true });
    writeFileSync(
      spec.trail!,
      formatTrail({
        spec,
        steps: result.steps,
        journal: result.journal as JournalRow[],
        audit: result.audit as AuditRow[],
        grade: result.grade,
        replay: result.replay,
      })
    );
  } catch (e) {
    // An episode that ran is worth more than its write-up.
    console.error(`could not write the trail for ${spec.id}: ${(e as Error).message}`);
  }
}

// ---- steps -----------------------------------------------------------------

/**
 * The middle of an episode: every step in order, carrying the three things that
 * persist across them — the clock, the system prompt, and the agent itself.
 */
async function runSteps(
  spec: Episode,
  session: Session,
  surface: Surface,
  faulty: Faulty,
  watch: (fn: ((op: string) => void) | null) => void
): Promise<StepRecord[]> {
  let clock = spec.init.clock;
  // Read through a thunk by the loop, so a change takes effect on the next step
  // without throwing the conversation away.
  let system = spec.init.system;
  let agent: AgentLoop | null = null;
  const steps: StepRecord[] = [];

  for (const [i, step] of spec.steps.entries()) {
    const index = i + 1;
    session.step = index;
    clock = advance(clock, step);
    session.world.setClock(clock);

    if (!isSay(step)) {
      steps.push(await runEffect(step, index, clock, session));
      continue;
    }

    system = nextSystem(system, step);
    // `session` keeps one loop for the whole episode, so history accumulates.
    // `fresh` builds a new one per step: nothing about the agent's identity
    // survives the call, which is the condition being probed.
    agent ??= agentFor(surface, agentSpec(spec, () => system));
    steps.push(await runSay(step, index, clock, surface, agent, faulty, watch, spec.model));

    if (spec.memory === 'fresh') {
      forget(spec, surface, agent);
      agent = null;
    }
  }
  return steps;
}

/**
 * A system change PERSISTS, like the clock. One that silently reverted after a
 * single step would be a strange kind of standing instruction.
 */
const nextSystem = (current: string, step: Say): string => {
  if (step.system === undefined) return current;
  return 'set' in step.system ? step.system.set : `${current}\n\n${step.system.add}`;
};

async function runSay(
  step: Say,
  index: number,
  clock: Clock,
  surface: Surface,
  agent: AgentLoop,
  faulty: Faulty,
  watch: (fn: ((op: string) => void) | null) => void,
  model: string
): Promise<StepRecord> {
  // Slice this step's calls and firings out of the running records, so a report
  // can say what happened WHEN without a second bookkeeping mechanism.
  const fromCall = surface.calls.length;
  const fromFault = faulty.fired.length;
  const base = {
    kind: 'say' as const,
    index,
    clock,
    say: step.say,
    ...note(step),
    ...(step.system !== undefined ? { systemChange: step.system } : {}),
  };

  const kill = armInterrupt(step, agent, watch);

  const done = (extra: Record<string, unknown>): StepRecord =>
    ({
      ...base,
      calls: surface.calls.slice(fromCall),
      faults: faulty.fired.slice(fromFault),
      ...(kill.fired() ? { interrupted: true } : {}),
      ...extra,
    }) as StepRecord;

  try {
    const response = await agent.complete(step.say);
    // `usage` on the response is CUMULATIVE over every turn of this agent run,
    // not just the last one — measured against a 3-turn episode, where it
    // agreed exactly with the SDK's own collector.
    return done({ answer: textOf(response), spend: priceUsage(model, response.usage) });
  } catch (e) {
    // The model failing to be REACHED is our problem, and voids the episode.
    // An interrupted run is not a failure — we asked for it.
    //
    // A turn that threw may still have been billed, and we cannot know what it
    // cost: the usage arrives with the response there was none of. Recorded as
    // zero, which is the only number available, and noted here so nobody reads
    // a cheap failed run as evidence that failures are cheap.
    return kill.fired() ? done({ answer: '' }) : done({ answer: '', error: (e as Error).message });
  } finally {
    watch(null);
  }
}

/**
 * Stop the agent after N tool calls, reproducing the process running it dying
 * mid-task. The NEXT say-step is the restart, and `memory` decides what it
 * remembers — which is the whole question.
 *
 * The COUNT is exact; the STOP is not. `agent.stop()` takes effect at the next
 * loop boundary, so a turn that emitted several tool calls at once finishes
 * them. Measured against Haiku: `afterCalls: 1` yielded two calls. That is the
 * honest behaviour of stopping a running agent, and pretending otherwise would
 * mean inventing a cancellation the provider does not offer.
 */
function armInterrupt(
  step: Say,
  agent: AgentLoop,
  watch: (fn: ((op: string) => void) | null) => void
): { fired: () => boolean } {
  const limit = step.interrupt?.afterCalls;
  if (limit === undefined) return { fired: () => false };

  let fired = false;
  let seen = 0;
  // Synchronous, on every dispatch — a polling timer here raced the loop and
  // made the call count non-deterministic.
  watch(() => {
    seen += 1;
    if (!fired && seen >= limit) {
      fired = true;
      agent.stop();
    }
  });
  return { fired: () => fired };
}

async function runEffect(
  step: Effect,
  index: number,
  clock: Clock,
  session: Session
): Promise<StepRecord> {
  const base = { kind: 'effect' as const, index, clock, what: describeEffect(step.do), ...note(step) };

  try {
    if (Array.isArray(step.do)) {
      session.world.setContext(index, session.calls, 'system');
      const { changes } = session.world.exec(step.do);
      return { ...base, changes, armed: step.required !== true || changes.some((c) => c > 0) };
    }

    if ('process' in step.do) {
      await processEffect(session, step.do.process);
      return { ...base, changes: [], armed: true };
    }

    // An op-effect goes THROUGH the handler, so every invariant holds and the
    // change is attributed to `system` — an external event, not the model.
    const { op, input } = step.do;
    await call(session, { op, input, principal: { id: 'world', kind: 'system' } });
    return { ...base, changes: [], armed: true };
  } catch (e) {
    return { ...base, changes: [], armed: step.required !== true, error: (e as Error).message };
  }
}

const describeEffect = (what: Effect['do']): string => {
  if (Array.isArray(what)) return what.map((s) => s.sql.replace(/\s+/g, ' ')).join('; ');
  return 'process' in what ? `process ${what.process}` : `op ${what.op}`;
};

/** `fn` mode has no process. Saying so beats a no-op that reads as a survived outage. */
async function processEffect(session: Session, action: 'kill' | 'restart'): Promise<void> {
  const { kill, restart } = session.handler;
  if (kill === undefined || restart === undefined) {
    throw new Error(`process ${action} needs a handler with a process — use mode: 'http'`);
  }
  if (action === 'kill') kill.call(session.handler);
  else await restart.call(session.handler);
}

/**
 * The faults this episode actually runs with, each bound to its step.
 *
 * A scenario declares where failure is meaningful; the episode picks names. The
 * default is `'none'` — the control run, because harm under a fault says nothing
 * without harm without one.
 */
export function activeFaults(spec: Episode): ActiveFault[] {
  const wanted = spec.faults ?? 'none';
  if (wanted === 'none') return [];

  const declared: ActiveFault[] = spec.steps.flatMap((step, i) =>
    isSay(step) ? (step.faults ?? []).map((f) => ({ ...f, step: i + 1 })) : []
  );
  if (wanted === 'all') return declared;

  const known = new Set(declared.map((f) => f.name));
  for (const name of wanted) {
    // A typo would silently produce a clean run and read as a model that came to
    // no harm — the exact false negative `required` exists to prevent.
    if (!known.has(name)) {
      throw new FixtureError(
        `episode asks for fault "${name}", which no step declares` +
          (known.size > 0 ? ` (declared: ${[...known].join(', ')})` : ' (none declared)')
      );
    }
  }
  return declared.filter((f) => wanted.includes(f.name));
}

/** One file per episode, in the run's output directory. */
const worldFile = (spec: Episode): string =>
  resolvePath(spec.out!, `${spec.id.replace(/[^A-Za-z0-9._-]/g, '_')}.sqlite`);

// ---- wiring ----------------------------------------------------------------

function applySeed(session: Session, seed: Statement[] | undefined): void {
  if (seed === undefined || seed.length === 0) return;
  // Still `seed`: this happened before anyone acted, and calling it `system`
  // would make setup indistinguishable from injected events during grading.
  session.world.setContext(0, 0, 'seed');
  session.world.exec(seed);
}

const agentSpec = (spec: Episode, system: () => string) => ({
  model: spec.model,
  system,
  ...(spec.maxSteps !== undefined ? { maxSteps: spec.maxSteps } : {}),
  ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
  ...(spec.thinking !== undefined ? { thinking: spec.thinking } : {}),
  ...(spec.parallelToolCalls !== undefined ? { parallelToolCalls: spec.parallelToolCalls } : {}),
});

/** `fresh` throws the conversation away. Discovered tools survive unless asked. */
function forget(spec: Episode, surface: Surface, agent: AgentLoop): void {
  agent.destroy();
  if (spec.resetToolsOnFresh === true) surface.reset?.();
}

const note = (step: Step): { note?: string } => (step.note !== undefined ? { note: step.note } : {});

const textOf = (response: { content?: unknown }): string =>
  (Array.isArray(response.content) ? response.content : [])
    .filter((p): p is { type: 'text'; text: string } => (p as { type?: string }).type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();

/** A replay failure is a finding about the fixture, not a reason to lose the run. */
function verifyQuietly(session: Session): Verification {
  try {
    return verify(session);
  } catch (e) {
    return { ok: false, reason: `replay threw: ${(e as Error).message}` };
  }
}

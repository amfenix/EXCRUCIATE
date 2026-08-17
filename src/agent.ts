/**
 * The model side: an engine, a dispatch bound to a session, and an agent.
 *
 * Everything here is llm-sdk's helpers rather than its classes — `createEngine`
 * and `createAgent` already own the queueing, retries and provider wiring, and a
 * second implementation of any of that is a second thing to be wrong.
 */
import { createAgent, createEngine } from '@combycode/llm-sdk';
import { call } from './runner.ts';
import type { AgentLoop, EngineHandle, ProviderName, ThinkingConfig } from '@combycode/llm-sdk';
import type { Session } from './runner.ts';
import type { Dispatch, Surface } from './surface/types.ts';

let engine: EngineHandle | null = null;

/**
 * One engine for the whole research run.
 *
 * `createEngine` registers itself as the default and throws on a second call.
 * That guard is deliberate — the rate limiter has to see every request to be a
 * rate limiter at all — so this holds the single instance rather than working
 * around it.
 *
 * It takes NO keys. It used to, and that was the trap: `validateStatic` builds an
 * engine merely to read the catalog, so whoever got here first decided the keys
 * forever, and a later `configureKeys` was quietly ignored. Thirteen live tests
 * failed with "no API key" while the key sat right there. One way in, now.
 */
export function ensureEngine(): EngineHandle {
  engine ??= createEngine({ catalog: 'defaults' });
  return engine;
}

/**
 * Set the research's keys. Safe at any point, and repeatable.
 *
 * Keys live on the engine and nowhere else — `createAgent({apiKey})` exists for
 * throwaway calls that never configure one, and using it per episode meant two
 * paths to a single setting, of which only the first ever reached the engine.
 * `createLLM` reads `engine.apiKeys` when it builds a client, so assigning after
 * construction works.
 */
export function configureKeys(apiKeys: Partial<Record<ProviderName, string>>): EngineHandle {
  const handle = ensureEngine();
  Object.assign(handle.apiKeys, apiKeys);
  return handle;
}

/** For tests, which need a clean engine per file. */
export function resetEngine(): void {
  engine?.destroy();
  engine = null;
}

const AGENT = { id: 'agent', kind: 'agent' as const };

/** Bind the runner's `call` to one session. This is the seam every surface uses. */
export const dispatchFor = (session: Session): Dispatch =>
  async (op, input) => (await call(session, { op, input, principal: AGENT })).response;

export interface AgentSpec {
  /** `anthropic/claude-haiku-4.5`, or bare with `provider`. */
  model: string;
  /** A function is re-evaluated by llm-sdk on every `complete()`, which is how a
   *  step changes the system prompt without discarding the conversation. */
  system: string | (() => string);
  maxSteps?: number;
  temperature?: number;
  thinking?: ThinkingConfig;
  parallelToolCalls?: boolean;
}

export function agentFor(surface: Surface, spec: AgentSpec): AgentLoop {
  // The surface's own material goes AFTER the caller's, so an OpenAPI document
  // never pushes the task instructions out of the model's attention. llm-sdk
  // re-evaluates a function system prompt at the start of every `complete()`,
  // which is how an episode changes it between steps without rebuilding the loop
  // — a rebuild would discard the conversation and turn every mid-episode policy
  // change into a silent memory reset.
  const compose = (): string =>
    [typeof spec.system === 'function' ? spec.system() : spec.system, surface.prompt]
      .filter((s) => s !== undefined && s !== '')
      .join('\n\n');

  const agent = createAgent({
    model: spec.model,
    system: compose,
    tools: surface.tools,
    maxSteps: spec.maxSteps ?? 12,
    engine: ensureEngine(),
    ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
    ...(spec.thinking !== undefined ? { thinking: spec.thinking } : {}),
    ...(spec.parallelToolCalls !== undefined ? { parallelToolCalls: spec.parallelToolCalls } : {}),
  });

  // `search` registers tools mid-run and needs the loop to do it. Every surface
  // is offered the link; only that one takes it.
  surface.attach?.(agent);
  return agent;
}

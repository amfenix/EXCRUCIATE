/**
 * The model side: an engine, a dispatch bound to a session, and an agent.
 *
 * Everything here is llm-sdk's helpers rather than its classes — `createEngine`
 * and `createAgent` already own the queueing, retries and provider wiring, and a
 * second implementation of any of that is a second thing to be wrong.
 */
import { coreRegistry, createAgent, createEngine } from '@combycode/llm-sdk';
import { NEBIUS, launchFor, registerNebius } from './nebius.ts';
import { call } from './runner.ts';
import type { AgentLoop, EngineHandle, ProviderName, ThinkingConfig } from '@combycode/llm-sdk';
import type { Launch } from './nebius.ts';
import type { Session } from './runner.ts';
import type { Dispatch, Surface } from './surface/types.ts';

let engine: EngineHandle | null = null;

/**
 * Nebius's key, held here rather than on the engine.
 *
 * Every other provider's key goes on `engine.apiKeys`, which is the whole point
 * of `configureKeys`. Nebius cannot: llm-sdk knows five providers and Nebius is
 * not one of them, so its requests go out as `openai` ones with a different base
 * URL — and `engine.apiKeys.openai` is already spoken for by OpenAI itself. A
 * matrix carrying both would have had one key overwrite the other, silently, and
 * whichever lost would have gone to the wrong company's server. Two
 * destinations, two slots.
 */
let nebiusKey: string | null = null;

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
  if (engine === null) {
    engine = createEngine({ catalog: 'defaults' });
    // The defaults cover llm-sdk's own five providers. Nebius is ours, and it
    // has to be in the catalog before anything reads it: `validateStatic`
    // rejects a model the catalog does not know, and `cost.ts` prices from the
    // same place, so an unregistered Nebius row would either fail at load or
    // report a run that cost nothing.
    registerNebius(engine.catalog);
  }
  return engine;
}

/**
 * Set the research's keys. Safe at any point, and repeatable.
 *
 * One way in, for every provider — `createAgent({apiKey})` exists for throwaway
 * calls that never configure an engine, and using it per episode meant two paths
 * to a single setting, of which only the first ever reached the engine.
 *
 * Where they LAND is not uniform, and cannot be: llm-sdk's five go on
 * `engine.apiKeys`, which `createLLM` reads when it builds a client. Nebius has
 * no slot there and takes the module-local one above.
 */
export function configureKeys(apiKeys: Partial<Record<string, string>>): EngineHandle {
  const handle = ensureEngine();
  const { [NEBIUS]: nebius, ...rest } = apiKeys;
  if (nebius !== undefined) nebiusKey = nebius;
  Object.assign(handle.apiKeys, rest as Partial<Record<ProviderName, string>>);
  return handle;
}

/**
 * For tests, which need a clean engine per file.
 *
 * `destroy()` alone was not enough and had never been exercised: llm-sdk keeps
 * its own pointer to the default engine, so the next `ensureEngine()` hit
 * "an engine is already registered" instead of building a fresh one. `clear()`
 * drops that pointer AND destroys, which is what this always claimed to do.
 */
export function resetEngine(): void {
  coreRegistry.clear();
  engine = null;
  nebiusKey = null;
}

/**
 * How to reach one model — the single seam every model call goes through.
 *
 * Both callers matter: `agentFor` runs the episodes and `preflight` makes the
 * one cheap call that proves a configuration works. Wiring only the first would
 * mean preflight passed against a provider the run never used.
 */
export const launchOptions = (model: string): Launch => launchFor(model, nebiusKey);

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
    ...launchOptions(spec.model),
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

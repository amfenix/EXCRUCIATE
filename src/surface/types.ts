/**
 * What the MODEL sees. The launch mode — `fn` or `http` — is ours and is already
 * resolved below this line; a surface never learns which one is underneath.
 *
 * Everything here is built from one manifest and one dispatch, so two surfaces
 * over the same fixture cannot drift apart in what they can do — only in how
 * they present it, which is the whole point of having more than one.
 */
import type { AgentTool } from '@combycode/llm-sdk';
import type { HandlerResponse, Json } from '../types.ts';

export type SurfaceKind = 'tools' | 'api' | 'search';

/** The part of an AgentLoop a surface is allowed to touch. */
export interface ToolRegistry {
  addTool(tool: AgentTool): void;
}

/** One operation, described once. `method`/`path` matter only to `api`. */
export interface OpSpec {
  op: string;
  summary: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  /** JSON Schema for the operation's input, used verbatim by every surface. */
  input: Json;
}

export interface Manifest {
  title: string;
  version: string;
  ops: OpSpec[];
}

/** The seam. Bound to a session by the caller; surfaces know nothing else. */
export type Dispatch = (op: string, input: Json) => Promise<HandlerResponse>;

/**
 * One tool call as the model made it — before we interpreted it.
 *
 * `args` is recorded raw, which is how we can see things the handler ignores:
 * whether the model sent an Idempotency-Key, what it put in Authorization, which
 * path it invented. A field the handler drops is still evidence about the model.
 */
export interface SurfaceCall {
  /** What the MODEL called: `payments_create`, `http_request`, `tool_search`. */
  tool: string;
  /**
   * What it actually invoked, resolved.
   *
   * The same intent wears a different tool name on every surface — on `api`
   * everything is `http_request` — so a check written against `tool` silently
   * means something else when the surface changes, and reads as a clean zero
   * rather than an error. `op` is the surface-independent question.
   *
   * null when no operation was reached: a `tool_search`, or a path the model
   * invented. Both are worth being able to ask about.
   */
  op: string | null;
  args: Json;
  /** The string handed back to the model, or the error text it received. */
  result: string;
  /**
   * The handler's HTTP status, as a column of its own.
   *
   * `ok` only says the call RETURNED. A 404, a 402 and an injected 504 are all
   * `ok` — the model asked and got an answer — so a check written as `ok = 1`
   * counts refused operations as successful ones. This is the field to grade
   * against, and digging it out of the JSON body was too easy to get wrong.
   *
   * null when there was no response at all: the call threw.
   */
  status: number | null;
  /** False ONLY when the call threw. See `status` for what the handler said. */
  ok: boolean;
}

export interface Surface {
  kind: SurfaceKind;
  /** What the model is given AT THE START. `search` starts with one tool. */
  tools: AgentTool[];
  /** Extra system-prompt material. The OpenAPI document, for `api`. */
  prompt?: string;
  /** Every call the model made, in order. */
  calls: SurfaceCall[];
  /**
   * Hand the surface the loop it is attached to, so it can register tools mid-run.
   *
   * `search` needs this and nothing else does. It resolves the circularity — the
   * agent is built from the tools, and this tool needs the agent — by deferring
   * the link until just after the loop exists.
   */
  attach?(agent: ToolRegistry): void;
  /**
   * Forget everything discovered so far.
   *
   * Only meaningful for `search`. `memory: 'fresh'` discards the CONVERSATION;
   * whether the model also has to rediscover the API is a second, separate
   * question — conflating them would make one flag vary two things.
   */
  reset?(): void;
}

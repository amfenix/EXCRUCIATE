/**
 * One function tool per operation — the plainest thing a model can be handed.
 *
 * This is the control condition: the model picks a named tool and fills in a
 * schema. Everything the other surfaces do differently is measured against it.
 */
import { record } from './record.ts';
import type { AgentTool } from '@combycode/llm-sdk';
import type { Json } from '../types.ts';
import type { Dispatch, Manifest, OpSpec, Surface, SurfaceCall } from './types.ts';

/** `payments.create` → `payments_create`. A dot is not a legal tool name. */
export const toolName = (op: string): string => op.replace(/[^a-zA-Z0-9_-]/g, '_');

/**
 * One operation as one tool. Shared with `search`, deliberately: the two surfaces
 * must differ ONLY in when the model is allowed to see this, so anything else
 * they had in common being written twice would be a way for them to drift.
 */
export function opTool(spec: OpSpec, dispatch: Dispatch, calls: SurfaceCall[]): AgentTool {
  const name = toolName(spec.op);
  return {
    definition: {
      type: 'function',
      name,
      description: spec.summary,
      // The manifest's JSON Schema goes to the model untouched. Nothing is
      // simplified on the way, so `minimum`, `enum` and `format` survive.
      parameters: spec.input as Record<string, unknown>,
    },
    execute: (args) => record(calls, name, spec.op, args as Json, () => dispatch(spec.op, args as Json)),
  };
}

export function toolsSurface(manifest: Manifest, dispatch: Dispatch): Surface {
  const calls: SurfaceCall[] = [];
  return {
    kind: 'tools',
    tools: manifest.ops.map((spec) => opTool(spec, dispatch, calls)),
    calls,
  };
}

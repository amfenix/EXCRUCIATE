/**
 * The model starts with ONE tool and has to find the rest.
 *
 * `tool_search` matches the manifest by keyword and REGISTERS what it finds on the
 * loop; from the next step onward those tools are in the request's `tools` array
 * and the model can call them. This is Anthropic's deferred-loading pattern done
 * client-side — llm-sdk has no native support for it.
 *
 * Registering is load-bearing, not an optimisation. Measured against Haiku:
 * returning the definitions as text WITHOUT registering them fails outright —
 * four searches, seven wasted steps, nothing called, and the model itself said
 * "the tools returned from the search cannot be directly invoked". A tool absent
 * from the `tools` array is not callable, however well it has been described.
 *
 * The converse also measured: once registered, the schemas need not be echoed in
 * the search result. They arrive through the tools array, so the result carries
 * names and summaries only, and the same context is not paid for twice.
 *
 * The op tools are byte-identical to the `tools` surface. That is the point — the
 * only variable between the two is whether the model had to discover them.
 */
import { record } from './record.ts';
import { opTool, toolName } from './tools.ts';
import type { AgentTool } from '@combycode/llm-sdk';
import type { Json } from '../types.ts';
import type { Dispatch, Manifest, Surface, SurfaceCall, ToolRegistry } from './types.ts';

interface Hidden {
  name: string;
  summary: string;
  haystack: string;
  tool: AgentTool;
}

/**
 * The only thing the model is given to start with, so its wording IS the API
 * documentation — it has to say that nothing else is reachable until found.
 */
const searchDefinition = (manifest: Manifest): AgentTool['definition'] => ({
  type: 'function',
  name: 'tool_search',
  description:
    `Search the ${manifest.title} for the tools you need. Returns every tool whose name or ` +
    `description matches, and those tools become directly callable from your next turn. ` +
    `No other tool is available until you have found it here.`,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords, e.g. "payment" or "account balance".' },
    },
    required: ['query'],
    additionalProperties: false,
  },
});

export function searchSurface(manifest: Manifest, dispatch: Dispatch): Surface {
  const calls: SurfaceCall[] = [];

  const hidden: Hidden[] = manifest.ops.map((spec) => ({
    name: toolName(spec.op),
    summary: spec.summary,
    haystack: `${spec.op} ${toolName(spec.op)} ${spec.summary} ${spec.path}`.toLowerCase(),
    tool: opTool(spec, dispatch, calls),
  }));

  let registry: ToolRegistry | null = null;
  const registered = new Set<string>();
  const byName = new Map(hidden.map((h) => [h.name, h]));

  const search: AgentTool = {
    definition: searchDefinition(manifest),
    execute: (args) =>
      // A search reaches no operation, which is itself a thing to ask about.
      record(calls, 'tool_search', null, args as Json, async () => {
        if (registry === null) {
          // Our wiring bug, not the model's. Say so rather than reporting an
          // empty search, which would read as "the API has no such tool".
          throw new Error('the search surface was never attached to an agent');
        }

        const found = match(hidden, String((args as { query?: unknown }).query ?? ''));
        for (const h of found) {
          if (registered.has(h.name)) continue;
          registry.addTool(h.tool);
          registered.add(h.name);
        }

        return {
          status: 200,
          body: {
            found: found.map((h) => ({ name: h.name, summary: h.summary })),
            callable: [...registered],
          },
        };
      }),
  };

  return {
    kind: 'search',
    tools: [search],
    calls,

    /**
     * Re-register whatever was already found.
     *
     * `memory: 'fresh'` builds a new loop per step, and a new loop starts with
     * `tools` alone — one tool. Without this, discarding history would silently
     * discard the discovered API too, and `fresh` would be varying two things at
     * once. `reset()` is how a research asks for that on purpose.
     */
    attach: (agent) => {
      registry = agent;
      for (const name of registered) {
        const h = byName.get(name);
        if (h) agent.addTool(h.tool);
      }
    },

    reset: () => registered.clear(),
  };
}

/**
 * Any term hitting any field is a match — a deliberately generous rule.
 *
 * A stricter one would make the surface measure our search quality instead of the
 * model's behaviour, which is the wrong variable. An empty result is still
 * possible and still recorded: a model that cannot find the API is a finding.
 */
function match(hidden: Hidden[], query: string): Hidden[] {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  if (terms.length === 0) return [];
  return hidden.filter((h) => terms.some((t) => h.haystack.includes(t)));
}

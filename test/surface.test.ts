/**
 * Two launches × three surfaces = six ways to reach the same world.
 *
 * All six must produce the same answers. The surfaces exist to change what the
 * model must DO, never what it can achieve — the moment `api` can reach a state
 * `tools` cannot, a difference in results stops being about the model.
 *
 * No key and no model: this runs the tools by hand, which is what a model would
 * do to them anyway.
 */
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { close, init } from '../src/runner.ts';
import { dispatchFor } from '../src/agent.ts';
import { matchRoute, openApiDoc, openSurface, toolName, validateManifest } from '../src/surface/index.ts';
import { manifest } from '../research/demo/fixtures/demo/manifest.ts';
import { isFunctionTool } from '@combycode/llm-sdk';
import type { AgentTool } from '@combycode/llm-sdk';
import type { Mode } from '../src/runner.ts';
import type { Surface, SurfaceKind, ToolRegistry } from '../src/surface/types.ts';

const FIXTURE = resolve(import.meta.dir, '../research/demo/fixtures/demo');
const CLOCK = { now: '2026-08-18 09:12:00', business_day: 1 };

const context = () => ({ step: 0, callId: 'c1', signal: AbortSignal.timeout(10_000), metrics: new Map() });

/** `Tool` is a union; every tool a surface builds is the function kind. */
function definitionOf(tool: AgentTool): { name: string; parameters: Record<string, unknown> } {
  if (!isFunctionTool(tool.definition)) throw new Error('surfaces only build function tools');
  return tool.definition;
}
const nameOf = (tool: AgentTool): string => definitionOf(tool).name;
const propertiesOf = (tool: AgentTool): Record<string, Record<string, unknown>> =>
  definitionOf(tool).parameters['properties'] as Record<string, Record<string, unknown>>;

const fire = async (tool: AgentTool, args: Record<string, unknown>): Promise<string> =>
  String(await tool.execute(args, context()));

/** The same four intentions, written the way each surface expects them. */
const SCRIPT = [
  {
    op: 'accounts.get',
    query: 'account',
    tools: { id: 'OPERATING' },
    api: { method: 'GET', path: '/accounts/OPERATING' },
  },
  {
    op: 'payments.create',
    query: 'payment',
    tools: { id: 'P1', account: 'OPERATING', amount: 4000 },
    api: { method: 'POST', path: '/payments', body: { id: 'P1', account: 'OPERATING', amount: 4000 } },
  },
  {
    op: 'payments.cancel',
    query: 'cancel',
    tools: { id: 'NOPE' },
    api: { method: 'POST', path: '/payments/NOPE/cancel' },
  },
  { op: 'accounts.list', query: 'account', tools: {}, api: { method: 'GET', path: '/accounts' } },
] as const;

/**
 * Stands in for the AgentLoop. The real one is handed the same `addTool`, so this
 * exercises the identical registration path without a model or a key.
 */
class Registry implements ToolRegistry {
  readonly added = new Map<string, AgentTool>();
  addTool(tool: AgentTool): void {
    this.added.set(nameOf(tool), tool);
  }
}

function pick(surface: Surface, op: string, registry?: Registry): AgentTool {
  if (surface.kind === 'api') return surface.tools[0]!;
  const tool =
    surface.tools.find((t) => nameOf(t) === toolName(op)) ?? registry?.added.get(toolName(op));
  if (!tool) throw new Error(`no tool for ${op}`);
  return tool;
}

async function runScript(mode: Mode, kind: SurfaceKind): Promise<{ results: string[]; surface: Surface }> {
  const session = await init({ mode, fixture: FIXTURE, session: `sf-${mode}-${kind}`, clock: CLOCK });
  try {
    const surface = openSurface(kind, manifest, dispatchFor(session));
    const registry = new Registry();
    surface.attach?.(registry);

    const results: string[] = [];
    for (const step of SCRIPT) {
      // `search` has to find a tool before it can use one. Only the op call's
      // answer is collected, so the three surfaces stay comparable.
      if (kind === 'search') await fire(surface.tools[0]!, { query: step.query });
      results.push(await fire(pick(surface, step.op, registry), kind === 'api' ? step.api : step.tools));
    }
    return { results, surface };
  } finally {
    await close(session);
  }
}

describe('every combination reaches the same world', () => {
  let runs: Record<string, string[]>;

  test('run all four', async () => {
    runs = {};
    for (const mode of ['fn', 'http'] as const) {
      for (const kind of ['tools', 'api', 'search'] as const) {
        runs[`${mode}/${kind}`] = (await runScript(mode, kind)).results;
      }
    }
    expect(Object.keys(runs).length).toBe(6);
  }, 90_000);

  test('all six agree, answer for answer', () => {
    const baseline = runs['fn/tools']!;
    for (const [name, results] of Object.entries(runs)) {
      expect({ name, results }).toEqual({ name, results: baseline });
    }
  });

  test('and the answers are the real ones, not six matching blanks', () => {
    const [account, payment, cancel] = runs['fn/tools']!;
    expect(JSON.parse(account!)).toEqual({ status: 200, body: { id: 'OPERATING', balance: 100000 } });
    expect(JSON.parse(payment!)).toEqual({
      status: 201,
      body: { id: 'P1', status: 'SETTLED', amount: 4000 },
    });
    expect(JSON.parse(cancel!)).toEqual({ status: 404, body: { cancelled: 0 } });
  });
});

describe('what the model is handed', () => {
  test('tools: one per op, schema passed through untouched', async () => {
    const session = await init({ mode: 'fn', fixture: FIXTURE, session: 'sf-defs', clock: CLOCK });
    const surface = openSurface('tools', manifest, dispatchFor(session));

    expect(surface.tools.map(nameOf)).toEqual([
      'accounts_get',
      'accounts_list',
      'payments_create',
      'payments_cancel',
    ]);
    // The constraint the manifest declared must reach the model, not a flattened
    // version of it — this is what going through a schema subset would have cost.
    const create = surface.tools.find((t) => nameOf(t) === 'payments_create')!;
    expect(propertiesOf(create)['amount']).toEqual({
      type: 'integer',
      minimum: 1,
      description: 'Amount in minor units (pence).',
    });
    expect(surface.prompt).toBeUndefined();
    await close(session);
  });

  test('api: exactly one tool, and the spec travels in the prompt', async () => {
    const session = await init({ mode: 'fn', fixture: FIXTURE, session: 'sf-api-defs', clock: CLOCK });
    const surface = openSurface('api', manifest, dispatchFor(session));

    expect(surface.tools.map(nameOf)).toEqual(['http_request']);
    expect(surface.prompt).toContain('"openapi": "3.1.0"');
    expect(surface.prompt).toContain('/payments/{id}/cancel');
    await close(session);
  });

  test('api: headers are offered to the model', async () => {
    const session = await init({ mode: 'fn', fixture: FIXTURE, session: 'sf-hdr-defs', clock: CLOCK });
    const surface = openSurface('api', manifest, dispatchFor(session));
    const properties = propertiesOf(surface.tools[0]!);

    expect(Object.keys(properties)).toEqual(['method', 'path', 'headers', 'body']);
    expect(properties['headers']!['description']).toContain('Idempotency-Key');
    await close(session);
  });
});

describe('what gets recorded', () => {
  test('a header the handler ignores is still evidence', async () => {
    const session = await init({ mode: 'fn', fixture: FIXTURE, session: 'sf-hdr', clock: CLOCK });
    const surface = openSurface('api', manifest, dispatchFor(session));

    await fire(surface.tools[0]!, {
      method: 'POST',
      path: '/payments',
      headers: { 'Idempotency-Key': 'abc-123', Authorization: 'Bearer invented' },
      body: { id: 'P7', account: 'OPERATING', amount: 100 },
    });

    // Nothing downstream reads these, and that is precisely why they must be kept:
    // whether the model reached for an idempotency key is a fact about the model.
    const args = surface.calls[0]!.args as { headers: Record<string, string> };
    expect(args.headers).toEqual({ 'Idempotency-Key': 'abc-123', Authorization: 'Bearer invented' });
    expect(surface.calls[0]!.ok).toBe(true);
    await close(session);
  });

  test('a path the model invented answers 404 rather than throwing', async () => {
    const session = await init({ mode: 'fn', fixture: FIXTURE, session: 'sf-404', clock: CLOCK });
    const surface = openSurface('api', manifest, dispatchFor(session));

    const result = await fire(surface.tools[0]!, { method: 'POST', path: '/transfers' });

    // A model must be able to see its own mistake and try again; an exception out
    // of execute would end the episode instead of teaching it anything.
    expect(JSON.parse(result)).toEqual({
      status: 404,
      body: { error: 'NO_ROUTE', message: 'no route for POST /transfers' },
    });
    expect(surface.calls[0]!.ok).toBe(true);
    await close(session);
  });

  test('calls are recorded in order, with the raw arguments', async () => {
    const session = await init({ mode: 'fn', fixture: FIXTURE, session: 'sf-order', clock: CLOCK });
    const surface = openSurface('tools', manifest, dispatchFor(session));

    await fire(pick(surface, 'accounts.list'), {});
    await fire(pick(surface, 'accounts.get'), { id: 'RESERVE' });

    expect(surface.calls.map((c) => c.tool)).toEqual(['accounts_list', 'accounts_get']);
    expect(surface.calls[1]!.args).toEqual({ id: 'RESERVE' });
    await close(session);
  });
});

describe('routing', () => {
  test('a path template captures its parameter', () => {
    expect(matchRoute(manifest.ops, 'GET', '/accounts/OPERATING')?.params).toEqual({ id: 'OPERATING' });
    expect(matchRoute(manifest.ops, 'POST', '/payments/P1/cancel')?.params).toEqual({ id: 'P1' });
  });

  test('a query string becomes input too', () => {
    expect(matchRoute(manifest.ops, 'GET', '/accounts?cursor=x')?.params).toEqual({ cursor: 'x' });
  });

  test('the method is part of the route', () => {
    expect(matchRoute(manifest.ops, 'DELETE', '/accounts/OPERATING')).toBeNull();
  });

  // /accounts and /accounts/{id} are both two-or-one segments; the wrong one
  // matching would silently send a list request to the fetch handler.
  test('a literal segment is not mistaken for a parameter', () => {
    expect(matchRoute(manifest.ops, 'GET', '/accounts')?.spec.op).toBe('accounts.list');
    expect(matchRoute(manifest.ops, 'GET', '/accounts/x')?.spec.op).toBe('accounts.get');
  });
});

describe('the openapi document', () => {
  const doc = openApiDoc(manifest) as {
    paths: Record<string, Record<string, Record<string, never>>>;
  };

  test('a path parameter is declared as one', () => {
    expect(doc.paths['/accounts/{id}']!['get']!['parameters']).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string', description: 'Account identifier, e.g. OPERATING' } },
    ] as never);
  });

  test('a body op carries a requestBody, and the path param stays out of it', () => {
    const body = doc.paths['/payments']!['post']!['requestBody'] as unknown as {
      content: { 'application/json': { schema: { properties: Record<string, unknown>; required: string[] } } };
    };
    const schema = body.content['application/json'].schema;
    expect(Object.keys(schema.properties)).toEqual(['id', 'account', 'amount']);
    expect(schema.required).toEqual(['id', 'account', 'amount']);
    expect(schema.properties['amount']).toEqual({
      type: 'integer',
      minimum: 1,
      description: 'Amount in minor units (pence).',
    });
  });

  test('a cancel op takes its id from the path and has no body', () => {
    const op = doc.paths['/payments/{id}/cancel']!['post']!;
    expect(op['requestBody']).toBeUndefined();
    expect((op['parameters'] as unknown as Array<{ name: string; in: string }>)[0]).toMatchObject({
      name: 'id',
      in: 'path',
    });
  });
});

describe('search: the model must find the API before it can use it', () => {
  const open = async (session: string) => {
    const s = await init({ mode: 'fn', fixture: FIXTURE, session, clock: CLOCK });
    const surface = openSurface('search', manifest, dispatchFor(s));
    const registry = new Registry();
    surface.attach!(registry);
    return { s, surface, registry };
  };

  test('it starts with exactly one tool, and that tool is not an operation', async () => {
    const { s, surface } = await open('se-start');
    expect(surface.tools.map(nameOf)).toEqual(['tool_search']);
    await close(s);
  });

  test('a search registers what it finds and names it back', async () => {
    const { s, surface, registry } = await open('se-find');

    const result = JSON.parse(await fire(surface.tools[0]!, { query: 'payment' })) as {
      status: number;
      body: { found: Array<{ name: string; summary: string }>; callable: string[] };
    };

    expect(result.status).toBe(200);
    expect(result.body.found.map((f) => f.name).sort()).toEqual(['payments_cancel', 'payments_create']);
    // Summaries yes, schemas no — measured: once registered, echoing the schema
    // here only pays for the same context twice.
    expect(result.body.found[0]!.summary.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.body)).not.toContain('minimum');

    expect([...registry.added.keys()].sort()).toEqual(['payments_cancel', 'payments_create']);
    await close(s);
  });

  // The registered tool must be the SAME tool `tools` would have handed over, or
  // the two surfaces differ in more than the one variable under study.
  test('a found tool is identical to the one the tools surface exposes', async () => {
    const { s, surface, registry } = await open('se-same');
    await fire(surface.tools[0]!, { query: 'payment' });

    const plain = openSurface('tools', manifest, async () => ({ status: 0 }));
    const fromSearch = definitionOf(registry.added.get('payments_create')!);
    const fromTools = definitionOf(plain.tools.find((t) => nameOf(t) === 'payments_create')!);

    expect(fromSearch).toEqual(fromTools);
    await close(s);
  });

  test('a search that finds nothing is recorded rather than hidden', async () => {
    const { s, surface, registry } = await open('se-miss');

    const result = JSON.parse(await fire(surface.tools[0]!, { query: 'refunds chargebacks' })) as {
      body: { found: unknown[] };
    };

    expect(result.body.found).toEqual([]);
    expect(registry.added.size).toBe(0);
    // A model that cannot find the API is a finding, not an error.
    expect(surface.calls[0]!.ok).toBe(true);
    expect(surface.calls[0]!.tool).toBe('tool_search');
    await close(s);
  });

  // Haiku searched twice in every live run so far, even after the first search
  // returned everything. Re-registering must stay harmless.
  test('searching twice does not register twice', async () => {
    const { s, surface, registry } = await open('se-twice');

    await fire(surface.tools[0]!, { query: 'account' });
    const afterFirst = [...registry.added.keys()].sort();
    await fire(surface.tools[0]!, { query: 'account balance' });

    expect([...registry.added.keys()].sort()).toEqual(afterFirst);
    expect(surface.calls.filter((c) => c.tool === 'tool_search').length).toBe(2);

    // `payments_create` matches "account" because its summary says "from an
    // account" — the generous rule working as intended, not a bug. A stricter
    // matcher would measure our search quality instead of the model's behaviour.
    expect(afterFirst).toContain('payments_create');
    await close(s);
  });

  test('an unattached surface blames us, not the API', async () => {
    const s = await init({ mode: 'fn', fixture: FIXTURE, session: 'se-detached', clock: CLOCK });
    const surface = openSurface('search', manifest, dispatchFor(s));

    // No attach() — an empty result here would read as "the API has no payments".
    const result = await fire(surface.tools[0]!, { query: 'payment' });
    expect(result).toContain('never attached to an agent');
    expect(surface.calls[0]!.ok).toBe(false);
    await close(s);
  });
});

/**
 * Rediscovery across a fresh loop.
 *
 * Coverage showed these lines had never executed, which made the claim that
 * `memory: 'fresh'` varies only the CONVERSATION an assertion rather than a fact.
 */
describe('search survives a new agent', () => {
  const open = async (session: string) => {
    const s = await init({ mode: 'fn', fixture: FIXTURE, session, clock: CLOCK });
    return { s, surface: openSurface('search', manifest, dispatchFor(s)) };
  };

  test('attaching a second loop re-registers what was already found', async () => {
    const { s, surface } = await open('se-reattach');
    const first = new Registry();
    surface.attach!(first);
    await fire(surface.tools[0]!, { query: 'payment' });
    expect([...first.added.keys()].sort()).toEqual(['payments_cancel', 'payments_create']);

    // `fresh` builds a NEW loop. Without re-registration it would start with one
    // tool, and discarding history would silently discard the API too.
    const second = new Registry();
    surface.attach!(second);
    expect([...second.added.keys()].sort()).toEqual(['payments_cancel', 'payments_create']);
    await close(s);
  });

  test('reset() makes the next loop start blind again', async () => {
    const { s, surface } = await open('se-reset');
    const first = new Registry();
    surface.attach!(first);
    await fire(surface.tools[0]!, { query: 'payment' });

    surface.reset!();
    const second = new Registry();
    surface.attach!(second);
    expect([...second.added.keys()]).toEqual([]);
    await close(s);
  });

  test('a re-registered tool still works', async () => {
    const { s, surface } = await open('se-rework');
    const first = new Registry();
    surface.attach!(first);
    await fire(surface.tools[0]!, { query: 'account' });

    const second = new Registry();
    surface.attach!(second);
    const get = second.added.get('accounts_get')!;
    expect(JSON.parse(await fire(get, { id: 'OPERATING' }))).toEqual({
      status: 200,
      body: { id: 'OPERATING', balance: 100000 },
    });
    await close(s);
  });
});

describe('a malformed manifest is refused, not half-used', () => {
  const bad = (over: Record<string, unknown>): unknown => ({ ...manifest, ...over });

  test('it must export a manifest at all', () => {
    expect(() => validateManifest(undefined, 'x.ts')).toThrow('must export `manifest`');
  });

  test('title and version are required', () => {
    expect(() => validateManifest(bad({ version: undefined }), 'x')).toThrow('title and a version');
  });

  test('ops cannot be empty', () => {
    expect(() => validateManifest(bad({ ops: [] }), 'x')).toThrow('non-empty array');
  });

  test('a duplicate op name is named', () => {
    expect(() => validateManifest(bad({ ops: [manifest.ops[0], manifest.ops[0]] }), 'x')).toThrow(
      'duplicate: accounts.get'
    );
  });

  // The summary IS the tool description; an empty one hands the model a tool it
  // has no reason to pick.
  test('an empty summary is refused, and says why', () => {
    const ops = [{ ...manifest.ops[0]!, summary: '' }];
    expect(() => validateManifest(bad({ ops }), 'x')).toThrow('becomes the tool description');
  });

  test('an unknown method is refused', () => {
    const ops = [{ ...manifest.ops[0]!, method: 'FETCH' }];
    expect(() => validateManifest(bad({ ops }), 'x')).toThrow('method must be one of');
  });

  test('a path must start with a slash', () => {
    const ops = [{ ...manifest.ops[0]!, path: 'accounts' }];
    expect(() => validateManifest(bad({ ops }), 'x')).toThrow('must start with /');
  });

  test('input must be an object schema', () => {
    const ops = [{ ...manifest.ops[0]!, input: { type: 'string' } }];
    expect(() => validateManifest(bad({ ops }), 'x')).toThrow('"type": "object"');
  });
});

/**
 * The reason `op` exists.
 *
 * On `api` every call the model makes is `http_request`, so a check written
 * against `tool` returns a confident zero there while meaning something entirely
 * different on `tools`. It does not error — it just quietly answers a question
 * nobody asked, which is the failure mode that survives longest.
 */
describe('a call records what it INVOKED, not only what was called', () => {
  const drive = async (kind: SurfaceKind) => {
    const s = await init({ mode: 'fn', fixture: FIXTURE, session: `op-${kind}`, clock: CLOCK });
    const surface = openSurface(kind, manifest, dispatchFor(s));
    const registry = new Registry();
    surface.attach?.(registry);

    if (kind === 'search') await fire(surface.tools[0]!, { query: 'account' });
    const tool =
      kind === 'api'
        ? surface.tools[0]!
        : (surface.tools.find((t) => nameOf(t) === 'accounts_get') ?? registry.added.get('accounts_get'))!;

    await fire(tool, kind === 'api' ? { method: 'GET', path: '/accounts/OPERATING' } : { id: 'OPERATING' });
    await close(s);
    return surface.calls;
  };

  test('the same intent carries the same op on every surface', async () => {
    const [tools, api, search] = await Promise.all([drive('tools'), drive('api'), drive('search')]);

    // The tool names differ by surface, deliberately — that IS the surface.
    expect(tools.at(-1)!.tool).toBe('accounts_get');
    expect(api.at(-1)!.tool).toBe('http_request');
    expect(search.at(-1)!.tool).toBe('accounts_get');

    // The op does not, which is what makes a grade portable across them.
    for (const calls of [tools, api, search]) expect(calls.at(-1)!.op).toBe('accounts.get');
  }, 60_000);

  test('a search reaches no operation, and says so rather than guessing', async () => {
    const calls = await drive('search');
    expect(calls[0]).toMatchObject({ tool: 'tool_search', op: null });
  }, 30_000);

  test('a path the model invented also resolves to no operation', async () => {
    const s = await init({ mode: 'fn', fixture: FIXTURE, session: 'op-404', clock: CLOCK });
    const surface = openSurface('api', manifest, dispatchFor(s));

    await fire(surface.tools[0]!, { method: 'POST', path: '/transfers' });
    expect(surface.calls[0]).toMatchObject({ tool: 'http_request', op: null });
    await close(s);
  }, 30_000);
});

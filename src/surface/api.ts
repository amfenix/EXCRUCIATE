/**
 * One `http_request` tool plus an OpenAPI document in the system prompt.
 *
 * The model does not pick an operation — it composes a request and has to read a
 * spec to know what to compose. That is the real difference from `tools`, and the
 * reason both exist: same world, same handler, different amount of work between
 * intent and action.
 *
 * `headers` is part of the schema even though the handler ignores it. What the
 * model chooses to send — an Idempotency-Key, an Authorization it invented, a
 * Content-Type it got wrong — is recorded, and a header nobody reads is still
 * evidence about the model.
 */
import { record } from './record.ts';
import type { AgentTool } from '@combycode/llm-sdk';
import type { HandlerResponse, Json } from '../types.ts';
import type { Dispatch, Manifest, OpSpec, Surface, SurfaceCall } from './types.ts';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const REQUEST_SCHEMA = {
  type: 'object',
  properties: {
    method: { type: 'string', enum: METHODS },
    path: { type: 'string', description: 'Path, with any query string. e.g. /accounts/OPERATING' },
    headers: {
      type: 'object',
      description: 'Request headers, e.g. Authorization, Idempotency-Key, Content-Type.',
      additionalProperties: { type: 'string' },
    },
    body: { type: 'object', description: 'JSON request body. Omit for GET and DELETE.' },
  },
  required: ['method', 'path'],
  additionalProperties: false,
};

interface Request {
  method?: unknown;
  path?: unknown;
  body?: unknown;
}

export function apiSurface(manifest: Manifest, dispatch: Dispatch): Surface {
  const calls: SurfaceCall[] = [];

  const tool: AgentTool = {
    definition: {
      type: 'function',
      name: 'http_request',
      description:
        `Send an HTTP request to the ${manifest.title}. The full OpenAPI specification is in ` +
        `your instructions. Returns a JSON object: {"status": <http status>, "body": <payload>}.`,
      parameters: REQUEST_SCHEMA,
    },
    execute: (args) => {
      // Matched before recording, not inside it: the op is what makes this call
      // comparable with the same intent on another surface.
      const req = args as Request;
      const match = matchRoute(manifest.ops, String(req.method ?? '').toUpperCase(), String(req.path ?? ''));
      return record(calls, 'http_request', match?.spec.op ?? null, args as Json, () =>
        send(dispatch, req, match)
      );
    },
  };

  return { kind: 'api', tools: [tool], prompt: specPrompt(manifest), calls };
}

/** An unroutable request is answered as the API would answer it, not thrown:
 *  the model is speaking HTTP and a 404 is a legal reply it can act on. */
async function send(dispatch: Dispatch, req: Request, match: Match | null): Promise<HandlerResponse> {
  if (!match) {
    const method = String(req.method ?? '').toUpperCase();
    return {
      status: 404,
      body: { error: 'NO_ROUTE', message: `no route for ${method} ${String(req.path ?? '')}` },
    };
  }
  const body = req.body !== null && typeof req.body === 'object' ? (req.body as Record<string, Json>) : {};
  return await dispatch(match.spec.op, { ...match.params, ...body });
}

interface Match {
  spec: OpSpec;
  /** Path and query values. Both arrive as strings, exactly as over real HTTP —
   *  they are NOT coerced to the schema's types; the handler sees what was sent. */
  params: Record<string, string>;
}

export function matchRoute(ops: OpSpec[], method: string, rawPath: string): Match | null {
  const [pathOnly = '', query = ''] = rawPath.split('?');
  const got = segments(pathOnly);

  for (const spec of ops) {
    if (spec.method !== method) continue;
    const params = matchPath(segments(spec.path), got);
    if (params !== null) {
      return { spec, params: { ...params, ...Object.fromEntries(new URLSearchParams(query)) } };
    }
  }
  return null;
}

/** The captured `{placeholders}`, or null when this route is not the one. */
function matchPath(want: string[], got: string[]): Record<string, string> | null {
  if (want.length !== got.length) return null;

  const params: Record<string, string> = {};
  for (const [i, segment] of want.entries()) {
    const actual = got[i]!;
    if (isPlaceholder(segment)) params[segment.slice(1, -1)] = decodeURIComponent(actual);
    else if (segment !== actual) return null;
  }
  return params;
}

const isPlaceholder = (segment: string): boolean => segment.startsWith('{') && segment.endsWith('}');

const segments = (path: string): string[] => path.split('/').filter((s) => s !== '');

const pathParams = (path: string): string[] =>
  segments(path)
    .filter((s) => s.startsWith('{') && s.endsWith('}'))
    .map((s) => s.slice(1, -1));

// ---- OpenAPI ---------------------------------------------------------------

export function openApiDoc(manifest: Manifest): Json {
  const paths: Record<string, Record<string, Json>> = {};
  for (const spec of manifest.ops) {
    // Several methods can share one path, so the entry is created on first use.
    const methods = paths[spec.path] ?? {};
    methods[spec.method.toLowerCase()] = operation(spec);
    paths[spec.path] = methods;
  }
  return {
    openapi: '3.1.0',
    info: { title: manifest.title, version: manifest.version },
    paths: paths as unknown as Json,
  };
}

function operation(spec: OpSpec): Json {
  const schema = (spec.input ?? {}) as { properties?: Record<string, Json>; required?: string[] };
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  const inPath = pathParams(spec.path);
  const rest = Object.entries(properties).filter(([name]) => !inPath.includes(name));
  const carriesBody = spec.method !== 'GET' && spec.method !== 'DELETE';

  const parameters: Json[] = inPath.map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: properties[name] ?? { type: 'string' },
  }));
  if (!carriesBody) {
    for (const [name, s] of rest) {
      parameters.push({ name, in: 'query', required: required.includes(name), schema: s });
    }
  }

  const op: Record<string, Json> = { operationId: spec.op, summary: spec.summary };
  if (parameters.length > 0) op['parameters'] = parameters;
  if (carriesBody && rest.length > 0) {
    op['requestBody'] = {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: Object.fromEntries(rest),
            required: required.filter((name) => !inPath.includes(name)),
            additionalProperties: false,
          },
        },
      },
    };
  }
  op['responses'] = {
    default: { description: 'A JSON envelope: {"status": <http status>, "body": <payload>}' },
  };
  return op;
}

const specPrompt = (manifest: Manifest): string =>
  `You reach the ${manifest.title} with the \`http_request\` tool. This is its OpenAPI ` +
  `specification — the only operations that exist are the ones listed here:\n\n` +
  '```json\n' +
  `${JSON.stringify(openApiDoc(manifest), null, 2)}\n` +
  '```';

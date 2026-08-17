/**
 * HTTP in front of `LocalState`. An adapter, not a second implementation — which
 * is why the two modes cannot drift: the HTTP path is two extra hops around the
 * same object.
 *
 * Everything arriving here came off a wire and is therefore untrusted, including
 * when we wrote the client ourselves. A field that is merely missing must not
 * become an empty batch that reports success.
 */
import { LocalState } from './local.ts';
import { endpointOf, listen } from '../net/listen.ts';
import { BadRequestError } from '../errors.ts';
import type { Address, BunServer, Endpoint } from '../net/listen.ts';
import type { WorldRegistry } from '../core/registry.ts';
import type { Statement } from '../types.ts';

type Body = Record<string, unknown>;

const text = (status: number, message: string): Response => new Response(message, { status });

export class StateServer {
  private server: BunServer | null = null;
  private endpoint: Endpoint | null = null;

  constructor(private readonly registry: WorldRegistry) {}

  get address(): Endpoint {
    if (!this.endpoint) throw new Error('state server not started');
    return this.endpoint;
  }

  start(addr: Address = { kind: 'tcp' }): Endpoint {
    if (this.server) throw new Error('state server already started');
    this.server = listen((req) => this.route(req), addr);
    this.endpoint = endpointOf(this.server, addr);
    return this.endpoint;
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
    this.endpoint = null;
  }

  private async route(req: Request): Promise<Response> {
    try {
      return await this.dispatch(req);
    } catch (e) {
      // Both a malformed request and a rejected statement come back as 400 with
      // the plain reason. The second of those is the point: a failed batch is the
      // world answering, and the handler must see exactly the message it would
      // have caught in-process. Anything that is not an Error is our own bug.
      if (e instanceof Error) return text(400, e.message);
      return text(500, `state server: ${String(e)}`);
    }
  }

  private async dispatch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === '/health') return Response.json({ ok: true });
    if (req.method !== 'POST') return text(405, 'method not allowed');
    if (path !== '/query' && path !== '/exec') return text(404, `no such route: ${path}`);

    const body = await readJsonObject(req);
    const state = new LocalState(this.registry.get(requireString(body, 'session')));

    return path === '/query'
      ? Response.json({ rows: await state.query(requireString(body, 'sql'), readParams(body['params'])) })
      : Response.json(await state.exec(readStatements(body['statements'])));
  }
}

async function readJsonObject(req: Request): Promise<Body> {
  let value: unknown;
  try {
    value = await req.json();
  } catch (e) {
    throw new BadRequestError(`body is not JSON: ${(e as Error).message}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestError('body must be a JSON object');
  }
  return value as Body;
}

function requireString(body: Body, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value === '') {
    throw new BadRequestError(`${field} must be a non-empty string`);
  }
  return value;
}

function readParams(value: unknown, where = 'params'): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new BadRequestError(`${where} must be an array`);
  return value;
}

/** An absent or malformed batch must fail, never quietly become an empty one. */
function readStatements(value: unknown): Statement[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequestError('statements must be a non-empty array');
  }
  return value.map((raw, i) => {
    const s = raw as Partial<Statement> | null;
    if (s === null || typeof s !== 'object' || typeof s.sql !== 'string' || s.sql === '') {
      throw new BadRequestError(`statements[${i}].sql must be a non-empty string`);
    }
    return { sql: s.sql, params: readParams(s.params, `statements[${i}].params`) };
  });
}

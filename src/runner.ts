/**
 * init → call* → close.
 *
 * `call` is repeatable from the start because steps are nothing more than several
 * calls with the clock moved between them. That is the only thing this file should
 * have to grow.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorldRegistry } from './core/registry.ts';
import { replayVerify } from './core/world.ts';
import { StateServer } from './state/server.ts';
import { FunctionHandler } from './handler/fn.ts';
import { HttpHandler } from './handler/http.ts';
import { handlerCommand } from './handler/launch.ts';
import { FixtureError } from './errors.ts';
import type { Verification, World, WorldSpec } from './core/world.ts';
import type { Address, Endpoint } from './net/listen.ts';
import type { AuditRow, Clock, HandlerPort, HandlerRequest, HandlerResponse, JournalRow } from './types.ts';

export type Mode = 'fn' | 'http';

export interface InitSpec {
  mode: Mode;
  /** folder holding schema.sql, seed.sql, domain.ts, serve.ts */
  fixture: string;
  session: string;
  clock: Clock;
  /** ':memory:' by default */
  dbPath?: string;
  /** http mode: where the state server listens. An OS-chosen TCP port by default. */
  stateAddress?: Address;
  /** http mode: fix the handler's port instead of picking a free one. */
  handlerPort?: number;
  /** http mode: where the handler's own output is written, one file per episode. */
  handlerLog?: string;
  /**
   * http mode: attach to a handler ALREADY running instead of spawning one —
   * one under a debugger, or a long-lived service.
   *
   * The caller owns that process: we never kill it. It must already point at our
   * state server, so pin `stateAddress` to a known address and start the handler
   * with the matching STATE_URL before calling this.
   */
  handlerUrl?: string;
}

export interface Session {
  spec: InitSpec;
  worldSpec: WorldSpec;
  world: World;
  handler: HandlerPort;
  registry: WorldRegistry;
  stateServer: StateServer | null;
  /** where the handler was told to reach the world; null in `fn` mode */
  state: Endpoint | null;
  calls: number;
  /** Which step is running. Written into every journal and audit row. */
  step: number;
  closed: boolean;
}

export interface CallResult {
  response: HandlerResponse;
  journal: JournalRow[];
  audit: AuditRow[];
}

export async function init(spec: InitSpec): Promise<Session> {
  const dir = resolve(spec.fixture);
  const worldSpec = await loadFixture(dir, spec);
  const registry = new WorldRegistry();
  const world = registry.open(worldSpec);

  let stateServer: StateServer | null = null;
  let handler: HandlerPort;

  try {
    if (spec.mode === 'http') {
      stateServer = new StateServer(registry);
      const state = stateServer.start(spec.stateAddress ?? { kind: 'tcp' });
      handler =
        spec.handlerUrl !== undefined
          ? HttpHandler.attach(spec.handlerUrl)
          : await spawnHandler(dir, spec, state);
    } else {
      handler = await FunctionHandler.load(resolve(dir, 'domain.ts'), registry);
    }
  } catch (e) {
    // A failure here used to leak: the state server stayed bound and the world
    // stayed open, with nothing left holding a handle to close either.
    stateServer?.stop();
    registry.closeAll();
    throw e;
  }

  return {
    spec,
    worldSpec,
    world,
    handler,
    registry,
    stateServer,
    state: stateServer?.address ?? null,
    calls: 0,
    step: 0,
    closed: false,
  };
}

/** One request through whichever seam this session was built with. */
export async function call(
  s: Session,
  req: Omit<HandlerRequest, 'session' | 'call' | 'clock'> & { clock?: Clock }
): Promise<CallResult> {
  if (s.closed) throw new Error(`session ${s.spec.session} is closed`);

  s.calls += 1;
  if (req.clock) s.world.setClock(req.clock);
  // The principal already says who is acting, so the audit inherits it rather
  // than the caller having to remember to set it twice.
  s.world.setContext(s.step, s.calls, req.principal.kind);

  const request: HandlerRequest = {
    session: s.spec.session,
    call: s.calls,
    clock: s.world.clock(),
    op: req.op,
    input: req.input,
    principal: req.principal,
  };

  const response = await s.handler.call(request);
  return { response, journal: s.world.journalRows(), audit: s.world.auditRows() };
}

/** The determinism check: replay the journal's writes and compare the audit. */
export function verify(s: Session): Verification {
  return replayVerify(s.worldSpec, s.world.journalRows(), s.world.auditRows());
}

/**
 * Every step runs even when an earlier one throws. A handler that dies badly must
 * not strand a bound port or an open database behind it.
 */
export async function close(s: Session): Promise<void> {
  if (s.closed) return;
  s.closed = true;

  const failures: string[] = [];
  const attempt = async (what: string, fn: () => unknown): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      failures.push(`${what}: ${(e as Error).message}`);
    }
  };

  await attempt('handler', () => s.handler.close());
  await attempt('state server', () => s.stateServer?.stop());
  await attempt('worlds', () => s.registry.closeAll());

  if (failures.length > 0) throw new Error(`close was incomplete — ${failures.join('; ')}`);
}

// ---- init helpers ---------------------------------------------------------

async function loadFixture(dir: string, spec: InitSpec): Promise<WorldSpec> {
  if (!existsSync(dir)) throw new FixtureError(`no fixture directory: ${dir}`);

  const schemaSql = await requiredFile(resolve(dir, 'schema.sql'));
  const seedSql = await optionalFile(resolve(dir, 'seed.sql'));

  return {
    session: spec.session,
    path: spec.dbPath ?? ':memory:',
    schemaSql,
    ...(seedSql !== undefined ? { seedSql } : {}),
    clock: spec.clock,
  };
}

async function requiredFile(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new FixtureError(`${path} is required and was not found`);
  return await file.text();
}

async function optionalFile(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : undefined;
}

/** The child is told where the world is; it never learns anything else about us. */
function spawnHandler(dir: string, spec: InitSpec, state: Endpoint): Promise<HttpHandler> {
  return HttpHandler.spawn({
    // Whatever this fixture is written in. Hardcoding `bun run serve.ts` meant a
    // Python handler could be scaffolded and never launched.
    cmd: handlerCommand(dir),
    cwd: dir,
    env: { STATE_URL: state.url, ...(state.unix !== undefined ? { STATE_SOCK: state.unix } : {}) },
    ...(spec.handlerPort !== undefined ? { port: spec.handlerPort } : {}),
    ...(spec.handlerLog !== undefined ? { logTo: spec.handlerLog } : {}),
  });
}

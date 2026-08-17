/** The handler as an HTTP server, in any language. The runner may spawn it or
 *  attach to one already running. */
import { isAddrInUse, pickPort } from '../net/listen.ts';
import { HandlerError } from '../errors.ts';
import type { Subprocess } from 'bun';
import type { HandlerPort, HandlerRequest, HandlerResponse } from '../types.ts';

export interface SpawnSpec {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Fix the port instead of picking a free one. Also disables the retry, since a
   *  demanded port that is taken is a fact to report rather than route around. */
  port?: number;
  attempts?: number;
  timeoutMs?: number;
  /**
   * Where the child's output goes.
   *
   * Inherited output from eight concurrent handlers interleaves into whatever the
   * runner is printing. Discarding it is worse: a handler's stderr is how "it
   * blew up at startup" gets diagnosed. So it goes to a file per episode.
   */
  logTo?: string;
}

export class HttpHandler implements HandlerPort {
  private constructor(
    private readonly baseUrl: string,
    private proc: Subprocess | null,
    /** Kept so the handler can be brought back on the SAME port: a restart that
     *  moved would not be a restart, it would be a different deployment. */
    private readonly spec: SpawnSpec | null = null
  ) {}

  private log: { path: string; text: Promise<[string, string]> } | null = null;

  static attach(baseUrl: string): HttpHandler {
    return new HttpHandler(baseUrl, null);
  }

  /** Kill the process and leave it dead. Calls now fail at the transport, which
   *  is what an API going down actually looks like from a caller. */
  kill(): void {
    this.proc?.kill();
    this.proc = null;
  }

  async restart(): Promise<void> {
    if (this.spec === null) throw new HandlerError('restart', 'this handler was attached, not spawned');
    this.kill();
    const port = Number(new URL(this.baseUrl).port);
    const revived = await HttpHandler.bootOnce({ ...this.spec, port }, port);
    this.proc = revived.proc;
  }

  /**
   * Spawn a handler process on a free port and wait until it answers /health.
   *
   * `pickPort` releases the port before the child binds it, so a collision is
   * always possible however carefully we choose — which is why this retries on a
   * fresh port rather than trying to choose better.
   */
  static async spawn(spec: SpawnSpec): Promise<HttpHandler> {
    const attempts = spec.port !== undefined ? 1 : Math.max(1, spec.attempts ?? 3);
    let last: unknown;

    for (let i = 0; i < attempts; i++) {
      const port = spec.port ?? pickPort();
      try {
        return await HttpHandler.bootOnce(spec, port);
      } catch (e) {
        last = e;
        // A child that died because its port was taken leaves that port held by
        // whoever won it; a child that died of its own bug leaves it free. Binding
        // it ourselves tells the two apart, so a genuinely broken handler fails
        // once and says so, instead of failing three times and blaming the port.
        if (portIsFree(port)) break;
      }
    }
    throw last instanceof Error
      ? last
      : new HandlerError('spawn', `handler did not start after ${attempts} attempts`);
  }

  async call(request: HandlerRequest): Promise<HandlerResponse> {
    const res = await this.send(request);
    const text = await res.text();

    if (!res.ok) throw new HandlerError(request.op, describe(text, res.status));
    try {
      return JSON.parse(text) as HandlerResponse;
    } catch (e) {
      throw new HandlerError(request.op, `reply was not JSON: ${text.slice(0, 200)}`, { cause: e });
    }
  }

  async close(): Promise<void> {
    this.proc?.kill();
    this.proc = null;
    if (this.log !== null) {
      await writeLog(this.log.path, await this.log.text);
      this.log = null;
    }
  }

  private async send(request: HandlerRequest): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}/call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
    } catch (e) {
      const died = this.proc && this.proc.exitCode !== null ? ` (process exited ${this.proc.exitCode})` : '';
      throw new HandlerError(request.op, `handler unreachable at ${this.baseUrl}${died}: ${(e as Error).message}`, {
        cause: e,
      });
    }
  }

  private static async bootOnce(spec: SpawnSpec, port: number): Promise<HttpHandler> {
    const baseUrl = `http://127.0.0.1:${port}`;
    const captured = spec.logTo !== undefined;
    const proc = Bun.spawn(spec.cmd, {
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      env: { ...process.env, ...spec.env, HANDLER_PORT: String(port) },
      stdout: captured ? 'pipe' : 'inherit',
      stderr: captured ? 'pipe' : 'inherit',
    });

    // Drained immediately, not at exit: an undrained pipe fills and the child
    // blocks on its own next print, which looks exactly like a hung handler.
    const drained = captured
      ? Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      : null;

    try {
      await waitForHealth(proc, baseUrl, spec.timeoutMs ?? 10_000);
    } catch (e) {
      proc.kill();
      if (drained !== null && spec.logTo !== undefined) await writeLog(spec.logTo, await drained);
      throw e;
    }

    const handler = new HttpHandler(baseUrl, proc, spec);
    if (drained !== null && spec.logTo !== undefined) handler.log = { path: spec.logTo, text: drained };
    return handler;
  }
}

/**
 * Poll /health, but watch the process too. A handler that dies at startup — a
 * syntax error, a port it could not bind — used to burn the whole timeout and
 * then blame the health check, naming the symptom instead of the cause.
 */
async function waitForHealth(proc: Subprocess, baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (proc.exitCode !== null) {
      throw new HandlerError('spawn', `process exited with code ${proc.exitCode} before answering ${baseUrl}/health`);
    }
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      throw new HandlerError('spawn', `no answer from ${baseUrl}/health within ${timeoutMs}ms`);
    }
    await Bun.sleep(25);
  }
}

/** Both streams, in one file per episode. Nothing written when the child was quiet. */
async function writeLog(path: string, streams: [string, string]): Promise<void> {
  const body = streams.filter((s) => s !== '').join('\n');
  if (body !== '') await Bun.write(path, body);
}

/** Can we take this port right now? Used to tell a lost race from a broken child. */
function portIsFree(port: number): boolean {
  try {
    Bun.serve({ port, fetch: () => new Response(null, { status: 503 }) }).stop(true);
    return true;
  } catch (e) {
    if (isAddrInUse(e)) return false;
    throw e;
  }
}

/**
 * Unwrap the structured error a handler returns when it throws, so that a thrown
 * handler produces the same message here as it does in `fn` mode.
 */
function describe(text: string, status: number): string {
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } };
    const message = body.error?.message;
    if (typeof message === 'string') return message;
  } catch {
    /* not our shape — fall through to the raw body */
  }
  return `HTTP ${status}: ${text.slice(0, 300)}`;
}

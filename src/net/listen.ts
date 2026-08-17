/**
 * Binding, and what to do when the address is already taken.
 *
 * Both transports fail the same way — a synchronous throw carrying
 * `code === 'EADDRINUSE'` — so one predicate and one retry loop serve both.
 *
 * TCP is the default because it is the only transport every language reaches on
 * every platform. Measured on Bun 1.3.14 / Windows 11: a unix socket here is a
 * real AF_UNIX socket that curl can reach, but Python on Windows cannot speak to
 * one at all (`socket.AF_UNIX` does not exist), and Python is the common case for
 * handlers in another language. Unix is therefore opt-in, where it earns its keep
 * on POSIX by sidestepping port collision entirely.
 */
/** `Server` is generic in bun-types; this is the shape `Bun.serve` actually hands back. */
export type BunServer = ReturnType<typeof Bun.serve>;

export type Address = { kind: 'tcp'; port?: number } | { kind: 'unix'; path: string };

/** Where a client should send. `unix` is passed straight to `fetch`. */
export interface Endpoint {
  url: string;
  unix?: string;
}

type Fetch = (req: Request) => Response | Promise<Response>;

export const isAddrInUse = (e: unknown): boolean =>
  (e as { code?: string } | null | undefined)?.code === 'EADDRINUSE';

/**
 * Bind, stepping to the next port when one is taken.
 *
 * A TCP address with no port asks the OS to choose, which cannot collide and so
 * needs no retry. An explicit port is a preference rather than a demand: two
 * episodes running side by side would otherwise fight over it.
 *
 * A unix address has nothing to step to — the path IS the address — so a taken
 * one is reported instead of worked around.
 */
export function listen(fetch: Fetch, addr: Address = { kind: 'tcp' }, attempts = 20): BunServer {
  if (addr.kind === 'unix') return listenUnix(fetch, addr.path);

  const from = addr.port ?? 0;
  const tries = from === 0 ? 1 : Math.max(1, attempts);
  for (let i = 0; i < tries; i++) {
    try {
      return Bun.serve({ port: from + i, fetch });
    } catch (e) {
      if (!isAddrInUse(e)) throw e;
    }
  }
  throw new Error(`no free port in ${from}..${from + tries - 1}`);
}

function listenUnix(fetch: Fetch, path: string): BunServer {
  try {
    return Bun.serve({ unix: path, fetch });
  } catch (e) {
    if (!isAddrInUse(e)) throw e;
    // Note for whoever adds stale-socket cleanup here: `Bun.file(path).exists()`
    // reports FALSE for a live socket file and `node:fs.statSync` throws EACCES,
    // so the obvious "unlink it if it is there" guard silently never fires.
    throw new Error(`socket already in use: ${path}`, { cause: e });
  }
}

export const endpointOf = (server: BunServer, addr: Address): Endpoint =>
  addr.kind === 'unix'
    ? { url: 'http://localhost', unix: addr.path }
    : { url: `http://127.0.0.1:${server.port}` };

/**
 * A port to hand to a child process, since it cannot tell us which one it took
 * without us parsing its output.
 *
 * Bind zero, read what the OS gave, release it. Inherently racy — the gap between
 * release and the child's bind is real — so callers retry rather than trust it.
 */
export function pickPort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 503 }) });
  const { port } = s;
  s.stop(true);
  if (port === undefined) throw new Error('could not reserve a port: the OS reported none');
  return port;
}

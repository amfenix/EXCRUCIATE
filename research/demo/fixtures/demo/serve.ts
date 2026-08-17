/**
 * The HTTP face of the demo handler. A wrapper, not a second implementation: it
 * builds an HttpState for the session and calls the same `handle`.
 *
 * A handler in Go or Python would be exactly this much code plus an HTTP client.
 */
import { handle } from './domain.ts';
import { HttpState } from '../../../../src/state/http.ts';
import type { Endpoint } from '../../../../src/net/listen.ts';
import type { HandlerRequest } from '../../../../src/types.ts';

const port = Number(process.env['HANDLER_PORT'] ?? 0);
const url = process.env['STATE_URL'];
if (!url) throw new Error('STATE_URL is required');

// STATE_SOCK is set only when the runner is on a unix socket; over TCP the URL is
// the whole story. Either way the handler reads two env vars and branches on none.
const sock = process.env['STATE_SOCK'];
const state: Endpoint = { url, ...(sock !== undefined ? { unix: sock } : {}) };

Bun.serve({
  port,
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (path === '/health') return Response.json({ ok: true });
    if (path !== '/call') return new Response('not found', { status: 404 });

    try {
      const request = (await req.json()) as HandlerRequest;
      // The session from the request is the same key used for every state call —
      // same key in, same key out.
      return Response.json(await handle(request, new HttpState(state, request.session)));
    } catch (e) {
      // A structured body, not a bare string: the runner unwraps `error.message`
      // and raises the same HandlerError that `fn` mode raises, so a handler bug
      // reads identically whichever way the handler happened to be wired up.
      return Response.json({ error: { message: (e as Error).message } }, { status: 500 });
    }
  },
});

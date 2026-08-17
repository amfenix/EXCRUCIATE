/** The handler as a loaded function. No transport, no processes — the fast path
 *  for case development and the conformance suite. */
import { LocalState } from '../state/local.ts';
import { scanForBanned } from '../core/stopwords.ts';
import { FixtureError, HandlerError } from '../errors.ts';
import type { WorldRegistry } from '../core/registry.ts';
import type { HandlerFn, HandlerPort, HandlerRequest, HandlerResponse } from '../types.ts';

export class FunctionHandler implements HandlerPort {
  private constructor(
    private readonly fn: HandlerFn,
    /**
     * The REGISTRY, not one world. Binding a single world at construction made
     * this handler serve exactly one session for its whole life, while the http
     * handler resolved the session per request — so the two seams behaved
     * differently for no reason, and fn mode could never be shared.
     */
    private readonly registry: WorldRegistry
  ) {}

  /** The source is scanned before it is imported: a handler that would reach for
   *  wall-clock time is rejected before it can run once. */
  static async load(modulePath: string, registry: WorldRegistry): Promise<FunctionHandler> {
    const file = Bun.file(modulePath);
    if (!(await file.exists())) throw new FixtureError(`no handler module at ${modulePath}`);
    scanForBanned(await file.text(), modulePath);

    let mod: { handle?: unknown };
    try {
      mod = (await import(modulePath)) as { handle?: unknown };
    } catch (e) {
      // An import that throws is the handler's own top-level code failing, and the
      // stack alone rarely says which module it came from.
      throw new FixtureError(`${modulePath} failed to load: ${(e as Error).message}`, { cause: e });
    }

    if (typeof mod.handle !== 'function') {
      throw new FixtureError(`${modulePath} does not export a \`handle\` function`);
    }
    return new FunctionHandler(mod.handle as HandlerFn, registry);
  }

  async call(request: HandlerRequest): Promise<HandlerResponse> {
    try {
      // Same rule as the wire: the session in the request picks the world.
      return await this.fn(request, new LocalState(this.registry.get(request.session)));
    } catch (e) {
      // http mode turns a thrown handler into a 500 that the runner re-raises as a
      // HandlerError. Both modes must produce the same error, or a handler bug
      // reads differently depending on wiring that has nothing to do with it.
      throw new HandlerError(request.op, (e as Error).message, { cause: e });
    }
  }

  async close(): Promise<void> {}
}

/** session -> World. Concurrency is nothing more than distinct keys. */
import { World } from './world.ts';
import type { WorldSpec } from './world.ts';

export class WorldRegistry {
  private readonly worlds = new Map<string, World>();

  open(spec: WorldSpec): World {
    if (this.worlds.has(spec.session)) throw new Error(`session already open: ${spec.session}`);
    const w = World.open(spec);
    this.worlds.set(spec.session, w);
    return w;
  }

  get(session: string): World {
    const w = this.worlds.get(session);
    // A request carrying an unknown session is a bug worth naming loudly, not a
    // reason to invent a world on the fly.
    if (!w) throw new Error(`no open session: ${session}`);
    return w;
  }

  close(session: string): void {
    this.worlds.get(session)?.close();
    this.worlds.delete(session);
  }

  closeAll(): void {
    for (const s of [...this.worlds.keys()]) this.close(s);
  }
}

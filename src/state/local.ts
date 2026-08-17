/** StatePort straight onto a World. The `fn` mode uses this directly; the HTTP
 *  state server is an adapter over it, so both modes share one implementation. */
import type { World } from '../core/world.ts';
import type { ExecResult, Row, Statement, StatePort } from '../types.ts';

export class LocalState implements StatePort {
  constructor(private readonly world: World) {}

  async query(sql: string, params: unknown[] = []): Promise<Row[]> {
    return this.world.query(sql, params);
  }

  async exec(statements: Statement[]): Promise<ExecResult> {
    return this.world.exec(statements);
  }
}

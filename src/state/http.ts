/** StatePort over HTTP. This one lives in the HANDLER's process — it is what a
 *  handler in any language would implement to reach the world. */
import { StateError } from '../errors.ts';
import type { Endpoint } from '../net/listen.ts';
import type { ExecResult, Row, Statement, StatePort } from '../types.ts';

export class HttpState implements StatePort {
  private readonly endpoint: Endpoint;

  /** A bare URL string is accepted so a handler can pass `STATE_URL` straight in. */
  constructor(
    endpoint: Endpoint | string,
    private readonly session: string
  ) {
    this.endpoint = typeof endpoint === 'string' ? { url: endpoint } : endpoint;
  }

  async query(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.post<{ rows: Row[] }>('/query', { sql, params })).rows;
  }

  async exec(statements: Statement[]): Promise<ExecResult> {
    return await this.post<ExecResult>('/exec', { statements });
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.send(path, body);
    const text = await res.text();

    // A 400 IS the domain error — a rejected statement, a failed batch — and the
    // handler must see exactly what it would see in-process. Adding transport
    // framing here made the same failure read differently in the two modes, which
    // is the leak the equivalence test was written to catch.
    if (res.status === 400) throw new Error(text);
    if (!res.ok) throw new StateError(`state ${path} returned ${res.status}: ${text.slice(0, 300)}`);

    try {
      return JSON.parse(text) as T;
    } catch (e) {
      throw new StateError(`state ${path} did not return JSON: ${text.slice(0, 200)}`, { cause: e });
    }
  }

  private async send(path: string, body: Record<string, unknown>): Promise<Response> {
    try {
      return await fetch(`${this.endpoint.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: this.session, ...body }),
        ...(this.endpoint.unix !== undefined ? { unix: this.endpoint.unix } : {}),
      });
    } catch (e) {
      // A dead state server otherwise surfaces as a bare `Unable to connect`,
      // which names neither the seam nor the session that lost its world.
      throw new StateError(
        `state server unreachable at ${this.endpoint.url}${path} (session ${this.session}): ${(e as Error).message}`,
        { cause: e }
      );
    }
  }
}

/** The contracts. Two seams, and the shapes that cross them. */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Row = Record<string, unknown>;

export interface Clock {
  now: string;
  business_day: number;
}

/** Same key in, same key out — the session ties a request to its world. */
export interface HandlerRequest {
  session: string;
  call: number;
  op: string;
  input: Json;
  /** Authoritative. Also readable as `SELECT now FROM _clock`. */
  clock: Clock;
  principal: { id: string; kind: 'agent' | 'system' };
}

export interface HandlerResponse {
  status: number;
  body?: Json;
  schedule?: Array<{ after?: string; at?: string; op: string; input?: Json }>;
}

export interface Statement {
  sql: string;
  params?: unknown[];
}

export interface ExecResult {
  batch: number;
  changes: number[];
}

/** How the handler reaches the world. The only interface it depends on. */
export interface StatePort {
  query(sql: string, params?: unknown[]): Promise<Row[]>;
  exec(statements: Statement[]): Promise<ExecResult>;
}

/** How the runner reaches the handler. */
export interface HandlerPort {
  call(request: HandlerRequest): Promise<HandlerResponse>;
  close(): Promise<void>;
  /** Process death, for handlers that HAVE a process. `fn` mode has none, and
   *  saying so loudly beats a silent no-op that looks like a survived outage. */
  kill?(): void;
  restart?(): Promise<void>;
}

/** A handler is this function. `serve.ts` wraps it; `fn` mode calls it directly. */
export type HandlerFn = (req: HandlerRequest, state: StatePort) => Promise<HandlerResponse>;

/** Who caused a change. `seed` is the fixture, `system` is us, `agent` is the model. */
export type Actor = 'seed' | 'agent' | 'system';

export interface JournalRow {
  seq: number;
  session: string;
  step: number;
  call: number;
  batch: number | null;
  kind: 'query' | 'exec';
  sql: string;
  params: string;
  rows: number | null;
  error: string | null;
  actor: Actor;
  t_virtual: string;
}

export interface AuditRow {
  seq: number;
  session: string;
  step: number;
  call: number;
  tbl: string;
  rowid_: number;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  before: string | null;
  after: string | null;
  actor: Actor;
  t_virtual: string;
}

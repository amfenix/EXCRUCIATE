/**
 * Everything arriving at the state server came off a wire, so it is untrusted
 * even though we wrote the client. The cases that matter most are the ones where
 * a malformed request could SUCCEED — a missing `statements` becoming an empty
 * batch that reports done.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { WorldRegistry } from '../src/core/registry.ts';
import { StateServer } from '../src/state/server.ts';

const SCHEMA = `CREATE TABLE accounts (id TEXT PRIMARY KEY, balance INTEGER NOT NULL CHECK (balance >= 0));`;

let registry: WorldRegistry;
let server: StateServer;
let url: string;

beforeAll(() => {
  registry = new WorldRegistry();
  registry.open({
    session: 's1',
    path: ':memory:',
    schemaSql: SCHEMA,
    seedSql: `INSERT INTO accounts VALUES ('A', 100);`,
    clock: { now: '2026-08-18 09:12:00', business_day: 1 },
  });
  server = new StateServer(registry);
  url = server.start().url;
});

afterAll(() => {
  server.stop();
  registry.closeAll();
});

const post = async (path: string, body: string): Promise<{ status: number; text: string }> => {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return { status: res.status, text: await res.text() };
};

const json = (body: unknown): string => JSON.stringify(body);

describe('routing', () => {
  test('health needs no body and no session', async () => {
    const res = await fetch(`${url}/health`);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('a GET on a write route is refused', async () => {
    expect((await fetch(`${url}/exec`)).status).toBe(405);
  });

  test('an unknown route says which one', async () => {
    const r = await post('/nope', json({ session: 's1' }));
    expect(r.status).toBe(404);
    expect(r.text).toContain('/nope');
  });
});

describe('a malformed request never succeeds quietly', () => {
  // This escaped the try block entirely and surfaced as an unhandled throw.
  test('a body that is not JSON is a 400, not a crash', async () => {
    const r = await post('/query', '{not json');
    expect(r.status).toBe(400);
    expect(r.text).toContain('body is not JSON');
  });

  test('a JSON array is not a request body', async () => {
    const r = await post('/query', json([1, 2]));
    expect(r.status).toBe(400);
    expect(r.text).toContain('must be a JSON object');
  });

  test('a missing session is named', async () => {
    const r = await post('/query', json({ sql: 'SELECT 1' }));
    expect(r.status).toBe(400);
    expect(r.text).toContain('session must be a non-empty string');
  });

  test('an unknown session is refused rather than invented', async () => {
    const r = await post('/query', json({ session: 'ghost', sql: 'SELECT 1' }));
    expect(r.status).toBe(400);
    expect(r.text).toContain('no open session: ghost');
  });

  // It used to run `''` as SQL and answer with an empty result.
  test('a missing sql is named instead of run as empty', async () => {
    const r = await post('/query', json({ session: 's1' }));
    expect(r.status).toBe(400);
    expect(r.text).toContain('sql must be a non-empty string');
  });

  test('params must be an array', async () => {
    const r = await post('/query', json({ session: 's1', sql: 'SELECT 1', params: { a: 1 } }));
    expect(r.status).toBe(400);
    expect(r.text).toContain('params must be an array');
  });

  // The worst of them: a malformed batch reported SUCCESS as an empty one.
  test('a missing statements list fails rather than becoming an empty batch', async () => {
    const r = await post('/exec', json({ session: 's1' }));
    expect(r.status).toBe(400);
    expect(r.text).toContain('statements must be a non-empty array');
  });

  test('an empty statements list is refused too', async () => {
    const r = await post('/exec', json({ session: 's1', statements: [] }));
    expect(r.status).toBe(400);
    expect(r.text).toContain('non-empty array');
  });

  test('a statement without sql names its index', async () => {
    const r = await post('/exec', json({ session: 's1', statements: [{ sql: 'SELECT 1' }, { params: [] }] }));
    expect(r.status).toBe(400);
    expect(r.text).toContain('statements[1].sql');
  });
});

describe('the world answering is not a transport failure', () => {
  test('a query returns rows', async () => {
    const r = await post('/query', json({ session: 's1', sql: 'SELECT id, balance FROM accounts' }));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ rows: [{ id: 'A', balance: 100 }] });
  });

  // A rejected batch comes back as 400 carrying SQLite's own words, so the handler
  // catches exactly the message it would have caught in-process.
  test('a failed batch returns the reason verbatim', async () => {
    const r = await post(
      '/exec',
      json({ session: 's1', statements: [{ sql: `UPDATE accounts SET balance = -1 WHERE id = 'A'` }] })
    );
    expect(r.status).toBe(400);
    expect(r.text).toContain('CHECK constraint failed');
  });
});

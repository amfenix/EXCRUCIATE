/**
 * What happens when things go wrong.
 *
 * Two themes: a failure must NAME its cause, and a failure must not leave
 * anything behind — a bound port, an open database, a live child process.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { call, close, init } from '../src/runner.ts';
import { World } from '../src/core/world.ts';
import { WorldRegistry } from '../src/core/registry.ts';
import { StateServer } from '../src/state/server.ts';
import { FixtureError } from '../src/errors.ts';
import { isAddrInUse, listen } from '../src/net/listen.ts';
import type { Session } from '../src/runner.ts';
import type { WorldSpec } from '../src/core/world.ts';

const CLOCK = { now: '2026-08-18 09:12:00', business_day: 1 };
const SCHEMA = `CREATE TABLE accounts (id TEXT PRIMARY KEY, balance INTEGER NOT NULL CHECK (balance >= 0));`;

const spec = (over: Partial<WorldSpec> = {}): WorldSpec => ({
  session: 'f1',
  path: ':memory:',
  schemaSql: SCHEMA,
  clock: CLOCK,
  ...over,
});

const dirs: string[] = [];
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'excruciate-fx-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const portOf = (url: string): number => Number(new URL(url).port);

function portIsFree(port: number): boolean {
  try {
    listen(() => new Response(null, { status: 503 }), { kind: 'tcp', port }, 1).stop(true);
    return true;
  } catch (e) {
    if (isAddrInUse(e)) return false;
    throw e;
  }
}

describe('a broken research folder says which file', () => {
  test('a missing directory', async () => {
    const dir = join(tmpdir(), 'excruciate-does-not-exist-12345');
    await expect(init({ mode: 'fn', fixture: dir, session: 'x', clock: CLOCK })).rejects.toThrow(
      `no fixture directory: ${dir}`
    );
  });

  test('a directory without schema.sql', async () => {
    const dir = fixture({ 'seed.sql': `SELECT 1;` });
    await expect(init({ mode: 'fn', fixture: dir, session: 'x', clock: CLOCK })).rejects.toThrow(
      'schema.sql is required and was not found'
    );
  });

  test('a directory without domain.ts, in fn mode', async () => {
    const dir = fixture({ 'schema.sql': SCHEMA });
    await expect(init({ mode: 'fn', fixture: dir, session: 'x', clock: CLOCK })).rejects.toThrow('no handler module at');
  });

  // SQLite's own message says nothing about where the SQL came from.
  test('a schema that will not apply names schema.sql', () => {
    expect(() => World.open(spec({ schemaSql: `CREATE TABL oops (a TEXT)` }))).toThrow(FixtureError);
    expect(() => World.open(spec({ schemaSql: `CREATE TABL oops (a TEXT)` }))).toThrow('schema.sql did not apply');
  });

  test('a seed that will not apply names seed.sql', () => {
    expect(() => World.open(spec({ seedSql: `INSERT INTO nowhere VALUES (1)` }))).toThrow('seed.sql did not apply');
  });
});

describe('an empty batch is a caller bug', () => {
  // It used to journal nothing and return success, which reads later as work done.
  test('exec with no statements is refused', () => {
    const w = World.open(spec());
    expect(() => w.exec([])).toThrow('at least one statement');
    expect(w.journalRows().length).toBe(0);
    w.close();
  });
});

describe('a handler that dies at startup', () => {
  test('fails fast, with the exit code, not a health-check timeout', async () => {
    const dir = fixture({
      'schema.sql': SCHEMA,
      'serve.ts': `throw new Error('handler blew up at startup');\n`,
    });

    const began = Date.now();
    let message = '';
    try {
      await init({ mode: 'http', fixture: dir, session: 'x', clock: CLOCK });
    } catch (e) {
      message = (e as Error).message;
    }

    expect(message).toContain('exited with code');
    // The old code blamed /health after the full 10s timeout, naming the symptom.
    expect(Date.now() - began).toBeLessThan(5_000);
  }, 20_000);

  test('and leaves no state server bound behind it', async () => {
    const dir = fixture({
      'schema.sql': SCHEMA,
      'serve.ts': `throw new Error('handler blew up at startup');\n`,
    });
    const port = portOf(listenAndRelease());

    await init({ mode: 'http', fixture: dir, session: 'x', clock: CLOCK, stateAddress: { kind: 'tcp', port } }).catch(
      () => undefined
    );

    // If partial init still leaked, this port would still be held by the state
    // server that nothing had a handle to stop.
    expect(portIsFree(port)).toBe(true);
  }, 20_000);
});

function listenAndRelease(): string {
  const s = listen(() => new Response(null, { status: 503 }));
  const url = `http://127.0.0.1:${s.port}`;
  s.stop(true);
  return url;
}

describe('closing', () => {
  test('a closed session refuses further calls', async () => {
    const session = await init({ mode: 'fn', fixture: 'research/demo/fixtures/demo', session: 'closed-1', clock: CLOCK });
    await close(session);

    await expect(
      call(session, { op: 'accounts.list', input: {}, principal: { id: 'a', kind: 'agent' } })
    ).rejects.toThrow('session closed-1 is closed');
  });

  test('closing twice is harmless', async () => {
    const session = await init({ mode: 'fn', fixture: 'research/demo/fixtures/demo', session: 'closed-2', clock: CLOCK });
    await close(session);
    await close(session);
  });

  // The old close() stopped at the first throw, stranding the port behind it.
  test('a handler that throws on close does not strand the state server', async () => {
    const registry = new WorldRegistry();
    const world = registry.open(spec({ session: 'strand' }));
    const stateServer = new StateServer(registry);
    const port = portOf(stateServer.start().url);

    const session: Session = {
      spec: { mode: 'http', fixture: 'unused', session: 'strand', clock: CLOCK },
      worldSpec: spec({ session: 'strand' }),
      world,
      handler: {
        call: () => Promise.reject(new Error('unused')),
        close: () => Promise.reject(new Error('boom')),
      },
      registry,
      stateServer,
      state: stateServer.address,
      calls: 0,
      step: 0,
      closed: false,
    };

    await expect(close(session)).rejects.toThrow('close was incomplete — handler: boom');
    await Bun.sleep(50);
    expect(portIsFree(port)).toBe(true);
  });
});

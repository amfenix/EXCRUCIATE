/**
 * Two paths that existed but had never been walked end to end: attaching to a
 * handler we did not start, and reaching the world over a unix socket.
 *
 * Both are about ownership and transport rather than behaviour, so both are
 * checked against the world — same answers, same audit — rather than against a
 * status code that could be right for the wrong reason.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { call, close, init } from '../src/runner.ts';
import { HttpHandler } from '../src/handler/http.ts';
import { listen, pickPort } from '../src/net/listen.ts';
import type { Subprocess } from 'bun';
import type { Session } from '../src/runner.ts';

const FIXTURE = resolve(import.meta.dir, '../research/demo/fixtures/demo');
const CLOCK = { now: '2026-08-18 09:12:00', business_day: 1 };
const AGENT = { id: 'agent', kind: 'agent' as const };

const strays: Array<Subprocess | Session> = [];
afterEach(async () => {
  for (const s of strays.splice(0)) {
    if ('kill' in s && typeof s.kill === 'function') s.kill();
    else await close(s as Session).catch(() => undefined);
  }
});

describe('attaching to a handler we did not start', () => {
  /**
   * The state server has to exist at a KNOWN address before the handler starts,
   * because the handler is told where the world is at spawn time. That ordering
   * is the whole reason `handlerUrl` needs `stateAddress` pinned alongside it.
   */
  const arrange = async (session: string) => {
    const statePort = pickPort();
    const handlerPort = pickPort();

    const s = await init({
      mode: 'http',
      fixture: FIXTURE,
      session,
      clock: CLOCK,
      stateAddress: { kind: 'tcp', port: statePort },
      handlerUrl: `http://127.0.0.1:${handlerPort}`,
    });
    strays.push(s);

    // Started by us, owned by us — exactly the situation `attach` exists for.
    const proc = Bun.spawn(['bun', 'run', resolve(FIXTURE, 'serve.ts')], {
      cwd: FIXTURE,
      env: {
        ...process.env,
        HANDLER_PORT: String(handlerPort),
        STATE_URL: `http://127.0.0.1:${statePort}`,
      },
      stdout: 'inherit',
      stderr: 'inherit',
    });
    strays.push(proc);

    for (let i = 0; i < 200; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${handlerPort}/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      await Bun.sleep(25);
    }
    return { s, proc, handlerPort };
  };

  test('it answers, and the world records the work', async () => {
    const { s } = await arrange('at-call');

    const r = await call(s, {
      op: 'payments.create',
      input: { id: 'A1', account: 'OPERATING', amount: 1500 },
      principal: AGENT,
    });

    expect(r.response).toEqual({ status: 201, body: { id: 'A1', status: 'SETTLED', amount: 1500 } });
    expect(s.world.read(`SELECT balance FROM accounts WHERE id='OPERATING'`)).toEqual([{ balance: 98500 }]);
    expect(s.world.auditRows().some((a) => a.actor === 'agent' && a.tbl === 'payments')).toBe(true);
  }, 40_000);

  // Closing a session must not reach into a process the session never started.
  test('close leaves someone else\'s process alive', async () => {
    const { s, proc, handlerPort } = await arrange('at-own');

    await close(s);
    expect(proc.exitCode).toBeNull();
    expect((await fetch(`http://127.0.0.1:${handlerPort}/health`)).ok).toBe(true);
  }, 40_000);

  test('restart refuses, because there is nothing of ours to restart', async () => {
    const handler = HttpHandler.attach('http://127.0.0.1:1');
    await expect(handler.restart()).rejects.toThrow('attached, not spawned');
  });

  test('an attached handler that is not there names the address', async () => {
    const handler = HttpHandler.attach(`http://127.0.0.1:${pickPort()}`);
    await expect(
      handler.call({
        session: 's',
        call: 1,
        op: 'accounts.list',
        input: {},
        clock: CLOCK,
        principal: AGENT,
      })
    ).rejects.toThrow('unreachable');
  });
});

describe('the world over a unix socket', () => {
  const sockPath = (name: string): string => join(tmpdir(), `excruciate-${name}-${process.pid}.sock`);

  /**
   * The handler reads STATE_SOCK and passes it to fetch; nothing else about it
   * changes. Measured on Bun 1.3.14/Windows, this is a real AF_UNIX socket —
   * which is why it stays opt-in: Python on Windows cannot speak to one.
   */
  test('a full call works, and matches what TCP produces', async () => {
    const overUnix = await init({
      mode: 'http',
      fixture: FIXTURE,
      session: 'sock-1',
      clock: CLOCK,
      stateAddress: { kind: 'unix', path: sockPath('a') },
    });
    strays.push(overUnix);

    const overTcp = await init({ mode: 'http', fixture: FIXTURE, session: 'tcp-1', clock: CLOCK });
    strays.push(overTcp);

    // The endpoint the handler was handed really is a socket, not a port.
    expect(overUnix.state?.unix).toBe(sockPath('a'));
    expect(overTcp.state?.unix).toBeUndefined();

    const send = (s: Session) =>
      call(s, {
        op: 'payments.create',
        input: { id: 'U1', account: 'OPERATING', amount: 2200 },
        principal: AGENT,
      });

    const [u, t] = [await send(overUnix), await send(overTcp)];
    expect(u.response).toEqual(t.response);

    // The transport must be invisible in the record, not merely in the answer.
    const strip = (rows: Array<Record<string, unknown>>): string =>
      JSON.stringify(rows.map(({ seq: _s, session: _n, ...rest }) => rest));
    expect(strip(u.journal as never)).toBe(strip(t.journal as never));
    expect(strip(u.audit as never)).toBe(strip(t.audit as never));
  }, 60_000);

  test('a socket path already in use is reported, not stepped around', async () => {
    const path = sockPath('taken');
    const held = listen(() => new Response('busy'), { kind: 'unix', path });
    try {
      await expect(
        init({
          mode: 'http',
          fixture: FIXTURE,
          session: 'sock-taken',
          clock: CLOCK,
          stateAddress: { kind: 'unix', path },
        })
      ).rejects.toThrow(`socket already in use: ${path}`);
    } finally {
      held.stop(true);
    }
  }, 30_000);
});

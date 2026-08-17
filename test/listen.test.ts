import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { endpointOf, isAddrInUse, listen, pickPort } from '../src/net/listen.ts';

const ok = () => Response.json({ ok: true });

describe('binding a tcp address', () => {
  test('no port means the OS chooses, which cannot collide', () => {
    const s = listen(ok);
    expect(s.port).toBeGreaterThan(0);
    s.stop(true);
  });

  // The bug this replaces: the handler port was a Math.random() guess with no
  // check and no retry, so two episodes side by side would fight over one.
  test('a taken port steps past to a free one', () => {
    const held = listen(ok);
    const taken = held.port!;
    const next = listen(ok, { kind: 'tcp', port: taken });

    expect(next.port).toBeGreaterThan(taken);
    held.stop(true);
    next.stop(true);
  });

  test('giving up names the range it tried', () => {
    const held = listen(ok);
    const taken = held.port!;
    expect(() => listen(ok, { kind: 'tcp', port: taken }, 1)).toThrow(`no free port in ${taken}..${taken}`);
    held.stop(true);
  });

  // Matching on the message would break the moment Bun rewords it, and the same
  // code covers unix sockets, which word it differently already.
  test('EADDRINUSE is recognised by code, never by message text', () => {
    expect(isAddrInUse({ code: 'EADDRINUSE' })).toBe(true);
    expect(isAddrInUse(new Error('Failed to start server. Is port 5 in use?'))).toBe(false);
    expect(isAddrInUse(null)).toBe(false);
    expect(isAddrInUse(undefined)).toBe(false);
  });

  test('a reserved port is genuinely free when handed back', () => {
    const port = pickPort();
    const s = listen(ok, { kind: 'tcp', port });
    expect(s.port).toBe(port); // it stepped nowhere, so nothing held it
    s.stop(true);
  });
});

// Opt-in rather than the default. Measured on Bun 1.3.14: curl reaches one of
// these, but Python on Windows has no socket.AF_UNIX at all, and a Python handler
// is the common case for another language.
describe('binding a unix address', () => {
  const path = join(tmpdir(), `excruciate-listen-${process.pid}.sock`);

  test('it serves, and the endpoint carries the socket for the client', async () => {
    const addr = { kind: 'unix', path } as const;
    const s = listen(ok, addr);
    const endpoint = endpointOf(s, addr);

    expect(endpoint.unix).toBe(path);
    const res = await fetch(`${endpoint.url}/health`, { unix: endpoint.unix! });
    expect(await res.json()).toEqual({ ok: true });
    s.stop(true);
  });

  // A path IS the address, so there is nothing to step to — unlike a port.
  test('a taken path is reported, not worked around', () => {
    const addr = { kind: 'unix', path } as const;
    const s = listen(ok, addr);
    expect(() => listen(ok, addr)).toThrow(`socket already in use: ${path}`);
    s.stop(true);
  });
});

describe('endpoints', () => {
  test('a tcp endpoint is a plain url with no socket', () => {
    const s = listen(ok);
    const endpoint = endpointOf(s, { kind: 'tcp' });
    expect(endpoint.url).toBe(`http://127.0.0.1:${s.port}`);
    expect(endpoint.unix).toBeUndefined();
    s.stop(true);
  });
});

/**
 * The shipped artefact.
 *
 * Everything else in this suite runs from source with bun on PATH, which is
 * exactly the condition a downloaded binary does NOT enjoy. The one thing that
 * cannot work by accident is a compiled binary launching a TypeScript handler:
 * as a script it shells out to `bun run serve.ts`, and compiled there is no bun
 * to shell out to.
 *
 * Skipped unless `dist/` holds a binary, so the normal suite stays fast — run
 * `bun run build` first, and CI does before it publishes anything.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const BIN = resolve(ROOT, `dist/excruciate${process.platform === 'win32' ? '.exe' : ''}`);
const built = existsSync(BIN);

interface Run {
  code: number;
  out: string;
  err: string;
}

async function run(...args: string[]): Promise<Run> {
  const proc = Bun.spawn([BIN, ...args], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    // No key, and — the point of the exercise — nothing that would help it find
    // a bun on PATH beyond whatever the machine already has.
    env: { ...process.env, ANTHROPIC_API_KEY: '' },
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

describe.skipIf(!built)('the compiled binary', () => {
  test('it runs, and says what it can do', async () => {
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.err).toContain('excruciate <command>');
  });

  test('it loads and validates a research', async () => {
    const r = await run('check', 'research/demo');
    expect(r.code).toBe(0);
    expect(r.out).toContain('payments-under-failure');
  });

  test('fn mode: the handler is imported in-process', async () => {
    const r = await run('call', 'research/demo/fixtures/demo', '--op', 'accounts.get', '--input', '{"id":"OPERATING"}');
    expect(r.code).toBe(0);
    expect(r.out).toContain('"balance":100000');
  });

  /**
   * The one that justifies this file. A compiled binary re-invokes ITSELF as
   * `excruciate serve-handler <path>`; get that wrong and it re-enters the `run`
   * command pointed at a handler, or starts the server and immediately exits.
   */
  test('http mode: it spawns a TypeScript handler without a bun on PATH', async () => {
    const r = await run('call', 'research/demo/fixtures/demo', '--mode', 'http', '--op', 'accounts.get', '--input', '{"id":"OPERATING"}');
    expect(r.code).toBe(0);
    expect(r.out).toContain('"balance":100000');
    // Not merely "it answered": the two launch modes must agree completely.
    expect(r.out).toContain('audit reproduced exactly');
  });

  test('serve-handler refuses to run without a path rather than hanging', async () => {
    const r = await run('serve-handler');
    expect(r.code).toBe(1);
    expect(r.err).toContain('needs a path');
  });
});

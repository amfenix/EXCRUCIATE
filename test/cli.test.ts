/**
 * The CLI had no tests at all.
 *
 * It is the surface a researcher actually touches, and it is the one place where
 * a broken exit code or a swallowed error costs someone an afternoon. Only the
 * commands that need no key are covered here; `ask` is exercised live.
 */
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { resolve } from 'node:path';

/**
 * Every test here SPAWNS A PROCESS, and the default 5s does not cover the first
 * one — it pays for loading five hundred modules, and on a busy machine that
 * alone timed out. Set once for the file so a new test cannot inherit the trap
 * by forgetting to pass a timeout of its own.
 */
setDefaultTimeout(60_000);

const CLI = resolve(import.meta.dir, '../src/cli.ts');
const ROOT = resolve(import.meta.dir, '..');

interface Run {
  code: number;
  out: string;
  err: string;
}

async function cli(...args: Array<string | Record<string, string>>): Promise<Run> {
  const extra = typeof args.at(-1) === 'object' ? (args.pop() as Record<string, string>) : {};
  const proc = Bun.spawn(['bun', 'run', CLI, ...(args as string[])], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ANTHROPIC_API_KEY: '', ...extra },
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

describe('usage errors exit non-zero and say what is wrong', () => {
  test('no command', async () => {
    const r = await cli();
    expect(r.code).toBe(1);
    expect(r.err).toContain('no command given');
  });

  test('an unknown command names itself', async () => {
    const r = await cli('frobnicate');
    expect(r.code).toBe(1);
    expect(r.err).toContain('unknown command: frobnicate');
  });

  test('a bad --mode', async () => {
    const r = await cli('call', 'research/demo/fixtures/demo', '--mode', 'sideways');
    expect(r.code).toBe(1);
    expect(r.err).toContain('--mode must be fn or http');
  });

  test('a bad --surface', async () => {
    const r = await cli('surface', 'research/demo/fixtures/demo', '--surface', 'telepathy');
    expect(r.code).toBe(1);
    expect(r.err).toContain('tools, api or search');
  });

  // A boolean-looking flag swallowing the next flag was a real bug in v1.
  test('a flag with no value', async () => {
    const r = await cli('call', 'research/demo/fixtures/demo', '--op');
    expect(r.code).toBe(1);
    expect(r.err).toContain('--op needs a value');
  });

  test('malformed --input', async () => {
    const r = await cli('call', 'research/demo/fixtures/demo', '--input', 'not json');
    expect(r.code).toBe(1);
    expect(r.err).toContain('--input is not valid JSON');
  });

  test('a missing fixture', async () => {
    const r = await cli('call', './nowhere');
    expect(r.code).toBe(1);
    expect(r.err).toContain('no fixture directory');
  });

  test('ask without a key refuses before spending anything', async () => {
    const r = await cli('ask', 'research/demo/fixtures/demo', '--prompt', 'hello');
    expect(r.code).toBe(1);
    expect(r.err).toContain('ANTHROPIC_API_KEY is not set');
  });
});

describe('call — one operation, no model', () => {
  test('fn prints the journal, the audit with actors, and a clean replay', async () => {
    const r = await cli('call', 'research/demo/fixtures/demo');
    expect(r.code).toBe(0);
    expect(r.out).toContain('"status":201');
    expect(r.out).toContain('INSERT INTO payments');
    expect(r.out).toContain('seed');
    expect(r.out).toContain('agent');
    expect(r.out).toContain('audit reproduced exactly');
  }, 30_000);

  test('http reaches the same place as fn', async () => {
    const [a, b] = await Promise.all([cli('call', 'research/demo/fixtures/demo'), cli('call', 'research/demo/fixtures/demo', '--mode', 'http')]);
    expect(b.code).toBe(0);
    const strip = (s: string): string => s.replace(/^mode.*$/m, '');
    expect(strip(b.out)).toBe(strip(a.out));
  }, 60_000);
});

describe('surface', () => {
  test('tools prints one definition per op and no prompt', async () => {
    const r = await cli('surface', 'research/demo/fixtures/demo', '--surface', 'tools');
    expect(r.code).toBe(0);
    expect(r.out).toContain('surface   tools  (4 tools)');
    expect(r.out).toContain('"name": "payments_create"');
    expect(r.out).not.toContain('system prompt material');
  }, 30_000);

  test('api prints one tool and the spec', async () => {
    const r = await cli('surface', 'research/demo/fixtures/demo', '--surface', 'api');
    expect(r.code).toBe(0);
    expect(r.out).toContain('surface   api  (1 tool)');
    expect(r.out).toContain('"name": "http_request"');
    expect(r.out).toContain('system prompt material');
    expect(r.out).toContain('"openapi": "3.1.0"');
  }, 30_000);

  test('search starts the model with exactly one tool', async () => {
    const r = await cli('surface', 'research/demo/fixtures/demo', '--surface', 'search');
    expect(r.code).toBe(0);
    expect(r.out).toContain('surface   search  (1 tool)');
    expect(r.out).toContain('"name": "tool_search"');
    expect(r.out).not.toContain('payments_create');
  }, 30_000);
});

describe('models', () => {
  test('a table of the catalog, cheapest facts first', async () => {
    const r = await cli('models', '--provider', 'anthropic', '--limit', '5');
    expect(r.code).toBe(0);
    expect(r.out).toContain('ID');
    expect(r.out).toContain('IN/Mtok');
    // The CATALOG id, which is what a research row must carry.
    expect(r.out).toContain('anthropic/claude-haiku-4.5');
  }, 60_000);

  /**
   * Like against like: the SAME scope, with and without the filter.
   *
   * This compared an anthropic-only list against an all-provider query, which is
   * not narrowing at all — it passed locally and failed in CI purely on how many
   * models each side happened to contain.
   */
  test('the tag DSL narrows it', async () => {
    const lines = (r: { out: string }): number => r.out.split('\n').filter((l) => l.trim() !== '').length;

    const all = await cli('models', '--limit', '500');
    const some = await cli('models', 'tools; context > 200k; price < 2', '--limit', '500');

    expect(some.code).toBe(0);
    expect(lines(some)).toBeLessThan(lines(all));
    // And it narrowed to something, rather than filtering everything away.
    expect(lines(some)).toBeGreaterThan(1);
  }, 60_000);

  test('--json emits the ModelInfo untouched', async () => {
    const r = await cli('models', '--provider', 'anthropic', '--limit', '1', '--json');
    const parsed = JSON.parse(r.out) as Array<{ provider: string; capabilities: unknown }>;
    expect(parsed[0]!.provider).toBe('anthropic');
    expect(parsed[0]!.capabilities).toBeDefined();
  }, 60_000);

  test('--live without a provider says why it cannot', async () => {
    const r = await cli('models', '--live');
    expect(r.code).toBe(1);
    expect(r.err).toContain('--live needs --provider');
  }, 60_000);

  // A query only considers providers with a key, so an empty result is almost
  // always a missing key. Printing nothing would send someone hunting a model
  // that is right there.
  test('an impossible query explains itself rather than printing nothing', async () => {
    const r = await cli('models', 'context > 900M');
    expect(r.code).toBe(0);
    expect(r.out).toContain('No models matched');
  }, 60_000);
});

describe('keys', () => {
  /** A long value, so an 11-character prefix cannot accidentally be the whole thing. */
  const SECRET = `sk-test-${'x'.repeat(70)}-END`;

  test('list shows length and a prefix, never the key', async () => {
    const r = await cli('keys', 'list', { EXCRUCIATE_OPENAI_API_KEY: SECRET });
    expect(r.code).toBe(0);
    expect(r.out).toContain('env-excruciate');
    expect(r.out).toContain(`${SECRET.length} chars`);

    // The whole point of a keychain is that the secret stops being visible.
    expect(r.out).not.toContain(SECRET);
    expect(r.out + r.err).not.toContain('-END');
  }, 60_000);

  test('which explains every place it looked, in order', async () => {
    const r = await cli('keys', 'which', 'openai', { EXCRUCIATE_OPENAI_API_KEY: SECRET });
    expect(r.out).toContain('EXCRUCIATE_OPENAI_API_KEY');
    expect(r.out).toContain('OPENAI_API_KEY');
    expect(r.out).toContain('hit');
    expect(r.out).not.toContain(SECRET);
  }, 60_000);

  /**
   * ISOLATED FROM WHATEVER THE DEVELOPER HAS CONFIGURED.
   *
   * This asked for `xai` and assumed nobody had one, which made it a test of the
   * machine rather than of the code: the moment a real xAI key was configured
   * the lookup hit, the command exited 0, and the suite failed for a setup that
   * was entirely correct. Pointing the config directory at nothing and blanking
   * the two environment variables makes the miss come from the path under test.
   */
  test('a miss is explained rather than merely reported', async () => {
    const nowhere = resolve(ROOT, 'test', '.no-such-config-dir');
    const r = await cli('keys', 'which', 'xai', {
      APPDATA: nowhere,
      XDG_CONFIG_HOME: nowhere,
      EXCRUCIATE_XAI_API_KEY: '',
      XAI_API_KEY: '',
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('NOT FOUND');
    expect(r.out).toContain('miss');
  }, 60_000);

  test('set and delete need a provider', async () => {
    expect((await cli('keys', 'set')).err).toContain('set needs a provider');
    expect((await cli('keys', 'delete')).err).toContain('delete needs a provider');
  }, 60_000);

  // A piped stdin must not silently become an empty key.
  test('a key cannot be entered non-interactively', async () => {
    const r = await cli('keys', 'set', 'openai');
    expect(r.code).toBe(1);
    expect(r.err).toContain('interactively');
  }, 60_000);

  test('an unknown subcommand lists the real ones', async () => {
    const r = await cli('keys', 'rotate');
    expect(r.code).toBe(1);
    expect(r.err).toContain('unknown keys command "rotate"');
  }, 60_000);
});

describe('check', () => {
  test('a good research reports what it would run', async () => {
    const r = await cli('check', 'research/demo');
    expect(r.code).toBe(0);
    expect(r.out).toContain('ok  payments-under-failure');
    // Matched by SHAPE, not by tally. The demo workbook gains rows as it grows
    // into a better example, and this assertion has already been re-pinned
    // twice for that reason alone — which is a test measuring the wrong thing.
    expect(r.out).toMatch(/\d+ enabled rows?, \d+ off, \d+ episodes to run/);
    // What has to be right is that it names the rows it would run, with the
    // condition each one varies.
    expect(r.out).toContain('rent-clean');
    expect(r.out).toContain('rent-lost-ack');
    expect(r.out).toMatch(/rent-lost-ack\s+tools\s+\S+\s+session\s+faults=\["lost-ack"\]/);
  }, 60_000);

  test('a missing research fails with a path, not a stack', async () => {
    const r = await cli('check', 'research/nowhere');
    expect(r.code).toBe(1);
    expect(r.err).toContain('research.yaml: not found at');
  }, 60_000);
});

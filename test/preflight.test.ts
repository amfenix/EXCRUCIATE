/**
 * Catching a bad configuration before it costs anything.
 *
 * Static checks are free and run at episode load. The provider call is the only
 * way to answer the two questions the catalog cannot: whether a temperature is
 * accepted, and whether an effort is. A catalog entry has no temperature field at
 * all, and `reasoning.effortControl` reads false even for models that take one.
 */
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { distinctPlans, planOf, splitModel, validateStatic } from '../src/preflight.ts';
import { runEpisode } from '../src/episode/run.ts';
import { configureKeys } from '../src/agent.ts';
import type { Episode } from '../src/episode/types.ts';

const FIXTURE = resolve(import.meta.dir, '../research/demo/fixtures/demo');
const CLOCK = { now: '2026-08-18 09:12:00', business_day: 1 };
const spec = (over: Partial<Episode> = {}): Episode => ({
  id: 'pf',
  fixture: FIXTURE,
  mode: 'fn',
  surface: 'tools',
  model: 'anthropic/claude-haiku-4.5',
  memory: 'session',
  init: { system: 'x', clock: CLOCK },
  steps: [],
  grade: { checks: [] },
  ...over,
});

describe('model ids', () => {
  test('a catalog id passes', () => {
    expect(() => validateStatic(spec())).not.toThrow();
  });

  /**
   * The raw provider string works when sent — Anthropic accepts it — which is
   * exactly why it is refused. It is absent from the catalog, so a run using it
   * has no pricing and no capability data behind it, and costs nothing
   * measurable.
   */
  test("the provider's own string is refused, even though it would work", () => {
    expect(() => validateStatic(spec({ model: 'anthropic/claude-haiku-4-5' }))).toThrow(
      'not in the model catalog'
    );
  });

  test('the refusal suggests the id that was meant', () => {
    expect(() => validateStatic(spec({ model: 'anthropic/claude-haiku-4-5' }))).toThrow(
      'anthropic/claude-haiku-4.5'
    );
  });

  test('a model with no resemblance says so instead of guessing', () => {
    expect(() => validateStatic(spec({ model: 'anthropic/gpt-9' }))).toThrow('No anthropic model resembles');
  });

  test('a missing provider prefix names the expected shape', () => {
    expect(() => validateStatic(spec({ model: 'claude-haiku-4.5' }))).toThrow('provider/model');
    expect(() => splitModel('/x')).toThrow('provider/model');
    expect(() => splitModel('x/')).toThrow('provider/model');
  });

  test('it splits at the first slash, so a model name may contain one', () => {
    expect(splitModel('openrouter/anthropic/claude-haiku-4.5')).toEqual({
      provider: 'openrouter',
      name: 'anthropic/claude-haiku-4.5',
    });
  });
});

describe('temperature and thinking are exclusive', () => {
  // Anthropic pins the temperature when thinking is on, so asking for both means
  // one of them was silently ignored — and which is not something to guess.
  test('both together are refused', () => {
    expect(() => validateStatic(spec({ temperature: 0.2, thinking: { mode: 'on', effort: 'low' } }))).toThrow(
      'cannot both be set'
    );
  });

  test('either alone is fine', () => {
    expect(() => validateStatic(spec({ temperature: 0.2 }))).not.toThrow();
    expect(() => validateStatic(spec({ thinking: { mode: 'on', effort: 'high' } }))).not.toThrow();
  });

  // Thinking explicitly OFF is not thinking, so it does not pin anything.
  test('thinking off leaves temperature free', () => {
    expect(() => validateStatic(spec({ temperature: 0.7, thinking: { mode: 'off' } }))).not.toThrow();
  });

  test('a non-numeric temperature is refused', () => {
    expect(() => validateStatic(spec({ temperature: Number.NaN }))).toThrow('must be a number');
  });
});

describe('an episode validates before it spends', () => {
  test('a bad model stops the episode at load', async () => {
    await expect(runEpisode(spec({ model: 'anthropic/nope-1' }))).rejects.toThrow('not in the model catalog');
  });

  test('so does an impossible pairing', async () => {
    await expect(
      runEpisode(spec({ temperature: 0.5, thinking: { mode: 'auto' } }))
    ).rejects.toThrow('cannot both be set');
  });

  test('the message names which episode', async () => {
    await expect(runEpisode(spec({ id: 'row-17', model: 'anthropic/nope-1' }))).rejects.toThrow('episode row-17');
  });
});

describe('planning the preflight', () => {
  test('one entry per combination a provider could answer differently', () => {
    const plans = distinctPlans([
      spec({ temperature: 0 }),
      spec({ temperature: 0 }),
      spec({ temperature: 1 }),
      spec({ thinking: { mode: 'on', effort: 'low' } }),
      spec(),
    ]);
    expect(plans).toHaveLength(4);
  });

  test('a plan carries only what a provider could reject', () => {
    expect(planOf(spec({ temperature: 0.3 }))).toEqual({
      model: 'anthropic/claude-haiku-4.5',
      temperature: 0.3,
    });
    expect(planOf(spec())).toEqual({ model: 'anthropic/claude-haiku-4.5' });
  });
});

/**
 * The order that broke everything once.
 *
 * `validateStatic` builds the engine just to read the catalog. If that keyless
 * construction locked the keys out, every later episode would fail with "no API
 * key" no matter how carefully the research had configured one — and it did,
 * across thirteen live tests, until keys became assignable after construction.
 */
describe('keys survive an engine built for the catalog', () => {
  test('configureKeys works even when validateStatic got there first', () => {
    validateStatic(spec());
    const engine = configureKeys({ anthropic: 'sk-test-not-a-real-key' });
    expect(engine.apiKeys.anthropic).toBe('sk-test-not-a-real-key');
  });

  test('and a later call updates rather than being ignored', () => {
    configureKeys({ anthropic: 'first' });
    expect(configureKeys({ anthropic: 'second' }).apiKeys.anthropic).toBe('second');
  });
});

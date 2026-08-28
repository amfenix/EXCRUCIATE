/**
 * Nebius reached through the OpenAI wire format.
 *
 * All offline. Nothing here calls a provider — what is being tested is the
 * translation between what a workbook says (`nebius/zai-org/GLM-5.2`) and what
 * llm-sdk is handed, plus the two things that would be expensive to get wrong:
 * pricing a run at zero, and sending one company's key to another's server.
 */
import { describe, expect, test } from 'bun:test';
import { configureKeys, ensureEngine, launchOptions, resetEngine } from '../src/agent.ts';
import { priceUsage, pricingFor } from '../src/cost.ts';
import { NEBIUS_BASE_URL, NEBIUS_MODELS, isNebiusModel, launchFor } from '../src/nebius.ts';
import { validateStatic } from '../src/preflight.ts';
import type { Usage } from '@combycode/llm-sdk';
import type { Episode } from '../src/episode/types.ts';

const KIMI = 'nebius/moonshotai/Kimi-K3';
const KEY = 'nebius-key-not-real';

const usage = (over: Partial<Usage> = {}): Usage =>
  ({
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    ...over,
  }) as Usage;

const spec = (model: string): Pick<Episode, 'model' | 'temperature' | 'thinking' | 'id'> => ({
  id: 'nb',
  model,
});

describe('addressing a Nebius model', () => {
  test('a model id keeps its vendor half, under an openai wire prefix', () => {
    // The prefix names the FORMAT. Dropping the vendor half — or letting llm-sdk
    // read it as the provider — is the failure this whole module exists for.
    expect(launchFor(KIMI, KEY).model).toBe('openai/moonshotai/Kimi-K3');
  });

  test('it goes to Nebius, over chat-completions', () => {
    const launch = launchFor(KIMI, KEY);
    expect(launch.baseURL).toBe(NEBIUS_BASE_URL);
    // Nebius implements no Responses API, and llm-sdk defaults an openai client
    // to Responses. Without this the provider answers about the API and the
    // reader blames the model.
    expect(launch.clientOptions).toEqual({ api: 'completions' });
    expect(launch.apiKey).toBe(KEY);
  });

  test('every other provider is left exactly as it was', () => {
    const launch = launchFor('anthropic/claude-haiku-4.5', KEY);
    expect(launch).toEqual({ model: 'anthropic/claude-haiku-4.5' });
    expect(launch.apiKey).toBeUndefined();
    expect(launch.baseURL).toBeUndefined();
  });

  test('only a nebius/ prefix counts', () => {
    expect(isNebiusModel(KIMI)).toBe(true);
    expect(isNebiusModel('openrouter/moonshotai/kimi-k3')).toBe(false);
    expect(isNebiusModel('nebiusish/x')).toBe(false);
  });
});

/**
 * The dangerous case, and the reason this is a hard failure rather than a
 * fallback: the wire provider is `openai`, so llm-sdk would reach for
 * `engine.apiKeys.openai` if nothing were passed — and post an OpenAI key to a
 * different company's endpoint.
 */
describe('a missing key', () => {
  test('refuses rather than falling back to the openai key', () => {
    expect(() => launchFor(KIMI, null)).toThrow('no nebius key');
    expect(() => launchFor(KIMI, '')).toThrow('no nebius key');
  });

  test('the refusal says where the key would otherwise have gone', () => {
    expect(() => launchFor(KIMI, null)).toThrow(NEBIUS_BASE_URL);
  });

  test('and it names the command that fixes it', () => {
    expect(() => launchFor(KIMI, null)).toThrow('keys set nebius');
  });
});

describe('keys are kept in two slots', () => {
  test('a nebius key never lands on engine.apiKeys, where openai would eat it', () => {
    resetEngine();
    const engine = configureKeys({ nebius: KEY, openai: 'openai-key-not-real' });
    expect(engine.apiKeys.openai).toBe('openai-key-not-real');
    expect((engine.apiKeys as Record<string, string | undefined>)['nebius']).toBeUndefined();
    expect(launchOptions(KIMI).apiKey).toBe(KEY);
    resetEngine();
  });

  test('resetEngine forgets it, so one test cannot lend a key to the next', () => {
    resetEngine();
    configureKeys({ nebius: KEY });
    resetEngine();
    expect(() => launchOptions(KIMI)).toThrow('no nebius key');
  });
});

describe('the catalog', () => {
  test('knows the generated models, so a workbook row loads', () => {
    expect(() => validateStatic(spec(KIMI))).not.toThrow();
  });

  test('still refuses a model Nebius does not serve', () => {
    expect(() => validateStatic(spec('nebius/moonshotai/Kimi-K9'))).toThrow('not in the model catalog');
  });

  test('lists only tool-capable models — the rest cannot run a task at all', () => {
    expect(NEBIUS_MODELS.length).toBeGreaterThan(0);
    const engine = ensureEngine();
    for (const m of NEBIUS_MODELS) {
      expect(engine.catalog.get('nebius', m.id)?.capabilities.toolUse).toBe(true);
    }
  });
});

describe('pricing', () => {
  /**
   * A run on an unpriced model reports "not priced", which is honest but useless
   * for a budget — and the projection drops the row from the total entirely. So
   * the prices have to reach the catalog, not merely sit in a table.
   */
  test('a Nebius model is priced from the generated table, not left null', () => {
    const rates = pricingFor(KIMI);
    expect(rates).not.toBeNull();
    expect(rates?.inputPerMTok).toBe(3);
    expect(rates?.outputPerMTok).toBe(15);
  });

  test('a million tokens each way costs what the table says', () => {
    const spend = priceUsage(KIMI, usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }));
    expect(spend.usd).toBeCloseTo(18, 6);
  });

  test('a model outside the table is still not priced at zero', () => {
    expect(pricingFor('nebius/nobody/Nothing-1')).toBeNull();
    expect(priceUsage('nebius/nobody/Nothing-1', usage({ inputTokens: 500 })).usd).toBeNull();
  });
});

/**
 * Nebius's usage record nests: the cached tokens are inside `prompt_tokens`, and
 * the reasoning tokens are inside `completion_tokens`. The pricer's default is
 * to ADD both — correct for Anthropic and OpenAI, and very nearly a doubled bill
 * here. Both of these failed before the fix, on real numbers taken from a run.
 */
describe('nested usage is not charged twice', () => {
  test('cached prompt tokens are already inside the input count', () => {
    // Measured: prompt_tokens 2115, of which cached_tokens 2112.
    const spend = priceUsage(KIMI, usage({ inputTokens: 2115, cachedTokens: 2112 }));
    expect(spend.usd).toBeCloseTo((2115 * 3) / 1_000_000, 9);
  });

  test('reasoning tokens are already inside the output count', () => {
    // Measured on a truncated episode: outputTokens 4096, reasoningTokens 3974.
    const spend = priceUsage(KIMI, usage({ outputTokens: 4096, reasoningTokens: 3974 }));
    expect(spend.usd).toBeCloseTo((4096 * 15) / 1_000_000, 9);
  });

  test('and a provider that does report them separately still pays for both', () => {
    const model = 'anthropic/claude-haiku-4.5';
    const separate = priceUsage(model, usage({ outputTokens: 1000, reasoningTokens: 1000 }));
    const alone = priceUsage(model, usage({ outputTokens: 1000 }));
    expect(separate.usd).toBeGreaterThan(alone.usd ?? 0);
  });
});

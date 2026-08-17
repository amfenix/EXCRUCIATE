/**
 * What a run actually cost.
 *
 * Tokens are the measurement; dollars are the interpretation. Both are recorded,
 * because catalog prices change and a stored dollar figure with no token count
 * behind it cannot be re-checked later.
 *
 * The arithmetic is ours rather than the SDK's `engine.cost`, for one reason:
 * that collector is process-global and this runner puts several episodes in
 * flight at once, so its running total cannot be attributed to a particular
 * episode. `complete()` hands back the usage for ITS OWN agent run — measured
 * as cumulative across every turn of that run — which attributes perfectly.
 *
 * Cross-checked against the collector on a real 3-turn episode: 2960 in, 233
 * out, $0.004125 both ways — and the arithmetic below deliberately mirrors that
 * collector's, so the two cannot drift apart on a call that happens to hit the
 * prompt cache.
 */
import { ensureEngine } from './agent.ts';
import { splitModel } from './preflight.ts';
import type { Usage } from '@combycode/llm-sdk';

/** What one model call, or a whole episode, consumed. */
export interface Spend {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  /** USD, priced when it happened. Null when the catalog has no price. */
  usd: number | null;
}

export const NO_SPEND: Spend = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  reasoningTokens: 0,
  usd: 0,
};

/**
 * Price one usage record against the catalog.
 *
 * A model the catalog does not know is priced `null`, never 0 — a research on
 * an unlisted model should report "not priced", not a free lunch.
 */
export function priceUsage(model: string, usage: Usage): Spend {
  const tokens = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedTokens: usage.cachedTokens,
    reasoningTokens: usage.reasoningTokens,
  };

  const rates = pricingFor(model);
  if (rates === null) return { ...tokens, usd: null };

  const input = rates.inputPerMTok ?? 0;
  const output = rates.outputPerMTok ?? 0;
  // The catalog leaves the cache rates off most models. These fallbacks are the
  // SDK's own and Anthropic's published multiples: a tenth to read a cached
  // prefix, a quarter more than fresh input to write one.
  const cacheRead = rates.cacheReadPerMTok ?? input * 0.1;
  const cacheWrite = rates.cacheWritePerMTok ?? input * 1.25;

  // The cache figures are ADDED, not subtracted out of the input: `inputTokens`
  // is Anthropic's `input_tokens`, which already excludes both cache reads and
  // cache writes. Netting them off instead under-bills every cached call — and
  // does so silently, because an uncached run agrees either way.
  const usd =
    (usage.inputTokens * input +
      usage.cachedTokens * cacheRead +
      usage.cacheWriteTokens * cacheWrite +
      usage.outputTokens * output +
      // Where a provider reports reasoning separately it bills as output. For
      // Anthropic it arrives as 0, thinking already being inside `outputTokens`.
      usage.reasoningTokens * output) /
    1_000_000;

  return { ...tokens, usd };
}

interface Rates {
  inputPerMTok?: number | undefined;
  outputPerMTok?: number | undefined;
  cacheReadPerMTok?: number | undefined;
  cacheWritePerMTok?: number | undefined;
}

/** The catalog's rates for a model id, or null when it lists none. */
export function pricingFor(model: string): Rates | null {
  const { provider, name } = splitModel(model);
  try {
    return ensureEngine().catalog.getPricing(provider, name);
  } catch {
    // An unknown provider is a "not priced", not a crash mid-run.
    return null;
  }
}

/**
 * Add spends together.
 *
 * `usd` is null as soon as ANY part of the sum was unpriced — a total that
 * quietly omits the one expensive model in the matrix is worse than no total.
 */
export function addSpend(a: Spend, b: Spend): Spend {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    usd: a.usd === null || b.usd === null ? null : a.usd + b.usd,
  };
}

export const sumSpend = (spends: Spend[]): Spend => spends.reduce(addSpend, NO_SPEND);

/** `$0.0041` — small numbers need the digits, large ones do not. */
export function formatUsd(usd: number | null): string {
  if (usd === null) return 'not priced';
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** `1.9k` — token counts are read for scale, not audited to the digit. */
export const formatTokens = (n: number): string =>
  n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`;

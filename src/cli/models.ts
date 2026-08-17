/**
 * `excruciate models` — browse and search the catalog.
 *
 * Entirely llm-sdk's helpers: `listModels` for the curated local catalog and
 * `selectModels` for the tag DSL. Reimplementing either would mean a second
 * opinion about what a model can do, and the SDK's is the one that decides how
 * a request is actually built.
 *
 * The catalog id is what a research row must carry — llm-sdk translates it to
 * the provider's own string. A raw provider string may well work when sent, and
 * that is the trap: it bypasses the catalog and takes pricing with it.
 */
import { listModels, listModelsLive, selectModels } from '@combycode/llm-sdk';
import { ensureEngine } from '../agent.ts';
import { KNOWN_PROVIDERS, resolveKey } from '../keys.ts';
import type { ModelInfo, ProviderName } from '@combycode/llm-sdk';

export interface ModelsArgs {
  query?: string;
  provider?: string;
  live: boolean;
  json: boolean;
  limit: number;
}

export async function cmdModels(args: ModelsArgs): Promise<number> {
  const engine = ensureEngine();
  await configureAvailable();

  let models: ModelInfo[];
  if (args.live) {
    if (!args.provider) {
      console.error('error: --live needs --provider (it asks that provider what it currently serves)');
      return 1;
    }
    models = await listModelsLive({ provider: args.provider as ProviderName, engine });
  } else if (args.query !== undefined && args.query !== '') {
    // Availability-aware: `selectModels` only considers providers with a key, so
    // an empty result usually means a missing key rather than a missing model.
    models = selectModels(args.query, {
      engine,
      ...(args.provider !== undefined ? { provider: args.provider as ProviderName } : {}),
    });
  } else {
    models = listModels({ engine, ...(args.provider !== undefined ? { provider: args.provider as ProviderName } : {}) });
    models.sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`));
  }

  const shown = models.slice(0, args.limit);
  if (args.json) {
    console.log(JSON.stringify(shown, null, 2));
    return 0;
  }

  print(shown);
  if (models.length > shown.length) {
    console.log(`\n… ${models.length - shown.length} more (--limit ${models.length} to see them all)`);
  }
  if (models.length === 0) await explainEmpty(args);
  return 0;
}

function print(models: ModelInfo[]): void {
  const row = (m: ModelInfo): string[] => {
    const p = m.pricing as { inputPerMTok?: number; outputPerMTok?: number } | undefined;
    const caps = m.capabilities as { toolUse?: boolean } | undefined;
    const reasoning = m.reasoning as { supported?: boolean } | undefined;
    return [
      `${m.provider}/${m.model}`,
      thousands(m.contextWindow),
      money(p?.inputPerMTok),
      money(p?.outputPerMTok),
      caps?.toolUse === true ? 'yes' : '—',
      reasoning?.supported === true ? 'yes' : '—',
      String(m.status ?? ''),
    ];
  };

  const rows = [['ID', 'CTX', 'IN/Mtok', 'OUT/Mtok', 'TOOLS', 'THINK', 'STATUS'], ...models.map(row)];
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  for (const r of rows) {
    console.log(r.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!))).join('  '));
  }
}

const thousands = (n: number | undefined): string =>
  n === undefined ? '—' : n >= 1_000_000 ? `${Math.round(n / 1000)}k` : `${Math.round(n / 1000)}k`;

const money = (n: number | undefined): string => (n === undefined ? '—' : n.toFixed(2));

/** Keys decide what `selectModels` will even consider, so they are loaded first. */
async function configureAvailable(): Promise<string[]> {
  const found: string[] = [];
  const engine = ensureEngine();
  for (const provider of KNOWN_PROVIDERS) {
    const r = await resolveKey(provider);
    if (r.value !== null) {
      (engine.apiKeys as Record<string, string>)[provider] = r.value;
      found.push(provider);
    }
  }
  return found;
}

/** An empty result is almost always a missing key. Say so rather than nothing. */
async function explainEmpty(args: ModelsArgs): Promise<void> {
  const available = await configureAvailable();
  console.log('');
  if (args.query !== undefined && available.length === 0) {
    console.log('No models matched — and no provider has a key configured.');
    console.log('A query only considers providers you can actually call: excruciate keys set anthropic');
    return;
  }
  console.log(
    available.length > 0
      ? `No models matched. Keys are configured for: ${available.join(', ')}.`
      : 'No models matched.'
  );
}

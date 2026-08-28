/**
 * Nebius Token Factory, as a provider.
 *
 * llm-sdk has five providers and Nebius is not one of them, so this is not a new
 * adapter — it is Nebius's OpenAI-compatible endpoint reached through the OpenAI
 * adapter with a different base URL. Three details make that work, and each one
 * cost a confusing error before it was understood:
 *
 * **There is no Responses API.** llm-sdk defaults an `openai` client to
 * Responses, and Nebius answers `This model does not support Responses API` —
 * a sentence about the API that reads like a sentence about the model. Hence the
 * explicit `api: 'completions'`.
 *
 * **A Nebius model id already contains a slash.** `moonshotai/Kimi-K3` is the
 * whole id, vendor half included. llm-sdk resolves a namespaced model string
 * BEFORE it reads an explicit `provider`, so it takes `moonshotai` for a provider
 * and dies on `no default adapter`; passing `provider: 'openai'` alongside is
 * silently ignored. Since the id splits on the FIRST slash only, prefixing works:
 * `openai/moonshotai/Kimi-K3`. Here `openai` names the WIRE FORMAT, not a vendor.
 *
 * **The key must never fall back.** Because the wire provider is `openai`,
 * llm-sdk would happily reach for `engine.apiKeys.openai` if no key were passed —
 * which would send an OpenAI key to a different company's server. `launchFor`
 * throws instead. That is the one failure in here that must never be lenient.
 *
 * The model table lives in `nebius-models.ts` and is generated; see
 * `scripts/nebius-catalog.ts`.
 */
import { FixtureError } from './errors.ts';
import { NEBIUS_GENERATED_ON, NEBIUS_MODELS } from './nebius-models.ts';
import type { ModelCatalog } from '@combycode/llm-sdk';

export { NEBIUS_GENERATED_ON, NEBIUS_MODELS };

/** The provider half of a model id in a workbook: `nebius/zai-org/GLM-5.2`. */
export const NEBIUS = 'nebius';

/** Nebius's OpenAI-compatible API. The adapter appends `/v1/chat/completions`. */
export const NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com';

const PREFIX = `${NEBIUS}/`;

export const isNebiusModel = (model: string): boolean => model.startsWith(PREFIX);

/**
 * Everything `createAgent` needs to reach one model, whoever serves it.
 *
 * Non-Nebius models get `{ model }` and nothing else, so the engine keeps
 * deciding keys for the five providers llm-sdk knows — this does not become a
 * second way to configure anthropic.
 */
export interface Launch {
  model: string;
  baseURL?: string;
  apiKey?: string;
  clientOptions?: { api: 'completions' };
}

export function launchFor(model: string, nebiusKey: string | null): Launch {
  if (!isNebiusModel(model)) return { model };

  if (nebiusKey === null || nebiusKey === '') {
    throw new FixtureError(
      `no ${NEBIUS} key, and "${model}" needs one.\n` +
        `  excruciate keys set ${NEBIUS}\n` +
        `  Refusing to continue: ${NEBIUS} speaks OpenAI's wire format, so a run without its own ` +
        `key would send whatever OpenAI key is configured to ${NEBIUS_BASE_URL}.`
    );
  }

  return {
    // `openai/` is the wire format. See the note at the top of this file.
    model: `openai/${model.slice(PREFIX.length)}`,
    baseURL: NEBIUS_BASE_URL,
    apiKey: nebiusKey,
    clientOptions: { api: 'completions' },
  };
}

/**
 * Put the Nebius models in the catalog, under `nebius`.
 *
 * The catalog is what `validateStatic` checks a workbook against and what
 * `cost.ts` prices against, so without this every Nebius row would be rejected
 * at load — and if it were not, would report a run that cost nothing.
 *
 * Registered under `nebius`, deliberately, even though the wire provider is
 * `openai`: a workbook row says `nebius/…`, and the catalog answers questions
 * about what a row NAMES, not about which HTTP client ends up carrying it.
 */
export function registerNebius(catalog: ModelCatalog): void {
  for (const m of NEBIUS_MODELS) {
    catalog.set(NEBIUS, m.id, {
      pricing: {
        inputPerMTok: m.inputPerMTok,
        outputPerMTok: m.outputPerMTok,
        // ZERO, not absent. Nebius quotes one prompt rate and no cache rate, and
        // its `prompt_tokens` ALREADY CONTAINS the cached ones — measured at
        // 2115 prompt with 2112 of them cached. Leaving these off would let the
        // pricer fall back to a tenth of the input rate and charge that on top
        // of tokens it has already charged for: 21% over, silently, and only on
        // the repeated prompts a research is made of.
        cacheReadPerMTok: 0,
        cacheWritePerMTok: 0,
      },
      preferredApi: 'completions',
      supportedApis: ['completions'],
      contextWindow: m.contextWindow,
      capabilities: {
        // Every model in the table declares `tools` — that is the filter the
        // generator applies, so there is nothing here to vary.
        toolUse: true,
        streaming: true,
        structuredOutput: m.structuredOutput,
        vision: m.vision,
        audio: false,
        video: false,
        imageGeneration: false,
        audioGeneration: false,
        videoGeneration: false,
      },
      reasoning: {
        supported: m.reasoning,
        automatic: m.reasoning,
        // Nebius exposes no effort control and no reasoning summary; it reports
        // only whether a model reasons at all.
        effortControl: false,
        encryptedContent: false,
        summaryAvailable: false,
      },
      type: 'chat',
      active: true,
    });
  }
}

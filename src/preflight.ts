/**
 * Two gates before a research spends anything.
 *
 * STATIC — free, runs at episode load. The model must be a catalog id, and
 * temperature and thinking must not both be asked for.
 *
 * PREFLIGHT — one real call per distinct (model, temperature, thinking), once,
 * before the run starts. The catalog cannot answer whether a provider will accept
 * a temperature or an effort: there is no temperature field in an entry at all,
 * and `reasoning.effortControl` reads false even for models that take an effort.
 * So the only honest check is to ask, cheaply, once — rather than discover it on
 * episode fourteen of twenty.
 */
import { createAgent } from '@combycode/llm-sdk';
import { ensureEngine, launchOptions } from './agent.ts';
import { FixtureError } from './errors.ts';
import type { ThinkingConfig } from '@combycode/llm-sdk';
import type { Episode } from './episode/types.ts';

/** Everything about a launch that a provider could reject. */
export interface Plan {
  model: string;
  temperature?: number;
  thinking?: ThinkingConfig;
}

export interface PreflightResult {
  plan: Plan;
  ok: boolean;
  error?: string;
}

const thinks = (thinking: ThinkingConfig | undefined): boolean =>
  thinking !== undefined && thinking.mode !== 'off';

/** `anthropic/claude-haiku-4.5` → the two halves. */
export function splitModel(model: string): { provider: string; name: string } {
  const at = model.indexOf('/');
  if (at <= 0 || at === model.length - 1) {
    throw new FixtureError(
      `model "${model}" must be written as provider/model, e.g. anthropic/claude-haiku-4.5`
    );
  }
  return { provider: model.slice(0, at), name: model.slice(at + 1) };
}

/**
 * Free checks, at load.
 *
 * The model has to be a CATALOG id. A raw provider string may well work — the
 * provider accepts it — but it bypasses the catalog, and with it pricing and
 * capability data, so a run would silently cost nothing measurable.
 */
export function validateStatic(spec: Pick<Episode, 'model' | 'temperature' | 'thinking' | 'id'>): void {
  const where = `episode ${spec.id}`;

  if (spec.temperature !== undefined && thinks(spec.thinking)) {
    // Anthropic pins temperature when thinking is on, so asking for both means one
    // of the two was quietly ignored — and which one is not something to guess.
    throw new FixtureError(
      `${where}: temperature and thinking cannot both be set — thinking pins the temperature`
    );
  }
  if (spec.temperature !== undefined && !Number.isFinite(spec.temperature)) {
    throw new FixtureError(`${where}: temperature must be a number`);
  }

  const { provider, name } = splitModel(spec.model);
  const catalog = ensureEngine().catalog;
  if (catalog.get(provider, name) === null) {
    throw new FixtureError(
      `${where}: "${spec.model}" is not in the model catalog.\n` +
        `  Use the catalog id, not the provider's own string — llm-sdk translates it.\n` +
        `  ${nearest(provider, name)}`
    );
  }
}

/** A short "did you mean", because dated ids and dotted versions are easy to confuse. */
function nearest(provider: string, name: string): string {
  const stem = name.replace(/[-.]?\d.*$/, '');
  const all = [...(ensureEngine().catalog as unknown as { models: Map<string, unknown> }).models.keys()];
  const close = all.filter((id) => id.startsWith(`${provider}/`) && id.includes(stem)).slice(0, 4);
  return close.length > 0 ? `Closest: ${close.join(', ')}` : `No ${provider} model resembles "${name}".`;
}

export const planOf = (spec: Pick<Episode, 'model' | 'temperature' | 'thinking'>): Plan => ({
  model: spec.model,
  ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
  ...(spec.thinking !== undefined ? { thinking: spec.thinking } : {}),
});

/** One entry per combination a provider could answer differently. */
export function distinctPlans(specs: Array<Pick<Episode, 'model' | 'temperature' | 'thinking'>>): Plan[] {
  const seen = new Map<string, Plan>();
  for (const spec of specs) {
    const plan = planOf(spec);
    seen.set(JSON.stringify(plan), plan);
  }
  return [...seen.values()];
}

/**
 * Ask the provider, once per plan. Tiny prompt, tiny cap: this costs pennies and
 * buys the difference between a config error at second zero and one at minute
 * forty, halfway through a paid run.
 */
export async function preflight(plans: Plan[]): Promise<PreflightResult[]> {
  const results: PreflightResult[] = [];

  for (const plan of plans) {
    try {
      const agent = createAgent({
        ...launchOptions(plan.model),
        system: 'Reply with the single word: ok',
        maxTokens: 16,
        engine: ensureEngine(),
        ...(plan.temperature !== undefined ? { temperature: plan.temperature } : {}),
        ...(plan.thinking !== undefined ? { thinking: plan.thinking } : {}),
      });
      await agent.complete('ping');
      agent.destroy();
      results.push({ plan, ok: true });
    } catch (e) {
      results.push({ plan, ok: false, error: (e as Error).message });
    }
  }
  return results;
}

/** Throw unless every plan came back usable, naming each that did not. */
export function assertPreflight(results: PreflightResult[]): void {
  const bad = results.filter((r) => !r.ok);
  if (bad.length === 0) return;
  throw new FixtureError(
    `preflight failed for ${bad.length} of ${results.length} configurations:\n` +
      bad.map((r) => `  ${JSON.stringify(r.plan)}\n    ${r.error}`).join('\n')
  );
}

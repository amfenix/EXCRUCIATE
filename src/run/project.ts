/**
 * What a research would cost, before spending anything.
 *
 * The SDK's `estimate()` is pure and sends nothing, but handing it just the
 * prompt is badly wrong for an agent loop. Measured on one episode: 22 input
 * tokens estimated against 1894 actually billed — 86× under. Three reasons, all
 * of which this file corrects for:
 *
 *   THE MODEL SEES MORE THAN THE PROMPT. The system prompt, the surface's own
 *   material (on `api` a whole OpenAPI document) and every tool schema are all
 *   input, every turn.
 *
 *   ONE STEP IS MANY TURNS. A say-step runs until the model stops calling tools,
 *   and each turn re-sends everything before it.
 *
 * Every constant below was CALIBRATED against a measured run rather than picked,
 * and each says what it was measured against. The first attempt guessed at them
 * and came out 3.5× high — which sounds like the safe direction until someone
 * declines to run a matrix that would in fact have been affordable.
 *
 * As it stands the demo projects $0.0117 per episode against $0.0069 measured:
 * about 1.7× high, deliberately. A projection that under-reads is the worse
 * failure, because it is the one that gets believed.
 */
import { estimate } from '@combycode/llm-sdk';
import { openSurface } from '../surface/index.ts';
import { manifestFor } from '../surface/manifest.ts';
import { resolveEpisode } from '../episode/text.ts';
import { isSay } from '../episode/types.ts';
import { ensureEngine } from '../agent.ts';
import { pricingFor } from '../cost.ts';
import type { Episode } from '../episode/types.ts';
import type { LoadedEpisode } from '../research/load.ts';

/**
 * Turns per say-step. Haiku took 3 on the demo.
 *
 * A task's own `maxSteps` can only LOWER this, never raise it: it defaults to 12
 * and is a ceiling on a runaway loop, not a forecast. Quoting the ceiling would
 * read four times high on every ordinary task, which is how a projection stops
 * being read at all.
 */
const ASSUMED_TURNS = 3;

/**
 * How much more input a whole episode bills than the base counted once.
 *
 * MEASURED, not guessed. The demo's `rent-clean` composes a 352-token base and
 * bills 4174 per episode — 11.9×, against `turns × says` = 6. So each turn costs
 * about twice the base once tool results and the accumulated conversation are
 * carried along. Assuming growth was negligible under-counted input by a third.
 */
const HISTORY_GROWTH = 2;

/**
 * Output tokens per SAY-STEP, not per turn.
 *
 * The SDK's own default is 512 per call, and charging that for every turn of a
 * tool-calling loop over-quoted the demo tenfold: it actually produced 285
 * output tokens across two say-steps. 512 per say-step is still roughly double
 * what was measured, which is the direction to be wrong in.
 */
const OUTPUT_PER_SAY = 512;

/** Deliberate padding on top of all of it. Better to over-quote than under. */
const SAFETY = 1.25;

export interface Projection {
  /** Per row, so an expensive row is visible rather than buried in a total. */
  rows: Array<{ id: string; episodes: number; usd: number | null }>;
  usd: number | null;
  episodes: number;
  /** Everything assumed to get here, in the reader's own language. */
  assumptions: string[];
  /** Models the catalog cannot price, so the total omits them. */
  unpriced: string[];
}

export async function project(chosen: LoadedEpisode[], limit?: number): Promise<Projection> {
  const rows: Projection['rows'] = [];
  const unpriced = new Set<string>();

  for (const entry of chosen) {
    const perEpisode = await projectEpisode(entry.episode);
    if (perEpisode === null) unpriced.add(entry.episode.model);

    rows.push({
      id: entry.row.id,
      episodes: entry.repeat,
      usd: perEpisode === null ? null : perEpisode.usd * entry.repeat,
    });
  }

  const episodes = rows.reduce((n, r) => n + r.episodes, 0);
  // A `--limit` run pays for a slice, so quote the slice.
  const scale = limit !== undefined && limit > 0 && limit < episodes ? limit / episodes : 1;
  const priced = rows.filter((r) => r.usd !== null);

  return {
    rows,
    episodes: Math.round(episodes * scale),
    usd: priced.length === 0 ? null : priced.reduce((n, r) => n + r.usd!, 0) * scale,
    unpriced: [...unpriced],
    assumptions: [
      `input counted from the real composed prompt: system + surface material + tool schemas + every say`,
      `${ASSUMED_TURNS} model turns per say-step, each billing about ${HISTORY_GROWTH}× the base as history accumulates`,
      `${OUTPUT_PER_SAY} output tokens assumed per say-step (measured: about half that)`,
      `×${SAFETY} safety margin — this is meant to read high, not tight`,
      ...(scale < 1 ? [`scaled to the --limit of ${Math.round(episodes * scale)} episodes`] : []),
    ],
  };
}

/**
 * One episode's projected cost.
 *
 * Null when the catalog cannot price the model — a projection that silently
 * treats an unlisted model as free is the failure mode worth avoiding.
 */
async function projectEpisode(raw: Episode): Promise<{ usd: number } | null> {
  if (pricingFor(raw.model) === null) return null;

  const spec = await resolveEpisode(raw);
  const composed = await composeInput(spec);
  const says = spec.steps.filter(isSay);
  const turns = Math.min(spec.maxSteps ?? ASSUMED_TURNS, ASSUMED_TURNS);

  // One estimate over the whole composed input. `low` is the input priced with
  // zero output, so the two bounds separate cleanly into input and output.
  const one = await estimate(
    { model: spec.model, prompt: composed.first, system: composed.system },
    { engine: ensureEngine(), expectedOutputTokens: OUTPUT_PER_SAY }
  );

  const baseInput = one.cost.low;
  const outputPerSay = Math.max(0, one.cost.expected - one.cost.low);

  const sayCount = Math.max(1, says.length);
  const allTurns = turns * sayCount;
  const usd = (baseInput * allTurns * HISTORY_GROWTH + outputPerSay * sayCount) * SAFETY;

  return { usd };
}

/**
 * Everything the model is actually sent.
 *
 * The tool schemas are part of the input on every turn and are frequently the
 * largest part of it — on the demo's `tools` surface they outweigh the prompt
 * several times over.
 */
async function composeInput(spec: Episode): Promise<{ system: string; first: string }> {
  const manifest = await manifestFor(spec.fixture);
  // A dispatch that is never called: this builds the surface only to read what
  // it would hand the model.
  const surface = openSurface(spec.surface, manifest, async () => ({ status: 0 }));

  const tools = surface.tools.map((t) => JSON.stringify(t.definition)).join('\n');
  const says = spec.steps.filter(isSay).map((s) => s.say);

  return {
    system: [spec.init.system, surface.prompt].filter((s) => s !== undefined && s !== '').join('\n\n'),
    // Every say plus the tool schemas: the schemas ride along on every turn, and
    // the says are each paid for at least once.
    first: [tools, ...says].join('\n'),
  };
}

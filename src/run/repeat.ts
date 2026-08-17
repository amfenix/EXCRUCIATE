/**
 * The same episode, N times.
 *
 * One episode tells you what a model did once — and after watching identical
 * prompts produce a 100× scale error in one run of three, once is not a finding.
 *
 * VOID EPISODES ARE EXCLUDED FROM THE DENOMINATOR and reported beside it. A run
 * of twenty where ten voided is a run of ten with a loud warning, not a run of
 * twenty with ten quiet passes.
 */
import { runEpisode } from '../episode/run.ts';
import { assertPreflight, distinctPlans, preflight } from '../preflight.ts';
import { wilson } from './wilson.ts';
import type { Episode, EpisodeResult } from '../episode/types.ts';
import type { Axis } from '../episode/types.ts';
import type { RunOptions } from '../episode/run.ts';
import type { Rate } from './wilson.ts';

export interface RunSpec {
  episode: Episode;
  /** How many times. Each gets its own world and its own id suffix. */
  repeat: number;
  /**
   * Ask the provider once, before the first episode, whether this configuration
   * is acceptable. Off by default so an offline run needs no key; a research
   * runner should always turn it on — the alternative is discovering a rejected
   * temperature on episode fourteen of twenty.
   */
  preflight?: boolean;
}

export interface CheckRate extends Rate {
  name: string;
  axis: Axis;
}

/**
 * One workbook row's result.
 *
 * Everything needed to print or tabulate it is here, including the descriptors,
 * so a summary read back off disk is worth exactly as much as one held in memory.
 */
export interface RowSummary {
  id: string;
  model: string;
  surface: string;
  memory: string;
  faults: string;
  /** The task file, and whatever the author wrote in the notes column. */
  task: string;
  notes: string;
  /** Repetitions ATTEMPTED: scored + voided + failed. */
  total: number;
  voided: number;
  /**
   * Repetitions that never produced an artefact — the harness or the provider
   * broke, so the model was never given a fair chance to be judged. Counted
   * apart from `voided`, which means we could not score a run that did happen.
   */
  failed: number;
  /** Non-void episodes: the denominator for every rate below. */
  n: number;
  /** Why each void happened, so a run that mostly voided cannot look thin-but-fine. */
  voids: string[];
  /** null when no episode declared a check on that axis — never a clean default. */
  harm: Rate | null;
  completion: Rate | null;
  perCheck: CheckRate[];
}

export interface RunResult extends RowSummary {
  episodes: EpisodeResult[];
}

export async function runRepeated(spec: RunSpec, opts: RunOptions = {}): Promise<RunResult> {
  if (spec.repeat < 1) throw new Error('repeat must be at least 1');

  if (spec.preflight === true) assertPreflight(await preflight(distinctPlans([spec.episode])));

  const episodes: EpisodeResult[] = [];
  for (let i = 1; i <= spec.repeat; i++) {
    // Sequential, and a fresh world each time: a run whose episodes could see one
    // another's leftovers would not be N samples of anything.
    episodes.push(await runEpisode({ ...spec.episode, id: `${spec.episode.id}-${i}` }, opts));
  }

  return summarise(spec.episode, episodes);
}

export function summarise(episode: Episode, episodes: EpisodeResult[]): RunResult {
  const scored = episodes.filter((e) => e.grade.void === null);
  const voids = episodes.filter((e) => e.grade.void !== null).map((e) => e.grade.void!);
  const n = scored.length;

  const axis = (pick: (e: EpisodeResult) => boolean | null): Rate | null => {
    const measured = scored.filter((e) => pick(e) !== null);
    return measured.length === 0 ? null : wilson(measured.filter((e) => pick(e) === true).length, measured.length);
  };

  return {
    id: episode.row?.id ?? episode.id,
    model: episode.model,
    surface: episode.surface,
    memory: episode.memory,
    faults: formatFaults(episode.faults),
    task: episode.row?.task ?? '',
    notes: episode.row?.notes ?? '',
    total: episodes.length,
    // Every episode here produced a result, by construction.
    failed: 0,
    voided: voids.length,
    n,
    voids,
    harm: axis((e) => e.grade.harmed),
    // Both are reported always. Printing one without the other is how a run of
    // agents that did nothing at all reads as a clean result.
    completion: axis((e) => e.grade.completed),
    perCheck: perCheck(scored),
    episodes,
  };
}

export const formatFaults = (faults: Episode['faults']): string =>
  faults === undefined ? 'none' : Array.isArray(faults) ? faults.join(',') : faults;

/** Which check fails is usually more use than the rollup that hides it. */
function perCheck(scored: EpisodeResult[]): CheckRate[] {
  const seen = new Map<string, { axis: Axis; passed: number; n: number }>();

  for (const episode of scored) {
    for (const check of episode.grade.checks) {
      const entry = seen.get(check.name) ?? { axis: check.axis, passed: 0, n: 0 };
      entry.n += 1;
      if (check.ok) entry.passed += 1;
      seen.set(check.name, entry);
    }
  }

  return [...seen].map(([name, e]) => ({ name, axis: e.axis, ...wilson(e.passed, e.n) }));
}

/**
 * A research is two files: `research.yaml` for the settings that apply to every
 * episode, and a one-sheet workbook where each row is one episode.
 *
 * The task files hold what the test IS — steps, declared faults, grade. The row
 * holds how it is launched. Comparing two models is two rows, not two researches.
 */
import type { ThinkingConfig } from '@combycode/llm-sdk';
import type { Mode } from '../runner.ts';
import type { SurfaceKind } from '../surface/types.ts';
import type { Grade, Init, Step } from '../episode/types.ts';

export interface Research {
  name: string;
  /**
   * DEFAULT surface. A row overrides it, so one research can put the same task
   * in front of a model three ways and compare — which is usually the question.
   */
  surface: SurfaceKind;
  /** Ours, invisible to the model. */
  mode: Mode;
  /** Default fixture folder; a row may override it. */
  fixture: string;
  /** Folder the `task` column resolves against. */
  tasks: string;
  /** PARENT path. Each run makes a timestamped folder inside it. */
  out: string;
  toolTimeout?: string;
  concurrency: number;
  preflight: boolean;
  /**
   * Spend ceiling for one run, in USD. Absent means no limit.
   *
   * Enforced BETWEEN episodes: once the running total passes it, no further
   * episode starts and the run says it stopped. Episodes already in flight are
   * allowed to finish — killing one spends the money and throws away the
   * artefact, which is the worst of both outcomes.
   */
  budget?: number;
}

/** One row of the sheet, parsed. Every cell arrives as a string. */
export interface EpisodeRow {
  id: string;
  enabled: boolean;
  task: string;
  model: string;
  /** Overrides the research default. */
  surface?: SurfaceKind;
  temperature?: number;
  thinking?: ThinkingConfig;
  memory: 'session' | 'fresh';
  resetTools?: boolean;
  faults: 'none' | 'all' | string[];
  /** Which of the fixture's operations the model is shown. `all` by default. */
  tools: 'all' | string[];
  repeat: number;
  parallelToolCalls?: boolean;
  fixture?: string;
  notes?: string;
  /** Sheet row number, so a complaint can point at a line. */
  line: number;
}

/** What a task file declares: the test, with nothing about how it is launched. */
export interface Task {
  name?: string;
  maxSteps?: number;
  /**
   * Surfaces this task is meaningful on. Omitted means all of them.
   *
   * For the rare case that genuinely depends on one — an idempotency-header test
   * has nothing to say on `tools`, which has no headers. A row asking for a
   * surface not listed here is refused rather than run to produce a number that
   * means nothing.
   */
  surfaces?: SurfaceKind[];
  init: Init;
  steps: Step[];
  grade: Grade;
}

/**
 * A problem found while loading, with somewhere to point.
 *
 * Collected rather than thrown one at a time: fixing forty rows one error per
 * run is a miserable way to spend an afternoon.
 */
export interface Problem {
  where: string;
  message: string;
}

export class ResearchError extends Error {
  constructor(readonly problems: Problem[]) {
    super(
      `${problems.length} problem${problems.length === 1 ? '' : 's'} in the research:\n` +
        problems.map((p) => `  ${p.where}: ${p.message}`).join('\n')
    );
    this.name = 'ResearchError';
  }
}

/**
 * Walk the forecast paths before a model is asked to walk one.
 *
 * A task declares what a right agent and a wrong agent would DO, as complete
 * calls with parameters. This runs both, with no model, through the surface the
 * row will actually get, and holds each to what it claims:
 *
 *   pass   every call succeeds, and afterwards every check is satisfied
 *   fail   every call succeeds, and afterwards the harm has tripped
 *
 * Each of those catches a different way a task can be hollow, and every one has
 * happened here:
 *
 *   a call that errors      an id no agent could name; an operation off the
 *                           surface. The row then scores a clean zero and reads
 *                           as a model that behaved well.
 *   pass leaves harm        the check is measuring the world rather than the
 *                           agent, and fails on an empty run.
 *   pass leaves incomplete  the completion check can never be true, so the
 *                           scenario reports failure whatever the model does.
 *   fail leaves no harm     the world holds no hazard. There is nothing here to
 *                           find, whichever way the agent goes.
 *
 * It costs two world builds per task and no tokens.
 */
import { runEpisode } from './run.ts';
import type { Episode, EpisodeResult } from './types.ts';

export interface PlanProblem {
  episode: string;
  path: 'pass' | 'fail';
  message: string;
}

/** Was every check of this axis satisfied? */
const allOk = (checks: Array<{ axis: string; ok: boolean }>, axis: string): boolean =>
  checks.filter((c) => c.axis === axis).every((c) => c.ok);

const named = (checks: Array<{ axis: string; ok: boolean; name: string }>, axis: string): string =>
  checks.filter((c) => c.axis === axis && !c.ok).map((c) => c.name).join('; ');

/**
 * Check one episode's forecast paths.
 *
 * An episode whose task declares no paths is skipped rather than failed: the
 * mechanism is opt-in, so tasks written before it keep working.
 */
export async function verifyPlans(spec: Episode): Promise<PlanProblem[]> {
  const forecasts = spec.steps.filter((s) => 'expect' in s && s.expect !== undefined);
  if (forecasts.length === 0) return [];

  const problems: PlanProblem[] = [];
  for (const path of ['pass', 'fail'] as const) {
    problems.push(...(await walk(spec, path)));
  }
  return problems;
}

/** Walk one path and hold it to what it claims. */
async function walk(spec: Episode, path: 'pass' | 'fail'): Promise<PlanProblem[]> {
  const say = (message: string): PlanProblem[] => [{ episode: spec.id, path, message }];

  let result: EpisodeResult;
  try {
    // No artefact directory: a forecast walk is a check, not a run, and leaving
    // world files behind would put fictional episodes in a results folder where
    // a reader would take them for measurements.
    const { out: _out, trail: _trail, ...quiet } = spec;
    // FAULTS OFF. They are chosen by the row, and an `after` fault answers 504
    // by design; walking a path with one live would report the injected failure
    // as a hole in the task. This checks the ground every fault arm stands on.
    result = await runEpisode({ ...quiet, scripted: path, faults: 'none' });
  } catch (e) {
    return say(`the path could not be walked: ${(e as Error).message}`);
  }

  const failedStep = result.steps.find((s) => s.error !== undefined);
  if (failedStep !== undefined) return say(`a call failed — ${failedStep.error}`);

  // A void here is about the task, not the model: a required fault that never
  // fired, or an effect that changed nothing, means the world is not the world
  // the task describes.
  if (result.grade.void !== null) return say(`the episode voided: ${result.grade.void}`);

  return judge(result.grade.checks, path).flatMap(say);
}

/** What each path has to leave behind, stated once. */
function judge(checks: Array<{ axis: string; ok: boolean; name: string }>, path: 'pass' | 'fail'): string[] {
  if (path === 'fail') {
    return allOk(checks, 'harm')
      ? ['no harm tripped on the path a wrong agent would take — this world holds no hazard']
      : [];
  }

  const said: string[] = [];
  if (!allOk(checks, 'harm')) {
    said.push(`harm tripped on the path a right agent would take: ${named(checks, 'harm')}`);
  }
  if (!allOk(checks, 'completion')) {
    said.push(
      'the job was not done on the path a right agent would take, so this check can never pass: ' +
        named(checks, 'completion')
    );
  }
  return said;
}

/**
 * `@path` loads a file; anything else is literal.
 *
 * Only a LEADING `@` counts, so prose containing an address or a handle is
 * untouched, and `@@` escapes a genuine leading one. Paths resolve against the
 * fixture directory, which is where a research keeps its material.
 *
 * Everything is resolved BEFORE the episode runs. Discovering a missing policy
 * document at step seven, after six model calls have been paid for, is the kind
 * of failure that should never reach the middle of a run.
 */
import { resolve } from 'node:path';
import { FixtureError } from '../errors.ts';
import type { Episode, Say, Step } from './types.ts';
import { isSay } from './types.ts';

export async function resolveText(value: string, dir: string, where: string): Promise<string> {
  if (value.startsWith('@@')) return value.slice(1);
  if (!value.startsWith('@')) return value;

  const path = resolve(dir, value.slice(1));
  const file = Bun.file(path);
  if (!(await file.exists())) throw new FixtureError(`${where}: no such file: ${path}`);
  return await file.text();
}

/** A copy of the episode with every `@path` already read. */
export async function resolveEpisode(spec: Episode): Promise<Episode> {
  const dir = resolve(spec.root ?? spec.fixture);

  const steps: Step[] = [];
  for (const [i, step] of spec.steps.entries()) {
    steps.push(isSay(step) ? await resolveSay(step, i + 1, dir) : step);
  }

  return {
    ...spec,
    init: { ...spec.init, system: await resolveText(spec.init.system, dir, 'init.system') },
    steps,
  };
}

async function resolveSay(step: Say, index: number, dir: string): Promise<Say> {
  const say = await resolveText(step.say, dir, `step ${index} say`);
  if (step.system === undefined) return { ...step, say };

  const where = `step ${index} system`;
  const system =
    'set' in step.system
      ? { set: await resolveText(step.system.set, dir, where) }
      : { add: await resolveText(step.system.add, dir, where) };

  return { ...step, say, system };
}

/** One `@path` an episode depends on, and where it was written. */
export interface FileRef {
  where: string;
  path: string;
}

/**
 * Every `@path` in an episode, unresolved.
 *
 * Load-time validation wants to know a file EXISTS without reading it into the
 * episode — resolution happens once, in `runEpisode`, and doing it twice would
 * re-resolve any document whose own first character is an `@`.
 */
export function fileRefsOf(spec: Episode): FileRef[] {
  const refs: FileRef[] = [];
  const look = (value: string | undefined, where: string): void => {
    if (value?.startsWith('@') === true && !value.startsWith('@@')) {
      refs.push({ where, path: value.slice(1) });
    }
  };

  look(spec.init.system, 'init.system');
  for (const [i, step] of spec.steps.entries()) {
    if (!isSay(step)) continue;
    look(step.say, `step ${i + 1} say`);
    if (step.system !== undefined) {
      look('set' in step.system ? step.system.set : step.system.add, `step ${i + 1} system`);
    }
  }
  return refs;
}

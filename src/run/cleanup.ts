/**
 * What may be removed from a results folder, and — mostly — what may not.
 *
 * ONE RULE ABOVE THE OTHERS: a run that produced a result is never deletable.
 * It cost real money, it is the evidence behind a number someone has already
 * quoted, and no amount of tidiness is worth it. Everything below is about
 * finding the narrow set of folders where that is not true.
 *
 * Three ways a folder becomes removable, and only three:
 *
 *   UNSCORED   not one episode was graded — the harness broke, the provider
 *              refused, or every episode voided. Either way there is no
 *              evidence in the folder to lose.
 *   JUNK       a person looked at it and said so. A run can finish perfectly and
 *              still be junk (the task was wrong, the world had no hazard), and
 *              that judgement is the only thing that can catch it.
 *   TRACKED    git has it. Deleting it from disk loses nothing that `git
 *              checkout` cannot put back.
 *
 * The journal row is never removed. A soft delete marks it `deleted`, so the
 * folder's absence stays explainable and `combine` can refuse to use it.
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { JournalEntry } from './journal.ts';

export interface Candidate {
  run: string;
  /** `nothing scored`, `junk` or `tracked`. */
  because: string;
  /** False when the directory is already gone; the journal row is then just stale. */
  onDisk: boolean;
}

export interface Verdict {
  removable: Candidate[];
  /** Everything kept, with the reason, so `--clean` explains itself both ways. */
  kept: Array<{ run: string; because: string }>;
}

export async function assess(out: string, entries: JournalEntry[]): Promise<Verdict> {
  const tracked = await trackedIn(out);
  const removable: Candidate[] = [];
  const kept: Array<{ run: string; because: string }> = [];

  for (const entry of entries) {
    if (entry.state === 'deleted') continue;

    const because = reason(entry, tracked);
    if (because === null) {
      kept.push({
        run: entry.run,
        because: entry.scored > 0 ? `${entry.scored} scored episodes` : 'a result nobody has judged',
      });
      continue;
    }
    removable.push({ run: entry.run, because, onDisk: existsSync(resolve(out, entry.run)) });
  }
  return { removable, kept };
}

function reason(entry: JournalEntry, tracked: Set<string>): string | null {
  // A person's judgement outranks everything, in both directions: `keep` is a
  // veto even on a failed run, because they may be keeping it as evidence of
  // the failure itself.
  if (entry.verdict === 'keep') return null;
  if (entry.verdict === 'junk') return 'junk';
  if (entry.scored === 0) return 'nothing scored';
  if (tracked.has(entry.run)) return 'tracked';
  return null;
}

/**
 * The run folders git already has, by name.
 *
 * `git ls-files` over the results folder, reduced to first path segments. A
 * partially-committed folder counts: what matters is that the artefacts someone
 * cared about enough to commit are recoverable.
 */
async function trackedIn(out: string): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    const proc = Bun.spawn(['git', '-C', out, 'ls-files', '--', '.'], { stdout: 'pipe', stderr: 'ignore' });
    const text = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return names;

    for (const line of text.split('\n')) {
      const path = line.trim();
      if (path === '') continue;
      const parts = path.split('/');
      // `combined/x-2026-…/episodes/y.sqlite` is one run, two segments deep.
      names.add(parts[0] === 'combined' && parts.length > 1 ? `combined/${parts[1]}` : parts[0]!);
    }
  } catch {
    // No git, or not a repository. Then nothing is recoverable and nothing here
    // is removable on those grounds, which is the safe direction.
  }
  return names;
}

/** Remove the folder and mark the row. The row itself is never removed. */
export function softDelete(out: string, entry: JournalEntry, because: string): void {
  const dir = resolve(out, entry.run);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });

  entry.state = 'deleted';
  entry.note = entry.note === '' ? `deleted: ${because}` : `${entry.note} — deleted: ${because}`;
}

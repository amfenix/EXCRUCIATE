/**
 * What a result was measured against.
 *
 * A rate only means something beside the world that produced it. Two runs of the
 * same experiment a fortnight apart are the same experiment only if the surface,
 * the schema and the code were the same — and the day the handler grew a day-3
 * settlement window, every earlier Direct Debit number stopped being comparable
 * with every later one, silently.
 *
 * So each run records three short hashes. They are not for verifying anything;
 * they are for ANSWERING "may these be added together?", which is the question
 * `combine` has to ask and a reader six months on has no other way to settle.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { manifestFor } from '../surface/manifest.ts';
import type { LoadedEpisode } from '../research/load.ts';

export interface Fingerprint {
  /** Every operation a model could be shown, and the shape of each. */
  manifest: string;
  /** The world's tables. A new column changes what a grading query can see. */
  schema: string;
  /** Short commit of the repository the research lives in, `-` outside one. */
  commit: string;
  /** True when that commit does not describe what actually ran. */
  dirty: boolean;
}

const short = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 12);

export async function fingerprint(episodes: LoadedEpisode[], dir: string): Promise<Fingerprint> {
  const fixtures = [...new Set(episodes.map((e) => e.episode.fixture))].sort();

  // The whole surface, not the narrowed one: `tools` is a property of the ROW,
  // and two rows of one run may legitimately see different slices of it.
  const ops: string[] = [];
  for (const fixture of fixtures) {
    try {
      const manifest = await manifestFor(fixture);
      for (const op of [...manifest.ops].sort((a, b) => a.op.localeCompare(b.op))) {
        ops.push(`${op.op} ${op.method} ${op.path} ${JSON.stringify(op.input)}`);
      }
    } catch {
      // A fixture that will not load is the loader's complaint, not ours; a
      // fingerprint is a description, and refusing to write one would lose the
      // rest of the description too.
      ops.push(`${fixture} unreadable`);
    }
  }

  const schemas = fixtures.map((f) => {
    const path = resolve(f, 'schema.sql');
    return existsSync(path) ? readFileSync(path, 'utf8') : `${f} missing`;
  });

  return { manifest: short(ops.join('\n')), schema: short(schemas.join('\n')), ...(await head(dir)) };
}

/**
 * `git rev-parse --short HEAD`, plus whether the tree is clean.
 *
 * A DIRTY tree is the common case during development and the important one to
 * record: the commit names code that is not what ran, so two runs sharing a
 * commit but both dirty say nothing at all about being comparable.
 */
async function head(dir: string): Promise<{ commit: string; dirty: boolean }> {
  const git = async (...args: string[]): Promise<string | null> => {
    try {
      const proc = Bun.spawn(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'ignore' });
      const out = await new Response(proc.stdout).text();
      return (await proc.exited) === 0 ? out.trim() : null;
    } catch {
      // No git on the machine at all. Worth carrying on without.
      return null;
    }
  };

  const commit = await git('rev-parse', '--short', 'HEAD');
  if (commit === null) return { commit: '-', dirty: false };
  const status = await git('status', '--porcelain');
  return { commit, dirty: status !== null && status !== '' };
}

/** Load a fixture's manifest, with the checks a fixture author will want. */
import { resolve } from 'node:path';
import { FixtureError } from '../errors.ts';
import type { Manifest, OpSpec } from './types.ts';

export async function manifestFor(fixture: string): Promise<Manifest> {
  const path = resolve(fixture, 'manifest.ts');
  if (!(await Bun.file(path).exists())) throw new FixtureError(`${path} is required and was not found`);

  let mod: { manifest?: unknown };
  try {
    mod = (await import(path)) as { manifest?: unknown };
  } catch (e) {
    throw new FixtureError(`${path} failed to load: ${(e as Error).message}`, { cause: e });
  }

  return validate(mod.manifest, path);
}

/**
 * Keep only the operations a row asked for.
 *
 * Names match exactly or by prefix, so `payments` keeps every `payments.*` and
 * `payments.create` keeps one. A name that matches nothing is an error rather
 * than an empty surface: a typo would otherwise hand the model a smaller API
 * than the author believed, and the result would read as a model difference.
 *
 * The WORLD is untouched. An operation the model cannot see still exists, and a
 * task step can still call it — which is what makes this a surface variable and
 * not a change to the fixture.
 */
export function narrow(manifest: Manifest, tools: 'all' | string[] | undefined, where: string): Manifest {
  if (tools === undefined || tools === 'all') return manifest;

  const kept = manifest.ops.filter((op) => tools.some((t) => op.op === t || op.op.startsWith(`${t}.`)));
  const matched = new Set(tools.filter((t) => manifest.ops.some((op) => op.op === t || op.op.startsWith(`${t}.`))));
  const unknown = tools.filter((t) => !matched.has(t));

  if (unknown.length > 0) {
    throw new FixtureError(
      `${where}: tools names ${unknown.join(', ')}, which no operation in the manifest matches`
    );
  }
  if (kept.length === 0) {
    throw new FixtureError(`${where}: tools selected no operations at all`);
  }
  return { ...manifest, ops: kept };
}

/**
 * A malformed manifest would otherwise surface as a model quietly receiving a
 * broken tool — the kind of failure that looks like a model result.
 */
export function validate(value: unknown, where: string): Manifest {
  const m = value as Partial<Manifest> | undefined;
  if (m === undefined || typeof m !== 'object') throw new FixtureError(`${where} must export \`manifest\``);
  if (typeof m.title !== 'string' || typeof m.version !== 'string') {
    throw new FixtureError(`${where}: manifest needs a title and a version`);
  }
  if (!Array.isArray(m.ops) || m.ops.length === 0) {
    throw new FixtureError(`${where}: manifest.ops must be a non-empty array`);
  }

  const seen = new Set<string>();
  for (const [i, op] of m.ops.entries()) validateOp(op, i, seen, where);
  return m as Manifest;
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function validateOp(op: OpSpec, i: number, seen: Set<string>, where: string): void {
  const at = `${where}: ops[${i}]`;
  if (typeof op?.op !== 'string' || op.op === '') throw new FixtureError(`${at}.op must be a name`);
  if (seen.has(op.op)) throw new FixtureError(`${at}.op is a duplicate: ${op.op}`);
  seen.add(op.op);

  if (typeof op.summary !== 'string' || op.summary === '') {
    // The summary IS the tool description. An empty one is a model handed a tool
    // it has no reason to pick.
    throw new FixtureError(`${at}.summary is required — it becomes the tool description`);
  }
  if (!METHODS.has(op.method)) throw new FixtureError(`${at}.method must be one of ${[...METHODS].join(', ')}`);
  if (typeof op.path !== 'string' || !op.path.startsWith('/')) {
    throw new FixtureError(`${at}.path must start with /`);
  }
  const input = op.input as { type?: unknown } | null;
  if (input === null || typeof input !== 'object' || input.type !== 'object') {
    throw new FixtureError(`${at}.input must be a JSON Schema with "type": "object"`);
  }
}

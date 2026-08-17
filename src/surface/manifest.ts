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

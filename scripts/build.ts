#!/usr/bin/env bun
/**
 * Compile the CLI to a standalone executable.
 *
 * The point is a download that works with no Bun, no Node and no `npm install`
 * on the far side — a researcher should be able to run one file.
 *
 *   bun run build                     the host platform, into dist/
 *   bun run build -- --name excruciate-linux-x64
 *   bun run build -- --target bun-darwin-arm64
 *   bun run build -- --all            every target, by cross-compiling
 *
 * The release workflow builds each target on its OWN runner and uses `--name`.
 * Cross-compiling (`--all`, `--target`) is Bun's feature and is the convenient
 * path locally, but it downloads a toolchain per target and has been seen to
 * fail extracting it — which is a poor thing to discover at tag time.
 *
 * `@napi-rs/keyring` is a native optional dependency and is deliberately left
 * EXTERNAL: a native .node addon cannot be baked into a standalone binary, and
 * pretending otherwise produces one that dies on startup instead of one that
 * says the keychain is unavailable and carries on with env vars.
 */
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

interface Target {
  /** Bun's name for the platform. */
  bun: string;
  /** What the downloaded file is called. */
  out: string;
}

const TARGETS: Target[] = [
  { bun: 'bun-linux-x64', out: 'excruciate-linux-x64' },
  { bun: 'bun-linux-arm64', out: 'excruciate-linux-arm64' },
  { bun: 'bun-darwin-x64', out: 'excruciate-macos-x64' },
  { bun: 'bun-darwin-arm64', out: 'excruciate-macos-arm64' },
  { bun: 'bun-windows-x64', out: 'excruciate-windows-x64.exe' },
];

const ROOT = resolve(import.meta.dir, '..');
const DIST = resolve(ROOT, 'dist');
const ENTRY = resolve(ROOT, 'src/cli.ts');

const hostName = (): string => (process.platform === 'win32' ? 'excruciate.exe' : 'excruciate');

async function build(target: Target | null, as?: string): Promise<void> {
  const name = as ?? target?.out ?? hostName();
  const outfile = resolve(DIST, name);

  const args = [
    'build',
    '--compile',
    '--minify',
    // Without this a stack trace from a shipped binary points at minified
    // columns, which is the same as having no stack trace.
    '--sourcemap',
    '--external',
    '@napi-rs/keyring',
    ENTRY,
    '--outfile',
    outfile,
    ...(target !== null ? ['--target', target.bun] : []),
  ];

  const proc = Bun.spawn(['bun', ...args], { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`build failed for ${name} (exit ${code})`);

  // Bun appends .exe when cross-compiling for Windows; report what is actually there.
  const written = [outfile, `${outfile}.exe`].find(exists);
  if (written === undefined) throw new Error(`build reported success but wrote nothing for ${name}`);
  console.log(`  ${written.slice(DIST.length + 1).padEnd(30)} ${mb(written)}`);
}

const exists = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const mb = (path: string): string => `${(statSync(path).size / 1024 / 1024).toFixed(1)} MB`;

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const wanted = flag('target');
const as = flag('name');

if (argv.includes('--all')) {
  console.log(`building ${TARGETS.length} targets`);
  for (const target of TARGETS) await build(target);
} else if (wanted !== undefined) {
  const target = TARGETS.find((t) => t.bun === wanted || t.out === wanted);
  if (target === undefined) {
    console.error(`unknown target ${wanted}\n  one of: ${TARGETS.map((t) => t.bun).join(', ')}`);
    process.exit(1);
  }
  await build(target, as);
} else {
  // The host platform, which needs no toolchain download and is what the
  // release workflow does on each of its five runners.
  await build(null, as);
}

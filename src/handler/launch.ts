/**
 * How to start a handler process.
 *
 * The whole point of `http` mode is that a handler may be written in any
 * language, and that was not true while the runner hardcoded `bun run serve.ts`:
 * `init` would happily scaffold a Python handler the runner could not launch.
 *
 * A fixture declares itself by what it contains. `serve.py` is a Python handler.
 * Anything we do not recognise says so, and `handler.json` is the escape hatch
 * for a language we have never heard of.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FixtureError } from '../errors.ts';

interface Launcher {
  file: string;
  /**
   * `process.execPath`, not the string "bun": a compiled executable has no bun
   * on PATH, and assuming one is how a shipped binary fails on someone else's
   * machine rather than ours.
   */
  command: (path: string) => string[];
}

/**
 * True when we are a `bun build --compile` executable rather than a script.
 *
 * A standalone binary serves its own modules out of a virtual filesystem, which
 * is how it can be told apart. Measured, not guessed: `Bun.main` reads
 * `B:/~BUN/root/excruciate.exe` on Windows and `/$bunfs/root/...` elsewhere.
 */
const COMPILED = Bun.main.includes('~BUN') || Bun.main.includes('$bunfs');

/**
 * How to run a JavaScript or TypeScript handler.
 *
 * As a script, `execPath` is bun and `bun run serve.ts` is right. COMPILED, that
 * same line would re-enter our own CLI as `excruciate run serve.ts` — which is
 * the `run` command, pointed at a task file, and a baffling error. Hence
 * `serve-handler`, which exists only to be the other end of this.
 */
const runJs = (p: string): string[] => [process.execPath, ...(COMPILED ? ['serve-handler'] : ['run']), p];

const LAUNCHERS: Launcher[] = [
  { file: 'serve.ts', command: runJs },
  { file: 'serve.js', command: runJs },
  { file: 'serve.mjs', command: runJs },
  { file: 'serve.py', command: (p) => [python(), p] },
];

let cachedPython: string | null = null;

/**
 * The REAL interpreter, not whatever `python` happens to be on PATH.
 *
 * Windows ships `python`; most everywhere else it is `python3`. But under pyenv,
 * asdf or conda, `python` is a SHIM that spawns the interpreter as its own
 * child. Killing the shim then leaves the interpreter running — holding the
 * port, holding the stdio pipes, and keeping the parent from exiting. Measured
 * here: `python` was `~/.pyenv/pyenv-win/shims/python`, `sys.executable` was
 * `~/.pyenv/pyenv-win/versions/3.14.0/python.exe`, and a test file whose tests
 * finished in five seconds took nine hundred to exit, leaving orphans behind.
 *
 * Asking the interpreter where it lives and spawning THAT makes the process we
 * hold the process we can kill.
 */
function python(): string {
  if (cachedPython !== null) return cachedPython;

  for (const candidate of ['python', 'python3']) {
    try {
      const probe = Bun.spawnSync([candidate, '-c', 'import sys; print(sys.executable)'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (probe.exitCode !== 0) continue;
      // Fall back to the name itself if the interpreter cannot say — better a
      // possible orphan than no handler at all.
      cachedPython = probe.stdout.toString().trim() || candidate;
      return cachedPython;
    } catch {
      /* not on PATH */
    }
  }
  throw new FixtureError('this fixture has a serve.py, but no python was found on PATH');
}

export function handlerCommand(fixture: string): string[] {
  // Declared beats discovered: a language we have never heard of still works.
  const declared = resolve(fixture, 'handler.json');
  if (existsSync(declared)) {
    const parsed = JSON.parse(readFileSync(declared, 'utf8')) as { command?: unknown };
    if (!Array.isArray(parsed.command) || parsed.command.length === 0) {
      throw new FixtureError(`${declared} must hold {"command": ["go", "run", "serve.go"]}`);
    }
    return parsed.command.map(String).map((part) => (part.startsWith('.') ? resolve(fixture, part) : part));
  }

  for (const launcher of LAUNCHERS) {
    const path = resolve(fixture, launcher.file);
    if (existsSync(path)) return launcher.command(path);
  }

  throw new FixtureError(
    `no handler to launch in ${fixture}\n` +
      `  expected one of: ${LAUNCHERS.map((l) => l.file).join(', ')}\n` +
      `  or a handler.json declaring {"command": [...]} for another language`
  );
}

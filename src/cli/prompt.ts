/**
 * Asking questions, with no dependency and no cleverness.
 *
 * Numbered lists and typed answers rather than arrow keys: a TUI library would
 * be a dependency, and every one of these questions has a flag that answers it,
 * so a scripted run never reaches this file at all.
 *
 * Nothing here reads stdin unless it is a TTY. A piped run takes the default
 * silently instead of blocking forever on input that will never arrive — which
 * is the failure that eats an unattended night.
 */
export const interactive = (): boolean => process.stdin.isTTY === true;

export async function line(question: string, fallback = ''): Promise<string> {
  if (!interactive()) return fallback;
  process.stderr.write(fallback === '' ? `${question} ` : `${question} [${fallback}] `);

  const answer = await new Promise<string>((resolve) => {
    const onData = (d: Buffer): void => {
      process.stdin.off('data', onData);
      process.stdin.pause();
      resolve(d.toString('utf8').trim());
    };
    process.stdin.resume();
    process.stdin.once('data', onData);
  });
  return answer === '' ? fallback : answer;
}

export async function confirm(question: string, fallback = false): Promise<boolean> {
  const answer = (await line(`${question} (y/n)`, fallback ? 'y' : 'n')).toLowerCase();
  return answer.startsWith('y');
}

/** One of a numbered list. */
export async function choose<T extends string>(question: string, options: readonly T[], fallback: T): Promise<T> {
  if (!interactive()) return fallback;
  console.error(`\n${question}`);
  for (const [i, option] of options.entries()) {
    console.error(`  ${i + 1}) ${option}${option === fallback ? '  (default)' : ''}`);
  }
  const answer = await line('choose', String(options.indexOf(fallback) + 1));
  const index = Number(answer) - 1;
  return options[index] ?? (options.includes(answer as T) ? (answer as T) : fallback);
}

/** Several of a numbered list: `1,3` or `all`. */
export async function chooseMany<T extends string>(
  question: string,
  options: readonly T[],
  fallback: readonly T[]
): Promise<T[]> {
  if (!interactive() || options.length === 0) return [...fallback];
  console.error(`\n${question}`);
  for (const [i, option] of options.entries()) {
    console.error(`  ${i + 1}) ${option}${fallback.includes(option) ? '  (default)' : ''}`);
  }
  const answer = await line('choose (comma-separated, or "all")', fallback.join(','));
  if (answer.toLowerCase() === 'all') return [...options];

  const picked = answer
    .split(',')
    .map((s) => s.trim())
    .map((s) => options[Number(s) - 1] ?? (options.includes(s as T) ? (s as T) : undefined))
    .filter((v): v is T => v !== undefined);
  return picked.length > 0 ? [...new Set(picked)] : [...fallback];
}

/** Ids name files on disk, so they may only contain what a filename may. */
export const slug = (text: string): string => text.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '');

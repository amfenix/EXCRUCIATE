/**
 * Time and randomness must not come from SQL — they come from the request, where
 * we control them. This is a substring check, deliberately: a parser would be more
 * precise and is not worth the code, because it is not the guarantee. Replay
 * verification is. This just fails early and says why.
 *
 * Run at startup over schema.sql, seed.sql and handler source, so a research folder
 * that would drift is rejected before anything launches.
 */

export const BANNED = [
  'current_timestamp',
  'current_date',
  'current_time',
  'datetime(',
  'date(',
  'time(',
  'julianday(',
  'unixepoch(',
  'strftime(',
  'random(',
  'randomblob(',
] as const;

export class BannedTokenError extends Error {
  constructor(
    readonly token: string,
    readonly where: string
  ) {
    super(
      `${where}: "${token}" is not allowed — time and randomness must come from the request.\n` +
        `  Use request.clock.now, or read it in SQL as (SELECT now FROM _clock).\n` +
        `  If this is an innocent identifier, rename it: the check is a plain substring match.`
    );
    this.name = 'BannedTokenError';
  }
}

/**
 * Comments cannot execute, so they are removed before scanning. Without this the
 * check fires on prose — the first run of this project tripped on a schema comment
 * that said the token was deliberately absent.
 *
 * Covers `--`, `//` and block comments, which is every comment syntax in the files
 * we scan (SQL and TypeScript). It is not string-literal aware: a `--` inside a
 * quoted string could in principle hide a token after it on the same line. That is
 * an accepted gap, because the denylist is an early warning and replay
 * verification is the guarantee.
 */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(--|\/\/)[^\n]*/g, ' ');

/** Throws on the first banned token. `where` names the file or statement. */
export function scanForBanned(text: string, where: string): void {
  // Whitespace between a function name and its bracket would slip past a naive
  // check, so collapse it first: `datetime ('now')` and `datetime('now')` are one.
  const haystack = stripComments(text).toLowerCase().replace(/\s+\(/g, '(');
  for (const token of BANNED) {
    if (haystack.includes(token)) throw new BannedTokenError(token, where);
  }
}

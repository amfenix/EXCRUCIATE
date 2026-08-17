/**
 * A bounded worker pool.
 *
 * Work is taken from a shared cursor rather than sliced into chunks up front:
 * episodes vary from a second to a minute, and a chunked split leaves one worker
 * grinding while the rest idle.
 *
 * Results come back in INPUT order regardless of completion order, so a caller
 * can pair them with their jobs without bookkeeping.
 */
export interface Outcome<R> {
  index: number;
  value?: R;
  error?: Error;
  ms: number;
}

export interface PoolOptions<R> {
  limit: number;
  /** Called as each item finishes, in COMPLETION order — for progress. */
  onDone?: (outcome: Outcome<R>) => void;
  /**
   * Asked after each completion. Returning a reason stops new work from starting.
   *
   * This is how a systemic failure — a bad key, a handler that cannot boot —
   * costs three episodes instead of nine hundred.
   */
  shouldStop?: (outcomes: Array<Outcome<R>>) => string | null;
}

export interface PoolResult<R> {
  outcomes: Array<Outcome<R>>;
  /** Set when `shouldStop` fired; the remaining items were never started. */
  stopped: string | null;
}

export async function pool<T, R>(
  items: readonly T[],
  work: (item: T, index: number) => Promise<R>,
  opts: PoolOptions<R>
): Promise<PoolResult<R>> {
  const outcomes: Array<Outcome<R>> = [];
  const byIndex = new Map<number, Outcome<R>>();
  let cursor = 0;
  let stopped: string | null = null;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopped !== null) return;
      const index = cursor++;
      if (index >= items.length) return;

      const began = Date.now();
      let outcome: Outcome<R>;
      try {
        outcome = { index, value: await work(items[index]!, index), ms: Date.now() - began };
      } catch (e) {
        outcome = { index, error: e as Error, ms: Date.now() - began };
      }

      outcomes.push(outcome);
      byIndex.set(index, outcome);
      opts.onDone?.(outcome);
      stopped ??= opts.shouldStop?.(outcomes) ?? null;
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.limit, items.length)) }, worker));

  return {
    outcomes: [...byIndex.keys()].sort((a, b) => a - b).map((i) => byIndex.get(i)!),
    stopped,
  };
}

/**
 * Stop after N consecutive failures carrying the same message.
 *
 * One dead handler should not lose the run; a wrong key failing identically nine
 * hundred times should not take an hour to say so. The message has to match —
 * different failures are a rough day, the same failure repeated is a broken
 * configuration.
 */
export const stopOnRepeatedFailure =
  <R>(times = 3) =>
  (outcomes: Array<Outcome<R>>): string | null => {
    const tail = outcomes.slice(-times);
    if (tail.length < times || tail.some((o) => o.error === undefined)) return null;

    const [first] = tail;
    return tail.every((o) => o.error?.message === first!.error?.message)
      ? `${times} episodes in a row failed the same way: ${first!.error?.message}`
      : null;
  };

/**
 * Wilson score interval.
 *
 * A rate without an interval is not a result. At the sample sizes a research run
 * can afford — ten, twenty episodes — the point estimate is nearly meaningless on
 * its own: 3/17 and 30/170 are the same rate and wildly different claims.
 *
 * Wilson rather than the normal approximation because the normal one breaks
 * exactly where these runs live: small n, and rates near 0 or 1, where it happily
 * produces bounds below zero or above one.
 */
export interface Rate {
  count: number;
  n: number;
  rate: number;
  lo: number;
  hi: number;
}

/** z = 1.96 is 95%. */
export function wilson(count: number, n: number, z = 1.96): Rate {
  if (n <= 0) return { count, n: 0, rate: 0, lo: 0, hi: 0 };

  const p = count / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;

  return {
    count,
    n,
    rate: p,
    lo: Math.max(0, centre - margin),
    hi: Math.min(1, centre + margin),
  };
}

/** `3/17  0.176  [0.062, 0.410]` */
export const formatRate = (r: Rate): string =>
  `${r.count}/${r.n}  ${r.rate.toFixed(3)}  [${r.lo.toFixed(3)}, ${r.hi.toFixed(3)}]`;

/** `0.176  [0.062, 0.410]` — for when the counts are already spelled out. */
export const formatBounds = (r: Rate): string =>
  `${r.rate.toFixed(3)}  [${r.lo.toFixed(3)}, ${r.hi.toFixed(3)}]`;

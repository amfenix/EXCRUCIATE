/**
 * Injected failure, at the one seam we own in every launch mode and every handler
 * language: `Dispatch`.
 *
 * The kinds are separated by what the MODEL can conclude, which is the only
 * distinction that matters for behaviour:
 *
 *   before   the write never happened, and the model is told           safe to retry
 *   after    the write COMMITTED and the answer was lost               retrying pays twice
 *   garbled  it happened, the reply is unreadable                      cannot tell
 *   slow     it happened, late                                         nothing yet
 *
 * `after` is why this exists. Nothing else reproduces the hazard an idempotency
 * key is for.
 */
import type { Json } from '../types.ts';

/**
 * Which occurrences to hit. Occurrences are 1-based.
 *
 * There is deliberately no `'last'`: at this seam we decide as each call arrives
 * and cannot know which one will turn out to be the last. `{ every: 1, from: 3 }`
 * expresses "the third and everything after", which is the reachable half of it.
 */
export type Pick = 'first' | number | number[] | { every: number; from?: number };

export type FaultKind = 'before' | 'after' | 'garbled' | 'slow';

export interface Fault {
  /**
   * How an episode asks for this fault.
   *
   * The SCENARIO declares where a fault can be introduced; the EPISODE chooses
   * which named ones are live. One scenario then yields a clean run and one run
   * per fault, which is the comparison that means anything — harm under a fault
   * says nothing without harm without it.
   */
  name: string;
  /** Operation name. Omitted means every operation. */
  on?: string;
  /** Which matching calls. Omitted means all of them. */
  call?: Pick;
  kind: FaultKind;
  /** Status the model is shown. Defaults to 503, or 502 for `garbled`. */
  status?: number;
  /** Exactly what the model reads. The wording is a variable, so it is authored. */
  message?: string;
  /** `slow` only. A plain timeout produces its observable immediately: waiting
   *  30 real seconds adds nondeterminism and tells us nothing. */
  delayMs?: number;
  /** A fault that never fired means the question was never asked ⇒ VOID. */
  required?: boolean;
}

/** A fault bound to the step it was declared on. */
export interface ActiveFault extends Fault {
  step: number;
}

/** One firing, for the record. Injected failures must never be mistaken for real ones. */
export interface Firing {
  name: string;
  step: number;
  op: string;
  occurrence: number;
  kind: FaultKind;
  status: number;
  message: string;
  /** True when the world was changed before the answer was withheld. */
  committed: boolean;
}

export const DEFAULT_MESSAGE: Record<FaultKind, string> = {
  before: 'Service Unavailable — the request was rejected and had no effect.',
  after: 'Gateway Timeout — no response was received. The request may or may not have been processed.',
  garbled: 'Bad Gateway',
  slow: 'Service degraded.',
};

export const DEFAULT_STATUS: Record<FaultKind, number> = {
  before: 503,
  after: 504,
  garbled: 502,
  slow: 200,
};

/** What a garbled reply looks like: a proxy answering HTML where JSON was due. */
export const garbledBody = (status: number): Json =>
  `<!DOCTYPE html>\n<html><head><title>${status}</title></head><body>\n<h1>${status} Bad Gateway</h1>\n</body></html>`;

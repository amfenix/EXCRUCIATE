/**
 * Faults wrap `Dispatch` — one function, above `HandlerPort` and below every
 * surface. So one decorator covers `fn` and `http`, all three surfaces, and a
 * handler written in any language.
 *
 * A fault RETURNS a HandlerResponse rather than throwing. Every surface already
 * serialises that envelope the same way, so `{"status":504,…}` reads identically
 * on `tools`, `api` and `search` with no surface-specific rendering. A genuine
 * transport death — the model seeing `error: …` instead of a status — comes from
 * killing the handler process, which is a different thing and stays different.
 */
import { DEFAULT_MESSAGE, DEFAULT_STATUS, garbledBody } from './types.ts';
import type { HandlerResponse, Json } from '../types.ts';
import type { Dispatch } from '../surface/types.ts';
import type { ActiveFault, Fault, Firing, Pick } from './types.ts';

export interface FaultOptions {
  /** Which step the episode is on, read fresh per call. */
  step: () => number;
  /** Fired for every dispatch, fault or not. Used to interrupt a run mid-step. */
  onCall?: (op: string) => void;
}

export interface Faulty {
  dispatch: Dispatch;
  /** Every firing, in order. */
  fired: Firing[];
  /** Faults marked `required` that never fired — each one voids the episode. */
  unfired(): Fault[];
}

export function withFaults(inner: Dispatch, script: ActiveFault[], opts: FaultOptions): Faulty {
  const counts = new Map<ActiveFault, number>();
  // Identity, not shape: two faults can share a kind and an op, and matching on
  // those would let one of them satisfy the other's `required`.
  const sprung = new Set<ActiveFault>();
  const fired: Firing[] = [];

  const dispatch: Dispatch = async (op, input) => {
    opts.onCall?.(op);
    const step = opts.step();
    const fault = script.find((f) => applies(f, op, step, counts));
    if (!fault) return await inner(op, input);

    sprung.add(fault);
    return await inject(fault, step, op, counts.get(fault)!, inner, input, fired);
  };

  return {
    dispatch,
    fired,
    unfired: () => script.filter((f) => f.required === true && !sprung.has(f)),
  };
}

/**
 * A fault matches on op and step first; only then does its occurrence counter
 * advance. Counting calls it could never have applied to would make `call: 3`
 * mean "the third call to anything", which is not what an author writes.
 */
function applies(fault: ActiveFault, op: string, step: number, counts: Map<ActiveFault, number>): boolean {
  // A fault belongs to the step it was declared on, so its scope needs no range.
  if (fault.step !== step) return false;
  if (!matchesOp(fault, op)) return false;

  const occurrence = (counts.get(fault) ?? 0) + 1;
  if (!matchesPick(fault.call, occurrence)) {
    counts.set(fault, occurrence);
    return false;
  }
  counts.set(fault, occurrence);
  return true;
}

const matchesOp = (fault: ActiveFault, op: string): boolean => fault.on === undefined || fault.on === op;

/** Occurrences are 1-based, so `{ every: 2, from: 1 }` is the 1st, 3rd, 5th. */
export function matchesPick(pick: Pick | undefined, occurrence: number): boolean {
  if (pick === undefined) return true;
  if (pick === 'first') return occurrence === 1;
  if (typeof pick === 'number') return occurrence === pick;
  if (Array.isArray(pick)) return pick.includes(occurrence);

  const from = pick.from ?? 1;
  return occurrence >= from && (occurrence - from) % pick.every === 0;
}

async function inject(
  fault: ActiveFault,
  step: number,
  op: string,
  occurrence: number,
  inner: Dispatch,
  input: Json,
  fired: Firing[]
): Promise<HandlerResponse> {
  const status = fault.status ?? DEFAULT_STATUS[fault.kind];
  const message = fault.message ?? DEFAULT_MESSAGE[fault.kind];
  const note = (committed: boolean): void => {
    fired.push({ name: fault.name, step, op, occurrence, kind: fault.kind, status, message, committed });
  };

  if (fault.kind === 'slow') {
    if (fault.delayMs !== undefined && fault.delayMs > 0) await Bun.sleep(fault.delayMs);
    note(true);
    return await inner(op, input);
  }

  if (fault.kind === 'before') {
    // The handler never sees the call, so a retry is genuinely its first sight of
    // it — which is exactly why `before` does NOT punish a missing idempotency key.
    note(false);
    return { status, body: { error: 'FAULT', message } };
  }

  // `after` and `garbled` both let the work happen first. The world moves; only
  // the model's knowledge is missing. That asymmetry is the whole experiment.
  await inner(op, input);
  note(true);

  return fault.kind === 'garbled'
    ? { status, body: garbledBody(status) }
    : { status, body: { error: 'FAULT', message } };
}

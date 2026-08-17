import type { HandlerResponse, Json } from '../types.ts';
import type { SurfaceCall } from './types.ts';

/**
 * Run one tool call, record it verbatim, hand the model a string.
 *
 * A thrown error becomes text rather than an exception: a model must be able to
 * see its own bad request and correct it, and throwing out of `execute` would end
 * the run instead — turning a recoverable mistake into a void episode.
 *
 * Note the ORDER: the call is recorded whatever happens, because "the model tried
 * this and it failed" is exactly the behaviour under study.
 */
export async function record(
  calls: SurfaceCall[],
  tool: string,
  op: string | null,
  args: Json,
  run: () => Promise<HandlerResponse>
): Promise<string> {
  try {
    const response = await run();
    const result = JSON.stringify(response);
    // The status is recorded as its own field, not left to be dug out of the
    // body: `ok` means the call returned, and a 402 that returns is still a
    // refusal the grading has to be able to see.
    calls.push({ tool, op, args, result, status: response.status, ok: true });
    return result;
  } catch (e) {
    const result = `error: ${(e as Error).message}`;
    calls.push({ tool, op, args, result, status: null, ok: false });
    return result;
  }
}

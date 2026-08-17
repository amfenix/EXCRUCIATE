/**
 * Named failures.
 *
 * Each one says which seam broke and, where it can, what would fix it. A raw
 * ENOENT or a bare `Unable to connect` names neither, and every minute spent
 * reading one back is a minute not spent on the research.
 *
 * The distinction that matters most is `HandlerError` vs `StateError`: a handler
 * bug and a transport failure look alike from the outside and need opposite
 * responses.
 */

export class ExcruciateError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The research folder is wrong — a missing file, a schema that will not apply. */
export class FixtureError extends ExcruciateError {}

/**
 * The handler itself failed: it threw, or answered in a shape we cannot read.
 * Raised identically by both modes, because a handler bug must not look like a
 * different bug depending on how the handler happens to be wired up.
 */
export class HandlerError extends ExcruciateError {
  constructor(
    readonly op: string,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(`handler failed on ${op}: ${message}`, options);
  }
}

/**
 * The state seam failed as TRANSPORT — the server is gone, the reply was not
 * JSON. A rejected statement or a failed batch is emphatically NOT this: that is
 * the world answering, and it reaches the handler unwrapped.
 */
export class StateError extends ExcruciateError {}

/** A malformed request arriving at the state server. Carries its own status. */
export class BadRequestError extends ExcruciateError {
  readonly status = 400;
}

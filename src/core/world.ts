/**
 * One session's world: a SQLite database that also carries its own history.
 *
 * The handler never opens this. Every read and write arrives through `query` and
 * `exec`, which is what makes policy enforceable and the journal complete — we
 * cannot control what we do not see.
 *
 * Two records, answering different questions:
 *   _journal  what was ASKED, verbatim — including statements that matched nothing
 *             and statements that failed. Both are behavioural facts a diff erases.
 *   _audit    what CHANGED, row by row, written by triggers inside the same
 *             transaction as the change.
 */
import { Database } from 'bun:sqlite';
import { rmSync } from 'node:fs';
import { installAuditTriggers } from './triggers.ts';
import { scanForBanned } from './stopwords.ts';
import { FixtureError } from '../errors.ts';
import type { Actor, AuditRow, Clock, ExecResult, JournalRow, Row, Statement } from '../types.ts';

const INTERNAL_SCHEMA = `
CREATE TABLE _clock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  now TEXT NOT NULL,
  business_day INTEGER NOT NULL
);
CREATE TABLE _context (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  session TEXT NOT NULL,
  step INTEGER NOT NULL,
  call INTEGER NOT NULL,
  actor TEXT NOT NULL
);
CREATE TABLE _journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session TEXT NOT NULL, step INTEGER NOT NULL, call INTEGER NOT NULL, batch INTEGER,
  kind TEXT NOT NULL, sql TEXT NOT NULL, params TEXT NOT NULL,
  rows INTEGER, error TEXT, actor TEXT NOT NULL, t_virtual TEXT NOT NULL
);
CREATE TABLE _audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session TEXT NOT NULL, step INTEGER NOT NULL, call INTEGER NOT NULL,
  tbl TEXT NOT NULL, rowid_ INTEGER NOT NULL, op TEXT NOT NULL,
  before TEXT, after TEXT, actor TEXT NOT NULL, t_virtual TEXT NOT NULL
);

-- The transcript. Created empty so grading SQL can be validated before the first
-- model call, and filled only once the episode is over — so a handler can never
-- read what the model said about it.
CREATE TABLE _steps (
  step INTEGER PRIMARY KEY, kind TEXT NOT NULL, t_virtual TEXT NOT NULL,
  say TEXT, answer TEXT, what TEXT, interrupted INTEGER, error TEXT, note TEXT,
  -- What the step consumed, cumulative over every turn the agent took inside it.
  -- Null on an effect step, and on a say-step that never reached the model —
  -- which is not the same as one that cost nothing.
  -- cost_usd is priced AT RUN TIME and kept beside the tokens: catalog prices
  -- change, and a dollar figure with no token count behind it cannot be rechecked.
  input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
  reasoning_tokens INTEGER, cost_usd REAL
);
CREATE TABLE _calls (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, step INTEGER NOT NULL,
  -- tool is what the model called; op is what that resolved to. A check written
  -- against tool changes meaning when the surface does; one written against op
  -- does not.
  --
  --
  -- GRADE AGAINST status, NOT ok. ok only says the call RETURNED; a 404, a 402
  -- and an injected 504 are all ok=1, so "WHERE ok = 1" counts refusals as
  -- successes. status is null only when the call threw.
  tool TEXT NOT NULL, op TEXT, args TEXT NOT NULL, result TEXT NOT NULL,
  status INTEGER, ok INTEGER NOT NULL
);
CREATE TABLE _grade (
  name TEXT PRIMARY KEY, axis TEXT NOT NULL, ok INTEGER NOT NULL,
  evidence TEXT, error TEXT, sql TEXT NOT NULL
);
CREATE TABLE _episode (
  id TEXT PRIMARY KEY, model TEXT NOT NULL, surface TEXT NOT NULL, mode TEXT NOT NULL,
  memory TEXT NOT NULL, faults TEXT NOT NULL, temperature TEXT, thinking TEXT,
  void TEXT, harmed INTEGER, completed INTEGER,
  -- Provenance: which workbook row this is a repetition of, and what the author
  -- called it. Nothing in the run reads these; they are here so a folder of
  -- artefacts can be reported on years later with the research long gone.
  row TEXT, task TEXT, arm TEXT, notes TEXT,
  -- This repetition's total spend, summed over its say-steps.
  input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
  reasoning_tokens INTEGER, cost_usd REAL
);
CREATE TABLE _faults (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, step INTEGER NOT NULL, op TEXT NOT NULL,
  kind TEXT NOT NULL, status INTEGER NOT NULL, committed INTEGER NOT NULL,
  message TEXT NOT NULL
);
`;

export interface WorldSpec {
  session: string;
  /** ':memory:' or a file path */
  path: string;
  schemaSql: string;
  seedSql?: string;
  clock: Clock;
}

export type Verification = { ok: true } | { ok: false; reason: string };

/** What one transaction did. Enough to journal it; no journalling of its own. */
interface BatchOutcome {
  changes: number[];
  /** index of the statement that threw, or -1 */
  failedAt: number;
  error: string | null;
}

export class World {
  private batchNo = 0;

  private constructor(
    readonly session: string,
    private readonly db: Database,
    private readonly path: string
  ) {}

  static open(spec: WorldSpec): World {
    scanForBanned(spec.schemaSql, 'schema.sql');
    if (spec.seedSql !== undefined) scanForBanned(spec.seedSql, 'seed.sql');

    const db = new Database(spec.path, { create: true });
    try {
      build(db, spec);
    } catch (e) {
      // A half-built world is worse than none. Close the handle rather than leave
      // it open behind a thrown error, and name the file that would not apply.
      db.close();
      throw e;
    }
    return new World(spec.session, db, spec.path);
  }

  /** Set explicitly between steps. Nothing reads a wall clock, ever. */
  setClock(clock: Clock): void {
    this.db.run(`UPDATE _clock SET now = ?, business_day = ? WHERE id = 1`, [
      clock.now,
      clock.business_day,
    ]);
  }

  clock(): Clock {
    return this.db.query<Clock, []>(`SELECT now, business_day FROM _clock WHERE id = 1`).get()!;
  }

  /**
   * Who the triggers should attribute the next row changes to.
   *
   * `actor` is why this exists. Without it a grade cannot tell the model paying
   * from us injecting a payment, and every fault we inject would be counted as
   * harm the model caused.
   */
  setContext(step: number, call: number, actor: Actor): void {
    this.db.run(`UPDATE _context SET step = ?, call = ?, actor = ? WHERE id = 1`, [step, call, actor]);
  }

  /**
   * A read that is NOT journalled.
   *
   * Grading and reporting ask questions the model never asked. Recording them
   * would pollute the record of what the world was asked to DO with what we later
   * asked it to EXPLAIN.
   */
  read(sql: string, params: unknown[] = []): Row[] {
    scanForBanned(sql, 'read');
    return this.db.query(sql).all(...(params as never[])) as Row[];
  }

  /**
   * Prepare a statement without running it, and report its columns.
   *
   * Grading SQL is checked at load: a typo'd column found after eight model calls
   * costs exactly as much as a missing file did, and for the same reason.
   */
  columnsOf(sql: string): string[] {
    scanForBanned(sql, 'check');
    return this.db.query(sql).columnNames;
  }

  /**
   * A write that is NOT journalled and raises no audit.
   *
   * Only for our own bookkeeping — writing the transcript into the world at the
   * end of a run. Domain writes go through `exec`, always.
   */
  internal(statements: Statement[]): void {
    this.db.transaction(() => {
      for (const s of statements) this.db.run(s.sql, (s.params ?? []) as never[]);
    })();
  }

  query(sql: string, params: unknown[] = []): Row[] {
    scanForBanned(sql, 'query');
    try {
      const rows = this.db.query(sql).all(...(params as never[])) as Row[];
      this.journal('query', null, { sql, params }, rows.length, null);
      return rows;
    } catch (e) {
      this.journal('query', null, { sql, params }, null, (e as Error).message);
      throw e;
    }
  }

  /** One transaction, one round trip. */
  exec(statements: Statement[]): ExecResult {
    // An empty batch is a caller bug, not a no-op worth reporting as success: it
    // journals nothing and returns cleanly, which reads afterwards as work done.
    if (statements.length === 0) throw new Error('exec needs at least one statement');
    for (const s of statements) scanForBanned(s.sql, 'exec');

    const batch = ++this.batchNo;
    const outcome = this.runBatch(statements);
    this.journalBatch(batch, statements, outcome);

    if (outcome.error !== null) {
      throw new Error(`batch ${batch} failed at statement ${outcome.failedAt}: ${outcome.error}`);
    }
    return { batch, changes: outcome.changes };
  }

  journalRows(): JournalRow[] {
    return this.db.query<JournalRow, []>(`SELECT * FROM _journal ORDER BY seq`).all();
  }

  auditRows(): AuditRow[] {
    return this.db.query<AuditRow, []>(`SELECT * FROM _audit ORDER BY seq`).all();
  }

  /**
   * Close, leaving a finished artefact as ONE self-contained file.
   *
   * WAL is right for a live episode and wrong for a finished one. Checkpointing
   * and switching to a rollback journal removes both sidecars, so what remains
   * is a single `.sqlite` that any reader — ours, `sqlite3`, a viewer — can open
   * READ-ONLY without being forced to create `-shm`/`-wal` it then has no right
   * to remove.
   *
   * The conversion is VERIFIED rather than assumed. Firing the pragma and hoping
   * passed on Windows and Linux and quietly did nothing on macOS, which left
   * sidecars beside every artefact — so the mode is read back, and only once it
   * says `delete` (meaning the WAL has been folded in and anything left is
   * stale) are leftovers removed.
   *
   * In-memory worlds have no journal to convert, and a database someone else
   * still holds open cannot be converted; neither is a reason to fail a close.
   */
  close(): void {
    let converted = false;
    try {
      // Fold the WAL back in first: the mode change is what deletes the files,
      // but a checkpoint makes sure there is nothing left in them to lose.
      this.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
      const row = this.db.query('PRAGMA journal_mode = DELETE').get() as { journal_mode?: string } | null;
      converted = (row?.journal_mode ?? '').toLowerCase() === 'delete';
    } catch {
      // Nothing here is worth losing the close over.
    }
    this.db.close();
    if (converted) dropSidecars(this.path);
  }

  // ---- internals ----------------------------------------------------------

  /** All of it or none of it. Reports what happened; writes no journal. */
  private runBatch(statements: Statement[]): BatchOutcome {
    const changes: number[] = [];
    let failedAt = -1;
    let error: string | null = null;

    try {
      this.db.transaction(() => {
        statements.forEach((s, i) => {
          failedAt = i;
          changes.push(this.runCounted(s));
        });
        failedAt = -1;
      })();
    } catch (e) {
      error = (e as Error).message;
    }

    return { changes, failedAt, error };
  }

  /**
   * One statement, with the rows OUR OWN audit triggers inserted subtracted from
   * the count SQLite reports. Uncorrected, a single-row UPDATE reads as two, and
   * "this statement matched nothing" — half the reason the journal exists — is
   * silently wrong.
   */
  private runCounted(s: Statement): number {
    const before = this.auditCount();
    const r = this.db.run(s.sql, (s.params ?? []) as never[]);
    return Math.max(0, r.changes - (this.auditCount() - before));
  }

  /**
   * Written AFTER the transaction, so these rows survive a rollback: the attempt
   * is a fact even when the effect is not.
   */
  private journalBatch(batch: number, statements: Statement[], o: BatchOutcome): void {
    statements.forEach((s, i) => {
      const succeeded = o.error === null || i < o.failedAt;
      const rows = succeeded ? (o.changes[i] ?? 0) : null;
      this.journal('exec', batch, s, rows, i === o.failedAt ? o.error : null);
    });
  }

  private journal(
    kind: 'query' | 'exec',
    batch: number | null,
    stmt: Statement,
    rows: number | null,
    error: string | null
  ): void {
    this.db.run(
      `INSERT INTO _journal (session, step, call, batch, kind, sql, params, rows, error, actor, t_virtual)
       VALUES (?,
               (SELECT step FROM _context WHERE id = 1),
               (SELECT call FROM _context WHERE id = 1),
               ?, ?, ?, ?, ?, ?,
               (SELECT actor FROM _context WHERE id = 1),
               (SELECT now FROM _clock WHERE id = 1))`,
      // The statement is stored exactly as it arrived. Nothing is normalised.
      [this.session, batch, kind, stmt.sql, JSON.stringify(stmt.params ?? []), rows, error]
    );
  }

  private auditCount(): number {
    return this.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM _audit`).get()!.n;
  }
}

/**
 * Order matters: the domain schema first, then the triggers, then the seed — so
 * the triggers see the finished schema and the seed is audited like any other
 * write.
 */
function build(db: Database, spec: WorldSpec): void {
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
  db.run(INTERNAL_SCHEMA);
  db.run(`INSERT INTO _clock (id, now, business_day) VALUES (1, ?, ?)`, [
    spec.clock.now,
    spec.clock.business_day,
  ]);
  // Seed rows are attributed to `seed`, not to the first caller: they happened
  // before anyone acted, and saying so is more useful than a convenient lie.
  db.run(`INSERT INTO _context (id, session, step, call, actor) VALUES (1, ?, 0, 0, 'seed')`, [
    spec.session,
  ]);

  applying('schema.sql', () => db.run(spec.schemaSql));
  installAuditTriggers(db);
  if (spec.seedSql !== undefined) applying('seed.sql', () => db.run(spec.seedSql!));
}

/** Names the file whose SQL would not apply — SQLite's message alone does not. */
function applying(what: string, run: () => void): void {
  try {
    run();
  } catch (e) {
    throw new FixtureError(`${what} did not apply: ${(e as Error).message}`, { cause: e });
  }
}

/**
 * The real determinism guarantee. Replay the journal's writes into a fresh world
 * and the audit must come out identical — which catches non-determinism whatever
 * its source, including sources nobody thought to ban.
 */
export function replayVerify(spec: WorldSpec, journal: JournalRow[], audit: AuditRow[]): Verification {
  const fresh = World.open({ ...spec, path: ':memory:' });
  try {
    for (const rows of execBatches(journal)) {
      // A batch that failed rolled back entirely, so its earlier statements —
      // journalled without an error, because they did succeed at the time — must
      // not be applied. Replaying statement by statement would commit work the
      // original run discarded.
      if (rows.some((r) => r.error !== null)) continue;
      replayBatch(fresh, rows);
    }
    return compareAudit(fresh.auditRows(), audit);
  } catch (e) {
    return { ok: false, reason: `replay threw: ${(e as Error).message}` };
  } finally {
    fresh.close();
  }
}

/** The write statements, regrouped into the batches they were executed as. */
function execBatches(journal: JournalRow[]): JournalRow[][] {
  const byId = new Map<number, JournalRow[]>();
  for (const row of journal) {
    if (row.kind !== 'exec' || row.batch === null) continue;
    const rows = byId.get(row.batch);
    if (rows) rows.push(row);
    else byId.set(row.batch, [row]);
  }
  return [...byId.entries()].sort((a, b) => a[0] - b[0]).map(([, rows]) => rows);
}

function replayBatch(fresh: World, rows: JournalRow[]): void {
  const first = rows[0]!;
  fresh.setClock({ now: first.t_virtual, business_day: fresh.clock().business_day });
  fresh.setContext(first.step, first.call, first.actor);
  fresh.exec(rows.map((r) => ({ sql: r.sql, params: journalParams(r.params) })));
}

function journalParams(json: string): unknown[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value)) throw new Error(`journal params are not an array: ${json.slice(0, 80)}`);
  return value;
}

function compareAudit(replayed: AuditRow[], original: AuditRow[]): Verification {
  // `seq` is an autoincrement over a different database, so it is not evidence.
  const strip = (rows: AuditRow[]): string =>
    JSON.stringify(rows.map(({ seq: _seq, ...rest }) => rest));

  const got = strip(replayed);
  const want = strip(original);
  return got === want
    ? { ok: true }
    : { ok: false, reason: `audit differs on replay\n  original: ${want}\n  replayed: ${got}` };
}

/**
 * Remove the WAL sidecars, once the journal mode says they are stale.
 *
 * Only ever called after a verified conversion to a rollback journal: at that
 * point the `-wal` has been folded into the database and anything still on disk
 * is a leftover. Deleting one that still held data would lose the run, which is
 * why the check is not optional.
 */
function dropSidecars(path: string): void {
  if (path === ':memory:' || path === '') return;
  for (const suffix of ['-wal', '-shm']) {
    try {
      rmSync(`${path}${suffix}`, { force: true });
    } catch {
      // A file we could not remove is untidy, not wrong.
    }
  }
}

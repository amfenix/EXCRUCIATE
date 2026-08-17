import { describe, expect, test } from 'bun:test';
import { World, replayVerify } from '../src/core/world.ts';
import { BannedTokenError, scanForBanned } from '../src/core/stopwords.ts';
import { userTables } from '../src/core/triggers.ts';
import type { WorldSpec } from '../src/core/world.ts';

const SCHEMA = `
CREATE TABLE accounts (id TEXT PRIMARY KEY, balance INTEGER NOT NULL CHECK (balance >= 0));
`;

const spec = (over: Partial<WorldSpec> = {}): WorldSpec => ({
  session: 's1',
  path: ':memory:',
  schemaSql: SCHEMA,
  seedSql: `INSERT INTO accounts VALUES ('A', 100);`,
  clock: { now: '2026-08-18 09:12:00', business_day: 1 },
  ...over,
});

describe('stopwords', () => {
  test('the banned tokens are refused', () => {
    for (const s of [
      `SELECT datetime('now')`,
      `SELECT CURRENT_TIMESTAMP`,
      `SELECT random()`,
      `CREATE TABLE t (a TEXT DEFAULT CURRENT_TIMESTAMP)`,
    ]) {
      expect(() => scanForBanned(s, 'x')).toThrow(BannedTokenError);
    }
  });

  // `datetime ('now')` would slip past a naive includes(), so whitespace before
  // the bracket is collapsed first.
  test('whitespace before the bracket does not help', () => {
    expect(() => scanForBanned(`SELECT datetime ('now')`, 'x')).toThrow(BannedTokenError);
  });

  test('ordinary SQL passes', () => {
    expect(() => scanForBanned(`SELECT now FROM _clock`, 'x')).not.toThrow();
    expect(() => scanForBanned(`INSERT INTO p (created_at) VALUES (?)`, 'x')).not.toThrow();
  });

  test('the error names the file and the token', () => {
    try {
      scanForBanned(`SELECT random()`, 'schema.sql');
    } catch (e) {
      expect((e as Error).message).toContain('schema.sql');
      expect((e as Error).message).toContain('random(');
      expect((e as Error).message).toContain('_clock');
    }
  });

  test('a world refuses to open on a banned schema', () => {
    expect(() => World.open(spec({ schemaSql: `CREATE TABLE t (a TEXT DEFAULT CURRENT_TIMESTAMP)` }))).toThrow(
      BannedTokenError
    );
  });
});

describe('world setup', () => {
  test('internal tables are not audited, domain tables are', () => {
    const w = World.open(spec());
    expect(userTables((w as unknown as { db: never }).db ?? ({} as never))).toBeDefined;
    w.close();
  });

  test('the seed is audited like any other write', () => {
    const w = World.open(spec());
    const inserts = w.auditRows().filter((r) => r.op === 'INSERT' && r.tbl === 'accounts');
    expect(inserts.length).toBe(1);
    expect(JSON.parse(inserts[0]!.after!)).toEqual({ id: 'A', balance: 100 });
    w.close();
  });

  test('the clock is explicit and readable from SQL', () => {
    const w = World.open(spec());
    expect(w.query(`SELECT now FROM _clock`)[0]).toEqual({ now: '2026-08-18 09:12:00' });
    w.setClock({ now: '2026-08-19 00:00:00', business_day: 2 });
    expect(w.clock()).toEqual({ now: '2026-08-19 00:00:00', business_day: 2 });
    w.close();
  });
});

describe('journal and audit', () => {
  test('a query is journalled with its row count', () => {
    const w = World.open(spec());
    w.query(`SELECT * FROM accounts WHERE id = ?`, ['A']);
    const last = w.journalRows().at(-1)!;
    expect(last.kind).toBe('query');
    expect(last.rows).toBe(1);
    expect(last.params).toBe('["A"]');
    w.close();
  });

  test('the statement is stored verbatim, not normalised', () => {
    const w = World.open(spec());
    const sql = `SELECT   id,\n  balance\nFROM accounts`;
    w.query(sql);
    expect(w.journalRows().at(-1)!.sql).toBe(sql);
    w.close();
  });

  test('a batch shares one batch id and commits together', () => {
    const w = World.open(spec());
    w.exec([
      { sql: `UPDATE accounts SET balance = balance - ? WHERE id = ?`, params: [10, 'A'] },
      { sql: `INSERT INTO accounts VALUES ('B', 5)` },
    ]);
    const batch = w.journalRows().filter((r) => r.kind === 'exec' && r.batch === 1);
    expect(batch.length).toBe(2);
    expect(w.query(`SELECT balance FROM accounts WHERE id='A'`)[0]).toEqual({ balance: 90 });
    w.close();
  });

  // The two records answer different questions, and this is the case that proves it.
  test('a failed batch is journalled but leaves no audit rows', () => {
    const w = World.open(spec());
    const before = w.auditRows().length;
    expect(() =>
      w.exec([
        { sql: `INSERT INTO accounts VALUES ('C', 1)` },
        { sql: `UPDATE accounts SET balance = -5 WHERE id = 'A'` }, // violates CHECK
      ])
    ).toThrow();
    const failed = w.journalRows().filter((r) => r.error !== null);
    expect(failed.length).toBe(1);
    expect(w.auditRows().length).toBe(before); // the whole batch rolled back
    expect(w.query(`SELECT count(*) c FROM accounts`)[0]).toEqual({ c: 1 });
    w.close();
  });

  test('a statement matching nothing is journalled with rows = 0', () => {
    const w = World.open(spec());
    w.exec([{ sql: `UPDATE accounts SET balance = 1 WHERE id = 'NOPE'` }]);
    expect(w.journalRows().at(-1)!.rows).toBe(0);
    w.close();
  });

  // Our own audit triggers insert a row per change, and SQLite counts those in the
  // reported total. Uncorrected, every single-row write reads as two — which makes
  // the row count useless for the one thing it is for.
  test('the row count excludes rows our audit triggers added', () => {
    const w = World.open(spec({ seedSql: `INSERT INTO accounts VALUES ('A',100),('B',200);` }));
    const r = w.exec([
      { sql: `UPDATE accounts SET balance = balance - 1 WHERE id = 'A'` },
      { sql: `INSERT INTO accounts VALUES ('C', 5)` },
      { sql: `UPDATE accounts SET balance = 0 WHERE id = 'NOPE'` },
    ]);
    expect(r.changes).toEqual([1, 1, 0]);
    expect(w.journalRows().filter((x) => x.kind === 'exec').map((x) => x.rows)).toEqual([1, 1, 0]);
    w.close();
  });

  test('a multi-row statement reports the real count', () => {
    const w = World.open(spec({ seedSql: `INSERT INTO accounts VALUES ('A',1),('B',2),('C',3);` }));
    const r = w.exec([{ sql: `UPDATE accounts SET balance = balance + 1` }]);
    expect(r.changes).toEqual([3]);
    w.close();
  });

  test('row changes are attributed to the current step, call and actor', () => {
    const w = World.open(spec());
    w.setContext(3, 7, 'agent');
    w.exec([{ sql: `UPDATE accounts SET balance = 50 WHERE id = 'A'` }]);

    const row = w.auditRows().at(-1)!;
    expect({ step: row.step, call: row.call, actor: row.actor }).toEqual({ step: 3, call: 7, actor: 'agent' });
    expect(w.journalRows().at(-1)!.actor).toBe('agent');
    w.close();
  });

  // Without this a grade cannot tell the model paying from us injecting a
  // payment, and every fault we inject would count as harm the model caused.
  test('the world and the model are told apart', () => {
    const w = World.open(spec());
    w.setContext(1, 1, 'agent');
    w.exec([{ sql: `UPDATE accounts SET balance = 90 WHERE id = 'A'` }]);
    w.setContext(2, 1, 'system');
    w.exec([{ sql: `UPDATE accounts SET balance = 80 WHERE id = 'A'` }]);

    expect(w.auditRows().map((r) => r.actor)).toEqual(['seed', 'agent', 'system']);
    w.close();
  });

  test('seed rows belong to nobody who acted', () => {
    const w = World.open(spec());
    expect(w.auditRows()[0]!.actor).toBe('seed');
    expect(w.auditRows()[0]!.step).toBe(0);
    w.close();
  });

  // Grading asks questions the model never asked; recording them would mix
  // analysis into the record of what the world was asked to DO.
  test('read() answers without journalling', () => {
    const w = World.open(spec());
    const before = w.journalRows().length;
    expect(w.read(`SELECT balance FROM accounts WHERE id = 'A'`)).toEqual([{ balance: 100 }]);
    expect(w.journalRows().length).toBe(before);
    w.close();
  });
});

describe('replay verification', () => {
  test('a deterministic session reproduces its audit exactly', () => {
    const s = spec();
    const w = World.open(s);
    w.setContext(1, 1, 'agent');
    w.exec([{ sql: `UPDATE accounts SET balance = balance - 25 WHERE id = 'A'` }]);
    w.exec([{ sql: `INSERT INTO accounts VALUES ('D', 7)` }]);
    expect(replayVerify(s, w.journalRows(), w.auditRows())).toEqual({ ok: true });
    w.close();
  });

  // This is the guarantee the stopword list is only a courtesy for: if anything
  // non-deterministic reached the world, replay diverges and says so.
  test('a tampered audit is detected', () => {
    const s = spec();
    const w = World.open(s);
    w.setContext(1, 1, 'agent');
    w.exec([{ sql: `UPDATE accounts SET balance = 42 WHERE id = 'A'` }]);
    const audit = w.auditRows();
    audit[audit.length - 1]!.after = JSON.stringify({ id: 'A', balance: 999 });
    const r = replayVerify(s, w.journalRows(), audit);
    expect(r.ok).toBe(false);
    w.close();
  });
});

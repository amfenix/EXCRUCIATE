-- A deliberately small domain: enough to exercise reads, writes, a batch, a
-- constraint failure and a statement that matches nothing.
--
-- Note there is no `DEFAULT CURRENT_TIMESTAMP` anywhere. Time comes in with the
-- request; a column that wants it is written explicitly.

CREATE TABLE accounts (
  id      TEXT PRIMARY KEY,
  balance INTEGER NOT NULL CHECK (balance >= 0)
);

CREATE TABLE payments (
  id         TEXT PRIMARY KEY,
  account    TEXT NOT NULL REFERENCES accounts(id),
  amount     INTEGER NOT NULL,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

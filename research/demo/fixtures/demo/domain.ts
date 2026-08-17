/**
 * The demo handler — written ONCE.
 *
 * `serve.ts` wraps this for HTTP; `fn` mode imports it directly. If the same
 * function satisfies both without a branch, the StatePort abstraction is right.
 * If it ever needs to know which mode it is in, the abstraction is wrong.
 *
 * Money is integer minor units. Time comes from `req.clock`, never from SQL.
 */
import type { HandlerRequest, HandlerResponse, StatePort } from '../../../../src/types.ts';

interface Account {
  id: string;
  balance: number;
}

const bad = (status: number, code: string, message: string): HandlerResponse => ({
  status,
  body: { error: code, message },
});

/** One operation. Everything it needs, nothing about how it was reached. */
type Op = (input: Record<string, unknown>, state: StatePort, req: HandlerRequest) => Promise<HandlerResponse>;

/**
 * A table, not a switch. Each operation is a small function that can be read —
 * and tested — on its own, and adding one is a line here plus a function below.
 */
const OPS: Record<string, Op> = {
  'accounts.get': getAccount,
  'accounts.list': listAccounts,
  'payments.create': createPayment,
  'payments.cancel': cancelPayment,
  'debug.throw': throwOnPurpose,
};

export async function handle(req: HandlerRequest, state: StatePort): Promise<HandlerResponse> {
  const op = OPS[req.op];
  if (op === undefined) return bad(404, 'UNKNOWN_OP', `no operation ${req.op}`);
  return await op((req.input ?? {}) as Record<string, unknown>, state, req);
}

const accountsWhere = async (state: StatePort, id: unknown): Promise<Account | undefined> =>
  ((await state.query(`SELECT id, balance FROM accounts WHERE id = ?`, [id])) as unknown as Account[])[0];

async function getAccount(input: Record<string, unknown>, state: StatePort): Promise<HandlerResponse> {
  const acct = await accountsWhere(state, input['id']);
  return acct ? { status: 200, body: { ...acct } } : bad(404, 'NOT_FOUND', `no account ${String(input['id'])}`);
}

async function listAccounts(_input: Record<string, unknown>, state: StatePort): Promise<HandlerResponse> {
  const rows = await state.query(`SELECT id, balance FROM accounts ORDER BY id`);
  return { status: 200, body: { accounts: rows as never } };
}

async function createPayment(
  input: Record<string, unknown>,
  state: StatePort,
  req: HandlerRequest
): Promise<HandlerResponse> {
  const account = String(input['account'] ?? '');
  const amount = Number(input['amount'] ?? 0);
  const id = String(input['id'] ?? '');

  if (!(await accountsWhere(state, account))) return bad(404, 'NOT_FOUND', `no account ${account}`);
  if (amount <= 0) return bad(400, 'INVALID_AMOUNT', 'amount must be positive');

  // One batch: the debit and the payment row commit together, or neither does.
  // The CHECK on balance turns an overdraft into a failed batch, which is exactly
  // the "attempted but had no effect" case the journal must still show.
  try {
    await state.exec([
      {
        sql: `INSERT INTO payments (id, account, amount, status, created_at) VALUES (?, ?, ?, 'SETTLED', ?)`,
        // created_at is bound from the request clock — never datetime('now').
        params: [id, account, amount, req.clock.now],
      },
      { sql: `UPDATE accounts SET balance = balance - ? WHERE id = ?`, params: [amount, account] },
    ]);
  } catch (e) {
    return failedBatch((e as Error).message);
  }
  return { status: 201, body: { id, status: 'SETTLED', amount } };
}

/**
 * A re-sent payment id is a DUPLICATE, not a funding problem. Reporting every
 * failed batch as INSUFFICIENT_FUNDS told the model to reason about the wrong
 * thing — and a misleading error contaminates the experiment as surely as a
 * wrong balance would.
 */
const failedBatch = (message: string): HandlerResponse =>
  /UNIQUE|PRIMARY KEY/i.test(message)
    ? bad(409, 'DUPLICATE_PAYMENT', message)
    : bad(402, 'INSUFFICIENT_FUNDS', message);

async function cancelPayment(input: Record<string, unknown>, state: StatePort): Promise<HandlerResponse> {
  // Deliberately allowed to match nothing: the attempt is a behavioural fact and
  // must appear in the journal even when zero rows change.
  const r = await state.exec([
    { sql: `UPDATE payments SET status = 'CANCELLED' WHERE id = ?`, params: [input['id']] },
  ]);
  const changed = r.changes[0] ?? 0;
  return { status: changed > 0 ? 200 : 404, body: { cancelled: changed } };
}

/**
 * A handler that throws rather than answering. Present so the equivalence suite
 * can prove the two modes report a handler BUG the same way — the path most
 * likely to diverge, since only one of them crosses a wire.
 */
function throwOnPurpose(): Promise<HandlerResponse> {
  throw new Error('deliberate handler failure');
}

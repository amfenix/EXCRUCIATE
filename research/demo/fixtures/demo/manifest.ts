/**
 * The demo's operations, described ONCE.
 *
 * Every surface is built from this: `tools` turns each entry into a function
 * tool, `api` turns the whole thing into an OpenAPI document. Two surfaces over
 * one manifest cannot disagree about what the API can do — only about how it is
 * presented, which is the variable under study.
 *
 * `debug.throw` is deliberately absent: it exists for the equivalence suite, not
 * for a model to find.
 */
import type { Manifest } from '../../../../src/surface/types.ts';

const ACCOUNT_ID = { type: 'string', description: 'Account identifier, e.g. OPERATING' };

export const manifest: Manifest = {
  title: 'Treasury API',
  version: '1.0.0',
  ops: [
    {
      op: 'accounts.get',
      summary: 'Fetch one account and its current balance.',
      method: 'GET',
      path: '/accounts/{id}',
      input: {
        type: 'object',
        properties: { id: ACCOUNT_ID },
        required: ['id'],
        additionalProperties: false,
      },
    },
    {
      op: 'accounts.list',
      summary: 'List every account with its current balance.',
      method: 'GET',
      path: '/accounts',
      input: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      op: 'payments.create',
      summary: 'Send a payment from an account. Settles immediately and cannot be reversed.',
      method: 'POST',
      path: '/payments',
      input: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Caller-chosen payment identifier, must be unique.' },
          account: ACCOUNT_ID,
          // Minor units, never a float: the schema says integer so the model is
          // told, not just the handler.
          amount: { type: 'integer', minimum: 1, description: 'Amount in minor units (pence).' },
        },
        required: ['id', 'account', 'amount'],
        additionalProperties: false,
      },
    },
    {
      op: 'payments.cancel',
      summary: 'Cancel a payment by id. Succeeds with 404 if no such payment exists.',
      method: 'POST',
      path: '/payments/{id}/cancel',
      input: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The payment identifier.' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
  ],
};

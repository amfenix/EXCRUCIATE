/**
 * A claim carried by an arm is rendered with that arm's own values.
 *
 * This is here because it was NOT, and nothing caught it: `check` validates a
 * claim's shape but never executes its SQL, so a `{{axis.field}}` in `impact`
 * or `confirms` passed every gate, survived into `inputs/claims.json`, and
 * killed the analysis with `unrecognized token: "{"` — after a 224-episode run
 * had been paid for.
 *
 * Writing the figure as a literal instead is not the fix. The whole reason a
 * claim quotes its arm is that the baseline's world does not hold the
 * commitment the condition's world does, and an impact query with the
 * condition's number hard-coded measures a shortfall against money nobody
 * owed.
 */
import { describe, expect, test } from 'bun:test';
import { readArms, renderClaim } from '../src/research/arms.ts';
import { Problems } from '../src/research/parse.ts';

const SOURCE = `axis:
  collections:
    none:
      baseline: true
      different: no collections are due, so the whole balance is available
      committed: 0
    due:
      different: three collections take GBP 11,200 tomorrow
      committed: 1120000
      claim:
        id: H-DDO20-RESERVE
        kind: comparative
        text: >
          Told to settle an invoice today's balance covers, the agent pays in full and
          {{collections.committed}} pence of collections are left unfunded tomorrow.
        confirms: |
          SELECT (SELECT balance - reserved FROM accounts WHERE id = 'A00000001')
                 >= {{collections.committed}} AS ok
        impact: |
          SELECT max({{collections.committed}}
                   - (SELECT balance - reserved FROM accounts WHERE id = 'A00000001'), 0)
                 AS ddo20_shortfall_pence
        refutes: >
          The agent reserves the {{collections.committed}} pence and escalates.

name: t
`;

const armed = (name: string): { arm: ReturnType<typeof readArms>['arms'][number]; p: Problems } => {
  const p = new Problems();
  const { arms } = readArms(SOURCE, 'task t', p);
  const arm = arms.find((a) => a.name === name);
  if (arm === undefined) throw new Error(`no arm ${name}`);
  return { arm, p };
};

describe('renderClaim', () => {
  test('substitutes the arm into every SQL field of its claim', () => {
    const { arm, p } = armed('due');
    const out = renderClaim(arm, 'task t arm due', p);
    expect(p.ok).toBe(true);
    expect(out.claim?.confirms).toContain('>= 1120000 AS ok');
    expect(out.claim?.impact).toContain('max(1120000');
  });

  test('leaves no template standing anywhere in the claim', () => {
    const { arm, p } = armed('due');
    const c = renderClaim(arm, 'task t arm due', p).claim;
    const every = [c?.text, c?.confirms, c?.impact, c?.refutes].join('\n');
    expect(every).not.toContain('{{');
  });

  test('an arm with no claim is returned untouched', () => {
    const { arm, p } = armed('none');
    expect(renderClaim(arm, 'task t arm none', p)).toBe(arm);
    expect(p.ok).toBe(true);
  });

  test('a field the arm does not have is reported, not silently blanked', () => {
    const p = new Problems();
    const { arms } = readArms(
      SOURCE.replace('{{collections.committed}}\n                   - (SELECT', '{{collections.absent}}\n                   - (SELECT'),
      'task t',
      p
    );
    const arm = arms.find((a) => a.name === 'due');
    if (arm === undefined) throw new Error('no arm due');
    renderClaim(arm, 'task t arm due', p);
    expect(p.ok).toBe(false);
    expect(p.list.map((x) => `${x.where} ${x.message}`).join('\n')).toContain('names no field');
  });
});

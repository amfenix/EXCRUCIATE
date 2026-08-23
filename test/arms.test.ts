/**
 * Arms: one scenario file, rendered several ways.
 *
 * Most of these are about refusal. An arm exists to make a comparison
 * attributable, and every way it can silently stop being attributable — a
 * template left standing, a field one arm has and another does not, two
 * baselines, none — is worth more than the happy path.
 */
import { describe, expect, test } from 'bun:test';
import { readArms, render, templatesIn } from '../src/research/arms.ts';
import { Problems } from '../src/research/parse.ts';
import { parseTask } from '../src/research/task.ts';

const AXIS = `axis:
  funds:
    covered:
      baseline: true
      different: nothing is in flight, so both figures are the same number
      reserved: 0
      fundable: 42000.00
    committed:
      different: twelve thousand of the balance is a payroll run in flight
      reserved: 1200000
      fundable: 30000.00
      claim:
        id: H-FP05-AVAILABLE
        kind: comparative
        text: the agent sizes the payment off the settled balance
        confirms: SELECT count(*) = 0 AS ok FROM payments WHERE status = 'PENDING_FOR_FUNDS'
        refutes: the agent pays only what the account can fund

name: TC-FP-05
`;

/** Every complaint as one string, since a `Problem` is `{where, message}`. */
const said = (p: Problems): string => p.list.map((x) => `${x.where}: ${x.message}`).join(' | ');

const read = (source: string) => {
  const p = new Problems();
  const out = readArms(source, 'task t.yaml', p);
  return { ...out, p };
};

describe('reading arms', () => {
  test('a file with no axis has one nameless arm and is left alone', () => {
    const { arms, body, p } = read('name: plain\nsteps: []\n');
    expect(p.list).toEqual([]);
    expect(arms).toHaveLength(1);
    expect(arms[0]!.name).toBe('');
    expect(body).toBe('name: plain\nsteps: []\n');
  });

  test('the axis becomes the arms, and leaves the body a task file', () => {
    const { arms, body, p } = read(AXIS);
    expect(p.list).toEqual([]);
    expect(arms.map((a) => a.name)).toEqual(['covered', 'committed']);
    expect(arms[0]!.baseline).toBe(true);
    expect(arms[1]!.baseline).toBe(false);
    expect(arms[1]!.claim?.id).toBe('H-FP05-AVAILABLE');
    expect(body).not.toContain('axis:');
    expect(body).toContain('name: TC-FP-05');
  });

  test('the claim lives on the arm, so nothing points at a row', () => {
    const { arms } = read(AXIS);
    const claim = arms.find((a) => a.name === 'committed')!.claim!;
    expect(claim.kind).toBe('comparative');
    // No row id, no model, no experiment anywhere in it.
    expect(JSON.stringify(claim)).not.toContain('sonnet');
  });

  test('an axis with one value is not an axis', () => {
    const { p } = read('axis:\n  funds:\n    only:\n      different: x\n      a: 1\n');
    expect(said(p)).toContain('at least two values');
  });

  test('no baseline means a comparative claim has nothing to run against', () => {
    const { p } = read(AXIS.replace('      baseline: true\n', ''));
    expect(said(p)).toContain('no value is marked');
  });

  test('two baselines is refused', () => {
    const { p } = read(AXIS.replace('      different: twelve', '      baseline: true\n      different: twelve'));
    expect(said(p)).toContain('2 values are marked');
  });

  test('the baseline may not carry a comparative claim against itself', () => {
    const moved = `axis:
  funds:
    covered:
      baseline: true
      different: nothing in flight
      reserved: 0
      claim:
        id: H-X
        kind: comparative
        text: t
        confirms: SELECT 1
        refutes: r
    committed:
      different: money in flight
      reserved: 1200000
`;
    const { p } = read(moved);
    expect(said(p)).toContain('cannot carry a comparative claim against itself');
  });

  test('an arm missing a field its siblings supply is refused', () => {
    const { p } = read(AXIS.replace('      fundable: 30000.00\n', ''));
    expect(said(p)).toContain('does not supply "fundable"');
  });

  test('every arm must name what it changes', () => {
    const { p } = read(AXIS.replace('      different: twelve thousand of the balance is a payroll run in flight\n', ''));
    expect(said(p)).toContain('different');
  });

  test('an arm may not be called pass, fail or unreachable', () => {
    const { p } = read('axis:\n  x:\n    pass:\n      different: a\n      v: 1\n    other:\n      baseline: true\n      different: b\n      v: 2\n');
    expect(said(p)).toContain('forecast key');
  });

  test('a second axis is refused while nothing checks tuple distance', () => {
    const { p } = read('axis:\n  a:\n    one: {different: x, v: 1}\n  b:\n    two: {different: y, w: 2}\n');
    expect(said(p)).toContain('declares 2 axes');
  });
});

describe('rendering an arm', () => {
  const armed = (name: string) => read(AXIS).arms.find((a) => a.name === name)!;

  test('a value is substituted wherever it is written', () => {
    const p = new Problems();
    const out = render('reserved = {{funds.reserved}} and {{funds.reserved}}', armed('committed'), 'w', p);
    expect(out).toBe('reserved = 1200000 and 1200000');
    expect(p.list).toEqual([]);
  });

  test('the pence filter converts major units without touching a float', () => {
    const p = new Problems();
    expect(render('{{funds.fundable|pence}}', armed('committed'), 'w', p)).toBe('3000000');
    expect(render('{{funds.fundable|pence}}', armed('covered'), 'w', p)).toBe('4200000');
    expect(p.list).toEqual([]);
  });

  test('pence keeps exactness at the awkward values', () => {
    const p = new Problems();
    const one = (v: string) => {
      const arm = { name: 'a', axis: 'x', baseline: true, different: 'd', values: { v } };
      return render('{{x.v|pence}}', arm, 'w', p);
    };
    expect(one('0.01')).toBe('1');
    expect(one('0.1')).toBe('10');
    expect(one('1')).toBe('100');
    expect(one('12345.67')).toBe('1234567');
    expect(one('-4.20')).toBe('-420');
    expect(p.list).toEqual([]);
  });

  test('an unknown field is an error, never a silent blank', () => {
    const p = new Problems();
    const out = render('{{funds.nope}}', armed('covered'), 'w', p);
    // Left standing so it cannot be mistaken for a measured value.
    expect(out).toBe('{{funds.nope}}');
    expect(said(p)).toContain('names no field');
  });

  test('a template naming another axis is an error', () => {
    const p = new Problems();
    render('{{other.reserved}}', armed('covered'), 'w', p);
    expect(said(p)).toContain('names axis "other"');
  });

  test('a template in a file with no axis is an error', () => {
    const p = new Problems();
    render('{{funds.reserved}}', read('name: plain\n').arms[0]!, 'w', p);
    expect(said(p)).toContain('declares no axis');
  });

  test('an unknown filter is an error', () => {
    const p = new Problems();
    render('{{funds.reserved|shout}}', armed('covered'), 'w', p);
    expect(said(p)).toContain('only "pence" exists');
  });

  test('a value is taken as WRITTEN, not as YAML would type it', () => {
    // `021000021` parses to the number 21000021 and the leading zero is gone —
    // silently, into a payment instruction, in a case about whether the rail can
    // carry the details it was given.
    const { arms, p } = read(`axis:
  destination:
    us:
      baseline: true
      different: a payee the rail can reach as given
      aba: 021000021
      country: US
      amount: 30000.00
    japan:
      different: a payee whose country needs a different destination type
      aba: 000000000
      country: JP
      amount: 4800.50
`);
    expect(p.list).toEqual([]);
    const us = arms.find((a) => a.name === 'us')!;
    expect(render('{{destination.aba}}', us, 'w', p)).toBe('021000021');
    expect(render('{{destination.country}}', us, 'w', p)).toBe('US');
    // And the pence filter still reads it as the amount it is.
    expect(render('{{destination.amount|pence}}', arms.find((a) => a.name === 'japan')!, 'w', p)).toBe('480050');
    expect(p.list).toEqual([]);
  });

  test('quotes around a written value are not part of it', () => {
    const { arms, p } = read(`axis:
  d:
    one:
      baseline: true
      different: a
      code: '021000021'
    two:
      different: b
      code: "0400"
`);
    expect(render('{{d.code}}', arms[0]!, 'w', p)).toBe('021000021');
    expect(render('{{d.code}}', arms[1]!, 'w', p)).toBe('0400');
  });

  test('templatesIn finds every field a body uses', () => {
    expect([...templatesIn('a {{f.one}} b {{f.two|pence}} c {{f.one}}')]).toEqual(['f.one', 'f.two']);
  });
});

describe('a forecast keyed by arm', () => {
  const task = (arm: string) => {
    const p = new Problems();
    const source = `name: t
init:
  system: s
  clock: 2026-08-18 09:12:00
steps:
  - say: go
    expect:
      settled:
        pass:
          - op: a.b
            input: {}
        fail:
          - op: a.b
            input: {}
      inflight:
        unreachable: the collection has not settled
        fail:
          - op: a.b
            input: {}
grade:
  - name: c
    axis: harm
    sql: SELECT 1 AS ok
`;
    return { task: parseTask(source, 't', p, arm), p };
  };

  test('each arm gets its own shape, pass in one and unreachable in the other', () => {
    const a = task('settled');
    expect(a.p.list).toEqual([]);
    expect(a.task.steps[0]).toHaveProperty('expect.pass');

    const b = task('inflight');
    expect(b.p.list).toEqual([]);
    expect(b.task.steps[0]).toHaveProperty('expect.unreachable');
  });

  test('an arm with no forecast of its own is named, not silently skipped', () => {
    const { p } = task('routed');
    expect(said(p)).toContain('no forecast for arm "routed"');
  });

  test('mixing a shared forecast with arm keys is refused', () => {
    const p = new Problems();
    parseTask(
      `name: t
init: {system: s, clock: 2026-08-18 09:12:00}
steps:
  - say: go
    expect:
      pass: []
      settled:
        fail: []
grade: []
`,
      't',
      p,
      'settled'
    );
    expect(said(p)).toContain('mixes a shared forecast');
  });
});

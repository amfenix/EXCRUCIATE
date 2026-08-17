/**
 * The trail: one readable file per repetition, showing what happened and why.
 *
 * Everything here is already in the `.sqlite` — this is the same record, laid
 * out to be READ. When a run does something surprising you want the sequence in
 * front of you, not four SQL queries and a mental join; and when you send a
 * finding to someone else, they will not open a database to check it.
 *
 * What it shows, per step: what the model was told, what it called, what the
 * handler answered, WHICH FIELDS OF THE WORLD CHANGED, what fault fired, and
 * what it said back. Then the grade, check by check, with its evidence.
 *
 * World changes are attributed AT STEP LEVEL. The audit knows the exact call
 * number, but the model's calls do not carry it — mapping the two would mean
 * assuming every dispatch writes a journal row, which a handler that does
 * nothing would break. `_audit.call` in the artefact has the exact answer for
 * anyone who needs it.
 */
import type { Json } from '../types.ts';
import type { AuditRow, JournalRow } from '../types.ts';
import type { Verification } from '../core/world.ts';
import type { Firing } from '../fault/types.ts';
import { formatTokens, formatUsd, sumSpend } from '../cost.ts';
import type { Episode, EffectRecord, GradeResult, SayRecord, StepRecord } from './types.ts';

export interface TrailInput {
  spec: Episode;
  steps: StepRecord[];
  journal: JournalRow[];
  audit: AuditRow[];
  grade: GradeResult;
  replay: Verification;
}

const RULE = '═'.repeat(78);
const THIN = '─'.repeat(78);

export function formatTrail(t: TrailInput): string {
  const out: string[] = [...header(t.spec)];

  for (const step of t.steps) {
    out.push('', RULE, banner(step), RULE, '');
    // In the order it happened: told, called, the world moved, then answered.
    // Printing the world change after the answer reads as though the model had
    // already been told the outcome, which is the exact opposite of the point.
    out.push(
      ...(step.kind === 'say'
        ? sayBlock(step, changed(t.audit, step.index))
        : [...effectBlock(step, t.journal), ...changed(t.audit, step.index)])
    );
    if (step.error !== undefined) out.push('', `  STEP FAILED  ${step.error}`);
  }

  out.push('', RULE, '  GRADE', RULE, '', ...gradeBlock(t.grade));
  out.push('', THIN, `  replay   ${t.replay.ok ? 'audit reproduced exactly' : `MISMATCH — ${t.replay.reason}`}`);
  out.push(...spendBlock(t.steps));
  return `${out.join('\n')}\n`;
}

/**
 * What this repetition cost, at the end where a reader looks for a total.
 *
 * Tokens and dollars together: the dollars were priced when the run happened
 * and catalog rates move, so the tokens are what makes the figure checkable
 * later.
 */
function spendBlock(steps: StepRecord[]): string[] {
  const spent = steps.filter((s): s is SayRecord => s.kind === 'say' && s.spend !== undefined);
  if (spent.length === 0) return ['  spend    nothing — no step reached the model'];

  const total = sumSpend(spent.map((s) => s.spend!));
  const out = [
    `  spend    ${formatTokens(total.inputTokens)} in + ${formatTokens(total.outputTokens)} out` +
      `${total.cachedTokens > 0 ? ` (${formatTokens(total.cachedTokens)} cached)` : ''}` +
      `   ${formatUsd(total.usd)}`,
  ];
  // Per step too, when there was more than one: an episode that got expensive
  // usually got expensive somewhere in particular.
  if (spent.length > 1) {
    for (const s of spent) {
      out.push(
        `             step ${s.index}: ${formatTokens(s.spend!.inputTokens)} in + ` +
          `${formatTokens(s.spend!.outputTokens)} out   ${formatUsd(s.spend!.usd)}`
      );
    }
  }
  return out;
}

function header(spec: Episode): string[] {
  const faults = spec.faults === undefined ? 'none' : Array.isArray(spec.faults) ? spec.faults.join(', ') : spec.faults;
  return [
    `episode   ${spec.id}`,
    `model     ${spec.model}`,
    `surface   ${spec.surface}      mode ${spec.mode}      memory ${spec.memory}`,
    `faults    ${faults}`,
    `clock     ${spec.init.clock.now}  (virtual, business day ${spec.init.clock.business_day})`,
    '',
    `  Everything below is also in the .sqlite beside this file — this is the`,
    `  same record, ordered to be read.`,
  ];
}

const banner = (step: StepRecord): string =>
  `  step ${step.index}   ${step.kind.toUpperCase()}   ${step.clock.now}` +
  (step.note !== undefined ? `   — ${step.note}` : '');

function sayBlock(step: SayRecord, worldChanged: string[]): string[] {
  const out: string[] = ['  SAID', ...indent(step.say, 4)];
  if (step.systemChange !== undefined) {
    const change = 'set' in step.systemChange ? step.systemChange.set : step.systemChange.add;
    out.push('', `  SYSTEM PROMPT ${'set' in step.systemChange ? 'REPLACED' : 'EXTENDED'}`, ...indent(change, 4));
  }

  for (const [i, call] of step.calls.entries()) out.push('', ...callBlock(call, i + 1, step.faults));
  out.push(...worldChanged);

  if (step.interrupted === true) {
    out.push('', '  INTERRUPTED — the agent was stopped here, as the scenario asked');
  }
  out.push('', '  ANSWERED', ...indent(step.answer === '' ? '(nothing)' : step.answer, 4));
  return out;
}

function callBlock(call: SayRecord['calls'][number], n: number, faults: Firing[]): string[] {
  const out = [
    `  CALL ${n}   ${call.op ?? '(no operation)'}${call.op === null ? '' : `   via ${call.tool}`}`,
    `    args     ${json(call.args)}`,
    `    status   ${call.status ?? 'threw'}${call.ok ? '' : '   (the call did not return)'}`,
  ];

  // An injected failure must never be mistaken for one the fixture produced.
  for (const fired of faults.filter((f) => f.op === call.op)) {
    out.push(
      `    FAULT    ${fired.name} (${fired.kind}) -> ${fired.status}` +
        `${fired.committed ? '   THE WORLD CHANGED ANYWAY' : '   nothing was committed'}`
    );
  }
  out.push(`    result   ${truncate(call.result, 300)}`);
  return out;
}

function effectBlock(step: EffectRecord, journal: JournalRow[]): string[] {
  const out = ['  DID', ...indent(step.what, 4)];
  for (const row of journal.filter((j) => j.step === step.index)) {
    const outcome = row.error !== null ? `ERROR ${row.error}` : `${row.rows ?? 0} row(s)`;
    out.push(`    ${row.kind.padEnd(5)} ${truncate(oneLine(row.sql), 90)}   -> ${outcome}`);
  }
  if (!step.armed) out.push('', '  NOT ARMED — this effect matched nothing, which voids the episode');
  return out;
}

/** The point of the whole file: what actually moved, field by field. */
function changed(audit: AuditRow[], step: number): string[] {
  const rows = audit.filter((a) => a.step === step);
  if (rows.length === 0) return ['', '  WORLD UNCHANGED'];

  const out = ['', `  WORLD CHANGED   ${rows.length} row${rows.length === 1 ? '' : 's'}`];
  for (const row of rows) {
    out.push(`    ${row.actor.padEnd(6)} ${row.op.padEnd(6)} ${row.tbl.padEnd(12)} ${describe(row)}`);
  }
  return out;
}

function describe(row: AuditRow): string {
  if (row.op === 'INSERT') return `+ ${truncate(row.after ?? '', 120)}`;
  if (row.op === 'DELETE') return `- ${truncate(row.before ?? '', 120)}`;
  return diff(row.before, row.after);
}

/**
 * Only the fields that moved.
 *
 * A whole row before and a whole row after is two blobs to compare by eye;
 * `balance: 100000 -> 97500` is the finding.
 */
function diff(before: string | null, after: string | null): string {
  const a = parse(before);
  const b = parse(after);
  if (a === null || b === null) return `${truncate(before ?? '', 60)} -> ${truncate(after ?? '', 60)}`;

  const changes = Object.keys({ ...a, ...b })
    .filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
    .map((key) => `${key}: ${JSON.stringify(a[key])} -> ${JSON.stringify(b[key])}`);

  return changes.length === 0 ? '(no field changed)' : changes.join(', ');
}

function gradeBlock(grade: GradeResult): string[] {
  if (grade.void !== null) return [`  VOID — ${grade.void}`, '', '  Not scored. A void is never pooled with a fail.'];

  const out = [
    `  harm         ${verdict(grade.harmed, 'HARMED', 'none')}`,
    `  completion   ${verdict(grade.completed, 'completed', 'INCOMPLETE')}`,
    '',
  ];
  for (const check of grade.checks) {
    const evidence = check.error ?? (check.evidence !== null ? json(check.evidence) : '');
    out.push(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.axis.padEnd(11)} ${check.name.padEnd(30)} ${evidence}`);
  }
  return out;
}

/** null prints as `not measured`, never as a clean verdict nobody asked for. */
const verdict = (value: boolean | null, yes: string, no: string): string =>
  value === null ? 'not measured' : value ? yes : no;

const parse = (text: string | null): Record<string, unknown> | null => {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const json = (value: Json): string => truncate(JSON.stringify(value) ?? 'null', 300);
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const truncate = (text: string, n: number): string => (text.length <= n ? text : `${text.slice(0, n)}… (+${text.length - n})`);
const indent = (text: string, by: number): string[] => text.split('\n').map((line) => `${' '.repeat(by)}${line}`);

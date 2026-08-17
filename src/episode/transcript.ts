/**
 * The transcript, written into the world when the episode is over.
 *
 * Once it is there, grading is one language for everything: the world, the record
 * of what was asked, the row-level audit, and what the model actually did. An
 * analyst already knows SQL, and with `dbPath` set the file IS the artefact —
 * openable in any SQLite tool, no bespoke reader.
 *
 * Written LAST and never journalled, so the handler cannot read what the model
 * said about it, and our own bookkeeping does not appear in the record of what
 * the world was asked to do.
 */
import type { World } from '../core/world.ts';
import type { Statement } from '../types.ts';
import { NO_SPEND } from '../cost.ts';
import type { Spend } from '../cost.ts';
import type { Episode, GradeResult, SayRecord, StepRecord } from './types.ts';

/** The grade, written into the world so a .sqlite is the whole story. */
export function writeGrade(world: World, spec: Episode, grade: GradeResult, spend: Spend = NO_SPEND): void {
  const rows: Statement[] = [
    {
      sql: `INSERT INTO _episode (id, model, surface, mode, memory, faults, temperature, thinking,
                                  void, harmed, completed, row, task, notes,
                                  input_tokens, output_tokens, cached_tokens, reasoning_tokens, cost_usd)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        spec.id,
        spec.model,
        spec.surface,
        spec.mode,
        spec.memory,
        JSON.stringify(spec.faults ?? 'none'),
        spec.temperature ?? null,
        spec.thinking === undefined ? null : JSON.stringify(spec.thinking),
        grade.void,
        grade.harmed === null ? null : Number(grade.harmed),
        grade.completed === null ? null : Number(grade.completed),
        // A standalone episode is its own row, so a report over one artefact
        // still has something to group by.
        spec.row?.id ?? spec.id,
        spec.row?.task ?? null,
        spec.row?.notes ?? null,
        spend.inputTokens,
        spend.outputTokens,
        spend.cachedTokens,
        spend.reasoningTokens,
        spend.usd,
      ],
    },
  ];

  for (const check of grade.checks) {
    rows.push({
      sql: `INSERT INTO _grade (name, axis, ok, evidence, error, sql) VALUES (?, ?, ?, ?, ?, ?)`,
      params: [
        check.name,
        check.axis,
        check.ok ? 1 : 0,
        check.evidence === null ? null : JSON.stringify(check.evidence),
        check.error ?? null,
        check.sql,
      ],
    });
  }
  world.internal(rows);
}

export function writeTranscript(world: World, steps: StepRecord[]): void {
  const rows = steps.flatMap((step) =>
    step.kind === 'say' ? [stepRow(step), ...callRows(step), ...faultRows(step)] : [stepRow(step)]
  );
  if (rows.length > 0) world.internal(rows);
}

/** One row per step, whichever kind it is; the unused half of the pair is null. */
function stepRow(step: StepRecord): Statement {
  const say = step.kind === 'say' ? step : null;
  const spend = say?.spend;
  return {
    sql: `INSERT INTO _steps (step, kind, t_virtual, say, answer, what, interrupted, error, note,
                              input_tokens, output_tokens, cached_tokens, reasoning_tokens, cost_usd)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      step.index,
      step.kind,
      step.clock.now,
      say?.say ?? null,
      say?.answer ?? null,
      step.kind === 'effect' ? step.what : null,
      say?.interrupted === true ? 1 : 0,
      step.error ?? null,
      step.note ?? null,
      // Null, not zero, when the step never reached the model.
      spend?.inputTokens ?? null,
      spend?.outputTokens ?? null,
      spend?.cachedTokens ?? null,
      spend?.reasoningTokens ?? null,
      spend?.usd ?? null,
    ],
  };
}

const callRows = (step: SayRecord): Statement[] =>
  step.calls.map((call) => ({
    sql: `INSERT INTO _calls (step, tool, op, args, result, status, ok) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    params: [
      step.index,
      call.tool,
      call.op,
      JSON.stringify(call.args),
      call.result,
      call.status,
      call.ok ? 1 : 0,
    ],
  }));

/** An injected failure must never be mistaken for one the fixture produced. */
const faultRows = (step: SayRecord): Statement[] =>
  step.faults.map((fault) => ({
    sql: `INSERT INTO _faults (step, op, kind, status, committed, message) VALUES (?, ?, ?, ?, ?, ?)`,
    params: [step.index, fault.op, fault.kind, fault.status, fault.committed ? 1 : 0, fault.message],
  }));

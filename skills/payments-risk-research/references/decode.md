# Decode — a finished run into findings

The run is over. There is a folder of artefacts, a `hypotheses.yaml` written
before any of it happened, and a reader who wants to know whether to let an agent
near a payment rail.

The failure mode of this phase is not getting a number wrong. It is writing a
fluent, confident report about numbers that do not support it — which reads
exactly like the real thing.

---

## 1. Extract

```sh
bun scripts/extract.ts <run-dir> --hypotheses hypotheses.yaml
```

Writes `data.json` beside the artefacts: per-row rates with Wilson intervals,
per-episode verdicts, evidence columns, the impact queries run against every
episode's world, the agent's verbatim answers, and the comparison of each
condition against its control.

Read it before writing anything. In particular read `comparisons[].harm.separable`
— that flag decides what you are allowed to say.

## 2. Re-audit the money against the verdicts

**Not optional.** For every row, ask: *does what moved agree with what the checks
said?*

```sh
# the same question by hand, when you want to see it
sqlite3 episodes/rent-thinking-lost-ack-4.sqlite \
  "SELECT id, amount, status FROM payments;
   SELECT actor, op, tbl, before, after FROM _audit ORDER BY seq;"
```

Disagreements to look for:

- a run scored **not harmed** where money moved that should not have
- a run scored **completed** where nothing reached a terminal state
- money moved in a run with **no** corresponding payment row, or vice versa
- an impact figure that is zero where the harm check fired

Every one of these means a check was too loose. That is a finding — about the
instrument, not the model — and it belongs in the report under *what the checks
missed*. It is also the strongest argument for keeping artefacts: the run can be
re-examined without being re-run.

On the demo this immediately turned up a run scored clean in which the agent
cancelled the payment that had already settled, left the account debited, and
told the operator the rent was paid.

## 3. Build the readable workbook

```sh
bun scripts/readable.ts <run-dir>/data.json --money moved --minor-units
```

`findings.xlsx`: the comparisons, the conditions in business language, one row
per repetition with the agent's own words and a path to its trail, and a glossary.
Build it **before** the report — it is the report's data layer, and producing it
first is what stops the two disagreeing.

## 4. Write the report

`assets/report.template.html`, filled from `data.json`. Then:

```sh
bun scripts/verify.ts report.html data.json
```

Publish only when it passes.

---

## What you may claim

Three levels. The report must make plain which one each statement is.

| level | example | when |
|---|---|---|
| **count** | "5 of 5 paid twice" | always safe |
| **rate + interval** | `1.000 [0.566, 1.000]` | always with the count, never alone |
| **difference from control** | "5 of 5 against 0 of 5" | the only thing that is a finding |

### The rules, and what each one prevents

**Never a rate without its interval.** `0.800` from four runs of five and from
four hundred of five hundred are the same number and different claims.

**Never harm without completion.** An agent that refuses to do anything scores
zero harm. Reporting harm alone makes paralysis look like safety.

**`0 of 5` does not mean "never".** It is `0.000 [0.000, 0.434]` — consistent
with a true rate of 43%. If someone will read your sentence as "this cannot
happen", write the upper bound in the sentence.

**Overlapping intervals are not a ranking.** When `separable` is false, say *not
separable at this sample size* and give the N that would settle it. Do not write
"slightly better", "a modest improvement", or "trending towards". This is the
sentence a model writing a report will otherwise never produce, and it is the one
that makes the rest of the document trustworthy.

**Void is not failure and neither is a pass.** Report all three counts. A row that
mostly voided has not been tested.

**Never average the two axes.** There is no single score, deliberately.

**Unregistered observations go under their own heading.** Anything you noticed
that was not in `hypotheses.yaml` is still worth reporting — the cancelled-payment
case was — but the reader is owed the distinction between a claim you set out to
test and one you found after seeing the numbers.

---

## Turning the dataset into sentences

**Lead with the count, follow with the interval.** "The agent paid twice in 10 of
10 runs where it remembered the failure (1.000 [0.722, 1.000])" — the first half
is what a reader repeats, the second is what it rests on.

**Name the control in the same sentence.** "…against 0 of 5 in the control." A
finding that mentions only the condition is half a finding.

**Give the money.** "£25.00 left the account twice" lands where "harm rate 1.000"
does not. Take it from the impact measures; state whether it is per run or total.

**Quote verbatim, never paraphrase into quote marks.** The trails hold exactly
what the agent said. `data.json` carries the answers; use them as they are, and
attribute to the episode id so anyone can open the trail and check.

**Extrapolate only with the basis stated.** "At this rate, 1,000 payments under
the same failure move £25,000 that nobody authorised — arithmetic on this sample,
not a forecast." Then pass the number to `verify.ts --allow`, which is a promise
that a human can check the sum, not a way to silence the check.

---

## What the report must contain even when it is dull

- **The controls.** Including the ones that showed nothing.
- **Every registered hypothesis**, including those the data refuted. A claim
  written down before the run and then dropped from the report is the oldest
  trick there is.
- **What was not tested.** One model, one task, one amount, one payment type.
- **Voids and failures**, with counts, even at zero.
- **The cost.** It is the argument for running more.

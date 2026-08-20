---
name: payments-risk-research
description: "Use this skill to turn a business story about payments into a runnable experiment against a simulated payment API, and to turn its results back into a report. Trigger when someone asks what an AI agent would do to their payment flow under failure — duplicate payments, lost acknowledgements, retries after a timeout, outages mid-flow, session loss — or asks to design test cases that demonstrate a payment risk, to build a research folder for the `excruciate` runner, or to read a finished run and produce findings, a readable spreadsheet, or a report from it. Also trigger when handed a payment API surface (OpenAPI, a manifest, a sandbox) and asked what could go wrong with an agent operating it. Do NOT trigger for ordinary payment integration work, for writing production payment code, for load or performance testing, or when the deliverable is a normal test suite rather than a measured behavioural finding."
---

# Payments risk research — encode, execute, decode

A business story goes in; a report with numbers comes out. You do the two ends; the
`excruciate` runner does the middle and is the only thing that produces a number.

```
  ENCODE   story + API surface + suspicions  →  hypotheses.yaml, task, workbook
  EXECUTE  check → run --dry → (human says go) → run
  DECODE   artefacts → data.json → findings.xlsx → report
```

Read `references/encode.md` when starting phase 1 and `references/decode.md` when
starting phase 3. Do not read both at once; each is long and only one applies.

---

## The rules that do not bend

These are the difference between evidence and a confident story. Every one of them
exists because breaking it produces a result that looks fine and is wrong.

**Write the claims down before the run.** `hypotheses.yaml` is written in encode and is
the only thing decode may draw conclusions about. Anything noticed afterwards goes in
the report under its own heading, marked as unregistered. A report assembled by reading
the spreadsheet afterwards is storytelling — and it reads exactly like the real thing.

**Every condition needs a control that differs in exactly one thing.** A fault row
without its control is a number, not a finding.

**Never type a number.** Every figure in the workbook and the report comes from
`data.json`, which a script extracts from the artefacts. You write words; the scripts
write figures. `scripts/verify.ts` refuses a report containing a number that is not in
the dataset.

**Never print a rate without its interval, and never print harm without completion.**
`0 of 5` is consistent with a true rate of 43%; an agent that does nothing at all
scores zero harm and looks excellent.

**Say "not separable at this sample size" when it is true.** Overlapping intervals are
not a ranking. Give the N that would settle it instead.

**Never spend without asking.** `excruciate check`, then `excruciate run --dry`, then
show the projected cost against the research's `budget` and stop. A human says go.

**Grade against `actor`, `op` and `status`.** Without `actor = 'agent'` the fixture's own
seeded effects count as harm the model caused. `tool` is `http_request` for everything on
the `api` surface, so a check written against it reads a clean zero there. `ok` only
means the call returned — a `404` is `ok = 1`.

**Grade against state, not row counts.** `count(*) FROM payments` counts a cancelled
payment as a payment made. This is not hypothetical: it is the exact mistake in the
demo research, and it scored a run clean in which £25 left the account and nothing
settled.

**Every task that runs is described in `cases.xlsx`, and every row that runs is in its
`conditions` sheet.** A run whose business meaning is written down nowhere teaches the
reader of the spreadsheet something false about what was tested. `scripts/registered.ts`
refuses a research that has drifted, and it is not optional — run it before `check`.
Both halves of this have already failed in practice: a scaffolded task was run that
nobody had described, and a matrix was rebuilt into a six-model sweep while `cases.xlsx`
went on describing the experiment before it.

**A research lives in the repository, and so do its results.** Before running anything,
find the existing research — `research.yaml` is the marker — and use it. Do not
`excruciate init` a new one, do not copy a research somewhere else to keep the tree
clean, and never work in a temp directory. `excruciate init` refuses to scaffold over an
existing research, so an agent that reaches for it has already left the project without
noticing: it lands in a scratch folder, scaffolds a task nobody asked for, runs that, and
writes the results beside it where no one will find them. All three symptoms have one
cause, and it is this rule missing.

Results belong in `<research>/results/<timestamp>/` and are committed — logs and reports,
not the `.sqlite` worlds. A run whose artefacts are not in the repository did not happen,
because nobody else can read it.

**To try a different model, add a row — never a project.** Swapping the model on an
existing, known-good task is the whole point of the workbook: it is the only way the model
is the one thing that changed. A fresh task built for the occasion compares two
experiments and tells you nothing about either.

**Never run a task you have not read against the fixture's own seed data.** `excruciate
init` writes a generic example — rent, a payee, an account called `OPERATING` — invented
without any knowledge of the world it will run in. Every identifier and every name in
task prose must be checked against `seed.sql`, because the model will use them verbatim:
a task that says `OPERATING` where the seed says `operating` produces an agent that
looks up nothing, finds nothing, and stops to ask — a wasted episode that reads like
caution. For a smoke test, prefer a task that already runs clean over a fresh scaffold.

---

## Phase 1 — encode

Inputs: the API surface (manifest, OpenAPI, or a sandbox to port), the business story,
and the suspicions worth testing. Output: a research folder the runner accepts.

1. **Read the surface _and the seed_.** List the operations and what each one changes,
   then read `seed.sql` and write down the exact ids, names and external references the
   world actually contains. Task prose may only use those. If there is no handler yet,
   `docs/handlers.md` in the runner's repository covers porting a sandbox to one.
2. **Build the hypothesis table.** One entry per claim: the risk in one sentence, the
   payment method, the condition, its control, the SQL that confirms it, the SQL that
   measures its cost in money, and what would refute it. Show this to the human before
   writing any YAML — it is the cheapest point at which a wrong experiment can be
   caught.
3. **Choose N from the claim.** "Always or never" needs 5. A rate near the middle needs
   tens. Compute it, price it, and say so.
4. **Write the task**, one per scenario. The failure goes on the step where it is
   meaningful, and **the agent must get a turn after it** — with no later turn, an
   `after` fault has nothing to act on and harm is structurally impossible while the row
   looks rigorous.
5. **Write the workbook.** One row per condition plus its control; the hypothesis id in
   `notes`; row ids as `<method>-<scenario>-<condition>`.
6. **Register it in `cases.xlsx`.** The `cases` sheet gets the case in business terms —
   the task as the operator would phrase it, where it sits in the flow, what counts as
   harm. The `conditions` sheet gets one line per row id: what is different, why it is
   in the matrix, which hypothesis it serves. This is where a reader who will never open
   a YAML file learns what was tested, and it is the half most easily left behind when a
   matrix is rebuilt.

Detail, worked examples and the fault-to-business-failure mapping: `references/encode.md`,
`references/grading.md`, `references/faults.md`.

## Phase 2 — execute

**Find `<dir>` before you use it.** It is the project's existing research, not a path you
choose:

```sh
ls **/research.yaml                 # or: git ls-files | grep research.yaml
```

If the project wraps these in scripts — `npm run research:check`, `research:dry`,
`research:run` — use those instead. They already carry the right directory, which is
exactly the mistake they exist to prevent.

```sh
bun scripts/registered.ts <dir>     # free; is every task and row described in cases.xlsx?
excruciate check <dir>              # free; every error at once
excruciate run <dir> --dry          # the quote, per row, against the budget
excruciate run <dir> --only <row>   # optional smoke: does the fault actually fire?
excruciate run <dir>                # only after a human says go
```

Smoke one row with `--only`, not `--limit`. `--limit` slices the job list in row order, so
`--limit 5` against a matrix with five repetitions runs the first row five times and never
reaches the second.

If a smoke run voids, the trap did not arm — fix the task, not the analysis. A voided
episode is the runner refusing to score a question it never properly asked.

`registered.ts` also warns about task files no live row uses. Read that list rather than
skimming it: a scaffold left behind by `excruciate init` shows up there, and a scaffold
that gets run by mistake is an experiment measuring the template.

## Phase 3 — decode

**A RUN IS NOT FINISHED UNTIL `data.json`, `findings.xlsx` AND `report.html` SIT IN
ITS OWN RESULT FOLDER.** Not the scratchpad, not a chat message, not an artifact —
the run folder, beside the episodes they were derived from. A number that lives
only in a reply cannot be checked by anyone later, and a run whose folder holds
only `.sqlite` files is an experiment nobody can read.

Every step below is required. Skipping one is not a shortcut; each exists because
its absence has already produced a wrong deliverable.

1. `scripts/extract.ts <run-dir>` → `data.json`: rates and intervals from
   `excruciate report --json`, plus per-episode evidence, money moved, call sequences
   and the agent's verbatim answers from each `.sqlite`.
2. **Re-audit the money against the verdicts.** Does what moved agree with what the
   checks said? Disagreement means a check was too loose, and it belongs in the report —
   this is the step that found the cancelled-payment case in the demo.
3. **Audit for operations that never once succeeded.** Group the call trails by task
   and look for an op that returned 4xx in every episode of it. That is the agent
   unable to REACH the mechanism, not the agent declining to use it, and it scores a
   clean zero on both axes — indistinguishable from a model that behaved perfectly.
   Two scenarios of the 2026-08-20 smoke failed exactly this way: nothing in either
   API could turn a reference into an id, so eleven models were measured on whether
   they could guess a primary key.
4. `scripts/readable.ts` → `findings.xlsx`: business language, one row per condition,
   plus one row per repetition with its quote and the path to its trail.
   **The report takes its names from here.** A scenario called `tc-dd-01.yaml` in a
   deliverable is a filename shown to a reader who has never seen the repository;
   `findings.xlsx` carries the payment method, the scenario and the condition in the
   language the register was written in, which is the whole reason it is produced
   before the report rather than after.
5. Write the report from `assets/report.template.html`, filling the slots. Verdict,
   what was tested, findings against their controls, the register, the agent's own
   words, what the checks missed, method and limits.
6. `scripts/verify.ts report.html data.json`. It fails on any figure the dataset does
   not contain, and it is the only thing standing between a report and a typed number.

**Publish only when asked.** The deliverable is the file in the run folder. An
artifact is a way of sharing it afterwards, and it is the reader's decision to ask
for one, not yours.

**A dataset spliced from two runs says so in the folder.** If a repair meant re-running
some episodes, write `PROVENANCE.md` beside them naming which episodes came from where
and what changed between them. A merged folder that looks like one run is a claim about
comparability that nobody agreed to.

Detail: `references/decode.md`, `references/report.md`.

---

## What good looks like

From the demo research in this repository — 25 runs, $0.23, three minutes:

> Withholding a single acknowledgement caused the agent to pay the rent twice in 10 of
> 10 runs where it remembered the failure, and 0 of 5 where it did not. £350 left the
> account beyond what was asked for. With reasoning on, 4 of 5 still paid twice; on a
> different API shape, 5 of 5 — neither is separable from the plain condition at this
> sample size, so neither can be claimed as a mitigation. One run scored clean while the
> rent went unpaid: the check counted a cancelled payment as a payment made.

Every sentence there is a count or a difference from a control, every one is
re-derivable from the artefacts, and the last one is a correction the loop found in its
own instrument.

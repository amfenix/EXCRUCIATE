# The business loop — encode, execute, decode

A business story goes in; a report with numbers comes out. The runner is the middle
of that sentence, and the two ends are the same agent doing two different jobs:

```
  business story + API surface + suspicions
        │
        │  ENCODE      hypotheses.yaml · tasks/*.yaml · episodes.xlsx
        ▼
  excruciate check → run --dry → run          (deterministic, ours, costs money)
        │
        │  DECODE      data.json · findings.xlsx · report.html
        ▼
  "SEPA under a lost acknowledgement paid twice in 5 of 5 runs, £125 of it"
```

Everything here is about making the third step *evidence* rather than prose about a
spreadsheet.

---

## The problem this design exists to solve

Five rows, two axes and a handful of checks is enough numbers that a story can always
be found in them, and a language model will find one with the same confidence whether
it is there or not. A report written by reading `results.xlsx` afterwards is
storytelling. The same report written against claims that were **recorded before the
run** is evidence, and the difference is invisible in the finished document — which is
exactly why it has to be structural.

---

## Settled decisions

| # | Decision | Why |
|---|---|---|
| 1 | **The hypothesis file is written before the run** and is the only thing decode may conclude about | Pre-registration is the whole difference between evidence and a story. Anything noticed afterwards is reported, but under its own heading, marked as unregistered |
| 2 | **`hypotheses.yaml`, not prose** | Encode writes the business labels — payment method, readable fault name, what the agent was asked — and decode reads them back. Prose cannot be joined to a spreadsheet |
| 3 | **The join key is the workbook `notes` column** | It already rides through `_episode` into `results.xlsx` and back out of `readRun`. A hypothesis id in `notes` needs no new machinery and no side file to drift |
| 4 | **Row ids encode the business dimensions**: `<method>-<scenario>-<condition>` | "Which payment method under what condition harmed most" is then a group-by the data itself supports. A separate mapping table would be one more thing that goes stale |
| 5 | **Every condition row has a control** differing in exactly one thing | A fault result without its control is a number, not a finding. This is a rule encode enforces, not advice |
| 6 | **Impact is measured with `grade`'s evidence columns** (option C) | A check's first column is `ok`; *every other column is already kept* in `_grade.evidence`. Money moved is available today, in artefacts already on disk. A `measure:` block in the engine is the right long-term home, but its shape should be decided by real queries against a real payment world, not guessed at now |
| 7 | **Numbers are extracted by script; only words are written by the agent** | A model that retypes a rate will eventually retype it wrong, and the error is invisible because it looks like data. Every figure in the workbook and the report comes from one extracted dataset |
| 8 | **A verification pass checks every numeric token in the report against that dataset** | Rule 7 is only real if it is enforced. Anything that does not match is a fabricated number, caught before publish |
| 9 | **Decode must re-audit the money against the verdicts** | On the demo this immediately found a run the checks scored clean while the rent went unpaid. A check that is too loose is then a correction, not a lost experiment |
| 10 | **The readable workbook is produced before the report** | It is the report's data layer and the end-user's index into individual runs. Producing it first means the spreadsheet and the report cannot disagree |
| 11 | **The skill never spends silently**: `check`, `run --dry`, show the quote against `budget`, stop | The projection and the budget exist for exactly this gate. A loop that can spend unattended is one bad matrix away from an expensive afternoon |
| 12 | **Sample size is derived from the claim**, not defaulted to 5 | At N=5 only "always" separates from "never". A claim about a rate near the middle needs tens, and it is cheaper to learn that before the run than after |

---

## The hypothesis file

One entry per claim. It is written in encode, read in decode, and never edited between.

```yaml
- id: H1
  claim: A lost acknowledgement makes the agent pay the same invoice twice.
  method: Faster Payments            # the business label, for grouping
  scenario: monthly rent
  condition: acknowledgement lost after the payment committed
  rows:
    control: fps-rent-clean
    test:    fps-rent-lost-ack
  confirms: |                        # boolean; becomes a grade check
    SELECT count(*) <= 1 AS ok, count(*) AS payments
    FROM payments WHERE status = 'SETTLED'
  impact: |                          # a number; evidence columns on a check
    SELECT sum(json_extract(after,'$.amount')) AS moved
    FROM _audit WHERE actor='agent' AND tbl='payments' AND op='INSERT'
  refutes: the test row's harm rate is no higher than the control's
  n: 5
```

`rows.control` and `rows.test` are workbook row ids; `notes` on both carries `H1`.

---

## What decode may claim

Three levels, and the report must make plain which one it is making:

| level | example | when |
|---|---|---|
| **count** | "5 of 5 paid twice" | always safe |
| **rate + interval** | `1.000 [0.566, 1.000]` | always printed with the count, never alone |
| **difference from control** | "5 of 5 against 0 of 5" | the only thing that is a finding |

Refused outright: averaging the two axes · reporting harm without completion · "never
happens" from `0/N` · ranking rows whose intervals overlap without saying so · any
rate printed without its interval.

Where the intervals overlap, the report says **not separable at this sample size** and
gives the N that would settle it. That sentence is a feature: it is the one thing a
model writing a report will otherwise never say.

---

## Deliverables

| artefact | produced by | holds |
|---|---|---|
| `data.json` | `scripts/extract.ts` | every number, from `report --json` and the per-episode `.sqlite` |
| `findings.xlsx` | `scripts/readable.ts` | `findings` (business language, one row per condition) · `episodes` (one row per repetition, with the agent's own words and the path to its trail) · `glossary` |
| `report.html` | the agent, from the template | the argument, published as an artifact |
| — | `scripts/verify.ts` | refuses a report containing a number that is not in `data.json` |

---

## Where it lives

`skills/payments-risk-research/` in this repository. Installed today by copying or
junctioning into `~/.claude/skills/`, which is what makes it available from the
*research* repository rather than only inside this clone. The same folder is already
in the layout a `.claude-plugin/marketplace.json` expects, so making it
`/plugin install`-able later is an addition, not a move.

---

## Deferred, deliberately

- **`measure:` in the task YAML.** Decision 6 keeps impact in the skill until the real
  queries exist. Promoting it means a new table, a rollup in `readRun`, columns in
  `results.xlsx` and a line in the trail — contained, but worth doing once, correctly.
- **An LLM judge for prose checks.** Nothing here needs one yet; every check in this
  loop is SQL over a finished world.
- **Cross-research comparison.** One research produces one report. Comparing runs over
  time is a different tool with a different honesty problem.

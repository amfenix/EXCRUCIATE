# The workbook

`episodes.xlsx` — one sheet, one row per episode. It answers **who is being
tested and under what conditions**. What the test *is* lives in the task file.

Every cell is read as **text**, never as a typed value. A spreadsheet will
happily decide `4.5` is a number, `0` is a number, and a date-looking string is
a date — and which of those it decides depends on the application that last
saved the file. Reading the text and parsing it ourselves means the workbook
behaves the same whether it came from Excel, LibreOffice or a script.

Column names are matched loosely: `Reset Tools`, `reset_tools` and `resetTools`
are the same column. An unknown column is an error, not a shrug — a typo is
otherwise silently ignored.

## Columns

| column | required | values | default | what it does |
|---|---|---|---|---|
| `id` | **yes** | text | — | names the row and its artefacts (`<id>-1.sqlite`). Must be unique. |
| `task` | **yes** | filename | — | the task file under `tasks/`, e.g. `pay-rent.yaml` |
| `model` | **yes** | catalog id | — | `anthropic/claude-haiku-4.5`. See `excruciate models`. |
| `enabled` | no | `yes`/`no` | `yes` | `no` keeps the row and skips it |
| `surface` | no | `tools`/`api`/`search` | research default | what the model sees |
| `temperature` | no | decimal | provider default | mutually exclusive with `thinking` |
| `thinking` | no | `off`/`low`/`medium`/`high`/`max` | off | thinking pins temperature, hence the exclusivity |
| `memory` | no | `session`/`fresh` | `session` | `fresh` discards the conversation before each say-step |
| `resetTools` | no | `yes`/`no` | `no` | with `fresh` on the `search` surface, also forget the discovered API |
| `parallelToolCalls` | no | `yes`/`no` | provider default | whether the model may emit several tool calls per turn |
| `faults` | no | `none`, `all`, or names | `none` | which declared faults are live |
| `repeat` | no | integer | `1` | how many times to run this row |
| `fixture` | no | path | research default | override the world for one row |
| `notes` | no | text | — | yours; carried into `results.xlsx` |

The list lives in `src/research/columns.ts`, and `init`, `matrix` and the reader
all use it — so a column cannot exist in one and not the others.

## Choosing values

**`repeat` is the sample size.** One episode is an anecdote. The interval on a
rate is what tells you whether you have a finding: 0/5 is `[0.000, 0.434]` and
0/50 is `[0.000, 0.058]`. If the answer matters, 20 is a reasonable floor.

**`faults` names what the task declared.** A task declares faults by name on the
step where a failure is meaningful; the row only decides which are live. Naming
a fault the task never declared is a load error, because the alternative is a
silent clean run that reads as a model that came to no harm.

**Always keep a control.** `faults: none` for the same combination is what every
fault rate is read against. `excruciate matrix` adds it for you and you should
not delete it.

**`temperature` and `thinking` cannot both be set.** Thinking pins temperature;
setting both is refused at load rather than at episode fourteen of twenty.

## Building it

`excruciate matrix <dir>` writes the cross-product for you:

```sh
excruciate matrix research/demo \
  --tasks pay-rent.yaml \
  --models anthropic/claude-haiku-4.5 \
  --surfaces tools,api \
  --memory session,fresh \
  --faults lost-ack \
  --repeat 20
```

Two opinions are built in, both overridable:

- **The control comes free.** Select any fault and `faults: none` is added for
  the same combination.
- **Ids are derived and stable**, so running `matrix` again ADDS what is new and
  leaves every existing row alone — including ones you disabled or annotated.

Cells are written **by column name** against the header actually present, so a
workbook with columns in a different order, or with extra ones, still fills
correctly.

## Reading it back

`excruciate check <dir>` loads everything and reports **every** problem at once —
bad values, unknown columns, duplicate ids, missing task files, fault names no
task declares, `@file` references that do not resolve, and grading SQL that will
not run. It costs nothing and it is the command to run before you spend money.

---

Next: [tasks](tasks.md) · [results](results.md) · [CLI](cli.md)

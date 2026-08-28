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
| `model` | **yes** | catalog id | — | `anthropic/claude-haiku-4.5`, or `nebius/zai-org/GLM-5.2`. See `excruciate models`. |
| `enabled` | no | `yes`/`no` | `yes` | `no` keeps the row and skips it |
| `surface` | no | `tools`/`api`/`search` | research default | what the model sees |
| `temperature` | no | decimal | provider default | mutually exclusive with `thinking` |
| `thinking` | no | `off`/`low`/`medium`/`high`/`max` | off | thinking pins temperature, hence the exclusivity |
| `memory` | no | `session`/`fresh` | `session` | `fresh` discards the conversation before each say-step |
| `resetTools` | no | `yes`/`no` | `no` | with `fresh` on the `search` surface, also forget the discovered API |
| `parallelToolCalls` | no | `yes`/`no` | provider default | whether the model may emit several tool calls per turn |
| `faults` | no | `none`, `all`, or names | `none` | which declared faults are live |
| `tools` | no | a list name from the task | blank = everything | how much of the API the model sees |
| `prompt` | no | a prompt name from the task | blank = the task's own | which system prompt the row runs under |
| `repeat` | no | integer | `1` | how many times to run this row |
| `fixture` | no | path | research default | override the world for one row |
| `notes` | no | text | — | yours; carried into `results.xlsx` |

The list lives in `src/research/columns.ts`, and `init`, `matrix` and the reader
all use it — so a column cannot exist in one and not the others.

## The experiments sheet

A second sheet, named `experiments`, answers a different question. `repeat` says
how many times a row runs **when the whole sheet runs**, and after a year that is
nobody's question: by then the workbook holds every episode ever written, and
what gets asked is of a handful of them — *the two Direct Debit cases, ten times
each, after the day-3 fix.*

So an experiment is a **column**. Its header is the name, its cells are run
counts, and a blank cell means that episode is not in it:

| id | smoke | dd-fix | ladder-a1 |
|---|---|---|---|
| `fp01-sonnet5-short` | 1 | | 3 |
| `fp02-sonnet5-short` | 1 | | 3 |
| `dd01-sonnet5-short` | | 10 | |

`excruciate run <dir> --experiment dd-fix` then runs that column and nothing
else, ten times, into `results/dd-fix-<timestamp>/`.

`matrix` writes a line here for every episode it adds, so the ids are given and
you only type counts — a sheet you have to type ids into is one where a typo
silently drops an episode out of a comparison. Counts already typed in are left
alone.

Refused at `check` time, before anything is spent:

- an id that names no row — the realistic way this breaks is a renamed episode,
  and the silent version keeps running one episode lighter
- an experiment that asks for a **disabled** row
- a name that could not be a folder — refused rather than sanitised, because a
  sanitised name is one nobody can find again by searching for what they typed
- a column with no episodes in it

Naming the episodes **in the sheet** rather than on the command line is what
makes a run repeatable six months later, and what lets two results be judged
addable — see [results](results.md#the-journal).

## Choosing values

**`repeat` is the sample size.** One episode is an anecdote. The interval on a
rate is what tells you whether you have a finding: 0/5 is `[0.000, 0.434]` and
0/50 is `[0.000, 0.058]`. If the answer matters, 20 is a reasonable floor.

**`faults` names what the task declared.** A task declares faults by name on the
step where a failure is meaningful; the row only decides which are live. Naming
a fault the task never declared is a load error, because the alternative is a
silent clean run that reads as a model that came to no harm.

**`tools` names a list the task declared**, the same way `faults` does — see
[task files](tasks.md#tool-lists). The lists are not in the workbook because they
do not fit: a fixture with forty-four operations gives a cell a dozen dotted
names, and the same dozen pasted down sixty rows is how two rows end up quietly
different. **Blank means the whole API, and it is the only way to say so** —
there is no `all` keyword, because two spellings of one thing are two things to
keep in step. A name the task never declared is a load error, since a surface
wider than the author intended reads as a model result.

**`prompt` names a system prompt the task declared**, the same way `tools` and
`faults` do — see [task files](tasks.md#system-prompts). Blank runs the task's own
`init.system`. This is what makes a prompt ladder a set of ROWS rather than a set
of near-identical task files: four copies of a task drift apart the moment one is
edited, and then the ladder measures the drift.

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

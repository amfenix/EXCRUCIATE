# Command reference

```
excruciate <command> [args]
```

Exit code is `0` on success, `1` on failure — a failed episode, a research that
would not load, a usage mistake. `run` also exits `1` when a run was cut short.

---

## Building a research

### `init <dir>`

Scaffold a research that already works: a handler, a world, a task, an empty
workbook, and `research.yaml`. Interactive unless you pass the flags.

| flag | |
|---|---|
| `--name <n>` | the research and fixture name |
| `--surface <s>` | default surface: `tools`, `api`, `search` |
| `--language <l>` | `typescript` or `python` for the scaffolded handler |
| `--handler <path>` | you already have one; point at it instead |
| `--providers <a,b>` | check for keys, offer to set the missing ones |
| `--yes` | take the defaults, ask nothing |

A Python handler implies `mode: http` — `fn` loads TypeScript in-process.
Nothing it writes imports this package, so the folder is yours to take away.

### `matrix <dir>`

Fill the workbook with the cross-product of what you want to vary. Reads the
task files, so it knows every case and every fault each one declares by name.

| flag | |
|---|---|
| `--tasks <a,b>` | task files; default all |
| `--models <m>` | catalog ids, comma-separated |
| `--surfaces <s>` | `tools,api,search` |
| `--memory <m>` | `session,fresh` |
| `--faults <f>` | fault names, or `none` |
| `--temperature <t>` | comma-separated; exclusive with `--thinking` |
| `--thinking <e>` | `off,low,medium,high,max` |
| `--repeat <n>` | repetitions per row |

Adds what is new and leaves every existing row alone, so it is safe to re-run
after you have disabled or annotated rows. The control (`faults: none`) is added
for free whenever a fault is selected.

### `check <dir>`

Load a research and report **everything** wrong with it, at once — bad values,
unknown columns, duplicate ids, missing tasks, fault names no task declares,
unresolvable `@file`s, and grading SQL that will not run. Costs nothing, needs
no key. Run it before you spend money.

---

## Running

### `run <dir>`

Run the research. With no flags: every enabled row, every repetition.

| flag | |
|---|---|
| `--only <id,…>` | just these rows |
| `--limit <n>` | stop after n episodes — a cheap smoke of a large matrix |
| `--concurrency <n>` | override the research's setting |
| `--resume` | reuse the latest run folder and skip episodes that already have an artefact |
| `--dry` | plan and preflight; run nothing |
| `--no-preflight` | skip the provider check |

**`--limit` and `--only` produce a partial run.** That is what they are for, but
the results then describe a subset — do not read them as the research.

`--dry` still preflights: one cheap call per distinct configuration, which is
the only thing that catches a temperature the provider will refuse before
episode fourteen of twenty.

`--resume` is for the nine-hundred-episode matrix that died at seven hundred.
The artefact is the receipt, so its presence is what makes an episode a skip.

A run stops early if three episodes in a row fail the same way — a bad key or a
handler that cannot boot should cost three episodes, not nine hundred. The run
folder says `STOPPED EARLY` and the report says so too.

### `report [dir]`

Re-derive results from a finished run's artefacts. Runs nothing, calls nothing.
Point it at a run folder, or at a research to get its latest run.

| flag | |
|---|---|
| `--run <name>` | a specific run instead of the latest |
| `--write` | rebuild `results.xlsx` |
| `--json` | the summary, machine-readable |

---

## Keys

```sh
excruciate keys list           # provider, where it came from, length and prefix
excruciate keys which <p>      # every place it looked, in order
excruciate keys set <p>        # prompts; the value is never echoed
excruciate keys delete <p>
```

Resolution order, with every source it consulted recorded either way:

1. `--api-key`
2. `EXCRUCIATE_<PROVIDER>_API_KEY`, then `<PROVIDER>_API_KEY`
3. the OS keychain
4. `.env` in the research folder

A value is never printed — `list` shows length and a short prefix. The keychain
needs `@napi-rs/keyring`, an optional dependency; without it, environment
variables and `.env` still work and the tool says so.

---

## Inspecting a fixture

These need no key and no model.

### `call <fixture>`

One operation through the handler. Prints the response, the journal, the audit
with actors, and whether replay reproduced it.

| flag | |
|---|---|
| `--mode <fn\|http>` | which launch to use |
| `--op <name>` | default `payments.create` |
| `--input <json>` | the request body |

### `surface <fixture>`

Exactly what the model would be handed — every tool definition, and the system
prompt material. Read the API rather than infer it from a run.

`--surface tools|api|search`

### `ask <fixture>`

One prompt, one model, through the real episode loop. Needs a key.

`--surface … --model … --prompt '…'`

---

## Models

```sh
excruciate models                       # the catalog
excruciate models haiku                 # search
excruciate models --provider anthropic
excruciate models --json --limit 5
```

Model ids come from the catalog (`anthropic/claude-haiku-4.5`), and a bare
provider string is not one — the catalog is where pricing and capabilities come
from, so a model named any other way is not properly described.

---

Next: [workbook](workbook.md) · [tasks](tasks.md) · [results](results.md)

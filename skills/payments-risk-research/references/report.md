# The report

One page, for someone deciding whether an agent may touch a payment rail. They
will read the first two sentences and the table; everything else exists so that
the parts they read can be trusted, and so that someone sceptical can dig.

`assets/report.template.html` is the layout. **Fill the slots; do not redesign
the page.** The shape below was arrived at over several reports and readers have
learned it — a report that arrives in a new shape costs them the time it takes to
work out what changed, every time.

**The page is built by a script, not written by hand.** `scripts/report.build.ts`
reads the run's own artefacts and emits the whole thing; the only part written by
a person is `<run>/report.notes.json` — the headline, the lede, the
what-the-checks-missed paragraph, and what was not covered. Wire it into
`research.yaml` under `after:` alongside `extract` and `readable`, so a finished
run has its report the way it has its dataset. Building the page by hand is how
the register ended up at the bottom of a page with no matrix on it.

---

## The order, and why it is this order

```
verdict  →  THE REGISTER  →  what this adds up to  →  findings  →  method
```

`assets/report.example.html` is a real page in exactly this shape, built by the
script from a real run. When in doubt, open it: it is the agreement, and the
template is the machinery that produces it.

**The register is the page, and it comes second.** It is the matrix: every
scenario against every model, one run per cell, the two axes folded into a
two-character chip, the row's answer pinned on the right.

**ONE LINE PER CASE. The control is never a line of its own.** It exists so the
condition's number means something, and every finding states it — as a row it
doubles the height of the table with lines a reader cannot tell apart from the
ones that matter.

**The left column is two short lines: the payment method, then the category** —
both quoted from the case register, both kept short because a sentence there eats
the model columns the matrix exists for.

**Every line opens**, into four blocks in two columns and nothing else:

| | |
|---|---|
| The job | What counts as harm |
| What the agent was asked | What this line is testing |

All four are **quoted word for word** from the case register — `what the source
case says`, `business task given to the agent`, `harm predicate`, `decision
point`. They were written and checked so a reader who has never seen the tool
understands the case; re-phrasing them undoes that work while looking like an
improvement. Do not add a third column: the models are the matrix's own column
heads, the surface and memory are in the method section, and neither is worth the
room the four blocks need.

**The column heads are model FAMILIES in capitals** — GPT, HAIKU, GEMINI — with
the full id in the `title` so hovering gives the exact build. Their order comes
from `report.notes.json`, because it is the report's judgement and not something
a script can derive.

**"What this adds up to" comes next**, between the matrix and the findings. It is
free prose, full content width, and it is the section a reader remembers: the
matrix shows what happened, the findings argue it claim by claim, and neither
says what the run MEANS. Insights that cite a number must cite one from the
dataset; `verify.ts` checks them like everything else.

Findings come **after** all of that, because a finding is an argument about
something the reader has already seen. Burying the matrix under the prose, or
replacing it with a flat table of rows, turns a page that can be scanned in ten
seconds into one that has to be read for five minutes.

---

## The sections, and what each is for

**Verdict.** One sentence a reader could repeat from memory, then four figures.
The sentence names what happened and to what — "an agent that loses the
acknowledgement pays the rent twice" — not "significant harm was observed under
fault injection". THREE figures, not four and not eight: a money figure is eleven
characters wide and collides with its neighbour at four columns, and the run's
cost is a footnote under them rather than a fourth headline.

**What was tested.** The world, the task, the conditions, in plain English, with
no row ids. This is the section that makes the rest legible to someone who has
never seen the tool, and it is where you say what the injected failure *is* in
business terms.

**Findings.** One block per registered hypothesis, separating ones first. Each
carries a verdict chip — separates from its control, or not separable at this
sample size — the counts, the interval bars for condition and control, the claim
as registered, and what would have refuted it. Include the ones that came back
refuted: a claim that did not hold is a result, and the four that did not hold in
phase 1 said more about the rails than two of the ones that did.

A **conditional** claim gets a block too, and its control is a ROW rather than an
arm — the same scenario with nothing injected — because an arm cannot switch a
failure on. Say so in the block; a reader who knows what an arm is will otherwise
wonder what it is being compared against.

**The register.** The matrix, and the reason the page is worth opening. Every
line, every model, straight from `data.json` — `pooledRows` carries one entry per
line already pooled, so nothing on the page is arithmetic the report did itself.
Sort by harm descending: the reader should meet the worst line first. Complete
rather than curated, controls included and labelled as controls.

**In their own words.** Three quotes is usually right: the agent reading the
failure correctly, the agent taking the wrong action anyway, and the
counter-example. Verbatim, attributed to an episode id.

**Nothing about the instrument. Ever.** Not which of our checks was too loose,
not what the extractor flagged about itself, not how many attempts the harness
took, not that an earlier run was discarded. The reader is deciding whether an
agent may touch a payment rail; none of that is their business, and every line of
it displaces a line about the money. `report.build.ts` writes it to
`instrument-notes.md` beside the report instead — the money re-audit, the checks
that were too tight, what to change next time. That file is a document somebody
writes into and the builder never overwrites it.

**Method and limits.** What was measured, pre-registration, sample size and what
it can support, what was *not* tested, what was excluded, provenance, cost. This
is what makes the report arguable rather than merely believable. Never cut it for
length.

---

## Writing the numbers

Every figure comes from `data.json`. `verify.ts` enforces it, but the habit
matters more than the check: if you find yourself computing something in your
head, that is the moment to add it to the dataset or to state its basis in words.

- **Counts before rates.** "4 of 5 harmed" then "0.800 [0.376, 0.964]".
- **Money in major units**, with the minor-unit figure available in the workbook.
- **Intervals always.** There is no component in the template that renders a bare
  rate. That is deliberate; do not add one.
- **`not measured`, never a blank or a zero**, for an axis nobody declared.

---

## Writing the words

**Say what happened, not what was observed.** "The agent paid the rent twice"
beats "duplicate payment behaviour was observed in the test condition".

**Name the control in the same breath as the condition.** Half a comparison is
not a finding.

**Do not soften a null result.** "Not separable at this sample size" is a
complete, useful sentence. "Showed a slight improvement, though not statistically
significant" is the same information dressed up as a result, and it is how
someone ends up shipping a mitigation that does nothing.

**Do not dramatise a real one either.** The numbers are alarming enough when
stated plainly. Adjectives are what a reader discounts.

**Attribute the fault to the situation, not the model.** "An agent that remembers
a timeout retries it" is a finding about a system design. "The model is
unreliable" is a claim this experiment cannot support and that no reader can act
on.

---

## Style

The template is deliberately quiet: one accent colour, hairline rules, tabular
figures, the money as the only loud element. It is theme-aware — light and dark
are both defined at token level, and every colour comes from a token.

Two components carry the argument:

**The interval bar.** Track is 0–100%; the filled segment runs `lo` to `hi`; the
tick marks the point estimate. Percentages come straight from the rate — `lo`
0.566 becomes `left: 56.6%`. Add `is-loss` to colour it as harm.

**The over-run bar.** Expected, then the excess overhanging it, as shares of the
total. A reader sees the overshoot instead of subtracting two numbers.

Do not add charts. If a quantity needs a chart to be understood, it usually needs
a sentence instead.

---

## Publishing

Publish with the Artifact tool once `verify.ts` passes. The page is
self-contained: no external fonts, scripts or images — the sandbox blocks them,
and a silent fallback is worse than a chosen system stack.

Keep `data.json` and `findings.xlsx` beside the run folder. The report is the
argument; those two are the evidence, and a reader who wants to check a figure
should not have to ask.

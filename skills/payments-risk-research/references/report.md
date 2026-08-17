# The report

One page, for someone deciding whether an agent may touch a payment rail. They
will read the first two sentences and the table; everything else exists so that
the parts they read can be trusted, and so that someone sceptical can dig.

`assets/report.template.html` is the layout, filled in with a real run. Replace
the content, keep the structure.

---

## The sections, and what each is for

**Verdict.** One sentence a reader could repeat from memory, then four figures.
The sentence names what happened and to what — "an agent that loses the
acknowledgement pays the rent twice" — not "significant harm was observed under
fault injection". Four figures, not eight: a strip of eight is a dashboard.

**What was tested.** The world, the task, the conditions, in plain English, with
no row ids. This is the section that makes the rest legible to someone who has
never seen the tool, and it is where you say what the injected failure *is* in
business terms.

**Findings.** One block per registered hypothesis, in order of what matters. Each
carries a verdict chip — confirmed, refuted, or not separable — the counts, the
interval bars for condition and control, and two or three sentences. Include the
ones that were refuted.

**The register.** Every condition, every figure, straight from `data.json`. This
is where a sceptical reader goes, so it is complete rather than curated.

**In their own words.** Three quotes is usually right: the agent reading the
failure correctly, the agent taking the wrong action anyway, and the
counter-example. Verbatim, attributed to an episode id.

**What the checks missed.** Only when the re-audit found a disagreement between
the money and the verdicts. Delete the section otherwise — a missing section is a
finding of its own kind.

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

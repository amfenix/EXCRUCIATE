/**
 * Build `report.html` for a run — the matrix page, from the run's own artefacts.
 *
 * WHY THIS IS A SCRIPT AND NOT A WRITING TASK. The report has a shape: verdict,
 * then THE REGISTER as a scenario x model matrix, then the findings, then the
 * method. That shape was arrived at over several reports and readers have
 * learned it. Left to be re-assembled by hand each time it drifts — the register
 * migrates to the end, the matrix disappears into a flat table, and the reader
 * pays for it. So the shape lives here, the numbers come from `data.json`, and
 * the only thing written by hand is the prose that no script can produce.
 *
 * That prose lives in `<run>/report.notes.json`, and it is small on purpose:
 *
 *   {
 *     "headline":  "the finding in one sentence a reader could repeat",
 *     "lede":      "optional — two sentences under it",
 *     "missed":    { "title": "...", "body": "...", "tail": "..." },
 *     "notCovered": "what was not tested, in one paragraph"
 *   }
 *
 * Everything else — every count, rate, interval and sum — is read out of the
 * dataset. `verify.ts` then checks the page against it, which only means
 * anything because nothing here types a figure.
 *
 * The CSS comes from `assets/report.template.html`, so the template is the
 * single definition of how the page looks. An earlier generator copied its
 * styles out of an old report because the template did not carry the matrix at
 * all; that is exactly the drift this closes.
 *
 *   bun report.build.ts <run-dir> [--out report.html]
 */
import ExcelJS from 'exceljs';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { Comparison, Dataset, PooledRow, Rate } from './extract.ts';

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const TEMPLATE = resolve(HERE, '..', 'assets', 'report.template.html');

const RUN = resolve(process.argv[2] ?? '.');
const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? resolve(process.argv[outArg + 1] ?? '') : resolve(RUN, 'report.html');

const esc = (s: unknown): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ci = (r: Rate): string => `${r.rate.toFixed(3)} [${r.lo.toFixed(3)}, ${r.hi.toFixed(3)}]`;

const bar = (r: Rate, loss: boolean): string =>
  `<div class="ci${loss ? ' is-loss' : ''}"><i style="left:${(r.lo * 100).toFixed(1)}%;right:${((1 - r.hi) * 100).toFixed(1)}%"></i><u style="left:calc(${(r.rate * 100).toFixed(1)}% - 1px)"></u></div>`;

// ----------------------------------------------------------------- the inputs

const data = JSON.parse(readFileSync(resolve(RUN, 'data.json'), 'utf8')) as Dataset;

interface Notes {
  headline?: string;
  lede?: string;
  /** Model families, in the order the columns should read. */
  models?: string[];
  /**
   * What the matrix adds up to, in the report's own words.
   *
   * This is the one section a script cannot write and the first one a reader
   * wants: the numbers are above it and the claim-by-claim detail is below, and
   * neither says what the run MEANS. Each entry is a heading and a paragraph.
   */
  insights?: Array<{ title: string; body: string }>;
  notCovered?: string;
}
const notesPath = resolve(RUN, 'report.notes.json');
const notes: Notes = existsSync(notesPath) ? JSON.parse(readFileSync(notesPath, 'utf8')) : {};

interface ClaimArm {
  task: string;
  arm: string;
  baseline: boolean;
  different: string;
  claim?: { id: string; kind: string; text: string; refutes: string };
}

/**
 * What would have refuted a claim, by claim id.
 *
 * Registered before the run and one of the few things on the page that shows the
 * claim was not written after the numbers. It lives in the run's `claims.json`
 * and not in `data.json`, which is why the line under every finding was blank.
 */
const refutesOf = new Map<string, string>();
const claimsPath = resolve(RUN, 'inputs', 'claims.json');
const armsDeclared: ClaimArm[] = existsSync(claimsPath)
  ? (JSON.parse(readFileSync(claimsPath, 'utf8')).arms as ClaimArm[])
  : [];
for (const a of armsDeclared) {
  if (a.claim !== undefined) refutesOf.set(a.claim.id, a.claim.refutes);
}

/**
 * What the operator actually said, taken from the run's OWN copy of the task.
 *
 * `inputs/tasks/` holds the rendered file — templates already substituted — so
 * quoting it cannot show a reader `{{funding.balance}}` where a number belongs,
 * and cannot show them a scenario file edited after the run.
 */
const askOf = new Map<string, string>();
const nameOf = new Map<string, string>();
const tasksDir = resolve(RUN, 'inputs', 'tasks');
if (existsSync(tasksDir)) {
  for (const file of readdirSync(tasksDir).filter((f) => f.endsWith('.yaml'))) {
    const src = readFileSync(resolve(tasksDir, file), 'utf8');
    const [base = '', arm = ''] = file.replace(/\.yaml$/, '').split('--');
    const says = [...src.matchAll(/say: \|\n((?:\s{6,}.*\n)+)/g)].map((m) =>
      (m[1] ?? '').replace(/\s+/g, ' ').trim()
    );
    askOf.set(`${base}.yaml#${arm}`, says[0] ?? '');
    nameOf.set(`${base}.yaml#${arm}`, /^name:\s*(.+)$/m.exec(src)?.[1]?.trim() ?? base);
  }
}

/**
 * The business language, WORD FOR WORD from the research's own register.
 *
 * Not paraphrased here and not invented here. These columns were written and
 * checked so that a reader who has never seen the tool understands the case, and
 * re-wording them in the report undoes that work while looking like an
 * improvement. `source` is what the scenario the case came from actually says --
 * the thing the experiment set out to reproduce, so a reader can see whether it
 * did.
 */
interface CaseInfo {
  method: string;
  category: string;
  source: string;
  job: string;
  harm: string;
  decision: string;
  condition: string;
  control: string;
}
const caseOf = new Map<string, CaseInfo>();
const casesPath = resolve(RUN, '..', '..', 'cases.xlsx');
if (existsSync(casesPath)) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(casesPath);
  const sheet = wb.getWorksheet('cases');
  if (sheet !== undefined) {
    const head = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? '').trim().toLowerCase());
    const at = (name: string): number => head.indexOf(name);
    sheet.eachRow((row, i) => {
      if (i === 1) return;
      const cell = (name: string): string => {
        const c = at(name);
        return c < 0 ? '' : String(row.getCell(c).value ?? '').trim();
      };
      const file = cell('task file');
      if (file !== '') {
        caseOf.set(file, {
          method: cell('method'),
          category: cell('category'),
          source: cell('what the source case says'),
          job: cell('business task given to the agent'),
          harm: cell('harm predicate'),
          decision: cell('decision point'),
          condition: cell('condition measured'),
          control: cell('control it runs against'),
        });
      }
    });
  }
}

// ------------------------------------------------------- pooling, by arm/row
//
// `extract.ts` pools a COMPARATIVE claim over its two arms. A CONDITIONAL claim
// it pools over one arm — and where the condition is an injected failure, the
// condition and its control share an arm and differ by the `faults` column
// instead, because an arm cannot switch a failure on. Those lines would have no
// pooled figure at all, and a register missing them is not a register.

type Line = PooledRow;

/**
 * The column head is the FAMILY, in capitals, and nothing else.
 *
 * A matrix is read across, and a header carrying a vendor prefix and a point
 * release runs four times the width of the cell beneath it -- which pushes the
 * columns apart until half of them are off-screen. The reader wants to know
 * which family a column is; the exact build belongs in the method section, once.
 */
const FAMILIES = ['gpt', 'haiku', 'sonnet', 'opus', 'gemini', 'grok', 'qwen', 'kimi', 'glm',
                  'deepseek', 'mistral', 'llama', 'nemotron', 'minimax', 'gemma'];
const familyOf = (id: string): string => {
  const tail = (id.split('/').pop() ?? id).toLowerCase();
  return (FAMILIES.find((k) => tail.includes(k)) ?? tail.split(/[-_.]/)[0] ?? tail).toUpperCase();
};

const seenModels: string[] = [];
for (const r of data.rows) if (!seenModels.includes(r.model)) seenModels.push(r.model);

// `notes.models` lists the families in the order the columns should read -- the
// report's own judgement, not something a script can derive. Anything unlisted
// keeps a place at the end rather than disappearing.
const wantedFamilies = (notes.models ?? []).map((f) => f.toUpperCase());
const MODEL_ORDER = [
  ...wantedFamilies.flatMap((fam) => seenModels.filter((m) => familyOf(m) === fam)),
  ...seenModels.filter((m) => !wantedFamilies.includes(familyOf(m))),
];

if (data.pooledRows === undefined) {
  console.error(
    'error: this data.json has no `pooledRows`. Re-run extract.ts — the register is built from it,\n' +
      '       and computing the lines here instead would put figures on the page that verify.ts cannot check.'
  );
  process.exit(1);
}

const declared = new Map(armsDeclared.map((a) => [`${a.task}#${a.arm}`, a]));

const hasFault = (l: { faults: string }): boolean => l.faults !== 'none' && l.faults !== '"none"';

/**
 * The control of a case, in either of the two shapes a control takes.
 *
 * Usually it is the baseline ARM: the same world with the one thing put right.
 * But where the condition is an injected failure it cannot be an arm at all — an
 * arm cannot switch a failure on — so the control is the same arm with nothing
 * injected, and both lines carry the scenario's claim. Asking only whether the
 * arm has a claim therefore called neither of them a control, and the register
 * came out with four lines nobody needed.
 */
const faultedArms = new Set(
  (data.pooledRows ?? []).filter(hasFault).map((l) => `${l.task}#${l.arm}`)
);
const isControl = (l: Line): boolean => {
  if (hasFault(l)) return false;
  if (faultedArms.has(`${l.task}#${l.arm}`)) return true;
  return declared.get(`${l.task}#${l.arm}`)?.claim === undefined;
};

/**
 * Worst case first, and each case's pair kept together.
 *
 * The reader should meet the line that matters before the rest — but a condition
 * without the control beside it is half a comparison, and with the left column
 * down to a method and a category the two lines of a case read alike. Scattering
 * them across the table makes the reader hunt for the half that gives the number
 * its meaning.
 */
const worstOf = new Map<string, number>();
for (const l of data.pooledRows) {
  worstOf.set(l.task, Math.max(worstOf.get(l.task) ?? 0, l.harm.count));
}
const ordered = [...data.pooledRows]
  // THE CONTROL IS NOT A LINE. It exists so the condition's number means
  // something, and every finding below states it — but as a row in the register
  // it doubles the height of the table with lines a reader has no use for and
  // cannot tell apart from the ones that matter. One line per case; the control
  // is named inside it.
  .filter((l) => !isControl(l))
  .sort(
    (a, b) =>
      (worstOf.get(b.task) ?? 0) - (worstOf.get(a.task) ?? 0) ||
      b.harm.count - a.harm.count ||
      a.task.localeCompare(b.task)
  );

/**
 * THE LEFT COLUMN IS TWO WORDS AND A TAG: the payment method, and the category
 * the case came in under.
 *
 * Both are the register's own, and both are short on purpose. A sentence here
 * takes half the screen, which costs the reader the model columns the matrix
 * exists for -- and a sentence is not what they need at a glance anyway. What
 * makes the line different from its neighbour is one click away, in the detail,
 * where it can be read properly.
 *
 * The one thing that cannot wait for the click is which of a pair is the
 * control, so that is a tag rather than a phrase.
 */

const label = (l: Line): { method: string; category: string } => {
  const info = caseOf.get(l.task);
  return {
    method: info?.method ?? l.task.replace(/\.yaml$/, ''),
    category: info?.category ?? l.arm,
  };
};

// ------------------------------------------------------------------ register

const registerRows = ordered
  .map((l, i) => {
    const { method, category } = label(l);
    const cells = MODEL_ORDER.map((m) => {
      const r = l.models.find((x) => x.model === m);
      if (r === undefined) return '<td class="mx"><span class="cell c-none" title="not run">·</span></td>';
      const cls = r.harmed ? 'c-harm' : r.done ? 'c-safe' : 'c-idle';
      const chip = r.harmed ? (r.done ? 'HC' : 'H·') : r.done ? '·C' : '··';
      return `<td class="mx"><span class="cell ${cls}" title="harmed ${r.harmed} of ${r.n}, completed ${r.done} of ${r.n}">${chip}</span></td>`;
    }).join('\n              ');

    // EVERY FIELD BELOW IS QUOTED, NOT COMPOSED. They are the columns of the
    // case register, which were written and checked to be understood by a reader
    // who has never seen this tool. Re-phrasing them here would quietly undo that.
    const info = caseOf.get(l.task);

    return `            <tr class="armrow" tabindex="0" role="button" aria-expanded="false" aria-controls="d${i}">
              <th scope="row" class="arm" title="${esc(l.task)}">
                <span class="twist" aria-hidden="true">▸</span>
                <span class="armtext"><b>${esc(method)}</b><em>${esc(category)}</em></span>
              </th>
              ${cells}
              <td class="tot tot-harm">${l.harm.count > 0 ? `<b class="bad">${l.harm.count}</b>` : l.harm.count} of ${l.harm.n}</td>
              <td class="tot tot-done">${l.completion.count} of ${l.completion.n}</td>
            </tr>
            <tr class="detail" id="d${i}" hidden>
              <td colspan="${MODEL_ORDER.length + 3}">
                <div class="dgrid">
                  <div>
                    <h4>The job</h4>
                    <p class="small">${esc(info?.source ?? '')}</p>
                    <h4>What the agent was asked</h4>
                    <p class="askquote">${esc(info?.job ?? '')}</p>
                  </div>
                  <div>
                    <h4>What counts as harm</h4>
                    <p class="small">${esc(info?.harm ?? '')}</p>
                    <h4>What this line is testing</h4>
                    <p class="small">${esc(info?.decision ?? '')}</p>
                  </div>
                </div>
              </td>
            </tr>`;
  })
  .join('\n');

const modelHead = MODEL_ORDER.map(
  (m) => `              <th class="mx" title="${esc(m)}">${esc(familyOf(m))}</th>`
).join('\n');

// ------------------------------------------------------------------ findings

/**
 * A finding, in the one shape every finding has.
 *
 * The two axes are stacked, never averaged, and each carries the condition and
 * its control together — a rate on its own is not a finding, and half a
 * comparison is not one either.
 *
 * THE CONTROL IS THE SAME SCENARIO WITHOUT THE HAZARD. Sometimes that means the
 * world untouched and the failure not injected; sometimes it means a world we
 * built by taking the hazard out of the one the source case describes. Either
 * way it is the twin, and it is what the condition has to clear.
 */
/**
 * One axis of a finding: the condition, its control, and whether they part.
 *
 * A rate is `null` when every episode on that side voided — the side was never
 * scored, which is not the same as scoring zero and must not be drawn as if it
 * were.
 */
interface Axis {
  test: Rate | null;
  control: Rate | null;
  separable: boolean;
}
interface Finding {
  task: string;
  title: string;
  claim: string;
  refutes: string;
  condition: string;
  control: string;
  harm: Axis;
  completion: Axis | null;
  separable: boolean;
}

const measures = (f: Finding): string => {
  const block = (name: string, axis: Axis, loss: boolean): string =>
    axis.test === null || axis.control === null
      ? ''
      : `
          <div class="measure">
            <div class="mrow"><b>${axis.test.count} of ${axis.test.n}</b><span>${name} — ${esc(f.condition)}</span></div>
            ${bar(axis.test, loss)}
            <div class="scale"><span>0%</span><span>${ci(axis.test)}</span><span>100%</span></div>
            <div class="mrow"><b>${axis.control.count} of ${axis.control.n}</b><span>${name} — ${esc(f.control)}</span></div>
            ${bar(axis.control, false)}
            <div class="scale"><span>0%</span><span>${ci(axis.control)}</span><span>100%</span></div>
            <p class="small soft">${axis.separable ? 'Intervals do not overlap.' : 'Intervals overlap at this sample size.'}</p>
          </div>`;
  return block('harmed', f.harm, true) + (f.completion === null ? '' : block('completed the job', f.completion, false));
};

/** Worst first, and a side that never scored sorts last rather than as zero. */
const harmCount = (f: Finding): number => f.harm.test?.count ?? -1;

const overlapFree = (test: Rate, control: Rate): boolean => control.hi < test.lo || test.hi < control.lo;

/**
 * The task file behind a comparison.
 *
 * A comparison names its `scenario` — `fp-23` — and the case register is keyed by
 * the file, `tc-fp-23.yaml`. The row ids carry the file already, so they are the
 * honest place to read it from rather than guessing a prefix.
 */
const taskOfComparison = (c: Comparison): string => {
  const row = (c.testRows ?? c.controlRows ?? [])[0];
  return row === undefined ? '' : `${row.split('__')[0]}.yaml`;
};

const collected: Finding[] = [
  // Claims whose control is another ARM of the same scenario.
  ...data.comparisons.map((c): Finding => {
    const task = taskOfComparison(c);
    const info = caseOf.get(task);
    return {
      task,
      title: `${info?.method ?? c.scenario ?? task} — ${info?.category ?? ''}`,
      claim: c.claim,
      refutes: c.refutes ?? refutesOf.get(c.id) ?? '',
      condition: c.condition ?? info?.condition ?? 'the condition',
      control: `the control, ${info?.control ?? 'the same scenario without the hazard'}`,
      harm: { test: c.harm.test, control: c.harm.control, separable: c.harm.separable },
      completion: { test: c.completion.test, control: c.completion.control, separable: c.completion.separable },
      separable: c.harm.separable || c.completion.separable,
    };
  }),
  // Claims whose control is a ROW of the same arm — the same scenario with
  // nothing injected. The reader is not shown that difference; it is ours.
  ...data.conditionals.flatMap((c): Finding[] => {
    const mine = (data.pooledRows ?? []).filter((l) => l.task === c.task);
    // A conditional claim usually sits on a fault row, whose control is the same
    // arm with nothing injected. But it can also sit on an ARM, and then its
    // control is the scenario's other arm — dropping that case is how fourteen
    // findings became thirteen.
    const test =
      mine.find((l) => l.arm === (c.arm ?? '') && hasFault(l)) ??
      mine.find((l) => l.arm === (c.arm ?? ''));
    const control =
      mine.find((l) => l.arm === (c.arm ?? '') && !hasFault(l) && l !== test) ??
      mine.find((l) => l !== test && isControl(l));
    if (test === undefined || control === undefined) return [];
    const sep = overlapFree(test.harm, control.harm);
    return [{
      task: c.task,
      title: `${caseOf.get(c.task)?.method ?? c.task} — ${caseOf.get(c.task)?.category ?? ''}`,
      claim: c.claim,
      refutes: c.refutes ?? refutesOf.get(c.id) ?? '',
      condition: caseOf.get(c.task)?.condition ?? 'with the failure',
      // (the register's own words for what is different about this line)
      control: `the control, ${caseOf.get(c.task)?.control ?? 'nothing injected'}`,
      harm: { test: test.harm, control: control.harm, separable: sep },
      completion: {
        test: test.completion,
        control: control.completion,
        separable: overlapFree(test.completion, control.completion),
      },
      separable: sep,
    }];
  }),
];

const separating = collected.filter((f) => f.separable).length;

const findings = [...collected]
  .sort((a, b) => Number(b.separable) - Number(a.separable) || harmCount(b) - harmCount(a))
  .map(
    (f) => `
      <div class="finding">
        <div class="fhead">
          <span class="verdict ${f.separable ? 'v-confirmed' : 'v-open'}">${f.separable ? 'Separates from its control' : 'Not separable at this sample size'}</span>
          <h3>${esc(f.title)}</h3>
          <p class="small">${esc(f.claim)}</p>
          ${f.refutes === '' ? '' : `<p class="small soft"><b>It would be refuted by:</b> ${esc(f.refutes)}</p>`}
        </div>
        <div class="measures">${measures(f)}
        </div>
      </div>`
  )
  .join('\n');

// -------------------------------------------------------------------- totals

const scenarioCount = new Set(ordered.map((l) => l.task)).size;


// ------------------------------------------------------------------ assemble

const template = readFileSync(TEMPLATE, 'utf8');
const style = /<style>[\s\S]*?<\/style>/.exec(template)?.[0] ?? '';
const scripts = template.slice(template.indexOf('<script>', template.indexOf('</main>')));


const insights =
  (notes.insights ?? []).length === 0
    ? ''
    : `<section id="insights">
      <h2>What this adds up to</h2>
      ${(notes.insights ?? [])
        .map((x) => `<h3>${esc(x.title)}</h3>\n      <p>${esc(x.body)}</p>`)
        .join('\n      ')}
    </section>`;

const page = `<title>${esc(notes.headline ?? 'Agent risk across the payment rails')}</title>

${style}

<div class="shell">
  <aside class="rail">
    <div class="stamp">
      <b>EXCRUCIATE</b>
      ${scenarioCount} scenarios · ${MODEL_ORDER.length} models<br>
      ${data.run.scored} runs scored
    </div>
    <nav id="nav">
      <a href="#verdict" class="here">Verdict</a>
      <a href="#register">The register</a>
      ${insights === '' ? '' : '<a href="#insights">What this adds up to</a>'}
      <a href="#findings">Findings</a>
      <a href="#method">Method &amp; limits</a>
    </nav>
    <div class="stamp" style="margin-top:auto">
      Every figure re-derivable:<br>
      <code style="background:none;padding:0">excruciate report</code>
    </div>
  </aside>

  <main>
    <section id="verdict">
      <p class="eyebrow">Agent risk · Payment operations</p>
      <h1>${esc(notes.headline ?? `${scenarioCount} payment scenarios, and ${separating} places where the agent behaves differently the moment something is wrong`)}</h1>
      <p class="lede">${esc(notes.lede ?? 'Each model was put through every scenario against a working simulation of the payment API. Beside each scenario sits a control that differs in exactly one thing, so a failure can be attributed to that one thing and nothing else.')}</p>
      <p class="soft">Two things are scored, never averaged together. <b>Harm</b> is money or authority
        left somewhere it should not be. <b>Done</b> is whether the job was actually finished — because
        an agent that does nothing causes no harm and is no use.</p>
      <div class="strip strip-3">
        <div><b>${scenarioCount}</b><span>payment scenarios</span></div>
        <div><b class="loss">${separating} of ${data.comparisons.length}</b><span>behaviours that separate from their control</span></div>
        <div><b>${data.run.scored}</b><span>runs scored</span></div>
      </div>
      <p class="cost">Model spend for the run: <b>$${(data.run.spend.usd ?? 0).toFixed(2)}</b>.</p>
    </section>

    <section id="register">
      <h2>The register</h2>
      <p class="soft small">Every scenario against every model, one run per cell. An injected failure
        sits on its own line rather than folded into the scenario, because the control beside it is
        the comparison. <strong>Select a line</strong> for the task, the scoring and the conditions
        behind it.</p>

      <div class="legend">
        <span><span class="cell c-harm">H·</span> harm, job not done</span>
        <span><span class="cell c-harm">HC</span> harm, job done</span>
        <span><span class="cell c-safe">·C</span> no harm, job done</span>
        <span><span class="cell c-idle">··</span> no harm, job not done</span>
        <span><span class="cell c-none">·</span> not run</span>
      </div>

      <div class="scroller matrix">
        <table>
          <thead>
            <tr>
              <th class="arm">Scenario</th>
${modelHead}
              <th class="tot tot-harm">Harmed</th>
              <th class="tot tot-done">Done</th>
            </tr>
          </thead>
          <tbody>
${registerRows}
          </tbody>
        </table>
      </div>
    </section>

    ${insights}

    <section id="findings">
      <h2>Findings</h2>
      <p class="soft small">Each was written down before the run, with the query that would confirm it
        and the behaviour that would refute it. Both axes are shown, because several of these leave no
        harm behind and simply stop the job being done.</p>
${findings}
    </section>

    <section id="method">
      <h2>Method &amp; limits</h2>
      <p><b>What was measured.</b> Two axes, never averaged. <em class="term">Harm</em> is state left in
        the world that should not be there — money moved, a mandate destroyed, authority taken.
        <em class="term">Done</em> is whether the job the operator asked for was finished.</p>
      <p><b>Every line has a control.</b> A scenario and its control differ in exactly one thing.
        Anything a model does in both is not caused by that one thing.</p>
      <p><b>Written down first.</b> Every claim in Findings was registered against its scenario before
        any model ran, along with the behaviour that would refute it.</p>
      <p><b>Sample size.</b> One run per cell, ${MODEL_ORDER.length} models per line. Enough to show a
        behaviour consistent across models, not enough to quote a rate. Where the intervals overlap the
        page says so rather than ranking.</p>
      ${notes.notCovered === undefined ? '' : `<p><b>What is not covered.</b> ${esc(notes.notCovered)}</p>`}
    </section>
  </main>
</div>

`;

writeFileSync(OUT, page + scripts);

/**
 * The instrument's own account of itself, beside the report and not inside it.
 *
 * `suspects` is the extractor's warning about experiments that may never have
 * happened, and it has to be read before any rate is believed — by us. A reader
 * deciding whether to let an agent near a payment rail is not the audience for
 * it, and putting it on the page has cost that reader space every time it has
 * been tried.
 */
const suspectLines = (data.suspects ?? [])
  .map((x) => `- **${x.task ?? x.kind}** — ${x.detail}`)
  .join('\n');

// WRITTEN ONCE, THEN LEFT ALONE. This is a document somebody writes into — the
// money audit, which check was too loose, what to change next time. Rewriting it
// on every build would throw that away, and it has.
const notePath = resolve(RUN, 'instrument-notes.md');
if (!existsSync(notePath))
  writeFileSync(
    notePath,
  `# What the instrument said about itself\n\n` +
    `Run \`${basename(RUN)}\` — ${data.run.scored} of ${data.run.episodes} episodes scored.\n\n` +
    `**This is not part of the report.** The report is for someone deciding whether an agent may\n` +
    `touch a payment rail; this is for whoever maintains the experiment.\n\n` +
    (suspectLines === ''
      ? 'The extractor flagged nothing about this run.\n'
      : `## Read before the rates\n\nEach may be real. Each is also the shape of an experiment that never\nhappened, so confirm the trap armed before reading one as a finding.\n\n${suspectLines}\n`) +
      `\n## Anything else\n\nWrite here what the money audit turned up, which checks were too loose or too\ntight, and what to change before the next run.\n`
  );

console.log(
  `${ordered.length} register lines · ${data.comparisons.length} claims · ${data.conditionals.length} conditionals → ${OUT}`
);

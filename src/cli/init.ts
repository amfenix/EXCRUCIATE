/**
 * `excruciate init` — the master setup.
 *
 * Asks only what it cannot sensibly guess, writes a research that already works,
 * then runs `check` on it. A scaffold that does not validate is worse than none:
 * it hands someone a broken thing and their first hour goes on deciding whether
 * they broke it.
 *
 * Every question has a flag, so a scripted run never blocks on a prompt.
 */
import ExcelJS from 'exceljs';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { KNOWN_PROVIDERS, describeValue, keychainAvailable, resolveKey, setKey } from '../keys.ts';
import { choose, chooseMany, confirm, interactive, line, slug } from './prompt.ts';
import * as T from './templates.ts';
import { loadResearch } from '../research/load.ts';
import { COLUMNS } from '../research/columns.ts';
import type { Mode } from '../runner.ts';
import type { SurfaceKind } from '../surface/types.ts';

const SURFACES = ['tools', 'api', 'search'] as const;
const LANGUAGES = ['typescript', 'python'] as const;
type Language = (typeof LANGUAGES)[number];

export interface InitArgs {
  dir: string;
  name?: string;
  surface?: string;
  handler?: string;
  language?: string;
  providers?: string;
  yes: boolean;
}

/** Every supported column, so nothing is unreachable without editing the file
 *  by hand. See `src/research/columns.ts`. */
export const HEADER: readonly string[] = COLUMNS;

export async function cmdInit(args: InitArgs): Promise<number> {
  const dir = resolve(args.dir);
  if (existsSync(resolve(dir, 'research.yaml'))) {
    console.error(`error: ${dir} already holds a research (research.yaml exists)`);
    return 1;
  }

  const name = args.name ?? (await line('Research name?', slug(basename(dir))));
  const surface = (args.surface as SurfaceKind | undefined) ?? (await choose('Default surface?', SURFACES, 'tools'));

  // A handler you already have is a fixture you already have: the handler and
  // the schema it queries are one thing.
  const existing = args.handler ?? (await askHandler());
  const language: Language =
    existing !== undefined
      ? 'typescript'
      : ((args.language as Language | undefined) ?? (await choose('Handler language?', LANGUAGES, 'typescript')));

  // fn mode loads domain.ts into OUR process, so it is TypeScript-only. Choosing
  // Python decides the mode; saying so beats writing a research that cannot start.
  const mode: Mode = language === 'typescript' ? 'fn' : 'http';
  if (language !== 'typescript') {
    console.error(`\nnote: a ${language} handler runs over HTTP, so mode is http (fn loads TypeScript in-process).`);
  }

  await setUpKeys(args);

  const fixture = existing ?? `fixtures/${slug(name) || 'world'}`;
  const plan: Plan = { name, surface, mode, fixture, language, scaffoldFixture: existing === undefined };

  console.log(`\nwriting ${dir}`);
  write(dir, plan);
  await writeWorkbook(resolve(dir, 'episodes.xlsx'));
  console.log('  episodes.xlsx');

  // A scaffold that does not validate is worse than none: it hands someone a
  // broken thing and their first hour goes on deciding whether they broke it.
  const ok = await validate(dir);
  nextSteps(dir, plan);
  return ok ? 0 : 1;
}

async function validate(dir: string): Promise<boolean> {
  try {
    const research = await loadResearch(dir);
    console.log(`\nchecked: ${research.meta.name} loads, 0 rows so far`);
    return true;
  } catch (e) {
    console.error(`\nthe scaffold does not validate — this is our bug, please report it:\n${(e as Error).message}`);
    return false;
  }
}

async function askHandler(): Promise<string | undefined> {
  if (!interactive()) return undefined;
  if (!(await confirm('Do you already have a handler to test against?', false))) return undefined;
  const path = await line('Path to it?');
  return path === '' ? undefined : path;
}

/**
 * Providers, and a key for each.
 *
 * Which model runs which case is the matrix's job — by then you can see what
 * your keys actually give you. What `init` can usefully settle is whether you
 * can call anything at all.
 */
async function setUpKeys(args: InitArgs): Promise<void> {
  const wanted =
    args.providers !== undefined
      ? args.providers.split(',').map((s) => s.trim())
      : await chooseMany('Providers you will use?', KNOWN_PROVIDERS, ['anthropic']);

  if (wanted.length === 0) return;
  console.error('');

  for (const provider of wanted) {
    const r = await resolveKey(provider);
    if (r.value !== null) {
      console.error(`  ${provider.padEnd(12)} ok   ${r.source}, ${describeValue(r.value)}`);
      continue;
    }
    console.error(`  ${provider.padEnd(12)} no key found`);
    if (args.yes || !interactive() || !(await keychainAvailable())) continue;
    if (!(await confirm(`  Enter one for ${provider} now?`, false))) continue;

    const value = await line(`  key for ${provider} (input is visible):`);
    if (value === '') continue;
    if (!/^[\x20-\x7e]+$/.test(value)) {
      console.error('  refused: the value contains non-ASCII, which an API key never does');
      continue;
    }
    console.error(`  stored at ${await setKey(provider, value)}`);
  }
}

interface Plan {
  name: string;
  surface: SurfaceKind;
  mode: Mode;
  fixture: string;
  language: Language;
  scaffoldFixture: boolean;
}

function write(dir: string, plan: Plan): void {
  const put = (path: string, content: string): void => {
    const full = resolve(dir, path);
    mkdirSync(resolve(full, '..'), { recursive: true });
    writeFileSync(full, content);
    console.log(`  ${relative(dir, full).replace(/\\/g, '/')}`);
  };

  put('research.yaml', T.RESEARCH_YAML(plan.name, plan.surface, plan.mode, plan.fixture));
  put('tasks/pay-rent.yaml', T.TASK_YAML);
  put('docs/policy.md', T.POLICY_MD);

  if (plan.scaffoldFixture) {
    put(`${plan.fixture}/schema.sql`, T.SCHEMA_SQL);
    put(`${plan.fixture}/seed.sql`, T.SEED_SQL);
    put(`${plan.fixture}/manifest.ts`, T.MANIFEST_TS);
    if (plan.language === 'typescript') {
      put(`${plan.fixture}/domain.ts`, T.DOMAIN_TS);
      put(`${plan.fixture}/serve.ts`, T.SERVE_TS);
    } else {
      put(`${plan.fixture}/serve.py`, T.SERVE_PY);
    }
  }
}

/** Header only. The matrix fills the rows, and it knows the fault names. */
export async function writeWorkbook(path: string, rows: string[][] = []): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('episodes');
  sheet.addRow(HEADER);
  for (const row of rows) sheet.addRow(row);
  await wb.xlsx.writeFile(path);
}

export function nextSteps(dir: string, plan: { fixture: string; language: Language }): void {
  const handler = plan.language === 'typescript' ? 'domain.ts' : 'serve.py';
  console.log(`
Next:
  1  describe the world     ${plan.fixture}/schema.sql · seed.sql
  2  implement the ops      ${plan.fixture}/${handler} · manifest.ts
  3  write a case           tasks/pay-rent.yaml
  4  build the matrix       excruciate matrix ${dir}
  5  check it               excruciate check ${dir}
  6  run it                 excruciate run ${dir}
`);
}

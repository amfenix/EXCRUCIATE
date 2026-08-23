/**
 * `init` and `matrix`.
 *
 * The claim a scaffold makes is that it WORKS — so the tests run it, check it,
 * and in one case drive the generated Python handler with a real episode. A
 * scaffold nobody exercises is a folder of plausible-looking files.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import ExcelJS from 'exceljs';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdInit } from '../src/cli/init.ts';
import { cmdMatrix } from '../src/cli/matrix.ts';
import { COLUMNS } from '../src/research/columns.ts';
import { loadResearch } from '../src/research/load.ts';
import { runEpisode } from '../src/episode/run.ts';
import { call as call2raw, close as close2, init as init2raw } from '../src/runner.ts';
import type { Session } from '../src/runner.ts';

const CLOCK = { now: '2026-08-18 09:12:00', business_day: 1 };
let sessions = 0;
const init2 = (fixture: string): Promise<Session> =>
  init2raw({ mode: 'http', fixture, session: `py-${++sessions}`, clock: CLOCK });
const call2 = (session: Session, op: string, input: Record<string, unknown>) =>
  call2raw(session, { op, input: input as never, principal: { id: 'agent', kind: 'agent' } });

const dirs: string[] = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'excruciate-init-'));
  dirs.push(dir);
  return join(dir, 'research');
};
/**
 * Best-effort, and never a failure.
 *
 * A spawned handler holds its cwd on Windows for a moment after it is killed, so
 * the first removal can hit EBUSY. A leftover temp directory is not a broken
 * test, and reporting it as one hides whatever actually broke.
 */
afterAll(async () => {
  for (const d of dirs) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(d, { recursive: true, force: true });
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
  }
});

const init = (dir: string, over: Record<string, string> = {}): Promise<number> =>
  cmdInit({ dir, name: 'treasury', providers: '', yes: true, language: 'typescript', ...over });

const matrix = (dir: string, over: Record<string, string> = {}): Promise<number> =>
  cmdMatrix({
    dir,
    models: 'anthropic/claude-haiku-4.5',
    surfaces: 'tools',
    memory: 'session',
    faults: 'lost-ack',
    repeat: '20',
    yes: true,
    ...over,
  });

const rows = async (dir: string): Promise<string[][]> => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(join(dir, 'episodes.xlsx'));
  const sheet = wb.worksheets[0]!;
  const out: string[][] = [];
  for (let i = 1; i <= sheet.rowCount; i++) {
    out.push((sheet.getRow(i).values as unknown[]).slice(1).map((v) => String(v ?? '')));
  }
  return out;
};

describe('init writes something that already works', () => {
  test('every file lands, and the research loads', async () => {
    const dir = fresh();
    expect(await init(dir)).toBe(0);

    for (const file of [
      'research.yaml',
      'episodes.xlsx',
      'tasks/pay-rent.yaml',
      'docs/policy.md',
      'fixtures/treasury/schema.sql',
      'fixtures/treasury/seed.sql',
      'fixtures/treasury/manifest.ts',
      'fixtures/treasury/domain.ts',
      'fixtures/treasury/serve.ts',
    ]) {
      expect(existsSync(join(dir, file))).toBe(true);
    }

    const research = await loadResearch(dir);
    expect(research.meta.name).toBe('treasury');
    expect(research.episodes).toHaveLength(0);
  }, 60_000);

  // A workbook with no rows is a fresh scaffold, not a broken research. Refusing
  // it made `init` report its own output as invalid.
  test('an empty workbook is not a fault', async () => {
    const dir = fresh();
    await init(dir);
    await expect(loadResearch(dir)).resolves.toBeDefined();
  }, 60_000);

  // `@docs/policy.md` sits at the research root, not in the fixture — a fixture
  // may be shared by several researches, a policy belongs to one.
  test('@file resolves from the research root', async () => {
    const dir = fresh();
    await init(dir);
    await matrix(dir);

    const research = await loadResearch(dir);
    const resolved = await runEpisode({ ...research.episodes[0]!.episode, steps: [] }).catch((e: Error) => e);
    // Reaching a void rather than a missing-file error means the @path resolved.
    expect(String(resolved)).not.toContain('no such file');
  }, 60_000);

  test('the scaffolded files depend on nothing of ours', async () => {
    const dir = fresh();
    await init(dir);
    for (const file of ['fixtures/treasury/domain.ts', 'fixtures/treasury/serve.ts', 'fixtures/treasury/manifest.ts']) {
      // A scaffold that imports an unpublished package is a scaffold that does
      // not run, and the first hour goes on finding out why.
      expect(readFileSync(join(dir, file), 'utf8')).not.toContain("from 'excruciate'");
    }
  }, 60_000);

  test('python chooses http mode, because fn loads TypeScript in-process', async () => {
    const dir = fresh();
    await init(dir, { language: 'python' });

    const meta = readFileSync(join(dir, 'research.yaml'), 'utf8');
    expect(meta).toContain('mode: http');
    expect(existsSync(join(dir, 'fixtures/treasury/serve.py'))).toBe(true);
    expect(existsSync(join(dir, 'fixtures/treasury/domain.ts'))).toBe(false);
  }, 60_000);

  test('it refuses to write over an existing research', async () => {
    const dir = fresh();
    await init(dir);
    expect(await init(dir)).toBe(1);
  }, 60_000);
});

describe('matrix fills the workbook from the tasks', () => {
  test('the cross-product, with ids that name the artefact', async () => {
    const dir = fresh();
    await init(dir);
    await matrix(dir, { surfaces: 'tools,api', memory: 'session,fresh' });

    const research = await loadResearch(dir);
    expect(research.episodes).toHaveLength(8); // 2 surfaces × 2 memories × (clean + lost-ack)
    expect(research.episodes.map((e) => e.row.id)).toContain(
      'pay-rent__claude-haiku-4.5__tools__session__lost-ack'
    );
  }, 60_000);

  /**
   * The control comes free. A harm rate under a fault means nothing without the
   * rate without it, and forgetting the control is the easiest way to produce a
   * number that looks like a finding.
   */
  test('selecting a fault also adds the run without it', async () => {
    const dir = fresh();
    await init(dir);
    await matrix(dir, { faults: 'lost-ack' });

    const research = await loadResearch(dir);
    const faults = research.episodes.map((e) => JSON.stringify(e.episode.faults));
    expect(faults).toContain('"none"');
    expect(faults).toContain('["lost-ack"]');
  }, 60_000);

  test('it only offers faults the task actually declares', async () => {
    const dir = fresh();
    await init(dir);
    await matrix(dir, { faults: 'lost-ack,invented' });

    const research = await loadResearch(dir);
    expect(research.episodes.map((e) => JSON.stringify(e.episode.faults)).sort()).toEqual([
      '"none"',
      '["lost-ack"]',
    ]);
  }, 60_000);

  // Running it again must not disturb a row someone has decided about.
  test('a second run adds nothing and preserves edits', async () => {
    const dir = fresh();
    await init(dir);
    await matrix(dir);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(join(dir, 'episodes.xlsx'));
    const enabled = COLUMNS.indexOf('enabled') + 1;
    const notes = COLUMNS.indexOf('notes') + 1;
    wb.worksheets[0]!.getRow(2).getCell(enabled).value = 'no';
    wb.worksheets[0]!.getRow(2).getCell(notes).value = 'too expensive';
    await wb.xlsx.writeFile(join(dir, 'episodes.xlsx'));

    await matrix(dir);
    const after = await rows(dir);
    expect(after).toHaveLength(3); // header + 2, nothing appended
    expect(after[1]![enabled - 1]).toBe('no');
    expect(after[1]![notes - 1]).toBe('too expensive');
  }, 60_000);

  test('temperature and thinking are never put on the same row', async () => {
    const dir = fresh();
    await init(dir);
    await matrix(dir, { temperature: '0,1', thinking: 'high' });

    // BY HEADER, never by position: this read `[, , , , , temperature, thinking]`
    // and quietly started asserting about the wrong two columns the day an `arm`
    // column was inserted before them.
    for (const row of (await rows(dir)).slice(1)) {
      const temperature = row[COLUMNS.indexOf('temperature')];
      const thinking = row[COLUMNS.indexOf('thinking')];
      // The pairing is refused at load, so the matrix must not be able to build it.
      expect(temperature !== '' && thinking !== '').toBe(false);
    }
  }, 60_000);

  test('everything it writes passes check', async () => {
    const dir = fresh();
    await init(dir);
    await matrix(dir, { surfaces: 'tools,api,search' });
    await expect(loadResearch(dir)).resolves.toBeDefined();
  }, 60_000);
});

/**
 * The scaffolded Python handler, actually run.
 *
 * A scaffold's whole claim is that it works. This drives the generated
 * `serve.py` through a real episode in http mode: the runner spawns it, it reads
 * STATE_URL, it talks to the world over HTTP, and the audit records the change.
 * Standard library only — nothing to install.
 */
const hasPython = (): boolean => {
  try {
    return Bun.spawnSync(['python', '--version'], { stdout: 'pipe', stderr: 'pipe' }).exitCode === 0;
  } catch {
    return false;
  }
};

describe.skipIf(!hasPython())('the python handler the scaffold writes', () => {
  test('the runner spawns it and the world changes', async () => {
    const dir = fresh();
    await init(dir, { language: 'python' });

    const research = await loadResearch(dir);
    const fixture = join(dir, 'fixtures/treasury');

    const session = await init2(fixture);
    try {
      const paid = await call2(session, 'payments.create', { id: 'PY-1', account: 'OPERATING', amount: 1500 });
      expect(paid.response).toEqual({ status: 201, body: { id: 'PY-1', status: 'SETTLED', amount: 1500 } });

      // Not the handler's word for it — the world's.
      expect(session.world.read(`SELECT balance FROM accounts WHERE id='OPERATING'`)).toEqual([{ balance: 98500 }]);
      expect(session.world.auditRows().some((a) => a.actor === 'agent' && a.tbl === 'payments')).toBe(true);

      // Time came from the request. A handler reaching for datetime.now() could
      // not be replayed, and this proves it did not.
      const [row] = session.world.read(`SELECT created_at FROM payments WHERE id='PY-1'`);
      expect((row as { created_at: string }).created_at).toBe('2026-08-18 09:12:00');
    } finally {
      await close2(session);
    }
    expect(research.meta.mode).toBe('http');
  }, 120_000);

  test('a duplicate id is a 409, not a funding problem', async () => {
    const dir = fresh();
    await init(dir, { language: 'python' });
    const session = await init2(join(dir, 'fixtures/treasury'));
    try {
      await call2(session, 'payments.create', { id: 'PY-2', account: 'OPERATING', amount: 100 });
      const again = await call2(session, 'payments.create', { id: 'PY-2', account: 'OPERATING', amount: 100 });
      expect(again.response.status).toBe(409);
    } finally {
      await close2(session);
    }
  }, 120_000);
});

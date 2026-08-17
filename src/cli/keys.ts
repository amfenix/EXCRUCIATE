/**
 * `excruciate keys` — set, list, delete, explain.
 *
 * A value is never printed. Not with a flag, not on a TTY, not ever: the whole
 * point of a keychain is that the secret stops being visible, and a tool that
 * echoes it back has undone that for the sake of a convenience nobody needs.
 * Length and an eleven-character prefix identify a key perfectly well.
 */
import {
  KNOWN_PROVIDERS,
  deleteKey,
  describeValue,
  keychainAvailable,
  keyIdentity,
  loadConfig,
  providerEnvVar,
  resolveKey,
  setKey,
  targetOf,
} from '../keys.ts';

const pad = (s: string, n: number): string => s.padEnd(n);

export async function cmdKeys(args: string[]): Promise<number> {
  const action = args[0] ?? 'list';
  const provider = args[1];

  if (action === 'list') return await list();
  if (action === 'which') return await which(provider);
  if (action === 'set') return await set(provider);
  if (action === 'delete' || action === 'remove') return await remove(provider);

  console.error(`error: unknown keys command "${action}"\n${USAGE}`);
  return 1;
}

const USAGE = `excruciate keys list                  every provider and where its key came from
excruciate keys which <provider>     the full resolution trace
excruciate keys set <provider>       store one in the OS keychain
excruciate keys delete <provider>`;

async function list(): Promise<number> {
  const config = loadConfig();
  const keychain = await keychainAvailable();

  console.log(`keychain  ${keychain ? 'available' : 'not installed — env vars and .env still work'}`);
  console.log('');
  console.log(`${pad('PROVIDER', 12)} ${pad('SOURCE', 15)} KEY`);

  for (const provider of KNOWN_PROVIDERS) {
    const r = await resolveKey(provider, { config });
    console.log(`${pad(provider, 12)} ${pad(r.source ?? '—', 15)} ${describeValue(r.value)}`);
  }
  return 0;
}

/**
 * Why a key resolved the way it did.
 *
 * A silent miss is indistinguishable from a missing key, and diagnosing one
 * without the trace cost two rounds of investigation while this was being built.
 */
async function which(provider: string | undefined): Promise<number> {
  if (!provider) {
    console.error(`error: which needs a provider\n${USAGE}`);
    return 1;
  }
  const r = await resolveKey(provider);
  for (const a of r.attempts) {
    const note = a.message === undefined ? '' : `  (${a.message})`;
    console.log(`  ${pad(a.result, 12)} ${pad(a.source, 15)} ${a.detail}${note}`);
  }
  console.log('');
  console.log(`  => ${r.source ?? 'NOT FOUND'}: ${describeValue(r.value)}`);
  return r.value ? 0 : 1;
}

async function set(provider: string | undefined): Promise<number> {
  if (!provider) {
    console.error(`error: set needs a provider\n${USAGE}`);
    return 1;
  }
  if (!(await keychainAvailable())) {
    console.error(
      `error: no OS keychain on this install.\n` +
        `  Install it:  bun add @napi-rs/keyring\n` +
        `  Or use an environment variable:  export ${providerEnvVar(provider)}=…`
    );
    return 1;
  }

  const value = await prompt(`key for ${provider} (input is visible): `);
  if (value === '') {
    console.error('error: nothing entered');
    return 1;
  }
  // An API key is ASCII. Anything else is a paste that went wrong, or a value
  // written by another tool in an encoding this one cannot read back.
  if (!/^[\x20-\x7e]+$/.test(value)) {
    console.error('error: refused — the value contains non-ASCII, which an API key never does');
    return 1;
  }

  const target = await setKey(provider, value, loadConfig());
  console.log(`stored at ${target} — ${describeValue(value)}`);
  return 0;
}

async function remove(provider: string | undefined): Promise<number> {
  if (!provider) {
    console.error(`error: delete needs a provider\n${USAGE}`);
    return 1;
  }
  if (!(await keychainAvailable())) {
    console.error('error: no OS keychain on this install, so there is nothing here to delete');
    return 1;
  }
  const { target, existed } = await deleteKey(provider, loadConfig());
  console.log(existed ? `deleted ${target}` : `nothing stored at ${target}`);
  return 0;
}

/** Reads one line. Non-interactive input never silently becomes an empty key. */
async function prompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    console.error('error: a key can only be entered interactively');
    return '';
  }
  process.stderr.write(question);
  return await new Promise<string>((resolve) => {
    const onData = (d: Buffer): void => {
      process.stdin.off('data', onData);
      process.stdin.pause();
      resolve(d.toString('utf8').trim());
    };
    process.stdin.resume();
    process.stdin.once('data', onData);
  });
}

/** Where a key WOULD be stored, for `init` to show before asking. */
export const keyTarget = (provider: string): string => targetOf(keyIdentity(provider, loadConfig()));

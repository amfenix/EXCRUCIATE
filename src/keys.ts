/**
 * Credential resolution.
 *
 * Five layers, first hit wins, and every attempt is recorded so `keys which` can
 * show *why* a key resolved the way it did. That matters more than it sounds: a
 * silent miss is indistinguishable from a missing key, and diagnosing one without
 * a trace cost two rounds of investigation while this was being built.
 *
 * The OS keychain is the recommended layer, but it is never required. The native
 * module is an optionalDependency loaded through a dynamic import; if it is
 * absent — no prebuilt for the platform, a policy that blocks it, a headless CI
 * box with no Secret Service — everything else still works. **The keychain is a
 * bonus, never a barrier to installing.**
 *
 * A key value is never logged, never written to a results folder, and never
 * printed without an explicit `--show` on a TTY.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, resolve as resolvePath } from 'node:path';

export type KeySource = 'flag' | 'env-excruciate' | 'env-provider' | 'keychain' | 'dotenv';

export interface Attempt {
  source: KeySource;
  /** what was actually looked at: an env var name, a computed keychain target, a path */
  detail: string;
  result: 'hit' | 'miss' | 'unavailable' | 'error';
  message?: string;
}

export interface KeyResolution {
  provider: string;
  value: string | null;
  source: KeySource | null;
  attempts: Attempt[];
}

export interface ProviderKeyConfig {
  /** keychain service; combined with `account` to form the target */
  service?: string;
  account?: string;
}

export interface KeyConfig {
  keys?: Record<string, ProviderKeyConfig>;
}

export interface ResolveOptions {
  /** an explicit --api-key. Discouraged: it lands in shell history. */
  flagValue?: string;
  /** research folder, for `.env` */
  dir?: string;
  config?: KeyConfig;
}

// ------------------------------------------------------------------- config

export function configPath(): string {
  const base =
    platform() === 'win32'
      ? (process.env['APPDATA'] ?? resolvePath(homedir(), 'AppData', 'Roaming'))
      : (process.env['XDG_CONFIG_HOME'] ?? resolvePath(homedir(), '.config'));
  return resolvePath(base, 'excruciate', 'config.json');
}

export function loadConfig(dir?: string): KeyConfig {
  const read = (p: string): KeyConfig => {
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as KeyConfig;
    } catch {
      return {};
    }
  };
  const global = existsSync(configPath()) ? read(configPath()) : {};
  const localPath = dir ? resolvePath(dir, 'excruciate.json') : null;
  const local = localPath && existsSync(localPath) ? read(localPath) : {};
  return { keys: { ...(global.keys ?? {}), ...(local.keys ?? {}) } };
}

export function saveConfig(cfg: KeyConfig): string {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`);
  return p;
}

// ------------------------------------------------------------------ naming

const upper = (provider: string): string => provider.toUpperCase().replace(/[^A-Z0-9]/g, '_');

export const excruciateEnvVar = (provider: string): string => `EXCRUCIATE_${upper(provider)}_API_KEY`;
export const providerEnvVar = (provider: string): string => `${upper(provider)}_API_KEY`;

/** Default keychain identity: target `<provider>.excruciate`. */
export const defaultKeyConfig = (provider: string): Required<ProviderKeyConfig> => ({
  service: 'excruciate',
  account: provider,
});

export function keyIdentity(provider: string, config?: KeyConfig): Required<ProviderKeyConfig> {
  const d = defaultKeyConfig(provider);
  const c = config?.keys?.[provider] ?? {};
  return { service: c.service ?? d.service, account: c.account ?? d.account };
}

/**
 * The store is a flat map from one target string to one blob; "service" and
 * "account" are a fiction the library encodes into it as `{account}.{service}`.
 * Splitting a raw target at the FIRST dot recovers a pair that reproduces it,
 * which is how an existing entry from another tool is pointed at.
 */
export function splitTarget(target: string): Required<ProviderKeyConfig> {
  const i = target.indexOf('.');
  if (i < 0) return { account: target, service: '' };
  return { account: target.slice(0, i), service: target.slice(i + 1) };
}

export const targetOf = (id: Required<ProviderKeyConfig>): string => `${id.account}.${id.service}`;

// ---------------------------------------------------------------- keychain

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(v: string): void;
  deletePassword(): boolean;
}
interface KeyringModule {
  Entry: new (service: string, account: string) => KeyringEntry;
}

let keyringCache: KeyringModule | null | undefined;

/** null when the native module is unavailable — never an exception. */
export async function keyring(): Promise<KeyringModule | null> {
  if (keyringCache !== undefined) return keyringCache;
  try {
    keyringCache = (await import('@napi-rs/keyring')) as unknown as KeyringModule;
  } catch {
    keyringCache = null;
  }
  return keyringCache;
}

export async function keychainAvailable(): Promise<boolean> {
  return (await keyring()) !== null;
}

const NUL = String.fromCharCode(0);
/** A value written UTF-16LE and read by a UTF-8 reader arrives NUL-separated. */
const stripNul = (s: string): string => (s.includes(NUL) ? s.split(NUL).filter(Boolean).join('') : s);

// -------------------------------------------------------------------- .env

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k) out[k] = v;
  }
  return out;
}

// ----------------------------------------------------------------- resolve

/** A key found, and where. Null means "not here" — never "not anywhere". */
type Hit = { value: string; source: KeySource } | null;

/** Every place a key can come from, in the order they are consulted. */
type Lookup = (provider: string, opts: ResolveOptions, config: KeyConfig, attempts: Attempt[]) => Promise<Hit>;

/**
 * ORDER IS THE POLICY, and it is the whole of this function: an explicit flag
 * beats the environment, which beats the OS keychain, which beats a `.env` in
 * the research folder. Every source it consulted is recorded either way, so a
 * missing key can be diagnosed without guessing — the absence of that trace
 * cost two rounds of investigation while this was being built.
 */
export async function resolveKey(provider: string, opts: ResolveOptions = {}): Promise<KeyResolution> {
  const attempts: Attempt[] = [];
  const config = opts.config ?? loadConfig(opts.dir);

  for (const lookup of [fromFlag, fromEnv, fromKeychain, fromDotenv]) {
    const hit = await lookup(provider, opts, config, attempts);
    if (hit !== null) return { provider, value: hit.value, source: hit.source, attempts };
  }
  return { provider, value: null, source: null, attempts };
}

const fromFlag: Lookup = async (_provider, opts, _config, attempts) => {
  const hit = opts.flagValue !== undefined && opts.flagValue !== '';
  attempts.push({ source: 'flag', detail: '--api-key', result: hit ? 'hit' : 'miss' });
  return hit ? { value: opts.flagValue!, source: 'flag' } : null;
};

const fromEnv: Lookup = async (provider, _opts, _config, attempts) => {
  const names: Array<[KeySource, string]> = [
    ['env-excruciate', excruciateEnvVar(provider)],
    ['env-provider', providerEnvVar(provider)],
  ];
  for (const [source, name] of names) {
    const value = process.env[name];
    attempts.push({ source, detail: name, result: value ? 'hit' : 'miss' });
    if (value) return { value, source };
  }
  return null;
};

const fromKeychain: Lookup = async (provider, _opts, config, attempts) => {
  const id = keyIdentity(provider, config);
  const detail = targetOf(id);

  const kr = await keyring();
  if (!kr) {
    attempts.push({
      source: 'keychain',
      detail,
      result: 'unavailable',
      message: '@napi-rs/keyring is not installed for this platform; env and .env still work',
    });
    return null;
  }

  try {
    const raw = new kr.Entry(id.service, id.account).getPassword();
    const value = raw ? stripNul(raw) : null;
    attempts.push({ source: 'keychain', detail, result: value ? 'hit' : 'miss' });
    return value ? { value, source: 'keychain' } : null;
  } catch (e) {
    // A read that throws is NOT the same as a key that is absent, and conflating
    // them makes a decode failure look like a missing credential.
    attempts.push({ source: 'keychain', detail, result: 'error', message: (e as Error).message });
    return null;
  }
};

const fromDotenv: Lookup = async (provider, opts, _config, attempts) => {
  if (opts.dir === undefined) return null;

  const detail = resolvePath(opts.dir, '.env');
  if (!existsSync(detail)) {
    attempts.push({ source: 'dotenv', detail, result: 'miss', message: 'no .env in the research folder' });
    return null;
  }

  const env = parseDotenv(readFileSync(detail, 'utf8'));
  const value = env[excruciateEnvVar(provider)] ?? env[providerEnvVar(provider)];
  attempts.push({ source: 'dotenv', detail, result: value ? 'hit' : 'miss' });
  return value ? { value, source: 'dotenv' } : null;
};

// ------------------------------------------------------------------ mutate

export class KeychainUnavailable extends Error {
  constructor() {
    super(
      'no OS keychain available on this install (@napi-rs/keyring is an optional dependency). ' +
        'Use an environment variable or a .env file instead.'
    );
    this.name = 'KeychainUnavailable';
  }
}

export async function setKey(provider: string, value: string, config?: KeyConfig): Promise<string> {
  const kr = await keyring();
  if (!kr) throw new KeychainUnavailable();
  const id = keyIdentity(provider, config ?? loadConfig());
  new kr.Entry(id.service, id.account).setPassword(value);
  return targetOf(id);
}

export async function deleteKey(provider: string, config?: KeyConfig): Promise<{ target: string; existed: boolean }> {
  const kr = await keyring();
  if (!kr) throw new KeychainUnavailable();
  const id = keyIdentity(provider, config ?? loadConfig());
  const entry = new kr.Entry(id.service, id.account);
  let existed = false;
  try {
    existed = entry.getPassword() !== null;
  } catch {
    existed = false;
  }
  try {
    entry.deletePassword();
  } catch {
    /* already absent */
  }
  return { target: targetOf(id), existed };
}

/** Presence only. A value is never returned from here. */
export function describeValue(value: string | null): string {
  if (!value) return 'not set';
  const printable = /^[\x20-\x7e]+$/.test(value);
  return `${value.length} chars, prefix ${value.slice(0, Math.min(11, value.length))}…${
    printable ? '' : '  (WARNING: contains non-ASCII — probably a decoding mismatch)'
  }`;
}

/** Providers worth checking by default. */
export const KNOWN_PROVIDERS = ['anthropic', 'openai', 'google', 'xai', 'openrouter', 'nebius'] as const;

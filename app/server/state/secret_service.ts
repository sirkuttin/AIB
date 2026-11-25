/**
 * The Linux Secret Service (GNOME Keyring, KWallet, KeePassXC...) through `secret-tool` (libsecret's command line), for the
 * secrets AIB keeps at rest: API keys, the push (VAPID) private key, the allow-rules signing key, sync pairing tokens.
 *
 * Prior art, and what AIB takes from each:
 *   - VS Code (SecretStorage -> Electron safeStorage -> libsecret / kwallet): uses the OS store when a keyring answers; a headless
 *     box with none is the case it cannot serve, which is why it asks for --password-store=basic there. AIB instead falls back by
 *     itself, once, with a log line.
 *   - GitHub CLI (go-keyring -> Secret Service over D-Bus): when no keyring answers it writes the token to hosts.yml in plain text
 *     and says so. Same fallback shape; AIB keeps it in a 0600 file.
 *   - Docker credential helpers (docker-credential-secretservice / -pass): the store is a separate helper; the config only
 *     names it, and "not available" is an error the user sees. AIB keeps only a marker in its own files, the value is in the store.
 *   - keytar (Atom/VS Code before safeStorage): libsecret with attributes {service, account}; no fallback at all, and it hung
 *     on a locked keyring waiting for an unlock prompt. AIB copies the attribute scheme (service + account) and bounds every call
 *     with `timeout`, so a locked keyring at a headless restart turns into the fallback, never a hang.
 *
 * The value goes to `secret-tool store` on stdin (never an argument, so it is not in a process list). Deno cannot write a child's
 * stdin synchronously, so the child is `sh -c 'printf %s "$VAR" | { unset VAR; exec secret-tool ... }'` with the value in the
 * environment of that one shell only: the same user can read it there (as it can read AIB's memory), nobody else.
 *
 * Nothing here ever logs or returns a value in an error: messages name the store, never the secret.
 */
import { getLogger } from '../core/log.ts';
import { which } from '../platform/pypath.ts';

const log = getLogger('secrets');

export interface ToolResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}
/** Runs `secret-tool <args>`; `input` goes to its stdin. Replaced in tests. */
export type ToolRunner = (args: string[], input?: string) => ToolResult;

/** Seconds a `secret-tool` call may take: a locked keyring waits for an unlock dialog nobody answers on a headless restart. */
const CALL_SECONDS = 15;
const INPUT_VAR = 'AIB_SECRET_TOOL_INPUT';
const decode = new TextDecoder();

const realRunner: ToolRunner = (args, input) => {
  try {
    const bounded = which('timeout') ? ['timeout', String(CALL_SECONDS), 'secret-tool', ...args] : ['secret-tool', ...args];
    const command = input === undefined
      ? new Deno.Command(bounded[0], { args: bounded.slice(1), stdin: 'null', stdout: 'piped', stderr: 'piped' })
      : new Deno.Command('sh', {
        args: ['-c', `printf %s "$${INPUT_VAR}" | { unset ${INPUT_VAR}; exec "$@"; }`, 'sh', ...bounded],
        env: { [INPUT_VAR]: input },
        stdin: 'null',
        stdout: 'piped',
        stderr: 'piped',
      });
    const r = command.outputSync();
    return { ok: r.success, stdout: decode.decode(r.stdout), stderr: decode.decode(r.stderr) };
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
};

let runner: ToolRunner = realRunner;
let available: boolean | null = null;
let noticed = false;

/** Tests: use this runner for every call (null = the real `secret-tool`) and forget what was probed. */
export function setToolRunner(next: ToolRunner | null): void {
  runner = next ?? realRunner;
  available = null;
  noticed = false;
}

/** The service name of AIB's entries; AIB_KEYRING_SERVICE_SUFFIX (tests) keeps a test run's entries apart from the owner's. */
export function serviceName(base: string): string {
  const suffix = (Deno.env.get('AIB_KEYRING_SERVICE_SUFFIX') || '').trim();
  return suffix ? `${base} ${suffix}` : base;
}

/**
 * Is a Secret Service answering? `secret-tool` must exist and a lookup of an entry that is not there must fail quietly: a failed
 * lookup that prints something (no D-Bus session, no org.freedesktop.secrets provider) means there is no service. Cached.
 */
export function secretServiceAvailable(): boolean {
  if (available !== null) return available;
  if (runner === realRunner && (Deno.build.os !== 'linux' || !which('secret-tool'))) return (available = false);
  const r = runner(['lookup', 'service', serviceName('AIB probe'), 'account', 'probe']);
  available = r.ok || r.stderr.trim() === '';
  return available;
}

/** One line in the log, once per run, when Linux has no Secret Service and secrets stay in 0600 files. */
export function noteFileFallback(): void {
  if (noticed) return;
  noticed = true;
  log.info('No Secret Service (keyring) is available here; secrets are kept in owner-only (0600) files in the data folder.');
}

/**
 * May this process put secrets in the Secret Service? Linux only. AIB_KEY_STORE=file says no, =secret-service says yes (and a
 * secret still falls back to its file when a write fails); otherwise yes when a service answers, except under the test suite
 * (AGENT_STUDIO_TEST=1), which never touches a real keyring.
 */
export function useSecretService(): boolean {
  const want = (Deno.env.get('AIB_KEY_STORE') || '').trim().toLowerCase();
  if (runner === realRunner && Deno.build.os !== 'linux') return false;
  if (want === 'file') return false;
  if (!want && Deno.env.get('AGENT_STUDIO_TEST') === '1' && runner === realRunner) return false;
  if (want && want !== 'secret-service') return false;
  if (secretServiceAvailable()) return true;
  noteFileFallback();
  return false;
}

export function ssStore(service: string, account: string, label: string, plain: string): boolean {
  return runner(['store', '--label', label, 'service', serviceName(service), 'account', account], plain).ok;
}

export function ssLookup(service: string, account: string): string | null {
  const r = runner(['lookup', 'service', serviceName(service), 'account', account]);
  if (!r.ok) return null;
  const text = r.stdout.replace(/\r?\n$/, '');
  return text === '' ? null : text;
}

export function ssClear(service: string, account: string): boolean {
  return runner(['clear', 'service', serviceName(service), 'account', account]).ok;
}

// ---- markers: "secret-service:v1:<account>" stands for a value kept in the service under AIB's device-key service name --------

export const DEVICE_SERVICE = 'AIB device keys';
export const MARKER_PREFIX = 'secret-service:v1:';

export function isMarker(stored: unknown): boolean {
  return typeof stored === 'string' && stored.startsWith(MARKER_PREFIX) && stored.length > MARKER_PREFIX.length;
}

/** Puts `plain` in the service under a fresh account for `purpose`; the marker to keep in the file, or null when the store refused. */
export function storeMarked(purpose: string, plain: string): string | null {
  const account = `${purpose}-${crypto.randomUUID()}`;
  if (!ssStore(DEVICE_SERVICE, account, `AIB: ${purpose}`, plain)) return null;
  if (ssLookup(DEVICE_SERVICE, account) !== plain) { // written but not readable back: do not trust it
    ssClear(DEVICE_SERVICE, account);
    return null;
  }
  return MARKER_PREFIX + account;
}

export function openMarked(marker: string): string | null {
  return isMarker(marker) ? ssLookup(DEVICE_SERVICE, marker.slice(MARKER_PREFIX.length)) : null;
}

export function forgetMarked(marker: unknown): void {
  if (typeof marker === 'string' && isMarker(marker)) ssClear(DEVICE_SERVICE, marker.slice(MARKER_PREFIX.length));
}

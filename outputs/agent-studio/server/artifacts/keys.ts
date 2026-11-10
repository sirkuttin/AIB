/**
 * Per-conversation keys for Studio's artifact tool (artifact_keys.py).
 *
 * The agent's MCP shim authenticates to the artifact routes with the header X-Studio-Artifact-Key instead of the page token; a key
 * only works for the conversation it was issued to. A key is HMAC-SHA256(secret, 'studio-artifact-key/v1\0' + conversation id as
 * UTF-8), lowercase hex, where the secret is the whole content (32 random bytes when created) of the file artifact-key-secret in the
 * shared state folder, created once with O_EXCL and mode 0600. The file and the key are byte-for-byte those of the Python server, so
 * a key issued by either server checks in the other while both share the state folder (interop tests in work/deno/artifact_keys_test.ts).
 *
 *   configure(stateDir)             // once per process
 *   const key = issue(conversationId)
 *   check(key, conversationId)      // true only for the key issued for exactly that conversation
 */
import { createHmac, randomBytes } from 'node:crypto';
import { getLogger, registerSecret } from '../core/log.ts';
import { join } from '../platform/path.ts';
import { tokenMatches } from '../web/security.ts';

const log = getLogger('artifact_keys');

export const SECRET_FILE = 'artifact-key-secret';
const PREFIX = new TextEncoder().encode('studio-artifact-key/v1\0');
const state: { dir: string | null; secret: Uint8Array | null } = { dir: null, secret: null };

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function loadSecret(directory: string): Uint8Array {
  const path = join(directory, SECRET_FILE);
  Deno.mkdirSync(directory, { recursive: true });
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const data = Deno.readFileSync(path);
      if (data.length >= 32) return data;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      let file: Deno.FsFile;
      try {
        file = Deno.openSync(path, { write: true, createNew: true, mode: 0o600 });
      } catch (createError) {
        if (createError instanceof Deno.errors.AlreadyExists) continue;
        throw createError;
      }
      try {
        const data = new Uint8Array(randomBytes(32));
        let written = 0;
        while (written < data.length) written += file.writeSync(data.subarray(written));
      } finally {
        file.close();
      }
      continue;
    }
    sleepSync(20); // another process is still writing it
  }
  throw new Error('Could not read the artifact key secret');
}

/** Choose the shared state folder. Safe to call again; returns true when a secret is available. */
export function configure(stateDir: string | null | undefined): boolean {
  if (stateDir === null || stateDir === undefined) {
    state.dir = state.secret = null;
    return false;
  }
  if (state.dir !== String(stateDir) || state.secret === null) {
    try {
      state.secret = loadSecret(String(stateDir));
      state.dir = String(stateDir);
    } catch {
      state.dir = state.secret = null;
      return false;
    }
  }
  return true;
}

function mac(conversationId: unknown): string {
  return createHmac('sha256', state.secret!).update(PREFIX).update(new TextEncoder().encode(String(conversationId))).digest('hex');
}

/** The key for this conversation, or null when no state folder is configured. */
export function issue(conversationId: unknown): string | null {
  if (!conversationId || state.secret === null) return null;
  const key = mac(conversationId);
  registerSecret(key); // so it is blanked if it ever reaches a log line
  return key;
}

/** True only when key is the key issued for exactly this conversation. Never throws. */
export function check(key: unknown, conversationId: unknown): boolean {
  try {
    if (!key || !conversationId || state.secret === null) return false;
    return tokenMatches(String(key), mac(conversationId));
  } catch (error) {
    log.exception(error, 'Artifact key check failed; treated as not valid'); // never log the key itself
    return false;
  }
}

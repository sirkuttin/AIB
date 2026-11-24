/**
 * Per-conversation keys for Studio's artifact tool (artifact_keys.py).
 *
 * The agent's MCP shim authenticates to the artifact routes with the header X-Studio-Artifact-Key instead of the page token; a key
 * only works for the conversation it was issued to. A key is HMAC-SHA256(secret, 'studio-artifact-key/v1\0' + conversation id as
 * UTF-8), lowercase hex, where the secret is the whole content (32 random bytes when created) of the file artifact-key-secret in the
 * shared state folder, created once with O_EXCL and mode 0600. The file and the key are byte-for-byte those of the Python server, so
 * a key issued by either server checks in the other while both share the state folder (interop tests in work/deno/artifact_keys_test.ts).
 *
 * Security item 7: on Windows the file holds the secret sealed with DPAPI for this user ("dpapi:v1:<base64>", state/sealed.ts), so
 * an agent that reads the data folder cannot compute another chat's key; a plain file from an older AIB is sealed in place at the
 * next start (same secret: keys already issued keep checking). Elsewhere it stays plain, mode 0600. (The Python server cannot read
 * a sealed file; it is retired, and AIB_SEAL=off keeps the plain form for the interop tests.)
 *
 *   configure(stateDir)             // once per process
 *   const key = issue(conversationId)
 *   check(key, conversationId)      // true only for the key issued for exactly that conversation
 */
import { createHmac, randomBytes } from 'node:crypto';
import { getLogger, registerSecret } from '../core/log.ts';
import { join } from '../platform/path.ts';
import { tokenMatches } from '../web/security.ts';
import { openBytes, sealBytes, SEALED_PREFIX, sealingOn } from '../state/sealed.ts';

const log = getLogger('artifact_keys');

export const SECRET_FILE = 'artifact-key-secret';
const PREFIX = new TextEncoder().encode('studio-artifact-key/v1\0');
const state: { dir: string | null; secret: Uint8Array | null } = { dir: null, secret: null };

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const SEALED_START = new TextEncoder().encode(SEALED_PREFIX);

function isSealedFile(data: Uint8Array): boolean {
  return data.length > SEALED_START.length && SEALED_START.every((b, i) => data[i] === b);
}

/** The secret in a secret file's bytes, plain or sealed (tests and tools that compute keys themselves); null when unusable. */
export function secretOfFile(data: Uint8Array): Uint8Array | null {
  if (isSealedFile(data)) return openBytes('artifact-key-secret', new TextDecoder().decode(data).trim());
  return data.length >= 32 ? data : null;
}

/**
 * Seal a plain secret file in place (security item 7: on Windows the file holds "dpapi:v1:<base64>" for this user, so an agent
 * that reads it cannot forge another chat's key). Same secret, so every key already issued keeps checking. Best effort: another
 * process reading the file at that moment can make the rename fail; the next start tries again.
 */
function sealInPlace(path: string, secret: Uint8Array): void {
  if (!sealingOn()) return;
  const temporary = `${path}.${Deno.pid}.tmp`;
  try {
    Deno.writeTextFileSync(temporary, sealBytes('artifact-key-secret', secret), { createNew: true, mode: 0o600 });
    Deno.renameSync(temporary, path);
  } catch (error) {
    try {
      Deno.removeSync(temporary);
    } catch { /* not made */ }
    log.warning('The artifact key secret could not be sealed yet (%s); it stays as it was', error instanceof Error ? error.message : error);
  }
}

function loadSecret(directory: string): Uint8Array {
  const path = join(directory, SECRET_FILE);
  Deno.mkdirSync(directory, { recursive: true });
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const data = Deno.readFileSync(path);
      if (isSealedFile(data)) {
        const secret = openBytes('artifact-key-secret', new TextDecoder().decode(data).trim());
        if (secret && secret.length >= 32) return secret;
        // Sealed for another Windows account or damaged: no key can be issued (as with a short file); never replaced silently.
        throw new Error('The artifact key secret is sealed for another Windows account or damaged');
      }
      if (data.length >= 32) {
        sealInPlace(path, data); // migration: a plain secret from an older AIB
        return data;
      }
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
        const secret = new Uint8Array(randomBytes(32));
        const data = sealingOn() ? new TextEncoder().encode(sealBytes('artifact-key-secret', secret)) : secret;
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

/**
 * Subagent worktrees (design v2 2.1): the key a Claude chat's command hooks send to AIB's hook routes, HMAC with its own label
 * ('studio-hook-key/v1') over the same secret, so it never works as an artifact key and the other way round. It goes in the agent
 * process's environment (AIB_HOOK_KEY), never in settings, a command line or a URL.
 */
const HOOK_PREFIX = new TextEncoder().encode('studio-hook-key/v1\0');

function hookMac(conversationId: unknown): string {
  return createHmac('sha256', state.secret!).update(HOOK_PREFIX).update(new TextEncoder().encode(String(conversationId))).digest('hex');
}

/** The hook key for this conversation, or null when no state folder is configured. */
export function issueHookKey(conversationId: unknown): string | null {
  if (!conversationId || state.secret === null) return null;
  const key = hookMac(conversationId);
  registerSecret(key);
  return key;
}

/** True only when key is the hook key of exactly this conversation. Never throws. */
export function checkHookKey(key: unknown, conversationId: unknown): boolean {
  try {
    if (!key || !conversationId || state.secret === null) return false;
    return tokenMatches(String(key), hookMac(conversationId));
  } catch {
    return false;
  }
}

const PROOF_PREFIX = new TextEncoder().encode('studio-hook-proof/v1\0');
const NUL = new Uint8Array([0]);

/**
 * The proof AIB puts on each hook answer (X-Studio-Hook-Proof; security review P1, MF 1): lowercase hex HMAC-SHA256 keyed with the
 * chat's hook key over 'studio-hook-proof/v1\0' + the forwarder's nonce + '\0' + the status + '\0' + the body bytes. The keeper's
 * forwarder (keeper/hookforward.go hookProof) blocks any answer without it, so a program squatting AIB's port can't answer.
 */
export function hookProof(key: string, nonce: string, status: number, body: Uint8Array): string {
  const enc = new TextEncoder();
  return createHmac('sha256', key).update(PROOF_PREFIX).update(enc.encode(nonce)).update(NUL).update(enc.encode(String(status)))
    .update(NUL).update(body).digest('hex');
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

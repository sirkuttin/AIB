/**
 * Sealed secrets: AIB's own control secrets at rest, and the per-chat keys AIB hands to a forwarder through an agent, in a form a
 * program that only reads files gets nothing from (security item 7, "readable token files control agents").
 *
 *   Windows  "dpapi:v1:<base64>"  CryptProtectData for the current user, with entropy "AIB sealed secret v1\0<purpose>", so a value
 *                                  sealed for one use never opens as another. The keeper (keeper/seal_windows.go) seals and opens
 *                                  the same form: keeper.json's token, MCP_FORWARD_HEADERS, AIB_HOOK_KEY.
 *   Linux, a Secret Service answering
 *                                  "secret-service:v1:<account>" for the long-lived secrets only (SERVICE_PURPOSES: the sync
 *                                  pairing token). The per-run ones (host token, artifact key, forward headers, hook key) are
 *                                  also read by the keeper (Go) and made anew each run: they stay as below.
 *   elsewhere                      no DPAPI: values stay plain, in 0600 files; the keeper's peer check guards its token instead
 *                                  (keeper/peer_linux.go, peer_darwin.go).
 *
 * What this does not stop, and cannot for a program of the same Windows user: one that runs code can call DPAPI itself (or read
 * AIB's memory). The line it draws: reading AIB's files never gives control; only running code as the user does, which already
 * equals being the user.
 *
 * AIB_SEAL=off turns sealing off (tests that compare the old, plain form); opening still works.
 */
import { dpapiProtect, dpapiUnprotect, fromBase64, toBase64 } from './secrets.ts';
import { forgetMarked, isMarker, openMarked, storeMarked, useSecretService } from './secret_service.ts';

export const SEALED_PREFIX = 'dpapi:v1:';

export type SealPurpose =
  | 'pcsync-peer-token'
  | 'keeper-token'
  | 'agent-host-token'
  | 'artifact-key-secret'
  | 'mcp-forward-headers'
  | 'hook-key'
  | 'artifact-key';

/** Purposes kept in the Secret Service on Linux when one answers: long-lived, and only AIB's server reads them. */
const SERVICE_PURPOSES: readonly SealPurpose[] = ['pcsync-peer-token'];

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder('utf-8', { fatal: true });

function entropy(purpose: SealPurpose): Uint8Array<ArrayBuffer> {
  return utf8.encode(`AIB sealed secret v1\0${purpose}`) as Uint8Array<ArrayBuffer>;
}

/** True when this process seals (Windows, not turned off). */
export function sealingOn(): boolean {
  return Deno.build.os === 'windows' && (Deno.env.get('AIB_SEAL') || '').toLowerCase() !== 'off';
}

export function isSealedText(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SEALED_PREFIX);
}

/** The sealed form of some bytes ("dpapi:v1:..."); throws when DPAPI fails or this is not Windows. */
export function sealBytes(purpose: SealPurpose, plain: Uint8Array): string {
  const copy = new Uint8Array(plain);
  try {
    return SEALED_PREFIX + toBase64(dpapiProtect(copy, entropy(purpose)));
  } finally {
    copy.fill(0);
  }
}

/** The bytes of a sealed form; null when it cannot be opened (another user, another purpose, damaged, not Windows). */
export function openBytes(purpose: SealPurpose, stored: string): Uint8Array | null {
  if (!isSealedText(stored) || Deno.build.os !== 'windows') return null;
  try {
    return dpapiUnprotect(fromBase64(stored.slice(SEALED_PREFIX.length)), entropy(purpose));
  } catch {
    return null;
  }
}

/** Sealed when this process seals, else the plain text as it is. */
export function sealText(purpose: SealPurpose, plain: string): string {
  if (SERVICE_PURPOSES.includes(purpose) && useSecretService()) return storeMarked(purpose, plain) ?? plain; // refused: stays plain
  if (!sealingOn()) return plain;
  return sealBytes(purpose, utf8.encode(plain));
}

/** sealText, but never throws: the plain text when DPAPI refuses (the flow keeps working as before this change). */
export function sealOrPlain(purpose: SealPurpose, plain: string): string {
  try {
    return sealText(purpose, plain);
  } catch {
    return plain;
  }
}

/** The plain text of a sealed form; a value without the prefix is returned as it is (an older AIB's plain value); null when a
 * sealed value cannot be opened. */
export function openText(purpose: SealPurpose, stored: string): string | null {
  if (isMarker(stored)) return openMarked(stored);
  if (!isSealedText(stored)) return stored;
  const bytes = openBytes(purpose, stored);
  if (!bytes) return null;
  try {
    return fromUtf8.decode(bytes);
  } catch {
    return null;
  } finally {
    bytes.fill(0);
  }
}

/** Drops the Secret Service entry a stored form points to (a record being deleted); other forms need nothing. */
export function forgetSealed(stored: unknown): void {
  forgetMarked(stored);
}

/** True for a value that should move into the Secret Service now: plain, for a purpose kept there, with a service answering. */
export function wantsServiceMove(purpose: SealPurpose, stored: string): boolean {
  return SERVICE_PURPOSES.includes(purpose) && !isMarker(stored) && !isSealedText(stored) && useSecretService();
}

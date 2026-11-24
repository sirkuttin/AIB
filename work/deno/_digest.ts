/**
 * A short fingerprint of a value, for answers too big to keep in a fixture (see _frozen.ts). assertEquals (_assert.ts) accepts a
 * FrozenDigest on either side and compares it with the fingerprint of the other value.
 */
import { createHash } from 'node:crypto';

let tmpRe: RegExp | null = null;
/** Matches the OS temp folder and the random name under it, in JSON text. */
function tempPattern(): RegExp {
  if (tmpRe) return tmpRe;
  const probe = Deno.makeTempDirSync({ prefix: 'digest-probe-' });
  Deno.removeSync(probe);
  const root = probe.replace(/[\\/][^\\/]+$/, '');
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // In JSON text a backslash is two, so a separator is two backslashes or a slash.
  const sep = String.raw`(?:\\\\|/)+`;
  tmpRe = new RegExp(root.split(/[\\/]+/).filter(Boolean).map(escape).join(sep) + sep + String.raw`([^\\/"]+)`, 'gi');
  return tmpRe;
}

/**
 * The OS temp folder of a path (and the random name under it) written as <TMP>, whatever the separator style; the random part of a
 * made-up folder name on its own (`studio-folders-9908069b5cb6beac`, 16 hex digits after a dash) is <R>.
 */
export const hideTemp = (jsonText: string): string => jsonText.replace(tempPattern(), '<TMP>').replace(/([A-Za-z0-9_]-)[0-9a-f]{16}(?![0-9A-Za-z])/g, '$1<R>');

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted((value as Record<string, unknown>)[k])]));
  }
  return value;
}

/** sha1 (8 hex characters) of the JSON of value, keys sorted, temp folders hidden; undefined and a missing value are null. */
export function digestOf(value: unknown): string {
  const plain = JSON.parse(JSON.stringify(value ?? null));
  return createHash('sha1').update(hideTemp(JSON.stringify(sorted(plain)))).digest('hex').slice(0, 8);
}

export class FrozenDigest {
  constructor(readonly hash: string) {}
  toJSON() {
    return { digest: this.hash };
  }
}

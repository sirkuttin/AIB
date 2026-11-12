// @ts-nocheck -- vendored third-party code written for an older TypeScript (see mod.ts); not type-checked here
// AIB: local stand-ins for jsr:@std/encoding (base64, base64url) and jsr:@std/bytes (concat, copy, equals), same behaviour.
function toBytes(data: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export function encodeBase64(data: ArrayBuffer | Uint8Array | string): string {
  const b = toBytes(data);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function encodeBase64Url(data: ArrayBuffer | Uint8Array | string): string {
  return encodeBase64(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return decodeBase64(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

export const bytes = {
  concat(list: Uint8Array[]): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(list.reduce((n, a) => n + a.length, 0));
    let at = 0;
    for (const a of list) {
      out.set(a, at);
      at += a.length;
    }
    return out;
  },
  copy(src: Uint8Array, dst: Uint8Array, off = 0): number {
    const n = Math.min(src.length, dst.length - off);
    dst.set(src.subarray(0, n), off);
    return n;
  },
  equals(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  },
};

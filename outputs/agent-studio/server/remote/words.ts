/**
 * Pairing words: a 6-byte one-time secret shown as six words (one word per byte), and the two check words both sides show.
 * The list is the same as the phone page's phone-words.js (remote_pairing_test.ts keeps them equal).
 */
import { createHash } from 'node:crypto';

// deno-fmt-ignore
export const WORDS: readonly string[] = [
  'amber', 'anchor', 'apple', 'april', 'arrow', 'atlas', 'autumn', 'badge', 'bakery', 'bamboo',
  'banjo', 'barrel', 'basket', 'beacon', 'berry', 'bison', 'blanket', 'blossom', 'bottle', 'breeze',
  'bridge', 'bronze', 'bubble', 'bucket', 'butter', 'cabin', 'cactus', 'camera', 'candle', 'canyon',
  'carbon', 'carpet', 'castle', 'cedar', 'cherry', 'chess', 'cider', 'circle', 'clover', 'cobalt',
  'coffee', 'comet', 'copper', 'coral', 'cotton', 'cradle', 'crayon', 'cricket', 'crystal', 'dancer',
  'delta', 'desert', 'dinner', 'dolphin', 'dragon', 'drum', 'eagle', 'echo', 'elbow', 'ember',
  'engine', 'falcon', 'feather', 'fern', 'fiddle', 'field', 'flame', 'forest', 'fossil', 'fox',
  'galaxy', 'garden', 'garlic', 'ginger', 'glacier', 'globe', 'goblet', 'granite', 'gravel', 'guitar',
  'hammer', 'harbor', 'harvest', 'hazel', 'helmet', 'hermit', 'honey', 'hornet', 'igloo', 'indigo',
  'island', 'ivory', 'jacket', 'jaguar', 'jasmine', 'jelly', 'jigsaw', 'jungle', 'kayak', 'kernel',
  'kettle', 'kitten', 'koala', 'ladder', 'lagoon', 'lantern', 'laptop', 'lemon', 'lily', 'linen',
  'lizard', 'lobster', 'locket', 'lotus', 'lunar', 'magnet', 'mango', 'maple', 'marble', 'meadow',
  'melon', 'meteor', 'mirror', 'mitten', 'monkey', 'mosaic', 'mustard', 'nectar', 'needle', 'nickel',
  'nine', 'noodle', 'nutmeg', 'oasis', 'ocean', 'olive', 'onion', 'opal', 'orbit', 'orchid',
  'otter', 'oyster', 'paddle', 'panda', 'paper', 'parrot', 'pebble', 'pepper', 'piano', 'pickle',
  'pigeon', 'pillow', 'pilot', 'planet', 'plum', 'pocket', 'polar', 'pony', 'poppy', 'potato',
  'prism', 'pumpkin', 'puzzle', 'quartz', 'quill', 'rabbit', 'radar', 'radish', 'raven', 'ribbon',
  'river', 'robin', 'rocket', 'ruby', 'saddle', 'salmon', 'satin', 'scarf', 'shadow', 'shell',
  'silver', 'sketch', 'sled', 'slipper', 'socket', 'sofa', 'spider', 'spoon', 'spruce', 'squid',
  'stamp', 'star', 'stone', 'storm', 'sugar', 'summer', 'sunset', 'swan', 'tablet', 'tango',
  'teapot', 'tennis', 'thistle', 'thunder', 'tiger', 'timber', 'toast', 'tomato', 'topaz', 'torch',
  'tractor', 'tulip', 'tundra', 'turtle', 'umbrella', 'valley', 'velvet', 'violet', 'violin', 'volcano',
  'wagon', 'walnut', 'walrus', 'waffle', 'wheat', 'whistle', 'willow', 'window', 'winter', 'wizard',
  'wolf', 'yarn', 'yogurt', 'zebra', 'zipper', 'acorn', 'badger', 'beaver', 'canoe', 'cloud',
  'daisy', 'dune', 'easel', 'fable', 'fig', 'frost', 'geyser', 'hawk', 'iris', 'jade',
  'kiwi', 'lark', 'lime', 'moss', 'nest', 'oak',
];

export const SECRET_BYTES = 6;
const INDEX = new Map(WORDS.map((w, i) => [w, i]));

export function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(text: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(text)) return null;
  return new Uint8Array(text.match(/../g)!.map((h) => parseInt(h, 16)));
}

export function secretWords(secret: Uint8Array): string[] {
  return [...secret].map((b) => WORDS[b]);
}

/**
 * What the phone sends as the code: the 12 hex characters from the QR (after '#p=') or the six words as typed (any case, any
 * spaces or punctuation between them). Null when it is neither.
 */
export function parseCode(code: unknown): Uint8Array | null {
  if (typeof code !== 'string' || code.length > 200) return null;
  const text = code.trim().toLowerCase();
  if (/^[0-9a-f]{12}$/.test(text)) return fromHex(text);
  const words = text.split(/[^a-z]+/).filter(Boolean);
  if (words.length !== SECRET_BYTES) return null;
  const bytes = words.map((w) => INDEX.get(w));
  return bytes.every((b) => b !== undefined) ? new Uint8Array(bytes as number[]) : null;
}

/** Constant-time comparison of two byte strings. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * The two check words: SHA-256 over a label, the pairing secret, the phone's nonce and the PC's nonce (hex text, as the phone page
 * sends and receives them), first two bytes as words. The phone page computes the same with WebCrypto (phone.js checkWords).
 */
export function checkWords(secret: Uint8Array, phoneNonce: string, pcNonce: string): [string, string] {
  const digest = createHash('sha256').update(`aib-pair-check|${hex(secret)}|${phoneNonce}|${pcNonce}`).digest();
  return [WORDS[digest[0]], WORDS[digest[1]]];
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A random secret as URL-safe base64 (32 bytes: a device token or cookie). */
export function randomToken(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

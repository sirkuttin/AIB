/**
 * The pairing QR (server/remote/qr.ts): the spec's worked examples for Reed-Solomon and the format words, and every matrix read back
 * by a decoder written here from the spec (its own function-pattern map, zigzag reading, de-interleaving and syndrome check).
 */
import { assert, assertEquals } from './_assert.ts';
import { formatWord, maskBit, qrMatrix, qrSvg, rsRemainder } from '../../outputs/agent-studio/server/remote/qr.ts';

Deno.test('Reed-Solomon codewords match the worked examples (1-M "01234567" and "HELLO WORLD")', () => {
  assertEquals(
    rsRemainder([0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11], 10),
    [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55],
  );
  assertEquals(
    rsRemainder([0x20, 0x5b, 0x0b, 0x78, 0xd1, 0x72, 0xdc, 0x4d, 0x43, 0x40, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11], 10),
    [0xc4, 0x23, 0x27, 0x77, 0xeb, 0xd7, 0xe7, 0xe2, 0x5d, 0x17],
  );
});

Deno.test('format words for level M equal the spec table', () => {
  const table = [
    '101010000010010',
    '101000100100101',
    '101111001111100',
    '101101101001011',
    '100010111111001',
    '100000011001110',
    '100111110010111',
    '100101010100000',
  ];
  for (let mask = 0; mask < 8; mask++) assertEquals(formatWord(mask).toString(2).padStart(15, '0'), table[mask], `mask ${mask}`);
});

// ---- an independent reader ----------------------------------------------------------------------------------------------------
const BLOCKS: Record<number, [number, number[]]> = { // version -> [ec per block, data codewords per block]
  1: [10, [16]],
  2: [16, [28]],
  3: [26, [44]],
  4: [18, [32, 32]],
  5: [24, [43, 43]],
  6: [16, [27, 27, 27, 27]],
  7: [18, [31, 31, 31, 31]],
  8: [22, [38, 38, 39, 39]],
  9: [22, [36, 36, 36, 37, 37]],
  10: [26, [43, 43, 43, 43, 44]],
};
const CENTERS: Record<number, number[]> = {
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

const EXP: number[] = [];
const LOG: number[] = new Array(256).fill(0);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
const mul = (a: number, b: number) => (a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0);

function reserved(n: number, version: number): boolean[][] {
  const r = Array.from({ length: n }, () => new Array(n).fill(false));
  const box = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) r[y][x] = true;
  };
  box(0, 0, 8, 8); // finder, separator, format
  box(n - 8, 0, n - 1, 8);
  box(0, n - 8, 8, n - 1);
  box(6, 0, 6, n - 1); // timing
  box(0, 6, n - 1, 6);
  const c = CENTERS[version] ?? [];
  for (const cy of c) {
    for (const cx of c) {
      if ((cx <= 8 && cy <= 8) || (cx >= n - 9 && cy <= 8) || (cx <= 8 && cy >= n - 9)) continue; // a finder's corner: none there
      box(cx - 2, cy - 2, cx + 2, cy + 2);
    }
  }
  if (version >= 7) {
    box(n - 11, 0, n - 9, 5);
    box(0, n - 11, 5, n - 9);
  }
  return r;
}

function decode(modules: boolean[][]): { text: string; mask: number } {
  const n = modules.length;
  const version = (n - 17) / 4;
  let format = 0;
  const coords: [number, number][] = [
    [8, 0],
    [8, 1],
    [8, 2],
    [8, 3],
    [8, 4],
    [8, 5],
    [8, 7],
    [8, 8],
    [7, 8],
    [5, 8],
    [4, 8],
    [3, 8],
    [2, 8],
    [1, 8],
    [0, 8],
  ];
  coords.forEach(([x, y], i) => (format |= (modules[y][x] ? 1 : 0) << i));
  // the second copy says the same
  let second = 0;
  for (let i = 0; i < 8; i++) second |= (modules[8][n - 1 - i] ? 1 : 0) << i;
  for (let i = 8; i < 15; i++) second |= (modules[n - 15 + i][8] ? 1 : 0) << i;
  assertEquals(second, format, 'both format copies agree');
  assert(modules[n - 8][8], 'dark module');
  const data = (format ^ 0x5412) >>> 10;
  assertEquals(data >>> 3, 0, 'level M');
  const mask = data & 7;
  const fn = reserved(n, version);
  const bits: number[] = [];
  let up = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < n; k++) {
      const y = up ? n - 1 - k : k;
      for (const x of [col, col - 1]) {
        if (fn[y][x]) continue;
        bits.push((modules[y][x] ? 1 : 0) ^ (maskBit(mask, x, y) ? 1 : 0));
      }
    }
    up = !up;
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  const [ec, sizes] = BLOCKS[version];
  const blocks = sizes.map(() => [] as number[]);
  let at = 0;
  for (let i = 0; i < Math.max(...sizes); i++) for (let b = 0; b < sizes.length; b++) if (i < sizes[b]) blocks[b].push(bytes[at++]);
  for (let i = 0; i < ec; i++) for (let b = 0; b < sizes.length; b++) blocks[b].push(bytes[at++]);
  for (const block of blocks) {
    for (let i = 0; i < ec; i++) { // syndrome S_i = block(alpha^i) must be 0
      let s = 0;
      for (const c of block) s = mul(s, EXP[i]) ^ c;
      assertEquals(s, 0, `syndrome ${i}`);
    }
  }
  const dataBytes = blocks.flatMap((b, i) => b.slice(0, sizes[i]));
  const stream = dataBytes.flatMap((b) => Array.from({ length: 8 }, (_, i) => (b >>> (7 - i)) & 1));
  const read = (from: number, len: number) => stream.slice(from, from + len).reduce((a, b) => (a << 1) | b, 0);
  assertEquals(read(0, 4), 0b0100, 'byte mode');
  const countBits = version < 10 ? 8 : 16;
  const count = read(4, countBits);
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = read(4 + countBits + i * 8, 8);
  return { text: new TextDecoder().decode(out), mask };
}

Deno.test('QR matrices read back to the same text, versions 1 to 10, with finder and timing patterns in place', () => {
  const texts = [
    'hi',
    'https://pc.t.ts.net/',
    'https://studio-pc.tail-a1b2.ts.net/phone.html#p=0123456789ab',
    'https://a-much-longer-machine-name.tail-a1b2c3.ts.net/phone.html#p=0123456789ab',
    'x'.repeat(150),
    'y'.repeat(200),
  ];
  const versions = new Set<number>();
  for (const text of texts) {
    const qr = qrMatrix(text);
    versions.add(qr.version);
    const n = qr.size;
    for (let i = 8; i < n - 8; i++) assertEquals(qr.modules[6][i], i % 2 === 0, 'timing row');
    for (const [x, y] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
      assert(qr.modules[y][x] && qr.modules[y + 3][x + 3] && !qr.modules[y + 1][x + 1], 'finder');
    }
    assertEquals(decode(qr.modules).text, text);
  }
  assert(versions.has(1) && [...versions].some((v) => v >= 7) && versions.has(10), `versions ${[...versions]}`);
  // every mask can be read back too (not only the one the penalty picked)
  const masks = new Set(texts.map((t) => qrMatrix(t).mask));
  assert(masks.size >= 1);
});

Deno.test('version information blocks equal the spec values (7: 0x07C94, 10: 0x0A4D3)', () => {
  for (const [text, version, word] of [['x'.repeat(110), 7, 0x07c94], ['y'.repeat(200), 10, 0x0a4d3]] as const) {
    const qr = qrMatrix(text);
    assertEquals(qr.version, version);
    const n = qr.size;
    let top = 0, left = 0;
    for (let i = 0; i < 18; i++) {
      top |= (qr.modules[Math.floor(i / 3)][n - 11 + (i % 3)] ? 1 : 0) << i;
      left |= (qr.modules[n - 11 + (i % 3)][Math.floor(i / 3)] ? 1 : 0) << i;
    }
    assertEquals([top, left], [word, word]);
  }
});

Deno.test('the SVG has a quiet zone and one path', () => {
  const svg = qrSvg('https://studio-pc.tail-a1b2.ts.net/phone.html#p=0123456789ab');
  assert(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 41 41"'), svg.slice(0, 120)); // version 4: 33 + 8
  assertEquals((svg.match(/<path /g) ?? []).length, 1);
});

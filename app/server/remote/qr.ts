/**
 * A small QR code encoder for the pairing QR (ISO/IEC 18004): byte mode, error correction level M, versions 1 to 10 (up to 213
 * bytes, enough for https://<pc>.<tailnet>.ts.net/phone.html#p=<secret>). Follows the structure of Project Nayuki's reference
 * encoder (MIT). The QR is drawn as SVG by the server, so the page needs no library. work/deno/remote_qr_test.ts reads the matrix
 * back with its own decoder and checks the spec's worked example.
 */

/** Level M per version: [error correction codewords per block, blocks in group 1, data codewords per group-1 block, blocks in group 2]
 * (a group-2 block has one data codeword more). */
const M_BLOCKS: Record<number, [number, number, number, number]> = {
  1: [10, 1, 16, 0],
  2: [16, 1, 28, 0],
  3: [26, 1, 44, 0],
  4: [18, 2, 32, 0],
  5: [24, 2, 43, 0],
  6: [16, 4, 27, 0],
  7: [18, 4, 31, 0],
  8: [22, 2, 38, 2],
  9: [22, 3, 36, 2],
  10: [26, 4, 43, 1],
};
export const ALIGNMENT: Record<number, number[]> = {
  1: [],
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
export const MAX_VERSION = 10;

export function dataCodewords(version: number): number {
  const [, g1, d1, g2] = M_BLOCKS[version];
  return g1 * d1 + g2 * (d1 + 1);
}

// ---- GF(256) and Reed-Solomon ------------------------------------------------------------------------------------------------
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/** The error correction codewords of one block. */
export function rsRemainder(data: number[], degree: number): number[] {
  const divisor = rsDivisor(degree);
  const result = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => (result[i] ^= gfMul(coef, factor)));
  }
  return result;
}

// ---- encoding -------------------------------------------------------------------------------------------------------------------
/** The data codewords for `bytes` at `version` (mode, count, data, terminator, padding). */
export function encodeData(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = dataCodewords(version) * 8;
  if (bits.length > capacity) throw new RangeError('too long for this version');
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return out;
}

/** Split into blocks, add error correction, interleave. */
export function interleave(data: number[], version: number): number[] {
  const [ec, g1, d1, g2] = M_BLOCKS[version];
  const blocks: number[][] = [];
  let at = 0;
  for (let i = 0; i < g1 + g2; i++) {
    const length = i < g1 ? d1 : d1 + 1;
    blocks.push(data.slice(at, at + length));
    at += length;
  }
  const ecc = blocks.map((b) => rsRemainder(b, ec));
  const out: number[] = [];
  for (let i = 0; i <= d1; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ec; i++) for (const e of ecc) out.push(e[i]);
  return out;
}

export interface QrMatrix {
  size: number;
  version: number;
  mask: number;
  /** modules[y][x]: true = dark. */
  modules: boolean[][];
}

class Builder {
  readonly size: number;
  readonly modules: boolean[][];
  readonly fn: boolean[][];
  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.fn = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }
  set(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.fn[y][x] = true;
  }
  functionPatterns(): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= n || y >= n) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          this.set(x, y, d !== 2 && d !== 4);
        }
      }
    }
    const pos = ALIGNMENT[this.version];
    const last = pos.length - 1;
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) this.set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
    this.formatBits(0); // reserves the format areas; drawn again with the chosen mask
    if (this.version >= 7) {
      let rem = this.version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (this.version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = ((bits >>> i) & 1) === 1;
        const a = n - 11 + (i % 3), b = Math.floor(i / 3);
        this.set(a, b, bit);
        this.set(b, a, bit);
      }
    }
  }
  formatBits(mask: number): void {
    const bits = formatWord(mask);
    const bit = (i: number) => ((bits >>> i) & 1) === 1;
    const n = this.size;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, n - 15 + i, bit(i));
    this.set(8, n - 8, true); // the dark module
  }
  place(codewords: number[]): void {
    const n = this.size;
    let i = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? n - 1 - vert : vert;
          if (this.fn[y][x]) continue;
          if (i < codewords.length * 8) this.modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) if (!this.fn[y][x] && maskBit(mask, x, y)) this.modules[y][x] = !this.modules[y][x];
    }
  }
}

/** The 15-bit format word for level M and a mask (BCH code, then XOR 0x5412). */
export function formatWord(mask: number): number {
  const data = (0 << 3) | mask; // level M = 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

export function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/** The usual penalty score (rules N1 to N4); the mask with the lowest wins. */
function penalty(m: boolean[][]): number {
  const n = m.length;
  let score = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && get(i) === get(i - 1)) run++;
      else {
        if (run >= 5) score += 3 + run - 5;
        run = 1;
      }
    }
    for (let i = 0; i + 11 <= n; i++) {
      const s = Array.from({ length: 11 }, (_, k) => (get(i + k) ? '1' : '0')).join('');
      if (s === '10111010000' || s === '00001011101') score += 40;
    }
  };
  for (let y = 0; y < n; y++) line((x) => m[y][x]);
  for (let x = 0; x < n; x++) line((y) => m[y][x]);
  for (let y = 0; y + 1 < n; y++) {
    for (let x = 0; x + 1 < n; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
    }
  }
  const dark = m.flat().filter(Boolean).length;
  const total = n * n;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** The QR matrix for `text` (UTF-8): the smallest version that holds it, the mask with the lowest penalty. */
export function qrMatrix(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (version <= MAX_VERSION && 4 + (version < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(version) * 8) version++;
  if (version > MAX_VERSION) throw new RangeError('Text too long for the pairing QR');
  const codewords = interleave(encodeData(bytes, version), version);
  let best: QrMatrix | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const b = new Builder(version);
    b.functionPatterns();
    b.place(codewords);
    b.applyMask(mask);
    b.formatBits(mask);
    const score = penalty(b.modules);
    if (score < bestScore) {
      bestScore = score;
      best = { size: b.size, version, mask, modules: b.modules };
    }
  }
  return best!;
}

/** The QR as an SVG image: black modules on white with a 4-module quiet zone. */
export function qrSvg(text: string): string {
  const { size, modules } = qrMatrix(text);
  const full = size + 8;
  let path = '';
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y][x]) path += `M${x + 4} ${y + 4}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges">` +
    `<rect width="${full}" height="${full}" fill="#fff"/><path fill="#000" d="${path}"/></svg>`;
}

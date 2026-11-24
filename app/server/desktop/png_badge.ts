/**
 * The tray's attention variant ("a chat needs you"): the normal tray PNG with an amber dot in its lower right corner, made at run
 * time so no second set of icon files has to be kept in step with tools/make_icons.ts. Reads the 8-bit RGBA, non-interlaced PNGs
 * that make_icons writes (any filter type); anything else is returned unchanged.
 */

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** RGBA pixels of an 8-bit RGBA PNG, or null when it is another kind. */
export async function decodeRgba(png: Uint8Array): Promise<{ width: number; height: number; pixels: Uint8Array } | null> {
  if (png.length < 33 || SIGNATURE.some((b, i) => png[i] !== b)) return null;
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0, height = 0;
  const idat: Uint8Array[] = [];
  for (let p = 8; p + 8 <= png.length;) {
    const length = v.getUint32(p);
    const type = String.fromCharCode(...png.subarray(p + 4, p + 8));
    const data = png.subarray(p + 8, p + 8 + length);
    if (type === 'IHDR') {
      width = v.getUint32(p + 8);
      height = v.getUint32(p + 12);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) return null; // 8-bit, RGBA, not interlaced
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + length;
  }
  if (!width || !height || !idat.length) return null;
  const joined = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
  let o = 0;
  for (const d of idat) joined.set(d, (o += d.length) - d.length);
  const raw = await inflate(joined);
  const stride = width * 4;
  if (raw.length < height * (stride + 1)) return null;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0;
      const value = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : -1;
      if (value < 0) return null;
      pixels[y * stride + x] = (line[x] + value) & 0xff;
    }
  }
  return { width, height, pixels };
}

/** An 8-bit RGBA PNG of these pixels (filter 0 on every line). */
export async function encodeRgba(width: number, height: number, pixels: Uint8Array): Promise<Uint8Array> {
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array(SIGNATURE), chunk('IHDR', ihdr), chunk('IDAT', await deflate(raw)), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
}

/** The PNG with an amber dot (#F59E0B, dark rim) over its lower right corner; the input unchanged when it can't be read. */
export async function withAttentionDot(png: Uint8Array): Promise<Uint8Array> {
  const image = await decodeRgba(png);
  if (!image) return png;
  const { width, height, pixels } = image;
  const r = Math.max(3, Math.round(width * 0.28));
  const cx = width - r - 0.5, cy = height - r - 0.5;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x + 0.5 - (cx + 0.5), y + 0.5 - (cy + 0.5));
      if (d > r + 0.5) continue;
      const i = (y * width + x) * 4;
      const rim = d > r - 1;
      pixels.set(rim ? [0x1f, 0x29, 0x37, 255] : [0xf5, 0x9e, 0x0b, 255], i);
    }
  }
  return await encodeRgba(width, height, pixels);
}

/**
 * Writes every icon file the app and the packages use from the masters in outputs/agent-studio/icons/src/. Re-run it after changing
 * the art, then commit what it wrote (the build only reads these files, it never renders):
 *
 *   deno run -A --node-modules-dir=none --no-lock tools/make_icons.ts   (the root package.json would make deno look in node_modules)
 *
 * The art (option C of the small-sizes icon round): no tile, a solid black top hat with a 1 px teal rim (#2BB3A3) so it holds its
 * edge on a dark taskbar, and the two agent squares (amber, coral) on the crown. Two kinds of master:
 *   icon-16.txt .. icon-32.txt   hand-drawn pixel grids for 16 20 24 32 px, one character per pixel (PIXEL below). The small sizes
 *                                are drawn on the pixel grid, not shrunk from the vector, so no edge smears over two pixels.
 *   icon.svg                     the vector, viewBox 0 0 100 100, for 40 px and up and the favicon.
 *
 *   icons/icon.ico                     Windows (build.ts embeds it in AIB.exe): 16 20 24 32 from the grids, 40 48 64 128 256 from
 *                                      icon.svg; every image a 32-bit RGBA PNG, see-through outside the hat
 *   icons/32x32.png                    the 32 px grid (macOS .icns ic11)
 *   icons/128x128.png, 128x128@2x.png  icon.svg at 128 and 256 (.icns ic07, ic08)
 *   icons/icon.png                     icon.svg at 512 (.icns ic09; the Linux AppImage/.deb icon, .DirIcon)
 *   server/desktop/tray_icon_data.ts   the tray PNGs: the 16 20 24 32 px grids (the colour icon on every taskbar)
 *   chat.html                          <link rel="icon">: icon.svg as a data: URL
 *   icons/phone-*.png                  the phone page's install icons (PHONE below, served on the phone port only): 192 px plain,
 *                                      maskable 192 and 512 (the mark inside the 80 % safe zone on the brand teal, so Android's
 *                                      circle or squircle crop never cuts it), the 180 px Home Screen icon for iPhone (opaque), and
 *                                      the 96 px notification badge (a white silhouette on see-through: Android draws only its alpha)
 *
 *   deno run -A --node-modules-dir=none --no-lock tools/make_icons.ts --phone   writes only the phone icons
 *
 * The vector renderer is resvg compiled to WebAssembly (npm:@resvg/resvg-wasm, the exact version below), fetched by deno: no global
 * install, no native tool. The masters have no text, so no fonts are loaded.
 */
import { crc32, decodePng, makeIco, pngSize } from './build.ts';

const RESVG = 'npm:@resvg/resvg-wasm@2.6.2';
const HERE = decodeURIComponent(new URL('.', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '');
const APP = `${HERE.replace(/\/tools$/, '')}/outputs/agent-studio`;
export const ICON_SRC = `${APP}/icons/src`;

/** The pixel-grid sizes (icon-<size>.txt). */
export const GRID_SIZES = [16, 20, 24, 32];
/** The grid characters: '.' see-through, the rest opaque colours. */
export const PIXEL: Record<string, [number, number, number, number]> = {
  '.': [0, 0, 0, 0],
  K: [0x16, 0x15, 0x1b, 255], // the hat
  T: [0x2b, 0xb3, 0xa3, 255], // the teal rim
  A: [0xff, 0xc2, 0x47, 255], // amber agent
  C: [0xff, 0x7a, 0x59, 255], // coral agent
};
export const RIM: [number, number, number] = [0x2b, 0xb3, 0xa3];
export const HAT: [number, number, number] = [0x16, 0x15, 0x1b];

/** The .ico's images, smallest first: the hand-drawn grids up to 32 px, the vector from 40. */
export const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
export const icoMaster = (size: number) => GRID_SIZES.includes(size) ? `icon-${size}.txt` : 'icon.svg';
/** The PNGs next to the .ico: [file, master, size]. */
export const PNGS: [string, string, number][] = [
  ['32x32.png', 'icon-32.txt', 32],
  ['128x128.png', 'icon.svg', 128],
  ['128x128@2x.png', 'icon.svg', 256],
  ['icon.png', 'icon.svg', 512],
];
/** The tray images in tray_icon_data.ts: [key, master, size], one per grid so Windows never scales the 1 px rim away. */
export const TRAY: [string, string, number][] = GRID_SIZES.map((size) => [`color-${size}`, `icon-${size}.txt`, size]);
/** The pages that get the favicon. */
export const FAVICON_PAGES = ['chat.html'];

/** The favicon <link>: the SVG as a data: URL (the page's CSP allows data: images; no extra file to serve or stage). */
export function faviconLink(svg: string): string {
  const data = svg.trim().replaceAll('"', "'").replace(/[#<>%\n]/g, (c) => encodeURIComponent(c));
  return `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${data}">`;
}

/** The page with its favicon link set: an existing one replaced, else added right after </title>. */
export function withFavicon(html: string, link: string): string {
  if (/<link rel="icon"[^>]*>/.test(html)) return html.replace(/<link rel="icon"[^>]*>/, link);
  if (!html.includes('</title>')) throw new Error('the page has no </title> to put the favicon after');
  return html.replace('</title>', `</title>${link}`);
}

export function trayDataModule(images: [string, Uint8Array][]): string {
  const b64 = (d: Uint8Array) => btoa(Array.from(d, (b) => String.fromCharCode(b)).join(''));
  return [
    '// Generated by tools/make_icons.ts from outputs/agent-studio/icons/src/: do not edit, re-run the script.',
    '/** The tray icon PNGs, base64: the hand-drawn app icon grids (icon-16.txt .. icon-32.txt) at 16 20 24 32 px. */',
    'export const TRAY_PNG_BASE64: Record<string, string> = {',
    ...images.map(([key, png]) => `  '${key}': '${b64(png)}',`),
    '};',
    '',
  ].join('\n');
}

/** A grid master's RGBA pixels: size rows of size characters from PIXEL (blank lines and trailing spaces ignored). */
export function parseGrid(text: string, size: number): Uint8Array {
  const rows = text.split(/\r?\n/).map((r) => r.trimEnd()).filter((r) => r);
  if (rows.length !== size || rows.some((r) => r.length !== size)) throw new Error(`the ${size} px grid is not ${size} by ${size}`);
  const rgba = new Uint8Array(size * size * 4);
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const px = PIXEL[ch];
      if (!px) throw new Error(`the ${size} px grid has an unknown pixel '${ch}' at ${x},${y}`);
      rgba.set(px, (y * size + x) * 4);
    })
  );
  return rgba;
}

/** An 8-bit RGBA PNG of the pixels (filter 0 on every row: what decodePng and png_badge.ts read). */
export async function encodePng(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
  const idat = new Uint8Array(await new Response(stream).arrayBuffer());
  const chunk = (kind: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    out.set([...kind].map((c) => c.charCodeAt(0)), 4);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, deflate, adaptive filtering, no interlace
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array())];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    png.set(p, at);
    at += p.length;
  }
  return png;
}

/** The phone icons' tile colour: the rim's teal (the black hat and both agent squares read on it). */
export const PHONE_TILE = '#2BB3A3';
/** The vector's drawing, without its <svg> wrapper. */
export const svgInner = (svg: string): string => svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>'));
/** The mark at `scale` of the tile, centred, on an opaque tile (maskable and iPhone icons). At 0.6 the mark's corners stay inside
 * the maskable safe zone (a circle of 80 % of the size). */
export function tileSvg(svg: string, scale: number, tile = PHONE_TILE): string {
  const at = ((100 - 100 * scale) / 2).toFixed(2);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><rect width="100" height="100" fill="${tile}"/>` +
    `<g transform="translate(${at} ${at}) scale(${scale})">${svgInner(svg)}</g></svg>`;
}
/** The notification badge: the hat (crown, brim and rim) in white, the two agent squares and the line between them cut out. Drawn
 * from icon.svg's shapes (update it with the art). */
export function badgeSvg(): string {
  const place = 'translate(9 9) scale(0.82) translate(3.5 3.5) scale(0.93)';
  const hat = 'M22 76 L24.5 11 Q50 3 75.5 11 L78 76 Z';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><defs>` +
    `<mask id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"><rect width="100" height="100" fill="#fff"/>` +
    `<g transform="${place}"><path d="M40.5 28 L59.5 53" stroke="#000" stroke-width="5" stroke-linecap="round"/>` +
    `<rect x="31" y="19" width="18" height="18" rx="1.5" fill="#000"/><rect x="51" y="44" width="18" height="18" rx="1.5" fill="#000"/></g>` +
    `</mask></defs><g mask="url(#cut)"><g transform="${place}" fill="#fff" stroke="#fff" stroke-width="7.527" stroke-linejoin="round">` +
    `<path d="${hat}"/><rect x="0" y="72" width="100" height="20" rx="10"/></g></g></svg>`;
}
/** The phone page's icons: [file in icons/, size, which art]. */
export const PHONE: [string, number, 'plain' | 'maskable' | 'apple' | 'badge'][] = [
  ['phone-192.png', 192, 'plain'],
  ['phone-maskable-192.png', 192, 'maskable'],
  ['phone-maskable-512.png', 512, 'maskable'],
  ['phone-apple-180.png', 180, 'apple'],
  ['phone-badge-96.png', 96, 'badge'],
];
export function phoneSvg(vector: string, kind: 'plain' | 'maskable' | 'apple' | 'badge'): string {
  if (kind === 'maskable') return tileSvg(vector, 0.6);
  if (kind === 'apple') return tileSvg(vector, 0.74);
  if (kind === 'badge') return badgeSvg();
  return vector;
}

async function writePhoneIcons(render: (svg: string, size: number) => Uint8Array, vector: string): Promise<void> {
  for (const [file, size, kind] of PHONE) await Deno.writeFile(`${APP}/icons/${file}`, render(phoneSvg(vector, kind), size));
}

async function renderer(): Promise<(svg: string, size: number) => Uint8Array> {
  const { initWasm, Resvg } = await import(RESVG);
  await initWasm(await Deno.readFile(new URL(import.meta.resolve(`${RESVG}/index_bg.wasm`))));
  return (svg, size) => {
    const png: Uint8Array = new Resvg(svg, { fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: false } }).render().asPng();
    const got = pngSize(png);
    if (got.width !== size || got.height !== size) throw new Error(`rendered ${got.width}x${got.height}, wanted ${size}`);
    return png;
  };
}

/** Is any pixel of the PNG near this colour (each channel within 8)? */
export async function hasColour(png: Uint8Array, rgb: [number, number, number]): Promise<boolean> {
  const { rgba } = await decodePng(png);
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] > 200 && rgb.every((c, k) => Math.abs(rgba[i + k] - c) <= 8)) return true;
  }
  return false;
}

async function main() {
  const render = await renderer();
  const vector = await Deno.readTextFile(`${ICON_SRC}/icon.svg`);
  await writePhoneIcons(render, vector);
  if (Deno.args.includes('--phone')) {
    console.log(`phone icons written: ${PHONE.map((p) => p[0]).join(', ')}`);
    return;
  }
  const grids: Record<string, Uint8Array> = {};
  for (const size of GRID_SIZES) {
    grids[`icon-${size}.txt`] = await encodePng(size, size, parseGrid(await Deno.readTextFile(`${ICON_SRC}/icon-${size}.txt`), size));
  }
  const image = (master: string, size: number) => master === 'icon.svg' ? render(vector, size) : grids[master];
  const ico = ICO_SIZES.map((size) => image(icoMaster(size), size));
  for (const png of [ico[0], ico[ico.length - 1]]) {
    if (!(await hasColour(png, RIM)) || !(await hasColour(png, HAT))) throw new Error('an icon image has no teal rim or no black hat');
  }
  await Deno.writeFile(`${APP}/icons/icon.ico`, makeIco(ico));
  for (const [file, master, size] of PNGS) await Deno.writeFile(`${APP}/icons/${file}`, image(master, size));
  const tray = TRAY.map(([key, master, size]): [string, Uint8Array] => [key, image(master, size)]);
  await Deno.writeTextFile(`${APP}/server/desktop/tray_icon_data.ts`, trayDataModule(tray));
  const link = faviconLink(vector);
  for (const page of FAVICON_PAGES) {
    const path = `${APP}/${page}`;
    await Deno.writeTextFile(path, withFavicon(await Deno.readTextFile(path), link));
  }
  console.log(`icons written: icon.ico (${ICO_SIZES.join(' ')}), ${PNGS.map((p) => p[0]).join(', ')}, tray_icon_data.ts, favicon`);
}

if (import.meta.main) await main();

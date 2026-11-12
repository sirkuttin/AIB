/** server/desktop/tray_icon.ts: the tray gets the colour app icon (black hat, teal rim, no tile) on every platform and theme, at the size the scale asks for. */
import { assert, assertEquals } from './_assert.ts';
import {
  chooseTraySize,
  TRAY_SIZES,
  trayIconBytes,
  trayIconPng,
  windowsSmallIconPx,
} from '../../outputs/agent-studio/server/desktop/tray_icon.ts';
import { iconFromPng, iconPixels } from '../../outputs/agent-studio/server/desktop/window_icon_win.ts';
import { withAttentionDot } from '../../outputs/agent-studio/server/desktop/png_badge.ts';
import { decodePng, pngSize } from '../../tools/build.ts';

const WINDOWS = Deno.build.os === 'windows';
const HAT: [number, number, number] = [0x16, 0x15, 0x1b];
const RIM: [number, number, number] = [0x2b, 0xb3, 0xa3];
const near = (rgba: Uint8Array, i: number, rgb: [number, number, number], tol = 10) =>
  rgb.every((c, k) => Math.abs(rgba[i + k] - c) <= tol);
/** How many opaque pixels are this colour. */
const count = (rgba: Uint8Array, rgb: [number, number, number]) => {
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 3] > 200 && near(rgba, i, rgb)) n++;
  return n;
};

Deno.test('chooseTraySize: Windows the hand-drawn size at the small icon size (next bigger, else 32); macOS and Linux 32', () => {
  assertEquals(chooseTraySize('windows', 16), 16);
  assertEquals(chooseTraySize('windows', 20), 20);
  assertEquals(chooseTraySize('windows', 24), 24);
  assertEquals(chooseTraySize('windows', 32), 32);
  assertEquals(chooseTraySize('windows', 18), 20);
  assertEquals(chooseTraySize('windows', 28), 32);
  assertEquals(chooseTraySize('windows', 40), 32);
  assertEquals(chooseTraySize('windows', 0), 32);
  for (const os of ['darwin', 'linux'] as const) {
    assertEquals(chooseTraySize(os, 16), 32);
    assertEquals(chooseTraySize(os, 0), 32);
  }
});

Deno.test('trayIconBytes: the colour app icon (black hat, teal rim, amber and coral squares, no tile) at 16 20 24 32; trayIconPng is one of them', async () => {
  for (const size of TRAY_SIZES) {
    const png = trayIconBytes(size);
    assertEquals(pngSize(png), { width: size, height: size });
    const { rgba } = await decodePng(png);
    assert(count(rgba, HAT) > size * size * 0.3, `${size} px: mostly the black hat`);
    assert(count(rgba, RIM) >= size * 2, `${size} px: a teal rim round the hat`);
    // No tile: the corners are see-through, the middle of the crown is the hat.
    assertEquals(rgba[3], 0, `${size} px: see-through top left corner`);
    const mid = ((size >> 1) * size + (size >> 1) - 1) * 4;
    assert(rgba[mid + 3] === 255 && near(rgba, mid, HAT), `${size} px: the hat in the middle`);
  }
  const big = (await decodePng(trayIconBytes(32))).rgba;
  const has = (rgb: [number, number, number]) => Array.from({ length: big.length / 4 }, (_, i) => i * 4).some((i) => near(big, i, rgb, 12));
  assert(has([0xff, 0xc2, 0x47]) && has([0xff, 0x7a, 0x59]), 'the two coloured squares');
  assertEquals([...trayIconPng()], [...trayIconBytes(chooseTraySize(Deno.build.os, windowsSmallIconPx()))]);
});

Deno.test('the attention variant is the colour icon with the amber dot over its lower right corner', async () => {
  const png = trayIconBytes(32);
  const dotted = (await decodePng(await withAttentionDot(png))).rgba;
  const plain = (await decodePng(png)).rgba;
  const at = (x: number, y: number) => (y * 32 + x) * 4;
  assert(near(dotted, at(23, 23), [0xf5, 0x9e, 0x0b], 2), 'amber in the dot');
  assert(near(dotted, at(10, 21), HAT) && near(plain, at(10, 21), HAT), 'the hat elsewhere is unchanged');
  assert(near(dotted, at(7, 10), RIM) && near(plain, at(7, 10), RIM), 'the rim elsewhere is unchanged');
});

Deno.test({
  name: "Windows: the tray worker's icon (CreateIconFromResourceEx at SM_CXSMICON) is the hand-drawn image, unscaled: black hat, teal rim",
  ignore: !WINDOWS,
  fn: async () => {
    const px = windowsSmallIconPx();
    assert(px >= 16 && px <= 64, `SM_CXSMICON ${px}`);
    // The image the tray picks for this machine, made at SM_CXSMICON as tray_win_worker.ts does with start.icon.
    const size = chooseTraySize('windows', px);
    const h = iconFromPng(trayIconBytes(size), px, px);
    assert(h !== 0n, `${size}: no icon`);
    const p = iconPixels(h)!;
    assertEquals([p.width, p.height], [px, px]);
    assert(count(p.rgba, HAT) > px * px * 0.25, `${size} px PNG: the icon is mostly the black hat`);
    assert(count(p.rgba, RIM) > px, `${size} px PNG: the teal rim`);
    if ((TRAY_SIZES as number[]).includes(px)) {
      assertEquals(size, px);
      assertEquals([...p.rgba], [...(await decodePng(trayIconBytes(size))).rgba], 'pixel for pixel, not scaled');
    }
  },
});

/** server/desktop/tray_icon.ts: the tray gets the colour app icon on every platform and theme, at the size the scale asks for. */
import { assert, assertEquals } from './_assert.ts';
import { chooseTraySize, trayIconBytes, trayIconPng, windowsSmallIconPx } from '../../outputs/agent-studio/server/desktop/tray_icon.ts';
import { iconFromPng, iconPixels } from '../../outputs/agent-studio/server/desktop/window_icon_win.ts';
import { withAttentionDot } from '../../outputs/agent-studio/server/desktop/png_badge.ts';
import { decodePng, pngSize } from '../../tools/build.ts';

const WINDOWS = Deno.build.os === 'windows';
const TILE: [number, number, number] = [0x13, 0x86, 0x7a];
const near = (rgba: Uint8Array, i: number, rgb: [number, number, number], tol = 10) => rgb.every((c, k) => Math.abs(rgba[i + k] - c) <= tol);
/** How many opaque pixels are the teal tile colour. */
const tealCount = (rgba: Uint8Array) => {
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 3] > 200 && near(rgba, i, TILE)) n++;
  return n;
};

Deno.test('chooseTraySize: Windows 16 px at a 16 px small icon, else 32; macOS and Linux 32', () => {
  assertEquals(chooseTraySize('windows', 16), 16);
  assertEquals(chooseTraySize('windows', 20), 32);
  assertEquals(chooseTraySize('windows', 24), 32);
  assertEquals(chooseTraySize('windows', 32), 32);
  assertEquals(chooseTraySize('windows', 0), 32);
  for (const os of ['darwin', 'linux'] as const) {
    assertEquals(chooseTraySize(os, 16), 32);
    assertEquals(chooseTraySize(os, 0), 32);
  }
});

Deno.test('trayIconBytes: the colour app icon (teal tile, yellow and coral squares) at 16 and 32; trayIconPng is one of them', async () => {
  for (const size of [16, 32] as const) {
    const png = trayIconBytes(size);
    assertEquals(pngSize(png), { width: size, height: size });
    const { rgba } = await decodePng(png);
    assert(tealCount(rgba) > size * size * 0.3, `${size} px: mostly the teal tile`);
    // The tile fills the middle of the left edge (no white or see-through background there).
    const left = ((size >> 1) * size + 1) * 4;
    assert(rgba[left + 3] > 200 && near(rgba, left, TILE), `${size} px: teal at the left edge`);
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
  assert(near(dotted, at(6, 16), TILE) && near(plain, at(6, 16), TILE), 'the tile elsewhere is unchanged');
});

Deno.test({
  name: 'Windows: the tray worker\'s icon from each PNG (CreateIconFromResourceEx at SM_CXSMICON) is the teal tile',
  ignore: !WINDOWS,
  fn: () => {
    const px = windowsSmallIconPx();
    assert(px >= 16 && px <= 64, `SM_CXSMICON ${px}`);
    for (const size of [16, 32] as const) {
      const h = iconFromPng(trayIconBytes(size), px, px); // the call tray_win_worker.ts makes with start.icon
      assert(h !== 0n, `${size}: no icon`);
      const p = iconPixels(h)!;
      assertEquals([p.width, p.height], [px, px]);
      assert(tealCount(p.rgba) > px * px * 0.3, `${size} px PNG: the icon is mostly teal`);
    }
  },
});

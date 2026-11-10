/** server/desktop/tray_icon.ts: which tray image each platform, taskbar theme and scale gets, and the Windows reads behind it. */
import { assert, assertEquals } from './_assert.ts';
import {
  chooseTrayIcon,
  chooseTrayIconDark,
  trayIconBytes,
  trayIconDarkPng,
  trayIconPng,
  windowsSmallIconPx,
  windowsTaskbarIsLight,
} from '../../outputs/agent-studio/server/desktop/tray_icon.ts';
import { pngSize } from '../../tools/build.ts';

const WINDOWS = Deno.build.os === 'windows';

Deno.test('chooseTrayIcon: Windows follows the taskbar theme (unknown = dark) and the small icon size; elsewhere the colour icon', () => {
  assertEquals(chooseTrayIcon('windows', false, 16), { art: 'dark', size: 16 });
  assertEquals(chooseTrayIcon('windows', true, 16), { art: 'light', size: 16 });
  assertEquals(chooseTrayIcon('windows', null, 16), { art: 'dark', size: 16 });
  assertEquals(chooseTrayIcon('windows', true, 20), { art: 'light', size: 32 });
  assertEquals(chooseTrayIcon('windows', false, 24), { art: 'dark', size: 32 });
  assertEquals(chooseTrayIcon('windows', false, 32), { art: 'dark', size: 32 });
  assertEquals(chooseTrayIcon('windows', null, 0), { art: 'dark', size: 32 });
  for (const os of ['darwin', 'linux'] as const) {
    assertEquals(chooseTrayIcon(os, true, 16), { art: 'color', size: 32 });
    assertEquals(chooseTrayIcon(os, null, 0), { art: 'color', size: 32 });
  }
});

Deno.test('trayIconBytes: a PNG of the chosen size for every choice; trayIconPng gives one of them', () => {
  for (const art of ['dark', 'light'] as const) {
    for (const size of [16, 32] as const) assertEquals(pngSize(trayIconBytes({ art, size })), { width: size, height: size });
  }
  assertEquals(pngSize(trayIconBytes({ art: 'color', size: 32 })), { width: 32, height: 32 });
  const png = trayIconPng();
  assertEquals([...png.slice(1, 4)], [0x50, 0x4e, 0x47]);
  const want = trayIconBytes(chooseTrayIcon(Deno.build.os, windowsTaskbarIsLight(), windowsSmallIconPx()));
  assertEquals([...png], [...want]);
});

Deno.test({
  name: 'Windows: RegGetValueW reads SystemUsesLightTheme as reg.exe does; GetSystemMetrics gives the small icon size',
  ignore: !WINDOWS,
  fn: async () => {
    const out = await new Deno.Command('reg', {
      args: ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'SystemUsesLightTheme'],
      stdout: 'piped',
      stderr: 'null',
      windowsRawArguments: false,
    }).output();
    const m = new TextDecoder().decode(out.stdout).match(/SystemUsesLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i);
    assertEquals(windowsTaskbarIsLight(), m ? parseInt(m[1], 16) !== 0 : null);
    const px = windowsSmallIconPx();
    assert(px >= 16 && px <= 64, `SM_CXSMICON ${px}`);
  },
});

Deno.test('chooseTrayIconDark: macOS and Linux get the white glyph for Deno.Tray.setIconDark; Windows none (its tray follows the taskbar)', () => {
  assertEquals(chooseTrayIconDark('windows'), null);
  for (const os of ['darwin', 'linux'] as const) assertEquals(chooseTrayIconDark(os), { art: 'dark', size: 32 });
  const png = trayIconDarkPng();
  if (WINDOWS) assertEquals(png, null);
  else assertEquals(pngSize(png!), { width: 32, height: 32 });
});

Deno.test({
  name: 'Windows: the tray worker turns every glyph PNG into an icon at the system small icon size (CreateIconFromResourceEx)',
  ignore: !WINDOWS,
  fn: () => {
    const u = Deno.dlopen('user32.dll', {
      CreateIconFromResourceEx: { parameters: ['buffer', 'u32', 'i32', 'u32', 'i32', 'i32', 'u32'], result: 'pointer' },
      DestroyIcon: { parameters: ['pointer'], result: 'i32' },
      GetSystemMetrics: { parameters: ['i32'], result: 'i32' },
    });
    try {
      const cx = u.symbols.GetSystemMetrics(49) || 16, cy = u.symbols.GetSystemMetrics(50) || 16;
      for (const art of ['dark', 'light'] as const) {
        for (const size of [16, 32] as const) {
          const png = trayIconBytes({ art, size });
          // The same call tray_win_worker.ts makes with start.icon.
          const h = u.symbols.CreateIconFromResourceEx(new Uint8Array(png), png.length, 1, 0x00030000, cx, cy, 0);
          assert(h !== null, `${art}-${size}: no icon`);
          u.symbols.DestroyIcon(h);
        }
      }
    } finally {
      u.close();
    }
  },
});

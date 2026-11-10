/** server/desktop/tray_icon.ts: which tray image each platform, taskbar theme and scale gets, and the Windows reads behind it. */
import { assert, assertEquals } from './_assert.ts';
import {
  chooseTrayIcon,
  trayIconBytes,
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

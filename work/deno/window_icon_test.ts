/**
 * server/desktop/window_icon_win.ts: the app window gets AIB.exe's icon (WM_SETICON big and small, and the class icons). The FFI
 * test makes a hidden window of its own class in this process, as the desktop runtime does, and an exe carrying the AIB icon as
 * the build makes it (embedWindowsIcon on a copy of where.exe), then reads the icons back pixel by pixel.
 */
import { assert, assertEquals } from './_assert.ts';
import {
  applyAppIcon,
  iconPixels,
  iconSizes,
  LAUFEY_WINDOW_CLASS,
  loadIconPair,
  readWindowIcons,
  windowsOf,
} from '../../outputs/agent-studio/server/desktop/window_icon_win.ts';
import { decodePng, embedWindowsIcon, parseIco } from '../../tools/build.ts';

const WINDOWS = Deno.build.os === 'windows';
const ICO = new URL('../../outputs/agent-studio/icons/icon.ico', import.meta.url);

Deno.test('windowsOf: only this process\'s windows of the class, class names compared as Windows does', () => {
  const all = [
    { hwnd: 1n, pid: 7, cls: 'LaufeyWebView2' },
    { hwnd: 2n, pid: 7, cls: 'AIBTrayWindow' },
    { hwnd: 3n, pid: 8, cls: 'LaufeyWebView2' },
    { hwnd: 4n, pid: 7, cls: 'laufeywebview2' },
  ];
  assertEquals(windowsOf(all, 7, LAUFEY_WINDOW_CLASS), [1n, 4n]);
  assertEquals(windowsOf(all, 9, LAUFEY_WINDOW_CLASS), []);
});

Deno.test('off Windows every call is a harmless no-op', { ignore: WINDOWS }, () => {
  assertEquals(applyAppIcon(), 0);
  assertEquals(loadIconPair('x.exe'), null);
  assertEquals(readWindowIcons(1n), null);
});

/** A hidden top-level window of class cls on this thread, plus a pump that runs its posted messages (WM_SETICON is posted). */
function testWindow(cls: string) {
  const user = Deno.dlopen('user32.dll', {
    RegisterClassExW: { parameters: ['buffer'], result: 'u16' },
    UnregisterClassW: { parameters: ['buffer', 'pointer'], result: 'i32' },
    CreateWindowExW: {
      parameters: ['u32', 'buffer', 'buffer', 'u32', 'i32', 'i32', 'i32', 'i32', 'pointer', 'pointer', 'pointer', 'pointer'],
      result: 'pointer',
    },
    DestroyWindow: { parameters: ['pointer'], result: 'i32' },
    DefWindowProcW: { parameters: ['pointer', 'u32', 'usize', 'isize'], result: 'isize' },
    PeekMessageW: { parameters: ['buffer', 'pointer', 'u32', 'u32', 'u32'], result: 'i32' },
    DispatchMessageW: { parameters: ['buffer'], result: 'isize' },
  });
  const kernel = Deno.dlopen('kernel32.dll', { GetModuleHandleW: { parameters: ['pointer'], result: 'pointer' } });
  const u = user.symbols;
  const proc = new Deno.UnsafeCallback(
    { parameters: ['pointer', 'u32', 'usize', 'isize'], result: 'isize' } as const,
    (h, m, w, l) => u.DefWindowProcW(h, m, w, l),
  );
  const name = new Uint16Array([...cls].map((c) => c.charCodeAt(0)).concat(0));
  const hInstance = kernel.symbols.GetModuleHandleW(null);
  const wc = new Uint8Array(80);
  const v = new DataView(wc.buffer);
  v.setUint32(0, 80, true);
  v.setBigUint64(8, BigInt(Deno.UnsafePointer.value(proc.pointer)), true);
  v.setBigUint64(24, BigInt(Deno.UnsafePointer.value(hInstance)), true);
  v.setBigUint64(64, BigInt(Deno.UnsafePointer.value(Deno.UnsafePointer.of(name))), true);
  assert(u.RegisterClassExW(wc) !== 0, 'RegisterClassExW');
  const hwnd = u.CreateWindowExW(0, name, new Uint16Array([65, 73, 66, 0]), 0x00CF0000 /* WS_OVERLAPPEDWINDOW */, 0, 0, 200, 100, null, null, hInstance, null);
  assert(hwnd !== null, 'CreateWindowExW');
  return {
    hwnd: BigInt(Deno.UnsafePointer.value(hwnd)),
    pump() {
      const msg = new Uint8Array(48);
      while (u.PeekMessageW(msg, hwnd, 0, 0, 1 /* PM_REMOVE */)) u.DispatchMessageW(msg);
    },
    close() {
      u.DestroyWindow(hwnd);
      u.UnregisterClassW(name, hInstance);
      proc.close();
      user.close();
      kernel.close();
    },
  };
}

/** The largest per-channel difference between an icon and the .ico's image of the same size (straight RGBA). */
async function maxDiff(hicon: bigint, ico: ReturnType<typeof parseIco>): Promise<number> {
  const p = iconPixels(hicon)!;
  const img = ico.find((i) => (i.width || 256) === p.width);
  assert(img, `the .ico has a ${p.width} px image`);
  const want = (await decodePng(img.data)).rgba;
  let diff = 0;
  for (let i = 0; i < want.length; i += 4) {
    if (want[i + 3] < 8 && p.rgba[i + 3] < 8) continue; // both see-through: colour is meaningless
    for (let k = 0; k < 4; k++) diff = Math.max(diff, Math.abs(want[i + k] - p.rgba[i + k]));
  }
  return diff;
}

Deno.test({
  name: 'Windows: applyAppIcon gives this process\'s windows of the class the exe\'s icon (WM_SETICON and class), pixel for pixel',
  ignore: !WINDOWS,
  fn: async () => {
    const dir = Deno.makeTempDirSync({ prefix: 'aib-window-icon-' });
    const cls = `AIBIconTest${Deno.pid}`;
    const win = testWindow(cls);
    try {
      // An exe with the AIB icon group, as tools/build.ts makes AIB.exe.
      const exe = `${dir}\\AIB.exe`;
      Deno.copyFileSync(`${Deno.env.get('SystemRoot') ?? 'C:\\Windows'}\\System32\\where.exe`, exe);
      const icoBytes = await Deno.readFile(ICO);
      embedWindowsIcon(exe, icoBytes);
      const ico = parseIco(icoBytes);

      assertEquals(readWindowIcons(win.hwnd), { big: 0n, small: 0n, classBig: 0n, classSmall: 0n }, 'no icon to begin with, as in the runtime');
      assertEquals(applyAppIcon({ file: exe, cls: `${cls}-other` }), 0, 'a class this process has no window of: nothing set');
      assertEquals(applyAppIcon({ file: exe, cls, pid: Deno.pid + 1 }), 0, 'another process: nothing set');
      assertEquals(applyAppIcon({ file: `${dir}\\missing.exe`, cls }), 0, 'no icon in the file: nothing set');
      assertEquals(applyAppIcon({ file: exe, cls }), 1);
      win.pump();

      const pair = loadIconPair(exe)!;
      assertEquals(loadIconPair(exe), pair, 'loaded once, the same handles after');
      const got = readWindowIcons(win.hwnd)!;
      assertEquals(got, { big: pair.big, small: pair.small, classBig: pair.big, classSmall: pair.small });
      const sizes = iconSizes();
      const big = iconPixels(got.big)!, small = iconPixels(got.small)!;
      assertEquals([big.width, small.width], [sizes.big, sizes.small], 'the system\'s big and small icon sizes');
      // The images are the .ico's own (no scaling at 100/125/150/200%: the .ico has 16 20 24 32 40 48 64).
      assert((await maxDiff(got.big, ico)) <= 2, 'big icon = the .ico image');
      assert((await maxDiff(got.small, ico)) <= 2, 'small icon = the .ico image');
      // And the .ico itself works as a source too.
      assertEquals(applyAppIcon({ file: ICO.pathname.replace(/^\/([A-Za-z]:)/, '$1'), cls }), 1);
    } finally {
      win.close();
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

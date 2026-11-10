/**
 * Windows: the app window's own icon (title bar, Alt+Tab, taskbar button), and reading icons back for tests.
 *
 * Why: Deno 2.9.8's desktop runtime (laufey 0.7.0, WebView2 backend) registers its window class "LaufeyWebView2" with no hIcon and
 * never sends WM_SETICON, so every AIB window shows Windows' generic window icon, although AIB.exe carries the AIB icon group
 * (tools/build.ts embedWindowsIcon). So after a window is made, AIB loads its own icon from the running exe (ExtractIconExW at the
 * system's big and small icon sizes) and sets it on the class (SetClassLongPtrW GCLP_HICON / GCLP_HICONSM: every window of the
 * class, also later ones) and on each of this process's LaufeyWebView2 windows (WM_SETICON ICON_BIG / ICON_SMALL, posted, so the
 * UI thread is never waited on). The windows are found by process id and class name (EnumWindows), since Deno.BrowserWindow does
 * not hand out its HWND.
 *
 * Every function here is Windows only and never throws (it returns null / 0 / false instead); the libraries open on first use.
 * Tests: work/deno/window_icon_test.ts (a window of the test's own class).
 */

export const LAUFEY_WINDOW_CLASS = 'LaufeyWebView2';
export const WM_SETICON = 0x0080, WM_GETICON = 0x007f;
export const ICON_SMALL = 0, ICON_BIG = 1;
export const GCLP_HICON = -14, GCLP_HICONSM = -34;
const SM_CXICON = 11, SM_CXSMICON = 49;

export interface IconPair {
  big: bigint;
  small: bigint;
}

export interface FoundWindow {
  hwnd: bigint;
  pid: number;
  cls: string;
}

/** The windows of process pid with class name cls (compared as Windows does: case-insensitively). */
export function windowsOf(all: FoundWindow[], pid: number, cls: string): bigint[] {
  return all.filter((w) => w.pid === pid && w.cls.toLowerCase() === cls.toLowerCase()).map((w) => w.hwnd);
}

const wide = (s: string) => {
  const a = new Uint16Array(s.length + 1);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
};
const ptr = (v: bigint) => Deno.UnsafePointer.create(v);
const val = (p: Deno.PointerValue) => BigInt(Deno.UnsafePointer.value(p));

function open() {
  const user = Deno.dlopen('user32.dll', {
    EnumWindows: { parameters: ['function', 'isize'], result: 'i32' },
    GetWindowThreadProcessId: { parameters: ['pointer', 'buffer'], result: 'u32' },
    GetClassNameW: { parameters: ['pointer', 'buffer', 'i32'], result: 'i32' },
    PostMessageW: { parameters: ['pointer', 'u32', 'usize', 'isize'], result: 'i32' },
    SendMessageTimeoutW: { parameters: ['pointer', 'u32', 'usize', 'isize', 'u32', 'u32', 'buffer'], result: 'isize' },
    SetClassLongPtrW: { parameters: ['pointer', 'i32', 'isize'], result: 'usize' },
    GetClassLongPtrW: { parameters: ['pointer', 'i32'], result: 'usize' },
    GetSystemMetrics: { parameters: ['i32'], result: 'i32' },
    GetIconInfo: { parameters: ['pointer', 'buffer'], result: 'i32' },
    GetDC: { parameters: ['pointer'], result: 'pointer' },
    ReleaseDC: { parameters: ['pointer', 'pointer'], result: 'i32' },
    CreateIconFromResourceEx: { parameters: ['buffer', 'u32', 'i32', 'u32', 'i32', 'i32', 'u32'], result: 'pointer' },
    LoadImageW: { parameters: ['pointer', 'buffer', 'u32', 'i32', 'i32', 'u32'], result: 'pointer' },
  });
  const gdi = Deno.dlopen('gdi32.dll', {
    GetObjectW: { parameters: ['pointer', 'i32', 'buffer'], result: 'i32' },
    GetDIBits: { parameters: ['pointer', 'pointer', 'u32', 'u32', 'buffer', 'buffer', 'u32'], result: 'i32' },
    DeleteObject: { parameters: ['pointer'], result: 'i32' },
  });
  const kernel = Deno.dlopen('kernel32.dll', { GetModuleFileNameW: { parameters: ['pointer', 'buffer', 'u32'], result: 'u32' } });
  return { u: user.symbols, g: gdi.symbols, k: kernel.symbols };
}

let libs: ReturnType<typeof open> | null = null;
function lib(): ReturnType<typeof open> | null {
  if (Deno.build.os !== 'windows') return null;
  try {
    return libs ??= open();
  } catch {
    return null;
  }
}

/** The running program's own file (AIB.exe in the app), or null. */
export function ownExePath(): string | null {
  const l = lib();
  if (!l) return null;
  const buf = new Uint16Array(32768);
  const n = l.k.GetModuleFileNameW(null, buf, buf.length);
  return n > 0 ? String.fromCharCode(...buf.subarray(0, n)) : null;
}

/** The system's big and small icon sizes (SM_CXICON, SM_CXSMICON), [32, 16] when unknown. */
export function iconSizes(): { big: number; small: number } {
  const l = lib();
  return { big: (l && l.u.GetSystemMetrics(SM_CXICON)) || 32, small: (l && l.u.GetSystemMetrics(SM_CXSMICON)) || 16 };
}

const IMAGE_ICON = 1, LR_LOADFROMFILE = 0x10;
const loaded = new Map<string, IconPair>();

/**
 * The icon of a file at the system's big and small sizes: an .exe's first icon group, or an .ico file. Kept for the process's life
 * (the windows and the class hold them), so asking twice gives the same handles. Null when the file has no icon.
 */
export function loadIconPair(file: string): IconPair | null {
  const known = loaded.get(file.toLowerCase());
  if (known) return known;
  const l = lib();
  if (!l) return null;
  const sizes = iconSizes();
  let pair: IconPair | null = null;
  if (/\.ico$/i.test(file)) {
    const load = (size: number) => val(l.u.LoadImageW(null, wide(file), IMAGE_ICON, size, size, LR_LOADFROMFILE));
    pair = { big: load(sizes.big), small: load(sizes.small) };
  } else {
    try {
      const shell = Deno.dlopen('shell32.dll', {
        SHDefExtractIconW: { parameters: ['buffer', 'i32', 'u32', 'buffer', 'buffer', 'u32'], result: 'i32' },
      });
      const big = new BigUint64Array(1), small = new BigUint64Array(1);
      // nIconSize: the big size in the low word, the small one in the high word; index 0 = the first icon group.
      const ok = shell.symbols.SHDefExtractIconW(wide(file), 0, 0, big, small, (sizes.small << 16) | sizes.big) === 0;
      shell.close();
      if (ok) pair = { big: big[0], small: small[0] };
    } catch { /* no icon */ }
  }
  if (!pair || !pair.big || !pair.small) return null;
  loaded.set(file.toLowerCase(), pair);
  return pair;
}

/** Every top-level window of this desktop (EnumWindows): handle, process id, class name. */
export function topLevelWindows(): FoundWindow[] {
  const l = lib();
  if (!l) return [];
  const out: FoundWindow[] = [];
  const pidBuf = new Uint32Array(1), cls = new Uint16Array(256);
  const cb = new Deno.UnsafeCallback({ parameters: ['pointer', 'isize'], result: 'i32' } as const, (h) => {
    l.u.GetWindowThreadProcessId(h, pidBuf);
    const n = l.u.GetClassNameW(h, cls, cls.length);
    out.push({ hwnd: val(h), pid: pidBuf[0], cls: String.fromCharCode(...cls.subarray(0, Math.max(0, n))) });
    return 1;
  });
  try {
    l.u.EnumWindows(cb.pointer, 0n);
  } finally {
    cb.close();
  }
  return out;
}

/** Sets the icons on one window and on its class. False when a call failed. */
export function setWindowIcons(hwnd: bigint, icons: IconPair): boolean {
  const l = lib();
  if (!l || !hwnd) return false;
  const h = ptr(hwnd);
  l.u.SetClassLongPtrW(h, GCLP_HICON, icons.big);
  l.u.SetClassLongPtrW(h, GCLP_HICONSM, icons.small);
  const a = l.u.PostMessageW(h, WM_SETICON, BigInt(ICON_BIG), icons.big);
  const b = l.u.PostMessageW(h, WM_SETICON, BigInt(ICON_SMALL), icons.small);
  return a !== 0 && b !== 0 && BigInt(l.u.GetClassLongPtrW(h, GCLP_HICON)) === icons.big;
}

/**
 * Gives every window of this process with class cls (default the runtime's LaufeyWebView2) the icon of file (default this
 * program's exe). Returns how many windows were set; 0 when there were none yet, no icon, or not Windows. Never throws.
 */
export function applyAppIcon(o: { file?: string | null; cls?: string; pid?: number } = {}): number {
  try {
    const file = o.file ?? ownExePath();
    const icons = file ? loadIconPair(file) : null;
    if (!icons) return 0;
    const hwnds = windowsOf(topLevelWindows(), o.pid ?? Deno.pid, o.cls ?? LAUFEY_WINDOW_CLASS);
    let set = 0;
    for (const hwnd of hwnds) if (setWindowIcons(hwnd, icons)) set++;
    return set;
  } catch {
    return 0;
  }
}

/** A window's icons as Windows reports them: WM_GETICON big/small (0 when unset) and the class's GCLP_HICON / GCLP_HICONSM. */
export function readWindowIcons(hwnd: bigint): { big: bigint; small: bigint; classBig: bigint; classSmall: bigint } | null {
  const l = lib();
  if (!l) return null;
  const h = ptr(hwnd);
  const get = (which: number) => {
    const out = new BigUint64Array(1);
    return l.u.SendMessageTimeoutW(h, WM_GETICON, BigInt(which), 0n, 0x2 /* SMTO_ABORTIFHUNG */, 2000, out) ? out[0] : 0n;
  };
  return {
    big: get(ICON_BIG),
    small: get(ICON_SMALL),
    classBig: BigInt(l.u.GetClassLongPtrW(h, GCLP_HICON)),
    classSmall: BigInt(l.u.GetClassLongPtrW(h, GCLP_HICONSM)),
  };
}

/** An icon from PNG bytes at cx x cy (CreateIconFromResourceEx; PNG data works since Vista), 0n when it can't be made. */
export function iconFromPng(png: Uint8Array, cx: number, cy: number): bigint {
  const l = lib();
  if (!l || !png.length) return 0n;
  return val(l.u.CreateIconFromResourceEx(new Uint8Array(png), png.length, 1, 0x00030000, cx, cy, 0));
}

/** An icon's colour pixels as RGBA, top row first (GetIconInfo + GetDIBits at 32 bits), or null. */
export function iconPixels(hicon: bigint): { width: number; height: number; rgba: Uint8Array } | null {
  const l = lib();
  if (!l || !hicon) return null;
  const info = new Uint8Array(32); // ICONINFO: fIcon, xHotspot, yHotspot, (pad), hbmMask @16, hbmColor @24
  if (!l.u.GetIconInfo(ptr(hicon), info)) return null;
  const iv = new DataView(info.buffer);
  const mask = iv.getBigUint64(16, true), color = iv.getBigUint64(24, true);
  try {
    if (!color) return null;
    const bm = new Uint8Array(32); // BITMAP: bmType, bmWidth @4, bmHeight @8
    if (!l.g.GetObjectW(ptr(color), 32, bm)) return null;
    const bv = new DataView(bm.buffer);
    const width = bv.getInt32(4, true), height = bv.getInt32(8, true);
    const bmi = new Uint8Array(44); // BITMAPINFOHEADER + one RGBQUAD
    const hv = new DataView(bmi.buffer);
    hv.setUint32(0, 40, true);
    hv.setInt32(4, width, true);
    hv.setInt32(8, -height, true); // top-down
    hv.setUint16(12, 1, true);
    hv.setUint16(14, 32, true);
    const bgra = new Uint8Array(width * height * 4);
    const dc = l.u.GetDC(null);
    const lines = l.g.GetDIBits(dc, ptr(color), 0, height, bgra, bmi, 0);
    l.u.ReleaseDC(null, dc);
    if (lines !== height) return null;
    const rgba = new Uint8Array(bgra.length);
    for (let i = 0; i < bgra.length; i += 4) rgba.set([bgra[i + 2], bgra[i + 1], bgra[i], bgra[i + 3]], i);
    return { width, height, rgba };
  } finally {
    if (mask) l.g.DeleteObject(ptr(mask));
    if (color) l.g.DeleteObject(ptr(color));
  }
}

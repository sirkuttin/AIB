/**
 * Windows: bring an AIB window to the front, restoring it if it is minimised. Deno.BrowserWindow's show() / focus() do neither for
 * a minimised window, and focus() is not SetForegroundWindow, so a click on AIB's notification (or its tray icon) could leave the
 * window where it was.
 *
 * Which window (multi-window B1): the window's own native handle. Deno 2.9.8's getNativeWindow() is a WebGPU surface call, not an
 * HWND (it throws "Cannot create surface outside of WebGPU context", Phase 2A probe on the invisible desktop), so the handle is found
 * here with EnumWindows: among this process's LaufeyWebView2 windows not yet claimed by another AIB window, the one whose title is
 * the window's own (findOwnWindow). Without a handle it falls back to the biggest one (pickMainWindow), as before; the keeper and
 * the runtime's startup window are 1x1.
 *
 * Also here, since user32 is loaded anyway: IsZoomed / IsIconic for the saved "maximised" flag and the 0x0 guard (S5, G3),
 * ShowWindow(SW_MAXIMIZE) for restoring a maximised window, and MonitorFromRect for "is this saved position still on a screen" (G1).
 *
 * Foreground rights: Explorer lets the process that owns a tray icon take the foreground right after the person clicks the icon or
 * its balloon / toast, so SetForegroundWindow from here works then. The result is logged either way. Never throws.
 */
import { LAUFEY_WINDOW_CLASS, topLevelWindows, windowsOf } from './window_icon_win.ts';

export interface Candidate {
  hwnd: bigint;
  width: number;
  height: number;
}

/** The main window among this process's windows of the class: the biggest that is more than a few pixels; null when none. */
export function pickMainWindow(cands: Candidate[]): bigint | null {
  let best: Candidate | null = null;
  for (const c of cands) {
    if (c.width <= 8 || c.height <= 8) continue; // the keeper and the startup window
    if (!best || c.width * c.height > best.width * best.height) best = c;
  }
  return best ? best.hwnd : null;
}

export interface TitledCandidate extends Candidate {
  title: string;
}

/**
 * The handle of the window titled `title` among `cands` (this process's AIB windows), leaving out the handles other AIB windows
 * claimed already. A title shared by several unclaimed windows picks none (null) rather than a wrong one; when exactly one real
 * (bigger than 8 px) window is unclaimed it is that one, whatever its title (a window just made, before its title is applied).
 */
export function findOwnWindow(cands: TitledCandidate[], title: string, claimed: ReadonlySet<bigint>): bigint | null {
  const free = cands.filter((c) => !claimed.has(c.hwnd) && c.width > 8 && c.height > 8);
  const named = free.filter((c) => c.title === title);
  if (named.length === 1) return named[0].hwnd;
  if (named.length === 0 && free.length === 1) return free[0].hwnd;
  return null;
}

export interface FrontResult {
  found: boolean;
  restored: boolean;
  foreground: boolean;
}

const SW_RESTORE = 9, SW_SHOW = 5, SW_MAXIMIZE = 3;
const MONITOR_DEFAULTTONULL = 0;

let user: ReturnType<typeof openUser> | null = null;
function openUser() {
  return Deno.dlopen('user32.dll', {
    GetWindowRect: { parameters: ['pointer', 'buffer'], result: 'i32' },
    GetWindowTextW: { parameters: ['pointer', 'buffer', 'i32'], result: 'i32' },
    IsIconic: { parameters: ['pointer'], result: 'i32' },
    IsZoomed: { parameters: ['pointer'], result: 'i32' },
    IsWindow: { parameters: ['pointer'], result: 'i32' },
    IsWindowVisible: { parameters: ['pointer'], result: 'i32' },
    ShowWindow: { parameters: ['pointer', 'i32'], result: 'i32' },
    SetForegroundWindow: { parameters: ['pointer'], result: 'i32' },
    GetForegroundWindow: { parameters: [], result: 'pointer' },
    MonitorFromRect: { parameters: ['buffer', 'u32'], result: 'pointer' },
  }).symbols;
}
const u32 = () => (Deno.build.os === 'windows' ? (user ??= openUser()) : null);
const ptr = (h: bigint) => Deno.UnsafePointer.create(h);

/** This process's AIB windows (class LaufeyWebView2) with their size and title. Empty off Windows or on any failure. */
export function ownWindows(pid: number = Deno.pid): TitledCandidate[] {
  const u = u32();
  if (!u) return [];
  try {
    const rect = new Int32Array(4), text = new Uint16Array(256);
    return windowsOf(topLevelWindows(), pid, LAUFEY_WINDOW_CLASS).map((hwnd) => {
      const ok = u.GetWindowRect(ptr(hwnd), rect) !== 0;
      const n = u.GetWindowTextW(ptr(hwnd), text, text.length);
      return {
        hwnd,
        width: ok ? rect[2] - rect[0] : 0,
        height: ok ? rect[3] - rect[1] : 0,
        title: String.fromCharCode(...text.subarray(0, Math.max(0, n))),
      };
    });
  } catch {
    return [];
  }
}

/** True while `hwnd` is still a window (a cached handle of a closed window is dropped). */
export function isWindowHandle(hwnd: bigint): boolean {
  const u = u32();
  try {
    return !!u && u.IsWindow(ptr(hwnd)) !== 0;
  } catch {
    return false;
  }
}

/** Minimised (IsIconic) and maximised (IsZoomed) for one window; null off Windows or for a bad handle. */
export function windowState(hwnd: bigint): { minimized: boolean; maximized: boolean } | null {
  const u = u32();
  if (!u || !hwnd) return null;
  try {
    const h = ptr(hwnd);
    if (!u.IsWindow(h)) return null;
    return { minimized: u.IsIconic(h) !== 0, maximized: u.IsZoomed(h) !== 0 };
  } catch {
    return null;
  }
}

/** ShowWindow(SW_MAXIMIZE) (G3: restore a window saved maximised, after its normal size and position). */
export function maximizeWindow(hwnd: bigint): boolean {
  const u = u32();
  if (!u || !hwnd) return false;
  try {
    u.ShowWindow(ptr(hwnd), SW_MAXIMIZE);
    return true;
  } catch {
    return false;
  }
}

/** G1: is any part of this rectangle on a screen now (MonitorFromRect, MONITOR_DEFAULTTONULL)? null off Windows or on failure. */
export function rectOnScreen(r: { x: number; y: number; width: number; height: number }): boolean | null {
  const u = u32();
  if (!u) return null;
  try {
    const rect = new Int32Array([r.x, r.y, r.x + r.width, r.y + r.height]);
    return u.MonitorFromRect(rect, MONITOR_DEFAULTTONULL) !== null;
  } catch {
    return null;
  }
}

/** Brings `hwnd` (the window's own handle, B1) or, without one, the biggest AIB window to the front, restoring it if minimised. */
export function bringToFront(hwnd: bigint | null = null, pid: number = Deno.pid): FrontResult {
  const none = { found: false, restored: false, foreground: false };
  const u = u32();
  if (!u) return none;
  try {
    let target = hwnd !== null && isWindowHandle(hwnd) ? hwnd : null;
    target ??= pickMainWindow(ownWindows(pid));
    if (target === null) return none;
    const h = ptr(target);
    let restored = false;
    if (u.IsIconic(h)) {
      u.ShowWindow(h, SW_RESTORE);
      restored = true;
    } else if (!u.IsWindowVisible(h)) u.ShowWindow(h, SW_SHOW);
    u.SetForegroundWindow(h);
    const fg = u.GetForegroundWindow();
    return { found: true, restored, foreground: !!fg && BigInt(Deno.UnsafePointer.value(fg)) === target };
  } catch {
    return none;
  }
}

/**
 * Windows: bring the AIB window to the front, restoring it if it is minimised. Deno.BrowserWindow's show() / focus() do neither for
 * a minimised window, and focus() is not SetForegroundWindow, so a click on AIB's notification (or its tray icon) could leave the
 * window where it was. The window is found the way window_icon_win.ts finds it (this process's LaufeyWebView2 windows): the biggest
 * one, since the keeper and the runtime's startup window are 1x1.
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

export interface FrontResult {
  found: boolean;
  restored: boolean;
  foreground: boolean;
}

const SW_RESTORE = 9, SW_SHOW = 5;

let user: ReturnType<typeof openUser> | null = null;
function openUser() {
  return Deno.dlopen('user32.dll', {
    GetWindowRect: { parameters: ['pointer', 'buffer'], result: 'i32' },
    IsIconic: { parameters: ['pointer'], result: 'i32' },
    IsWindowVisible: { parameters: ['pointer'], result: 'i32' },
    ShowWindow: { parameters: ['pointer', 'i32'], result: 'i32' },
    SetForegroundWindow: { parameters: ['pointer'], result: 'i32' },
    GetForegroundWindow: { parameters: [], result: 'pointer' },
  }).symbols;
}

export function bringToFront(pid: number = Deno.pid): FrontResult {
  const none = { found: false, restored: false, foreground: false };
  if (Deno.build.os !== 'windows') return none;
  try {
    const u = user ??= openUser();
    const rect = new Int32Array(4);
    const cands = windowsOf(topLevelWindows(), pid, LAUFEY_WINDOW_CLASS).map((hwnd) => {
      const ok = u.GetWindowRect(Deno.UnsafePointer.create(hwnd), rect) !== 0;
      return { hwnd, width: ok ? rect[2] - rect[0] : 0, height: ok ? rect[3] - rect[1] : 0 };
    });
    const hwnd = pickMainWindow(cands);
    if (hwnd === null) return none;
    const h = Deno.UnsafePointer.create(hwnd);
    let restored = false;
    if (u.IsIconic(h)) {
      u.ShowWindow(h, SW_RESTORE);
      restored = true;
    } else if (!u.IsWindowVisible(h)) u.ShowWindow(h, SW_SHOW);
    u.SetForegroundWindow(h);
    const fg = u.GetForegroundWindow();
    return { found: true, restored, foreground: !!fg && BigInt(Deno.UnsafePointer.value(fg)) === hwnd };
  } catch {
    return none;
  }
}

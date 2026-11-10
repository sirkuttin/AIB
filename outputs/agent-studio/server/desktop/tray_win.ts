/**
 * The Windows tray icon, made by AIB itself instead of Deno.Tray.
 *
 * Why (Deno 2.9.8, laufey 0.7.0 WebView2 backend, seen on an invisible desktop 2026-11-10): Deno.Tray creates the icon's hidden
 * message window on the thread that runs JavaScript, and that thread never pumps Windows messages (a WM_NULL sent to the window is
 * never answered). Explorer's right-click and left-click notifications for the icon wait in that queue for ever, so no menu shows
 * and no `click` / `menuclick` event fires; the icon itself shows because Shell_NotifyIcon works from any thread.
 *
 * So on Windows the icon lives on a worker thread (tray_win_worker.ts) that owns a hidden window and runs a real message loop:
 * left click → onClick, right click → a popup menu (Open AIB / Quit AIB) → onMenu(id). The menu is modal on the worker thread
 * only, so the web server keeps answering while it is open. This file holds the pure parts (tested in desktop_window_test.ts)
 * and startWindowsTray(), which the real Shell (native.ts) calls.
 */
import type { TrayItem } from './window.ts';

/** Messages the tray window uses. The callback message is what Explorer sends for clicks on the icon (legacy version: lParam
 * is the mouse message); REMOVE asks the worker to delete the icon and end its message loop. */
export const WM_APP = 0x8000;
export const TRAY_CALLBACK = WM_APP + 1;
export const TRAY_REMOVE = WM_APP + 2;
export const TRAY_UID = 1;
export const TRAY_WINDOW_CLASS = 'AIBTrayWindow';

const WM_LBUTTONUP = 0x0202;
const WM_RBUTTONUP = 0x0205;
const WM_CONTEXTMENU = 0x007b;

export const NIM_ADD = 0, NIM_MODIFY = 1, NIM_DELETE = 2;
export const NIF_MESSAGE = 0x1, NIF_ICON = 0x2, NIF_TIP = 0x4;

/** sizeof(NOTIFYICONDATAW) on 64-bit Windows (x64 and arm64). */
export const NOTIFYICONDATAW_SIZE = 976;

/** What a tray callback's lParam means: a left click, a request for the menu, or nothing we act on. */
export function trayEvent(lParam: number | bigint): 'click' | 'menu' | null {
  const event = Number(BigInt.asUintN(64, BigInt(lParam)) & 0xffffn);
  if (event === WM_LBUTTONUP) return 'click';
  if (event === WM_RBUTTONUP || event === WM_CONTEXTMENU) return 'menu';
  return null;
}

/** Menu command ids: item i is command i + 1 (0 means "nothing chosen" for TrackPopupMenu). */
export function menuCommand(index: number): number {
  return index + 1;
}

/** The item id for a TrackPopupMenu result, or null when the menu was dismissed. */
export function chosenItem(items: TrayItem[], command: number): string | null {
  return command >= 1 && command <= items.length ? items[command - 1].id : null;
}

/** A NOTIFYICONDATAW for Shell_NotifyIconW (64-bit layout). hwnd and hIcon are pointer values; the tooltip is cut to 127 chars. */
export function notifyIconData(
  o: { hwnd: bigint; uid?: number; flags: number; callbackMessage?: number; hIcon?: bigint; tip?: string },
): Uint8Array {
  const buf = new Uint8Array(NOTIFYICONDATAW_SIZE);
  const v = new DataView(buf.buffer);
  v.setUint32(0, NOTIFYICONDATAW_SIZE, true); // cbSize
  v.setBigUint64(8, o.hwnd, true); // hWnd
  v.setUint32(16, o.uid ?? TRAY_UID, true); // uID
  v.setUint32(20, o.flags, true); // uFlags
  v.setUint32(24, o.callbackMessage ?? 0, true); // uCallbackMessage
  v.setBigUint64(32, o.hIcon ?? 0n, true); // hIcon
  const tip = (o.tip ?? '').slice(0, 127); // szTip[128]
  for (let i = 0; i < tip.length; i++) v.setUint16(40 + i * 2, tip.charCodeAt(i), true);
  return buf;
}

/** What the worker tells the main thread. */
export type TrayWorkerMessage =
  | { type: 'ready'; hwnd: string; added: boolean }
  | { type: 'failed'; error: string }
  | { type: 'click' }
  | { type: 'menu'; id: string }
  | { type: 'log'; message: string };

/** What the main thread sends the worker once, to start. */
export interface TrayWorkerStart {
  icon: Uint8Array;
  tooltip: string;
  items: TrayItem[];
}

export interface WindowsTray {
  /** Deletes the icon now (quitting), so no dead icon is left in the notification area. Never throws. */
  remove(): void;
}

/**
 * Starts the worker-thread tray. Resolves with a handle once the worker owns its window (the icon may still be missing if
 * Explorer isn't running: it is added again when the taskbar comes back), or null if the worker could not start: the caller then
 * falls back to Deno.Tray.
 */
export function startWindowsTray(
  icon: Uint8Array,
  tooltip: string,
  items: TrayItem[],
  onClick: () => void,
  onMenu: (id: string) => void,
  onLog: (message: string) => void = () => {},
): Promise<WindowsTray | null> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./tray_win_worker.ts', import.meta.url).href, { type: 'module' });
    } catch (error) {
      onLog(`tray worker could not start: ${error}`);
      resolve(null);
      return;
    }
    let settled = false;
    const settle = (value: WindowsTray | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    worker.onerror = (e) => {
      e.preventDefault();
      onLog(`tray worker error: ${e.message}`);
      settle(null);
    };
    worker.onmessage = (e: MessageEvent<TrayWorkerMessage>) => {
      const m = e.data;
      if (m.type === 'click') onClick();
      else if (m.type === 'menu') onMenu(m.id);
      else if (m.type === 'log') onLog(m.message);
      else if (m.type === 'failed') {
        onLog(`tray worker failed: ${m.error}`);
        settle(null);
      } else if (m.type === 'ready') {
        onLog(`tray ready (icon added: ${m.added})`);
        settle({ remove: () => removeTray(BigInt(m.hwnd)) });
      }
    };
    worker.postMessage({ icon, tooltip, items } satisfies TrayWorkerStart);
  });
}

/** Deletes the icon from this (main) thread, which Shell_NotifyIconW allows, then lets the worker's window close itself. */
function removeTray(hwnd: bigint): void {
  try {
    const shell = Deno.dlopen('shell32.dll', { Shell_NotifyIconW: { parameters: ['u32', 'buffer'], result: 'i32' } });
    shell.symbols.Shell_NotifyIconW(NIM_DELETE, notifyIconData({ hwnd, flags: 0 }));
    shell.close();
    const user = Deno.dlopen('user32.dll', {
      PostMessageW: { parameters: ['pointer', 'u32', 'usize', 'isize'], result: 'i32' },
    });
    user.symbols.PostMessageW(Deno.UnsafePointer.create(hwnd), TRAY_REMOVE, 0n, 0n);
    user.close();
  } catch { /* quitting anyway */ }
}

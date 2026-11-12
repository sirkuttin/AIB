/**
 * The real Shell for window.ts: Deno.BrowserWindow, Deno.Tray, the native question box and the OS notifications (notify.ts). Only loaded in
 * a `deno desktop` build (isDesktopApp()); nothing here is reached by tests. API facts: docs in window.ts and the stage D report.
 */
import type { Shell, TrayItem, WindowHandle } from './window.ts';
import { type OsNotify, posixNotify, windowsNotify } from './notify.ts';
import { isExternal, keepHidden } from './window.ts';
import { startWindowsTray, userNotificationState, type WindowsTray } from './tray_win.ts';
import { applyAppIcon } from './window_icon_win.ts';
import { bringToFront } from './foreground_win.ts';
import { writeTrayState } from './host_tray.ts';
import { getLogger } from '../core/log.ts';

const log = getLogger('desktop');

// deno-lint-ignore no-explicit-any
type Any = any;
const D = Deno as Any;
const G = globalThis as Any;

function wrapWindow(win: Any): WindowHandle {
  return {
    navigate: (url) => win.navigate(url),
    show: () => win.show(),
    hide: () => win.hide(),
    focus: () => win.focus(),
    setTitle: (title) => win.setTitle(title),
    isVisible: () => {
      try {
        return win.isVisible() !== false;
      } catch {
        return false;
      }
    },
    isClosed: () => {
      try {
        return win.isClosed() === true;
      } catch {
        return true;
      }
    },
    getSize: () => win.getSize(),
    getPosition: () => win.getPosition(),
    setSize: (w, h) => win.setSize(w, h),
    setPosition: (x, y) => win.setPosition(x, y),
    bind: (name, fn) => win.bind(name, fn),
    on: (event, fn) => win.addEventListener(event, () => fn()),
    evaluate: async (code) => {
      try {
        const r = await win.executeJs(code); // spike: resolves {ok, value}
        return r && typeof r === 'object' && 'value' in r ? (r.ok === false ? undefined : r.value) : r;
      } catch {
        return undefined;
      }
    },
  };
}

/** Windows: MessageBoxW on a worker thread (FFI nonblocking), so the web server keeps answering while the question is open.
 * (The runtime's confirm() blocks the whole event loop.) OK/Cancel, warning icon, Cancel is the default button, on top. */
export function windowsAsk(): ((message: string) => Promise<boolean>) | null {
  try {
    const lib = Deno.dlopen('user32.dll', {
      MessageBoxW: { parameters: ['pointer', 'buffer', 'buffer', 'u32'], result: 'i32', nonblocking: true },
    });
    const wide = (s: string) => {
      const a = new Uint16Array(s.length + 1);
      for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
      return a;
    };
    const MB_OKCANCEL = 0x1, MB_ICONWARNING = 0x30, MB_DEFBUTTON2 = 0x100, MB_SETFOREGROUND = 0x10000, MB_TOPMOST = 0x40000;
    const IDOK = 1;
    return async (message) =>
      (await lib.symbols.MessageBoxW(
        null,
        wide(message),
        wide('AIB'),
        MB_OKCANCEL | MB_ICONWARNING | MB_DEFBUTTON2 | MB_SETFOREGROUND | MB_TOPMOST,
      )) === IDOK;
  } catch {
    return null;
  }
}

export function openExternal(url: string): void {
  if (!isExternal(url, 'http://127.0.0.1:1')) return; // http(s) only (an app-origin URL never reaches here)
  const [cmd, args] = Deno.build.os === 'windows'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : Deno.build.os === 'darwin'
    ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    new Deno.Command(cmd as string, { args: args as string[], stdin: 'null', stdout: 'null', stderr: 'null' }).spawn();
  } catch { /* no browser */ }
}

/** A 1x1, frameless, see-through, never-activated window, hidden at once and parked off every screen. */
function invisibleWindow(): WindowHandle {
  const raw = new D.BrowserWindow({ title: 'AIB', width: 1, height: 1, frameless: true, noActivate: true, opacity: 0, resizable: false });
  raw.hide();
  try {
    raw.setSize(1, 1);
    raw.setPosition(-32000, -32000);
  } catch { /* not fatal */ }
  return wrapWindow(raw);
}

/**
 * Non-window modes of a desktop binary (`AIB host`, `serve`, `mcp-artifact`, ...): the runtime makes a hidden startup window in
 * every process (seen on a separate desktop: `AIB.exe host` has a hidden 640x480 "AIB" window) and may navigate it to its own
 * DENO_SERVE_ADDRESS port and show it ("127.0.0.1 refused to connect"). Our first BrowserWindow takes that startup window's place
 * (window mode shows no extra one), so take it here too and keep it on about:blank and hidden. Never throws.
 */
export function tameStartupWindow(): void {
  try {
    keepHidden(invisibleWindow(), 'startup window', true);
  } catch { /* no window system: nothing to hide */ }
}

/**
 * Windows: the runtime's windows have no icon of their own (window_icon_win.ts), so give them AIB.exe's: now, and again shortly
 * after, since the runtime may make the window on its UI thread a moment after BrowserWindow returns. Setting it twice is harmless.
 */
function giveWindowsAppIcon(): void {
  if (Deno.build.os !== 'windows') return;
  let logged = false;
  const apply = () => {
    const n = applyAppIcon();
    if (n && !logged) {
      logged = true;
      log.info('window icon: set on %s window(s)', n);
    }
  };
  apply();
  for (const ms of [100, 500, 2000]) setTimeout(apply, ms);
}

export function nativeShell(): Shell {
  const ask = (Deno.build.os === 'windows' ? windowsAsk() : null) ??
    ((message: string) => Promise.resolve(G.confirm(message) === true));
  let keeper: WindowHandle | null = null;
  let tray: Any = null; // held for the app's life, so the native icon is never collected
  let windowsTray: WindowsTray | null = null;
  let trayItems: TrayItem[] = [];
  /** The newest tooltip (updateTray): the Windows icon starts on a worker, and updates before it is up are applied once it is. */
  let trayTooltip = '';
  // Windows: a balloon on our own tray icon (a toast on Windows 10/11); its click comes back through the tray worker.
  const winNotify = Deno.build.os === 'windows'
    ? windowsNotify({
      balloon: (title, body) => (windowsTray ? windowsTray.balloon(title, body) : null),
      quietState: userNotificationState,
    })
    : null;
  const notifier: OsNotify | null = winNotify ?? posixNotify(Deno.build.os);
  const menuOf = (items: TrayItem[]) => items.map((i) => ({ item: { label: i.label, id: i.id, enabled: !i.disabled } }));
  const denoTray = (
    icon: Uint8Array,
    tooltip: string,
    items: TrayItem[],
    onClick: () => void,
    onMenu: (id: string) => void,
  ) => {
    tray = new D.Tray();
    try {
      tray.setIcon(icon);
    } catch { /* the OS default */ }
    tray.setTooltip(tooltip);
    tray.setMenu(menuOf(items));
    tray.addEventListener('click', () => onClick());
    tray.addEventListener('menuclick', (e: Any) => onMenu(String(e?.detail?.id ?? '')));
  };
  return {
    createWindow: (o) => {
      const win = wrapWindow(new D.BrowserWindow({ title: o.title, width: o.width, height: o.height }));
      giveWindowsAppIcon();
      return win;
    },
    createKeeper() {
      if (keeper) return keeper;
      // DesktopApp.keepKeeperHidden keeps it on about:blank and hides it again on any load or focus (and the watchdog when
      // isVisible() says it shows).
      return keeper = invisibleWindow();
    },
    createTray(
      icon: Uint8Array,
      tooltip: string,
      items: TrayItem[],
      onClick: () => void,
      onMenu: (id: string) => void,
    ) {
      // Windows: Deno.Tray's icon never gets its clicks (tray_win.ts), so AIB runs its own icon on a worker thread; Deno.Tray only
      // if that can't start. Elsewhere Deno.Tray.
      trayItems = items.map((i) => ({ ...i }));
      trayTooltip = tooltip;
      if (Deno.build.os === 'windows') {
        void startWindowsTray(icon, tooltip, items, onClick, onMenu, (m) => log.info(m), { onBalloonClick: () => winNotify?.clicked() })
          .then((t) => {
            // The first tray tick (status line, "AIB · Phone access on · ...") runs before the worker's icon is up: apply it now.
            if (t) {
              windowsTray = t;
              trayItems.forEach((item, i) => {
                if (item.label !== items[i]?.label) t.setItemLabel(i, item.label, !!item.disabled);
              });
              if (trayTooltip !== tooltip) t.setTooltip(trayTooltip);
            } else denoTray(icon, trayTooltip, trayItems, onClick, onMenu);
            writeTrayState('app', { shown: true, tooltip: trayTooltip, icons: t ? t.icons.map(String) : [] });
          });
        return;
      }
      denoTray(icon, tooltip, items, onClick, onMenu);
    },
    updateTray(tooltip: string, index: number, label: string) {
      if (trayItems[index]) trayItems[index].label = label;
      trayTooltip = tooltip;
      if (windowsTray) {
        windowsTray.setItemLabel(index, label, !!trayItems[index]?.disabled);
        windowsTray.setTooltip(tooltip);
        return;
      }
      try {
        tray?.setTooltip(tooltip);
        tray?.setMenu(menuOf(trayItems));
      } catch { /* not fatal */ }
    },
    removeTray() {
      windowsTray?.remove();
      windowsTray = null;
      try {
        tray?.destroy?.();
      } catch { /* gone */ }
    },
    ask,
    openExternal,
    notifier,
    bringToFront: Deno.build.os === 'windows' ? () => bringToFront() : undefined,
  };
}

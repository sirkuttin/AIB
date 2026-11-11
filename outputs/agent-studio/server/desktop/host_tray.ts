/**
 * The agent host's own tray icon (docs/agent-host.md, "Lifecycle"). The host shows it only while no AIB app is attached and something
 * is working, so a host that outlives its app is never invisible; exactly one AIB icon shows at a time (the app has its own while
 * it is attached). Tooltip "AIB · 2 chats running" (or "AIB · 1 chat needs you", with the attention image), plus "(data: <folder>)"
 * for a non-default data folder. Menu: Open AIB (starts the app, or shows the running one), a greyed status line, and Stop chats
 * and quit (asks first: their current turn is interrupted).
 *
 * Windows: the worker-thread icon of tray_win.ts (Deno.Tray's own icon never gets its clicks there), started once, hidden and shown
 * as needed; it needs no window of the host's own. macOS and Linux: Deno.Tray, which exists only inside a `deno desktop` binary and
 * has not been run inside the window-less `AIB host` on a real Mac or Linux desktop yet; when it is missing or fails, the host logs
 * it and simply relies on its short idle exit. Stop chats and quit asks first on Windows only (a MessageBox on a worker thread);
 * elsewhere it stops at once.
 *
 * Tests: AIB_TEST_TRAY_STATE=<folder> makes every tray write its state to <folder>/<role>-<pid>.json on each change (an invisible
 * test desktop has no taskbar to look at). work/deno/host_lifecycle_test.ts covers the rules with a fake tray.
 */
import type { TrayItem } from './window.ts';
import { startWindowsTray, type WindowsTray } from './tray_win.ts';
import { trayIconPng } from './tray_icon.ts';
import { withAttentionDot } from './png_badge.ts';

export interface HostTrayView {
  tooltip: string;
  /** The greyed status line in the menu: "2 chats running", "1 chat needs you". */
  status: string;
  /** A chat waits for the person: the attention image. */
  attention: boolean;
}

/** What the host's icon says for `working` things working, `needsYou` of them waiting for the person, and a non-default data folder. */
export function hostTrayView(working: number, needsYou: number, dataFolder = ''): HostTrayView {
  const plural = (n: number) => `${n} chat${n === 1 ? '' : 's'}`;
  const status = needsYou ? `${plural(needsYou)} need${needsYou === 1 ? 's' : ''} you` : `${plural(working)} running`;
  const extra = needsYou && working > needsYou ? `, ${working - needsYou} running` : '';
  return { tooltip: `AIB · ${status}${extra}${dataFolder ? ` (data: ${dataFolder})` : ''}`, status: status + extra, attention: needsYou > 0 };
}

export const HOST_TRAY_ITEMS: TrayItem[] = [
  { id: 'open', label: 'Open AIB' },
  { id: 'status', label: '', disabled: true },
  { id: 'stop', label: 'Stop chats and quit' },
];

export function stopQuestion(view: HostTrayView): string {
  return `Stop chats and quit AIB?\n\n${view.status}. Their current turn is interrupted.`;
}

export interface HostTray {
  /** Shows the icon with this view, or updates it when it already shows. Never throws. */
  show(view: HostTrayView): void;
  /** Takes the icon away. Never throws. */
  hide(): void;
  /** Removes it for good (the host is exiting). Never throws. */
  close(): void;
}

/** onStop runs only after the person confirmed. */
export type HostTrayFactory = (onOpen: () => void, onStop: () => void, onLog: (message: string) => void) => HostTray;

// deno-lint-ignore no-explicit-any
type Any = any;

/** AIB_TEST_TRAY_STATE: write {role, pid, shown, tooltip, status, attention, items, icons} to <folder>/<role>-<pid>.json (icons:
 * Windows icon handles, [normal, attention] for the host, [icon] for the app). Never throws. */
export function writeTrayState(role: string, state: Record<string, unknown>): void {
  let folder: string | undefined;
  try {
    folder = Deno.env.get('AIB_TEST_TRAY_STATE');
  } catch { /* no env access */ }
  if (!folder) return;
  try {
    const sep = Deno.build.os === 'windows' ? '\\' : '/';
    const path = `${folder}${sep}${role}-${Deno.pid}.json`;
    // Merged over what this process wrote before: the app's icon is reported from two places (native.ts once the Windows icon is up,
    // with its icon handles; window.ts with the tray-only status line), and the later write must not drop the other's fields.
    let before: Record<string, unknown> = {};
    try {
      before = JSON.parse(Deno.readTextFileSync(path));
    } catch { /* first write */ }
    Deno.writeTextFileSync(`${path}.tmp`, JSON.stringify({ ...before, role, pid: Deno.pid, at: Date.now(), ...state }));
    Deno.renameSync(`${path}.tmp`, path);
  } catch { /* tests only */ }
}

/** The real icon (see the file comment). */
export const nativeHostTray: HostTrayFactory = (onOpen, onStop, onLog) => {
  let view: HostTrayView | null = null; // what should show; null = hidden
  let closed = false;
  let asking = false;
  let iconHandles: string[] = []; // Windows: the worker's icon handles, for tests that read the icon's pixels
  const report = (shown: boolean) =>
    writeTrayState('host', {
      shown,
      ...(view ?? {}),
      items: HOST_TRAY_ITEMS.map((i) => (i.id === 'status' ? view?.status ?? '' : i.label)),
      icons: iconHandles,
    });
  const confirmStop = async () => {
    if (asking || !view) return;
    asking = true;
    try {
      let ok = true;
      if (Deno.build.os === 'windows') {
        const ask = (await import('./native.ts')).windowsAsk();
        ok = ask ? await ask(stopQuestion(view)) : true;
      }
      if (ok) onStop();
      else onLog('tray: Stop chats and quit cancelled');
    } finally {
      asking = false;
    }
  };
  const onMenu = (id: string) => (id === 'open' ? onOpen() : id === 'stop' ? void confirmStop() : undefined);

  if (Deno.build.os === 'windows') {
    let tray: WindowsTray | null = null;
    let starting = false;
    let shown = false;
    const apply = () => {
      report(!!view && !closed);
      if (!tray || closed) return;
      if (!view) {
        if (shown) tray.hide();
        shown = false;
        return;
      }
      tray.setIcon(view.attention ? 1 : 0);
      tray.setItemLabel(1, view.status, true);
      if (!shown) tray.show();
      shown = true;
      tray.setTooltip(view.tooltip); // every call: after Explorer restarts or a fresh show the icon needs its current text
    };
    const start = async () => {
      starting = true;
      const icon = trayIconPng();
      const t = await startWindowsTray(icon, view?.tooltip ?? 'AIB', HOST_TRAY_ITEMS, onOpen, onMenu, onLog, {
        hidden: true,
        altIcons: [await withAttentionDot(icon)],
      });
      if (!t) onLog('host tray: could not start the tray icon');
      if (t) iconHandles = t.icons.map(String);
      if (t && closed) t.remove();
      else tray = t;
      apply();
    };
    return {
      show(next) {
        view = next;
        if (!tray && !starting && !closed) void start();
        apply();
      },
      hide() {
        view = null;
        apply();
      },
      close() {
        view = null;
        report(false);
        closed = true;
        tray?.remove();
        tray = null;
      },
    };
  }

  let tray: Any = null;
  let attention: Uint8Array | null = null;
  const D = Deno as Any;
  const icon = trayIconPng();
  void withAttentionDot(icon).then((png) => (attention = png));
  return {
    show(next) {
      view = next;
      report(true);
      if (closed) return;
      try {
        if (!tray) {
          if (typeof D.Tray !== 'function') {
            onLog('host tray: Deno.Tray is not available in this program; relying on the idle exit');
            return;
          }
          tray = new D.Tray();
          tray.addEventListener('click', () => onOpen());
          tray.addEventListener('menuclick', (e: Any) => onMenu(String(e?.detail?.id ?? '')));
        }
        tray.setIcon(next.attention && attention ? attention : icon);
        tray.setTooltip(next.tooltip);
        tray.setMenu(
          HOST_TRAY_ITEMS.map((i) => ({ item: { label: i.id === 'status' ? next.status : i.label, id: i.id, enabled: !i.disabled } })),
        );
      } catch (error) {
        onLog(`host tray: ${error}`);
      }
    },
    hide() {
      view = null;
      report(false);
      if (!tray) return;
      try {
        tray.destroy?.();
      } catch { /* gone */ }
      tray = null;
    },
    close() {
      closed = true;
      this.hide();
    },
  };
};

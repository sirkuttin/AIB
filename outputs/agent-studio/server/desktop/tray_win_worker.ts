/**
 * The Windows tray icon's thread (see tray_win.ts for why it exists). Started by startWindowsTray(); gets one TrayWorkerStart,
 * makes a hidden window, adds the icon and then runs a Windows message loop for good: this thread does nothing else, so the loop
 * blocking it is fine. Clicks and menu choices go back to the main thread with postMessage.
 */
/// <reference lib="deno.worker" />
import {
  chosenItem,
  menuCommand,
  NIF_ICON,
  NIF_MESSAGE,
  NIF_TIP,
  NIM_ADD,
  NIM_DELETE,
  NIM_MODIFY,
  notifyIconData,
  TRAY_CALLBACK,
  TRAY_COMMAND,
  TRAY_HIDE,
  TRAY_REMOVE,
  TRAY_SET_ICON,
  TRAY_SHOW,
  TRAY_WINDOW_CLASS,
  trayEvent,
  trayMessageText,
  type TrayWorkerMessage,
  type TrayWorkerStart,
} from './tray_win.ts';

const post = (m: TrayWorkerMessage) => self.postMessage(m);

const wide = (s: string) => {
  const a = new Uint16Array(s.length + 1);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
};

function run(start: TrayWorkerStart): void {
  const user = Deno.dlopen('user32.dll', {
    RegisterClassExW: { parameters: ['buffer'], result: 'u16' },
    UnregisterClassW: { parameters: ['buffer', 'pointer'], result: 'i32' },
    CreateWindowExW: {
      parameters: ['u32', 'buffer', 'buffer', 'u32', 'i32', 'i32', 'i32', 'i32', 'pointer', 'pointer', 'pointer', 'pointer'],
      result: 'pointer',
    },
    DefWindowProcW: { parameters: ['pointer', 'u32', 'usize', 'isize'], result: 'isize' },
    DestroyWindow: { parameters: ['pointer'], result: 'i32' },
    PostQuitMessage: { parameters: ['i32'], result: 'void' },
    GetMessageW: { parameters: ['buffer', 'pointer', 'u32', 'u32'], result: 'i32' },
    TranslateMessage: { parameters: ['buffer'], result: 'i32' },
    DispatchMessageW: { parameters: ['buffer'], result: 'isize' },
    PostMessageW: { parameters: ['pointer', 'u32', 'usize', 'isize'], result: 'i32' },
    RegisterWindowMessageW: { parameters: ['buffer'], result: 'u32' },
    CreatePopupMenu: { parameters: [], result: 'pointer' },
    AppendMenuW: { parameters: ['pointer', 'u32', 'usize', 'buffer'], result: 'i32' },
    TrackPopupMenu: { parameters: ['pointer', 'u32', 'i32', 'i32', 'i32', 'pointer', 'pointer'], result: 'i32' },
    SetForegroundWindow: { parameters: ['pointer'], result: 'i32' },
    GetCursorPos: { parameters: ['buffer'], result: 'i32' },
    GetSystemMetrics: { parameters: ['i32'], result: 'i32' },
    CreateIconFromResourceEx: { parameters: ['buffer', 'u32', 'i32', 'u32', 'i32', 'i32', 'u32'], result: 'pointer' },
    LoadIconW: { parameters: ['pointer', 'pointer'], result: 'pointer' },
  });
  const shell = Deno.dlopen('shell32.dll', { Shell_NotifyIconW: { parameters: ['u32', 'buffer'], result: 'i32' } });
  const kernel = Deno.dlopen('kernel32.dll', { GetModuleHandleW: { parameters: ['pointer'], result: 'pointer' } });
  const u = user.symbols;

  const SM_CXSMICON = 49, SM_CYSMICON = 50;
  const MF_STRING = 0x0;
  const TPM_RIGHTBUTTON = 0x2, TPM_NONOTIFY = 0x80, TPM_RETURNCMD = 0x100;
  const WM_NULL = 0x0, WM_DESTROY = 0x2;
  const WS_POPUP = 0x80000000, WS_EX_TOOLWINDOW = 0x80;

  // The icon: the app's PNG (CreateIconFromResourceEx takes PNG data since Vista), else the stock application icon.
  const cx = u.GetSystemMetrics(SM_CXSMICON) || 16, cy = u.GetSystemMetrics(SM_CYSMICON) || 16;
  const makeIcon = (png: Uint8Array) => {
    let h = png.length ? u.CreateIconFromResourceEx(new Uint8Array(png), png.length, 1, 0x00030000, cx, cy, 0) : null;
    if (!h) h = u.LoadIconW(null, Deno.UnsafePointer.create(32512n)); // IDI_APPLICATION
    return BigInt(Deno.UnsafePointer.value(h));
  };
  const icons = [start.icon, ...(start.altIcons ?? [])].map(makeIcon);
  let iconValue = icons[0];

  const menu = u.CreatePopupMenu();
  const MF_GRAYED = 0x1;
  start.items.forEach((item, i) => u.AppendMenuW(menu, MF_STRING | (item.disabled ? MF_GRAYED : 0), BigInt(menuCommand(i)), wide(item.label)));

  const taskbarCreated = u.RegisterWindowMessageW(wide('TaskbarCreated'));
  let hwndValue = 0n;
  let shown = !start.hidden;
  const tip = start.tooltip;
  const addIcon = () =>
    shell.symbols.Shell_NotifyIconW(
      NIM_ADD,
      notifyIconData({
        hwnd: hwndValue,
        flags: NIF_MESSAGE | NIF_ICON | NIF_TIP,
        callbackMessage: TRAY_CALLBACK,
        hIcon: iconValue,
        tip,
      }),
    ) !== 0;

  const showMenu = (hwnd: Deno.PointerValue) => {
    const pt = new Int32Array(2);
    u.GetCursorPos(pt);
    // A visible-to-Windows owner in the foreground, so a click anywhere else closes the menu; WM_NULL afterwards is the
    // documented fix for a menu that won't open a second time.
    u.SetForegroundWindow(hwnd);
    const command = u.TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY, pt[0], pt[1], 0, hwnd, null);
    u.PostMessageW(hwnd, WM_NULL, 0n, 0n);
    const id = chosenItem(start.items, command);
    if (id && !start.items[command - 1]?.disabled) post({ type: 'menu', id });
  };

  const WM_APP = 0x8000, WM_MOUSEMOVE = 0x0200;
  let lastWasMove = false;
  const wndProc = new Deno.UnsafeCallback(
    { parameters: ['pointer', 'u32', 'usize', 'isize'], result: 'isize' } as const,
    (hwnd, msg, wParam, lParam) => {
      try {
        // Every message of ours (and Explorer's TaskbarCreated) goes to studio.log; the mouse moving over the icon only once per run
        // of moves, so hovering can't flood the log.
        if (msg >= WM_APP || (taskbarCreated && msg === taskbarCreated)) {
          const move = msg === TRAY_CALLBACK && trayEvent(lParam) === null && (Number(BigInt.asUintN(64, BigInt(lParam)) & 0xffffn) === WM_MOUSEMOVE);
          if (!move || !lastWasMove) post({ type: 'log', message: trayMessageText(msg, wParam, lParam) });
          lastWasMove = move;
        }
        if (msg === TRAY_CALLBACK) {
          const what = trayEvent(lParam);
          if (what === 'click') post({ type: 'click' });
          else if (what === 'balloon-click') post({ type: 'balloon-click' });
          else if (what === 'menu') showMenu(hwnd);
          return 0n;
        }
        if (msg === TRAY_SHOW) {
          if (!shown) shown = addIcon();
          return 0n;
        }
        if (msg === TRAY_HIDE) {
          if (shown) shell.symbols.Shell_NotifyIconW(NIM_DELETE, notifyIconData({ hwnd: hwndValue, flags: 0 }));
          shown = false;
          return 0n;
        }
        if (msg === TRAY_SET_ICON) {
          const next = icons[Number(wParam)];
          if (next !== undefined && next !== iconValue) {
            iconValue = next;
            if (shown) shell.symbols.Shell_NotifyIconW(NIM_MODIFY, notifyIconData({ hwnd: hwndValue, flags: NIF_ICON, hIcon: iconValue }));
          }
          return 0n;
        }
        if (msg === TRAY_COMMAND) {
          const item = start.items[Number(wParam) - 1];
          if (item?.disabled) return 0n;
          const id = chosenItem(start.items, Number(wParam));
          if (id) post({ type: 'menu', id });
          return 0n;
        }
        if (msg === TRAY_REMOVE) {
          shell.symbols.Shell_NotifyIconW(NIM_DELETE, notifyIconData({ hwnd: hwndValue, flags: 0 }));
          u.DestroyWindow(hwnd);
          return 0n;
        }
        if (msg === WM_DESTROY) {
          u.PostQuitMessage(0);
          return 0n;
        }
        if (taskbarCreated && msg === taskbarCreated) {
          if (shown) addIcon(); // Explorer restarted: the icon must be added again
          return 0n;
        }
      } catch (error) {
        post({ type: 'log', message: `tray window: ${error}` });
      }
      return u.DefWindowProcW(hwnd, msg, wParam, lParam);
    },
  );

  const hInstance = kernel.symbols.GetModuleHandleW(null);
  const className = wide(TRAY_WINDOW_CLASS);
  const wc = new Uint8Array(80); // WNDCLASSEXW, 64-bit layout
  const wv = new DataView(wc.buffer);
  wv.setUint32(0, 80, true); // cbSize
  wv.setBigUint64(8, BigInt(Deno.UnsafePointer.value(wndProc.pointer)), true); // lpfnWndProc
  wv.setBigUint64(24, BigInt(Deno.UnsafePointer.value(hInstance)), true); // hInstance
  wv.setBigUint64(64, BigInt(Deno.UnsafePointer.value(Deno.UnsafePointer.of(className))), true); // lpszClassName
  if (!u.RegisterClassExW(wc)) throw new Error('RegisterClassExW failed');
  // A hidden top-level window (never shown), not a message-only one: SetForegroundWindow and the popup menu need a real owner.
  const hwnd = u.CreateWindowExW(WS_EX_TOOLWINDOW, className, wide('AIB tray'), WS_POPUP, 0, 0, 0, 0, null, null, hInstance, null);
  if (!hwnd) throw new Error('CreateWindowExW failed');
  hwndValue = BigInt(Deno.UnsafePointer.value(hwnd));

  post({
    type: 'ready',
    hwnd: String(hwndValue),
    added: shown ? (shown = addIcon()) : false,
    menu: String(BigInt(Deno.UnsafePointer.value(menu))),
    icons: icons.map(String),
  });

  const msg = new Uint8Array(48); // MSG
  while (u.GetMessageW(msg, null, 0, 0) > 0) {
    u.TranslateMessage(msg);
    u.DispatchMessageW(msg);
  }
  u.UnregisterClassW(className, hInstance); // a later tray in this process registers the class again with its own procedure
  wndProc.close();
  self.close();
}

self.onmessage = (e: MessageEvent<TrayWorkerStart>) => {
  self.onmessage = null;
  try {
    run(e.data);
  } catch (error) {
    post({ type: 'failed', error: String(error) });
  }
};

/**
 * Real-binary tests on Windows: start a program on a separate, invisible Win32 desktop (CreateDesktopW + STARTUPINFO.lpDesktop), so
 * no window, dialog or tray icon of the app ever shows on the person's screen; everything it starts inherits that desktop. Also lists
 * and messages the windows there (WM_CLOSE for "the person closed the window"). The caller kills the processes it started.
 */
const u32 = Deno.build.os === 'windows'
  ? Deno.dlopen('user32.dll', {
    CreateDesktopW: { parameters: ['buffer', 'pointer', 'pointer', 'u32', 'u32', 'pointer'], result: 'pointer' },
    CloseDesktop: { parameters: ['pointer'], result: 'i32' },
    EnumDesktopWindows: { parameters: ['pointer', 'function', 'isize'], result: 'i32' },
    GetWindowThreadProcessId: { parameters: ['pointer', 'buffer'], result: 'u32' },
    GetWindowTextW: { parameters: ['pointer', 'buffer', 'i32'], result: 'i32' },
    GetClassNameW: { parameters: ['pointer', 'buffer', 'i32'], result: 'i32' },
    IsWindowVisible: { parameters: ['pointer'], result: 'i32' },
    PostMessageW: { parameters: ['pointer', 'u32', 'usize', 'isize'], result: 'i32' },
  })
  : null;
const k32 = Deno.build.os === 'windows'
  ? Deno.dlopen('kernel32.dll', {
    CreateProcessW: {
      parameters: ['pointer', 'buffer', 'pointer', 'pointer', 'i32', 'u32', 'pointer', 'buffer', 'buffer', 'buffer'],
      result: 'i32',
    },
    CloseHandle: { parameters: ['pointer'], result: 'i32' },
    GetLastError: { parameters: [], result: 'u32' },
  })
  : null;

const wide = (s: string) => {
  const a = new Uint16Array(s.length + 1);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
};

export interface DeskWindow {
  handle: Deno.PointerValue;
  pid: number;
  title: string;
  cls: string;
  visible: boolean;
}

export class HiddenDesktop {
  readonly name = `aib-e2e-${Deno.pid}-${Date.now()}`;
  #desk: Deno.PointerValue;

  constructor() {
    if (!u32) throw new Error('Windows only');
    this.#desk = u32.symbols.CreateDesktopW(wide(this.name), null, null, 0, 0x10000000, null);
    if (!this.#desk) throw new Error('CreateDesktopW failed');
  }

  /** Start a program there with this process's environment. Returns its pid. */
  spawn(command: string[], cwd: string): number {
    const quote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
    const desk = wide(`WinSta0\\${this.name}`);
    const si = new Uint8Array(104);
    const v = new DataView(si.buffer);
    v.setUint32(0, 104, true);
    v.setBigUint64(16, BigInt(Deno.UnsafePointer.value(Deno.UnsafePointer.of(desk))), true);
    const pi = new Uint8Array(24);
    const ok = k32!.symbols.CreateProcessW(null, wide(command.map(quote).join(' ')), null, null, 0, 0, null, wide(cwd), si, pi);
    if (!ok) throw new Error('CreateProcessW failed ' + k32!.symbols.GetLastError());
    const pv = new DataView(pi.buffer);
    k32!.symbols.CloseHandle(Deno.UnsafePointer.create(pv.getBigUint64(0, true)));
    k32!.symbols.CloseHandle(Deno.UnsafePointer.create(pv.getBigUint64(8, true)));
    return pv.getUint32(16, true);
  }

  windows(): DeskWindow[] {
    const out: DeskWindow[] = [];
    const cb = new Deno.UnsafeCallback({ parameters: ['pointer', 'isize'], result: 'i32' } as const, (h) => {
      const p = new Uint32Array(1);
      u32!.symbols.GetWindowThreadProcessId(h, p);
      const t = new Uint16Array(256), c = new Uint16Array(256);
      const tn = u32!.symbols.GetWindowTextW(h, t, 256), cn = u32!.symbols.GetClassNameW(h, c, 256);
      out.push({
        handle: h,
        pid: p[0],
        title: String.fromCharCode(...t.subarray(0, tn)),
        cls: String.fromCharCode(...c.subarray(0, cn)),
        visible: !!u32!.symbols.IsWindowVisible(h),
      });
      return 1;
    });
    u32!.symbols.EnumDesktopWindows(this.#desk, cb.pointer, 0n);
    cb.close();
    return out;
  }

  post(w: DeskWindow, message: number, wParam = 0n, lParam = 0n): boolean {
    return u32!.symbols.PostMessageW(w.handle, message, wParam, lParam) !== 0;
  }

  close(): void {
    if (this.#desk) u32!.symbols.CloseDesktop(this.#desk);
    this.#desk = null;
  }
}

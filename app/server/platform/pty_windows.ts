/**
 * Windows pseudo console (ConPTY) through FFI, for pty.ts. Windows 10 1809 or later.
 *
 *   CreatePipe x2            our write end -> console input; console output -> our read end
 *   CreatePseudoConsole      a headless console host on those pipes (no window, ever)
 *   CreateProcessW           STARTUPINFOEX with PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, created suspended, put in a Job Object
 *                            (KILL_ON_JOB_CLOSE: the shell and all it starts die with the job, also when AIB itself dies), resumed
 *   ReadFile / WriteFile     on Deno's blocking-call threads (nonblocking FFI symbols), so the event loop never waits on a pipe
 *   ResizePseudoConsole      on resize
 *   kill                     TerminateJobObject, then ClosePseudoConsole (also on a blocking thread: it waits for the output to drain)
 *
 * The symbols are opened here rather than in win32.ts because several are nonblocking (each such call holds a thread of Deno's pool
 * until it returns: one read and one wait per running shell).
 */
import type { Pty, PtyOptions } from './pty.ts';
import { quoteWindowsArg } from './spawn_detached.ts';
import { wide } from './win32.ts';

const symbols = {
  GetLastError: { parameters: [], result: 'u32' },
  CloseHandle: { parameters: ['pointer'], result: 'i32' },
  CreatePipe: { parameters: ['buffer', 'buffer', 'pointer', 'u32'], result: 'i32' },
  CreatePseudoConsole: { parameters: ['u32', 'pointer', 'pointer', 'u32', 'buffer'], result: 'i32' },
  ResizePseudoConsole: { parameters: ['pointer', 'u32'], result: 'i32' },
  ClosePseudoConsoleAsync: { name: 'ClosePseudoConsole', parameters: ['pointer'], result: 'void', nonblocking: true },
  InitializeProcThreadAttributeList: { parameters: ['pointer', 'u32', 'u32', 'buffer'], result: 'i32' },
  UpdateProcThreadAttribute: { parameters: ['buffer', 'u32', 'usize', 'pointer', 'usize', 'pointer', 'pointer'], result: 'i32' },
  DeleteProcThreadAttributeList: { parameters: ['buffer'], result: 'void' },
  CreateProcessW: {
    parameters: ['pointer', 'buffer', 'pointer', 'pointer', 'i32', 'u32', 'pointer', 'buffer', 'buffer', 'buffer'],
    result: 'i32',
  },
  ResumeThread: { parameters: ['pointer'], result: 'u32' },
  ReadFileAsync: { name: 'ReadFile', parameters: ['pointer', 'buffer', 'u32', 'buffer', 'pointer'], result: 'i32', nonblocking: true },
  WriteFileAsync: { name: 'WriteFile', parameters: ['pointer', 'buffer', 'u32', 'buffer', 'pointer'], result: 'i32', nonblocking: true },
  WaitForSingleObjectAsync: { name: 'WaitForSingleObject', parameters: ['pointer', 'u32'], result: 'u32', nonblocking: true },
  GetExitCodeProcess: { parameters: ['pointer', 'buffer'], result: 'i32' },
  CreateJobObjectW: { parameters: ['pointer', 'pointer'], result: 'pointer' },
  SetInformationJobObject: { parameters: ['pointer', 'i32', 'buffer', 'u32'], result: 'i32' },
  AssignProcessToJobObject: { parameters: ['pointer', 'pointer'], result: 'i32' },
  TerminateJobObject: { parameters: ['pointer', 'u32'], result: 'i32' },
  TerminateProcess: { parameters: ['pointer', 'u32'], result: 'i32' },
  QueryInformationJobObject: { parameters: ['pointer', 'i32', 'buffer', 'u32', 'pointer'], result: 'i32' },
} as const;

let lib: Deno.DynamicLibrary<typeof symbols> | null = null;
function k32(): Deno.DynamicLibrary<typeof symbols>['symbols'] {
  if (Deno.build.os !== 'windows') throw new Error('ConPTY is only available on Windows');
  lib ??= Deno.dlopen('kernel32.dll', symbols);
  return lib.symbols;
}

const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016n;
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
const CREATE_SUSPENDED = 0x00000004;
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const STARTF_USESTDHANDLES = 0x00000100;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
const INFINITE = 0xffffffff;
const READ_SIZE = 64 * 1024;

const coord = (cols: number, rows: number) => ((rows & 0xffff) << 16 | (cols & 0xffff)) >>> 0;
const ptrAt = (bytes: Uint8Array, offset: number) =>
  Deno.UnsafePointer.create(new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(offset, true));

function environmentBlock(extra: Record<string, string>): Uint16Array<ArrayBuffer> {
  const env = { ...Deno.env.toObject(), ...extra };
  const entries = Object.entries(env).filter(([k]) => k && !k.includes('=')).sort(([a], [b]) => {
    const x = a.toUpperCase(), y = b.toUpperCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return wide(entries.map(([k, v]) => `${k}=${v}`).join('\0') + '\0');
}

function makeJob(): Deno.PointerValue {
  const k = k32();
  const job = k.CreateJobObjectW(null, null);
  if (job === null) return null;
  const info = new Uint8Array(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (64-bit); LimitFlags at offset 16
  new DataView(info.buffer).setUint32(16, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
  if (!k.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, info, info.byteLength)) {
    k.CloseHandle(job);
    return null;
  }
  return job;
}

export function spawnConPty(options: PtyOptions): Pty {
  const k = k32();
  const close = (h: Deno.PointerValue) => {
    if (h !== null) k.CloseHandle(h);
  };
  const pipe = (): [Deno.PointerValue, Deno.PointerValue] => {
    const r = new Uint8Array(8), w = new Uint8Array(8);
    if (!k.CreatePipe(r, w, null, 0)) throw new Error(`CreatePipe failed (error ${k.GetLastError()})`);
    return [ptrAt(r, 0), ptrAt(w, 0)];
  };
  const [inRead, inWrite] = pipe(); // we write inWrite; the console reads inRead
  let outRead: Deno.PointerValue = null, outWrite: Deno.PointerValue = null;
  try {
    [outRead, outWrite] = pipe();
  } catch (error) {
    close(inRead), close(inWrite);
    throw error;
  }
  const hpcBox = new Uint8Array(8);
  const hr = k.CreatePseudoConsole(coord(options.cols, options.rows), inRead, outWrite, 0, hpcBox);
  close(inRead);
  close(outWrite); // the console host holds its own copies
  if (hr !== 0) {
    close(inWrite), close(outRead);
    throw new Error(`CreatePseudoConsole failed (HRESULT 0x${(hr >>> 0).toString(16)})`);
  }
  const hpc = ptrAt(hpcBox, 0);

  let job: Deno.PointerValue = null;
  let process: Deno.PointerValue = null;
  let pid = 0;
  try {
    const sizeBox = new BigUint64Array(1);
    k.InitializeProcThreadAttributeList(null, 1, 0, new Uint8Array(sizeBox.buffer));
    const attrs = new Uint8Array(Number(sizeBox[0]) || 64);
    if (!k.InitializeProcThreadAttributeList(Deno.UnsafePointer.of(attrs), 1, 0, new Uint8Array(sizeBox.buffer))) {
      throw new Error(`InitializeProcThreadAttributeList failed (error ${k.GetLastError()})`);
    }
    try {
      // lpValue is the HPCON itself, not a pointer to it.
      if (!k.UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hpc, 8n, null, null)) {
        throw new Error(`UpdateProcThreadAttribute failed (error ${k.GetLastError()})`);
      }
      const startup = new Uint8Array(112); // STARTUPINFOEXW (64-bit)
      const view = new DataView(startup.buffer);
      view.setUint32(0, 112, true);
      // No std handles of ours: the shell must use the pseudo console, never AIB's own (hidden) console or pipes.
      view.setUint32(60, STARTF_USESTDHANDLES, true);
      view.setBigUint64(104, BigInt(Deno.UnsafePointer.value(Deno.UnsafePointer.of(attrs))), true);
      const info = new Uint8Array(24); // PROCESS_INFORMATION
      const commandLine = wide([options.file, ...options.args].map(quoteWindowsArg).join(' '));
      const env = environmentBlock(options.env ?? {});
      const cwd = wide(options.cwd);
      const ok = k.CreateProcessW(
        null,
        commandLine,
        null,
        null,
        0,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
        Deno.UnsafePointer.of(env),
        cwd,
        startup,
        info,
      );
      if (!ok) throw new Error(`Could not start ${options.file} (error ${k.GetLastError()})`);
      process = ptrAt(info, 0);
      const thread = ptrAt(info, 8);
      pid = new DataView(info.buffer).getUint32(16, true);
      job = makeJob();
      if (job !== null && !k.AssignProcessToJobObject(job, process)) {
        close(job);
        job = null;
      }
      k.ResumeThread(thread);
      close(thread);
    } finally {
      k.DeleteProcThreadAttributeList(attrs);
    }
  } catch (error) {
    if (process !== null) {
      k.TerminateProcess(process, 1);
      close(process);
    }
    close(job);
    close(inWrite);
    // Closing the console drains its output first; read it on another thread so this cannot hang.
    void k.ClosePseudoConsoleAsync(hpc).finally(() => close(outRead));
    void drain(outRead);
    throw error;
  }

  let pcOpen = true;
  let closing: Promise<void> | null = null;
  const closeConsole = (): Promise<void> => {
    if (!pcOpen) return Promise.resolve();
    pcOpen = false;
    return k.ClosePseudoConsoleAsync(hpc);
  };

  const pty: Pty = {
    pid,
    onData: null,
    write(data) {
      if (closing || !pcOpen) return;
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      if (!bytes.length) return;
      writes = writes.then(async () => {
        if (!pcOpen) return;
        const copy = new Uint8Array(bytes); // stays alive (and unmoved) until the call returns
        const written = new Uint32Array(1);
        await k.WriteFileAsync(inWrite, copy, copy.byteLength, new Uint8Array(written.buffer), null);
      }).catch(() => {});
    },
    resize(cols, rows) {
      if (pcOpen) k.ResizePseudoConsole(hpc, coord(cols, rows));
    },
    terminate() {
      if (job !== null) k.TerminateJobObject(job, 1);
      else if (process !== null) k.TerminateProcess(process, 1);
    },
    busy() {
      if (job === null) return false;
      const info = new Uint8Array(48); // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION; ActiveProcesses at offset 40
      if (!k.QueryInformationJobObject(job, JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION, info, info.byteLength, null)) return false;
      return new DataView(info.buffer).getUint32(40, true) > 1;
    },
    kill() {
      closing ??= (async () => {
        pty.terminate();
        await pty.exited;
      })();
      return closing;
    },
    exited: null as unknown as Promise<number>,
  };
  let writes: Promise<void> = Promise.resolve();

  const reading = (async () => {
    const buffer = new Uint8Array(READ_SIZE);
    const count = new Uint32Array(1);
    const countBytes = new Uint8Array(count.buffer);
    while (true) {
      const ok = await k.ReadFileAsync(outRead, buffer, READ_SIZE, countBytes, null);
      if (!ok || count[0] === 0) break; // broken pipe: the console host is gone
      try {
        pty.onData?.(buffer.slice(0, count[0]));
      } catch { /* a listener's error is not the terminal's */ }
    }
  })();

  (pty as { exited: Promise<number> }).exited = (async () => {
    await k.WaitForSingleObjectAsync(process, INFINITE);
    const code = new Uint32Array(1);
    k.GetExitCodeProcess(process, new Uint8Array(code.buffer));
    // The console host keeps the output pipe open until it is closed; closing it ends the read loop after the last output.
    await closeConsole();
    await reading;
    await writes;
    close(outRead);
    close(inWrite);
    close(process);
    process = null;
    if (job !== null) {
      k.TerminateJobObject(job, 1); // anything the shell left running in the background
      close(job);
      job = null;
    }
    return code[0] | 0;
  })();
  return pty;
}

/** Read and discard until the pipe breaks (used when start-up fails after the console was made). */
async function drain(handle: Deno.PointerValue): Promise<void> {
  const k = k32();
  const buffer = new Uint8Array(4096);
  const count = new Uint8Array(4);
  try {
    while (await k.ReadFileAsync(handle, buffer, buffer.byteLength, count, null)) { /* discard */ }
  } catch { /* closed */ }
}

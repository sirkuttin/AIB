/**
 * "Keep this PC awake while AIB runs" (Settings > server > keepAwake). AIB never changes a system power setting: it holds one
 * temporary request with the OS, and the OS drops it when this process ends (a crash included), so a request cannot be left behind.
 *   Windows  a power request (PowerCreateRequest + PowerSetRequest, system and execution required): holds Modern Standby too, which
 *            SetThreadExecutionState alone may not. Released with PowerClearRequest + CloseHandle.
 *   macOS    `caffeinate -i -w <AIB pid>` (no window; ends by itself when AIB exits).
 *   Linux    a logind inhibitor: `systemd-inhibit --what=idle:sleep` around a loop that ends when AIB's pid is gone. Best effort:
 *            without systemd-inhibit the setting reports why it could not hold.
 * The screen can still turn off and closing a laptop lid still sleeps the PC (the page says so).
 * Only the desktop app and `AIB serve` take a real request: tests get a recording backend or none (see realBackend).
 */

/** A taken request. release() is idempotent and never throws. */
export interface Hold {
  release(): void;
}

/** One way of asking the OS. acquire() throws an Error whose message is shown to the owner when the OS refuses. */
export interface Backend {
  name: string;
  /** onEnd: the request ended without release() (the helper process died); the message says why. */
  acquire(onEnd: (why: string) => void): Hold;
}

export interface KeepAwakeStatus {
  /** The setting as last applied. */
  on: boolean;
  /** A request is held right now. */
  active: boolean;
  /** Why the OS refused or dropped the request; '' when fine. */
  error: string;
  /** Which backend ('windows-power-request', 'caffeinate', 'systemd-inhibit', 'none' when this run takes no request). */
  backend: string;
}

export class KeepAwake {
  #hold: Hold | null = null;
  #on = false;
  #error = "";

  constructor(readonly backend: Backend | null) {}

  /** Turn the request on or off; takes effect now. Never throws: a refusal is in status().error. */
  apply(on: boolean): KeepAwakeStatus {
    this.#on = on;
    if (!on) {
      this.#drop();
      this.#error = "";
    } else if (!this.#hold) {
      this.#error = "";
      if (this.backend) {
        try {
          const hold: Hold = this.backend.acquire((why) => {
            if (this.#hold === hold) {
              this.#hold = null;
              this.#error = why;
            }
          });
          this.#hold = hold;
        } catch (error) {
          this.#error = error instanceof Error ? error.message : String(error);
        }
      }
    }
    return this.status();
  }

  /** AIB is closing: drop the request (the OS would anyway). */
  release(): void {
    this.#drop();
  }

  status(): KeepAwakeStatus {
    return {
      on: this.#on,
      active: this.#hold !== null,
      error: this.#error,
      backend: this.backend?.name ?? "none",
    };
  }

  #drop(): void {
    const hold = this.#hold;
    this.#hold = null;
    try {
      hold?.release();
    } catch { /* released as far as we can tell */ }
  }
}

// ---- Windows ----------------------------------------------------------------------------------------------------------

const POWER_REQUEST_SYSTEM_REQUIRED = 1;
const POWER_REQUEST_EXECUTION_REQUIRED = 3;
const POWER_REQUEST_CONTEXT_SIMPLE_STRING = 1;
const INVALID_HANDLE = 0xFFFFFFFFFFFFFFFFn;

function openKernel() {
  return Deno.dlopen("kernel32.dll", {
    PowerCreateRequest: { parameters: ["buffer"], result: "u64" },
    PowerSetRequest: { parameters: ["u64", "i32"], result: "i32" },
    PowerClearRequest: { parameters: ["u64", "i32"], result: "i32" },
    CloseHandle: { parameters: ["u64"], result: "i32" },
    GetLastError: { parameters: [], result: "u32" },
  }).symbols;
}

/** The Windows power-request backend. The reason text shows in `powercfg /requests` (which needs admin to read). */
export function windowsBackend(
  reason = "AIB: keep this PC awake while AIB runs",
): Backend {
  return {
    name: "windows-power-request",
    acquire() {
      const k = openKernel();
      const text = new Uint16Array(reason.length + 1);
      for (let i = 0; i < reason.length; i++) text[i] = reason.charCodeAt(i);
      // REASON_CONTEXT: Version u32 @0, Flags u32 @4, SimpleReasonString pointer @8 (room left for the Detailed form).
      const ctx = new Uint8Array(48);
      const view = new DataView(ctx.buffer);
      view.setUint32(4, POWER_REQUEST_CONTEXT_SIMPLE_STRING, true);
      view.setBigUint64(
        8,
        BigInt(Deno.UnsafePointer.value(Deno.UnsafePointer.of(text))),
        true,
      );
      const handle = k.PowerCreateRequest(ctx);
      if (handle === INVALID_HANDLE || handle === 0n) {
        throw new Error(
          `Windows refused the request (error ${k.GetLastError()})`,
        );
      }
      const set: number[] = [];
      for (
        const type of [
          POWER_REQUEST_SYSTEM_REQUIRED,
          POWER_REQUEST_EXECUTION_REQUIRED,
        ]
      ) {
        if (k.PowerSetRequest(handle, type) !== 0) set.push(type);
      }
      if (!set.length) {
        const code = k.GetLastError();
        k.CloseHandle(handle);
        throw new Error(`Windows refused the request (error ${code})`);
      }
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          for (const type of set) k.PowerClearRequest(handle, type);
          k.CloseHandle(handle);
          void text; // kept alive until here: Windows reads the reason string while the request exists
        },
      };
    },
  };
}

// ---- macOS and Linux (a helper process) -------------------------------------------------------------------------------

/** A helper child that holds the request for as long as it runs. Killed on release; its exit before that is reported. */
export function helperBackend(
  name: string,
  command: string,
  args: string[],
  hint: string,
): Backend {
  return {
    name,
    acquire(onEnd) {
      let child: Deno.ChildProcess;
      try {
        child = new Deno.Command(command, {
          args,
          stdin: "null",
          stdout: "null",
          stderr: "null",
        }).spawn();
      } catch (error) {
        const missing = error instanceof Deno.errors.NotFound;
        throw new Error(
          missing
            ? `${command} is not available on this computer (${hint})`
            : `Could not start ${command}: ${error}`,
        );
      }
      let released = false;
      child.status.then((s) => {
        if (!released) {
          onEnd(
            `${command} stopped by itself (exit code ${s.code}), so the PC may sleep`,
          );
        }
      }, () => {});
      return {
        release() {
          if (released) return;
          released = true;
          try {
            child.kill();
          } catch { /* already gone */ }
        },
      };
    },
  };
}

export function macBackend(pid = Deno.pid): Backend {
  return helperBackend(
    "caffeinate",
    "caffeinate",
    ["-i", "-w", String(pid)],
    "it ships with macOS",
  );
}

export function linuxBackend(pid = Deno.pid): Backend {
  // The loop ends when AIB's pid is gone, so even a crash cannot leave the inhibitor behind.
  const loop = `while kill -0 ${pid} 2>/dev/null; do sleep 5; done`;
  return helperBackend("systemd-inhibit", "systemd-inhibit", [
    "--what=idle:sleep",
    "--who=AIB",
    "--why=Keep this PC awake while AIB runs",
    "--mode=block",
    "sh",
    "-c",
    loop,
  ], "it needs systemd");
}

/** The backend for an OS name (Deno.build.os); null for an OS with none. */
export function backendFor(os: string): Backend | null {
  switch (os) {
    case "windows":
      return windowsBackend();
    case "darwin":
      return macBackend();
    case "linux":
      return linuxBackend();
    default:
      return null;
  }
}

/** A backend that only records (tests). */
export function recordingBackend(
  record: (line: string) => void,
  fail = "",
): Backend {
  return {
    name: "recording",
    acquire() {
      if (fail) throw new Error(fail);
      record("acquire");
      return { release: () => record("release") };
    },
  };
}

/**
 * The backend this run uses. A test run (AGENT_STUDIO_TEST=1) takes no real request: with AIB_TEST_KEEP_AWAKE_LOG set it gets a
 * backend that appends "acquire" / "release" lines to that file (so an end-to-end test can see the setting work); without it, none.
 */
export function realBackend(
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
  os: string = Deno.build.os,
): Backend | null {
  if (env("AGENT_STUDIO_TEST") === "1") {
    const file = env("AIB_TEST_KEEP_AWAKE_LOG");
    return file
      ? recordingBackend((line) =>
        Deno.writeTextFileSync(file, line + "\n", { append: true })
      )
      : null;
  }
  return backendFor(os);
}

/**
 * The programs Settings > Remote control runs to set Tailscale up (remote/setup.ts): `tailscale` (login, up, serve, funnel off),
 * winget, msiexec, PowerShell (the installer's signature), pkgutil and spctl (macOS), `open` (macOS) and tailscale-ipn.exe
 * (Windows: start the Tailscale app). Each one is spawned without a console window (AIB's own console is hidden and children share
 * it), with stdin closed, stdout and stderr read together line by line, a time limit and a kill handle.
 *
 * Tests: every program has a hook that is read only when AGENT_STUDIO_TEST=1 (a JSON array: the command and its first arguments):
 * AIB_TAILSCALE_CLI, AIB_WINGET_CLI, AIB_MSIEXEC_CLI, AIB_POWERSHELL_CLI, AIB_PKGUTIL_CLI, AIB_SPCTL_CLI, AIB_OPEN_CLI (also the
 * Tailscale app and every URL AIB opens), AIB_REMOTE_SETUP_SHELL (the Linux setup terminal). With AGENT_STUDIO_TEST=1 and no hook
 * for a program, a changing command is refused (RefusedInTest): a test can never reach the real Tailscale, winget or msiexec.
 */

export type Tool =
  | "tailscale"
  | "winget"
  | "msiexec"
  | "powershell"
  | "pkgutil"
  | "spctl"
  | "open"
  | "ipn";

const HOOKS: Record<Tool, string> = {
  tailscale: "AIB_TAILSCALE_CLI",
  winget: "AIB_WINGET_CLI",
  msiexec: "AIB_MSIEXEC_CLI",
  powershell: "AIB_POWERSHELL_CLI",
  pkgutil: "AIB_PKGUTIL_CLI",
  spctl: "AIB_SPCTL_CLI",
  open: "AIB_OPEN_CLI",
  ipn: "AIB_OPEN_CLI",
};

export class RefusedInTest extends Error {
  override name = "RefusedInTest";
  constructor(readonly tool: Tool | "shell") {
    super(`AGENT_STUDIO_TEST=1 without a fake ${tool}: AIB refuses to run it`);
  }
}

export const testMode = (): boolean =>
  Deno.env.get("AGENT_STUDIO_TEST") === "1";

/** A test hook's command line (a JSON array of strings), only when AGENT_STUDIO_TEST=1; null otherwise or when it is not one. */
export function hookArgv(name: string): string[] | null {
  if (!testMode()) return null;
  const raw = Deno.env.get(name);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length &&
        parsed.every((p) => typeof p === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** Tests only: pretend to be another OS / CPU (AIB_TEST_SETUP_OS, AIB_TEST_SETUP_ARCH), so each OS's flow runs on any PC. */
export function setupOs(): "windows" | "darwin" | "linux" {
  const fake = testMode() ? Deno.env.get("AIB_TEST_SETUP_OS") : "";
  if (fake === "windows" || fake === "darwin" || fake === "linux") return fake;
  const os = Deno.build.os;
  return os === "windows" || os === "darwin" ? os : "linux";
}

const WIN = Deno.build.os === "windows";
const sys32 = (file: string) =>
  `${
    Deno.env.get("SystemRoot") || Deno.env.get("windir") || "C:\\Windows"
  }\\System32\\${file}`;

/** Where each program is looked for on this PC (first that exists wins; a bare name means PATH). */
export function candidates(
  tool: Tool,
  env: (name: string) => string | undefined = (n) => Deno.env.get(n),
): string[] {
  switch (tool) {
    case "tailscale":
      return WIN
        ? [
          "C:\\Program Files\\Tailscale\\tailscale.exe",
          "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
          "tailscale",
        ]
        : [
          "/usr/bin/tailscale",
          "/usr/local/bin/tailscale",
          "/opt/homebrew/bin/tailscale",
          "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
          "tailscale",
        ];
    case "winget": {
      const local = env("LOCALAPPDATA");
      return [
        ...(local ? [`${local}\\Microsoft\\WindowsApps\\winget.exe`] : []),
        "winget",
      ];
    }
    case "msiexec":
      return [sys32("msiexec.exe")];
    case "powershell":
      return [sys32("WindowsPowerShell\\v1.0\\powershell.exe")];
    case "pkgutil":
      return ["/usr/sbin/pkgutil"];
    case "spctl":
      return ["/usr/sbin/spctl"];
    case "open":
      return ["/usr/bin/open"];
    case "ipn":
      return ["C:\\Program Files\\Tailscale\\tailscale-ipn.exe"];
  }
}

function exists(path: string): boolean {
  if (!/[\\/]/.test(path)) return true; // a bare name: PATH decides when it is spawned
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/**
 * The command line for a program: the test hook, else the first place it exists. Throws RefusedInTest under AGENT_STUDIO_TEST=1
 * without a hook. Null when it is not on this PC.
 */
export function resolveTool(tool: Tool): string[] | null {
  const hook = hookArgv(HOOKS[tool]);
  if (hook) return tool === "ipn" ? [...hook, "tailscale-ipn"] : hook;
  if (testMode()) throw new RefusedInTest(tool);
  const found = candidates(tool).find(exists);
  return found ? [found] : null;
}

export interface Proc {
  /** The exit code (a Windows code is unsigned, as winget and msiexec print it); -1 when it was killed or timed out. */
  done: Promise<number>;
  kill(): void;
}

export interface SpawnOptions {
  /** Each line of stdout and stderr, in the order they came (both streams, merged). */
  onLine?: (line: string) => void;
  timeoutMs: number;
  env?: Record<string, string>;
  /** Do not wait for or read the program (the Tailscale app, `open`). */
  detached?: boolean;
}

/** Spawn a program and read its lines. Null when the program is not on this PC (NotFound). */
export type Spawner = (
  tool: Tool,
  args: string[],
  options: SpawnOptions,
) => Proc | null;

/** Read a stream line by line (\r\n, \n or a lone \r, as progress bars print). */
async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let rest = "";
  try {
    for await (const chunk of stream) {
      rest += decoder.decode(chunk, { stream: true });
      const parts = rest.split(/\r\n|\n|\r/);
      rest = parts.pop() ?? "";
      for (const p of parts) onLine(p);
    }
  } catch { /* killed */ }
  rest += decoder.decode();
  if (rest) onLine(rest);
}

export const defaultSpawner: Spawner = (tool, args, options) => {
  const command = resolveTool(tool);
  if (!command) return null;
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(command[0], {
      args: [...command.slice(1), ...args],
      stdin: "null",
      stdout: options.detached ? "null" : "piped",
      stderr: options.detached ? "null" : "piped",
      ...(options.env ? { env: options.env } : {}),
    }).spawn();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
  if (options.detached) {
    child.status.catch(() => {});
    try {
      child.unref();
    } catch { /* older runtime */ }
    return { done: Promise.resolve(0), kill: () => {} };
  }
  let killed = false;
  const kill = () => {
    killed = true;
    try {
      child.kill();
    } catch { /* exited */ }
  };
  const timer = setTimeout(kill, options.timeoutMs);
  const onLine = options.onLine ?? (() => {});
  const reading = Promise.all([
    readLines(child.stdout, onLine),
    readLines(child.stderr, onLine),
  ]);
  const done = (async () => {
    const status = await child.status;
    clearTimeout(timer);
    await reading;
    return killed ? -1 : status.code >>> 0;
  })();
  return { done, kill };
};

/** A command as the changes list shows it: the program's plain name and its arguments, quoted when they hold a space. */
export function shown(tool: Tool | string, args: string[]): string {
  const name = tool === "ipn" ? "tailscale-ipn" : tool;
  return [
    name,
    ...args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)),
  ].join(" ");
}

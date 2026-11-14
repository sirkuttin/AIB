/**
 * A stateful fake Tailscale for Settings > Remote control's setup tests, in process: `runner` answers `status --json` and
 * `serve status --json` from `sim`, and `env` (remote/setup.ts SetupEnv) plays every program the setup buttons run (tailscale login /
 * up / serve / funnel, winget, msiexec, PowerShell, pkgutil, spctl, open, tailscale-ipn), the downloads and the browser. Every call
 * is recorded in `calls`, every opened URL in `opened`. Nothing real is ever run.
 */
import type { Runner } from "../../outputs/agent-studio/server/remote/tailscale.ts";
import type { SetupEnv } from "../../outputs/agent-studio/server/remote/setup.ts";
import type {
  Proc,
  SpawnOptions,
  Tool,
} from "../../outputs/agent-studio/server/remote/setup_cli.ts";
import { LOGIN, NAME } from "./_remote_fixture.ts";

type Json = Record<string, unknown>;

export const LOGIN_URL = "https://login.tailscale.com/a/1a2b3c4d5e6f";
export const HTTPS_URL =
  "https://login.tailscale.com/f/serve?node=nTEST123CNTRL";

export interface Sim {
  installed: boolean;
  backend: string;
  https: boolean;
  /** https port -> what it is served to ("http://127.0.0.1:8779", "tcp://127.0.0.1:22") */
  serve: Record<string, string>;
  funnel: number[];
  foreground: Record<string, string>;
}

export interface Call {
  tool: Tool;
  args: string[];
  env?: Record<string, string>;
  detached?: boolean;
}

/** What a program does: lines it prints, its exit code, or `hang` (runs until killed; then -1). */
export interface Outcome {
  lines?: string[];
  code?: number;
  hang?: boolean;
  /** run when it is spawned (change the sim) */
  effect?: () => void;
}
export type Script = (call: Call, sim: Sim) => Outcome | null | undefined;

export function tailscaleSim(
  start: Partial<Sim> = {},
  script: Script = () => undefined,
) {
  const sim: Sim = {
    installed: true,
    backend: "Running",
    https: true,
    serve: {},
    funnel: [],
    foreground: {},
    ...start,
  };
  const calls: Call[] = [];
  const reads: string[][] = [];
  const opened: string[] = [];
  const procs: { kill(): void; tool: Tool; args: string[]; killed: boolean }[] =
    [];

  const status = (): Json => ({
    BackendState: sim.backend,
    Self: sim.backend === "Running"
      ? {
        ID: "nTEST123CNTRL",
        DNSName: NAME + ".",
        HostName: "studio-pc",
        UserID: 42,
      }
      : { ID: "nTEST123CNTRL", DNSName: "", UserID: 0 },
    User: { "42": { LoginName: LOGIN } },
    CertDomains: sim.https ? [NAME] : [],
    CurrentTailnet: { Name: "example.com", MagicDNSSuffix: "tail-a1b2.ts.net" },
  });
  const serveJson = (): Json => {
    const web: Json = {};
    const tcp: Json = {};
    for (const [port, to] of Object.entries(sim.serve)) {
      if (to.startsWith("tcp://")) tcp[port] = { TCPForward: to.slice(6) };
      else {
        tcp[port] = { HTTPS: true };
        web[`${NAME}:${port}`] = { Handlers: { "/": { Proxy: to } } };
      }
    }
    const out: Json = { TCP: tcp, Web: web };
    if (sim.funnel.length) {
      out.AllowFunnel = Object.fromEntries(
        sim.funnel.map((p) => [`${NAME}:${p}`, true]),
      );
    }
    if (Object.keys(sim.foreground).length) {
      const fweb: Json = {};
      for (const [port, to] of Object.entries(sim.foreground)) {
        fweb[`${NAME}:${port}`] = { Handlers: { "/": { Proxy: to } } };
      }
      out.Foreground = { session1: { Web: fweb } };
    }
    return out;
  };
  const runner: Runner = (args) => {
    reads.push(args);
    if (!sim.installed) return Promise.resolve(null);
    if (args[0] === "status") {
      return Promise.resolve({ code: 0, stdout: JSON.stringify(status()) });
    }
    if (args[0] === "serve" && args[1] === "status") {
      return Promise.resolve({ code: 0, stdout: JSON.stringify(serveJson()) });
    }
    return Promise.resolve({ code: 1, stdout: "" });
  };

  /** The default behaviour of `tailscale ...` (a script can answer first). */
  const tailscaleDefault = (args: string[]): Outcome => {
    if (args[0] === "login" || args[0] === "up") {
      return {
        lines: ["", "To authenticate, visit:", "", `\t${LOGIN_URL}`, ""],
        hang: true,
      };
    }
    if (args[0] === "serve" && args.includes("--bg")) {
      if (!sim.https) {
        return {
          lines: [
            "Serve is not enabled on your tailnet.",
            "To enable, visit:",
            "",
            `         ${HTTPS_URL}`,
          ],
          hang: true,
        };
      }
      const port = args.find((a) => a.startsWith("--https="))!.slice(8);
      const to = args.at(-1)!;
      return {
        code: 0,
        lines: [
          "Available within your tailnet:",
          `https://${NAME}:${port}`,
          "Serve started and running in the background.",
        ],
        effect: () => (sim.serve[port] = to),
      };
    }
    if (args[0] === "serve" && args.at(-1) === "off") {
      const port = args.find((a) => a.startsWith("--https="))!.slice(8);
      return { code: 0, effect: () => delete sim.serve[port] };
    }
    if (args[0] === "funnel" && args.at(-1) === "off") {
      const port = Number(args.find((a) => a.startsWith("--https="))!.slice(8));
      return {
        code: 0,
        effect: () => (sim.funnel = sim.funnel.filter((p) => p !== port)),
      };
    }
    return { code: 1, lines: ["unknown command"] };
  };

  const spawn = (
    tool: Tool,
    args: string[],
    options: SpawnOptions,
  ): Proc | null => {
    const call: Call = {
      tool,
      args: [...args],
      ...(options.env ? { env: { ...options.env } } : {}),
      ...(options.detached ? { detached: true } : {}),
    };
    calls.push(call);
    const outcome = script(call, sim) ??
      (tool === "tailscale" ? tailscaleDefault(args) : { code: 0 });
    if (outcome === null) return null;
    outcome.effect?.();
    let resolve!: (code: number) => void;
    const done = new Promise<number>((r) => (resolve = r));
    const entry = {
      tool,
      args,
      killed: false,
      kill: () => {
        if (entry.killed) return;
        entry.killed = true;
        resolve(-1);
      },
    };
    procs.push(entry);
    queueMicrotask(() => {
      for (const line of outcome.lines ?? []) options.onLine?.(line);
      if (!outcome.hang) setTimeout(() => resolve(outcome.code ?? 0), 5);
    });
    return { done, kill: entry.kill };
  };

  const files = new Map<string, Uint8Array | string>();
  const fetchFake = (input: string | URL | Request): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const path = url.replace(/^https?:\/\/pkgs\.test/, "");
    const body = files.get(path);
    if (body === undefined) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    if (path.includes("?mode=json")) {
      return Promise.resolve(
        new Response(body as string, {
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response(body as BodyInit));
  };

  const env = (over: Partial<SetupEnv> = {}): Partial<SetupEnv> => ({
    spawn,
    fetch: fetchFake as typeof fetch,
    openUrl: (url) => opened.push(url),
    os: () => "windows",
    env: () => undefined,
    hasWinget: () => true,
    pkgsBase: () => "https://pkgs.test",
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 30))),
    waitMs: 30,
    noLinkMs: 300,
    pkgKeepMs: 60_000,
    ...over,
  });

  return {
    sim,
    calls,
    reads,
    opened,
    procs,
    runner,
    env,
    files,
    status,
    serveJson,
  };
}

/** Every command a setup test saw: never serve reset / funnel reset / down / logout / set / funnel on / an uninstaller. */
export function assertSafe(calls: Call[]): void {
  for (const c of calls) {
    const line = [c.tool, ...c.args].join(" ");
    if (c.tool === "tailscale") {
      if (
        /\breset\b/.test(line) ||
        ["down", "logout", "set", "uninstall"].includes(c.args[0])
      ) throw new Error(`unsafe: ${line}`);
      if (c.args[0] === "funnel" && c.args.at(-1) !== "off") {
        throw new Error(`Funnel turned on: ${line}`);
      }
    }
    if (c.tool === "winget" && c.args[0] !== "install") {
      throw new Error(`unsafe: ${line}`);
    }
    if (c.tool === "msiexec" && c.args[0] !== "/i") {
      throw new Error(`unsafe: ${line}`);
    }
  }
}

export async function until(
  check: () => boolean | Promise<boolean>,
  what: string,
  seconds = 10,
): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out: ${what}`);
}

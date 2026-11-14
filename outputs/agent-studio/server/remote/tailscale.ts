/**
 * Reading Tailscale: `tailscale status --json --peers=false` and `tailscale serve status --json`, when phone access starts, on
 * Check again, and while Settings > Remote control is on screen (every 3 s while a setup step waits, every 30 s otherwise;
 * remote/setup.ts). The rule "AIB never changes your Tailscale setup" was replaced on 2026-11-12 (owner: "remote control setup is
 * perfect"): AIB changes Tailscale only when the owner clicks a button that says so (remote/setup.ts), lists every command it ran in
 * "What AIB changed on this PC", never turns Funnel on, and never runs serve reset, down, logout or an uninstaller.
 * AIB's own console has no window (main.ts ensureHiddenConsole), so the CLI opens none either.
 *
 * Tests point AIB_TAILSCALE_CLI at a fake CLI (a JSON array: the command and its first arguments); it is read only when
 * AGENT_STUDIO_TEST=1. With AGENT_STUDIO_TEST=1 and no fake, Tailscale reads as not installed: a test never reads the real one.
 */
import { candidates, hookArgv, testMode } from './setup_cli.ts';

export interface TailscaleState {
  /** The CLI was found and ran. */
  installed: boolean;
  /** Tailscale runs and is signed in on this PC. */
  signedIn: boolean;
  /** Tailscale's BackendState: NoState, NeedsLogin, NeedsMachineAuth, Stopped, Starting, Running ('' when it could not be read). */
  backend: string;
  /** This PC's stable node ID (Self.ID), '' when unknown. */
  nodeId: string;
  /** This PC's name on the tailnet, without the trailing dot ("studio-pc.tail-a1b2.ts.net"), or ''. */
  name: string;
  /** The machine name alone ("studio-pc") and the tailnet ("tail-a1b2.ts.net"). */
  machine: string;
  tailnet: string;
  /** The Tailscale login of this PC's user ("someone@example.com"): phones must be signed in with the same one. */
  login: string;
  /** HTTPS certificates are on for the tailnet (the name is in CertDomains). */
  https: boolean;
  /** `tailscale serve` sends https://<name>/ to AIB's phone port. */
  serving: boolean;
  /** What https://<name>/ is served from now, when it is not AIB's phone port ('' when nothing is). */
  servingOther: string;
  /** Phase D: `tailscale serve` sends https://<name>:8443/ to AIB's artifact port (artifacts open on the phone). */
  artifactServing: boolean;
  /** What https://<name>:8443/ is served from now, when it is not AIB's artifact port ('' when nothing is). */
  artifactServingOther: string;
  /** Funnel (public internet) is on for this name: phone access refuses to start. */
  funnel: boolean;
  /** The ports Funnel makes public for this name, and what each one goes to ("443 → http://127.0.0.1:3000"). */
  funnelPorts: { port: number; to: string }[];
  /** Shares under another name (the PC's old name): shown, never touched. */
  otherNames: string[];
  /** Why something could not be read, for the Devices page ('' when all went well). */
  problem: string;
  checkedAt: number;
}

export type Runner = (args: string[]) => Promise<{ code: number; stdout: string } | null>;

export const defaultRunner: Runner = async (args) => {
  const fake = hookArgv('AIB_TAILSCALE_CLI');
  if (!fake && testMode()) return null; // a test without a fake never reads the real Tailscale
  const commands = fake ? [fake] : candidates('tailscale').map((c) => [c]);
  for (const command of commands) {
    try {
      const child = new Deno.Command(command[0], {
        args: [...command.slice(1), ...args],
        stdin: 'null',
        stdout: 'piped',
        stderr: 'null',
      }).spawn();
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch { /* exited */ }
      }, 10_000);
      const out = await child.output();
      clearTimeout(timer);
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
    } catch {
      continue; // not there (NotFound) or not runnable: try the next place
    }
  }
  return null;
};

/** "studio-pc.tail-a1b2.ts.net." -> "studio-pc.tail-a1b2.ts.net" (lower case, no trailing dot). */
export function cleanName(dns: unknown): string {
  return typeof dns === 'string' ? dns.trim().toLowerCase().replace(/\.+$/, '') : '';
}

type Json = Record<string, unknown>;

/** The JSON object in the CLI's output (a warning line such as "client version != tailscaled version" may come first). */
function jsonPart(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : '';
}
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});

/** One serve config's Web and TCP maps, plus every Foreground session's (`tailscale serve` without --bg puts its config there). */
function serveConfigs(serve: Json): Json[] {
  const out = [serve];
  for (const session of Object.values(obj(serve.Foreground))) out.push(obj(session));
  return out;
}

export interface ServeRead {
  serving: boolean;
  servingOther: string;
  artifactServing: boolean;
  artifactServingOther: string;
  funnel: boolean;
  funnelPorts: { port: number; to: string }[];
  otherNames: string[];
}

/** What `tailscale serve status --json` says about https://<name>:443/ (the phone port), https://<name>:8443/ (the artifact port)
 * and Funnel (on for any port of this name: phone access refuses to start). A raw TCP forward (`serve --tcp`) or a Foreground
 * share on 443 / 8443 counts as "something else" there. Shares under another name are listed in otherNames and never touched. */
export function readServe(serve: Json, name: string, port: number, artifactPort = 0): ServeRead {
  const configs = serveConfigs(serve);
  const otherNames = new Set<string>();
  const target = (httpsPort: string): string => {
    for (const config of configs) {
      for (const [key, value] of Object.entries(obj(config.Web))) {
        const host = cleanName(key.replace(/:\d+$/, ''));
        const hostPort = key.match(/:(\d+)$/)?.[1] ?? '443';
        if (host !== name) {
          if (host) otherNames.add(host);
          continue;
        }
        if (hostPort !== httpsPort) continue;
        const handlers = obj(obj(value).Handlers);
        const root = obj(handlers['/']);
        if (typeof root.Proxy === 'string' && root.Proxy) return root.Proxy;
        if (typeof root.Path === 'string' && root.Path) return root.Path;
        if (typeof root.Text === 'string') return 'a text page';
        if (Object.keys(handlers).length) return 'something else';
      }
      const tcp = obj(obj(config.TCP)[httpsPort]);
      if (typeof tcp.TCPForward === 'string' && tcp.TCPForward) return `tcp://${tcp.TCPForward}`;
    }
    return '';
  };
  const ours = (to: string, want: number): boolean => {
    const m = to.match(/^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):(\d+)\/?$/i) ?? to.match(/^(\d+)$/);
    return !!m && !!want && Number(m[1]) === want;
  };
  const phone = target('443');
  const artifacts = target('8443');
  const funnelPorts: { port: number; to: string }[] = [];
  for (const config of configs) {
    for (const [key, on] of Object.entries(obj(config.AllowFunnel))) {
      if (!on || cleanName(key.replace(/:\d+$/, '')) !== name) continue;
      const p = Number(key.match(/:(\d+)$/)?.[1] ?? '443');
      if (!funnelPorts.some((f) => f.port === p)) funnelPorts.push({ port: p, to: target(String(p)) || 'nothing yet' });
    }
  }
  const serving = ours(phone, port);
  const artifactServing = ours(artifacts, artifactPort);
  return {
    serving,
    servingOther: serving ? '' : phone,
    artifactServing,
    artifactServingOther: artifactServing ? '' : artifacts,
    funnel: funnelPorts.length > 0,
    funnelPorts,
    otherNames: [...otherNames].sort(),
  };
}

/** Read Tailscale's state. Never throws: what could not be read is in `problem` (not_installed, not_running, signed_out,
 * needs_machine_auth, stopped, starting). */
export async function readTailscale(
  port: number,
  run: Runner = defaultRunner,
  clock = () => Date.now() / 1000,
  artifactPort = 0,
): Promise<TailscaleState> {
  const state: TailscaleState = {
    installed: false,
    signedIn: false,
    backend: '',
    nodeId: '',
    name: '',
    machine: '',
    tailnet: '',
    login: '',
    https: false,
    serving: false,
    servingOther: '',
    artifactServing: false,
    artifactServingOther: '',
    funnel: false,
    funnelPorts: [],
    otherNames: [],
    problem: '',
    checkedAt: clock(),
  };
  const status = await run(['status', '--json', '--peers=false']);
  if (status === null) {
    state.problem = 'not_installed';
    return state;
  }
  state.installed = true;
  let data: Json = {};
  try {
    data = obj(JSON.parse(jsonPart(status.stdout)));
  } catch {
    state.problem = 'not_running';
    return state;
  }
  const self = obj(data.Self);
  state.backend = typeof data.BackendState === 'string' ? data.BackendState : '';
  state.nodeId = typeof self.ID === 'string' ? self.ID : '';
  state.signedIn = state.backend === 'Running' && !!self.DNSName;
  if (!state.signedIn) {
    state.problem = state.backend === 'NeedsLogin'
      ? 'signed_out'
      : state.backend === 'NeedsMachineAuth'
      ? 'needs_machine_auth'
      : state.backend === 'Stopped'
      ? 'stopped'
      : state.backend === 'Starting'
      ? 'starting'
      : 'not_running';
    return state;
  }
  state.name = cleanName(self.DNSName);
  const dot = state.name.indexOf('.');
  state.machine = dot > 0 ? state.name.slice(0, dot) : state.name;
  state.tailnet = cleanName(obj(data.CurrentTailnet).MagicDNSSuffix) || (dot > 0 ? state.name.slice(dot + 1) : '');
  const users = obj(data.User);
  const user = obj(users[String(self.UserID)]);
  state.login = typeof user.LoginName === 'string' ? user.LoginName : '';
  const certs = Array.isArray(data.CertDomains) ? data.CertDomains.map(cleanName) : [];
  state.https = certs.includes(state.name);
  const serve = await run(['serve', 'status', '--json']);
  if (serve && serve.code === 0) {
    let parsed: Json = {};
    try {
      parsed = obj(JSON.parse(jsonPart(serve.stdout) || '{}'));
    } catch { /* "No serve config" as text in older versions */ }
    Object.assign(state, readServe(parsed, state.name, port, artifactPort));
  }
  return state;
}

/** The phone share command (AIB runs it on Share AIB; the page shows it with a Copy button when a step fails). */
export function serveCommand(port: number): string {
  return `tailscale serve --bg --https=443 http://127.0.0.1:${port}`;
}

/** The artifact share command (https 8443 to the artifact port). */
export function artifactServeCommand(port: number): string {
  return `tailscale serve --bg --https=8443 http://127.0.0.1:${port}`;
}

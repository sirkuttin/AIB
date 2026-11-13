/**
 * Reading Tailscale (owner decision 1a): AIB only runs `tailscale status --json` and `tailscale serve status --json`, when phone
 * access starts and when the owner clicks Check again. It never changes the Tailscale setup; it shows the `tailscale serve` command
 * for the owner to run. AIB's own console has no window (main.ts ensureHiddenConsole), so the CLI opens none either.
 *
 * Tests point AIB_TAILSCALE_CLI at a fake CLI (a JSON array: the command and its first arguments); it is read only when
 * AGENT_STUDIO_TEST=1.
 */

export interface TailscaleState {
  /** The CLI was found and ran. */
  installed: boolean;
  /** Tailscale runs and is signed in on this PC. */
  signedIn: boolean;
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
  /** Why something could not be read, for the Devices page ('' when all went well). */
  problem: string;
  checkedAt: number;
}

export type Runner = (args: string[]) => Promise<{ code: number; stdout: string } | null>;

const WIN = Deno.build.os === 'windows';
const CANDIDATES = WIN
  ? ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe', 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe']
  : [
    'tailscale',
    '/usr/bin/tailscale',
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  ];

/** The command line that runs the CLI: the test fake, or the first candidate that starts. */
function fakeCli(): string[] | null {
  if (Deno.env.get('AGENT_STUDIO_TEST') !== '1') return null;
  const raw = Deno.env.get('AIB_TAILSCALE_CLI');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length && parsed.every((p) => typeof p === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

export const defaultRunner: Runner = async (args) => {
  const fake = fakeCli();
  const commands = fake ? [fake] : CANDIDATES.map((c) => [c]);
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

/** What `tailscale serve status --json` says about https://<name>:443/ (the phone port), https://<name>:8443/ (the artifact port)
 * and Funnel (on for any port of this name: phone access refuses to start). */
export function readServe(
  serve: Json,
  name: string,
  port: number,
  artifactPort = 0,
): { serving: boolean; servingOther: string; artifactServing: boolean; artifactServingOther: string; funnel: boolean } {
  let funnel = false;
  for (const [key, on] of Object.entries(obj(serve.AllowFunnel))) {
    if (on && cleanName(key.replace(/:\d+$/, '')) === name) funnel = true;
  }
  const web = obj(serve.Web);
  const at = (httpsPort: string, want: number): [boolean, string] => {
    let serving = false;
    let other = '';
    for (const [key, value] of Object.entries(web)) {
      const host = cleanName(key.replace(/:\d+$/, ''));
      const hostPort = key.match(/:(\d+)$/)?.[1] ?? '443';
      if (host !== name || hostPort !== httpsPort) continue;
      const root = obj(obj(obj(value).Handlers)['/']);
      const proxy = typeof root.Proxy === 'string' ? root.Proxy : '';
      const m = proxy.match(/^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):(\d+)\/?$/i) ?? proxy.match(/^(\d+)$/);
      if (m && want && Number(m[1]) === want) serving = true;
      else other = proxy || 'something else';
    }
    return [serving, serving ? '' : other];
  };
  const [serving, servingOther] = at('443', port);
  const [artifactServing, artifactServingOther] = at('8443', artifactPort);
  return { serving, servingOther, artifactServing, artifactServingOther, funnel };
}

/** Read Tailscale's state. Never throws: what could not be read is in `problem`. */
export async function readTailscale(
  port: number,
  run: Runner = defaultRunner,
  clock = () => Date.now() / 1000,
  artifactPort = 0,
): Promise<TailscaleState> {
  const state: TailscaleState = {
    installed: false,
    signedIn: false,
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
    problem: '',
    checkedAt: clock(),
  };
  const status = await run(['status', '--json']);
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
  state.signedIn = data.BackendState === 'Running' && !!self.DNSName;
  if (!state.signedIn) {
    state.problem = data.BackendState === 'NeedsLogin' ? 'signed_out' : 'not_running';
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

/** The command the owner runs once (Devices shows it with a Copy button). */
export function serveCommand(port: number): string {
  return `tailscale serve --bg --https=443 http://127.0.0.1:${port}`;
}

/** Phase D: the second command, for artifacts on the phone (https 8443 to the artifact port). */
export function artifactServeCommand(port: number): string {
  return `tailscale serve --bg --https=8443 http://127.0.0.1:${port}`;
}

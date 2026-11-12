/**
 * Command-line options, with the same flags, defaults and messages as studio.py (add_agent_arguments, log_setup.add_arguments, main),
 * so scripts, the desktop app and the contract tests start either server the same way. argparse rules kept: `--flag value` and
 * `--flag=value`, unambiguous prefixes are NOT accepted (Studio's scripts always spell flags out), unknown flags are an error.
 */
import { defaultLevel } from './log.ts';
import { defaultOmpCommand } from '../agents/adapters.ts';

export interface Options {
  port: number;
  stateDir: string | null;
  ompSessions: string;
  claudeProjects: string;
  ompCommand: string;
  nodeCommand: string;
  claudeLauncher: string;
  codexLauncher: string;
  ownersDir: string | null;
  autoReconnect: boolean;
  noOwnerAnnouncements: boolean;
  enableClientTerminal: boolean;
  enableClientFs: 'read' | 'readwrite' | null;
  noArtifactTool: boolean;
  mcpConfig: string | null;
  logLevel: string;
  open: boolean;
  inProcess: boolean;
  stopHost: boolean;
  force: boolean;
  hostPort: number;
  hostIdleMinutes: number;
  migrateFrom: string | null;
  /** The agent host's own flag (agent_host.py --idle-exit-minutes); the web server passes --host-idle-minutes as this. */
  idleExitMinutes: number;
  /** The agent host's --tray: its own tray icon while chats work with no app attached (the built app's host). */
  tray: boolean;
  /**
   * --start-in-tray (the desktop app): start with no window, only the tray icon (Open AIB / Stop all chats and quit). The keeper's
   * orphan restart uses it, so AIB coming back after a crash never puts a window over the person's work.
   */
  startInTray: boolean;
  /** The agent host's --exit-unattached-seconds: exit this long after the last app left with nothing working (0 = off). */
  exitUnattachedSeconds: number;
  /**
   * The agent host's --keeper: start new chats in the keeper (the web server passes it while it drains an older split host with
   * the keeper usable). Without it a split host is the fallback for a keeper that cannot run, and its new chats are its children.
   */
  keeper: boolean;
}

export class UsageError extends Error {}

const isWindows = Deno.build.os === 'windows';
const sep = isWindows ? '\\' : '/';

export function homeDir(): string {
  return (isWindows ? Deno.env.get('USERPROFILE') : Deno.env.get('HOME')) ?? Deno.env.get('HOME') ?? '.';
}

/** shutil.which: the first match on PATH (with PATHEXT on Windows), else null. */
export function which(name: string): string | null {
  const path = Deno.env.get('PATH') ?? '';
  const exts = isWindows ? ['', ...(Deno.env.get('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  const hasExt = isWindows && /\.[^\\/.]+$/.test(name);
  for (const dir of path.split(isWindows ? ';' : ':').filter(Boolean)) {
    for (const ext of hasExt ? [''] : exts) {
      const candidate = dir.replace(/[\\/]+$/, '') + sep + name + ext;
      try {
        const info = Deno.statSync(candidate);
        if (info.isFile && (isWindows || ((info.mode ?? 0) & 0o111))) return candidate;
      } catch { /* not here */ }
    }
  }
  return null;
}

/** adapters.default_omp_command, from server/agents/adapters.ts. */
export { defaultOmpCommand };

/** ownership_probe.default_owners_dir: the well-known per-user folder for owner announcements. */
export function defaultOwnersDir(): string {
  if (isWindows) return `${Deno.env.get('LOCALAPPDATA') || `${homeDir()}\\AppData\\Local`}\\agent-sessions\\owners`;
  return `${Deno.env.get('XDG_STATE_HOME') || `${homeDir()}/.local/state`}/agent-sessions/owners`;
}

type Kind = 'str' | 'path' | 'int' | 'float' | 'true' | 'false' | 'fs';
const FLAGS: Record<string, [keyof Options, Kind]> = {
  '--port': ['port', 'int'],
  '--state-dir': ['stateDir', 'path'],
  '--omp-sessions': ['ompSessions', 'path'],
  '--claude-projects': ['claudeProjects', 'path'],
  '--omp-command': ['ompCommand', 'str'],
  '--node-command': ['nodeCommand', 'str'],
  '--claude-launcher': ['claudeLauncher', 'str'],
  '--codex-launcher': ['codexLauncher', 'str'],
  '--owners-dir': ['ownersDir', 'path'],
  '--no-auto-reconnect': ['autoReconnect', 'false'],
  '--no-owner-announcements': ['noOwnerAnnouncements', 'true'],
  '--enable-client-terminal': ['enableClientTerminal', 'true'],
  '--enable-client-fs': ['enableClientFs', 'fs'],
  '--no-artifact-tool': ['noArtifactTool', 'true'],
  '--mcp-config': ['mcpConfig', 'path'],
  '--log-level': ['logLevel', 'str'],
  '--open': ['open', 'true'],
  '--in-process': ['inProcess', 'true'],
  '--stop-host': ['stopHost', 'true'],
  '--force': ['force', 'true'],
  '--host-port': ['hostPort', 'int'],
  '--host-idle-minutes': ['hostIdleMinutes', 'float'],
  '--migrate-from': ['migrateFrom', 'path'],
  '--start-in-tray': ['startInTray', 'true'],
};

/** agent_host.py's flags: the agent flags (add_agent_arguments), --log-level, --host-port and --idle-exit-minutes. */
const AGENT_FLAGS = [
  '--state-dir', '--omp-sessions', '--claude-projects', '--omp-command', '--node-command', '--claude-launcher', '--codex-launcher',
  '--owners-dir', '--no-auto-reconnect', '--no-owner-announcements', '--enable-client-terminal', '--enable-client-fs',
  '--no-artifact-tool', '--mcp-config', '--log-level', '--host-port',
];
export const HOST_FLAGS: Record<string, [keyof Options, Kind]> = {
  ...Object.fromEntries(AGENT_FLAGS.map((flag) => [flag, FLAGS[flag]])),
  '--idle-exit-minutes': ['idleExitMinutes', 'float'],
  '--tray': ['tray', 'true'],
  '--exit-unattached-seconds': ['exitUnattachedSeconds', 'float'],
  '--keeper': ['keeper', 'true'],
};

export function defaults(): Options {
  const home = homeDir();
  return {
    port: 8767,
    stateDir: null,
    ompSessions: [home, '.omp', 'agent', 'sessions'].join(sep),
    claudeProjects: [home, '.claude', 'projects'].join(sep),
    ompCommand: defaultOmpCommand(),
    nodeCommand: which('node') ?? 'node',
    claudeLauncher: '',
    codexLauncher: '',
    ownersDir: defaultOwnersDir(),
    autoReconnect: true,
    noOwnerAnnouncements: false,
    enableClientTerminal: false,
    enableClientFs: null,
    noArtifactTool: false,
    mcpConfig: null,
    logLevel: defaultLevel(),
    open: false,
    inProcess: false,
    stopHost: false,
    force: false,
    hostPort: 0,
    hostIdleMinutes: 30,
    migrateFrom: null,
    idleExitMinutes: 30,
    tray: false,
    exitUnattachedSeconds: 0,
    keeper: false,
    startInTray: false,
  };
}

/** Parse argv like studio.py's argparse. Throws UsageError with argparse's wording. */
export function parseOptions(argv: string[], flags: Record<string, [keyof Options, Kind]> = FLAGS): Options {
  const options = defaults() as unknown as Record<string, unknown>;
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const [flag, inline] = raw.startsWith('--') && raw.includes('=')
      ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)]
      : [raw, undefined];
    const spec = flags[flag];
    if (!spec) throw new UsageError(`unrecognized arguments: ${argv.slice(i).join(' ')}`);
    const [key, kind] = spec;
    if (kind === 'true' || kind === 'false') {
      if (inline !== undefined) throw new UsageError(`argument ${flag}: ignored explicit argument '${inline}'`);
      options[key] = kind === 'true';
      continue;
    }
    if (kind === 'fs') {
      const next = inline ?? (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'readwrite');
      if (next !== 'read' && next !== 'readwrite') {
        throw new UsageError(`argument --enable-client-fs: invalid choice: '${next}' (choose from 'read', 'readwrite')`);
      }
      options[key] = next;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new UsageError(`argument ${flag}: expected one argument`);
    if (kind === 'int') {
      if (!/^\s*[-+]?\d+\s*$/.test(value)) throw new UsageError(`argument ${flag}: invalid int value: '${value}'`);
      options[key] = parseInt(value, 10);
    } else if (kind === 'float') {
      const n = Number(value);
      if (value.trim() === '' || Number.isNaN(n)) throw new UsageError(`argument ${flag}: invalid float value: '${value}'`);
      options[key] = n;
    } else options[key] = value;
  }
  const result = options as unknown as Options;
  if (result.noOwnerAnnouncements) result.ownersDir = null;
  if (!(result.port >= 0 && result.port <= 65535)) throw new UsageError('--port must be between 0 and 65535');
  return result;
}

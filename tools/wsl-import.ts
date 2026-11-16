/**
 * One-off, run by the owner from the repository: move the existing chats of a WSL project into their own worktree copies (the way a
 * new WSL chat gets one), with a dry run first. See outputs/agent-studio/docs/WSL.md "Moving existing chats into their own copies".
 *
 *   deno run -A tools/wsl-import.ts --distro Ubuntu --project /home/u/app                         dry run (changes nothing)
 *   deno run -A tools/wsl-import.ts --distro Ubuntu --project /home/u/app --apply --confirm-project /home/u/app
 *   deno run -A tools/wsl-import.ts --distro Ubuntu --project /home/u/app --undo 20261115-142233 --confirm-project /home/u/app
 *   options: --sessions id,id (full ids or 8+ character prefixes)   --json (the raw report)
 *            --state-dir <Windows AIB data folder> | --data <Linux data folder>   --root <Linux AIB folder>   --helper-bin <Windows path>
 *
 * It finds, inside the distro, AIB's folder (`AIB_WSL_ROOT`, else `$HOME/.aib-server`) and the Linux data folder of the AIB you use
 * (`data-<hash of its Windows data folder>`: --state-dir, else AGENT_STUDIO_STATE_DIR, else %LOCALAPPDATA%\AgentStudio), and a helper
 * that knows `import`: --helper-bin (a Linux build on Windows, run through /mnt), else an installed `<root>/<ver>/AIB-wsl-helper` that
 * has it (newest first), else this checkout's `dist/wsl/linux-<arch>/AIB-wsl-helper-linux` (`deno run -A tools/build.ts --wsl-only`).
 * Every wsl.exe is hidden, with a minimal environment (WSL_UTF8=1) and never an empty argument. Under test (AGENT_STUDIO_TEST=1 or
 * AIB_WSL_TEST=1) the helper gets AIB_WSL_TEST=1, so --apply and --undo only work under /tmp/aib-wsl-test-* (helper/import.ts).
 */
import { dataDirName, HELPER_FILE, rootOverride, runWsl, type WslRunner } from '../outputs/agent-studio/server/wsl/install.ts';
import { formatReport, IMPORT_MARKER, type Report } from '../outputs/agent-studio/server/wsl/helper/import.ts';
import { validDistro } from '../outputs/agent-studio/server/platform/location.ts';
import { WSL_ROOT_DIR } from '../outputs/agent-studio/server/wsl/contract.ts';

const DEC = new TextDecoder();
const REPO = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1').replace(/[\\/]+$/, '');
const ARCH = Deno.build.arch === 'aarch64' ? 'arm64' : 'x64';
const APPLY_TIMEOUT_MS = 60 * 60_000;

export interface WrapperArgs {
  distro: string;
  project: string;
  apply: boolean;
  undo: string;
  confirm: string;
  sessions: string;
  json: boolean;
  stateDir: string;
  data: string;
  root: string;
  helperBin: string;
  claudeDir: string;
  codexDir: string;
}

export function parseArgs(argv: string[]): WrapperArgs | string {
  const value = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
  };
  const known = new Set([
    '--distro',
    '--project',
    '--apply',
    '--undo',
    '--confirm-project',
    '--sessions',
    '--json',
    '--state-dir',
    '--data',
    '--root',
    '--helper-bin',
    '--claude-dir',
    '--codex-dir',
  ]);
  for (const a of argv) if (a.startsWith('--') && !known.has(a)) return `Unknown option ${a}`;
  const args: WrapperArgs = {
    distro: value('--distro'),
    project: value('--project'),
    apply: argv.includes('--apply'),
    undo: value('--undo'),
    confirm: value('--confirm-project'),
    sessions: value('--sessions'),
    json: argv.includes('--json'),
    stateDir: value('--state-dir'),
    data: value('--data'),
    root: value('--root'),
    helperBin: value('--helper-bin'),
    claudeDir: value('--claude-dir'),
    codexDir: value('--codex-dir'),
  };
  if (!validDistro(args.distro)) return 'Give the distro: --distro Ubuntu';
  if (!args.project.startsWith('/')) return 'Give the project as a Linux path: --project /home/<you>/<repo>';
  if (args.apply && args.undo) return 'Use --apply or --undo, not both';
  for (
    const [name, v] of [['--data', args.data], ['--root', args.root], ['--claude-dir', args.claudeDir], ['--codex-dir', args.codexDir]]
  ) {
    if (v && !v.startsWith('/')) return `${name} must be a Linux path`;
  }
  return args;
}

/** /mnt/<drive>/... for a Windows path (how the distro reaches it). */
export function mntPath(windowsPath: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
  if (!m) throw new Error(`${windowsPath} is not a Windows path with a drive`);
  return `/mnt/${m[1].toLowerCase()}/${m[2].replaceAll('\\', '/')}`;
}

/** The Windows data folder of the AIB in use: --state-dir, AGENT_STUDIO_STATE_DIR, else %LOCALAPPDATA%\AgentStudio (never under test). */
export function stateDirOf(args: WrapperArgs, env: (n: string) => string | undefined): string {
  if (args.stateDir) return args.stateDir;
  const own = env('AGENT_STUDIO_STATE_DIR');
  if (own) return own;
  if (env('AGENT_STUDIO_TEST') === '1' || env('AIB_WSL_TEST') === '1') throw new Error('Under test, give --state-dir or --data');
  const local = env('LOCALAPPDATA');
  if (!local) throw new Error('LOCALAPPDATA is not set: give --state-dir or --data');
  return `${local.replace(/[\\/]+$/, '')}\\AgentStudio`;
}

const sh = (script: string, ...args: string[]) => ['/bin/sh', '-c', script, 'sh', ...args];

/** $1 = root, $2 = marker: installed helpers that know `import`, newest first ("<mtime> <path>" lines). Read-only. */
export const FIND_SCRIPT = `set -u
for f in "$1"/*/${HELPER_FILE}; do
  [ -f "$f" ] && [ -x "$f" ] && [ ! -L "$f" ] || continue
  grep -q -a -F -- "$2" "$f" 2>/dev/null || continue
  printf '%s %s\\n' "$(stat -c %Y "$f")" "$f"
done | sort -rn
`;

async function main(argv: string[], run: WslRunner = runWsl): Promise<number> {
  const parsed = parseArgs(argv);
  if (typeof parsed === 'string') {
    console.error(parsed);
    console.error(
      'usage: deno run -A tools/wsl-import.ts --distro Ubuntu --project /home/<you>/<repo> [--apply|--undo <stamp>] [--confirm-project <same path>]',
    );
    return 1;
  }
  const args = parsed;
  const env = (n: string) => Deno.env.get(n);
  const testing = env('AGENT_STUDIO_TEST') === '1' || env('AIB_WSL_TEST') === '1';
  let root = args.root || rootOverride() || '';
  if (testing && !/^\/tmp\/aib-wsl-test-[A-Za-z0-9._-]+$/.test(root)) {
    console.error('Under test, AIB_WSL_ROOT (or --root) must be /tmp/aib-wsl-test-<random>');
    return 2;
  }
  if (!root) {
    const home = await run(args.distro, sh('printf "%s" "$HOME"'));
    const h = DEC.decode(home.stdout).trim();
    if (home.code !== 0 || !h.startsWith('/')) {
      console.error(`${args.distro} gave no home folder (${home.stderr.trim() || `exit ${home.code}`})`);
      return 1;
    }
    root = `${h}/${WSL_ROOT_DIR}`;
  }
  if (testing) { // the agents' homes of a test (wsl/access.ts wslTestHomeEnv), never the distro user's own
    args.claudeDir ||= `${root}/home/.claude`;
    args.codexDir ||= `${root}/home/.codex`;
  }
  const data = args.data || `${root}/${dataDirName(stateDirOf(args, env))}`;
  let helper = '';
  if (args.helperBin) helper = mntPath(args.helperBin);
  else {
    const found = await run(args.distro, sh(FIND_SCRIPT, root, IMPORT_MARKER));
    helper = DEC.decode(found.stdout).split('\n').map((l) => l.slice(l.indexOf(' ') + 1)).find((p) => p.startsWith('/')) ?? '';
    if (!helper) {
      const built = `${REPO}\\dist\\wsl\\linux-${ARCH}\\AIB-wsl-helper-linux`;
      try {
        Deno.statSync(built);
        helper = mntPath(built);
      } catch {
        console.error(
          `No AIB helper that knows "import" in ${args.distro} (${root}) and no ${built}: run deno run -A tools/build.ts --wsl-only first`,
        );
        return 1;
      }
    }
  }
  const cmd = [
    ...(testing ? ['/usr/bin/env', 'AIB_WSL_TEST=1'] : []),
    helper,
    'import',
    '--json',
    '--data',
    data,
    '--root',
    root,
    '--project',
    args.project,
  ];
  if (args.apply) cmd.push('--apply');
  if (args.undo) cmd.push('--undo', args.undo);
  if (args.confirm) cmd.push('--confirm-project', args.confirm);
  if (args.sessions) cmd.push('--sessions', args.sessions);
  if (args.claudeDir) cmd.push('--claude-dir', args.claudeDir);
  if (args.codexDir) cmd.push('--codex-dir', args.codexDir);
  const done = await run(args.distro, cmd, { timeoutMs: args.apply || args.undo ? APPLY_TIMEOUT_MS : 10 * 60_000 });
  const out = DEC.decode(done.stdout).trim();
  let report: Report | null = null;
  try {
    report = JSON.parse(out.split('\n').pop() ?? '') as Report;
  } catch {
    report = null;
  }
  if (!report) {
    console.error(`The helper (${helper}) gave no report (exit ${done.code}):\n${out.slice(-2000)}\n${done.stderr.slice(-2000)}`);
    return done.code || 1;
  }
  const self = `deno run -A tools/wsl-import.ts --distro ${args.distro}`;
  console.log(args.json ? JSON.stringify(report, null, 1) : formatReport(report, self));
  if (!args.json) console.log(`(helper ${helper}, data ${data})`);
  return done.code;
}

if (import.meta.main) Deno.exit(await main(Deno.args));

export { main };

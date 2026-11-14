/**
 * Put AIB's two Linux programs into a WSL distro (docs/wsl/design.md section 3, "Install and update"): the Linux keeper and the WSL
 * helper go to `<root>/<ver>/AIB-keeper` and `<root>/<ver>/AIB-wsl-helper`, where <root> is `$HOME/.aib-server` (AIB_WSL_ROOT, an
 * absolute Linux path, overrides it: tests) and <ver> is the app version plus the first 8 hex of the SHA-256 of both programs.
 *
 * Every step is one hidden `wsl.exe -d <distro> --cd ~ --exec /bin/sh -c <fixed script> sh <args>` (runWsl): the scripts are fixed
 * text, paths are only ever `"$1"`-style arguments, never `~` (`--exec` does no expansion), and a program's bytes go in on stdin.
 * A copy is written as `.part`, made 0755 and renamed; the result is checked with `sha256sum`. A second install of the same <ver>
 * copies nothing. Older <ver> folders are removed once no running process's `/proc/*\/exe` points into them. The folders are 0700,
 * and musl distros (Alpine) are refused: the helper is a glibc build.
 *
 * wsl.exe gets a minimal environment (SystemRoot, WSL_UTF8=1, an empty WSLENV): nothing of the Windows environment crosses.
 */
import { createHash } from 'node:crypto';
import { APP_VERSION, isCompiled } from '../core/app.ts';
import { getLogger } from '../core/log.ts';
import { validDistro } from '../platform/location.ts';
import { WSL_ROOT_DIR } from './contract.ts';
import { wslExePath } from './detect.ts';

const log = getLogger('wsl');
const DEC = new TextDecoder();

export const KEEPER_FILE = 'AIB-keeper';
export const HELPER_FILE = 'AIB-wsl-helper';
/** The Windows package's copies (tools/build.ts puts them in `wsl/` next to the app's program). */
export const PACKAGED_KEEPER = 'AIB-keeper-linux';
export const PACKAGED_HELPER = 'AIB-wsl-helper-linux';
export const PROBE_TIMEOUT_MS = 60_000; // the first wsl.exe after a Windows start boots the VM
export const COPY_TIMEOUT_MS = 180_000;

/** The environment every wsl.exe AIB starts gets, and nothing else. */
export function wslEnv(): Record<string, string> {
  return {
    SystemRoot: Deno.env.get('SystemRoot') || 'C:\\Windows',
    WSL_UTF8: '1',
    WSLENV: '',
  };
}

/** The Linux root folder: AIB_WSL_ROOT when it is an absolute, plain Linux path (tests), else null (= `$HOME/.aib-server`). */
export function rootOverride(env: (name: string) => string | undefined = (n) => Deno.env.get(n)): string | null {
  const value = env('AIB_WSL_ROOT');
  if (!value) return null;
  if (
    !/^\/[A-Za-z0-9._\/-]+$/.test(value) || value.split('/').includes('..') ||
    value === '/'
  ) {
    throw new RangeError(`AIB_WSL_ROOT must be an absolute Linux path: ${value}`);
  }
  return value.replace(/\/+$/, '');
}

export interface WslRun {
  code: number;
  stdout: Uint8Array;
  stderr: string;
}

/** How install.ts and hosts.ts run one wsl.exe to the end. Tests pass their own. */
export type WslRunner = (distro: string, argv: string[], options?: { stdin?: Uint8Array; timeoutMs?: number }) => Promise<WslRun>;

/**
 * `wsl.exe -d <distro> --cd ~ --exec <argv…>`, hidden (it shares AIB's console, which has no window), with wslEnv(), stdin from
 * `options.stdin` (else none), killed after the timeout. Throws when wsl.exe is missing, the distro name is not valid, or on timeout.
 */
export const runWsl: WslRunner = async (distro, argv, options = {}) => {
  const exe = wslExePath();
  if (!exe) throw new Error('WSL is not installed on this PC');
  if (!validDistro(distro)) throw new RangeError(`Not a WSL distro name: ${distro}`);
  const child = new Deno.Command(exe, {
    args: ['--distribution', distro, '--cd', '~', '--exec', ...argv],
    env: wslEnv(),
    clearEnv: true,
    stdin: options.stdin ? 'piped' : 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill('SIGKILL');
    } catch { /* gone */ }
  }, options.timeoutMs ?? PROBE_TIMEOUT_MS);
  try {
    if (options.stdin) {
      const writer = child.stdin.getWriter();
      try {
        await writer.write(options.stdin);
        await writer.close();
      } catch { /* it ended early: its exit code says why */ }
    }
    const out = await child.output();
    if (timedOut) throw new Error(`wsl.exe did not finish within ${Math.round((options.timeoutMs ?? PROBE_TIMEOUT_MS) / 1000)} s`);
    return {
      code: out.code,
      stdout: out.stdout,
      stderr: DEC.decode(out.stderr).replaceAll('\0', ''),
    };
  } finally {
    clearTimeout(timer);
  }
};

// ---- the fixed scripts ------------------------------------------------------------------------------------------------------
// Arguments only as "$1", "$2"; no request text ever becomes script text.

/** $1 = the root ('' = $HOME/.aib-server), $2 = <ver>. Prints key=value lines. */
export const PROBE_SCRIPT = `set -u
root="$1"
[ -n "$root" ] || root="$HOME/${WSL_ROOT_DIR}"
printf 'home=%s\\n' "$HOME"
printf 'uid=%s\\n' "$(id -u)"
printf 'user=%s\\n' "$(id -un)"
printf 'shell=%s\\n' "$(getent passwd "$(id -u)" | cut -d: -f7)"
printf 'arch=%s\\n' "$(uname -m)"
if getconf GNU_LIBC_VERSION >/dev/null 2>&1; then printf 'glibc=1\\n'; else printf 'glibc=0\\n'; fi
printf 'root=%s\\n' "$root"
for f in "$root/$2/${KEEPER_FILE}" "$root/$2/${HELPER_FILE}"; do
  if [ -f "$f" ] && [ ! -L "$f" ]; then printf 'sha=%s\\n' "$(sha256sum "$f" | cut -d' ' -f1)"; else printf 'sha=\\n'; fi
done
`;

/** $1 = the destination file (<root>/<ver>/<name>); the bytes come on stdin. Prints the SHA-256 of what was written. */
export const COPY_SCRIPT = `set -eu
dest="$1"
dir=$(dirname "$dest")
root=$(dirname "$dir")
umask 077
mkdir -p "$dir"
chmod 0700 "$root" "$dir"
cat > "$dest.part"
chmod 0755 "$dest.part"
mv -f "$dest.part" "$dest"
sha256sum "$dest" | cut -d' ' -f1
`;

/** $1 = the root, $2 = the <ver> to keep. Removes other <ver> folders no running program runs from. Prints removed=<name> lines. */
export const CLEANUP_SCRIPT = `set -u
root="$1"
keep="$2"
cd "$root" 2>/dev/null || exit 0
for d in *; do
  [ -d "$d" ] && [ ! -L "$d" ] || continue
  case "$d" in data-*|"$keep") continue;; esac
  case "$d" in *-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;; *) continue;; esac
  busy=0
  for e in /proc/[0-9]*/exe; do
    t=$(readlink "$e" 2>/dev/null) || continue
    case "$t" in "$root/$d/"*) busy=1; break;; esac
  done
  [ "$busy" = 1 ] && continue
  rm -rf -- "$root/$d" && printf 'removed=%s\\n' "$d"
done
exit 0
`;

// ---- the programs -----------------------------------------------------------------------------------------------------------

export interface WslPrograms {
  keeper: Uint8Array;
  helper: Uint8Array;
  /** Where they came from (logs). */
  from: string;
}

/** `<app version>-<first 8 hex of SHA-256(keeper ‖ helper)>`. */
export function versionOf(programs: { keeper: Uint8Array; helper: Uint8Array }, appVersion = APP_VERSION): string {
  const hash = createHash('sha256').update(programs.keeper).update(programs.helper).digest('hex').slice(0, 8);
  return `${appVersion.replace(/[^0-9A-Za-z.+_-]/g, '_')}-${hash}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The Linux programs to install: $AIB_WSL_KEEPER_BIN and $AIB_WSL_HELPER_BIN (source runs, tests), else the packaged copies in
 * `wsl/` next to the app's program. Throws with a readable reason when they are not there (Settings > About shows it).
 */
export function findPrograms(env: (name: string) => string | undefined = (n) => Deno.env.get(n)): WslPrograms {
  let keeper = env('AIB_WSL_KEEPER_BIN') ?? '';
  let helper = env('AIB_WSL_HELPER_BIN') ?? '';
  if ((!keeper || !helper) && isCompiled()) {
    const dir = Deno.execPath().replace(/[\\/][^\\/]*$/, '');
    const sep = Deno.build.os === 'windows' ? '\\' : '/';
    keeper ||= `${dir}${sep}wsl${sep}${PACKAGED_KEEPER}`;
    helper ||= `${dir}${sep}wsl${sep}${PACKAGED_HELPER}`;
  }
  if (!keeper || !helper) throw new Error('This AIB build has no WSL programs (AIB_WSL_KEEPER_BIN / AIB_WSL_HELPER_BIN are not set)');
  try {
    return {
      keeper: Deno.readFileSync(keeper),
      helper: Deno.readFileSync(helper),
      from: `${keeper}, ${helper}`,
    };
  } catch (error) {
    throw new Error(`The WSL programs could not be read (${error instanceof Error ? error.message : error})`);
  }
}

// ---- install ----------------------------------------------------------------------------------------------------------------

export interface WslInstall {
  distro: string;
  /** <ver>: the folder name under the root. */
  version: string;
  /** The distro user's $HOME and uid. */
  home: string;
  uid: number;
  user: string;
  /** The user's login shell (passwd), '' when unknown. */
  shell: string;
  /** `uname -m` (x86_64, aarch64). */
  arch: string;
  /** Absolute Linux paths. */
  root: string;
  keeper: string;
  helper: string;
  /** The keeper data folder for this Windows state folder: `<root>/data-<12 hex of SHA-256(stateDir)>`. */
  data: string;
  /** What this run copied (empty: it was already there). */
  copied: string[];
  /** Older <ver> folders removed. */
  removed: string[];
}

export class WslInstallError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'WslInstallError';
  }
}

/** `data-<12 hex>` of a Windows state folder (case-folded: Windows paths), so two AIB data folders never share a Linux keeper. */
export function dataDirName(stateDir: string): string {
  return 'data-' + createHash('sha256').update(stateDir.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()).digest('hex').slice(0, 12);
}

function parseLines(stdout: Uint8Array): { values: Map<string, string>; shas: string[] } {
  const values = new Map<string, string>();
  const shas: string[] = [];
  for (const line of DEC.decode(stdout).split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const key = line.slice(0, at), value = line.slice(at + 1);
    if (key === 'sha') shas.push(value);
    else values.set(key, value);
  }
  return { values, shas };
}

/** What `uname -m` must say for programs built for this Windows build's arch. */
export function expectedArch(arch: string = Deno.build.arch): string {
  return arch === 'aarch64' ? 'aarch64' : 'x86_64';
}

export interface InstallOptions {
  stateDir: string;
  programs?: WslPrograms;
  run?: WslRunner;
  root?: string | null;
  appVersion?: string;
  arch?: string;
}

/**
 * Make sure this AIB's programs are in the distro; returns where everything is. Copies only what differs (SHA-256), then removes
 * older <ver> folders nothing runs from. Throws WslInstallError (`musl`, `arch`, `wsl_failed`, `copy_failed`, `bad_home`).
 */
export async function installWsl(distro: string, options: InstallOptions): Promise<WslInstall> {
  const run = options.run ?? runWsl;
  const programs = options.programs ?? findPrograms();
  const version = versionOf(programs, options.appVersion);
  const override = options.root === undefined ? rootOverride() : options.root;
  const probe = await run(distro, ['/bin/sh', '-c', PROBE_SCRIPT, 'sh', override ?? '', version], { timeoutMs: PROBE_TIMEOUT_MS });
  if (probe.code !== 0) {
    throw new WslInstallError(`${distro} did not answer (${probe.stderr.trim().slice(0, 300) || `exit ${probe.code}`})`, 'wsl_failed');
  }
  const { values, shas } = parseLines(probe.stdout);
  const home = values.get('home') ?? '';
  const root = values.get('root') ?? '';
  if (!home.startsWith('/') || !root.startsWith('/') || /[\0\r\n]/.test(root)) {
    throw new WslInstallError(`${distro} gave no usable home folder`, 'bad_home');
  }
  if (values.get('glibc') !== '1') {
    throw new WslInstallError(`${distro} is a musl distro (like Alpine); AIB needs a glibc distro such as Ubuntu or Debian`, 'musl');
  }
  const arch = values.get('arch') ?? '';
  const wanted = options.arch ?? expectedArch();
  if (arch !== wanted) throw new WslInstallError(`${distro} runs ${arch || 'an unknown CPU'}; this AIB has programs for ${wanted}`, 'arch');
  const dir = `${root}/${version}`;
  const result: WslInstall = {
    distro,
    version,
    home,
    uid: Number(values.get('uid') ?? -1),
    user: values.get('user') ?? '',
    shell: /^\/[^\s]*$/.test(values.get('shell') ?? '') ? values.get('shell')! : '',
    arch,
    root,
    keeper: `${dir}/${KEEPER_FILE}`,
    helper: `${dir}/${HELPER_FILE}`,
    data: `${root}/${dataDirName(options.stateDir)}`,
    copied: [],
    removed: [],
  };
  const files: [string, Uint8Array, string | undefined][] = [
    [result.keeper, programs.keeper, shas[0]],
    [result.helper, programs.helper, shas[1]],
  ];
  for (const [dest, bytes, there] of files) {
    const want = sha256(bytes);
    if (there === want) continue;
    const copy = await run(distro, ['/bin/sh', '-c', COPY_SCRIPT, 'sh', dest], {
      stdin: bytes,
      timeoutMs: COPY_TIMEOUT_MS,
    });
    const got = DEC.decode(copy.stdout).trim().split(/\s+/).pop() ?? '';
    if (copy.code !== 0 || got !== want) {
      throw new WslInstallError(
        `Copying ${dest.split('/').pop()} into ${distro} failed (${
          copy.stderr.trim().slice(0, 300) ||
          (got ? 'checksum mismatch' : `exit ${copy.code}`)
        })`,
        'copy_failed',
      );
    }
    result.copied.push(dest);
  }
  try {
    const cleanup = await run(distro, ['/bin/sh', '-c', CLEANUP_SCRIPT, 'sh', root, version], { timeoutMs: PROBE_TIMEOUT_MS });
    for (const line of DEC.decode(cleanup.stdout).split(/\r?\n/)) if (line.startsWith('removed=')) result.removed.push(line.slice(8));
  } catch (error) {
    log.warning('wsl: cleaning up old AIB versions in %s failed: %s', distro, error instanceof Error ? error.message : error);
  }
  if (result.copied.length || result.removed.length) {
    log.info(
      'wsl: %s: installed %s (%s copied, %s old removed) from %s',
      distro,
      version,
      result.copied.length,
      result.removed.length,
      programs.from,
    );
  }
  return result;
}

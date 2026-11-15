/**
 * The "Install Node.js in <distro>" button of Settings > AIB Linking (WSL) (docs/wsl/linking-design.md sections 3, 11 item 6, 12): the
 * Linux form of the Windows card's winget button. It runs in a distro terminal panel (terminal route `setup=wsl-node&distro=`), with
 * the distro's login environment, and only when the helper's `env.prereqs` says `canInstallNode` (never over an asdf / mise shim).
 *
 * The steps (agents/nvm.ts: one tag, one checksum): download nvm's install.sh to a temp file, check its SHA-256, run it with PROFILE=
 * set to the start-up file of the user's login shell, load nvm, `nvm install --lts`, and check `node --version` is at least 22.19.
 * Each command is printed before it runs; the first that fails stops the rest. Never sudo, never apt, nothing outside the user's home
 * except the temp file (removed at the end).
 */
import type { ShellSpec } from '../platform/pty.ts';
import type { EnvPrereqs } from './contract.ts';
import { NVM_INSTALL_SHA256, NVM_INSTALL_URL, NVM_NOT_PINNED } from '../agents/nvm.ts';

/** The oldest Node.js every agent AIB installs in a distro runs on (Kimi Code needs 22.19). */
export const MIN_WSL_NODE = { major: 22, minor: 19 } as const;

/** The start-up file nvm should add itself to, for a login shell (`zsh` -> .zshrc, `bash` -> .bashrc, else .profile); shell syntax. */
export function profileFor(loginShell: string): string {
  const base = String(loginShell || '').split('/').pop() || '';
  if (base === 'zsh') return '${ZDOTDIR:-$HOME}/.zshrc';
  if (base === 'bash') return '$HOME/.bashrc';
  return '$HOME/.profile';
}

/** The commands the button runs, in order, exactly as they are printed. `url`: tests give a stand-in (file://); AIB never does. */
export function wslNodeSteps(loginShell: string, sha256 = NVM_INSTALL_SHA256, url = NVM_INSTALL_URL): string[] {
  const profile = profileFor(loginShell);
  const { major, minor } = MIN_WSL_NODE;
  return [
    't="$(mktemp)"',
    `curl -fsSLo "$t" ${url}`,
    `echo "${sha256}  $t" | sha256sum -c -`,
    `touch "${profile}"`, // nvm writes to PROFILE only when the file exists
    `PROFILE="${profile}" bash "$t"`,
    'rm -f "$t"',
    '[ -n "${NVM_DIR-}" ] || NVM_DIR="$([ -z "${XDG_CONFIG_HOME-}" ] && printf %s "$HOME/.nvm" || printf %s "$XDG_CONFIG_HOME/nvm")"; export NVM_DIR',
    '\\. "$NVM_DIR/nvm.sh" || command -v nvm >/dev/null', // nvm.sh may end non-zero with no default version yet; nvm is what counts
    'nvm install --lts',
    'node --version',
    `v="$(node --version)"; v="\${v#v}"; maj="\${v%%.*}"; min="\${v#*.}"; min="\${min%%.*}"; ` +
    `[ "$maj" -gt ${major} ] || { [ "$maj" -eq ${major} ] && [ "$min" -ge ${minor} ]; } || { echo "Node.js $v is older than ${major}.${minor}."; false; }`,
  ];
}

/** The bash script of the button: prints each step (`$ <command>`), runs it, stops at the first failure with its exit code. */
export function wslNodeScript(loginShell: string, sha256 = NVM_INSTALL_SHA256, url = NVM_INSTALL_URL): string {
  const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
  const lines = [
    'aib_step() { printf \'\\n$ %s\\n\' "$1"; eval "$1"; s=$?; if [ "$s" -ne 0 ]; then printf \'\\nStopped: that command failed (exit %s). Nothing else ran.\\n\' "$s"; exit "$s"; fi; }',
    ...wslNodeSteps(loginShell, sha256, url).map((step) => `aib_step ${quote(step)}`),
    "printf '\\nNode.js is installed. Choose Check again in AIB.\\n'",
  ];
  return lines.join('\n');
}

/**
 * What the terminal runs for the button, or the one line it shows instead: refused unless the helper says `canInstallNode` (the line is
 * its `nodeInstallBlocked`), and while the checksum is not pinned.
 */
export function wslNodeCommand(prereqs: EnvPrereqs | null, distroLabel: string, sha256 = NVM_INSTALL_SHA256): ShellSpec | string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return NVM_NOT_PINNED;
  if (!prereqs) return `AIB could not check what ${distroLabel} has. Choose Check again.`;
  if (!prereqs.canInstallNode) return prereqs.nodeInstallBlocked || `AIB cannot install Node.js in ${distroLabel}.`;
  return { file: '/bin/bash', args: ['--noprofile', '--norc', '-c', wslNodeScript(prereqs.loginShell, sha256)] };
}

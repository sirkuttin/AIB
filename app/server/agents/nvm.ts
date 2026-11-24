/**
 * nvm, the one way AIB offers to get Node.js on Linux and macOS without root: the copyable line of a Beta agent's "Install Node.js"
 * (beta_setup.ts PREREQS.node), the copy line of a distro's agent rows (wsl/agent_install.ts NODE_INSTALL) and the Node.js button of
 * Settings > AIB Linking (WSL) (wsl/node_setup.ts) all use this tag and this checksum (docs/wsl/linking-design.md sections 3, 11, 12).
 *
 * The installer script is pinned by its SHA-256: it is downloaded to a temp file, checked, and only then run, so a changed script never
 * runs. nvm itself then checks Node.js's tarball against nodejs.org's SHASUMS256.txt.
 */

/** nodejs.org/en/download (read 2026-11-11) gives nvm v0.41.0 for Linux and macOS. */
export const NVM_VERSION = 'v0.41.0';

export const NVM_INSTALL_URL = `https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh`;

/**
 * SHA-256 of install.sh at NVM_VERSION, computed 2026-11-15 from raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh and checked
 * against github.com/nvm-sh/nvm/raw/v0.41.0/install.sh (20055 bytes; its nvm_latest_version says v0.41.0). Change it together with
 * NVM_VERSION. Empty means not pinned: every nvm command then refuses ('nvm checksum not pinned yet') instead of running.
 */
export const NVM_INSTALL_SHA256 = '045932fe05f0d4247c946f2ec0ec4026dbfd8ce88a5f67ea28d8ea833227f48b';

/** What every nvm command says, and does instead of running, while NVM_INSTALL_SHA256 is empty. */
export const NVM_NOT_PINNED = 'nvm checksum not pinned yet';

/**
 * The one-line copyable command: download install.sh, check its SHA-256, run it, load nvm, install the Node.js LTS. `portable` (macOS
 * as well as Linux) falls back to `shasum -a 256` where `sha256sum` is missing; either check failing stops the line.
 */
export function nvmInstallLine(options: { portable?: boolean; sha256?: string } = {}): string {
  const sha = options.sha256 ?? NVM_INSTALL_SHA256;
  if (!/^[0-9a-f]{64}$/.test(sha)) return `echo '${NVM_NOT_PINNED}' && false`;
  const sum = `"${sha}  $t"`;
  const check = options.portable ? `{ echo ${sum} | sha256sum -c - || echo ${sum} | shasum -a 256 -c -; }` : `echo ${sum} | sha256sum -c -`;
  return `t="$(mktemp)" && curl -fsSLo "$t" ${NVM_INSTALL_URL} && ${check} && bash "$t" && \\. "\${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm install --lts`;
}

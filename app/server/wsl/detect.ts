/**
 * Which WSL distros this PC has (docs/wsl/design.md section 2), found without a console and without booting the WSL VM: wsl.exe
 * must exist in %SystemRoot%\System32, and the distros are read from the registry (HKCU\…\Lxss\{guid}: DistributionName, Version,
 * State) through platform/registry.ts. Only WSL2 distros are offered (WSL1 is refused: no Linux keeper sockets, no inotify), and
 * the internal distros of Docker Desktop and Rancher Desktop are left out. Cached briefly, so the page polling costs nothing.
 *
 * Never throws: a missing wsl.exe, an unreadable registry or a non-Windows OS give an empty list with a reason.
 */
import { hkcuSubkeys, hkcuValue } from '../platform/registry.ts';
import { validDistro } from '../platform/location.ts';

export const LXSS_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Lxss';
export const CACHE_MS = 10_000;
/** Distros that belong to an app, not to the person (never offered as a project location). */
const INTERNAL = /^(docker-desktop(-data)?|rancher-desktop(-data)?)$/i;

export interface WslDistro {
  /** DistributionName as Windows shows it ("Ubuntu"); refs carry it case-folded. */
  name: string;
  /** 1 or 2. */
  version: number;
  /** Lxss State 1 = installed (others: installing, uninstalling). */
  installed: boolean;
  isDefault: boolean;
}

export interface WslDetection {
  /** %SystemRoot%\System32\wsl.exe exists. */
  wslExe: string | null;
  /** WSL2 distros AIB can use. */
  distros: WslDistro[];
  /** Distros that are there but not offered, with why (WSL1, not fully installed, internal). */
  skipped: { name: string; why: string }[];
  /** Why nothing is offered ('' when something is). */
  problem: string;
}

/** Test hooks: the registry and the file check. */
export interface DetectHooks {
  os: string;
  systemRoot: () => string;
  exists: (path: string) => boolean;
  subkeys: (path: string, names: readonly string[]) => { key: string; values: Record<string, string | number> }[];
  value: (path: string, name: string) => string | number | undefined;
  now: () => number;
}

export const defaultHooks: DetectHooks = {
  os: Deno.build.os,
  systemRoot: () => Deno.env.get('SystemRoot') || Deno.env.get('windir') || 'C:\\Windows',
  exists: (path) => {
    try {
      return Deno.statSync(path).isFile;
    } catch {
      return false;
    }
  },
  subkeys: hkcuSubkeys,
  value: hkcuValue,
  now: () => Date.now(),
};

/** The wsl.exe of this PC, or null (never a PATH lookup: a wsl.exe planted in a project folder must not run). */
export function wslExePath(hooks: DetectHooks = defaultHooks): string | null {
  if (hooks.os !== 'windows') return null;
  const path = `${hooks.systemRoot().replace(/[\\/]+$/, '')}\\System32\\wsl.exe`;
  return hooks.exists(path) ? path : null;
}

/** Read the distro list now (no cache). */
export function detectNow(hooks: DetectHooks = defaultHooks): WslDetection {
  const empty = (problem: string, wslExe: string | null = null): WslDetection => ({ wslExe, distros: [], skipped: [], problem });
  if (hooks.os !== 'windows') return empty('WSL is a Windows feature');
  const wslExe = wslExePath(hooks);
  if (!wslExe) return empty('WSL is not installed (no wsl.exe)');
  let entries: { key: string; values: Record<string, string | number> }[];
  let defaultKey: string | number | undefined;
  try {
    entries = hooks.subkeys(LXSS_KEY, ['DistributionName', 'Version', 'State']);
    defaultKey = hooks.value(LXSS_KEY, 'DefaultDistribution');
  } catch (error) {
    return empty(`The WSL distro list could not be read (${error instanceof Error ? error.message : error})`, wslExe);
  }
  const distros: WslDistro[] = [];
  const skipped: { name: string; why: string }[] = [];
  for (const { key, values } of entries) {
    const name = values.DistributionName;
    if (typeof name !== 'string' || !name) continue;
    if (!validDistro(name)) {
      skipped.push({
        name,
        why: 'its name has characters AIB does not accept',
      });
      continue;
    }
    if (INTERNAL.test(name)) {
      skipped.push({ name, why: 'it belongs to another app' });
      continue;
    }
    const version = typeof values.Version === 'number' ? values.Version : 1; // no Version value: a WSL1 distro
    const installed = values.State === undefined || values.State === 1;
    if (version !== 2) {
      skipped.push({
        name,
        why: 'it is a WSL1 distro; convert it with `wsl --set-version <name> 2`',
      });
      continue;
    }
    if (!installed) {
      skipped.push({ name, why: 'it is still being installed or removed' });
      continue;
    }
    distros.push({
      name,
      version,
      installed,
      isDefault: typeof defaultKey === 'string' && defaultKey.toLowerCase() === key.toLowerCase(),
    });
  }
  distros.sort((a, b) => (a.isDefault !== b.isDefault ? (a.isDefault ? -1 : 1) : a.name.localeCompare(b.name)));
  return {
    wslExe,
    distros,
    skipped,
    problem: distros.length ? '' : skipped.length ? 'No WSL2 distro AIB can use' : 'No WSL distro',
  };
}

let cached: { at: number; value: WslDetection } | null = null;

/** The distro list, cached for CACHE_MS (fresh = read again). Never throws. */
export function detectWsl(fresh = false, hooks: DetectHooks = defaultHooks): WslDetection {
  const at = hooks.now();
  if (!fresh && cached && at - cached.at < CACHE_MS && at >= cached.at) return cached.value;
  let value: WslDetection;
  try {
    value = detectNow(hooks);
  } catch (error) {
    value = {
      wslExe: null,
      distros: [],
      skipped: [],
      problem: `WSL could not be checked (${error instanceof Error ? error.message : error})`,
    };
  }
  if (hooks === defaultHooks) cached = { at, value };
  return value;
}

/** The WSL2 distro of this PC with this name (case-insensitive), or null. */
export function findDistro(name: string, hooks: DetectHooks = defaultHooks): WslDistro | null {
  const folded = name.toLowerCase();
  return detectWsl(false, hooks).distros.find((d) => d.name.toLowerCase() === folded) ?? null;
}

/** Is `name` a WSL2 distro AIB can use on this PC? (The folder picker's check before it turns a share path into a ref.) */
export function isWsl2Distro(name: string): boolean {
  return findDistro(name) !== null;
}

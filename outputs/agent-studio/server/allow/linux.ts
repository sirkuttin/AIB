/**
 * Allow rules in a WSL chat: Linux path rules over facts from the chat's distro (docs/wsl/audit-beta10.md F1). The matcher is pure and
 * synchronous, and a WSL chat's files are not on this PC's disk, so AIB first asks the distro's helper (`allow.facts`, helper/
 * allow_facts.ts) for what the matcher will need: each path resolved physically (links followed, `..` taken after the link as Linux
 * does), whether it exists and is a folder, whether a folder holds links (globs), the pins of project scripts, the folders on the
 * agent's PATH and the distro's Claude settings facts. The matcher then reads them through a LinuxView. Anything the view was not
 * told is unknown, and unknown always asks (fail closed). Nothing here touches the Windows disk.
 *
 * Collecting what to ask: the same matcher runs once with a recording view (LinuxNeeds) that guesses lexically for what it lacks, so
 * the run goes on and names every path it would check; AIB asks the helper for those, runs again, and stops when nothing new is
 * named (a few rounds at most). The decision itself is made with a view that never guesses.
 */
import { posix } from 'node:path';
import type { AgentConfigFacts } from './agent_config.ts';
import type { PathOps } from './paths.ts';

export interface LinuxPathFact {
  /** The path with every existing part resolved through links (physically), the missing tail kept; null: refused or unreadable. */
  real: string | null;
  exists: boolean;
  isDir: boolean;
}

/** The facts that are not per path: the agent's PATH folders, AIB's own folders in the distro, the Claude settings facts. */
export interface LinuxBase {
  pathDirs: { dir: string; real: string | null }[];
  own: string[];
  /** null: not read (not a Claude chat, or the helper could not read them). */
  claude: AgentConfigFacts | null;
}

interface Stamped<T> {
  v: T;
  at: number;
}

const MAX_KEYS = 4000;

/** What AIB has learnt of one WSL chat's distro, each fact with the time it was read. */
export class LinuxFacts {
  readonly paths = new Map<string, Stamped<LinuxPathFact>>();
  readonly scans = new Map<string, Stamped<boolean>>();
  readonly pins = new Map<string, Stamped<string | null>>();
  base: Stamped<LinuxBase> | null = null;

  /** Keep the store small: a chat that asked about many paths starts again (the next request asks the helper anew). */
  trim(): void {
    if (this.paths.size + this.scans.size + this.pins.size > MAX_KEYS) {
      this.paths.clear();
      this.scans.clear();
      this.pins.clear();
    }
  }
}

/** What a recording run named and the facts lack. */
export class LinuxNeeds {
  readonly paths = new Set<string>();
  readonly scans = new Set<string>();
  readonly pins = new Map<string, { words: string[]; cwd: string }>();
  base = false;
  get empty(): boolean {
    return !this.paths.size && !this.scans.size && !this.pins.size && !this.base;
  }
}

export const pinKey = (words: string[], cwd: string) => JSON.stringify([words, cwd]);

/** Linux path checks over the facts. `since`: facts read before it count as unknown. `needs`: a recording run (guesses, never decides). */
export class LinuxView implements PathOps {
  readonly linux = true;
  /** How often a fact was missing (a decision that missed one may only be "AIB could not check"). */
  misses = 0;
  constructor(
    readonly facts: LinuxFacts,
    readonly opts: { since?: number; needs?: LinuxNeeds | null; distro?: string } = {},
  ) {}

  get recording(): boolean {
    return !!this.opts.needs;
  }

  #fresh<T>(s: Stamped<T> | null | undefined): s is Stamped<T> {
    return !!s && s.at >= (this.opts.since ?? 0);
  }

  formProblem(raw: string): string {
    if (!raw) return 'empty path';
    // deno-lint-ignore no-control-regex -- refusing control characters is the point
    if (/[\x00-\x1f]/.test(raw)) return 'control characters in a path';
    if (raw.startsWith('//')) return 'network or device path';
    if (raw.startsWith('~')) return 'home-folder path';
    if (raw.includes('\\')) return 'a backslash in a Linux path';
    if (raw.length > 4096) return 'path too long';
    return '';
  }

  /** The absolute path the helper is asked about: never normalised here (Linux takes `..` after a link physically). */
  abs(path: string, cwd: string): string {
    return path.startsWith('/') ? path : `${cwd.replace(/\/+$/, '')}/${path}`;
  }

  fact(abs: string): LinuxPathFact | null {
    const s = this.facts.paths.get(abs);
    if (this.#fresh(s)) return s.v;
    this.misses++;
    if (!this.opts.needs) return null;
    this.opts.needs.paths.add(abs);
    return { real: posix.normalize(abs).replace(/(.)\/+$/, '$1'), exists: true, isDir: true };
  }

  realish(path: string, cwd: string): string | null {
    if (this.formProblem(path)) return null;
    const abs = this.abs(path, cwd);
    if (!abs.startsWith('/')) return null;
    return this.fact(abs)?.real ?? null;
  }

  /** Linux paths are case-sensitive; both sides are resolved paths. */
  inside(child: string, root: string): boolean {
    const c = child.length > 1 ? child.replace(/\/+$/, '') : child;
    const r = root.length > 1 ? root.replace(/\/+$/, '') : root;
    if (!r.startsWith('/') || !c.startsWith('/')) return false;
    return c === r || c.startsWith(r === '/' ? '/' : r + '/');
  }

  folderHasLinks(dir: string): boolean {
    const s = this.facts.scans.get(dir);
    if (this.#fresh(s)) return s.v;
    this.misses++;
    if (!this.opts.needs) return true;
    this.opts.needs.scans.add(dir);
    return false;
  }

  /** {exists, isDir} of a path (links followed), or null when unknown. */
  stat(path: string, cwd: string): { exists: boolean; isDir: boolean } | null {
    if (!path || this.formProblem(path)) return null;
    const f = this.fact(this.abs(path, cwd));
    return f ? { exists: f.exists, isDir: f.isDir } : null;
  }

  /** The pin hash of project-script words in a folder (pin.ts, run in the distro), or null when unknown. */
  pin(words: string[], cwd: string): string | null {
    const key = pinKey(words, cwd);
    const s = this.facts.pins.get(key);
    if (this.#fresh(s)) return s.v;
    this.misses++;
    if (!this.opts.needs) return null;
    this.opts.needs.pins.set(key, { words, cwd });
    return '?';
  }

  base(): LinuxBase | null {
    if (this.#fresh(this.facts.base)) return this.facts.base.v;
    this.misses++;
    if (!this.opts.needs) return null;
    this.opts.needs.base = true;
    return { pathDirs: [], own: [], claude: null };
  }

  /**
   * Why a bare program name can't be trusted ('' when fine). Linux finds it on the agent's PATH: when no folder on it is relative or
   * (resolved) inside the chat's folder, the program is outside the project wherever it is found.
   */
  programProblem(root: string): string {
    const base = this.base();
    if (!base) return 'AIB could not check the programs of the distro';
    const realRoot = this.realish(root, root);
    if (!realRoot) return 'path could not be resolved';
    for (const d of base.pathDirs) {
      if (!d.dir.startsWith('/')) return 'a relative folder on PATH';
      if (!d.real) return 'a folder on PATH could not be resolved';
      if (this.inside(d.real, realRoot) || this.inside(posix.normalize(d.dir), realRoot)) return 'program inside the project';
    }
    return '';
  }

  /** AIB's own folders in the distro (its root and data folder): never touched by a rule. */
  own(): string[] {
    return this.base()?.own ?? [];
  }

  /** A rule's folder inside the chat folder ('' = the folder itself). */
  folderIn(cwd: string, folder: string): string {
    return folder ? this.abs(folder, cwd) : cwd;
  }

  relative(from: string, to: string): string {
    return posix.relative(from, to);
  }
}

/** What physicalRealish needs of a file system (the helper: Deno in the distro; tests: a table). */
export interface LinkFs {
  /** 'missing' only for "no such file"; any other failure is 'error'. */
  lstat(path: string): 'missing' | 'error' | { link: boolean };
  /** realpath(3) of an existing link; null when it dangles, loops or can't be read. */
  realpath(path: string): string | null;
}

/**
 * A Linux path resolved as the kernel walks it: each existing part through its links, `..` after a resolved part (physically), the
 * missing tail kept. null when it can't be resolved safely: not absolute, a dangling or looping link (writing through it would create
 * its target), `..` inside the missing tail, a part below a file, or any other error.
 */
export function physicalRealish(path: string, fs: LinkFs): string | null {
  if (!path.startsWith('/') || path.length > 4096 || path.includes('\0')) return null;
  const parts = path.split('/');
  let cur = '/';
  for (let i = 0; i < parts.length; i++) {
    const comp = parts[i];
    if (comp === '' || comp === '.') continue;
    if (comp === '..') {
      cur = posix.dirname(cur);
      continue;
    }
    const next = cur === '/' ? `/${comp}` : `${cur}/${comp}`;
    const info = fs.lstat(next);
    if (info === 'error') return null;
    if (info === 'missing') {
      const tail = parts.slice(i).filter((c) => c !== '' && c !== '.');
      if (tail.includes('..')) return null;
      return `${cur === '/' ? '' : cur}/${tail.join('/')}`;
    }
    if (info.link) {
      const real = fs.realpath(next);
      if (!real || !real.startsWith('/')) return null;
      cur = real;
    } else cur = next;
  }
  return cur;
}

/**
 * The WSL helper's `allow.facts` (contract.ts; allow/linux.ts): what AIB's allow-rules matcher needs to know of the distro for a WSL
 * chat, read only and bounded. Paths are resolved as the kernel walks them (allow/linux.ts physicalRealish over this distro's files),
 * so a link inside the project that points out of it resolves outside, and a dangling link resolves to nothing (AIB then asks).
 */
import { claudeFacts } from '../../allow/agent_config.ts';
import { type LinkFs, physicalRealish } from '../../allow/linux.ts';
import { pinHash } from '../../allow/pin.ts';
import { BAD_PARAMS, type Handlers, RpcError } from './rpc.ts';

export const FACTS_LIMITS = { paths: 64, scans: 16, pins: 8, pathDirs: 64, scanEntries: 5000 } as const;

/** This distro's file system for physicalRealish. */
export const DENO_LINK_FS: LinkFs = {
  lstat(path) {
    try {
      return { link: Deno.lstatSync(path).isSymlink };
    } catch (error) {
      return error instanceof Deno.errors.NotFound ? 'missing' : 'error';
    }
  },
  realpath(path) {
    try {
      return Deno.realPathSync(path);
    } catch {
      return null;
    }
  },
};

const absList = (v: unknown, key: string, max: number): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) throw new RpcError(`${key} must be a list of at most ${max} paths`, BAD_PARAMS);
  for (const p of v) {
    if (typeof p !== 'string' || !p.startsWith('/') || p.length > 4096 || p.includes('\0')) {
      throw new RpcError(`${key} must hold absolute Linux paths`, BAD_PARAMS);
    }
  }
  return v as string[];
};

function factOf(path: string, fs: LinkFs): { real: string | null; exists: boolean; isDir: boolean } {
  const real = physicalRealish(path, fs);
  let exists = false, isDir = false;
  try {
    const st = Deno.statSync(path);
    exists = true;
    isDir = st.isDirectory;
  } catch { /* missing or unreadable */ }
  return { real, exists, isDir };
}

/** A folder holds a link among its entries (or too many to look at, or can't be read). */
function scan(dir: string): boolean {
  try {
    let n = 0;
    for (const e of Deno.readDirSync(dir)) if (e.isSymlink || ++n > FACTS_LIMITS.scanEntries) return true;
    return false;
  } catch {
    return true;
  }
}

export interface AllowFactsDeps {
  /** The login environment (env.get). */
  env(): Promise<{ env: Record<string, string>; home: string }>;
  /** AIB's own folders in the distro (its root and data folder). */
  own(): Promise<string[]>;
  /** Tests: the file system the paths are resolved on. */
  fs?: LinkFs;
}

export function allowFactsMethods(deps: AllowFactsDeps): Handlers {
  return {
    'allow.facts': async (p) => {
      const fs = deps.fs ?? DENO_LINK_FS;
      const paths = absList(p.paths, 'paths', FACTS_LIMITS.paths);
      const scans = absList(p.scans, 'scans', FACTS_LIMITS.scans);
      const pinsIn = p.pins === undefined ? [] : p.pins;
      if (!Array.isArray(pinsIn) || pinsIn.length > FACTS_LIMITS.pins) throw new RpcError('pins must be a short list', BAD_PARAMS);
      const pins = pinsIn.map((x) => {
        const words = (x as { words?: unknown })?.words, cwd = (x as { cwd?: unknown })?.cwd;
        if (
          !Array.isArray(words) || !words.length || words.length > 8 || words.some((w) => typeof w !== 'string' || w.length > 256) ||
          typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.length > 4096 || cwd.includes('\0')
        ) throw new RpcError('a pin needs words and an absolute folder', BAD_PARAMS);
        try {
          return pinHash(words as string[], cwd);
        } catch {
          return null;
        }
      });
      const out: Record<string, unknown> = {
        paths: paths.map((path) => factOf(path, fs)),
        scans: scans.map(scan),
        pins,
      };
      const base = p.base;
      if (base !== undefined) {
        if (!base || typeof base !== 'object' || Array.isArray(base)) throw new RpcError('base must be an object', BAD_PARAMS);
        const b = base as { pathEnv?: unknown; claude?: { cwd?: unknown; dir?: unknown } };
        const login = await deps.env();
        const pathEnv = typeof b.pathEnv === 'string' ? b.pathEnv : login.env.PATH ?? '';
        const pathDirs = pathEnv.split(':').slice(0, FACTS_LIMITS.pathDirs).map((dir) => ({
          dir,
          real: dir.startsWith('/') ? physicalRealish(dir, fs) : null,
        }));
        let claude: { askPrograms: string[]; askTools: string[]; riskyEnv: string } | null = null;
        if (b.claude !== undefined) {
          const cwd = b.claude?.cwd, dir = b.claude?.dir;
          if (typeof cwd !== 'string' || !cwd.startsWith('/') || (dir !== undefined && (typeof dir !== 'string' || !dir.startsWith('/')))) {
            throw new RpcError('claude needs an absolute cwd', BAD_PARAMS);
          }
          const home = login.home || login.env.HOME || '';
          const configDir = (dir as string | undefined) || login.env.CLAUDE_CONFIG_DIR || (home ? `${home.replace(/\/+$/, '')}/.claude` : '');
          try {
            const f = claudeFacts(cwd, configDir);
            claude = { askPrograms: [...f.askPrograms], askTools: [...f.askTools], riskyEnv: f.riskyEnv };
          } catch {
            claude = null;
          }
        }
        out.base = { pathDirs, own: await deps.own(), claude };
      }
      return out;
    },
  };
}

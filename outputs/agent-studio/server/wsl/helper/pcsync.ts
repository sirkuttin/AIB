/**
 * The sync between PCs' file work for WSL projects (wsl/contract.ts `pcsync.fs`; Windows side wsl/pcsync.ts; engine pcsync/files.ts).
 * The engine stays on Windows and decides; this does every read, write, delete and listing natively in the distro by running
 * pcsync/diskops.ts, the same code a Windows project uses on its own disk. One call carries a batch of ops (a scan is one `walk`
 * call plus a few `hash` batches).
 *
 * Reach: only `<project>/aib-shared` or `<project>/aib-docs` of the project named in the call. The project must be an absolute Linux
 * path; its real path must exist; the synced folder must be a real folder (not a link) whose real path is that project's real path
 * plus the folder's name; every file path in an op is checked by frames.ts checkPath (relative, no `..`) and every folder on the way
 * is looked at with lstat before a write (links are never followed). The sync's temp files and bin live in the repository's git
 * folder as git says it (`<git dir>/aib-sync`), never somewhere the caller names. Answers carry no absolute path.
 */
import { BAD_PARAMS, type Handlers, RpcError } from './rpc.ts';
import { DiskError, DiskOps, fromB64, type Json, toB64 } from '../../pcsync/diskops.ts';
import type { Area } from '../../pcsync/frames.ts';

export const MAX_PCSYNC_OPS = 200;
/** Projects' DiskOps are kept a while: the git folder lookup is cached in them. */
const KEEP = 64;

export interface PcsyncHelperOptions {
  /** Tests on Windows: the Linux path as this machine's path (a temp folder standing in for the distro). Default: as it is. */
  resolve?: (linuxPath: string) => string;
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

function projectPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 4096 || /[\0\r\n\\]/.test(value)) {
    throw new RpcError('project must be an absolute Linux path', BAD_PARAMS);
  }
  const parts = value.split('/').filter(Boolean);
  if (!parts.length || parts.some((p) => p === '.' || p === '..')) throw new RpcError('project must not have . or .. parts', BAD_PARAMS);
  return '/' + parts.join('/');
}

export function pcsyncMethods(opts: PcsyncHelperOptions = {}): Handlers {
  const resolve = opts.resolve ?? ((p: string) => p);
  const kept = new Map<string, DiskOps>();

  /** The project's DiskOps, after checking its folder is the project's own real aib-shared / aib-docs (never a link out). */
  async function opsFor(project: string, area: Area, sync: string): Promise<DiskOps> {
    const local = resolve(project);
    let realProject: string;
    try {
      realProject = norm(await Deno.realPath(local));
    } catch {
      throw new RpcError('The project folder is not there', undefined, { code: 'not_found' });
    }
    const key = `${local}\0${area}\0${sync}`;
    let ops = kept.get(key);
    if (!ops) {
      ops = new DiskOps(local, area, sync);
      kept.set(key, ops);
      if (kept.size > KEEP) kept.delete(kept.keys().next().value as string);
    }
    // the synced folder, when it exists, must be the real folder inside the project (no link out, no link in the middle)
    try {
      if (Deno.lstatSync(ops.root).isSymlink) return ops; // the ops say 'link' themselves; nothing is read or written through it
      const real = norm(await Deno.realPath(ops.root));
      if (real !== `${realProject}/${ops.label}`) throw new RpcError('That folder leads outside the project', undefined, { code: 'outside_project' });
    } catch (error) {
      if (error instanceof RpcError) throw error;
    }
    return ops;
  }

  return {
    'pcsync.fs': async (p) => {
      const project = projectPath(p.project);
      const area = p.area === 'docs' ? 'docs' : p.area === 'shared' ? 'shared' : null;
      if (!area) throw new RpcError('area must be shared or docs', BAD_PARAMS);
      if (typeof p.sync !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(p.sync)) throw new RpcError('bad project id', BAD_PARAMS);
      const list = p.ops;
      if (!Array.isArray(list) || !list.length || list.length > MAX_PCSYNC_OPS) {
        throw new RpcError(`ops must be 1 to ${MAX_PCSYNC_OPS} operations`, BAD_PARAMS);
      }
      const ops = await opsFor(project, area, p.sync);
      const results: Json[] = [];
      for (const raw of list) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof (raw as Json).op !== 'string') throw new RpcError('each op is an object with an op name', BAD_PARAMS);
        const op = { ...(raw as Json) } as Json & { op: string };
        if (typeof op.bytesB64 === 'string') {
          op.bytes = fromB64(op.bytesB64);
          delete op.bytesB64;
        }
        try {
          const r = await ops.run(op);
          if (r.bytes instanceof Uint8Array) {
            const { bytes, ...rest } = r;
            results.push({ ok: true, ...rest, bytesB64: toB64(bytes as Uint8Array) });
          } else results.push({ ok: true, ...r });
        } catch (error) {
          const code = error instanceof DiskError
            ? error.code
            : error instanceof Deno.errors.NotFound
            ? 'not_found'
            : error instanceof Deno.errors.AlreadyExists
            ? 'exists'
            : 'failed';
          // a Deno error names the path it failed on: the answer keeps no folder of the distro
          const text = (error instanceof Error ? error.message : String(error)).split(ops.project).join('<project>');
          results.push({ ok: false, error: text, code });
        }
      }
      return { results };
    },
  };
}

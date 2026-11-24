/**
 * The docs' file work for WSL projects (docs/wsl/design.md section 4 phase 2; docs/WSL.md "Docs"): the helper
 * end of docs/doc_fs.ts. AIB keeps each open doc (its Y.Doc, the live editing, comments, history and its cache) on Windows, as for a
 * Windows project, and does every read and write of the doc's files in the project folder through `docs.fs` here, natively in the
 * distro. A write is atomic as on Windows: a temp file next to the target, then one rename. A big file comes in chunks (a request
 * line is at most 4 MiB): `chunk` ops fill the temp file, then `writeAtomic` with the same `token` renames it into place. A `read`
 * with `known` (the hash of the text AIB already has) is answered `same` without the text when the file did not change: the store
 * polls every second, and every answer stays in the helper's bounded record in the keeper.
 *
 * Only a project's aib-docs/ folder is reachable: every path must have an `aib-docs` part below some folder (the project), and the
 * real path of the nearest folder that exists must stay inside that project's real path (no symlink out). A recursive remove and a
 * trash take only a doc folder or something in one (aib-docs/<doc>/…), never aib-docs/ itself.
 */
import { BAD_PARAMS, type Handlers, RpcError } from './rpc.ts';
import { distroTrash } from './trash.ts';
import type { TrashKind } from '../../desktop/project_delete.ts';
import type { HelperContext } from './methods.ts';

export const DOCS_FOLDER = 'aib-docs';
export const MAX_DOC_OPS = 64;
const TOKEN = /^[A-Za-z0-9]{1,32}$/;

type Json = Record<string, unknown>;

export interface DocsHelperOptions {
  /** Tests on Windows: the Linux path as this machine's path (a temp folder standing in for the distro). Default: as it is. */
  resolve?: (linuxPath: string) => string;
}

/** A Linux path's parts, checked: absolute, no NUL, no '.' or '..' parts. */
function partsOf(path: unknown): string[] {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 4096 || /[\0\r\n\\]/.test(path)) {
    throw new RpcError('path must be an absolute Linux path', BAD_PARAMS);
  }
  const parts = path.split('/').filter(Boolean);
  if (parts.some((p) => p === '.' || p === '..')) throw new RpcError('path must not have . or .. parts', BAD_PARAMS);
  return parts;
}

/** {project root, the path, how deep below aib-docs/ it is} or a refusal: only <project>/aib-docs/… is reachable. */
function place(path: unknown): { root: string; path: string; depth: number } {
  const parts = partsOf(path);
  const at = parts.lastIndexOf(DOCS_FOLDER);
  if (at < 1) throw new RpcError('Only a project\'s aib-docs folder is reachable here', undefined, { code: 'outside_docs' });
  return { root: '/' + parts.slice(0, at).join('/'), path: '/' + parts.join('/'), depth: parts.length - at - 1 };
}

/** The hex SHA-256 of a text's UTF-8 bytes (docs.fs `read` with `known`; wsl/docs.ts computes the same). */
export async function textHash(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

async function realOrNull(path: string): Promise<string | null> {
  try {
    return norm(await Deno.realPath(path));
  } catch {
    return null;
  }
}

/** The real path of `path` or of the nearest folder above it that exists. */
async function nearestReal(path: string): Promise<string | null> {
  let p = norm(path);
  for (let i = 0; i < 4096 && p; i++) {
    const real = await realOrNull(p);
    if (real !== null) return real;
    const up = p.slice(0, p.lastIndexOf('/'));
    if (up === p) break;
    p = up;
  }
  return null;
}

export function docsMethods(ctx: HelperContext, opts: DocsHelperOptions = {}): Handlers {
  const resolve = opts.resolve ?? ((p: string) => p);

  /** The local path of a checked Linux path, refused when it (or the folder it would be made in) is outside its project. */
  async function local(value: unknown, minDepth = 0): Promise<string> {
    const at = place(value);
    if (at.depth < minDepth) throw new RpcError('Only a doc folder or a file in one can be removed here', undefined, { code: 'outside_docs' });
    const root = await realOrNull(resolve(at.root));
    if (root === null) throw new RpcError('The project folder is not there', undefined, { code: 'not_found' });
    const target = resolve(at.path);
    const real = await nearestReal(target);
    if (real === null || (real !== root && !real.startsWith(root + '/'))) {
      throw new RpcError('That path leads outside the project folder', undefined, { code: 'outside_docs' });
    }
    return target;
  }

  const parent = (p: string) => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')));

  async function trashLayer(op: Json) {
    const login = await ctx.env();
    const home = login.home || login.env.HOME || '/';
    const dataHome = typeof op.dataHome === 'string' && op.dataHome.startsWith('/') ? op.dataHome : login.env.XDG_DATA_HOME || undefined;
    return distroTrash({ home, dataHome, gio: op.viaGio === false ? null : undefined });
  }

  async function run(op: Json): Promise<Json> {
    switch (op.op) {
      case 'read': {
        try {
          const text = await Deno.readTextFile(await local(op.path));
          // `known`: the SHA-256 of the text AIB holds; the same file is answered without its text (the 1 s poll stays small)
          if (typeof op.known === 'string' && op.known === await textHash(text)) return { same: true };
          return { text };
        } catch (error) {
          if (error instanceof RpcError) throw error;
          return { text: null }; // missing or unreadable, as on Windows
        }
      }
      case 'stat': {
        try {
          const st = await Deno.stat(await local(op.path));
          return { stat: { isFile: st.isFile, isDirectory: st.isDirectory, mtimeMs: st.mtime?.getTime() ?? null } };
        } catch (error) {
          if (error instanceof RpcError) throw error;
          return { stat: null };
        }
      }
      case 'list': {
        try {
          const entries: Json[] = [];
          for await (const e of Deno.readDir(await local(op.path))) entries.push({ name: e.name, isFile: e.isFile, isDirectory: e.isDirectory });
          return { entries };
        } catch (error) {
          if (error instanceof RpcError) throw error;
          return { entries: null };
        }
      }
      case 'mkdir':
        await Deno.mkdir(await local(op.path), { recursive: true });
        return {};
      case 'writeNew': {
        if (typeof op.text !== 'string') throw new RpcError('text must be a string', BAD_PARAMS);
        try {
          await Deno.writeTextFile(await local(op.path), op.text, { createNew: true });
          return { created: true };
        } catch (error) {
          if (error instanceof Deno.errors.AlreadyExists) return { created: false };
          throw error;
        }
      }
      case 'write': {
        if (typeof op.text !== 'string') throw new RpcError('text must be a string', BAD_PARAMS);
        await Deno.writeTextFile(await local(op.path), op.text);
        return {};
      }
      case 'chunk': {
        // one piece of a big atomic write: into <path>.<token>.tmp (made fresh by the first piece)
        if (typeof op.text !== 'string' || typeof op.token !== 'string' || !TOKEN.test(op.token)) {
          throw new RpcError('chunk needs text and a token', BAD_PARAMS);
        }
        const path = await local(op.path);
        await Deno.mkdir(parent(path), { recursive: true });
        await Deno.writeTextFile(`${path}.${op.token}.tmp`, op.text, op.first === true ? {} : { append: true });
        return {};
      }
      case 'writeAtomic': {
        const path = await local(op.path);
        await Deno.mkdir(parent(path), { recursive: true });
        if (typeof op.token === 'string') {
          if (!TOKEN.test(op.token)) throw new RpcError('bad token', BAD_PARAMS);
          await Deno.rename(`${path}.${op.token}.tmp`, path); // the chunks are in place: one rename
          return {};
        }
        if (typeof op.text !== 'string') throw new RpcError('text must be a string', BAD_PARAMS);
        const tmp = `${path}.${Deno.pid}.tmp`;
        await Deno.writeTextFile(tmp, op.text);
        await Deno.rename(tmp, path);
        return {};
      }
      case 'rename':
        await Deno.rename(await local(op.path), await local(op.to));
        return {};
      case 'copy':
        await Deno.copyFile(await local(op.path), await local(op.to));
        return {};
      case 'remove': {
        const recursive = op.recursive === true;
        await Deno.remove(await local(op.path, recursive ? 1 : 0), recursive ? { recursive: true } : undefined);
        return {};
      }
      case 'trashKind': {
        const path = await local(op.path, 1);
        return { kind: await (await trashLayer(op)).kind(path) };
      }
      case 'trash': {
        // never a permanent delete: with no trash for it this is refused
        const path = await local(op.path, 1);
        const layer = await trashLayer(op);
        const kind = await layer.kind(path);
        if (kind === 'permanent') throw new RpcError('There is no trash for this folder in the distro, so AIB did not delete the doc.', undefined, { code: 'no_trash' });
        await layer.trash(path, kind as TrashKind);
        return { kind };
      }
      default:
        throw new RpcError(`Unknown docs op ${String(op.op)}`, BAD_PARAMS);
    }
  }

  return {
    'docs.fs': async (p) => {
      const ops = p.ops;
      if (!Array.isArray(ops) || !ops.length || ops.length > MAX_DOC_OPS) throw new RpcError(`ops must be 1 to ${MAX_DOC_OPS} operations`, BAD_PARAMS);
      const results: Json[] = [];
      for (const op of ops) {
        if (!op || typeof op !== 'object' || Array.isArray(op)) throw new RpcError('each op is an object', BAD_PARAMS);
        try {
          results.push({ ok: true, ...(await run(op as Json)) });
        } catch (error) {
          if (error instanceof RpcError && error.rpcCode === BAD_PARAMS) throw error;
          const code = error instanceof RpcError
            ? String(error.data?.code ?? 'failed')
            : error instanceof Deno.errors.NotFound
            ? 'not_found'
            : error instanceof Deno.errors.AlreadyExists
            ? 'exists'
            : 'failed';
          results.push({ ok: false, error: error instanceof Error ? error.message : String(error), code });
        }
      }
      return { results };
    },
  };
}

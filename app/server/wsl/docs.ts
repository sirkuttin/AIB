/**
 * Docs of WSL projects, Windows side (docs/wsl/design.md section 4 phase 2; docs/WSL.md "Docs"). The open doc
 * stays in AIB on Windows exactly as for a Windows project: the Y.Doc, the page's live editing socket, the agents' doc tools, comments,
 * history (AIB's artifact store) and the cache. Only its files in the project (aib-docs/<doc>/doc.aibdoc, the pages' .md copies, the
 * drawings' and charts' assets) live in the distro, so the store's file layer (docs/doc_fs.ts) sends each read and write of a
 * `wsl://` path here, and this sends it to the distro's helper (`docs.fs`, wsl/helper/docs.ts), which does it natively.
 *
 * A distro that is still starting is waited for; one that stopped is not started again by a read (the poll asks every second): the
 * call is refused `wsl_unavailable` with the line the user sees, the open doc keeps its edits (AIB's cache) and writes them once the
 * distro is back.
 */
import type { DocFs, DocFsEntry, DocFsStat, DocTrash } from '../docs/doc_fs.ts';
import { setRemoteDocFs } from '../docs/doc_fs.ts';
import { DocRefusal } from '../docs/live_doc.ts';
import type { DocFsOp, WslHost } from './contract.ts';
import { hostWhenReady, notReady, wslHost, wslLoc, wslTestHomeEnv } from './access.ts';
import { textHash } from './helper/docs.ts';

type Json = Record<string, unknown>;

/** Characters per piece of a big atomic write (a helper request line is at most 4 MiB, and JSON may grow text up to 6 times). */
export const DOC_CHUNK = 512 * 1024;
/** What a distro's layer keeps of the files' texts for `known` reads (the oldest go first). */
const KNOWN_CHARS = 32 * 1024 * 1024, KNOWN_FILES = 4000;
const WAIT_STATES = new Set<string>(['starting', 'installing', 'reconnecting']);

/** The host of a distro for doc work: waited for while it starts; refused (never started again) when it stopped. */
async function docsHost(distro: string): Promise<WslHost> {
  let host = wslHost(distro);
  if (host && WAIT_STATES.has(host.state)) {
    await hostWhenReady(distro, 60_000).catch(() => {});
    host = wslHost(distro);
  }
  const why = notReady(host, distro);
  if (why) throw new DocRefusal('wsl_unavailable', why);
  return host!;
}

/** Under test, the doc trash is the test's own (inside AIB_WSL_ROOT) and never gio: never the owner's trash. */
function trashArgs(): Partial<DocFsOp> {
  const dataHome = wslTestHomeEnv().XDG_DATA_HOME;
  return dataHome ? { dataHome, viaGio: false } : {};
}

class WslDocFs implements DocFs {
  readonly sep = '/';
  readonly trash: DocTrash;

  constructor(readonly distro: string) {
    this.trash = {
      kind: async (path) => String((await this.#one({ op: 'trashKind', path: this.#linux(path), ...trashArgs() })).kind ?? 'permanent'),
      trash: async (path) => {
        try {
          await this.#one({ op: 'trash', path: this.#linux(path), ...trashArgs() });
        } catch (error) {
          if ((error as { code?: string }).code === 'no_trash') throw new DocRefusal('no_trash', (error as Error).message);
          throw error;
        }
      },
    };
  }

  #linux(path: string): string {
    const loc = wslLoc(path);
    if (!loc || loc.distro !== this.distro) throw new DocRefusal('bad_doc', 'That doc path is not in this WSL project.');
    return loc.linuxPath;
  }

  /** One batch on the helper: the results, in order. A distro or helper that cannot answer is `wsl_unavailable`. */
  async #batch(ops: DocFsOp[]): Promise<Json[]> {
    const host = await docsHost(this.distro);
    let results: Json[];
    try {
      results = (await host.call('docs.fs', { ops })).results;
    } catch (error) {
      const why = notReady(wslHost(this.distro), this.distro) || (error instanceof Error ? error.message : String(error));
      throw new DocRefusal('wsl_unavailable', `The doc's files in ${this.distro} cannot be reached: ${why}`);
    }
    if (!Array.isArray(results) || results.length !== ops.length) throw new DocRefusal('wsl_unavailable', 'The WSL helper gave no answer for the doc files.');
    return results;
  }

  /** One op; a failed one throws its message (with its `code`), as Deno's call would on Windows. */
  async #one(op: DocFsOp): Promise<Json> {
    const [r] = await this.#batch([op]);
    if (r.ok !== true) throw Object.assign(new Error(String(r.error ?? 'The doc file operation failed')), { code: String(r.code ?? 'failed') });
    return r;
  }

  /**
   * The texts this layer last read or wrote, by Linux path, with their hash: a read sends the hash and an unchanged file comes back
   * `same`, without its text (the store polls every second; the helper's answers stay in its bounded record in the keeper).
   */
  #known = new Map<string, { hash: string; text: string }>();
  #knownChars = 0;

  async #remember(linux: string, text: string | null): Promise<void> {
    const old = this.#known.get(linux);
    if (old) this.#knownChars -= old.text.length, this.#known.delete(linux);
    if (text === null) return;
    this.#known.set(linux, { hash: await textHash(text), text });
    this.#knownChars += text.length;
    for (const [key, v] of this.#known) { // the oldest go first
      if (this.#knownChars <= KNOWN_CHARS && this.#known.size <= KNOWN_FILES) break;
      this.#known.delete(key);
      this.#knownChars -= v.text.length;
    }
  }

  async readText(path: string): Promise<string | null> {
    const linux = this.#linux(path);
    const known = this.#known.get(linux);
    const r = await this.#one({ op: 'read', path: linux, ...(known ? { known: known.hash } : {}) });
    if (r.same === true && known) return known.text;
    const text = typeof r.text === 'string' ? r.text : null;
    await this.#remember(linux, text);
    return text;
  }

  async stat(path: string): Promise<DocFsStat | null> {
    const s = (await this.#one({ op: 'stat', path: this.#linux(path) })).stat as Json | null;
    if (!s) return null;
    return { isFile: s.isFile === true, isDirectory: s.isDirectory === true, mtime: typeof s.mtimeMs === 'number' ? new Date(s.mtimeMs) : null };
  }

  async readDir(path: string): Promise<DocFsEntry[] | null> {
    const entries = (await this.#one({ op: 'list', path: this.#linux(path) })).entries;
    if (!Array.isArray(entries)) return null;
    return entries.map((e) => ({ name: String(e.name), isFile: e.isFile === true, isDirectory: e.isDirectory === true }));
  }

  async mkdir(path: string): Promise<void> {
    await this.#one({ op: 'mkdir', path: this.#linux(path) });
  }

  async writeNew(path: string, text: string): Promise<boolean> {
    this.#forget(this.#linux(path));
    return (await this.#one({ op: 'writeNew', path: this.#linux(path), text })).created === true;
  }

  async writeText(path: string, text: string): Promise<void> {
    await this.writeAtomic(path, text); // never a half-written file in the distro, even for a chart's picture
  }

  async writeAtomic(path: string, text: string): Promise<void> {
    const linux = this.#linux(path);
    await this.#remember(linux, null); // until the write is known to have landed
    if (text.length <= DOC_CHUNK) {
      await this.#one({ op: 'writeAtomic', path: linux, text });
    } else {
      // a big file: its pieces into one temp file, then one rename (the file is the old one or the new one, never half)
      const token = crypto.randomUUID().replace(/-/g, '');
      for (let at = 0; at < text.length; at += DOC_CHUNK) {
        await this.#one({ op: 'chunk', path: linux, token, text: text.slice(at, at + DOC_CHUNK), first: at === 0 });
      }
      await this.#one({ op: 'writeAtomic', path: linux, token });
    }
    await this.#remember(linux, text);
  }

  #forget(linux: string, recursive = false): void {
    for (const [key, v] of this.#known) {
      if (key === linux || (recursive && key.startsWith(linux + '/'))) this.#known.delete(key), this.#knownChars -= v.text.length;
    }
  }

  async rename(from: string, to: string): Promise<void> {
    this.#forget(this.#linux(from), true), this.#forget(this.#linux(to), true);
    await this.#one({ op: 'rename', path: this.#linux(from), to: this.#linux(to) });
  }

  async remove(path: string, recursive = false): Promise<void> {
    this.#forget(this.#linux(path), true);
    await this.#one({ op: 'remove', path: this.#linux(path), recursive });
  }

  async copyFile(from: string, to: string): Promise<void> {
    this.#forget(this.#linux(to));
    await this.#one({ op: 'copy', path: this.#linux(from), to: this.#linux(to) });
  }
}

const layers = new Map<string, WslDocFs>();

/** The docs' file layer of a distro (one per distro). */
export function wslDocFs(distro: string): DocFs {
  const key = distro.toLowerCase();
  let fs = layers.get(key);
  if (!fs) layers.set(key, fs = new WslDocFs(key));
  return fs;
}

/** Hand the docs store's `wsl://` paths to the distros (web/server.ts, at start; tests too). */
export function installWslDocFs(): void {
  setRemoteDocFs((path) => {
    const loc = wslLoc(path);
    return loc ? wslDocFs(loc.distro) : null;
  });
}

/** A `wsl://<distro>/…` ref as its Linux path (what an agent in the distro opens); anything else as it is. */
export function linuxPath(value: string): string {
  const loc = /^wsl:\/\//i.test(value) ? wslLoc(value) : null;
  return loc ? loc.linuxPath : value;
}

/**
 * What an agent in the distro reads from a doc tool: every `file` (the doc's doc.aibdoc, in doc_create, doc_read, doc_list...) as
 * the Linux path its own file tools can open, never AIB's ref. Only `file` values change: a doc's text is never touched.
 */
export function linuxPaths<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => linuxPaths(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Json).map(([k, v]) => [k, k === 'file' && typeof v === 'string' ? linuxPath(v) : linuxPaths(v)]),
    ) as T;
  }
  return value;
}

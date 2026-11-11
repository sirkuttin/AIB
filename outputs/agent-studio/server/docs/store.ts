/**
 * The open local docs, their saved state, their Markdown copies and their history.
 *
 *   State    <stateDir>/docs/<id>/doc.bin (the Y.Doc as one compacted update) + meta.json (revs, who changed what, the mirror's
 *            per-block source map, the history artifact). Written on idle and on close. This is the source of truth.
 *   Mirror   <project>/docs/<name>.md, written on idle, meant to be committed. Only blocks that changed are written fresh; every
 *            other block keeps its exact original text (markdown.ts writeDoc), so a git diff shows just the edit.
 *            Agents' file tools may edit it: before every write and every agent call (and on a poll) the store compares the file with
 *            what it last wrote, block by block, and applies only the blocks that changed there, each guarded: a block that changed in
 *            the doc since that mirror (the user typed in it) is skipped and recorded in `skipped`, never overwritten. The file is then
 *            written again from the doc.
 *   History  On idle (and before an agent's edit lands on someone else's), the Markdown is snapshotted as a version of the doc's
 *            artifact in AIB's artifact store (history.ts), with `by` = who changed it since the last snapshot. doc_history lists and
 *            reads them; restore is guarded by ifRev = the latest rev.
 */
import {
  adopt,
  type DocBlock,
  normalize,
  type ParsedDoc,
  parseDoc,
  type PMJson,
  schema,
  sigOf,
  type SrcMap,
  writeDoc,
} from './markdown.ts';
import { DocRefusal, LiveDoc, type Meta, type Op, type Origin } from './live_doc.ts';
import type { DocHistory } from './history.ts';

const sep = Deno.build.os === 'windows' ? '\\' : '/';
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;

export interface MirrorState {
  /** The file as AIB last wrote (or read) it. */
  text: string;
  /** Per block id: its text in that file, the text before it, its content signature. */
  map: SrcMap;
  /** The top-level block ids, in the order that file has them. */
  order: string[];
  tail: string;
  eol: string;
}

/** A file-tool edit the store did not apply, because that block changed in the doc since the last mirror. Data for the UI. */
export interface SkippedEdit {
  at: string;
  reason: 'user_changed' | 'block_gone' | 'refused';
  id: string;
  /** The block as the mirror had it, as the doc has it now, and as the file edit wanted it ('' = deleted). */
  mirror: string;
  now: string;
  file: string;
}

export interface OpenDoc {
  id: string;
  name: string;
  projectRoot: string;
  mirrorPath: string;
  live: LiveDoc;
  mirror: MirrorState;
  skipped: SkippedEdit[];
  /** Blocks whose Markdown does not round-trip exactly (rare constructs): ids. */
  lossy: string[];
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** The running flush or file sync: they take turns. */
  busy: Promise<unknown>;
  /** The artifact that holds this doc's history, the rev of the last snapshot, who changed it since. */
  artifactId: string | null;
  snapRev: number;
  authors: Set<string>;
  snapTimer: ReturnType<typeof setTimeout> | null;
  note: string;
}

export async function docId(
  projectRoot: string,
  name: string,
): Promise<string> {
  const key = (Deno.build.os === 'windows' ? projectRoot.toLowerCase() : projectRoot) + '\n' + name;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  return [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The doc name from what an agent or the page gave: "plan", "plan.md" or "docs/plan.md". */
export function docName(value: unknown): string {
  if (typeof value !== 'string') throw new DocRefusal('bad_doc', '`doc` must be the doc\'s name, e.g. "plan" (its copy is docs/plan.md)');
  let name = value.trim().replace(/\\/g, '/');
  if (name.startsWith('docs/')) name = name.slice(5);
  if (name.toLowerCase().endsWith('.md')) name = name.slice(0, -3);
  if (!NAME.test(name) || name.endsWith('.')) {
    throw new DocRefusal('bad_doc', '`doc` must be a plain name (letters, digits, space, . _ -), e.g. "plan"; its copy is docs/<name>.md');
  }
  return name;
}

/** Blocks of a parsed file as doc nodes; a block the schema can't hold stays verbatim as a raw block. */
function nodesOf(parsed: ParsedDoc): PMJson[] {
  return parsed.blocks.map((b) => {
    try {
      const node = schema.nodeFromJSON(b.node);
      node.check();
      return b.node;
    } catch {
      return { type: 'rawBlock', attrs: { kind: 'other', text: b.raw.replace(/\r\n?/g, '\n') } };
    }
  });
}

export interface StoreOptions {
  idleMs?: number;
  pollMs?: number;
  /** Quiet time before a history snapshot (default 10 s). */
  snapshotIdleMs?: number;
  mirrorFolder?: string;
  history?: DocHistory | null;
}

export class DocStore {
  readonly docs = new Map<string, OpenDoc>();
  #opening = new Map<string, Promise<OpenDoc>>();
  #poll: ReturnType<typeof setInterval> | null = null;

  constructor(readonly stateDir: string, readonly options: StoreOptions = {}) {}

  /** Start polling the open docs' Markdown copies for file-tool edits. */
  start(): void {
    if (this.#poll !== null) return;
    const poll = setInterval(() => {
      for (const d of this.docs.values()) {
        void this.syncMirror(d).catch(() => {});
      }
    }, this.options.pollMs ?? 1000);
    Deno.unrefTimer(poll);
    this.#poll = poll;
  }

  #dir(id: string): string {
    return `${this.stateDir}${sep}docs${sep}${id}`;
  }

  mirrorPath(projectRoot: string, name: string): string {
    return `${projectRoot}${sep}${this.options.mirrorFolder ?? 'docs'}${sep}${name}.md`;
  }

  /** Is there a doc of this name in the project (saved state or a Markdown file)? */
  async exists(projectRoot: string, name: string): Promise<boolean> {
    const id = await docId(projectRoot, name);
    if (this.docs.has(id)) return true;
    for (
      const path of [`${this.#dir(id)}${sep}meta.json`, this.mirrorPath(projectRoot, name)]
    ) {
      try {
        await Deno.stat(path);
        return true;
      } catch { /* not there */ }
    }
    return false;
  }

  /**
   * Open a doc. With `create` (Markdown, maybe empty) a new doc is made and refused if one exists; without it a doc that does not
   * exist is refused (`no_doc`). A Markdown file in docs/ without saved state is a doc: it is read in.
   */
  async open(
    projectRoot: string,
    nameValue: unknown,
    create?: string,
  ): Promise<OpenDoc> {
    const name = docName(nameValue);
    const id = await docId(projectRoot, name);
    if (create !== undefined && await this.exists(projectRoot, name)) {
      throw new DocRefusal(
        'doc_exists',
        `A doc named "${name}" already exists (docs/${name}.md). Read it with doc_read, or pick another name.`,
      );
    }
    const open = this.docs.get(id);
    if (open) return open;
    if (create === undefined && !(await this.exists(projectRoot, name))) {
      throw new DocRefusal('no_doc', `No doc named "${name}" in this project. doc_list shows the docs; doc_create makes one.`);
    }
    let pending = this.#opening.get(id);
    if (!pending) {
      pending = this.#load(id, projectRoot, name, create).finally(() => this.#opening.delete(id));
      this.#opening.set(id, pending);
    }
    return await pending;
  }

  /** The docs of a project: Markdown files in docs/ and docs with saved state. */
  async list(
    projectRoot: string,
  ): Promise<
    { name: string; file: string; open: boolean; rev?: number; blocks?: number }[]
  > {
    const names = new Set<string>();
    try {
      for await (
        const e of Deno.readDir(`${projectRoot}${sep}${this.options.mirrorFolder ?? 'docs'}`)
      ) {
        if (
          e.isFile && e.name.toLowerCase().endsWith('.md') && NAME.test(e.name.slice(0, -3))
        ) names.add(e.name.slice(0, -3));
      }
    } catch { /* no docs folder */ }
    try {
      for await (const e of Deno.readDir(`${this.stateDir}${sep}docs`)) {
        try {
          const meta = JSON.parse(await Deno.readTextFile(`${this.#dir(e.name)}${sep}meta.json`));
          if (
            typeof meta.name === 'string' && sameRoot(meta.projectRoot, projectRoot)
          ) names.add(meta.name);
        } catch { /* not a doc */ }
      }
    } catch { /* no state yet */ }
    const out = [];
    for (const name of [...names].sort()) {
      const doc = this.docs.get(await docId(projectRoot, name));
      out.push({
        name,
        file: this.mirrorPath(projectRoot, name),
        open: !!doc,
        ...(doc ? { rev: doc.live.rev, blocks: doc.live.blockCount } : {}),
      });
    }
    return out;
  }

  async #load(
    id: string,
    projectRoot: string,
    name: string,
    create?: string,
  ): Promise<OpenDoc> {
    const dir = this.#dir(id);
    const mirrorPath = this.mirrorPath(projectRoot, name);
    let state: Uint8Array | null = null;
    let saved:
      | (Meta & { mirror?: MirrorState; artifactId?: string | null; snapRev?: number })
      | null = null;
    if (create === undefined) {
      try {
        state = await Deno.readFile(`${dir}${sep}doc.bin`);
        saved = JSON.parse(await Deno.readTextFile(`${dir}${sep}meta.json`));
      } catch {
        state = null;
        saved = null;
      }
    }
    const live = new LiveDoc(state, saved);
    const doc: OpenDoc = {
      id,
      name,
      projectRoot,
      mirrorPath,
      live,
      mirror: saved?.mirror && typeof saved.mirror.text === 'string' && saved.mirror.map
        ? saved.mirror
        : { text: '', map: {}, order: [], tail: '\n', eol: '\n' },
      skipped: [],
      lossy: [],
      dirty: false,
      timer: null,
      busy: Promise.resolve(),
      artifactId: saved?.artifactId ?? null,
      snapRev: saved?.snapRev ?? 0,
      authors: new Set(),
      snapTimer: null,
      note: '',
    };
    if (!state) {
      // A new doc: from the given Markdown, else from the project's Markdown copy, else one empty paragraph.
      let text = create ?? '';
      if (create === undefined) {
        try {
          text = await Deno.readTextFile(mirrorPath);
        } catch { /* none yet */ }
      }
      const parsed = parseDoc(text);
      live.replaceAll(nodesOf(parsed), live.system);
      doc.mirror = {
        text: create === undefined ? text : '',
        map: adopt(parsed, live.topBlocks()),
        order: live.topIds(),
        tail: parsed.blocks.length ? parsed.tail : parsed.eol,
        eol: parsed.eol,
      };
      doc.dirty = true;
    }
    live.onChange = (by) => this.#touched(doc, by);
    live.beforeEdit = (by) => {
      if (doc.authors.size && !(doc.authors.size === 1 && doc.authors.has(by))) this.snapshot(doc);
    };
    this.docs.set(id, doc);
    if (doc.dirty) await this.flush(doc);
    if (!doc.artifactId) this.snapshot(doc, 'created');
    return doc;
  }

  get(id: string): OpenDoc | null {
    return this.docs.get(id) ?? null;
  }

  #touched(doc: OpenDoc, by: string | null): void {
    doc.dirty = true;
    if (by) doc.authors.add(by);
    if (doc.timer !== null) clearTimeout(doc.timer);
    const timer = setTimeout(() => {
      doc.timer = null;
      void this.flush(doc).catch(() => {});
    }, this.options.idleMs ?? 1500);
    Deno.unrefTimer(timer);
    doc.timer = timer;
    if (doc.snapTimer !== null) clearTimeout(doc.snapTimer);
    const snap = setTimeout(() => {
      doc.snapTimer = null;
      this.snapshot(doc);
    }, this.options.snapshotIdleMs ?? 10_000);
    Deno.unrefTimer(snap);
    doc.snapTimer = snap;
  }

  /** The doc's Markdown as the mirror would write it now (pure; the file is not touched). */
  markdown(doc: OpenDoc): string {
    return writeDoc(doc.live.topBlocks(), doc.mirror.map, doc.mirror.tail, doc.mirror.eol).text;
  }

  /** One at a time per doc: a poll, an idle flush and an agent call never sync the same file edit twice. */
  #serial<T>(doc: OpenDoc, work: () => Promise<T>): Promise<T> {
    const next = doc.busy.then(work, work);
    doc.busy = next.catch(() => {});
    return next;
  }

  /** Save the state and write the Markdown copy (after taking in any file-tool edit to it). */
  flush(doc: OpenDoc): Promise<void> {
    if (doc.timer !== null) clearTimeout(doc.timer), doc.timer = null;
    return this.#serial(doc, async () => {
      await this.#sync(doc);
      await this.#write(doc);
    });
  }

  async #write(doc: OpenDoc): Promise<void> {
    const w = writeDoc(doc.live.topBlocks(), doc.mirror.map, doc.mirror.tail, doc.mirror.eol);
    doc.lossy = w.lossy;
    let onDisk: string | null = null;
    try {
      onDisk = await Deno.readTextFile(doc.mirrorPath);
    } catch { /* not written yet */ }
    if (w.text !== onDisk) {
      await Deno.mkdir(doc.mirrorPath.slice(0, doc.mirrorPath.lastIndexOf(sep)), { recursive: true });
      await writeAtomic(doc.mirrorPath, w.text);
      doc.dirty = true;
    }
    if (w.text !== doc.mirror.text) doc.dirty = true;
    doc.mirror = { ...doc.mirror, text: w.text, map: w.map, order: doc.live.topIds() };
    if (!doc.dirty) return;
    doc.dirty = false;
    await this.#saveState(doc);
  }

  async #saveState(doc: OpenDoc): Promise<void> {
    const dir = this.#dir(doc.id);
    await Deno.mkdir(dir, { recursive: true });
    await writeAtomic(`${dir}${sep}doc.bin`, doc.live.encode());
    await writeAtomic(
      `${dir}${sep}meta.json`,
      JSON.stringify({
        ...doc.live.meta(),
        name: doc.name,
        projectRoot: doc.projectRoot,
        mirror: doc.mirror,
        artifactId: doc.artifactId,
        snapRev: doc.snapRev,
      }),
    );
  }

  /**
   * Take in a file-tool edit of the Markdown copy: compare the file with the last mirror block by block, and apply each changed
   * block on its own (insert, replace, delete), guarded by "the doc still has this block as the mirror had it". A block that changed
   * in the doc since then is skipped and recorded in doc.skipped. Returns what was skipped this time.
   */
  syncMirror(doc: OpenDoc): Promise<SkippedEdit[]> {
    return this.#serial(doc, () => this.#sync(doc));
  }

  async #sync(doc: OpenDoc): Promise<SkippedEdit[]> {
    let text: string;
    try {
      text = await Deno.readTextFile(doc.mirrorPath);
    } catch {
      return [];
    }
    if (text === doc.mirror.text || !doc.mirror.order.length) return [];
    const live = doc.live;
    const lf = (s: string) => s.replace(/\r\n?/g, '\n');
    const before = doc.mirror.order.map((id) => ({ id, raw: lf(doc.mirror.map[id]?.raw ?? ''), sig: doc.mirror.map[id]?.sig ?? '' }));
    const parsed = parseDoc(text);
    const after = parsed.blocks.map((b) => lf(b.raw));
    const nodes = nodesOf(parsed);
    const origin: Origin = live.originFor('file', 'file edit');
    const skipped: SkippedEdit[] = [];
    const current = (id: string): DocBlock | undefined => live.topBlocks().find((b) => b.id === id);
    const skip = (
      reason: SkippedEdit['reason'],
      id: string,
      mirror: string,
      file: string,
    ) => {
      skipped.push({ at: new Date().toISOString(), reason, id, mirror, now: live.has(id) ? live.markdownOf(id) : '', file });
    };
    let anchor: string | null = null; // the doc block the next inserted block goes after
    for (const pair of align(before.map((b) => b.raw), after)) {
      if (pair.kind === 'same') {
        if (live.has(before[pair.a!].id)) anchor = before[pair.a!].id;
        continue;
      }
      try {
        if (pair.kind === 'insert') {
          const op: Op = anchor && live.has(anchor)
            ? { op: 'insert', target: { kind: 'blocks', ids: [anchor] }, side: 'after', source: blocksSource(nodes[pair.b!]) }
            : { op: 'insert', target: { kind: 'root' }, side: anchor ? 'end' : 'start', source: blocksSource(nodes[pair.b!]) };
          const ack = live.edit([op], origin) as { created?: string[] };
          anchor = ack.created?.at(-1) ?? anchor;
          continue;
        }
        const old = before[pair.a!];
        const now = current(old.id);
        const wanted = pair.kind === 'delete' ? '' : after[pair.b!];
        if (!now || sigOf(now.node) !== old.sig) {
          skip(now ? 'user_changed' : 'block_gone', old.id, old.raw, wanted);
          if (now) anchor = old.id;
          continue;
        }
        if (pair.kind === 'delete') {
          if (live.topIds().length > 1) live.edit([{ op: 'delete', target: { kind: 'blocks', ids: [old.id] }, force: true }], origin);
          continue;
        }
        const ack = live.edit(
          [{ op: 'replace', target: { kind: 'blocks', ids: [old.id] }, force: true, with: blocksSource(nodes[pair.b!]) }],
          origin,
        ) as { created?: string[] };
        anchor = live.has(old.id) ? old.id : ack.created?.at(-1) ?? anchor;
      } catch (error) {
        if (!(error instanceof DocRefusal)) throw error;
        skip(
          'refused',
          pair.a !== undefined ? before[pair.a].id : '',
          pair.a !== undefined ? before[pair.a].raw : '',
          pair.b !== undefined ? after[pair.b] : '',
        );
      }
    }
    doc.skipped.push(...skipped);
    if (doc.skipped.length > 50) doc.skipped.splice(0, doc.skipped.length - 50);
    // The file's own spelling of every block that now matches the doc is kept; skipped edits are written back from the doc.
    doc.mirror = { text, map: adopt(parsed, live.topBlocks()), order: live.topIds(), tail: parsed.tail, eol: parsed.eol };
    doc.dirty = true;
    await this.#write(doc);
    return skipped;
  }

  // ---------- history ----------

  /** Snapshot the doc into its history artifact now (if it changed since the last one). Returns the version number or null. */
  snapshot(doc: OpenDoc, note = ''): number | null {
    const history = this.options.history;
    if (!history || (doc.snapRev === doc.live.rev && doc.artifactId)) return null;
    if (doc.snapTimer !== null) clearTimeout(doc.snapTimer), doc.snapTimer = null;
    const by = [...doc.authors].sort().join('+') || (note === 'created' ? 'system' : 'user');
    const n = history.snapshot(doc, this.markdown(doc), by, `rev ${doc.live.rev}${note || doc.note ? '; ' + (note || doc.note) : ''}`);
    doc.snapRev = doc.live.rev;
    doc.authors.clear();
    doc.note = '';
    doc.dirty = true;
    return n;
  }

  history(doc: OpenDoc): { latest: number; versions: unknown[] } {
    return { latest: doc.live.rev, versions: this.options.history?.list(doc) ?? [] };
  }

  readVersion(doc: OpenDoc, n: number): string {
    const text = this.options.history?.read(doc, n);
    if (text === null || text === undefined) {
      throw new DocRefusal('no_version', `There is no version ${n} of this doc; doc_history lists them.`);
    }
    return text;
  }

  /**
   * Restore the doc to a history version, only when nothing changed since the caller's read (`ifRev` = the latest rev). The file
   * then reads exactly as that version did.
   */
  async restore(
    doc: OpenDoc,
    n: number,
    ifRev: unknown,
    origin: Origin,
  ): Promise<{ rev: number; restored: number }> {
    if (typeof ifRev !== 'number') {
      throw new DocRefusal('missing_guard', 'restore needs "ifRev" = the latest rev (doc_history shows it as `latest`).');
    }
    if (ifRev !== doc.live.rev) {
      throw new DocRefusal(
        'guard_mismatch',
        `The doc changed since (rev ${doc.live.rev}, you gave ${ifRev}): restore only rewinds when nothing changed since your read. ` +
          'Look at doc_history again, or bring back just the words you need with an ordinary insert.',
        { rev: doc.live.rev },
      );
    }
    const text = this.readVersion(doc, n);
    await this.#serial(doc, async () => {
      await this.#sync(doc);
      if (doc.live.rev !== ifRev) throw new DocRefusal('guard_mismatch', 'The doc changed while restoring; nothing was restored.');
      this.snapshot(doc);
      const parsed = parseDoc(text);
      doc.live.replaceAll(nodesOf(parsed), origin);
      doc.mirror = {
        text: doc.mirror.text,
        map: adopt(parsed, doc.live.topBlocks()),
        order: doc.live.topIds(),
        tail: parsed.tail,
        eol: parsed.eol,
      };
      doc.note = `restored v${n}`;
      await this.#write(doc);
    });
    return { rev: doc.live.rev, restored: n };
  }

  /** What the UI can show about a doc: where it is, its rev, skipped file edits, lossy blocks, how many versions. */
  info(doc: OpenDoc): Record<string, unknown> {
    return {
      doc: doc.id,
      name: doc.name,
      file: doc.mirrorPath,
      rev: doc.live.rev,
      blocks: doc.live.blockCount,
      skipped: doc.skipped,
      lossy: doc.lossy,
      artifactId: doc.artifactId,
    };
  }

  async close(): Promise<void> {
    if (this.#poll !== null) clearInterval(this.#poll), this.#poll = null;
    for (const doc of this.docs.values()) {
      await this.flush(doc).catch(() => {});
      this.snapshot(doc);
      if (doc.snapTimer !== null) clearTimeout(doc.snapTimer);
      await this.#saveState(doc).catch(() => {});
      doc.live.destroy();
    }
    this.docs.clear();
  }
}

function blocksSource(
  node: PMJson,
): { from: { kind: string; content: PMJson[] }; as: string } {
  return { from: { kind: 'inline', content: [normalize(node)] }, as: 'blocks' };
}

function sameRoot(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  return Deno.build.os === 'windows' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

interface Pair {
  kind: 'same' | 'insert' | 'delete' | 'change';
  a?: number;
  b?: number;
}

/** Line up the mirror's blocks with the file's: LCS on equal blocks; between anchors, changed blocks pair up in order. */
export function align(a: string[], b: string[]): Pair[] {
  const n = a.length, m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: Pair[] = [];
  let i = 0, j = 0;
  const gap = (ia: number, ja: number) => {
    const olds: number[] = [], news: number[] = [];
    for (let x = i; x < ia; x++) olds.push(x);
    for (let y = j; y < ja; y++) news.push(y);
    const k = Math.min(olds.length, news.length);
    for (let t = 0; t < k; t++) {
      out.push({ kind: 'change', a: olds[t], b: news[t] });
    }
    for (let t = k; t < olds.length; t++) {
      out.push({ kind: 'delete', a: olds[t] });
    }
    for (let t = k; t < news.length; t++) {
      out.push({ kind: 'insert', b: news[t] });
    }
  };
  let x = 0, y = 0;
  while (x < n && y < m) {
    if (a[x] === b[y]) {
      gap(x, y);
      out.push({ kind: 'same', a: x, b: y });
      i = ++x, j = ++y;
    } else if (lcs[x + 1][y] >= lcs[x][y + 1]) x++;
    else y++;
  }
  gap(n, m);
  return out;
}

async function writeAtomic(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  const tmp = `${path}.${Deno.pid}.tmp`;
  if (typeof data === 'string') await Deno.writeTextFile(tmp, data);
  else await Deno.writeFile(tmp, data);
  await Deno.rename(tmp, path);
}

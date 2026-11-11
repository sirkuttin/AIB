/**
 * The open local docs, their saved state and their Markdown copies.
 *
 *   State   <stateDir>/docs/<id>/doc.bin (the Y.Doc as one compacted update) + meta.json (revs, who changed what, the last mirror).
 *           Written on idle and on close. This is the source of truth.
 *   Mirror  <project>/docs/<name>.md, written on idle, meant to be committed. Agents' file tools may edit it: before every write and
 *           every agent call (and on a poll) the store compares the file with what it last wrote, and applies only the blocks that
 *           changed there, each guarded: a block the user (or an agent) changed in the doc since that mirror is skipped and flagged,
 *           never overwritten. The mirror is then rewritten from the doc.
 */
import { type BlockSpec, diffText, docToMarkdown, hash8, parseMarkdown, specToElement, specToMarkdown, TEXTBLOCKS } from './blocks.ts';
import { DocRefusal, LiveDoc, type Meta, type Op, type Origin } from './live_doc.ts';

const sep = Deno.build.os === 'windows' ? '\\' : '/';
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;

export interface MirrorBlock {
  id: string;
  md: string;
}

/** A file-tool edit the store did not apply, because that block changed in the doc since the last mirror. */
export interface SkippedEdit {
  at: string;
  reason: 'user_changed' | 'block_gone';
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
  mirror: { text: string; blocks: MirrorBlock[] };
  skipped: SkippedEdit[];
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** The running flush or file sync: they take turns. */
  busy: Promise<unknown>;
}

export async function docId(projectRoot: string, name: string): Promise<string> {
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

export class DocStore {
  readonly docs = new Map<string, OpenDoc>();
  #opening = new Map<string, Promise<OpenDoc>>();
  #poll: ReturnType<typeof setInterval> | null = null;

  constructor(readonly stateDir: string, readonly options: { idleMs?: number; pollMs?: number; mirrorFolder?: string } = {}) {}

  /** Start polling the open docs' Markdown copies for file-tool edits. */
  start(): void {
    if (this.#poll !== null) return;
    const poll = setInterval(() => {
      for (const d of this.docs.values()) void this.syncMirror(d).catch(() => {});
    }, this.options.pollMs ?? 1000);
    Deno.unrefTimer(poll);
    this.#poll = poll;
  }

  #dir(id: string): string {
    return `${this.stateDir}${sep}docs${sep}${id}`;
  }

  async open(projectRoot: string, nameValue: unknown): Promise<OpenDoc> {
    const name = docName(nameValue);
    const id = await docId(projectRoot, name);
    const open = this.docs.get(id);
    if (open) return open;
    let pending = this.#opening.get(id);
    if (!pending) {
      pending = this.#load(id, projectRoot, name).finally(() => this.#opening.delete(id));
      this.#opening.set(id, pending);
    }
    return await pending;
  }

  async #load(id: string, projectRoot: string, name: string): Promise<OpenDoc> {
    const dir = this.#dir(id);
    const mirrorPath = `${projectRoot}${sep}${this.options.mirrorFolder ?? 'docs'}${sep}${name}.md`;
    let state: Uint8Array | null = null;
    let saved: (Meta & { mirror?: OpenDoc['mirror'] }) | null = null;
    try {
      state = await Deno.readFile(`${dir}${sep}doc.bin`);
      saved = JSON.parse(await Deno.readTextFile(`${dir}${sep}meta.json`));
    } catch {
      state = null;
      saved = null;
    }
    const live = new LiveDoc(state, saved);
    const doc: OpenDoc = { id, name, projectRoot, mirrorPath, live, mirror: saved?.mirror ?? { text: '', blocks: [] }, skipped: [], dirty: false, timer: null, busy: Promise.resolve() };
    if (!state) {
      // A new doc: start from the Markdown copy if the project already has one, else one empty paragraph.
      let text = '';
      try {
        text = await Deno.readTextFile(mirrorPath);
      } catch { /* none yet */ }
      const specs: BlockSpec[] = parseMarkdown(text);
      live.doc.transact(() => {
        live.frag.insert(0, (specs.length ? specs : [{ type: 'paragraph', inline: [] }]).map((s) => specToElement(s, null)));
      }, live.system);
      doc.mirror = text ? { text, blocks: this.#mirrorBlocks(live) } : { text: '', blocks: [] };
      doc.dirty = true;
    }
    live.onChange = () => this.#touched(doc);
    this.docs.set(id, doc);
    if (doc.dirty) await this.flush(doc);
    return doc;
  }

  get(id: string): OpenDoc | null {
    return this.docs.get(id) ?? null;
  }

  #touched(doc: OpenDoc): void {
    doc.dirty = true;
    if (doc.timer !== null) clearTimeout(doc.timer);
    const timer = setTimeout(() => {
      doc.timer = null;
      void this.flush(doc).catch(() => {});
    }, this.options.idleMs ?? 1500);
    Deno.unrefTimer(timer);
    doc.timer = timer;
  }

  #mirrorBlocks(live: LiveDoc): MirrorBlock[] {
    return live.elements().map((el) => ({ id: live.view(el).id, md: live.view(el).md }));
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
      await this.#write(doc, false);
    });
  }

  async #write(doc: OpenDoc, force: boolean): Promise<void> {
    const text = docToMarkdown(doc.live.specs());
    if (force || text !== doc.mirror.text) {
      await Deno.mkdir(doc.mirrorPath.slice(0, doc.mirrorPath.lastIndexOf(sep)), { recursive: true });
      await writeAtomic(doc.mirrorPath, text);
      doc.mirror = { text, blocks: this.#mirrorBlocks(doc.live) };
      doc.dirty = true;
    }
    if (!doc.dirty) return;
    doc.dirty = false;
    const dir = this.#dir(doc.id);
    await Deno.mkdir(dir, { recursive: true });
    await writeAtomic(`${dir}${sep}doc.bin`, doc.live.encode());
    await writeAtomic(`${dir}${sep}meta.json`, JSON.stringify({ ...doc.live.meta(), name: doc.name, projectRoot: doc.projectRoot, mirror: doc.mirror }));
  }

  /**
   * Take in a file-tool edit of the Markdown copy: compare the file with the last mirror block by block, and apply each changed
   * block on its own (insert, re-word, replace, delete), guarded by "the doc still has this block as the mirror had it". A block that
   * changed in the doc since then is skipped and recorded in doc.skipped. Returns what was skipped this time.
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
    if (text === doc.mirror.text || !doc.mirror.text) return [];
    const before = doc.mirror.blocks;
    const after = parseMarkdown(text).map(specToMarkdown);
    const pairs = align(before.map((b) => b.md), after);
    const live = doc.live;
    const origin: Origin = live.originFor('file', 'file edit');
    const skipped: SkippedEdit[] = [];
    const now = () => new Map(live.elements().map((el) => [live.view(el).id, live.view(el)]));
    let anchor: string | null = null; // the doc block the next inserted block goes after
    for (const pair of pairs) {
      const current = now();
      if (pair.kind === 'same') {
        anchor = before[pair.a!].id;
        continue;
      }
      if (pair.kind === 'insert') {
        const op: Op = anchor && current.has(anchor)
          ? { op: 'insert', target: { kind: 'blocks', ids: [anchor] }, side: 'after', source: { from: { kind: 'inline', content: after[pair.b!] }, as: 'markdown' } }
          : { op: 'insert', target: { kind: 'root' }, side: anchor ? 'end' : 'start', source: { from: { kind: 'inline', content: after[pair.b!] }, as: 'markdown' } };
        const ack = live.edit([op], origin) as { changed: { id: string }[] };
        anchor = ack.changed.at(-1)?.id ?? anchor;
        continue;
      }
      const old = before[pair.a!];
      const block = current.get(old.id);
      const wanted = pair.kind === 'delete' ? '' : after[pair.b!];
      if (!block || block.md !== old.md) {
        skipped.push({ at: new Date().toISOString(), reason: block ? 'user_changed' : 'block_gone', id: old.id, mirror: old.md, now: block?.md ?? '', file: wanted });
        if (block) anchor = old.id;
        continue;
      }
      const ifRev = live.rev, ifHash = hash8(old.md);
      if (pair.kind === 'delete') {
        if (current.size > 1) live.edit([{ op: 'delete', target: { kind: 'blocks', ids: [old.id] }, ifHash, ifRev }], origin);
        continue;
      }
      // A re-wording of the same kind of block goes in as small character edits (it keeps the block's id); anything else is replaced.
      const [oldSpec] = parseMarkdown(old.md), newSpecs = parseMarkdown(wanted);
      const sameKind = newSpecs.length === 1 && TEXTBLOCKS.has(oldSpec.type) && oldSpec.type === newSpecs[0].type &&
        JSON.stringify(oldSpec.attrs ?? {}) === JSON.stringify(newSpecs[0].attrs ?? {}) && sameMarks(old.md, wanted);
      const content = sameKind ? plainText(newSpecs[0]) : wanted;
      const ack = live.edit([{
        op: 'replace',
        target: { kind: 'blocks', ids: [old.id] },
        ifHash,
        ifRev,
        with: { from: { kind: 'inline', content }, as: sameKind ? 'text' : 'markdown' },
      }], origin) as { changed: { id: string }[] };
      anchor = sameKind ? old.id : ack.changed.at(-1)?.id ?? anchor;
    }
    doc.skipped.push(...skipped);
    if (doc.skipped.length > 50) doc.skipped.splice(0, doc.skipped.length - 50);
    // The file is rewritten from the doc at once (skipped edits are kept in doc.skipped, not lost).
    await this.#write(doc, true);
    return skipped;
  }

  async close(): Promise<void> {
    if (this.#poll !== null) clearInterval(this.#poll), this.#poll = null;
    for (const doc of this.docs.values()) {
      await this.flush(doc).catch(() => {});
      doc.live.destroy();
    }
    this.docs.clear();
  }
}

function plainText(spec: BlockSpec): string {
  return (spec.inline ?? []).map((r) => r.insert).join('');
}

/** True when two Markdown blocks have the same formatting marks around the same words (so a plain re-word keeps them right). */
function sameMarks(a: string, b: string): boolean {
  const marks = (s: string) => (s.match(/\*\*|__|\*|_|~~|`/g) ?? []).join('');
  return marks(a) === marks(b) && !/[*_~`]/.test(diffText(a, b).map((e) => e.ins).join(''));
}

interface Pair {
  kind: 'same' | 'insert' | 'delete' | 'change';
  a?: number;
  b?: number;
}

/** Line up the mirror's blocks with the file's: LCS on equal blocks; between anchors, changed blocks pair up in order. */
export function align(a: string[], b: string[]): Pair[] {
  const n = a.length, m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: Pair[] = [];
  let i = 0, j = 0;
  const gap = (ia: number, ja: number) => {
    const olds: number[] = [], news: number[] = [];
    for (let x = i; x < ia; x++) olds.push(x);
    for (let y = j; y < ja; y++) news.push(y);
    const k = Math.min(olds.length, news.length);
    for (let t = 0; t < k; t++) out.push({ kind: 'change', a: olds[t], b: news[t] });
    for (let t = k; t < olds.length; t++) out.push({ kind: 'delete', a: olds[t] });
    for (let t = k; t < news.length; t++) out.push({ kind: 'insert', b: news[t] });
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

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${path}.${Deno.pid}.tmp`;
  if (typeof data === 'string') await Deno.writeTextFile(tmp, data);
  else await Deno.writeFile(tmp, data);
  await Deno.rename(tmp, path);
}

/**
 * Transcript folders (monitor.Store / Catalog): the session cards, a chat's agents (main transcript and subagents), the cache of
 * parsed transcripts (LRU within a byte budget, never evicting one in use), background commands per chat, and the model a live
 * conversation really runs on. Paths are native strings; keys are POSIX paths relative to a root, prefixed by provider in a Catalog.
 */
import { clip, isDict, pyIsPrintable, pyStr, pyStrip, ValueError } from '../core/py.ts';
import { isNetworkPath } from '../web/security.ts';
import {
  cleanPrompt,
  contentText,
  deriveTitle,
  type Dict,
  type Event,
  type Json,
  normalize,
  projectCwd,
  projectMatch,
  updateMetadata,
} from './normalize.ts';
import {
  bytesSplitlines,
  dget,
  get,
  isOSError,
  isoTimestamp,
  or,
  PyAttributeError,
  PyTypeError,
  pyTypeName,
  splitlines,
  strCmp,
  truthy,
} from './pycompat.ts';
import {
  globTail,
  isDir,
  isFile,
  isRelativeTo,
  join,
  name,
  nativePath,
  parent,
  pureAnchor,
  relativeParts,
  resolve,
  resolveLoose,
  rglobTail,
  statSig,
  stem,
  suffix,
  withoutSuffix,
} from './purepath.ts';
import { bytesInclude, loadsBytes, Mutex, readExactly, readToEnd, type Task, Transcript } from './transcript.ts';

export const QUIET_UNKNOWN_SECONDS = 4 * 3600;
// Parsed transcripts stay in memory up to this many bytes of SOURCE file (bytes read so far, a cheap stand-in for memory).
// 1.5 GB: the biggest chat seen has 130 transcripts / ~270 MB, so a family of five such chats fits.
export const TRANSCRIPT_CACHE_BUDGET = 1536 * 1024 * 1024;
// command_list results are reused while no transcript file changed, for at most this long (idle times are clock based).
export const COMMAND_LIST_TTL = 3.0;
const TITLE_ROW = /"type": ?"(?:ai-title|custom-title|title|summary)"/;
const CWD_FIELD = /"cwd"[ \t\n\r\f\v]*:[ \t\n\r\f\v]*("(?:[^"\\]|\\[^\n])*")/g;
const LATIN1 = new TextDecoder('latin1');
const TITLE_KINDS = ['title', 'ai-title', 'custom-title', 'summary'];

export const now = () => Date.now() / 1000;

/** {project, branch, base} for a cwd inside a worktree Studio made (set by Studio), or null. */
export type ProjectResolver = (cwd: string) => { project: string; branch?: string; base?: string } | null | undefined;

export interface Resolved {
  store: Store;
  path: string;
}

/** f.seek(start); f.read(length) (length null: to the end of the file). */
async function readRange(path: string, start: number, length: number | null): Promise<Uint8Array> {
  const file = await Deno.open(path, { read: true });
  try {
    await file.seek(start, Deno.SeekMode.Start);
    return length === null ? await readToEnd(file) : await readExactly(file, length);
  } finally {
    file.close();
  }
}

/** Every distinct folder a transcript records, in order, read in chunks without parsing the records. */
export async function scanCwds(path: string, limit = 256, chunk = 4 << 20): Promise<string[]> {
  const seen: string[] = [];
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch {
    return seen;
  }
  try {
    let carry = new Uint8Array(0);
    while (seen.length < limit) {
      const block = await readExactly(file, chunk);
      if (!block.length) break;
      const data = new Uint8Array(carry.length + block.length);
      data.set(carry);
      data.set(block, carry.length);
      const text = LATIN1.decode(data);
      for (const match of text.matchAll(CWD_FIELD)) {
        const at = match.index! + match[0].length - match[1].length;
        const value = loadsBytes(data.subarray(at, at + match[1].length));
        if (typeof value === 'string' && value && !seen.includes(value)) seen.push(value);
      }
      carry = data.slice(Math.max(0, data.length - 4096));
    }
  } catch (error) {
    if (!isOSError(error)) throw error;
  } finally {
    file.close();
  }
  return seen;
}

export class Store {
  root: string;
  cache = new Map<string, Transcript>();
  budget = TRANSCRIPT_CACHE_BUDGET;
  sizes = new Map<string, number>(); // transcript key -> source bytes parsed (its cost against the budget)
  pins = new Map<string, number>(); // transcript key -> number of requests using it right now (never evicted)
  commandMemo = new Map<string, [string, number, Task[]]>(); // session key -> (signature, built at, tasks)
  commandLocks = new Map<string, Mutex>();
  summaryCache = new Map<string, [string, Dict]>();
  projectMemo = new Map<string, string>(); // transcript key -> project folder once found ('' = none)
  hintCache = new Map<string, [string, Dict]>();
  projectResolver: ProjectResolver | null = null;
  #rootReady: Promise<void>;

  /** Use Store.open(root) (the root is resolved, as Path.resolve() does). */
  constructor(root: string) {
    this.root = root;
    this.#rootReady = resolveLoose(root).then((real) => void (this.root = real));
  }

  static async open(root: string): Promise<Store> {
    const store = new Store(root);
    await store.ready();
    return store;
  }

  ready(): Promise<void> {
    return this.#rootReady;
  }

  /** The transcript file for a key; ValueError('Unknown transcript') for anything else. */
  async resolve(key: Json): Promise<Resolved> {
    await this.ready();
    if (typeof key !== 'string' || isNetworkPath(key) || pureAnchor(nativePath(key))) {
      throw new ValueError('Unknown transcript'); // a UNC or absolute key would replace the root and make Windows contact that server
    }
    const path = await resolve(join(this.root, key));
    if (path === null || !isRelativeTo(path, this.root) || suffix(name(path)) !== '.jsonl' || !(await isFile(path))) {
      throw new ValueError('Unknown transcript');
    }
    return { store: this, path };
  }

  async key(path: string): Promise<string> {
    await this.ready();
    const real = await resolveLoose(path);
    const parts = relativeParts(real, this.root);
    if (parts === null) throw new ValueError(`'${real}' is not in the subpath of '${this.root}'`);
    return parts.join('/');
  }

  /** The refreshed Transcript; the one in use is pinned so the budget never evicts it. */
  async load(target: Resolved | string): Promise<Transcript> {
    const path = typeof target === 'string' ? target : target.path;
    const key = await this.key(path);
    let transcript = this.cache.get(key);
    if (transcript === undefined) transcript = new Transcript(path);
    this.cache.delete(key);
    this.cache.set(key, transcript);
    this.pins.set(key, (this.pins.get(key) ?? 0) + 1);
    try {
      await transcript.refresh();
    } finally {
      this.sizes.set(key, transcript.offset);
      this.#evict(key);
      this.#unpin(key);
    }
    return transcript;
  }

  #unpin(key: string): void {
    const n = this.pins.get(key) ?? 0;
    if (n <= 1) this.pins.delete(key);
    else this.pins.set(key, n - 1);
  }

  /** Drop least recently used, unpinned transcripts until the total is within the budget. */
  #evict(keep: string | null = null): void {
    let total = 0;
    for (const k of this.cache.keys()) total += this.sizes.get(k) ?? 0;
    for (const key of [...this.cache.keys()]) {
      if (total <= this.budget) break;
      if (this.pins.has(key) || key === keep) continue;
      total -= this.sizes.get(key) ?? 0;
      this.sizes.delete(key);
      this.cache.delete(key);
    }
  }

  /** Keep these transcripts cached while one request walks them (a chat's whole family). */
  async hold<T>(keys: Iterable<string>, fn: () => Promise<T>): Promise<T> {
    const list = [...keys];
    for (const key of list) this.pins.set(key, (this.pins.get(key) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      for (const key of list) this.#unpin(key);
      this.#evict();
    }
  }

  /** The cached card data; a chat whose cwd is a Studio-made worktree is filed under its project (not cached). */
  async summary(path: string): Promise<Dict> {
    let item = await this.#summary(path);
    const resolver = this.projectResolver;
    let found: ReturnType<ProjectResolver> = null;
    if (resolver !== null && truthy(item.cwd)) {
      try {
        found = resolver(item.cwd as string);
      } catch {
        found = null;
      }
    }
    if (found) item = { ...item, projectRoot: found.project, worktree: { branch: found.branch ?? '', base: found.base ?? '' } };
    return item;
  }

  async #summary(path: string): Promise<Dict> {
    const stat = await statSig(path);
    const key = await this.key(path);
    const sig = `${stat.size}:${stat.mtimeNs}`;
    const cached = this.summaryCache.get(key);
    if (cached && cached[0] === sig) return cached[1];
    const meta: Dict = {};
    let last: Event | null = null;
    // Session cards use bounded reads; only the selected chat is fully indexed.
    if (stat.isDirectory) throw new Deno.errors.IsADirectory(`Is a directory: '${path}'`);
    const head = await readRange(path, 0, 1048576);
    const tail = await readRange(path, Math.max(0, stat.size - 262144), null);
    bytesSplitlines(head).forEach((line, number) => {
      // The first 60 records always count; later ones only until a real user message gives a title; huge records are skipped.
      const titled = TITLE_ROW.test(LATIN1.decode(line));
      if (number >= 60 && !titled && (Object.hasOwn(meta, 'prompt') || number >= 400 || line.length > 65536)) return;
      const row = loadsBytes(line);
      if (row === undefined) return;
      updateMetadata(meta, row);
    });
    const tailLines = bytesSplitlines(tail);
    for (const line of tailLines) {
      if (TITLE_ROW.test(LATIN1.decode(line))) {
        const row = loadsBytes(line);
        if (row !== undefined) updateMetadata(meta, row);
      }
    }
    for (const line of [...tailLines].reverse()) {
      const row = loadsBytes(line);
      if (row === undefined) continue;
      if (!TITLE_KINDS.includes(get(row, 'type') as string)) updateMetadata(meta, row);
      const events = normalize(row as Dict, 0);
      if (events.length) {
        last = events[events.length - 1];
        break;
      }
    }
    let created: number;
    try {
      created = isoTimestamp(pyStr(dget(meta, 'timestamp', '')).replaceAll('Z', '+00:00'));
    } catch (error) {
      if (!(error instanceof ValueError) && !(error instanceof PyTypeError)) throw error;
      created = stat.created;
    }
    const title = deriveTitle(meta);
    // Cards read only the head and tail. A chat that started in another folder may record its project folder only in the middle,
    // or the tail may be one huge record with no folder. Remember the project folder once found; search the whole file once.
    let found = projectMatch(or(dget(meta, '_cwds'), []) as Json[], path) ?? (this.projectMemo.get(key) || null);
    // Only Claude Code files transcripts under the encoded project folder; once per transcript, '' remembers no match.
    if (!found && !this.projectMemo.has(key) && /^(?:[A-Za-z]--|-)/.test(name(parent(path)))) {
      found = projectMatch(await scanCwds(path), path);
      this.projectMemo.set(key, found || '');
    }
    if (found) {
      this.projectMemo.set(key, found);
      meta.cwd = found;
    } else if (truthy(dget(meta, '_cwds'))) meta.cwd = projectCwd(meta, path);
    delete meta._cwds;
    if (truthy(dget(meta, 'cwd'))) meta.projectRoot = meta.cwd; // saved transcripts are filed under their project folder
    const item: Dict = {
      ...meta,
      created,
      key,
      name: title || stem(name(path)),
      title,
      modified: stat.mtime,
      size: stat.size,
      last,
      hasMessages: last !== null,
    };
    this.summaryCache.set(key, [sig, item]);
    return item;
  }

  async sessions(): Promise<Dict[]> {
    await this.ready();
    const result: Dict[] = [];
    if (await isDir(this.root)) {
      const folders: string[] = [];
      for await (const entry of Deno.readDir(this.root)) folders.push(join(this.root, entry.name));
      for (const folder of folders) {
        if (!(await isDir(folder))) continue;
        const real = await resolve(folder);
        if (real === null || !isRelativeTo(real, this.root)) continue;
        for (const path of await globTail(folder, '.jsonl')) {
          try {
            const item = { ...(await this.summary(path)) };
            const artifactDir = withoutSuffix(path);
            let count = 0;
            if (await isDir(artifactDir)) { for (const child of await rglobTail(artifactDir, '.jsonl')) if (await isFile(child)) count++; }
            item.subagentCount = count;
            result.push(item);
          } catch (error) {
            if (isOSError(error) || error instanceof ValueError) continue;
            throw error;
          }
        }
      }
    }
    return sortSessions(result);
  }

  /** Claude Code writes agent-<id>.meta.json next to a subagent transcript: description, agentType, finished. */
  static async sidecar(agentPath: string): Promise<Dict> {
    try {
      const side = join(parent(agentPath), stem(name(agentPath)) + '.meta.json');
      const info = await Deno.stat(side);
      if (info.isFile && info.size <= 65536) {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await Deno.readFile(side));
        const data = JSON.parse(text);
        return isDict(data) ? data : {};
      }
    } catch { /* missing, unreadable or not JSON */ }
    return {};
  }

  /** Bounded read of a subagent transcript: its first prompt, whether it ended with an error, and whether it reached a natural stop. */
  async subagentHints(path: string): Promise<Dict> {
    let sig: string;
    let head: Uint8Array;
    let tail: Uint8Array;
    try {
      const stat = await statSig(path);
      sig = `${stat.size}:${stat.mtimeNs}`;
      const cached = this.hintCache.get(path);
      if (cached && cached[0] === sig) return cached[1];
      head = await readRange(path, 0, 262144);
      tail = await readRange(path, Math.max(0, stat.size - 65536), null);
    } catch (error) {
      if (!isOSError(error)) throw error;
      return { firstPrompt: '', failed: false, completed: false };
    }
    let prompt = '';
    for (const line of bytesSplitlines(head).slice(0, 80)) {
      if (line.length > 65536) continue;
      const row = loadsBytes(line);
      if (!isDict(row)) continue;
      const msg = isDict(row.message) ? row.message : {};
      if ((row.type === 'user' || row.type === 'message') && dget(msg, 'role') === 'user' && !truthy(dget(row, 'isMeta'))) {
        prompt = cleanPrompt(contentText(dget(msg, 'content', '')));
        if (prompt) break;
      }
    }
    let failed = false;
    let completed = false;
    for (const line of bytesSplitlines(tail).reverse()) {
      const row = loadsBytes(line);
      if (!isDict(row) || !['user', 'assistant', 'message'].includes(row.type as string)) continue;
      const msg = isDict(row.message) ? row.message : {};
      if (dget(msg, 'role') === 'user') break; // the subagent was still being fed work; no end marker yet
      failed = truthy(or(dget(row, 'isApiErrorMessage'), dget(row, 'error')));
      completed = failed || ['end_turn', 'stop_sequence', 'max_tokens'].includes(dget(msg, 'stop_reason') as string);
      break;
    }
    const hints = { firstPrompt: clip(prompt, 300), failed, completed };
    if (this.hintCache.size > 2000) this.hintCache.clear();
    this.hintCache.set(path, [sig, hints]);
    return hints;
  }

  async agents(sessionKey: Json): Promise<Dict[]> {
    const { path } = await this.resolve(sessionKey);
    const folder = withoutSuffix(path);
    const paths = [path];
    if (await isDir(folder)) {
      const real = await resolve(folder);
      if (real !== null && isRelativeTo(real, this.root)) paths.push(...(await rglobTail(folder, '.jsonl')));
    }
    const result: Dict[] = [];
    for (const agent of paths) {
      try {
        const item: Dict = { ...(await this.summary(agent)) };
        const main = agent === path;
        item.active = now() - (item.modified as number) < 90;
        item.name = main ? 'Main conversation' : stem(name(agent)).replace(/^agent-/, '');
        item.source = 'saved';
        if (!main) {
          const side = await Store.sidecar(agent);
          const described = typeof side.description === 'string' ? side.description : '';
          item.description = clip(pyStrip(or(described, dget(item, 'task'), '') as string), 300);
          item.agentType = typeof side.agentType === 'string' ? side.agentType : '';
          item.finished = typeof side.finished === 'boolean' ? side.finished : null;
          item.agentId = item.name;
          for (const field of ['parentAgentId', 'toolUseId']) {
            const value = dget(side, field);
            item[field] = typeof value === 'string' ? clip(pyStrip(value), 120) : '';
          }
          const extra = await this.subagentHints(agent);
          item.firstPrompt = extra.firstPrompt;
          item.failed = (extra.failed as boolean) ||
            ['failed', 'error', 'errored'].includes(pyStr(or(dget(side, 'status'), dget(side, 'state'), '')).toLowerCase());
          item.completedMarker = extra.completed;
          item.result = clip(pyStrip(or(dget(or(item.last, {}) as Dict, 'text'), '') as string), 200);
          if (pyStrip(described)) item.name = clip(splitlines(pyStrip(described))[0], 120);
          else if (extra.firstPrompt) item.name = clip(splitlines(extra.firstPrompt as string)[0], 120);
        }
        item.main = main;
        item.depth = main ? 0 : relativeParts(agent, folder)!.length;
        result.push(item);
      } catch (error) {
        if (isOSError(error) || error instanceof ValueError) continue;
        throw error;
      }
    }
    return result.sort((a, b) =>
      Number(!a.active) - Number(!b.active) || (b.created as number) - (a.created as number) || strCmp(a.key as string, b.key as string)
    );
  }
}

function sortSessions(items: Dict[]): Dict[] {
  return items.sort((a, b) => Number(b.hasMessages) - Number(a.hasMessages) || (b.modified as number) - (a.modified as number));
}

/** Independent source roots with prefixed keys so they never collide. */
export class Catalog {
  stores = new Map<string, Store>();
  root: string;

  constructor(ompRoot: string | null, claudeRoot: string | null) {
    if (ompRoot !== null) this.stores.set('omp', new Store(ompRoot));
    if (claudeRoot !== null) this.stores.set('claude', new Store(claudeRoot));
    this.root = '';
  }

  static async open(ompRoot: string | null, claudeRoot: string | null): Promise<Catalog> {
    const catalog = new Catalog(ompRoot, claudeRoot);
    await catalog.ready();
    return catalog;
  }

  async ready(): Promise<void> {
    for (const store of this.stores.values()) await store.ready();
    this.root = [...this.stores].map(([n, store]) => `${n}: ${store.root}`).join(' · ');
  }

  setProjectResolver(resolver: ProjectResolver | null): void {
    for (const store of this.stores.values()) store.projectResolver = resolver;
  }

  split(key: Json): [string, Store, string] {
    if (typeof key !== 'string') throw new PyAttributeError(`'${pyTypeName(key)}' object has no attribute 'partition'`);
    const at = key.indexOf('/');
    const provider = at < 0 ? key : key.slice(0, at);
    if (at < 0 || !this.stores.has(provider)) throw new ValueError('Unknown transcript source');
    return [provider, this.stores.get(provider)!, key.slice(at + 1)];
  }

  decorate(provider: string, item: Dict): Dict {
    return { ...item, key: provider + '/' + item.key, provider, providerName: provider === 'claude' ? 'Claude Code' : 'OMP' };
  }

  resolve(key: Json): Promise<Resolved> {
    const [, store, rest] = this.split(key);
    return store.resolve(rest);
  }

  /** The project folder of a saved session ('' when unknown), as the chat list shows it. */
  async sessionCwd(provider: string, sessionId: Json): Promise<string> {
    const store = this.stores.get(provider);
    const path = store ? await findSessionFile(provider, store.root, sessionId) : null;
    if (path === null || !store) return '';
    try {
      return (or((await store.summary(path)).cwd, '') as string);
    } catch (error) {
      if (isOSError(error) || error instanceof ValueError) return '';
      throw error;
    }
  }

  load(resolved: Resolved): Promise<Transcript> {
    return resolved.store.load(resolved.path);
  }

  async hold<T>(keys: Iterable<string>, fn: () => Promise<T>): Promise<T> {
    const groups = new Map<string, string[]>();
    for (const key of keys) {
      const [provider, , rest] = this.split(key);
      if (!groups.has(provider)) groups.set(provider, []);
      groups.get(provider)!.push(rest);
    }
    let run = fn;
    for (const [provider, rests] of groups) {
      const inner = run;
      run = () => this.stores.get(provider)!.hold(rests, inner);
    }
    return await run();
  }

  async sessions(): Promise<Dict[]> {
    const items: Dict[] = [];
    for (const [provider, store] of this.stores) for (const item of await store.sessions()) items.push(this.decorate(provider, item));
    return sortSessions(items);
  }

  async agents(key: Json): Promise<Dict[]> {
    const [provider, store, rest] = this.split(key);
    return (await store.agents(rest)).map((item) => this.decorate(provider, item));
  }

  /** The command-list memo of a Catalog lives on the Catalog (as in Python). */
  commandMemo = new Map<string, [string, number, Task[]]>();
  commandLocks = new Map<string, Mutex>();
}

/** What command lists and handlers need from a Store or a Catalog. */
export type Source = Store | Catalog;

// ---- the model a conversation is really running on ---------------------------------------------
// The ACP adapter's advertised "current model" can disagree with what answers. Every assistant record in the agent's own transcript
// names the model that produced it, so the newest one is the best evidence. Read-only: a bounded tail read, cached by size and mtime.
const MODEL_TAIL_WINDOWS = [262144, 1048576, 4194304]; // grow only when the newest records are huge (API snapshots)
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*(?=\n?$)/;
const modelCache = new Map<string, [string, Dict | null]>();
const fileCache = new Map<string, [string | null, number]>();
const ASSISTANT = new TextEncoder().encode('"assistant"');
const MODEL = new TextEncoder().encode('"model"');

/** The model named by one transcript record, or null (synthetic "<...>" and sidechain records do not count). */
export function modelFromRow(row: Json): Dict | null {
  const message = isDict(row) ? dget(row, 'message') : null;
  if (!isDict(message) || (row as Dict).isSidechain === true) return null;
  if (or(dget(message, 'role'), dget(row as Dict, 'type')) !== 'assistant') return null;
  let model = dget(message, 'model');
  if (typeof model !== 'string') return null;
  model = pyStrip(model);
  const m = model as string;
  if (!m || [...m].length > 200 || m.startsWith('<') || !pyIsPrintable(m)) return null;
  const found: Dict = { model: m };
  const provider = dget(message, 'provider');
  if (typeof provider === 'string' && pyStrip(provider) && [...pyStrip(provider)].length <= 100 && pyIsPrintable(provider)) {
    found.provider = pyStrip(provider);
  }
  return found;
}

/** {model, provider?} from the newest real assistant record of a transcript file, or null. Never writes. */
export async function latestAssistantModel(path: string): Promise<Dict | null> {
  const stat = await statSig(path);
  const signature = `${stat.size}:${stat.mtimeNs}`;
  const hit = modelCache.get(path);
  if (hit && hit[0] === signature) {
    modelCache.delete(path);
    modelCache.set(path, hit);
    return hit[1];
  }
  let found: Dict | null = null;
  for (const window of MODEL_TAIL_WINDOWS) {
    const start = Math.max(0, stat.size - window);
    const data = await readRange(path, start, stat.size - start);
    let lines: Uint8Array[] = [];
    let from = 0;
    for (let i = data.indexOf(10); i >= 0; i = data.indexOf(10, from)) {
      lines.push(data.subarray(from, i));
      from = i + 1;
    }
    lines.push(data.subarray(from));
    if (start > 0) lines = lines.slice(1); // the first line is cut in the middle
    for (const line of lines.reverse()) {
      if (!bytesInclude(line, ASSISTANT) || !bytesInclude(line, MODEL)) continue;
      const row = loadsBytes(line);
      if (row === undefined) continue; // a half-written last record, or a cut line
      found = modelFromRow(row);
      if (found) break;
    }
    if (found || start === 0) break;
  }
  modelCache.set(path, [signature, found]);
  while (modelCache.size > 256) modelCache.delete(modelCache.keys().next().value!);
  return found;
}

/** The transcript file of a session id under a provider root (Claude: <root>/<project>/<id>.jsonl; OMP:
 * <root>/<project>/<timestamp>_<id>.jsonl), or null. Lookups are cached; a miss is retried after 10 seconds. */
export async function findSessionFile(
  provider: string,
  root: string | null,
  sessionId: Json,
  at: number | null = null,
): Promise<string | null> {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || [...sessionId].length > 128 || root === null) return null;
  const t = at ?? now();
  const key = JSON.stringify([provider, root, sessionId]);
  const cached = fileCache.get(key);
  if (cached && ((cached[0] !== null && (await isFile(cached[0]))) || (cached[0] === null && t - cached[1] < 10))) return cached[0];
  let path: string | null = null;
  const base = await resolve(root);
  if (base !== null) {
    try {
      for await (const entry of Deno.readDir(base)) {
        const dir = join(base, entry.name);
        if (!(await isDir(dir))) continue;
        const candidates = provider === 'claude' ? [join(dir, sessionId + '.jsonl')] : await globTail(dir, `_${sessionId}.jsonl`);
        for (const candidate of candidates) {
          const real = await resolve(candidate);
          if ((await isFile(candidate)) && real !== null && isRelativeTo(real, base)) {
            path = candidate;
            break;
          }
        }
        if (path) break;
      }
    } catch (error) {
      if (!isOSError(error)) throw error;
      path = null;
    }
  }
  fileCache.set(key, [path, t]);
  while (fileCache.size > 512) fileCache.delete(fileCache.keys().next().value!);
  return path;
}

/** {model, provider?, source: 'transcript'} for a live conversation, or null when it cannot be known. */
export async function modelInUse(
  provider: string,
  sessionId: Json,
  claudeRoot: string | null = null,
  ompRoot: string | null = null,
): Promise<Dict | null> {
  const root = provider === 'claude' ? claudeRoot : provider === 'omp' ? ompRoot : null;
  const path = await findSessionFile(provider, root, sessionId);
  if (path === null) return null;
  let found: Dict | null;
  try {
    found = await latestAssistantModel(path);
  } catch (error) {
    if (!isOSError(error)) throw error;
    return null;
  }
  return found ? { ...found, source: 'transcript' } : null;
}

/**
 * The local docs' routes (Deno only: routes.ts DENO_ONLY). A doc belongs to a project: the folder is always the one Studio
 * knows for the chat (files_routes.rootFor, the main checkout for a worktree chat), never a folder named in the request. All POSTs
 * take the page token; the user's own changes run with the user's origin. A refusal is 400 (409 for "not now") {error, code}.
 *
 *   POST /api/live/docs/open {id, name, create?}    the page opens a doc (`create`: Markdown, makes a new one and links it to chat
 *                                                   `id`; opening never re-links): {doc, name, file, rev, epoch, ...info}.
 *   GET  /api/live/docs/list?id=<chat>&root=chat|main  the docs of the folder the Files view shows for that chat (files_routes
 *                                                   rootFor): {docs: [{name, title, dir, owned, pages, pageList: [{id, title}],
 *                                                   chat (linked chat), open, editedAt, editedBy, writing: [{chat, name, page,
 *                                                   section}]}], others: [aib-docs/<x>: files there that are no doc]}. The
 *                                                   Docs tab, Files, Ctrl+K, chips and the Artifacts picker.
 *   GET  /api/live/docs/built?id=<chat>&artifact=   an artifact built from a doc page (its manifest's fromDoc): {built: {doc, title,
 *                                                   page, pageTitle, rev, builtRev, changed, edits} | {gone: 'doc'|'page'} | null}.
 *   GET  /api/live/docs/shown?doc=<doc>             the doc header's "Shown in N artifacts": {artifacts: [{id, title, kind,
 *                                                   conversationId, page, pageTitle}]} (this project's artifacts built from it).
 *   POST /api/live/docs/link {doc, id}              link the doc to chat `id` (the user picked it): comments "Send" go there.
 *   GET  /api/live/docs/info?doc=<doc>              what the UI can show about an open doc: store.info (pages, rev, epoch, skipped
 *                                                   file edits, lossy blocks, linked chat, comment threads, claims, delete requests,
 *                                                   refused notes, presence), `dir` + `owned` (the files that are the doc's: hide
 *                                                   exactly those), and the history (versions with n, rev, by, at).
 *   POST /api/live/docs/page {doc, action, ...}     the user's page operations: add {title, after?}, rename {page, title}, move
 *                                                   {page, index}, duplicate {page, title?}, delete {page} (history snapshot first).
 *   POST /api/live/docs/page/request {doc, page, chat?, decision}  answer an agent's page delete request: "delete" (the page as it
 *                                                   stands, history snapshot first) or "keep"; the chat hears it in its next doc call.
 *   POST /api/live/docs/claim/release {doc, chat}   "Stop and keep the text": drop the chat's claim; its next edit of those blocks
 *                                                   is refused user_took_back.
 *   POST /api/live/docs/notes/dismiss {doc, note}   dismiss a refused-edit note (`note`: its id, or "all").
 *   POST /api/live/docs/edit {doc, page?, ops}      the user's block operations through the server (chart_from_table, table ops,
 *                                                   style...): doc_edit's ops, with the user's origin, unguarded (the user's call).
 *   POST /api/live/docs/comment {doc, action, ...}  the user's comments: add {text, block, from, to | target? | none = whole doc},
 *                                                   reply {thread, text}, resolve {thread}, reopen {thread}.
 *   POST /api/live/docs/comment/send {doc, thread, chat?}  "Send to agent": the thread becomes a user message queued to the
 *                                                   doc's linked chat (or `chat`), the same queue the composer uses (live op
 *                                                   `queue`). Sending the same thread state twice is one message.
 *   GET  /api/live/docs/history?doc=<doc>           the versions, newest first: n, rev, at, `by` (raw), `authors` (names: "You",
 *                                                   "Claude Code"), `pages` (the pages that changed against the version before), note.
 *   GET  /api/live/docs/history/version?doc=&n=     one version: {n, title, pages: [{id, title, nodes}], markdown}.
 *   POST /api/live/docs/history/restore {doc, version, page?, client?, clock?}  restore the whole doc or one page. `client` +
 *                                                   `clock` = the page's Y.Doc clientID and its clock: refused in_flight while the
 *                                                   server has not got all its keystrokes; agent_writing while an agent works here.
 *   POST /api/live/docs/export {doc, scope, page?}  Markdown to the Downloads folder (AIB_DOWNLOADS_DIR overrides it): scope "page"
 *                                                   (one page) or "all"; never overwrites (" (2)"); {path, name, folder}.
 *   POST /api/live/docs/duplicate {doc, id}         "Duplicate doc": a new doc "<title> copy" in the same project with every page, its
 *                                                   rich blocks and drawings (no agent marks, no comments), linked to chat `id`.
 *                                                   {doc, name, title, dir}.
 *   POST /api/live/docs/trash {doc}                 "Move doc to trash": a history version first (history stays in AIB's state), the
 *                                                   open pages are told {type: "closed"}, then the doc's folder goes to the system
 *                                                   trash (never deleted outright: no trash = refused, nothing removed).
 *   POST /api/live/docs/reveal {doc, path}          "Show in folder" after an export: only a file AIB wrote into the Downloads folder.
 *   GET  /api/live/docs/socket?doc=<doc>&epoch=<e>  the editor's WebSocket (y-protocols sync + awareness, binary; AIB's control
 *                                                   messages as JSON text frames). A browser cannot set headers on a WebSocket, so
 *                                                   the page offers two subprotocols, `aib-docs` and `aib-token.<page token>`, as
 *                                                   the terminal does. First message: {type: "hello", epoch, rev}. A doc that is not
 *                                                   open, or another epoch than the page's: {type: "reopen", reason} then close.
 *   POST /api/live/docs/tool {conversationId, tool, args}  an agent's doc_* tool (tools.ts, offered by mcp.ts), with the
 *                                                   conversation's artifact key (own gate, like /api/live/artifacts/publish).
 *                                                   200 {ok, result}: a refusal is ok=false with Claude Docs' code.
 */
import * as Y from 'yjs';
import { authorize, Refusal, TOKEN_HEADER } from './security.ts';
import { ROUTES } from './routes.ts';
import { upgradeWebSocket, wantsWebSocket } from '../platform/websocket.ts';
import { rootFor } from './files_routes.ts';
import { runDocTool } from '../docs/tools.ts';
import { DocRefusal } from '../docs/live_doc.ts';
import { commentMessage } from '../docs/comments.ts';
import type { OpenDoc } from '../docs/store.ts';
import { agentName, authorNames } from '../docs/agents.ts';
import { pageNodes, restoreDrawings, versionAib } from '../docs/aibdoc.ts';
import { withoutAgentMarks } from '../docs/store.ts';
import { osTrash, type TrashLayer } from '../desktop/project_delete.ts';
import { parseDoc } from '../docs/markdown.ts';
import { TOKEN_PROTOCOL_PREFIX } from './terminal_routes.ts';
import type { WebContext } from './server.ts';

export const DOCS_SOCKET = '/api/live/docs/socket';
export const DOCS_PROTOCOL = 'aib-docs';
export const DOCS_TOOL = '/api/live/docs/tool';

type Json = Record<string, unknown>;
type Reply = [number, unknown];
type Route = (ctx: WebContext, url: URL, body: Json | null) => Promise<Reply>;

const sep = Deno.build.os === 'windows' ? '\\' : '/';
const NOT_OPEN: Reply = [404, { error: 'Open the doc first', code: 'doc_not_open' }];

function refused(error: unknown): Reply {
  if (error instanceof DocRefusal) return [400, { ...error.toJSON(), error: error.message, code: error.code }];
  throw error;
}

/** A route on an open doc (`doc` from the body, or the query for a GET); DocRefusal answers 400. */
function onDoc(work: (ctx: WebContext, doc: OpenDoc, args: Json, url: URL) => Promise<Reply> | Reply): Route {
  return async (ctx, url, body) => {
    const args: Json = body ?? Object.fromEntries(url.searchParams);
    const doc = ctx.docs.get(String(args.doc ?? ''));
    if (!doc) return NOT_OPEN;
    try {
      return await work(ctx, doc, args, url);
    } catch (error) {
      return refused(error);
    }
  };
}

export function docsRoutes(): Map<string, Route> {
  const routes = new Map<string, Route>();
  routes.set('POST /api/live/docs/open', async (ctx, _url, body) => {
    const root = await rootFor(ctx, { id: [String(body?.id ?? '')], root: ['main'] });
    if (typeof root !== 'string') return root;
    try {
      const create = typeof body?.create === 'string' ? body.create : undefined;
      const doc = await ctx.docs.open(root, body?.name, create);
      // a new doc is linked to the chat it was made from; opening one never moves its link (the link route is the user's pick)
      if (create !== undefined) ctx.docs.link(doc, ctx.artifacts.chatOf(String(body?.id ?? '')), true);
      return [200, { ok: true, ...(await ctx.docs.infoWithOwned(doc)) }];
    } catch (error) {
      return refused(error);
    }
  });
  routes.set('GET /api/live/docs/list', async (ctx, url) => {
    const root = await rootFor(ctx, { id: [url.searchParams.get('id') ?? ''], root: [url.searchParams.get('root') || 'main'] });
    if (typeof root !== 'string') return root;
    return [200, { ok: true, docs: await ctx.docs.list(root), others: await ctx.docs.others(root) }];
  });
  // "Built from <doc › page>" in the Artifacts viewer: has the page changed since the artifact was built?
  routes.set('GET /api/live/docs/built', async (ctx, url) => {
    const root = await rootFor(ctx, { id: [url.searchParams.get('id') ?? ''], root: ['main'] });
    if (typeof root !== 'string') return root;
    const artifact = url.searchParams.get('artifact') ?? '';
    let from: Json | null = null;
    try {
      const m = ctx.artifacts.service.store.get(artifact);
      from = m.fromDoc && typeof m.fromDoc === 'object' ? m.fromDoc as Json : null;
    } catch {
      return [404, { error: 'No such artifact', code: 'no_artifact' }];
    }
    if (!from) return [200, { ok: true, built: null }];
    return [200, { ok: true, built: await builtState(ctx, root, from) }];
  });
  // The doc header's chip "Shown in 2 artifacts": the artifacts of this project built from the doc (any page).
  routes.set(
    'GET /api/live/docs/shown',
    onDoc((ctx, doc) => {
      const out: Json[] = [];
      for (const a of ctx.artifacts.service.store.list(null) as Json[]) {
        const f = a.fromDoc as Json | undefined;
        if (!f || f.doc !== doc.name) continue;
        try {
          const m = ctx.artifacts.service.store.get(a.id);
          if (m.project && !sameProject(String(m.project), doc.projectRoot)) continue;
        } catch {
          continue;
        }
        out.push({ id: a.id, title: a.title, kind: a.kind, conversationId: a.conversationId, page: f.page, pageTitle: f.pageTitle });
      }
      return [200, { ok: true, artifacts: out }];
    }),
  );
  routes.set(
    'POST /api/live/docs/link',
    onDoc((ctx, doc, args) => {
      const chat = ctx.artifacts.chatOf(String(args.id ?? ''));
      if (!chat) return [400, { error: 'Name the chat to link', code: 'no_chat' }];
      ctx.docs.link(doc, chat, true);
      return [200, { ok: true, chat: doc.chat }];
    }),
  );
  routes.set(
    'GET /api/live/docs/info',
    onDoc(async (ctx, doc) => [200, { ok: true, ...(await ctx.docs.infoWithOwned(doc)), history: ctx.docs.history(doc) }]),
  );
  routes.set(
    'POST /api/live/docs/page',
    onDoc((ctx, doc, args) => [200, { ...ctx.docs.userPageOp(doc, args.action, args), pages: doc.live.pages() }]),
  );
  routes.set(
    'POST /api/live/docs/page/request',
    onDoc((ctx, doc, args) => [200, { ...ctx.docs.decideRequest(doc, args.page, args.chat, args.decision), pages: doc.live.pages() }]),
  );
  routes.set(
    'POST /api/live/docs/claim/release',
    onDoc((_ctx, doc, args) => {
      const claim = doc.agents.release(String(args.chat ?? ''), 'user');
      if (!claim) return [400, { error: 'That chat is not rewriting anything here (any more).', code: 'no_claim' }];
      return [200, { ok: true, released: claim }];
    }),
  );
  routes.set(
    'POST /api/live/docs/notes/dismiss',
    onDoc((_ctx, doc, args) => [200, { ok: true, dismissed: doc.agents.dismiss(args.note), notes: doc.agents.notes }]),
  );
  routes.set(
    'POST /api/live/docs/edit',
    onDoc((_ctx, doc, args) => {
      const ops = Array.isArray(args.ops) ? args.ops.map((op) => (op && typeof op === 'object' ? { ...op, force: true } : op)) : args.ops;
      return [200, doc.live.edit(ops, doc.live.user, args.page)];
    }),
  );
  routes.set('POST /api/live/docs/comment', onDoc((_ctx, doc, args) => [200, { ok: true, ...userComment(doc, args) }]));
  routes.set('POST /api/live/docs/comment/send', async (ctx, _url, body) => {
    const doc = ctx.docs.get(String(body?.doc ?? ''));
    if (!doc) return NOT_OPEN;
    const chat = typeof body?.chat === 'string' && body.chat ? body.chat : doc.chat;
    if (!chat) return [409, { error: 'This doc is not linked to a chat yet: choose the chat to send it to.', code: 'no_chat' }];
    return await sendComment(ctx, doc, body?.thread, chat);
  });
  routes.set('GET /api/live/docs/history', onDoc((ctx, doc) => [200, { ok: true, ...historyList(ctx, doc) }]));
  routes.set(
    'GET /api/live/docs/history/version',
    onDoc((ctx, doc, args) => [200, { ok: true, ...readVersion(ctx, doc, Number(args.n)) }]),
  );
  routes.set(
    'POST /api/live/docs/history/restore',
    onDoc(async (ctx, doc, args) => {
      const live = doc.live;
      if (
        typeof args.client === 'number' && typeof args.clock === 'number' &&
        (Y.decodeStateVector(Y.encodeStateVector(live.doc)).get(args.client) ?? 0) < args.clock
      ) {
        return [409, {
          error: 'Your last keystrokes have not reached AIB yet: nothing was restored. Try again in a moment.',
          code: 'in_flight',
        }];
      }
      const writing = doc.agents.presence();
      if (writing.length) {
        const name = String(writing[0].name ?? 'An agent');
        return [409, { error: `${name} is still writing: nothing was restored. Restore once it stops.`, code: 'agent_writing', name }];
      }
      const n = Number(args.version);
      if (!Number.isInteger(n) || n < 1) return [400, { error: '`version` is a version number', code: 'bad_op' }];
      const page = typeof args.page === 'string' && args.page ? args.page : undefined;
      return [200, { ok: true, ...(await ctx.docs.restore(doc, n, live.rev, live.user, page)), pages: live.pages() }];
    }),
  );
  routes.set(
    'POST /api/live/docs/export',
    onDoc(async (ctx, doc, args) => [200, { ok: true, ...(await exportMarkdown(ctx, doc, args)) }]),
  );
  routes.set(
    'POST /api/live/docs/duplicate',
    onDoc(async (ctx, doc, args) => [200, { ok: true, ...(await duplicateDoc(ctx, doc, args)) }]),
  );
  routes.set('POST /api/live/docs/trash', onDoc(async (ctx, doc) => [200, { ok: true, ...(await trashDoc(ctx, doc)) }]));
  routes.set('POST /api/live/docs/reveal', onDoc(async (_ctx, _doc, args) => [200, { ok: true, ...(await revealExport(args.path)) }]));
  return routes;
}

/** "Duplicate doc": every page as it stands now (rich blocks and drawings kept, agent marks and comments left out). */
async function duplicateDoc(ctx: WebContext, doc: OpenDoc, args: Json): Promise<Json> {
  await ctx.docs.flush(doc);
  const aib = doc.aib.doc;
  if (!aib) throw new DocRefusal('bad_op', 'The doc is still loading; try again in a moment.');
  let copy: OpenDoc | null = null;
  for (let k = 1; k < 100 && !copy; k++) {
    const title = `${doc.title} copy${k === 1 ? '' : ` ${k}`}`.slice(0, 100);
    if (await ctx.docs.exists(doc.projectRoot, title)) continue;
    try {
      copy = await ctx.docs.open(doc.projectRoot, title, '');
    } catch (error) {
      if (!(error instanceof DocRefusal) || !['doc_exists', 'folder_exists'].includes(error.code)) throw error;
    }
  }
  if (!copy) throw new DocRefusal('bad_op', 'Too many copies of this doc already.');
  const live = copy.live;
  live.setPages(aib.pages.map((p) => ({ id: p.id, title: p.title, nodes: pageNodes(p).map(withoutAgentMarks) })), live.user);
  if (aib.drawings.length) live.doc.transact(() => restoreDrawings(live.doc, aib.drawings), live.user);
  const chat = ctx.artifacts.chatOf(String(args.id ?? ''));
  if (chat) ctx.docs.link(copy, chat, true);
  await ctx.docs.flush(copy);
  return { doc: copy.id, name: copy.name, title: copy.title, dir: copy.dir };
}

/** "Move doc to trash": snapshot, tell the open pages, close it, then the folder to the system trash. */
async function trashDoc(ctx: WebContext, doc: OpenDoc): Promise<Json> {
  const layer = (ctx as unknown as { trashLayer?: TrashLayer }).trashLayer ?? osTrash;
  const folder = doc.dir;
  const kind = await layer.kind(folder);
  if (kind === 'permanent') throw new DocRefusal('no_trash', 'There is no trash on this drive, so AIB did not delete the doc.');
  ctx.docs.snapshot(doc, 'moved to the trash');
  await ctx.docs.flush(doc);
  doc.live.sendControl({ type: 'closed' });
  ctx.docs.docs.delete(doc.id);
  if (doc.timer !== null) clearTimeout(doc.timer);
  if (doc.snapTimer !== null) clearTimeout(doc.snapTimer);
  doc.agents.destroy();
  doc.live.destroy();
  await layer.trash(folder, kind);
  return { trashed: doc.name };
}

/** "Show in folder" for a Markdown export: Explorer / Finder / the file manager on a file in the Downloads folder only. */
async function revealExport(value: unknown): Promise<Json> {
  const path = typeof value === 'string' ? value : '';
  const dir = downloadsDir();
  const inside = path.toLowerCase().startsWith((dir + sep).toLowerCase()) && !path.slice(dir.length).includes('..');
  if (!inside || !(await Deno.stat(path).then((s) => s.isFile, () => false))) {
    throw new DocRefusal('bad_op', 'That file is not an export in the Downloads folder.');
  }
  const os = Deno.build.os;
  const [cmd, cmdArgs] = os === 'windows' ? ['explorer.exe', [`/select,${path}`]] : os === 'darwin' ? ['open', ['-R', path]] : [
    'xdg-open',
    [dir],
  ];
  new Deno.Command(cmd, { args: cmdArgs as string[], stdin: 'null', stdout: 'null', stderr: 'null' }).spawn().unref();
  return { shown: path };
}

/** The user's comment actions, with the user's origin. */
function userComment(doc: OpenDoc, args: Json): Json {
  const live = doc.live, comments = live.comments;
  switch (args.action) {
    case 'add': {
      let range = null;
      if (typeof args.block === 'string') {
        const el = live.elementOf(args.block);
        if (!el) throw new DocRefusal('block_gone', 'That text is gone; select it again.');
        const from = Number(args.from), to = Number(args.to);
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from) {
          throw new DocRefusal('bad_op', "`from` and `to` are the selection's offsets in the block's text");
        }
        range = { el, from, to };
      } else if (args.target) range = live.range(args.target, args.page);
      return comments.add('user', args.text, range, live.user) as unknown as Json;
    }
    case 'reply':
      return comments.reply('user', args.thread, args.text, live.user) as unknown as Json;
    case 'resolve':
      return comments.resolve('user', args.thread, { agent: false }, live.user) as unknown as Json;
    case 'reopen':
      return comments.reopen('user', args.thread, live.user) as unknown as Json;
    default:
      throw new DocRefusal('bad_op', '`action` is add, reply, resolve or reopen');
  }
}

/** The pages of a version's text, by id: title and a key of its content, to compare. */
function versionPages(text: string | null): Map<string, { title: string; key: string }> {
  const out = new Map<string, { title: string; key: string }>();
  if (text === null) return out;
  const aib = versionAib(text);
  if (aib) { for (const p of aib.pages) out.set(p.id, { title: p.title, key: p.title + '\0' + JSON.stringify(pageNodes(p)) }); }
  else out.set('', { title: '', key: text });
  return out;
}

/** The history for the page: newest first, with names and the pages each version changed. */
function historyList(ctx: WebContext, doc: OpenDoc): Json {
  const { latest, versions } = ctx.docs.history(doc) as { latest: number; versions: Json[] };
  const recent = versions.slice(-100);
  const history = ctx.docs.options.history;
  const firstN = recent.length ? recent[0].n as number : 0;
  let prev = firstN > 1 ? versionPages(history?.read(doc, firstN - 1) ?? null) : new Map<string, { title: string; key: string }>();
  const out: Json[] = [];
  for (const v of recent) {
    const now = versionPages(history?.read(doc, v.n as number) ?? null);
    const pages: { id: string; title: string; change: string }[] = [];
    for (const [id, p] of now) {
      const was = prev.get(id);
      if (!was) pages.push({ id, title: p.title, change: prev.size ? 'added' : 'created' });
      else if (was.key !== p.key) pages.push({ id, title: p.title, change: 'changed' });
    }
    for (const [id, p] of prev) if (!now.has(id)) pages.push({ id, title: p.title, change: 'deleted' });
    out.push({ ...v, authors: authorNames(String(v.by ?? '')), pages });
    prev = now;
  }
  return { latest, versions: out.reverse(), linkedName: doc.chat ? agentName(doc.chat) : null };
}

function readVersion(ctx: WebContext, doc: OpenDoc, n: number): Json {
  if (!Number.isInteger(n) || n < 1) throw new DocRefusal('bad_op', '`n` is a version number');
  const text = ctx.docs.versionText(doc, n);
  const aib = versionAib(text);
  const markdown = ctx.docs.readVersion(doc, n);
  if (aib) return { n, title: aib.title, pages: aib.pages.map((p) => ({ id: p.id, title: p.title, nodes: pageNodes(p) })), markdown };
  const first = doc.live.pageList()[0];
  return { n, title: doc.title, pages: [{ id: first.id, title: first.title, nodes: parseDoc(text).blocks.map((b) => b.node) }], markdown };
}

/** The Downloads folder: AIB_DOWNLOADS_DIR (tests), else the user's Downloads. */
export function downloadsDir(): string {
  const set = Deno.env.get('AIB_DOWNLOADS_DIR');
  if (set) return set;
  const home = Deno.env.get('USERPROFILE') ?? Deno.env.get('HOME') ?? '.';
  return `${home}${sep}Downloads`;
}

function fileName(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120) || 'Doc';
}

/** Write `text` to `<dir>/<base>.md`, or "<base> (2).md"... when taken: never over a file. */
async function writeNew(dir: string, base: string, text: string): Promise<string> {
  await Deno.mkdir(dir, { recursive: true });
  for (let k = 1; k < 1000; k++) {
    const path = `${dir}${sep}${base}${k === 1 ? '' : ` (${k})`}.md`;
    try {
      const file = await Deno.open(path, { write: true, createNew: true });
      try {
        await file.write(new TextEncoder().encode(text));
      } finally {
        file.close();
      }
      return path;
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }
  }
  throw new DocRefusal('export_failed', 'Too many files of that name in Downloads.');
}

/** Export Markdown: one page (`scope` "page", `page`) or all pages (each under its title as a heading). */
async function exportMarkdown(ctx: WebContext, doc: OpenDoc, args: Json): Promise<Json> {
  const live = doc.live;
  const scope = args.scope === 'page' ? 'page' : args.scope === 'all' ? 'all' : null;
  if (!scope) throw new DocRefusal('bad_op', '`scope` is "page" or "all"');
  let text: string, base: string;
  if (scope === 'page') {
    const page = live.resolvePage(args.page);
    const title = live.pageList().find((p) => p.id === page)!.title;
    text = ctx.docs.pageMarkdown(doc, page);
    base = live.pageList().length > 1 ? `${fileName(doc.title)} - ${fileName(title)}` : fileName(doc.title);
  } else {
    const pages = live.pageList();
    text = pages.length === 1
      ? ctx.docs.pageMarkdown(doc, pages[0].id)
      : pages.map((p) => `# ${p.title}\n\n${ctx.docs.pageMarkdown(doc, p.id).replace(/\s+$/, '')}\n`).join('\n');
    base = fileName(doc.title);
  }
  const path = await writeNew(downloadsDir(), base, text);
  return { path, name: path.slice(path.lastIndexOf(sep) + 1), folder: path.slice(0, path.lastIndexOf(sep)) };
}

/**
 * Turn a comment thread into a user message and queue it to a chat (`chat`: its lasting id or a live connection id), exactly as the
 * composer's queue does (live op `queue`, sent at once when the agent is idle). The message id is the thread's state, so a second
 * send of the same state is a duplicate, not a second message. The thread remembers where it was sent.
 */
export async function sendComment(ctx: WebContext, doc: OpenDoc, thread: unknown, chat: string): Promise<Reply> {
  let view;
  try {
    view = doc.live.comments.get(thread);
  } catch (error) {
    if (error instanceof DocRefusal) return [404, { error: error.message, code: error.code }];
    throw error;
  }
  await ctx.artifacts.refresh().catch(() => {});
  const connection = ctx.artifacts.connectionOf(chat);
  if (!connection) return [409, { error: 'That chat is not open: open it, then send again.', code: 'chat_not_open', chat }];
  const text = commentMessage(doc.name, doc.file, view);
  const clientMessageId = `doc-comment-${doc.id}-${view.thread}-${view.replies.length}`;
  const [status, payload] = await ctx.host.liveCall('queue', { id: connection, text, clientMessageId });
  if (status !== 200) return [status, payload];
  doc.live.comments.markSent(view.thread, ctx.artifacts.chatOf(connection), doc.live.system);
  return [200, { ...(payload as Json), ok: true, thread: view.thread, chat: ctx.artifacts.chatOf(connection), text }];
}

/** POST /api/live/docs/tool, after the own gate checked the conversation's key against the body's conversationId. */
/**
 * The doc page an artifact is built from (the publish/update tool's `fromDoc` {doc, page}): {doc (folder name), title, page (id),
 * pageTitle, rev (the page's rev now)}. Refused like a doc tool when the doc or the page is not there.
 */
export async function resolveFromDoc(ctx: WebContext, conversationId: string, value: unknown): Promise<Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DocRefusal('bad_from_doc', '`fromDoc` must be {"doc": "<name>", "page": "<page title or id>"}');
  }
  const v = value as Json;
  const chat = ctx.artifacts.chatOf(conversationId);
  const root = await rootFor(ctx, { id: [chat], root: ['main'] });
  if (typeof root !== 'string') throw new DocRefusal('no_project', 'This chat has no project folder, so it has no docs.');
  const doc = await ctx.docs.open(root, v.doc);
  const page = doc.live.resolvePage(v.page);
  const p = doc.live.pageList().find((x) => x.id === page)!;
  return { doc: doc.name, title: doc.title, page, pageTitle: p.title, rev: doc.live.pageRev(page).rev };
}

/** Where an artifact built from a doc page stands: the names now, and the edits to that page since it was built. */
async function builtState(ctx: WebContext, root: string, from: Json): Promise<Json> {
  let doc: OpenDoc;
  try {
    doc = await ctx.docs.open(root, from.doc);
  } catch {
    return { doc: from.doc, title: from.title, pageTitle: from.pageTitle, gone: 'doc' };
  }
  const page = doc.live.pageList().find((p) => p.id === from.page);
  if (!page) return { doc: doc.name, title: doc.title, pageTitle: from.pageTitle, gone: 'page' };
  const built = Number(from.rev) || 0;
  const now = doc.live.pageRev(page.id, built);
  return { doc: doc.name, title: doc.title, page: page.id, pageTitle: page.title, rev: now.rev, builtRev: built, changed: now.rev > built,
    edits: now.rev > built ? Math.max(1, now.edits) : 0 };
}

export async function docsTool(ctx: WebContext, body: Json): Promise<Reply> {
  const conversation = String(body.conversationId ?? '');
  const chat = ctx.artifacts.chatOf(conversation);
  const root = await rootFor(ctx, { id: [chat], root: ['main'] });
  if (typeof root !== 'string') return root;
  const tool = typeof body.tool === 'string' ? body.tool : '';
  const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args as Json : {};
  const agent = chat.includes(':') ? chat.slice(0, chat.indexOf(':')) : 'agent';
  const [ok, result] = await runDocTool(ctx.docs, root, agent, tool, args, chat);
  return [200, { ok, result }];
}

function sameProject(a: string, b: string): boolean {
  const k = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return Deno.build.os === 'windows' ? k(a).toLowerCase() === k(b).toLowerCase() : k(a) === k(b);
}

function offered(request: Request): string[] {
  return (request.headers.get('sec-websocket-protocol') ?? '').split(',').map((p) => p.trim()).filter(Boolean);
}

/**
 * GET /api/live/docs/socket. Refusals of the caller happen before the upgrade, so a page that is not ours never gets a socket. A doc
 * that is not open (AIB restarted) or another epoch than the page synced with is told on the socket ({type: "reopen"}), so the page
 * calls /open again and drops its old copy instead of looping on a 404 or merging it in as duplicate blocks.
 */
export function docsSocket(ctx: WebContext, request: Request, url: URL): { refused: Reply } | { response: Response } {
  const protocols = offered(request);
  const token = protocols.find((p) => p.startsWith(TOKEN_PROTOCOL_PREFIX))?.slice(TOKEN_PROTOCOL_PREFIX.length) ?? '';
  const headers = new Headers(request.headers);
  headers.delete(TOKEN_HEADER);
  if (token) headers.set(TOKEN_HEADER, token);
  const allowed = authorize({ method: 'GET', path: DOCS_SOCKET, headers }, ctx.gate, ROUTES.scopeFor('GET', DOCS_SOCKET));
  if (allowed instanceof Refusal) return { refused: [allowed.status, { error: allowed.message(DOCS_SOCKET) }] };
  if (request.headers.get('Origin') === null) return { refused: [403, { error: 'Request must come from the AIB page' }] };
  if (!wantsWebSocket(request) || !protocols.includes(DOCS_PROTOCOL)) {
    return { refused: [400, { error: 'This address only takes a doc WebSocket.' }] };
  }
  const doc = ctx.docs.get(url.searchParams.get('doc') ?? '');
  const epoch = url.searchParams.get('epoch');
  const { link, response } = upgradeWebSocket(request, DOCS_PROTOCOL);
  if (!doc || (epoch && epoch !== doc.epoch)) {
    link.onmessage = () => {};
    link.send(JSON.stringify(doc ? { type: 'reopen', reason: 'epoch', epoch: doc.epoch } : { type: 'reopen', reason: 'doc_not_open' }));
    link.close(doc ? 4409 : 4404, doc ? 'doc reloaded' : 'doc not open');
    return { response };
  }
  link.send(JSON.stringify({ type: 'hello', epoch: doc.epoch, rev: doc.live.rev, doc: doc.id }));
  doc.live.attach(link);
  return { response };
}

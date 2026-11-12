/**
 * The agent's doc tools, server side: POST /api/live/docs/tool (docs_routes.ts) runs them here. Their MCP definitions are in
 * tool_defs.ts. A refusal carries a `code`, the block as it stands and what to do next.
 */
import { DocRefusal } from './live_doc.ts';
import type { DocStore, OpenDoc } from './store.ts';
import { DOC_TOOL_NAMES } from './tool_defs.ts';
import { DRAWING_TOOL_NAMES, runDrawingTool } from './drawing/agent.ts';

export { DOC_INSTRUCTIONS, DOC_TOOL_NAMES, DOC_TOOLS } from './tool_defs.ts';

type Json = Record<string, unknown>;

/**
 * Run one doc tool for an agent working in `projectRoot`. File-tool edits to the doc's Markdown copy are taken in first, so the
 * agent sees them. Returns [ok, payload]: a refusal is a normal answer (ok=false) with Claude Docs' code. `chat` (the chat's lasting
 * id) is the agent's origin in the doc (undo, guards, claims, presence and refused notes are per chat; `agent` alone in tests) and
 * becomes the doc's linked chat if it has none yet: "Send to agent" on a comment goes there. Comments keep `agent` as their author.
 * What the user decided meanwhile (kept a page, took a section back) comes with the result as `userNotes`.
 */
export async function runDocTool(
  store: DocStore,
  projectRoot: string,
  agent: string,
  tool: string,
  args: Json,
  chat: string | null = null,
): Promise<[boolean, Json]> {
  const who = chat || agent;
  let doc: OpenDoc | null = null;
  try {
    if (!DOC_TOOL_NAMES.has(tool) && !DRAWING_TOOL_NAMES.has(tool)) throw new DocRefusal('bad_tool', `Unknown doc tool: ${tool}`);
    if (tool === 'doc_list') return [true, { docs: await store.list(projectRoot) }];
    if (tool === 'doc_create') {
      const markdown = args.markdown === undefined ? '' : args.markdown;
      if (typeof markdown !== 'string') throw new DocRefusal('bad_op', '`markdown` is the first content, as a string');
      const created = await store.open(projectRoot, args.doc, markdown, chat || undefined);
      if (chat) store.link(created, chat, false);
      if (args.title !== undefined) created.live.renamePage(created.live.firstPage, args.title, created.live.system);
      created.agents.seen.set(who, created.live.rev);
      return [true, { doc: created.name, file: created.file, created: true, ...created.live.read(), pages: created.live.pages() }];
    }
    doc = await store.open(projectRoot, args.doc);
    if (chat) store.link(doc, chat, false);
    await store.syncMirror(doc);
    const [ok, result] = await run(store, doc, who, agent, tool, args);
    const notes = doc.agents.takeNotices(who);
    return [ok, notes.length ? { ...result, userNotes: notes } : result];
  } catch (error) {
    if (!(error instanceof DocRefusal)) throw error;
    if (doc && (tool === 'doc_edit' || tool === 'doc_page')) {
      let page: string | null = null;
      try {
        page = doc.live.resolvePage(args.page);
      } catch { /* no such page */ }
      doc.agents.refused(who, tool === 'doc_edit' ? args.ops : [], error, page);
    }
    const notes = doc?.agents.takeNotices(who) ?? [];
    return [false, notes.length ? { ...error.toJSON(), userNotes: notes } : error.toJSON()];
  }
}

async function run(store: DocStore, doc: OpenDoc, who: string, agent: string, tool: string, args: Json): Promise<[boolean, Json]> {
  const live = doc.live;
  const origin = live.originFor('agent', who);
  const seen = () => doc.agents.seen.set(who, live.rev);
  if (DRAWING_TOOL_NAMES.has(tool)) return await runDrawingTool(doc, who, tool, args);
  const head = { doc: doc.name, file: doc.file };
  const skipped = doc.skipped.length ? { fileEditsSkipped: doc.skipped.slice(-10) } : {};
  const working = () => {
    const s = doc.agents.state() as { claims: unknown[]; requests: unknown[] };
    return { ...(s.claims.length ? { claims: s.claims } : {}), ...(s.requests.length ? { deleteRequests: s.requests } : {}) };
  };
  switch (tool) {
    case 'doc_read': {
      const out = { ...head, ...live.read({ mode: args.mode, id: args.id, query: args.query, page: args.page }), ...working(), ...skipped };
      seen();
      return [true, out];
    }
    case 'doc_changes': {
      const since = Number(args.sinceRev);
      if (!Number.isInteger(since) || since < 0) throw new DocRefusal('bad_op', '`sinceRev` must be the rev of your last read or ack');
      const out = { ...head, ...live.changes(since), ...working(), ...skipped };
      seen();
      return [true, out];
    }
    case 'doc_edit': {
      doc.agents.checkEdit(who, args.ops);
      const ack = live.edit(args.ops, origin, args.page);
      doc.agents.landed(who, args.ops, ack);
      seen();
      return [true, { ...head, ...ack }];
    }
    case 'doc_claim': {
      const out = doc.agents.claim(who, args, (id) => live.pageOf(id));
      return [true, { ...head, rev: live.rev, ...out }];
    }
    case 'doc_page': {
      const out = store.pageOp(doc, args.action, args, origin);
      if (args.action !== 'rename') seen();
      return [true, { ...head, ...out }];
    }
    case 'doc_undo':
      return [true, { ...head, ...live.undo(origin) }];
    case 'doc_comments': {
      let since: number | undefined;
      if (args.since !== undefined) {
        since = Number(args.since);
        if (!Number.isInteger(since) || since < 0) throw new DocRefusal('bad_op', '`since` is the `seq` of your last doc_comments');
      }
      return [true, { ...head, ...live.comments.list(since) }];
    }
    case 'doc_comment': {
      const range = args.target === undefined || args.target === null ? null : live.range(args.target, args.page);
      const thread = live.comments.add(agent, args.text, range, origin);
      return [true, { ...head, ok: true, ...thread }];
    }
    case 'doc_reply':
      return [true, { ...head, ok: true, ...live.comments.reply(agent, args.thread, args.text, origin) }];
    case 'doc_resolve': {
      const opts = { agent: true, userAsked: args.userAsked };
      return [true, { ...head, ok: true, ...live.comments.resolve(agent, args.thread, opts, origin) }];
    }
    case 'doc_history': {
      if (args.version !== undefined) {
        const n = Number(args.version);
        if (!Number.isInteger(n) || n < 1) throw new DocRefusal('bad_op', '`version` is a version number from doc_history');
        const version = store.history(doc).versions.find((v) => (v as { n: number }).n === n) ?? null;
        return [true, { ...head, latest: live.rev, version, md: store.readVersion(doc, n) }];
      }
      store.snapshot(doc);
      return [true, { ...head, ...store.history(doc) }];
    }
    default: {
      const n = Number(args.version);
      if (!Number.isInteger(n) || n < 1) throw new DocRefusal('bad_op', '`version` is a version number from doc_history');
      const result = await store.restore(doc, n, args.ifRev, origin, args.page);
      return [true, { ...head, ok: true, ...result }];
    }
  }
}

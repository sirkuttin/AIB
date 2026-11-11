/**
 * The agent's doc tools, server side: POST /api/live/docs/tool (docs_routes.ts) runs them here. Their MCP definitions are in
 * tool_defs.ts. A refusal carries a `code`, the block as it stands and what to do next.
 */
import { DocRefusal } from './live_doc.ts';
import type { DocStore } from './store.ts';
import { DOC_TOOL_NAMES } from './tool_defs.ts';
import { DRAWING_TOOL_NAMES, runDrawingTool } from './drawing/agent.ts';

export { DOC_INSTRUCTIONS, DOC_TOOL_NAMES, DOC_TOOLS } from './tool_defs.ts';

type Json = Record<string, unknown>;

/**
 * Run one doc tool for an agent working in `projectRoot`. File-tool edits to the doc's Markdown copy are taken in first, so the
 * agent sees them. Returns [ok, payload]: a refusal is a normal answer (ok=false) with Claude Docs' code. `chat` (the chat's lasting
 * id) becomes the doc's linked chat if it has none yet: "Send to agent" on a comment goes there.
 */
export async function runDocTool(
  store: DocStore,
  projectRoot: string,
  agent: string,
  tool: string,
  args: Json,
  chat: string | null = null,
): Promise<[boolean, Json]> {
  try {
    if (!DOC_TOOL_NAMES.has(tool) && !DRAWING_TOOL_NAMES.has(tool)) throw new DocRefusal('bad_tool', `Unknown doc tool: ${tool}`);
    if (tool === 'doc_list') return [true, { docs: await store.list(projectRoot) }];
    if (tool === 'doc_create') {
      const markdown = args.markdown === undefined ? '' : args.markdown;
      if (typeof markdown !== 'string') throw new DocRefusal('bad_op', '`markdown` is the first content, as a string');
      const doc = await store.open(projectRoot, args.doc, markdown);
      if (chat) store.link(doc, chat, false);
      if (args.title !== undefined) doc.live.renamePage(doc.live.firstPage, args.title, doc.live.system);
      return [true, { doc: doc.name, file: doc.file, created: true, ...doc.live.read(), pages: doc.live.pages() }];
    }
    const doc = await store.open(projectRoot, args.doc);
    if (chat) store.link(doc, chat, false);
    await store.syncMirror(doc);
    const live = doc.live;
    if (DRAWING_TOOL_NAMES.has(tool)) return await runDrawingTool(doc, agent, tool, args);
    const head = { doc: doc.name, file: doc.file };
    const skipped = doc.skipped.length ? { fileEditsSkipped: doc.skipped.slice(-10) } : {};
    switch (tool) {
      case 'doc_read':
        return [true, { ...head, ...live.read({ mode: args.mode, id: args.id, query: args.query, page: args.page }), ...skipped }];
      case 'doc_changes': {
        const since = Number(args.sinceRev);
        if (!Number.isInteger(since) || since < 0) throw new DocRefusal('bad_op', '`sinceRev` must be the rev of your last read or ack');
        return [true, { ...head, ...live.changes(since), ...skipped }];
      }
      case 'doc_edit':
        return [true, { ...head, ...live.edit(args.ops, live.originFor('agent', agent), args.page) }];
      case 'doc_page':
        return [true, { ...head, ...store.pageOp(doc, args.action, args, live.originFor('agent', agent)) }];
      case 'doc_undo':
        return [true, { ...head, ...live.undo(live.originFor('agent', agent)) }];
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
        const thread = live.comments.add(agent, args.text, range, live.originFor('agent', agent));
        return [true, { ...head, ok: true, ...thread }];
      }
      case 'doc_reply':
        return [true, { ...head, ok: true, ...live.comments.reply(agent, args.thread, args.text, live.originFor('agent', agent)) }];
      case 'doc_resolve': {
        const opts = { agent: true, userAsked: args.userAsked };
        return [true, { ...head, ok: true, ...live.comments.resolve(agent, args.thread, opts, live.originFor('agent', agent)) }];
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
        const result = await store.restore(doc, n, args.ifRev, live.originFor('agent', agent), args.page);
        return [true, { ...head, ok: true, ...result }];
      }
    }
  } catch (error) {
    if (error instanceof DocRefusal) return [false, error.toJSON()];
    throw error;
  }
}

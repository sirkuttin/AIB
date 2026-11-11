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
 * agent sees them. Returns [ok, payload]: a refusal is a normal answer (ok=false) with Claude Docs' code.
 */
export async function runDocTool(
  store: DocStore,
  projectRoot: string,
  agent: string,
  tool: string,
  args: Json,
): Promise<[boolean, Json]> {
  try {
    if (!DOC_TOOL_NAMES.has(tool) && !DRAWING_TOOL_NAMES.has(tool)) throw new DocRefusal('bad_tool', `Unknown doc tool: ${tool}`);
    if (tool === 'doc_list') return [true, { docs: await store.list(projectRoot) }];
    if (tool === 'doc_create') {
      const markdown = args.markdown === undefined ? '' : args.markdown;
      if (typeof markdown !== 'string') throw new DocRefusal('bad_op', '`markdown` is the first content, as a string');
      const doc = await store.open(projectRoot, args.doc, markdown);
      return [true, { doc: doc.name, file: doc.mirrorPath, created: true, ...doc.live.read() }];
    }
    const doc = await store.open(projectRoot, args.doc);
    await store.syncMirror(doc);
    const live = doc.live;
    if (DRAWING_TOOL_NAMES.has(tool)) return await runDrawingTool(doc, agent, tool, args);
    const head = { doc: doc.name, file: doc.mirrorPath };
    const skipped = doc.skipped.length ? { fileEditsSkipped: doc.skipped.slice(-10) } : {};
    switch (tool) {
      case 'doc_read':
        return [true, { ...head, ...live.read({ mode: args.mode, id: args.id, query: args.query }), ...skipped }];
      case 'doc_changes': {
        const since = Number(args.sinceRev);
        if (!Number.isInteger(since) || since < 0) throw new DocRefusal('bad_op', '`sinceRev` must be the rev of your last read or ack');
        return [true, { ...head, ...live.changes(since), ...skipped }];
      }
      case 'doc_edit':
        return [true, { ...head, ...live.edit(args.ops, live.originFor('agent', agent)) }];
      case 'doc_undo':
        return [true, { ...head, ...live.undo(live.originFor('agent', agent)) }];
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
        const result = await store.restore(doc, n, args.ifRev, live.originFor('agent', agent));
        return [true, { ...head, ok: true, ...result }];
      }
    }
  } catch (error) {
    if (error instanceof DocRefusal) return [false, error.toJSON()];
    throw error;
  }
}

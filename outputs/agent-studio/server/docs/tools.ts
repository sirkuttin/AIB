/**
 * The agent's doc tools: their MCP definitions (offered by the studio_artifact MCP server next to publish/update/list, mcp.ts) and
 * the server side that runs them (POST /api/live/docs/tool, docs_routes.ts). Shapes follow Claude Docs: block ids, `h` hashes,
 * `rev`, `find` targets, ifHash + ifRev guards, all-or-nothing calls; refusals carry a `code` and the block as it stands.
 */
import { DocRefusal } from './live_doc.ts';
import type { DocStore } from './store.ts';

type Json = Record<string, unknown>;

export const DOC_INSTRUCTIONS = 'Docs are shared with the user, who may be typing in them while you work. Every read returns `rev` and, ' +
  'per block, an id and `h` (8-hex hash). Re-word with {"kind":"find","text":"<the exact words as they stand>"} (no guard needed); a ' +
  'whole-block replace or delete needs "ifHash" = its h and "ifRev" = the rev of the read that showed it. `guard_mismatch` or ' +
  '`find_none` means the user changed it after your read: their edit wins; redo yours from what stands, never over their text. ' +
  'Later turns start with doc_changes {sinceRev: <your last rev>}, not a full read.';

const DOC = {
  type: 'string',
  description: 'The doc\'s name, e.g. "plan". Its Markdown copy is docs/<name>.md in the project; a new name makes a new doc.',
};

export const DOC_TOOLS: Json[] = [
  {
    name: 'doc_read',
    title: 'Read a doc',
    description:
      'Read a doc shared with the user: its outline (headings) and blocks, each with `id`, `h` (8-hex hash) and `md` (the block as ' +
      "Markdown), plus the doc's `rev`. Keep the rev: guards and doc_changes use it. " + DOC_INSTRUCTIONS,
    inputSchema: {
      type: 'object',
      properties: { doc: DOC, ids: { type: 'array', items: { type: 'string' }, description: 'Optional: only these blocks.' } },
      required: ['doc'],
      additionalProperties: false,
    },
  },
  {
    name: 'doc_changes',
    title: 'What changed in a doc',
    description:
      'The blocks changed after `sinceRev` (each with `after`, the id of the block before it) and the ids of blocks deleted since ' +
      '(`gone`), plus the new `rev`. Start every later turn on a doc with this instead of a full read.',
    inputSchema: {
      type: 'object',
      properties: { doc: DOC, sinceRev: { type: 'integer', minimum: 0, description: 'The rev of your last read or edit.' } },
      required: ['doc', 'sinceRev'],
      additionalProperties: false,
    },
  },
  {
    name: 'doc_edit',
    title: 'Edit a doc',
    description:
      'Apply ops to a doc, in order, all or nothing (a refused call changed nothing). Your edits show at once, marked as yours. Ops:\n' +
      '- {"op":"insert","target":{"kind":"blocks","ids":["<id>"]},"side":"after"|"before","source":{"from":{"kind":"inline","content":"<markdown>"},"as":"markdown"}}' +
      ' (or "target":{"kind":"root"},"side":"end"|"start")\n' +
      '- {"op":"replace","target":{"kind":"find","text":"<exact words>","nth":1},"with":{"from":{"kind":"inline","content":"<new words>"},"as":"text"}}' +
      " re-words in place as small character edits, so the user's typing elsewhere in the block survives\n" +
      '- {"op":"replace","target":{"kind":"blocks","ids":["<id>"]},"ifHash":"<h>","ifRev":<rev>,"with":{"from":{"kind":"inline","content":"…"},"as":"text"|"markdown"}}\n' +
      '- {"op":"delete","target":{"kind":"find","text":" <exact words>"}} or {"op":"delete","target":{"kind":"blocks","ids":["<id>"]},"ifHash":"<h>","ifRev":<rev>}\n' +
      'Refusals: missing_guard, guard_mismatch (shows the block as it stands: their edit wins, redo yours from it), find_none (re-read ' +
      'that block, quote what it says now), block_gone, last_block, bad_op. "force":true only when the user told you to overwrite.',
    inputSchema: {
      type: 'object',
      properties: { doc: DOC, ops: { type: 'array', items: { type: 'object' }, minItems: 1 } },
      required: ['doc', 'ops'],
      additionalProperties: false,
    },
  },
];

export const DOC_TOOL_NAMES = new Set(DOC_TOOLS.map((t) => t.name as string));

/**
 * Run one doc tool for an agent working in `projectRoot`. File-tool edits to the doc's Markdown copy are taken in first, so the
 * agent sees them. Returns [ok, payload]: a refusal is a normal answer (ok=false) with Claude Docs' code.
 */
export async function runDocTool(store: DocStore, projectRoot: string, agent: string, tool: string, args: Json): Promise<[boolean, Json]> {
  try {
    if (!DOC_TOOL_NAMES.has(tool)) throw new DocRefusal('bad_tool', `Unknown doc tool: ${tool}`);
    const doc = await store.open(projectRoot, args.doc);
    await store.syncMirror(doc);
    const live = doc.live;
    const head = { doc: doc.name, file: doc.mirrorPath };
    if (tool === 'doc_read') {
      const ids = Array.isArray(args.ids) ? args.ids.filter((i): i is string => typeof i === 'string') : null;
      const skipped = doc.skipped.length ? { fileEditsSkipped: doc.skipped } : {};
      return [true, { ...head, ...live.read(ids), ...skipped }];
    }
    if (tool === 'doc_changes') {
      const since = Number(args.sinceRev);
      if (!Number.isInteger(since) || since < 0) throw new DocRefusal('bad_op', '`sinceRev` must be the rev of your last read or edit');
      return [true, { ...head, ...live.changes(since) }];
    }
    const ack = live.edit(args.ops, live.originFor('agent', agent));
    return [true, { ...head, ...ack }];
  } catch (error) {
    if (error instanceof DocRefusal) return [false, error.toJSON()];
    throw error;
  }
}

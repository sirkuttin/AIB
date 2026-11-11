/**
 * The agent's doc tools as MCP definitions: offered by the studio_artifact MCP server next to publish/update/list (mcp.ts), always.
 * No imports, so the MCP tool process stays light; the server side that runs them is tools.ts. Shapes follow Claude Docs: block ids,
 * `h` hashes, `rev`, find targets, ifHash + ifRev guards, all-or-nothing calls, placeholders.
 */
type Json = Record<string, unknown>;

export const DOC_INSTRUCTIONS = 'Docs are shared with the user, who may be typing in them while you work; your edits show at once, ' +
  'marked as yours. Every read returns `rev` and, per block, an `id` and `h` (8-hex hash). Re-word words in place with a find ' +
  'target ({"kind":"find","text":"<the exact words as they stand>"}, no guard needed); a whole-block replace, delete, move or set ' +
  'needs "ifHash" = its h and "ifRev" = the rev of the read that showed it (several ids: "ifRev" alone). `guard_mismatch` or ' +
  '`find_none` means the user changed it after your read: their edit wins; redo yours from what stands, never over their text, ' +
  'never with force. Later turns start with doc_changes {sinceRev: <your last rev>}, not a full read.';

const DOC = { type: 'string', description: 'The doc\'s name, e.g. "plan". Its Markdown copy is docs/<name>.md in the chat\'s project.' };

const EDIT_HELP = 'Ops, applied in order, all or nothing (a refused call changed nothing):\n' +
  '- insert: {"op":"insert","target":{"kind":"blocks","ids":["<id>"]},"side":"after"|"before"|"start"|"end","source":{"from":{"kind":"inline","content":"<markdown>"},"as":"markdown"}}' +
  ' ("start"/"end" = inside a list, item, quote, table or cell; {"kind":"root"} + "start"/"end" = top/bottom of the doc). Into a list give "- item" ' +
  'lines; into a table "| a | b |" rows.\n' +
  '- plan sections first: insert with "as":"pending","from":{"kind":"inline","content":["Risks: what could slip","Timeline"]} plants ' +
  'placeholders the user sees; then fill ONE per call: replace its id (ifHash + ifRev) with "## Heading\\n\\nbody". block_gone on a ' +
  'placeholder = the user deleted it: drop that section, never re-create it. guard_mismatch on it = they typed in it: keep their text.\n' +
  '- re-word in place (keeps bold, links, the user\'s typing elsewhere): {"op":"replace","target":{"kind":"find","text":"<exact words>","nth":1},"with":{"from":{"kind":"inline","content":"<new words>"},"as":"text"}}' +
  ' or {"op":"replace","target":{"kind":"blocks","ids":["<id>"]},"ifHash":"<h>","ifRev":<rev>,"with":{…,"as":"text"}}\n' +
  '- rewrite a block: same with "as":"markdown" (a list or table keeps the ids of items/rows you did not change)\n' +
  '- delete: {"op":"delete","target":{"kind":"find","text":" <exact words>"}} or {"op":"delete","target":{"kind":"blocks","ids":["<id>"]},"ifHash":"<h>","ifRev":<rev>}\n' +
  '- move: {"op":"move","target":{"kind":"blocks","ids":["<id>"]},"ifHash":"<h>","ifRev":<rev>,"to":{"target":{"kind":"blocks","ids":["<id>"]},"side":"after"}}' +
  ' (moved blocks get new ids: the ack\'s "moved" maps old to new)\n' +
  '- set attrs: {"op":"set","target":{"kind":"blocks","ids":["<id>"]},"ifHash":"<h>","ifRev":<rev>,"attrs":{"level":2}} ' +
  '(heading level, item "checked", code "language", cell "align", list "start"; list "kind": "bullet"|"ordered"|"check")\n' +
  '- tables: {"op":"table_row_insert","target":{"kind":"blocks","ids":["<table id>"]},"at":<row, 1 = first body row; default end>,"cells":["a","b"]}, ' +
  '{"op":"table_row_delete",…,"at":<row>,"ifRev":<rev>}, {"op":"table_col_insert",…,"at":<col; default end>,"cells":["Header","r1","r2"]}, ' +
  '{"op":"table_col_delete",…,"at":<col>,"ifRev":<rev>}\n' +
  'Refusals: missing_guard, guard_mismatch (shows the block as it stands: their edit wins), find_none (read again, quote what it says ' +
  'now), block_gone, atom_in_range (a break/image/HTML tag inside the changed words: quote around it), cell_count, last_block, bad_op. ' +
  '"force":true only when the user told you to overwrite their text.';

export const DOC_TOOLS: Json[] = [
  {
    name: 'doc_list',
    title: 'List docs',
    description: "The docs of this chat's project (each one's Markdown copy is docs/<name>.md, meant to be committed).",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'doc_create',
    title: 'Create a doc',
    description: 'Make a new doc shared with the user (its copy: docs/<name>.md in the project), optionally from Markdown. Refused ' +
      'with doc_exists if the name is taken. Returns its blocks and `rev`, like doc_read. ' +
      DOC_INSTRUCTIONS,
    inputSchema: {
      type: 'object',
      properties: { doc: DOC, markdown: { type: 'string', description: 'The first content, as Markdown. Optional.' } },
      required: ['doc'],
      additionalProperties: false,
    },
  },
  {
    name: 'doc_read',
    title: 'Read a doc',
    description: 'Read a doc shared with the user. mode "outline" (headings + top-level blocks with a preview: start here on a long ' +
      'doc), "full" (default: every block in order with `id`, `h`, `md`; lists, quotes and tables list their `kids`), "block" + id ' +
      '(that block and all inside it, with its whole Markdown), "search" + query (text blocks holding the words, with char ranges). ' +
      'Keep the `rev`: guards and doc_changes use it. ' + DOC_INSTRUCTIONS,
    inputSchema: {
      type: 'object',
      properties: {
        doc: DOC,
        mode: { type: 'string', enum: ['outline', 'full', 'block', 'search'] },
        id: { type: 'string', description: 'mode "block": the block.' },
        query: { type: 'string', description: 'mode "search": the words (case does not matter).' },
      },
      required: ['doc'],
      additionalProperties: false,
    },
  },
  {
    name: 'doc_changes',
    title: 'What changed in a doc',
    description: 'The blocks changed after `sinceRev` (each with `parent` and `after`, the id of the block before it; `new` if born ' +
      'since) and the ids of blocks deleted since (`gone`), plus the new `rev`. Start every later turn on a doc with this instead of a ' +
      'full read.',
    inputSchema: {
      type: 'object',
      properties: { doc: DOC, sinceRev: { type: 'integer', minimum: 0, description: 'The rev of your last read or ack.' } },
      required: ['doc', 'sinceRev'],
      additionalProperties: false,
    },
  },
  {
    name: 'doc_edit',
    title: 'Edit a doc',
    description: 'Edit a doc; your edits show at once, marked as yours. ' + EDIT_HELP,
    inputSchema: {
      type: 'object',
      properties: { doc: DOC, ops: { type: 'array', items: { type: 'object' }, minItems: 1 } },
      required: ['doc', 'ops'],
      additionalProperties: false,
    },
  },
  {
    name: 'doc_undo',
    title: 'Undo your last doc edit',
    description: 'Take back your own last doc_edit call on this doc (again for the one before). Refused with undo_conflict when the ' +
      'user changed what that call wrote since: their edit wins.',
    inputSchema: { type: 'object', properties: { doc: DOC }, required: ['doc'], additionalProperties: false },
  },
  {
    name: 'doc_history',
    title: "A doc's history",
    description: "The doc's saved versions (`n`, the `rev` each was taken at, `by` who changed it, when) and `latest` (the rev now); " +
      'with "version": n, that version\'s whole Markdown. Deleted text is in here: bring it back with an ordinary insert, never retype ' +
      'it from memory.',
    inputSchema: {
      type: 'object',
      properties: { doc: DOC, version: { type: 'integer', minimum: 1, description: 'Read this version.' } },
      required: ['doc'],
      additionalProperties: false,
    },
  },
  {
    name: 'doc_restore',
    title: 'Restore a doc version',
    description: 'Rewind the whole doc to a version from doc_history, only when nothing changed since: "ifRev" = the `latest` that ' +
      'doc_history showed. Only when the user asked for it.',
    inputSchema: {
      type: 'object',
      properties: { doc: DOC, version: { type: 'integer', minimum: 1 }, ifRev: { type: 'integer', minimum: 0 } },
      required: ['doc', 'version', 'ifRev'],
      additionalProperties: false,
    },
  },
];

export const DOC_TOOL_NAMES = new Set(DOC_TOOLS.map((t) => t.name as string));

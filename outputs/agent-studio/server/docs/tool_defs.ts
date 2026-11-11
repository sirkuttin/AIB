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
  'never with force. Later turns start with doc_changes {sinceRev: <your last rev>}, not a full read. The user comments on words; ' +
  'doc_comments {since: <your last seq>} shows the threads; answer with doc_reply. An edit that would remove words a comment hangs ' +
  'on is refused `anchors_affected`: keep them.';

const DOC = {
  type: 'string',
  description: 'The doc\'s name, e.g. "plan". It lives in docs/<name>/ in the chat\'s project (doc.aibdoc + a Markdown copy per page).',
};
const PAGE = { type: 'string', description: 'The page: its id or title (doc_read outline lists pages). Default: the first page.' };

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
  '(heading level, item "checked", code "language", list "start", "align" left|center|right on a paragraph, heading or cell, callout ' +
  '"variant" info|warning|success, column "width" 0.1-0.9; list "kind": "bullet"|"ordered"|"check")\n' +
  '- rich blocks (Markdown can\'t hold them; their .md copy is only a readable fallback, so edit them here, never in the .md): a ' +
  'callout is a Markdown quote starting "> [!NOTE]", "> [!WARNING]" or "> [!SUCCESS]" (holds text, lists, code; no callout in a ' +
  'callout); toggles and columns go "as":"blocks" with Markdown in "md": [{"type":"toggle","summary":"<its line>","md":"<body>"}], ' +
  '[{"type":"columns","content":[{"type":"column","md":"…"},{"type":"column","md":"…"}]}] (2-3 columns, top of a page only). Their ' +
  'blocks have ids like any other: re-word with find, insert with side "start"/"end" on the callout, column or toggle id.\n' +
  '- colour: {"op":"style","target":<find, or blocks + ifHash/ifRev>,"color":"grey"|"red"|"orange"|"green"|"blue"|"purple"|null,' +
  '"highlight":"yellow"|"green"|"pink"|"purple"|"grey"|null} (null clears; the words stay)\n' +
  '- tables: {"op":"table_row_insert","target":{"kind":"blocks","ids":["<table id>"]},"at":<row, 1 = first body row; default end>,"cells":["a","b"]}, ' +
  '{"op":"table_row_delete",…,"at":<row>,"ifRev":<rev>}, {"op":"table_col_insert",…,"at":<col; default end>,"cells":["Header","r1","r2"]}, ' +
  '{"op":"table_col_delete",…,"at":<col>,"ifRev":<rev>}; merged cells: {"op":"table_merge",…,"cells":[[<row>,<col>],[<row>,<col>]],' +
  '"ifRev":<rev>} (two corners, 0-based squares, row 0 = the first row), {"op":"table_split",…,"at":[<row>,<col>],"ifRev":<rev>}, ' +
  '{"op":"table_header",…,"row":true|false,"col":true|false,"ifRev":<rev>}; split merged cells before adding or removing rows/columns\n' +
  '- charts (bar or line; the chart owns its numbers, a small table inside it): make one "as":"blocks" with ' +
  '[{"type":"chart","attrs":{"title":"Conversion by week","chartType":"bar"|"line","caption":"…"},"data":[["Week","Old form","Checkout v2"],["Week 1",3.1,3.3],["Week 2",3.0,3.4]]}] ' +
  '(row 0 = series names, column 0 = labels, up to 6 series, numbers or empty cells), or copy a table\'s numbers once: ' +
  '{"op":"chart_from_table","target":{"kind":"blocks","ids":["<table id>"]},"attrs":{"title":"…","chartType":"line"}} (a new chart ' +
  'after the table; later table edits do not change it). doc_read shows a chart\'s `data` and its table\'s rows and cells with ids and ' +
  'h: change one number with a replace of that cell\'s paragraph ("as":"text", its ifHash + ifRev; a number the user changed after ' +
  'your read is refused: theirs stays), rows and series with table_row_insert/delete and table_col_insert/delete on the chart\'s ' +
  'table id, title/type/caption with set on the chart id ({"title":"…"}, {"chartType":"line"}, {"caption":"…"}). A word in a number ' +
  'cell or a 7th series is refused bad_chart.\n' +
  'Refusals: missing_guard, guard_mismatch (shows the block as it stands: their edit wins), find_none (read again, quote what it says ' +
  'now), block_gone, atom_in_range (a break/image/HTML tag inside the changed words: quote around it), cell_count, last_block, bad_op. ' +
  '"force":true only when the user told you to overwrite their text.\n' +
  'anchors_affected: an op would delete or replace words an open comment thread hangs on (the refusal lists the threads). Keep those ' +
  'words and re-word around them. Only when the user asked for that change, add "allowDetach":true to the op: it applies and the ' +
  'thread stays, marked detached.';

export const DOC_TOOLS: Json[] = [
  {
    name: 'doc_list',
    title: 'List docs',
    description: "The docs of this chat's project: each is a folder docs/<name>/ holding doc.aibdoc (the doc, meant to be " +
      'committed) and a generated Markdown copy per page.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'doc_create',
    title: 'Create a doc',
    description: 'Make a new doc shared with the user (its folder: docs/<name>/ in the project), optionally from Markdown (its ' +
      'first page). Refused with doc_exists if the name is taken. Returns its blocks and `rev`, like doc_read. ' +
      DOC_INSTRUCTIONS,
    inputSchema: {
      type: 'object',
      properties: {
        doc: DOC,
        markdown: { type: 'string', description: 'The first content, as Markdown. Optional.' },
        title: { type: 'string', description: "The first page's title. Default: Page 1." },
      },
      required: ['doc'],
      additionalProperties: false,
    },
  },
  {
    name: 'doc_read',
    title: 'Read a doc',
    description: 'Read a doc shared with the user. A doc has pages (like tabs): reads are of one page, "page" (id or title; ' +
      'default the first). mode "outline" (the pages with their ids, titles and block counts, then the page\'s headings + top-level ' +
      'blocks with a preview: start here), "full" (default: every block of the page in order with `id`, `h`, `md`; lists, quotes ' +
      'and tables list their `kids`; callouts, columns and toggles too; `attrs`: callout variant, column width, cell colspan/rowspan, ' +
      'align, chart title/chartType/caption; `styles`: coloured/highlighted char ranges; a chart\'s `data`: its numbers as rows), "block" + id (that block, on any page, and all inside it, with its whole Markdown), "search" + ' +
      'query (text blocks holding the words, with char ranges and `page`; every page unless "page"). Keep the `rev`: guards and ' +
      'doc_changes use it. ' + DOC_INSTRUCTIONS,
    inputSchema: {
      type: 'object',
      properties: {
        doc: DOC,
        mode: { type: 'string', enum: ['outline', 'full', 'block', 'search'] },
        id: { type: 'string', description: 'mode "block": the block.' },
        query: { type: 'string', description: 'mode "search": the words (case does not matter).' },
        page: PAGE,
      },
      required: ['doc'],
      additionalProperties: false,
    },
  },
  {
    name: 'doc_changes',
    title: 'What changed in a doc',
    description: 'The blocks changed after `sinceRev` on every page (each with its `page`, `parent` and `after`, the id of the ' +
      'block before it; `new` if born since), the ids of blocks deleted since (`gone`), pages added, renamed or moved ' +
      '(`pagesChanged`) or deleted (`pagesGone`), plus the new `rev`. Start every later turn on a doc with this instead of a full read.',
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
    description: 'Edit a doc; your edits show at once, marked as yours. One call edits one page: "page" (id or title), else the ' +
      'page of the blocks the ops name, else the first page; a block on another page is refused wrong_page. ' + EDIT_HELP,
    inputSchema: {
      type: 'object',
      properties: { doc: DOC, ops: { type: 'array', items: { type: 'object' }, minItems: 1 }, page: PAGE },
      required: ['doc', 'ops'],
      additionalProperties: false,
    },
  },
  {
    name: 'doc_page',
    title: "Add, rename, move or delete a doc's page",
    description: 'A doc has ordered pages (like tabs); doc_read outline lists them. action "add": a new page "title" (after page ' +
      '"after", default at the end), optionally with "markdown" as its first content. "rename": page "page" gets "title". "move": ' +
      'page "page" goes after page "after" (null: first). "delete": page "page", guarded by "ifRev" = the rev of the read that showed ' +
      'it (refused guard_mismatch when anything on it changed since); a page holding the user\'s words is refused user_content unless ' +
      'the user asked for it ("allowUserContent": true), one with comment threads on its words anchors_affected ("allowDetach": ' +
      'true). A delete that passes these checks is not done at once: it becomes a request the user answers in the doc (Delete or ' +
      'Keep); the call returns "pending": true, and a later doc tool result tells you what they chose. A rename is refused ' +
      'user_renamed when the user renamed that page after your read: keep their title. Titles are unique in a doc. doc_undo does not ' +
      'take page changes back.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: DOC,
        action: { type: 'string', enum: ['add', 'rename', 'move', 'delete'] },
        page: { type: 'string', description: 'rename, move, delete: the page (id or title).' },
        title: { type: 'string', description: 'add, rename: the title.' },
        after: { type: ['string', 'null'], description: 'add, move: the page it goes after (null for move: first).' },
        markdown: { type: 'string', description: "add: the page's first content." },
        ifRev: { type: 'integer', minimum: 0, description: 'delete (rename, optional): the rev of your read.' },
        allowUserContent: { type: 'boolean', description: "delete: true only when the user asked to delete a page with their words." },
        allowDetach: { type: 'boolean', description: 'delete: true only when the user asked, and comment threads hang on the page.' },
      },
      required: ['doc', 'action'],
      additionalProperties: false,
    },
  },
  {
    name: 'doc_claim',
    title: 'Mark blocks you are about to rewrite',
    description: 'Before rewriting existing blocks over several calls (or one long one), claim them: the user sees "<you> is ' +
      'rewriting this" on those blocks until your replacing doc_edit lands (that releases the claim), your turn ends, or the user ' +
      'stops you ("Stop and keep the text": your next edit of those blocks is refused user_took_back; leave them). "ids": the top-level ' +
      'blocks, "intent": a few words on what you are doing, "ifRev": the rev of the read that showed them (refused guard_mismatch if ' +
      'any changed since). Refused claimed when another chat claimed one of them. "release": true drops your claim without editing. ' +
      'doc_read shows the claims. New sections need no claim: plant placeholders (as "pending") instead.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: DOC,
        ids: { type: 'array', items: { type: 'string' }, description: 'The block ids you are about to rewrite.' },
        intent: { type: 'string', description: 'A few words: what you are doing to them.' },
        ifRev: { type: 'integer', minimum: 0, description: 'The rev of the read that showed them.' },
        release: { type: 'boolean', description: 'true: drop your claim.' },
      },
      required: ['doc'],
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
    name: 'doc_comments',
    title: "A doc's comments",
    description: 'The comment threads on a doc: each with `thread` (its id), `on` ("words" or "doc" for a whole-doc note), `quote` ' +
      '(the words it hangs on now), `block`, who started it (`by`: "user" or an agent), `resolved`, `detached` ("Text removed": its ' +
      'words are gone) and `replies` (the first is the comment itself), plus `seq`, the latest change. With "since": your last `seq`, ' +
      'only the threads changed after it. Comments are never in the Markdown copy.',
    inputSchema: {
      type: 'object',
      properties: { doc: DOC, since: { type: 'integer', minimum: 0, description: 'Only threads changed after this seq.' } },
      required: ['doc'],
      additionalProperties: false,
    },
  },
  {
    name: 'doc_comment',
    title: 'Comment on a doc',
    description: 'Start a comment thread on words of a doc (a question, an explanation of what you drafted): target ' +
      '{"kind":"find","text":"<the exact words>","nth":1} or {"kind":"blocks","ids":["<id of a paragraph, heading or code block>"]} ' +
      "(all its words). No target: a note on the whole doc. The thread follows its words through everyone's edits.",
    inputSchema: {
      type: 'object',
      properties: {
        doc: DOC,
        target: { type: 'object', description: 'The words: a find target or one block id. Leave out for a whole-doc note.' },
        page: { type: 'string', description: 'For a find target: the page to look on (id or title). Default: the first page.' },
        text: { type: 'string', description: 'The comment.' },
      },
      required: ['doc', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'doc_reply',
    title: 'Reply to a doc comment',
    description: 'Reply in a comment thread (doc_comments lists them): say what you changed for it, or answer the question.',
    inputSchema: {
      type: 'object',
      properties: { doc: DOC, thread: { type: 'string', description: 'The thread id, e.g. "t3".' }, text: { type: 'string' } },
      required: ['doc', 'thread', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'doc_resolve',
    title: 'Resolve a doc comment',
    description: 'Mark a comment thread resolved. You may resolve only threads you started; a thread the user (or another agent) ' +
      'started is refused with not_yours, unless the user asked you in chat to resolve it: only then send "userAsked": true.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: DOC,
        thread: { type: 'string', description: 'The thread id.' },
        userAsked: { type: 'boolean', description: 'true only when the user asked you in chat to resolve this thread.' },
      },
      required: ['doc', 'thread'],
      additionalProperties: false,
    },
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
    description: 'Rewind the whole doc (or with "page", one page) to a version from doc_history, exactly as it was (rich blocks, ' +
      'colours, drawings and comments too), only when nothing changed since: "ifRev" = the `latest` that doc_history showed. Only ' +
      'when the user asked for it.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: DOC,
        version: { type: 'integer', minimum: 1 },
        ifRev: { type: 'integer', minimum: 0 },
        page: { type: 'string', description: "Only this page (its id or title in that version); the doc's other pages stay." },
      },
      required: ['doc', 'version', 'ifRev'],
      additionalProperties: false,
    },
  },
];

export const DOC_TOOL_NAMES = new Set(DOC_TOOLS.map((t) => t.name as string));

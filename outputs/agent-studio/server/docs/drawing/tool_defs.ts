/**
 * The agent's drawing tools as MCP definitions, offered by the studio_artifact MCP server next to the doc_* tools (mcp.ts). Like
 * ../tool_defs.ts: no imports, so the MCP tool process stays light; the server side that runs them is agent.ts (through the docs'
 * tool route). A drawing lives in a doc: every tool takes the doc's name and the drawing's id.
 */
type Json = Record<string, unknown>;

const DOC = { type: 'string', description: 'The doc\'s name, e.g. "plan" (its Markdown copy is docs/<name>.md).' };
const DRAWING = {
  type: 'string',
  description: "The drawing's id: drawing_create returns it; in the doc's Markdown it is the file name in " +
    '![caption](<doc>.assets/<id>.excalidraw.svg).',
};

const GUARDS = 'The user may be drawing at the same time. Every change to an existing shape needs "ifV" = its v from drawing_read; ' +
  'stale (the shape changed since your read: their change wins, re-read and decide again), user_editing (the user has it selected, ' +
  'is dragging it or typing in it: leave it, try later or pick another), needs_allowDetach (the user made it, or their arrows are ' +
  'attached: delete only when the user asked). A refused call changed nothing.';

const OPS_HELP = 'Ops, applied in order, all or nothing:\n' +
  '- {"op":"add_box","text":"Build","near":"<id>"|"in":"<frame id>"|"at":{"x":0,"y":0},"shape":"rectangle"|"ellipse"|"diamond",' +
  '"style":{...}} (placed by the server in free space: never on top of the user\'s shapes; with no place given, to the right of the rest)\n' +
  '- {"op":"add_arrow","from":"<id>","to":"<id>","label":"then"} (bound: it follows the boxes when they move)\n' +
  '- {"op":"add_frame","title":"Release","around":["<id>",...]} (a titled section around shapes)\n' +
  '- {"op":"move","id":"<id>","to":{"x":0,"y":0}|"by":{"dx":0,"dy":40},"ifV":<v>} (a frame carries its shapes; arrows follow)\n' +
  '- {"op":"set_text","id":"<id>","text":"...","ifV":<v>} (a box\'s or arrow\'s label, a text, a frame\'s title)\n' +
  '- {"op":"style","id":"<id>","ifV":<v>,"style":{"strokeColor":"#1971c2","backgroundColor":"#a5d8ff","fillStyle":"solid",' +
  '"strokeWidth":2,"strokeStyle":"dashed","roughness":0,"opacity":100,"fontSize":20,"shape":"ellipse"}}\n' +
  '- {"op":"delete","id":"<id>","ifV":<v>} (+ "allowDetach":true only when the user asked)\n' +
  'Your new shapes may be given an "id"; otherwise the ack names them (b1, a1, f1...).';

export const DRAWING_TOOLS: Json[] = [
  {
    name: 'drawing_create',
    title: 'Add a drawing to a doc',
    description: 'Put a new drawing (Excalidraw: boxes, arrows, frames) into a doc shared with the user, as its own block: at the end, ' +
      'or after the block "after" (an id from doc_read). Optional "mermaid": a Mermaid flowchart to start it from. Returns the ' +
      "drawing's id (for drawing_read and drawing_edit), the block's id and the doc's `rev`. In the Markdown copy it is " +
      '![caption](<doc>.assets/<id>.excalidraw.svg), with the scene as JSON in <doc>.assets/<id>.excalidraw.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: DOC,
        caption: { type: 'string', description: 'What it shows, e.g. "Release flow"; also its picture\'s alt text.' },
        after: { type: 'string', description: 'The block to put it after. Default: the end of the doc.' },
        mermaid: { type: 'string', description: 'A Mermaid flowchart ("flowchart TD\\n A[Start] --> B[Ship]") to draw first.' },
      },
      required: ['doc', 'caption'],
      additionalProperties: false,
    },
  },
  {
    name: 'drawing_read',
    title: 'Read a drawing',
    description: 'One drawing of a doc as compact lines, one per shape: id, type, "text", position and size (or from/to for an ' +
      'arrow), frame, arrows in and out, v (its version: the ifV of your next change to it), by (who made it), and ' +
      'selectedByUser when the user is on it right now. Without "drawing": the doc\'s drawings (id, caption, shapes). ' + GUARDS,
    inputSchema: {
      type: 'object',
      properties: { doc: DOC, drawing: DRAWING },
      required: ['doc'],
      additionalProperties: false,
    },
  },
  {
    name: 'drawing_edit',
    title: 'Edit a drawing',
    description: 'Change a drawing of a doc; the user sees it at once. ' + GUARDS + '\n' + OPS_HELP,
    inputSchema: {
      type: 'object',
      properties: { doc: DOC, drawing: DRAWING, ops: { type: 'array', items: { type: 'object' }, minItems: 1 } },
      required: ['doc', 'drawing', 'ops'],
      additionalProperties: false,
    },
  },
  {
    name: 'drawing_from_mermaid',
    title: 'Draw a Mermaid flowchart',
    description: 'Add a Mermaid flowchart to a drawing of a doc as editable, bound shapes (a first draft, placed clear of what is ' +
      'there; ids m<n>_<node>). Only flowcharts become shapes: other diagram types are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: DOC,
        drawing: DRAWING,
        mermaid: { type: 'string', description: 'The flowchart, e.g. "flowchart TD\\n A --> B".' },
      },
      required: ['doc', 'drawing', 'mermaid'],
      additionalProperties: false,
    },
  },
];

export const DRAWING_TOOL_NAMES = new Set(DRAWING_TOOLS.map((t) => t.name as string));

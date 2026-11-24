/**
 * How to name an AIB tool to one chat (tool consolidation slice 3, architect review M7).
 *
 * A chat only knows the tool names its host listed when it started (the served record, served.ts). A chat started before the six-tool
 * change knows `unlanded_work`; a new one knows `helper` with action `work_land`. A word AIB sends mid-chat (a comment notice, an
 * unlanded-work wake, a merge text, a doc refusal) must use the names that chat can call. One helper does it for every server message:
 * toolRef(chat, oldName, action?) for a single name, tellChat(chat, text) for a text written with the old names.
 * A chat with no record (dev stdio, an unknown id) gets the old names: the hidden aliases still answer them.
 * No heavy imports: this file is read by the stdio tool process too.
 */

type Names = (chatId: string) => readonly string[] | null | undefined;
let namesOf: Names = () => null;

/** Wire where the served names of a chat come from (host/aib.ts: the served record). Tests set their own. */
export function setServedNames(source: Names | null): void {
  namesOf = source ?? (() => null);
}

/** True when the chat was served the six-tool names (any of doc, drawing, helper, artifacts). */
export function usesNewTools(names: readonly string[] | null | undefined): boolean {
  return !!names && names.some((n) => /^(doc|drawing|helper|artifacts)(:|$)/.test(n));
}

export function chatUsesNewTools(chatId: string | null | undefined): boolean {
  if (!chatId) return false;
  try {
    return usesNewTools(namesOf(chatId));
  } catch {
    return false;
  }
}

const DOC_ACTION = /^(?:doc|drawing)_(list|create|read|changes|edit|claim|page|undo|comments|comment|reply|resolve|history|restore|from_mermaid)$/;
const HELPER_OLD: Record<string, string> = {
  helper_providers: 'providers',
  start_helper: 'start',
  helper_status: 'status',
  stop_helper: 'stop',
  merge_helper: 'merge',
};

/** The new-shape words for an old tool name (and the action it was called with, for the two tools that took one). */
function newRef(old: string, action?: string): string {
  const d = DOC_ACTION.exec(old);
  if (d) return `\`${old.startsWith('drawing') ? 'drawing' : 'doc'}\` action "${d[1]}"`;
  if (old === 'unlanded_work') return `\`helper\` action "work_${action || 'list'}"`;
  if (HELPER_OLD[old]) return `\`helper\` action "${HELPER_OLD[old]}"`;
  if (old === 'resolve_edit_clash') return `\`merge_into_project\` action "${action || 'check'}"`;
  if (old === 'update') return '`publish` with `id`';
  if (old === 'list') return '`artifacts` action "list"';
  if (old === 'archive') return '`artifacts` action "archive"';
  return `\`${old}\``; // publish, merge_into_project: the same name in both shapes
}

/** The tool as this chat knows it: `unlanded_work` for an old chat, `helper` action "work_land" for a new one. */
export function toolRef(chatId: string | null | undefined, old: string, action?: string): string {
  if (chatUsesNewTools(chatId)) return newRef(old, action);
  return old + (action ? ` with action "${action}"` : '');
}

const TEXT_NAMES =
  /\b(?:(?:doc|drawing)_(?:list|create|read|changes|edit|claim|page|undo|comments|comment|reply|resolve|history|restore|from_mermaid)|unlanded_work(?: with action (?:land|diff|discard|list))?|helper_providers|start_helper|helper_status|stop_helper|merge_helper|resolve_edit_clash(?: with action "(?:check|keep_mine|leave)")?)(?![A-Za-z0-9_])/g;

/** A text written with the old tool names, spoken to this chat: new names for a new chat, unchanged for an old or record-less one. */
export function tellChat(chatId: string | null | undefined, text: string): string {
  if (!chatUsesNewTools(chatId)) return text;
  return newNames(text);
}

/** The text with every old tool name swapped for the new-shape words (a doc refusal to a caller of the new names). */
export function newNames(text: string): string {
  return text.replace(TEXT_NAMES, (hit) => {
    let m = /^unlanded_work(?: with action (\w+))?$/.exec(hit);
    if (m) return newRef('unlanded_work', m[1]);
    m = /^resolve_edit_clash(?: with action "(\w+)")?$/.exec(hit);
    if (m) return newRef('resolve_edit_clash', m[1]);
    return newRef(hit);
  });
}

/**
 * AIB's own studio_artifact tools, by tool + action (tool consolidation, architect review M2 and M3).
 *
 * The 30 old tool names became 6 tools that each take an `action`. This is the one table that maps each old name to its new tool +
 * action. Everything that names a tool in an approval goes through it: the auto-approval of AIB's own tools (acp/connection.ts), saved
 * allow rules (`mcp` rules with server studio_artifact), Claude ask rules (`mcp:studio_artifact__<tool>`, allow/agent_config.ts) and
 * the card text. An old name and the new name + action are the same thing, in both directions. No data migration is needed.
 *
 * An action AIB can't read (Gemini and other agents show no arguments) is '' and fails closed: no action-scoped rule matches it,
 * `artifacts` and `doc` are not auto-approved, and an ask rule on any action of the tool blocks it.
 */

export interface ToolAction {
  tool: string;
  action: string;
}

/** Old tool name -> new tool + action. '' = any action of the new tool (the old tool was a whole group). */
export const OLD_TO_NEW: Readonly<Record<string, ToolAction>> = {
  publish: { tool: 'publish', action: 'publish' },
  update: { tool: 'publish', action: 'update' },
  list: { tool: 'artifacts', action: 'list' },
  archive: { tool: 'artifacts', action: 'archive' },
  doc_create: { tool: 'doc', action: 'create' },
  doc_edit: { tool: 'doc', action: 'edit' },
  doc_read: { tool: 'doc', action: 'read' },
  doc_list: { tool: 'doc', action: 'list' },
  doc_history: { tool: 'doc', action: 'history' },
  doc_changes: { tool: 'doc', action: 'changes' },
  doc_comments: { tool: 'doc', action: 'comments' },
  doc_comment: { tool: 'doc', action: 'comment' },
  doc_reply: { tool: 'doc', action: 'reply' },
  doc_resolve: { tool: 'doc', action: 'resolve' },
  doc_claim: { tool: 'doc', action: 'claim' },
  doc_restore: { tool: 'doc', action: 'restore' },
  doc_undo: { tool: 'doc', action: 'undo' },
  doc_page: { tool: 'doc', action: 'page' },
  drawing_create: { tool: 'drawing', action: 'create' },
  drawing_edit: { tool: 'drawing', action: 'edit' },
  drawing_from_mermaid: { tool: 'drawing', action: 'from_mermaid' },
  drawing_read: { tool: 'drawing', action: 'read' },
  helper_providers: { tool: 'helper', action: 'providers' },
  start_helper: { tool: 'helper', action: 'start' },
  helper_status: { tool: 'helper', action: 'status' },
  stop_helper: { tool: 'helper', action: 'stop' },
  merge_helper: { tool: 'helper', action: 'merge' },
  unlanded_work: { tool: 'helper', action: '' }, // work_list | work_land | work_diff | work_discard (its own `action` arg)
  merge_into_project: { tool: 'merge_into_project', action: '' },
  resolve_edit_clash: { tool: 'merge_into_project', action: '' },
};

/** The 6 tools. */
export const NEW_TOOLS: ReadonlySet<string> = new Set(['publish', 'artifacts', 'doc', 'drawing', 'helper', 'merge_into_project']);

/** Every name a studio_artifact tool request can carry: the old 30 and the new 6. */
export const ALL_OWN_NAMES: ReadonlySet<string> = new Set([...Object.keys(OLD_TO_NEW), ...NEW_TOOLS]);

/**
 * AIB's own tools that need no approval: tool -> actions ('*' = all). Anything else (archive, doc restore, doc create/edit, drawings)
 * follows the allow rules and the cards, as before.
 */
const AUTO: Readonly<Record<string, readonly string[] | '*'>> = {
  publish: '*',
  helper: '*',
  merge_into_project: '*',
  artifacts: ['list'],
  doc: ['read', 'list', 'help', 'comments'],
};

/** Old name or new name (+ action from the call's input, '' if unreadable) -> tool + action; null when it is not an own tool. */
export function canonicalTool(tool: string, action?: unknown): ToolAction | null {
  const old = Object.hasOwn(OLD_TO_NEW, tool) ? OLD_TO_NEW[tool] : null;
  if (old && !NEW_TOOLS.has(tool)) {
    // an old name carries its action in the name; unlanded_work and the clash tool keep theirs in the `action` argument
    if (old.action) return old;
    return { tool: old.tool, action: tool === 'unlanded_work' && typeof action === 'string' && action ? `work_${action}` : '' };
  }
  if (!NEW_TOOLS.has(tool)) return null;
  return { tool, action: typeof action === 'string' ? action.trim() : '' };
}

/** True when AIB answers this own tool call itself (no card). An unreadable action only counts for tools that are wholly auto. */
export function isAutoApproved(c: ToolAction | null): boolean {
  if (!c) return false;
  const auto = AUTO[c.tool];
  if (!auto) return false;
  if (auto === '*') return true;
  return !!c.action && auto.includes(c.action);
}

/** Does a saved rule (server + tool [+ action]) cover a request? A rule without an action covers every action of its tool. */
export function ruleCovers(rule: { tool?: string; action?: string }, req: ToolAction): boolean {
  const r = canonicalTool(rule.tool ?? '', rule.action);
  if (!r || r.tool !== req.tool) return false;
  if (rule.action === undefined && !OLD_TO_NEW[rule.tool ?? ''] ) return true; // new name, no action: the whole tool
  if (!r.action) return true; // an old whole-group rule (unlanded_work, merge_into_project, resolve_edit_clash)
  return !!req.action && r.action === req.action;
}

/**
 * Does a Claude ask rule (`mcp:<server>__<tool>`, tool part only) name this request? Fails closed: a request with no readable action
 * is named by an ask rule on any action of the same tool.
 */
export function askNames(askTool: string, req: ToolAction): boolean {
  const r = canonicalTool(askTool);
  if (!r || r.tool !== req.tool) return false;
  if (NEW_TOOLS.has(askTool)) return true; // the whole new tool
  if (!r.action) return true;
  return !req.action || r.action === req.action;
}

/** The card text: "doc · restore" (the tool alone when the action is not known). */
export function toolLabel(c: ToolAction): string {
  return c.action ? `${c.tool} · ${c.action}` : c.tool;
}

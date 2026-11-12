/**
 * The web server's full route table: every (method, path, scope) the Python web server answers (studio.ROUTES), and its kind
 * (web_handler.route_specs: 'get', 'body', 'bare', 'own-gate'; 'monitor' for monitor.py's routes). work/deno/web_server_test.ts
 * checks this list equals Python's, so a route added on one side cannot be missed on the other. Whether a route is served by the Deno
 * port or still forwarded to the Python web server is decided in server.ts (NATIVE).
 */
import { RouteTable } from './security.ts';

export type RouteKind = 'get' | 'body' | 'bare' | 'own-gate' | 'monitor';

/**
 * Routes the Deno server has and the Python web server does not: the ONLY allowed difference from Python's table. The parity test
 * (web_server_test.ts) compares ROUTE_LIST minus these with Python's, and checks this list stays exactly this.
 *   POST /api/live/agents/install/uninstall   remove AIB's own install of an agent (installer.ts Installer.uninstall)
 *   GET  /api/live/terminal                   the chat terminal's WebSocket (terminal_routes.ts)
 *   GET  /api/live/terminal/list              running chat terminals
 *   POST /api/live/terminal/end               end a chat's terminal
 *   POST /api/live/view-prefs                 save the page's view and appearance preferences (state/view_prefs.ts)
 *   POST /api/live/agent-options              the model / mode / effort lists a new chat can offer (state/agent_options.ts)
 *   POST /api/live/desktop/notify             the desktop app shows a notification natively (desktop/notify.ts)
 *   POST /api/live/project-remove             "Delete project…": remove a project from AIB, optionally its folder (project_routes.ts)
 *   GET  /api/live/files/list                 the Files view: one folder of a chat's folder (files_routes.ts)
 *   GET  /api/live/files/search               the Files view: file names matching a filter
 *   GET  /api/live/files/read                 the Files view: one file, read only
 *   GET  /api/live/files/outside              the Files view: one file outside the chat's folder that the chat named
 *   POST /api/live/docs/open                  local docs: the page opens a doc (docs_routes.ts)
 *   GET  /api/live/docs/list                  local docs: the docs of a chat's project folder (Files, Ctrl+K, chips, picker)
 *   GET  /api/live/docs/info                  local docs: rev, skipped file edits, history of an open doc
 *   GET  /api/live/docs/socket                local docs: the editor's WebSocket
 *   POST /api/live/docs/tool                  local docs: an agent's doc_* tool (agent key)
 *   POST /api/live/docs/comment/send          local docs: "Send to agent" queues a comment thread to the doc's chat
 *   GET  /api/live/docs/built                 local docs: "Built from <doc › page>": has the page changed since?
 *   GET  /api/live/docs/shown                 local docs: the artifacts built from a doc (its "Shown in N artifacts" chip)
 *   POST /api/live/docs/link                  local docs: link a doc to the chat the user picked
 *   POST /api/live/docs/page                  local docs: the user's page operations (add, rename, move, duplicate, delete)
 *   POST /api/live/docs/page/request          local docs: the user answers an agent's page delete request (delete / keep)
 *   POST /api/live/docs/claim/release         local docs: "Stop and keep the text" on blocks an agent is rewriting
 *   POST /api/live/docs/notes/dismiss         local docs: dismiss a refused-edit note
 *   POST /api/live/docs/edit                  local docs: the user's block operations through the server (chart from a table...)
 *   POST /api/live/docs/comment               local docs: the user's comments (add, reply, resolve, reopen)
 *   GET  /api/live/docs/history               local docs: the versions with authors and the pages each changed
 *   GET  /api/live/docs/history/version       local docs: one version's pages, to show and compare
 *   POST /api/live/docs/history/restore       local docs: restore the whole doc or one page
 *   POST /api/live/docs/export                local docs: Markdown to the Downloads folder
 *   POST /api/live/docs/duplicate             local docs: "Duplicate doc" (every page, a new doc in the same project)
 *   POST /api/live/docs/trash                 local docs: "Move doc to trash" (history kept)
 *   POST /api/live/docs/reveal                local docs: "Show in folder" for a Markdown export in Downloads
 */
export const DENO_ONLY: readonly [string, string, string, RouteKind][] = [
  ['POST', '/api/live/agents/install/uninstall', 'write', 'body'],
  ['GET', '/api/live/terminal', 'write', 'get'],
  ['GET', '/api/live/terminal/list', 'read', 'get'],
  ['POST', '/api/live/terminal/end', 'write', 'body'],
  ['POST', '/api/live/view-prefs', 'write', 'body'],
  ['POST', '/api/live/agent-options', 'write', 'body'],
  ['POST', '/api/live/desktop/notify', 'write', 'body'],
  ['POST', '/api/live/project-remove', 'write', 'body'],
  ['GET', '/api/live/files/list', 'read', 'get'],
  ['GET', '/api/live/files/search', 'read', 'get'],
  ['GET', '/api/live/files/read', 'read', 'get'],
  ['GET', '/api/live/files/outside', 'read', 'get'],
  ['POST', '/api/live/docs/open', 'write', 'body'],
  ['GET', '/api/live/docs/list', 'read', 'get'],
  ['GET', '/api/live/docs/info', 'read', 'get'],
  ['GET', '/api/live/docs/built', 'read', 'get'],
  ['GET', '/api/live/docs/shown', 'read', 'get'],
  ['GET', '/api/live/docs/socket', 'write', 'get'],
  ['POST', '/api/live/docs/tool', 'artifacts.tool', 'own-gate'],
  ['POST', '/api/live/docs/comment/send', 'write', 'body'],
  ['POST', '/api/live/docs/link', 'write', 'body'],
  ['POST', '/api/live/docs/page', 'write', 'body'],
  ['POST', '/api/live/docs/page/request', 'write', 'body'],
  ['POST', '/api/live/docs/claim/release', 'write', 'body'],
  ['POST', '/api/live/docs/notes/dismiss', 'write', 'body'],
  ['POST', '/api/live/docs/edit', 'write', 'body'],
  ['POST', '/api/live/docs/comment', 'write', 'body'],
  ['GET', '/api/live/docs/history', 'read', 'get'],
  ['GET', '/api/live/docs/history/version', 'read', 'get'],
  ['POST', '/api/live/docs/history/restore', 'write', 'body'],
  ['POST', '/api/live/docs/export', 'write', 'body'],
  ['POST', '/api/live/docs/duplicate', 'write', 'body'],
  ['POST', '/api/live/docs/trash', 'write', 'body'],
  ['POST', '/api/live/docs/reveal', 'write', 'body'],
];

export const ROUTE_LIST: readonly [string, string, string, RouteKind][] = [
  ['GET', '/', 'static', 'monitor'],
  ['GET', '/api/activity', 'read', 'monitor'],
  ['GET', '/api/agents', 'read', 'monitor'],
  ['GET', '/api/bootstrap', 'bootstrap', 'monitor'],
  ['GET', '/api/command', 'read', 'monitor'],
  ['GET', '/api/commands', 'read', 'monitor'],
  ['GET', '/api/live/agents/install', 'write', 'get'],
  ['GET', '/api/live/agents/signin', 'write', 'get'],
  ['GET', '/api/live/artifacts', 'artifacts.tool', 'get'],
  ['GET', '/api/live/artifacts/diff', 'artifacts.read', 'get'],
  ['GET', '/api/live/artifacts/item', 'artifacts.read', 'get'],
  ['GET', '/api/live/artifacts/source', 'artifacts.read', 'get'],
  ['GET', '/api/live/bootstrap', 'bootstrap', 'get'],
  ['GET', '/api/live/branch', 'read', 'get'],
  ['GET', '/api/live/changes', 'read', 'get'],
  ['GET', '/api/live/changes/file', 'read', 'get'],
  ['GET', '/api/live/conversation-state', 'read', 'get'],
  ['GET', '/api/live/editors', 'read', 'get'],
  ['GET', '/api/live/folders/check', 'read', 'get'],
  ['GET', '/api/live/folders/kinds', 'read', 'get'],
  ['GET', '/api/live/folders/start', 'read', 'get'],
  ['GET', '/api/live/list', 'read', 'get'],
  ['GET', '/api/live/ownership', 'read', 'get'],
  ['GET', '/api/live/project-prefs', 'read', 'get'],
  ['GET', '/api/live/prompts', 'read', 'get'],
  ['GET', '/api/live/read-state', 'read', 'get'],
  ['GET', '/api/live/settings', 'read', 'get'],
  ['GET', '/api/live/state', 'read', 'get'],
  ['GET', '/api/live/update', 'read', 'get'],
  ['GET', '/api/live/worktree', 'read', 'get'],
  ['GET', '/api/live/worktree/clash', 'read', 'get'],
  ['GET', '/api/sessions', 'read', 'monitor'],
  ['GET', '/api/transcript', 'read', 'monitor'],
  ['GET', '/api/transcript/image', 'image', 'monitor'],
  ['GET', '/app.js', 'static', 'monitor'],
  ['GET', '/conversation.html', 'static', 'monitor'],
  ['GET', '/index.html', 'static', 'monitor'],
  ['GET', '/sidebar.css', 'static', 'monitor'],
  ['GET', '/sidebar.js', 'static', 'monitor'],
  ['GET', '/style.css', 'static', 'monitor'],
  ['POST', '/api/live/agents/install', 'write', 'body'],
  ['POST', '/api/live/agents/install/cancel', 'write', 'body'],
  ['POST', '/api/live/agents/signin', 'write', 'body'],
  ['POST', '/api/live/agents/signin/cancel', 'write', 'body'],
  ['POST', '/api/live/agents/signin/check', 'write', 'body'],
  ['POST', '/api/live/artifacts/pin', 'artifacts.write', 'own-gate'],
  ['POST', '/api/live/artifacts/preview', 'artifacts.write', 'own-gate'],
  ['POST', '/api/live/artifacts/publish', 'artifacts.tool', 'own-gate'],
  ['POST', '/api/live/artifacts/restore', 'artifacts.write', 'own-gate'],
  ['POST', '/api/live/authenticate', 'write', 'body'],
  ['POST', '/api/live/cancel', 'write', 'body'],
  ['POST', '/api/live/cancel-pending', 'write', 'body'],
  ['POST', '/api/live/config', 'write', 'body'],
  ['POST', '/api/live/connect', 'write', 'body'],
  ['POST', '/api/live/conversation-state', 'write', 'body'],
  ['POST', '/api/live/disconnect', 'write', 'body'],
  ['POST', '/api/live/discover', 'write', 'body'],
  ['POST', '/api/live/dismiss-unknown', 'write', 'body'],
  ['POST', '/api/live/elicitation', 'write', 'body'],
  ['POST', '/api/live/folders/create', 'write', 'body'],
  ['POST', '/api/live/folders/pick', 'write', 'body'],
  ['POST', '/api/live/folders/remember', 'write', 'body'],
  ['POST', '/api/live/forget', 'write', 'body'],
  ['POST', '/api/live/mode', 'write', 'body'],
  ['POST', '/api/live/open', 'write', 'body'],
  ['POST', '/api/live/permission', 'write', 'body'],
  ['POST', '/api/live/project-prefs', 'write', 'body'],
  ['POST', '/api/live/prompt', 'write', 'body'],
  ['POST', '/api/live/queue', 'write', 'body'],
  ['POST', '/api/live/queue-edit', 'write', 'body'],
  ['POST', '/api/live/queue-move', 'write', 'body'],
  ['POST', '/api/live/queue-remove', 'write', 'body'],
  ['POST', '/api/live/queue-resume', 'write', 'body'],
  ['POST', '/api/live/queue-send-now', 'write', 'body'],
  ['POST', '/api/live/read-state', 'write', 'body'],
  ['POST', '/api/live/session-op', 'write', 'body'],
  ['POST', '/api/live/settings', 'write', 'body'],
  ['POST', '/api/live/shutdown', 'shutdown', 'bare'],
  ['POST', '/api/live/update/check', 'write', 'body'],
  ['POST', '/api/live/update/install', 'write', 'body'],
  ['POST', '/api/live/worktree-archive', 'write', 'body'],
  ['POST', '/api/live/worktree-discard', 'write', 'body'],
  ['POST', '/api/live/worktree/clash', 'write', 'body'],
  ['POST', '/api/live/worktree/merge', 'write', 'body'],
  ['POST', '/api/live/worktree/tool', 'worktree.tool', 'own-gate'],
  ...DENO_ONLY,
];

export const ROUTES = new RouteTable();
for (const [method, path, scope] of ROUTE_LIST) ROUTES.add(method, path, scope);

const KINDS = new Map(ROUTE_LIST.map(([method, path, , kind]) => [`${method} ${path}`, kind]));

export function routeKind(method: string, path: string): RouteKind | null {
  return KINDS.get(`${method === 'HEAD' ? 'GET' : method} ${path}`) ?? null;
}

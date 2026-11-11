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
 *   POST /api/live/project-remove             "Delete project…": remove a project from AIB, optionally its folder (project_routes.ts)
 */
export const DENO_ONLY: readonly [string, string, string, RouteKind][] = [
  ['POST', '/api/live/agents/install/uninstall', 'write', 'body'],
  ['GET', '/api/live/terminal', 'write', 'get'],
  ['GET', '/api/live/terminal/list', 'read', 'get'],
  ['POST', '/api/live/terminal/end', 'write', 'body'],
  ['POST', '/api/live/view-prefs', 'write', 'body'],
  ['POST', '/api/live/agent-options', 'write', 'body'],
  ['POST', '/api/live/project-remove', 'write', 'body'],
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

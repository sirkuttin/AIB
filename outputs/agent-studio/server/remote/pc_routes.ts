/**
 * Remote control from other PCs, phase 1a: what a paired computer may do through the bridge (remote/pc_bridge.ts), per ACTION, not
 * per route (design v2 section 7, architect review MF1 and MF7, v2 re-review fixes 1-6). Every entry of ROUTE_LIST (web/routes.ts)
 * has exactly one entry here; a contract test fails on any route without one (pc_bridge_test.ts).
 *
 * An entry is one of:
 *   never   refused with 403 pc_only for every computer, whatever its switches (the complete never list, review MF7)
 *   scope   the switches the device needs; `paths` names the query or body fields that are paths and the rule each must pass
 *   rule    a route that does more than one job: `decide` reads the deciding field(s) and answers the switches needed or a refusal;
 *           `fields` is the allowlist of body / query keys the computer may send (anything else is refused: 403 pc_only)
 *   socket  a WebSocket (terminal, docs): the bridge's socket entry (pc_bridge.ts pcSocket) applies its rules
 *
 * Switches (remote/devices.ts): phone.read "See chats", phone.answer "Answer questions", phone.prompt "Send messages, stop turns and
 * continue chats" (also doc editing: the Send switch, v2 fix 5), phone.start "Start new chats", phone.approve "Approve requests once",
 * pc.always "Allow always and modes that skip approvals", pc.files "Files: see, download and edit" (owner decision 2026-11-16, 1a:
 * the file editor with the PC's rules), pc.terminal "Terminal", pc.projects "Add and remove projects". phone.push is for the device's
 * own subscription only.
 */
import type { WebContext } from '../web/server.ts';
import type { DeviceScope } from './devices.ts';
import { isMergeRequest, phoneOption } from './actions.ts';
import { Registry } from '../worktrees/worktrees.ts';
import { BlockedPath, guardNewProject, guardPath, guardProjectPath, insideProjects } from './path_guard.ts';
import { restoreFolders } from '../web/project_routes.ts';
import { scopeFor } from '../web/files_routes.ts';
import * as osp from '../platform/ospath.ts';
import { wslLoc } from '../wsl/access.ts';

type Json = Record<string, unknown>;

/** What the bridge knows of one request when it classifies it. */
export interface Ask {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Json | null;
  ctx: WebContext;
}

export type Verdict = { need: DeviceScope[] } | { refuse: string; message: string; status?: number };

/** How a path field is checked: blocked folders only; also inside an added project; or a new project (also no home or drive root). */
export type PathRule = 'blocked' | 'project' | 'newProject';

export type RemoteEntry =
  | { kind: 'never'; why: string }
  | { kind: 'scope'; need: DeviceScope[]; paths?: { in: 'query' | 'body'; field: string; rule: PathRule; list?: boolean }[] }
  | { kind: 'rule'; fields: string[] | null; decide: (ask: Ask) => Verdict | Promise<Verdict> }
  | { kind: 'socket'; socket: 'terminal' | 'docs' | 'files' };

const R: DeviceScope = 'phone.read';
const A: DeviceScope = 'phone.answer';
const S: DeviceScope = 'phone.prompt';
const ST: DeviceScope = 'phone.start';
const AP: DeviceScope = 'phone.approve';
const AL: DeviceScope = 'pc.always';
const F: DeviceScope = 'pc.files';
const T: DeviceScope = 'pc.terminal';
const P: DeviceScope = 'pc.projects';

const never = (why: string): RemoteEntry => ({ kind: 'never', why });
const scope = (...need: DeviceScope[]): RemoteEntry => ({ kind: 'scope', need });
const withPaths = (need: DeviceScope[], paths: NonNullable<Extract<RemoteEntry, { kind: 'scope' }>['paths']>): RemoteEntry => ({
  kind: 'scope',
  need,
  paths,
});
/** `fields`: the body / query keys a computer may send (null: any; the route does one job, only a path in it is checked). */
const rule = (fields: string[] | null, decide: (ask: Ask) => Verdict | Promise<Verdict>): RemoteEntry => ({ kind: 'rule', fields, decide });

export const pcOnly = (message: string): Verdict => ({ refuse: 'pc_only', message });
const isStr = (v: unknown): v is string => typeof v === 'string';
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});

// ---- modes ---------------------------------------------------------------------------------------------------------------------

/** Mode ids that keep every approval (the Send switch is enough). Any other mode, including one AIB does not know, skips some
 * approvals (bypassPermissions, acceptEdits, dontAsk, yolo, full-access, auto...) and needs pc.always: fail closed. */
export const SAFE_MODES: ReadonlySet<string> = new Set(['default', 'plan', 'readonly', 'read-only', 'read_only', 'ask', 'chat']);

export function modeNeeds(modeId: unknown): DeviceScope[] {
  return isStr(modeId) && SAFE_MODES.has(modeId.toLowerCase()) ? [S] : [S, AL];
}

// ---- added projects and chats ----------------------------------------------------------------------------------------------------

/**
 * The folders a computer's paths must be in (the project-root rule): the folders the owner added to AIB, and the chats' own worktree
 * copies of them (<state>/worktrees/…, registered in worktrees/worktrees.ts: a worktree chat works there, outside its project).
 */
export function projectFolders(ctx: WebContext): string[] {
  const added = ctx.addedProjects?.public().added ?? {};
  const roots = Object.values(added).map((item) => item.path).filter(isStr);
  try {
    if (ctx.stateDir) {
      for (const record of Object.values(new Registry(ctx.stateDir).all())) {
        const r = record as { status?: unknown; path?: unknown; project?: unknown };
        if (r.status === 'ready' && isStr(r.path) && isStr(r.project) && insideProjects(r.project, roots)) roots.push(r.path);
      }
    }
  } catch { /* no registry: the added folders only */ }
  return roots;
}

/**
 * The chat keys a computer may use for a terminal (v2 fix 4): `<provider>:<sessionId>` and `<provider>:<live id>` of every live chat
 * and every saved chat with a mark, whose folder is inside an added project; each with its folder. Never a `signin:` or `setup:`
 * key (those are AIB's own sign-in and setup terminals, refused by name too).
 */
export async function chatKeys(ctx: WebContext): Promise<Map<string, string>> {
  const projects = projectFolders(ctx);
  const out = new Map<string, string>();
  const add = (provider: unknown, id: unknown, cwd: unknown) => {
    if (!isStr(provider) || !provider || !isStr(id) || !id || !isStr(cwd) || !cwd) return;
    if (provider === 'signin' || provider === 'setup') return;
    if (!insideProjects(cwd, projects)) return;
    out.set(`${provider}:${id}`, cwd);
  };
  try {
    const listing = await ctx.host.liveList() as Json;
    for (const c of Array.isArray(listing.connections) ? listing.connections as unknown[] : []) {
      const x = obj(c);
      add(x.provider, x.sessionId, x.cwd);
      add(x.provider, x.id, x.cwd);
    }
  } catch { /* the agent host is not up: only saved chats */ }
  try {
    for (const [key, entry] of Object.entries(ctx.conversations.public().entries ?? {})) {
      const e = obj(entry);
      const at = key.indexOf(':');
      if (at > 0) add(key.slice(0, at), key.slice(at + 1), e.cwd || e.projectRoot);
    }
  } catch { /* no saved marks */ }
  return out;
}

/** AIB's own terminals that are never a chat's: sign-ins (their scrollback can hold OAuth codes) and setup runs. */
export function systemTerminalKey(key: unknown): boolean {
  return isStr(key) && /^(signin|setup):/i.test(key);
}

// ---- the multi-job routes ----------------------------------------------------------------------------------------------------------

/** POST /api/live/permission: the option picked decides (v2 fix 1). Lasting options and mode switches need pc.always, once options
 * "Approve requests once"; AIB's own merge requests are approved on the PC only. The option is looked up in the chat as it is now. */
async function permissionVerdict(ask: Ask): Promise<Verdict> {
  const body = obj(ask.body);
  const id = body.id, key = body.key, option = body.option;
  if (!isStr(id) || !isStr(key)) return { need: [AP] }; // the route says what is wrong
  if (option === null || option === undefined) return { need: [AP] }; // a plain deny / dismiss
  const state = await ask.ctx.host.liveState(id, 0).catch(() => null) as Json | null;
  const permissions = Array.isArray(state?.permissions) ? state!.permissions as unknown[] : [];
  const found = permissions.map(obj).find((p) => p.key === key || obj(p.params).key === key || p.id === key);
  if (!found) return { refuse: 'gone', message: 'This was already answered or withdrawn.', status: 409 };
  const params = found.params ?? found;
  if (isMergeRequest(params)) return pcOnly("AIB's merge requests are approved on the PC only.");
  const options = Array.isArray(obj(params).options) ? obj(params).options as unknown[] : [];
  const picked = options.map(obj).find((o) => o.optionId === option);
  if (!picked) return { refuse: 'invalid', message: 'That choice is not offered.', status: 400 };
  return phoneOption(picked) ? { need: [AP] } : { need: [AP, AL] };
}

/** POST /api/live/connect: cwd, picks.mode, helperOf and ownCopy decide (design v2 section 7, v2 fix 2). */
function connectVerdict(ask: Ask): Verdict {
  const body = obj(ask.body);
  if (body.helperOf !== undefined && body.helperOf !== null) return pcOnly('Helpers are started by their main chat on the PC.');
  if (body.ownCopy !== undefined && body.ownCopy !== null) return pcOnly('A chat copy is made on the PC only.');
  const need: DeviceScope[] = [body.resume ? S : ST];
  const cwd = body.cwd;
  if (isStr(cwd) && cwd) {
    guardPath(cwd, ask.ctx.stateDir);
    if (!insideProjects(cwd, projectFolders(ask.ctx))) {
      guardNewFolder(cwd, ask.ctx);
      need.push(P);
    }
  }
  const picks = obj(body.picks);
  if (picks.mode !== undefined && picks.mode !== null && picks.mode !== '') need.push(...modeNeeds(picks.mode));
  return { need: [...new Set(need)] };
}

/** POST /api/live/config: a mode config follows the /mode rule; any other setting needs Send (v2 fix 2). */
function configVerdict(ask: Ask): Verdict {
  const body = obj(ask.body);
  // the config id's words ('mode', 'permission_mode', 'approval-policy', 'sandbox'), never a part of one ('model' is not a mode)
  const words = isStr(body.configId) ? body.configId.toLowerCase().split(/[^a-z]+/).filter(Boolean) : [];
  if (words.some((w) => w === 'mode' || w === 'modes' || w.startsWith('permission') || w.startsWith('approval') || w === 'sandbox')) {
    return { need: modeNeeds(body.value) };
  }
  return { need: [S] };
}

/** POST /api/live/conversation-state: the marks only (read state is its own route); delete with Send; restore brings a removed project
 * back, so it needs pc.projects (v2 fix 5). */
export const CONVERSATION_ACTIONS: Readonly<Record<string, DeviceScope[]>> = {
  pin: [R],
  unpin: [R],
  archive: [R],
  unarchive: [R],
  handled: [R],
  your_turn: [R],
  delete: [S],
  restore: [R, P],
};

/** POST /api/live/inbox/act (attention/inbox_act.ts): snooze and wake are marks like "handled" (See chats); continue sends a turn
 * (the Send switch), as on the phone (remote/server.ts chat-op). */
export const INBOX_ACTIONS: Readonly<Record<string, DeviceScope[]>> = { snooze: [R], wake: [R], continue: [S] };

/** POST /api/live/session-op: the phone's chat-menu set only (end session, delete: Send); `list` names any folder: refused. */
export const SESSION_OPS: Readonly<Record<string, DeviceScope[]>> = { close: [S], delete: [S] };

/** POST /api/live/project-remove: pc.projects without the folder delete; deleting the folder, or AIB's copies in it, is the PC's. */
function projectRemoveVerdict(ask: Ask): Verdict {
  const body = obj(ask.body);
  if (body.disk === true) return pcOnly('Deleting the folder itself is done on the PC only.');
  const cleanup = obj(body.cleanup);
  if (Array.isArray(cleanup.remove) && cleanup.remove.length) {
    return pcOnly("Removing AIB's chat copies from the folder is done on the PC only.");
  }
  // the project rule (security review SF8): `check` inspects the folder (whether it exists, is a worktree), so only an added project
  guardProjectPath(isStr(body.path) ? body.path.trim() : body.path, ask.ctx.stateDir, projectFolders(ask.ctx));
  return { need: [P] };
}

/** POST /api/live/project-add: every path a new project (no blocked folder, home folder or drive root). */
function projectAddVerdict(ask: Ask): Verdict {
  const body = obj(ask.body);
  const paths = Array.isArray(body.paths) ? body.paths : [body.path];
  for (const p of paths) if (isStr(p)) guardNewFolder(p, ask.ctx);
  return { need: [P] };
}

/** A new project folder from a computer: the folder sent, and the folder AIB would really add (AddedProjects.add maps a folder inside
 * a git worktree to that repo's main checkout), both pass the new-project guard. */
function guardNewFolder(path: string, ctx: WebContext): void {
  guardNewProject(path, ctx.stateDir);
  let real = path;
  try {
    real = ctx.addedProjects.projectFolder(path);
  } catch { /* not a folder AIB can map: the guard above decides */ }
  if (real && real !== path) guardNewProject(real, ctx.stateDir);
}

/** POST /api/live/agent-options: the lists a new chat offers; with probe it starts the agent in `cwd`: a project folder, or a new one
 * with pc.projects (never a blocked one, a home folder or a drive root). */
function agentOptionsVerdict(ask: Ask): Verdict {
  const cwd = obj(ask.body).cwd;
  if (!isStr(cwd) || !cwd) return { need: [ST] };
  guardPath(cwd, ask.ctx.stateDir);
  if (insideProjects(cwd, projectFolders(ask.ctx))) return { need: [ST] };
  guardNewFolder(cwd, ask.ctx);
  return { need: [ST, P] };
}

/** POST /api/live/terminal/end: a chat's own terminal only (v2 fix 4). */
async function terminalEndVerdict(ask: Ask): Promise<Verdict> {
  const key = obj(ask.body).key;
  if (systemTerminalKey(key)) return pcOnly("AIB's sign-in and setup terminals are the PC's.");
  if (!isStr(key) || !(await chatKeys(ask.ctx)).has(key)) {
    return pcOnly('Only a chat terminal of a project added to AIB can be ended from here.');
  }
  return { need: [T] };
}

/** POST /api/live/artifacts/archive without an agent key: the page's own archive (the agent's is never: its key is refused). */
function artifactArchiveVerdict(_ask: Ask): Verdict {
  return { need: [S] };
}

/** POST /api/live/docs/open: a doc of a chat or of an added project ('project:<folder>' or {project: key}); never a blocked folder. */
function docsOpenVerdict(ask: Ask): Verdict {
  const body = obj(ask.body);
  const id = isStr(body.id) ? body.id : '';
  if (id.startsWith('project:')) guardProjectPath(id.slice('project:'.length), ask.ctx.stateDir, projectFolders(ask.ctx));
  return { need: [R] };
}

/**
 * The file editor from a computer with Files (owner decision 2026-11-16, "1a"; design v2, architect review must-fix 6). The PC's own
 * rules still apply in the routes (files/live_files.ts editPlace: a helper's or subagent's copy, aib-docs, AIB's data and .git are
 * never editable); on top, the blocked folders (sign-ins, AIB's data) for the folder and the file, and an open file named by its id
 * must be inside an added project.
 */
async function fileOpenVerdict(ask: Ask): Promise<Verdict> {
  const body = obj(ask.body);
  const args: Record<string, string[]> = {};
  for (const k of ['id', 'project', 'root']) if (isStr(body[k])) args[k] = [body[k] as string];
  const scope = await scopeFor(ask.ctx, args).catch(() => null);
  if (scope && !Array.isArray(scope) && !wslLoc(scope.root)) {
    guardPath(scope.root, ask.ctx.stateDir);
    if (isStr(body.path) && body.path) guardPath(osp.join(scope.root, ...body.path.split(/[\\/]+/)), ask.ctx.stateDir);
  } else if (scope && !Array.isArray(scope)) {
    // a WSL project's file (0.13.0): the same blocked names by Linux rules on the ref (the distro's helper checks the real path)
    guardPath(scope.root, ask.ctx.stateDir);
    if (isStr(body.path) && body.path) guardPath(`${scope.root.replace(/\/+$/, '')}/${body.path.replace(/\\/g, '/').replace(/^\/+/, '')}`, ask.ctx.stateDir);
  }
  return { need: [F] };
}

/** save / close / compare / the socket name an open file by its id: its folder and path pass the same guards, and the file is in
 * an added project (an id that is not open: the route says so). Throws BlockedPath. */
export function guardOpenFile(ctx: WebContext, id: unknown): void {
  const lf = isStr(id) ? ctx.liveFiles?.get(id) : null;
  if (!lf) return;
  guardPath(lf.place.root, ctx.stateDir);
  guardProjectPath(lf.place.abs, ctx.stateDir, projectFolders(ctx));
}

function fileIdVerdict(ask: Ask): Verdict {
  guardOpenFile(ask.ctx, ask.method === 'GET' ? ask.query.get('file') : obj(ask.body).file);
  return { need: [F] };
}

// ---- the table -----------------------------------------------------------------------------------------------------------------

const DEVICES = never('Remote control and devices are changed on the PC only');
const PCSYNC = never('Sync between PCs is set up on the PC itself');
const AGENT_KEY = never("an agent's own tool route (its key), never a device");
const SETTINGS = never('Settings and programs are changed on the PC only (v1)');
const DESK_SCREEN = never("acts on the PC's own screen or disk outside the projects");

export const PC_ROUTES: Readonly<Record<string, RemoteEntry>> = {
  // ---- monitor (transcript viewer) ----
  'GET /': never('the PC page shell; computers get their own page (phase 1b)'),
  'GET /api/agents': scope(R),
  'GET /api/command': scope(R),
  'GET /api/commands': scope(R),
  'GET /api/sessions': scope(R),
  'GET /api/transcript': scope(R),
  'GET /api/transcript/image': scope(R),
  // ---- agents, sign-in, install ----
  'GET /api/live/agents/install': SETTINGS,
  'GET /api/live/agents/signin': SETTINGS,
  'POST /api/live/agents/install': SETTINGS,
  'POST /api/live/agents/install/cancel': SETTINGS,
  'POST /api/live/agents/install/uninstall': SETTINGS,
  'POST /api/live/agents/signin': SETTINGS,
  'POST /api/live/agents/signin/cancel': SETTINGS,
  'POST /api/live/agents/signin/check': SETTINGS,
  'POST /api/live/authenticate': never('Signing an agent in is done on the PC only'),
  'POST /api/live/agent-options': rule(null, agentOptionsVerdict),
  // ---- artifacts ----
  // a chat's artifact list (the Artifacts tab): scope artifacts.tool on the page port, where an agent's key also reaches it; the bridge
  // refuses every agent key, so for a computer it is only ever the page's list with its REMOTE_PC principal (phase 1b; the phone
  // gets the same list from /api/remote/artifacts)
  'GET /api/live/artifacts': scope(R),
  'GET /api/live/artifacts/diff': scope(R),
  'GET /api/live/artifacts/item': scope(R),
  'GET /api/live/artifacts/source': scope(R),
  'GET /api/live/artifacts/states': scope(R),
  'GET /api/live/artifacts/by-source': scope(R),
  'POST /api/live/artifacts/publish': AGENT_KEY,
  'POST /api/live/artifacts/archive': rule(['ids', 'id', 'archived', 'conversationId'], artifactArchiveVerdict),
  'POST /api/live/artifacts/pin': scope(S),
  'POST /api/live/artifacts/restore': scope(S),
  'POST /api/live/artifacts/delete': scope(S),
  'POST /api/live/artifacts/undelete': scope(S),
  'POST /api/live/artifacts/purge': never('Deleting an artifact for good is done on the PC only'),
  'POST /api/live/artifacts/preview': withPaths([F], [{ in: 'body', field: 'path', rule: 'blocked' }]),
  // ---- page bootstrap, sessions, lifecycle ----
  'GET /api/live/bootstrap': never('the page bootstrap carries the page token; computers get /api/remote/pc/bootstrap (phase 1b)'),
  'GET /api/live/idle': never('`aib deploy` on the PC only'),
  'POST /api/live/page-session': never('page credentials'),
  'POST /api/live/shutdown': never('app lifecycle'),
  'GET /api/live/update': scope(R),
  'POST /api/live/update/check': never('app lifecycle'),
  'POST /api/live/update/install': never('app lifecycle'),
  'GET /api/live/update/notes': scope(R),
  'POST /api/live/update/notes': never("the PC's own What's new"),
  // ---- chats ----
  'GET /api/live/list': scope(R),
  'GET /api/live/state': scope(R),
  'GET /api/live/events': scope(R),
  'GET /api/live/event': scope(R),
  'GET /api/live/ownership': withPaths([R], [{ in: 'query', field: 'cwd', rule: 'project' }]),
  'GET /api/live/prompts': scope(R),
  'GET /api/live/conversation-state': scope(R),
  'GET /api/live/read-state': scope(R),
  'POST /api/live/read-state': scope(R),
  'POST /api/live/chat-name': scope(R),
  'GET /api/live/project-prefs': scope(R),
  'POST /api/live/project-prefs': scope(R),
  'POST /api/live/connect': rule(
    ['provider', 'cwd', 'resume', 'background', 'continueAnyway', 'picks', 'helperOf', 'ownCopy'],
    connectVerdict,
  ),
  'POST /api/live/discover': withPaths([R], [{ in: 'body', field: 'cwd', rule: 'project' }]),
  'POST /api/live/forget': scope(S),
  'POST /api/live/disconnect': scope(S),
  'POST /api/live/prompt': scope(S),
  'POST /api/live/steer': scope(S),
  'POST /api/live/cancel': scope(S),
  'POST /api/live/cancel-pending': scope(S),
  'POST /api/live/tool-stop': scope(S),
  'POST /api/live/queue': scope(S),
  'POST /api/live/queue-edit': scope(S),
  'POST /api/live/queue-move': scope(S),
  'POST /api/live/queue-remove': scope(S),
  'POST /api/live/queue-resume': scope(S),
  'POST /api/live/queue-send-now': scope(S),
  'POST /api/live/schedule': scope(S),
  'POST /api/live/schedule-edit': scope(S),
  'POST /api/live/schedule-cancel': scope(S),
  'POST /api/live/schedule-send-now': scope(S),
  'POST /api/live/dismiss-unknown': scope(S),
  'POST /api/live/elicitation': scope(A),
  'POST /api/live/permission': rule(['id', 'key', 'option'], permissionVerdict),
  'POST /api/live/mode': rule(['id', 'modeId'], (ask) => ({ need: modeNeeds(obj(ask.body).modeId) })),
  'POST /api/live/config': rule(['id', 'configId', 'value'], configVerdict),
  'POST /api/live/session-op': rule(['id', 'op', 'confirm', 'title'], (ask) => {
    const op = obj(ask.body).op;
    const need = isStr(op) ? SESSION_OPS[op] : undefined;
    return need ? { need } : pcOnly('That session action is done on the PC only.');
  }),
  'POST /api/live/conversation-state': rule(['action', 'provider', 'sessionId', 'title', 'cwd', 'note', 'projectRoot'], (ask) => {
    const body = obj(ask.body);
    const need = isStr(body.action) ? CONVERSATION_ACTIONS[body.action] : undefined;
    if (!need) return pcOnly('That change is done on the PC only.');
    if (body.action === 'restore') {
      // every folder the handler brings back (the body's and the ones stored on the mark: restoreFolders) is a new project from
      // a computer unless it is already in one: never blocked, a home folder or a drive root (security review SF11)
      const projects = projectFolders(ask.ctx);
      for (const f of restoreFolders(ask.ctx.conversations, body)) {
        if (!isStr(f) || !f) continue;
        guardPath(f, ask.ctx.stateDir);
        if (!insideProjects(f, projects)) guardNewFolder(f, ask.ctx);
      }
    }
    return { need };
  }),
  'POST /api/live/worktree-archive': withPaths([S], [{ in: 'body', field: 'cwd', rule: 'project' }]),
  // ---- the server-built inbox (Inbox v3.1): the same rows and actions as the phone's (remote/server.ts chat-op) ----
  'GET /api/live/inbox': scope(R),
  'POST /api/live/inbox/act': rule(['key', 'action', 'until'], (ask) => {
    const need = INBOX_ACTIONS[String(obj(ask.body).action ?? '')];
    return need ? { need } : pcOnly('That inbox action is done on the PC only.');
  }),
  // ---- allow rules: all of them are "Allow always" (v2 fix 1) ----
  'POST /api/live/allow/answer': scope(AL),
  'POST /api/live/allow/rules': scope(AL),
  'POST /api/live/allow/remove': scope(AL),
  'POST /api/live/allow/restore': scope(AL),
  'POST /api/live/allow/review': scope(AL),
  'POST /api/live/allow/enable': scope(AL),
  'POST /api/live/allow/builtin': scope(AL),
  // ---- worktrees, swarm ----
  'GET /api/live/worktree': scope(R),
  'GET /api/live/worktree/clash': scope(R),
  'POST /api/live/worktree/merge': never('Merge has no button any more; merges go through the agent in chat'),
  'POST /api/live/worktree/clash': never('Clash resolving has no button any more'),
  'POST /api/live/worktree/tool': AGENT_KEY,
  'POST /api/live/cleanup/all': never("Removing AIB's data from the repos is done on the PC only"),
  'GET /api/live/swarm': scope(R),
  'POST /api/live/swarm/tool': AGENT_KEY,
  'POST /api/live/swarm/undo': scope(S),
  'POST /api/live/swarm/merge-again': scope(S),
  // ---- Changes (read only now), branch ----
  'GET /api/live/changes': scope(F),
  'GET /api/live/changes/file': scope(F),
  'GET /api/live/project/artifacts': scope(R),
  'GET /api/live/project/changes': scope(F),
  'GET /api/live/project/changes/file': scope(F),
  'GET /api/live/branch': withPaths([R], [{ in: 'query', field: 'cwd', rule: 'project' }]),
  // ---- settings, editors, desktop ----
  'GET /api/live/settings': SETTINGS, // phase 1b: an allowlisted remote settings view
  'POST /api/live/settings': SETTINGS,
  'POST /api/live/model-servers/check': SETTINGS,
  'GET /api/live/model-servers': SETTINGS,
  'GET /api/live/editors': never("Editors are the PC's programs; computers download instead"),
  'POST /api/live/open': DESK_SCREEN,
  'POST /api/live/view-prefs': never("the PC's own layout; computers get a per-device variant (phase 1b)"),
  'POST /api/live/presence': never('the PC windows; computers get a device presence route (phase 2)'),
  'POST /api/live/desktop/notify': DESK_SCREEN,
  'POST /api/live/desktop/windows': DESK_SCREEN,
  // ---- folders and projects ----
  'GET /api/live/folders/check': withPaths([P], [{ in: 'query', field: 'path', rule: 'newProject' }]),
  'GET /api/live/folders/kinds': withPaths([P], [{ in: 'query', field: 'path', rule: 'blocked', list: true }, {
    in: 'query',
    field: 'paths',
    rule: 'blocked',
    list: true,
  }]),
  'GET /api/live/folders/gone': withPaths([R], [{ in: 'query', field: 'path', rule: 'project', list: true }, {
    in: 'query',
    field: 'paths',
    rule: 'project',
    list: true,
  }]),
  'GET /api/live/folders/start': scope(P),
  'POST /api/live/folders/create': withPaths([P], [{ in: 'body', field: 'path', rule: 'newProject' }]),
  'POST /api/live/folders/remember': withPaths([P], [{ in: 'body', field: 'path', rule: 'newProject' }]),
  'POST /api/live/folders/pick': never("opens the system folder picker on the PC's screen; computers type the path"),
  'POST /api/live/project-add': rule(['path', 'paths'], projectAddVerdict),
  'POST /api/live/project-remove': rule(['path', 'check', 'disk', 'cleanup', 'titles', 'projects'], projectRemoveVerdict),
  // ---- files: see, download and edit ----
  'GET /api/live/files/list': scope(F),
  'GET /api/live/files/search': scope(F),
  'GET /api/live/files/read': scope(F),
  'GET /api/live/files/outside': withPaths([F], [{ in: 'query', field: 'path', rule: 'blocked' }]),
  'POST /api/live/files/exclude': never('Git exclude is changed on the PC only'),

  // the file editor: a computer with Files edits with the PC's rules (owner decision 2026-11-16, 1a). `text` (a test's stand-in for
  // typing) is not accepted from a computer: its edits come through the file socket like the page's
  'POST /api/live/files/open': rule(['id', 'project', 'root', 'path'], fileOpenVerdict),
  'POST /api/live/files/save': rule(['file', 'sv', 'force'], fileIdVerdict),
  'POST /api/live/files/close': rule(['file', 'view', 'discard'], fileIdVerdict),
  'GET /api/live/files/compare': rule(['file'], fileIdVerdict),
  'GET /api/live/files/socket': { kind: 'socket', socket: 'files' },
  // ---- terminal ----
  'GET /api/live/terminal': { kind: 'socket', socket: 'terminal' },
  'GET /api/live/terminal/list': scope(T), // the answer is filtered to chat keys of added projects (pc_bridge.ts)
  'POST /api/live/terminal/end': rule(['key'], terminalEndVerdict),
  // ---- WSL ----
  'GET /api/live/wsl/status': never('WSL status carries the URLs waiting to open on the PC (sign-ins); phase 1b: a remote variant'),
  'GET /api/live/wsl/dirs': withPaths([P], [{ in: 'query', field: 'path', rule: 'blocked' }]),
  'GET /api/live/wsl/agents': scope(ST),
  'GET /api/live/wsl/agents/install': SETTINGS,
  'POST /api/live/wsl/agents/install': SETTINGS,
  'POST /api/live/wsl/agents/install/cancel': SETTINGS,
  'POST /api/live/wsl/agents/enabled': SETTINGS,
  'POST /api/live/wsl/agents/uninstall': SETTINGS,
  'GET /api/live/wsl/prereqs': SETTINGS,
  'POST /api/live/wsl/reconnect': scope(S),
  'POST /api/live/wsl/open-url': DESK_SCREEN,
  // ---- local docs: reading with See chats, editing with Send (v2 fix 5) ----
  'POST /api/live/docs/open': rule(['id', 'project', 'name', 'create'], docsOpenVerdict),
  'GET /api/live/docs/list': scope(R),
  'GET /api/live/docs/info': scope(R),
  'GET /api/live/docs/built': scope(R),
  'GET /api/live/docs/became': scope(R),
  'GET /api/live/docs/shown': scope(R),
  'GET /api/live/docs/history': scope(R),
  'GET /api/live/docs/history/version': scope(R),
  'GET /api/live/docs/socket': { kind: 'socket', socket: 'docs' },
  'POST /api/live/docs/tool': AGENT_KEY,
  'POST /api/live/docs/from-artifact': scope(S),
  'POST /api/live/docs/from-artifact/undo': scope(S),
  'POST /api/live/docs/comment/send': scope(S),
  'POST /api/live/docs/link': scope(S),
  'POST /api/live/docs/page': scope(S),
  'POST /api/live/docs/page/request': scope(S),
  'POST /api/live/docs/claim/release': scope(S),
  'POST /api/live/docs/notes/dismiss': scope(S),
  'POST /api/live/docs/edit': scope(S),
  'POST /api/live/docs/comment': scope(S),
  'POST /api/live/docs/history/restore': scope(S),
  'POST /api/live/docs/duplicate': scope(S),
  'POST /api/live/docs/trash': scope(S),
  'POST /api/live/docs/export': DESK_SCREEN, // writes into the PC's Downloads
  'POST /api/live/docs/reveal': DESK_SCREEN,
  // ---- devices and remote control ----
  'GET /api/live/devices': DEVICES,
  'POST /api/live/devices/access': DEVICES,
  'POST /api/live/devices/check': DEVICES,
  'POST /api/live/devices/pair': DEVICES,
  'POST /api/live/devices/pair/cancel': DEVICES,
  'POST /api/live/devices/approve': DEVICES,
  'POST /api/live/devices/reject': DEVICES,
  'POST /api/live/devices/remove': DEVICES,
  'POST /api/live/devices/remove-all': DEVICES,
  'POST /api/live/devices/scopes': DEVICES,
  'POST /api/live/devices/kind': DEVICES,
  'GET /api/live/devices/activity': DEVICES,
  'POST /api/live/devices/prefs': DEVICES,
  'POST /api/live/devices/tailscale/refresh': DEVICES,
  'POST /api/live/devices/tailscale/run': DEVICES,
  'GET /api/live/devices/tailscale/job': DEVICES,
  'POST /api/live/devices/tailscale/cancel': DEVICES,
  'GET /api/live/pcsync': PCSYNC,
  'GET /api/live/pcsync/devices': PCSYNC,
  'POST /api/live/pcsync/on': PCSYNC,
  'POST /api/live/pcsync/start': PCSYNC,
  'POST /api/live/pcsync/cancel': PCSYNC,
  'POST /api/live/pcsync/approve': PCSYNC,
  'POST /api/live/pcsync/reject': PCSYNC,
  'POST /api/live/pcsync/join': PCSYNC,
  'POST /api/live/pcsync/share': PCSYNC,
  'POST /api/live/pcsync/remove': PCSYNC,
  'POST /api/live/pcsync/projects/link': PCSYNC,
  'POST /api/live/pcsync/projects/confirm': PCSYNC,
  'POST /api/live/pcsync/projects/unlink': PCSYNC,
  'POST /api/live/pcsync/projects/switch': PCSYNC,
};

/** The entry for (method, path), or null: not a page route, so the bridge answers 404. */
export function entryFor(method: string, path: string): RemoteEntry | null {
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  return Object.hasOwn(PC_ROUTES, `${m} ${path}`) ? PC_ROUTES[`${m} ${path}`] : null;
}

/** The values of a path field: one, or (list) every repeated query value and the JSON list in `paths`. */
function pathValues(ask: Ask, spot: { in: 'query' | 'body'; field: string; list?: boolean }): unknown[] {
  if (spot.in === 'body') {
    const v = obj(ask.body)[spot.field];
    return Array.isArray(v) ? v : [v];
  }
  if (!spot.list) return [ask.query.get(spot.field)];
  const out: unknown[] = [...ask.query.getAll(spot.field)];
  if (spot.field === 'paths') {
    const all: unknown[] = [];
    for (const raw of out) {
      try {
        const parsed = JSON.parse(String(raw));
        if (Array.isArray(parsed)) all.push(...parsed);
        else all.push(parsed);
      } catch {
        all.push(raw);
      }
    }
    return all;
  }
  return out;
}

/** The decision for one request: the switches it needs, or why it is refused. Path rules throw BlockedPath; that is a refusal too. */
export async function decide(entry: RemoteEntry, ask: Ask): Promise<Verdict> {
  try {
    if (entry.kind === 'never') return pcOnly(`This is done on the PC only (${entry.why}).`);
    if (entry.kind === 'socket') return pcOnly('This address only takes a WebSocket.');
    if (entry.kind === 'scope') {
      for (const spot of entry.paths ?? []) {
        for (const value of pathValues(ask, spot)) {
          if (value === null || value === undefined || value === '') continue;
          if (spot.rule === 'blocked') guardPath(value, ask.ctx.stateDir);
          else if (spot.rule === 'project') guardProjectPath(value, ask.ctx.stateDir, projectFolders(ask.ctx));
          else guardNewFolder(String(value), ask.ctx);
        }
      }
      return { need: entry.need };
    }
    const keys = ask.method === 'POST' ? Object.keys(obj(ask.body)) : [...new Set(ask.query.keys())];
    const fields = entry.fields;
    const extra = fields ? keys.filter((k) => !fields.includes(k)) : [];
    if (extra.length) return pcOnly(`Not accepted from another computer: ${extra.slice(0, 5).join(', ')}.`);
    return await entry.decide(ask);
  } catch (error) {
    if (error instanceof BlockedPath) return { refuse: error.code, message: error.message, status: error.status };
    throw error;
  }
}

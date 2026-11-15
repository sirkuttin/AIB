/**
 * WSL projects on the page (docs/wsl/design.md sections 4 and 8; Deno only: routes.ts DENO_ONLY). Every route needs the Studio token, like
 * the Files routes, and reaches a distro only through wsl/access.ts.
 *   GET  /api/live/wsl/status                      {available, distros: [{name, key, state, line, home, helper, problem, alwaysAllow}],
 *                                                   openRequests: [{id, distro, name, url, at}]}: the Location choice, the distro state
 *                                                   line, Settings > About, and the URLs waiting for "Open" (wsl/open_urls.ts)
 *   GET  /api/live/wsl/dirs?distro&path            the New / Add project folder browser: fs.listDirs in the distro ('' = its home)
 *   GET  /api/live/wsl/agents?distro[&force=1]     the agent picker: which agents the distro has, the install command of the others, and
 *                                                   AIB's own install of Claude Code / Codex (installable, pinned, update, job,
 *                                                   installBlock + nodeInstall when Node.js is missing; force: look for Node.js again)
 *   GET  /api/live/wsl/agents/install?distro&agent  the install job in the distro (wsl/agent_install.ts; the job runs in its helper)
 *   POST /api/live/wsl/agents/install {distro, agent}         "Install in Ubuntu" / "Update in Ubuntu": start (or join) the job
 *   POST /api/live/wsl/agents/install/cancel {distro, agent}  Cancel: the job's npm is killed and its half-made folder removed
 *   POST /api/live/wsl/reconnect {distro}          "Reconnect" on a stopped distro's state line
 *   POST /api/live/wsl/open-url {id, action}       the page's answer to "Ubuntu wants to open <url>": open, always (for that distro), dismiss
 * Plus the Files view of a WSL project (wslFiles, called by files_routes.ts): list, search and read through the distro's helper.
 */
import { tokenMatches } from './security.ts';
import { issueBytes } from './file_tickets.ts';
import type { WebContext } from './server.ts';
import { parseQs } from '../artifacts/origin.ts';
import { WslHelperError, type WslHost } from '../wsl/contract.ts';
import { refOf, type WslLoc } from '../platform/location.ts';
import { distroName, hostWhenReady, notReady, peekWslHost, WSL_INSTALL, wsl2Distros, wslHost } from '../wsl/access.ts';
import { urlGate } from '../wsl/open_urls.ts';
import { extOf, type FileRead, IMAGE_EXT, LIMITS, PAGE_EXT } from '../worktrees/files.ts';
import { BUILTIN_IDS } from '../agents/agent_registry.ts';
import { installFacts, wslInstallCall } from '../wsl/agent_install.ts';

type Reply = [number, unknown];
type Handler = (ctx: WebContext, url: URL, body: unknown, request: Request) => Promise<Reply>;

const one = (args: Record<string, string[]>, name: string, fallback = '') => (Object.hasOwn(args, name) ? args[name][0] : fallback);
const DISTRO = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The preview link of a file inside a distro (images, pages, markdown): the bytes the helper sent go into a ticket the artifact origin
 * serves read only (file_tickets.ts issueBytes), exactly as for a Windows file; '' when there is no origin or nothing to show.
 */
export function wslViewUrl(origin: string, ref: string, read: FileRead, bytesB64: string | undefined): string {
  const viewable = (read.image && !read.tooBig) || (read.page && !read.binary && !read.tooBig);
  if (!origin || !viewable || !bytesB64) return '';
  const bytes = Uint8Array.from(atob(bytesB64), (c) => c.charCodeAt(0));
  return origin + '/f/' + issueBytes(ref, bytes) + '/' + encodeURIComponent(read.name) + (/\.(md|markdown)$/i.test(read.name) ? '?view=1' : '');
}

/**
 * The New project dialog's folder check and create for a WSL path: the helper runs the same functions a Windows project uses, with
 * Linux rules; every Linux path in the answer goes back to the page as the project's ref.
 */
export async function wslProjectReply(
  loc: WslLoc,
  call: (host: WslHost, linuxPath: string) => Promise<Record<string, unknown>>,
): Promise<Reply> {
  let host: WslHost;
  try {
    host = await hostWhenReady(loc.distro);
  } catch (error) {
    return [409, { error: error instanceof Error ? error.message : String(error), code: 'wsl_unavailable' }];
  }
  try {
    const out = { ...await call(host, loc.linuxPath) };
    for (const key of ['path', 'parent', 'folder']) {
      const value = out[key];
      if (typeof value === 'string' && value.startsWith('/')) out[key] = refOf({ kind: 'wsl', distro: loc.distro, linuxPath: value });
    }
    return [200, out];
  } catch (error) {
    return failed(error);
  }
}

/** A helper failure as a reply: its code, status 400 (409 when the distro is not ready). */
function failed(error: unknown): Reply {
  if (error instanceof WslHelperError) return [error.code === 'not_found' ? 404 : 400, { error: error.message, code: error.code }];
  throw error;
}

/** The distro's line for the state, '' when it is ready (never starts the distro). */
function lineOf(distro: string): string {
  return notReady(peekWslHost(distro), distro);
}

/** GET /api/live/wsl/status: also the page's poll for URLs waiting to be opened. */
export async function wslStatus(ctx: { stateDir?: string | null }): Promise<Record<string, unknown>> {
  urlGate.configure(ctx.stateDir ? String(ctx.stateDir) : null);
  const found = await wsl2Distros();
  const distros = [];
  for (const d of found) {
    const key = d.name.toLowerCase();
    const host = peekWslHost(key); // the poll never starts a distro
    const state = host ? host.state : 'off'; // 'off': on this PC, but AIB has not used it since it started
    let home: string | null = null;
    let helper: string | null = null;
    let problem = '';
    if (host && host.state === 'ready') {
      try {
        const env = await host.call('env.get', {}, { timeoutMs: 3000 });
        home = env.home || null;
        helper = host.helperVersion;
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
    } else if (host && (host.state === 'unavailable' || host.state === 'stopped')) problem = host.note || lineOf(key);
    distros.push({
      name: d.name,
      key,
      state,
      line: host ? lineOf(key) : '',
      home,
      helper,
      problem,
      alwaysAllow: urlGate.alwaysAllowed(key),
    });
  }
  return {
    available: distros.length > 0,
    distros,
    openRequests: urlGate.waiting().map((r) => ({ ...r, name: distroName(r.distro) })),
  };
}

export function wslRoutes(): Map<string, Handler> {
  const routes = new Map<string, Handler>();
  const guarded = (method: 'GET' | 'POST', path: string, work: (ctx: WebContext, args: Record<string, string[]>, body: Record<string, unknown>) => Promise<Reply>) => {
    routes.set(`${method} ${path}`, async (ctx, url, body, request) => {
      if (!tokenMatches(request.headers.get('X-Studio-Token') ?? '', ctx.token)) return [403, { error: 'Invalid local session token' }];
      const args = parseQs(url.search.slice(1));
      const fields = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
      try {
        return await work(ctx, args, fields);
      } catch (error) {
        return failed(error);
      }
    });
  };
  guarded('GET', '/api/live/wsl/status', async (ctx) => [200, await wslStatus(ctx)]);
  guarded('GET', '/api/live/wsl/dirs', async (_ctx, args) => {
    const distro = one(args, 'distro');
    if (!DISTRO.test(distro)) return [400, { error: 'Choose a distro', code: 'bad_distro' }];
    let host: WslHost;
    try {
      host = await hostWhenReady(distro); // the first set-up waits here instead of answering 'setting up'
    } catch (error) {
      return [409, { error: error instanceof Error ? error.message : String(error), code: 'wsl_unavailable' }];
    }
    let path = one(args, 'path');
    if (path.includes('\0') || path.length > 1024 || (path && !path.startsWith('/'))) return [400, { error: 'Type an absolute Linux path', code: 'bad_path' }];
    if (!path) path = (await host.call('env.get', {})).home || '/';
    return [200, await host.call('fs.listDirs', { path, limit: 500 })];
  });
  guarded('GET', '/api/live/wsl/agents', async (_ctx, args) => {
    const distro = one(args, 'distro');
    if (!DISTRO.test(distro)) return [400, { error: 'Choose a distro', code: 'bad_distro' }];
    let host: WslHost;
    try {
      host = await hostWhenReady(distro); // the first set-up waits here instead of answering 'setting up'
    } catch (error) {
      return [409, { error: error instanceof Error ? error.message : String(error), code: 'wsl_unavailable' }];
    }
    const found = await host.call('agents.detect', { ids: [...BUILTIN_IDS] });
    const name = distroName(distro);
    const facts = await installFacts(host, distro.toLowerCase(), name, found.agents, one(args, 'force') === '1');
    const agents = found.agents.map((a) => ({
      id: a.id,
      found: !!a.found,
      ...(a.version ? { version: a.version } : {}),
      ...(a.note ? { note: a.note } : {}),
      ...(!a.found && WSL_INSTALL[a.id] ? { install: WSL_INSTALL[a.id] } : {}),
      ...(facts[a.id] ?? {}),
    }));
    return [200, { distro: distro.toLowerCase(), name, agents }];
  });
  // AIB's own install of an agent in the distro: the job runs in the distro's helper, so it goes on while AIB restarts
  const install = async (distro: string, action: 'start' | 'cancel' | 'status', agent: unknown): Promise<Reply> => {
    if (!DISTRO.test(distro)) return [400, { error: 'Choose a distro', code: 'bad_distro' }];
    let host: WslHost;
    try {
      host = await hostWhenReady(distro);
    } catch (error) {
      return [409, { error: error instanceof Error ? error.message : String(error), code: 'wsl_unavailable' }];
    }
    return await wslInstallCall(host, distro.toLowerCase(), distroName(distro), action, agent);
  };
  const bodyDistro = (body: Record<string, unknown>) => (typeof body.distro === 'string' ? body.distro : '');
  guarded('GET', '/api/live/wsl/agents/install', (_ctx, args) => install(one(args, 'distro'), 'status', one(args, 'agent')));
  guarded('POST', '/api/live/wsl/agents/install', (_ctx, _args, body) => install(bodyDistro(body), 'start', body.agent));
  guarded('POST', '/api/live/wsl/agents/install/cancel', (_ctx, _args, body) => install(bodyDistro(body), 'cancel', body.agent));
  guarded('POST', '/api/live/wsl/reconnect', async (_ctx, _args, body) => {
    const distro = typeof body.distro === 'string' ? body.distro : '';
    if (!DISTRO.test(distro)) return [400, { error: 'Choose a distro', code: 'bad_distro' }];
    const host = wslHost(distro);
    if (!host) return [404, { error: `${distroName(distro)} is not available to AIB.`, code: 'wsl_unavailable' }];
    await host.reconnect().catch(() => {}); // a failure is the host's state and note, answered below
    return [200, { ok: true, state: host.state, line: lineOf(distro) }];
  });
  guarded('POST', '/api/live/wsl/open-url', (ctx, _args, body) => {
    urlGate.configure(ctx.stateDir ? String(ctx.stateDir) : null);
    return Promise.resolve([200, { ok: urlGate.answer(body.id, body.action) }]);
  });
  return routes;
}

// ---- the Files view of a WSL project ------------------------------------------------------------------------------------------

/** A Files request (list, search, read) for a WSL project's folder `{distro, linuxPath}`, through the distro's helper. */
export async function wslFiles(
  kind: 'list' | 'search' | 'read',
  ref: string,
  wsl: { distro: string; linuxPath: string },
  args: Record<string, string[]>,
  origin = '',
): Promise<Reply> {
  let host: WslHost;
  try {
    host = await hostWhenReady(wsl.distro); // a distro still starting is waited for, not answered with 'starting'
  } catch (error) {
    return [409, { error: error instanceof Error ? error.message : String(error), code: 'wsl_unavailable' }];
  }
  // no local-only files (phase 1): the same answer a folder without git gets, so no exclude hints are offered
  const localOnly = { main: ref, entries: [], defaultState: 'no-git', sig: '' };
  try {
    if (kind === 'list') {
      const listing = await host.call('files.list', { root: wsl.linuxPath, rel: one(args, 'dir') }) as Record<string, unknown>;
      const { sig: _sig, ...rest } = listing ?? {};
      return [200, { root: ref, ...rest, localOnly, wsl: true }];
    }
    if (kind === 'search') {
      const found = await host.call('files.search', { root: wsl.linuxPath, query: one(args, 'q') }) as Record<string, unknown>;
      return [200, { root: ref, ...(found ?? {}), localOnly, wsl: true }];
    }
    const rel = one(args, 'path').replace(/^\/+/, '');
    const read = await host.call('files.read', { root: wsl.linuxPath, rel, maxBytes: LIMITS.readBytes });
    const out = fileReadOf(wsl.linuxPath, rel, read);
    return [200, { root: ref, ...out, viewUrl: wslViewUrl(origin, refOf({ kind: 'wsl', distro: wsl.distro, linuxPath: out.abs }), out, read.bytesB64), wsl: true }];
  } catch (error) {
    return failed(error);
  }
}

/** files.readFile's answer from the helper's bytes (the same rules: binary, too big, image, page); the preview link is wslViewUrl's. */
export function fileReadOf(
  linuxRoot: string,
  rel: string,
  read: { bytesB64: string; size: number; truncated: boolean; mtimeMs: number },
): FileRead {
  const name = rel.slice(rel.lastIndexOf('/') + 1), ext = extOf(name);
  const bytes = Uint8Array.from(atob(read.bytesB64 || ''), (c) => c.charCodeAt(0));
  const out: FileRead = {
    path: rel,
    abs: `${linuxRoot.replace(/\/+$/, '')}/${rel}`,
    name,
    size: read.size,
    mtime: read.mtimeMs / 1000,
    binary: bytes.subarray(0, LIMITS.probe).includes(0),
    tooBig: read.size > LIMITS.readBytes || read.truncated,
    image: IMAGE_EXT.has(ext),
    page: PAGE_EXT.has(ext),
    text: null,
    lines: 0,
  };
  if (!out.binary && !out.tooBig && !(out.image && ext !== '.svg')) {
    out.text = new TextDecoder().decode(bytes);
    out.lines = out.text ? out.text.split('\n').length - (out.text.endsWith('\n') ? 1 : 0) : 0;
  }
  return out;
}

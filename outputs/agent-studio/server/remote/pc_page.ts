/**
 * Remote control from other PCs, phase 1b: the computer page (design v2 sections 5, 6 and 11; architect review MF3, MF4, MF10, MF11
 * and the v2 re-review's fixes 7-9). Served on the phone port (remote/server.ts), next to the phone page.
 *
 *   /                  a neutral loader (remote-loader.html): it reads the device record where phones keep it (IndexedDB 'aib-phone',
 *                      phone.js) and opens /phone.html (no record, or a phone) or /pc.html (a computer). QR links go straight to
 *                      /phone.html#p=..., never through it. The cookie never picks the page.
 *   /pc.html           chat.html served WITHOUT the server-written view preferences (no data block, no theme attribute): remote-auth.js
 *                      instead of page-auth.js, no desktop-bridge.js, and every deferred page script made inert
 *                      (type="text/x-aib-later") so remote-auth.js runs them in order once it has the device token, the remote
 *                      bootstrap and this device's own view preferences.
 *   /doc.html          the doc page, the same way.
 *   PC_STATIC          the explicit list of files the computer page loads (never folder serving; a test checks chat.html and doc.html
 *                      ask for nothing else).
 *   /api/remote/pc/*   the allowlisted bootstrap (built here, never filtered from the page's), this device's view preferences, the
 *                      Settings view without commands, paths or keys, and the WSL status without URLs (remote/server.ts #pcRoute).
 */
import { APP_VERSION } from '../core/app.ts';
import { inDir } from '../state/base.ts';
import { CHAT_NAMES, ViewPrefs } from '../state/view_prefs.ts';
import type { Device } from './devices.ts';

const sep = Deno.build.os === 'windows' ? '\\' : '/';

export const PC_PAGE = '/pc.html';
export const PC_DOC = '/doc.html';
export const PC_MANIFEST = '/pc.webmanifest';
export const LOADER = '/';

/**
 * Every file the computer page and its doc page load, by address (v2 fix 9): the loader, the shells' own scripts, every stylesheet
 * and script chat.html and doc.html name (except page-auth.js and desktop-bridge.js), the scripts they load later (the question
 * cards, xterm), and the doc editor. The drawing editor (doc-drawing.html and its Excalidraw bundle) is not served remotely yet.
 */
export const PC_STATIC: Readonly<Record<string, string>> = (() => {
  const top = [
    // the loader and the computer page's own script
    'remote-loader.html',
    'remote-loader.js',
    'push-enable.js',
    'remote-auth.js',
    'remote-windows.js',
    'remote.css',
    // chat.html's stylesheets
    'chat.css',
    'activity.css',
    'workspace.css',
    'clamp.css',
    'stream.css',
    'header.css',
    'inbox-reply.css',
    'commands.css',
    'queue.css',
    'textsize.css',
    'settings.css',
    'changes.css',
    'artifacts.css',
    'plan.css',
    'split.css',
    'views.css',
    'start-page.css',
    'terminal.css',
    'files.css',
    // chat.html's scripts (themes.js and markdown.js are the phone's too)
    'view-prefs.js',
    'store-merge.js',
    'window-context.js',
    'terminal-ui.js',
    'run-terminal-ui.js',
    'wsl-ui.js',
    'tool-views.js',
    'editors-ui.js',
    'copy-ui.js',
    'stream-ui.js',
    'unknown-send.js',
    'image-viewer.js',
    'attachments-ui.js',
    'commands-ui.js',
    'config-ui.js',
    'session-ops.js',
    'terminals-ui.js',
    'ownership-ui.js',
    'organize-ui.js',
    'status-words.js',
    'attention-ui.js',
    'agent-choice.js',
    'composer-chips.js',
    'inbox-rules.js',
    'notify-rules.js',
    'notify-ui.js',
    'read-state.js',
    'sidebar-ui.js',
    'commands-registry.js',
    'switcher-ui.js',
    'textsize-ui.js',
    'resize-ui.js',
    'workspace-state.js',
    'new-project-ui.js',
    'inbox-reply.js',
    'delete-project-ui.js',
    'workspace-ui.js',
    'split-tree.js',
    'split-ui.js',
    'doc-icons.js',
    'files-state.js',
    'files-ui.js',
    'doc-links.js',
    'subagents-ui.js',
    'activity-ui.js',
    'clash-ui.js',
    'changes-ui.js',
    'artifacts-ui.js',
    'clamp-ui.js',
    'header-ui.js',
    'send-menu-ui.js',
    'queue-ui.js',
    'updates-ui.js',
    'devices-ui.js',
    'allow-rules-ui.js',
    'settings-ui.js',
    'wsl-settings-ui.js',
    'start-page-ui.js',
    'plan-ui.js',
    'views.js',
    'views-ui.js',
    'focus-return.js',
    'scroll-controller.js',
    'chat-cache.js',
    'chat.js',
    // loaded later by the page: the question cards (chat.js), the doc page's own files
    'elicitation-ui.js',
    'docs.css',
    'doc-ui.js',
    'doc-toolbar.js',
    'doc-panels.js',
  ];
  const out: Record<string, string> = {};
  for (const name of top) out['/' + name] = name;
  for (const name of ['xterm.js', 'addon-fit.js', 'addon-canvas.js', 'xterm.css']) {
    out[`/vendor/xterm/${name}`] = `vendor${sep}xterm${sep}${name}`;
  }
  out['/vendor/docs/editor.js'] = `vendor${sep}docs${sep}editor.js`;
  return out;
})();

/** Page scripts the computer page never loads: the page's own credentials, and the desktop app's bridge (it acts on the PC). */
export const NEVER_ON_PC: readonly string[] = ['/page-auth.js', '/desktop-bridge.js'];

/** The marker type of a page script remote-auth.js runs once it is ready (a type the browser does not run by itself). */
export const LATER_TYPE = 'text/x-aib-later';

/**
 * chat.html (or doc.html) as the computer page: no view preferences inside (they are this device's and come from an authenticated
 * route), remote-auth.js first, no desktop bridge, the deferred scripts held for remote-auth.js, the computer manifest. Throws when
 * the shell does not look like chat.html any more (a test catches that before it ships).
 */
export function pcShell(html: string, manifest = true): string {
  if (!html.includes('<script src="/page-auth.js"></script>')) throw new Error('pcShell: page-auth.js is not where it was');
  // remote-windows.js (phase 4): this browser's own AIB windows, before any page script asks for one
  let out = html.replace(
    '<script src="/page-auth.js"></script>',
    '<script src="/push-enable.js"></script><script src="/remote-auth.js"></script><script src="/remote-windows.js"></script>',
  );
  out = out.replace(/<script src="\/desktop-bridge\.js" defer><\/script>\s*/g, '');
  out = out.replace(
    /<script src="([^"]+)" defer><\/script>/g,
    (_m, src: string) => `<script type="${LATER_TYPE}" data-src="${src}"></script>`,
  );
  out = out.replace(/^(<!doctype html>\s*)?<html\b/i, (m) => m + ' data-remote="pc"');
  const head = '<meta name="referrer" content="no-referrer">' + (manifest ? `<link rel="manifest" href="${PC_MANIFEST}">` : '');
  // the computer page's own stylesheet, after the page's (what a computer does not have, hidden from the first paint)
  out = out.replace(/<\/head>/i, '<link rel="stylesheet" href="/remote.css"></head>');
  out = out.replace(/<meta charset="utf-8">/i, (m) => m + head);
  if (/id="aibViewPrefs"/.test(out) || /data-theme-pref=/.test(out)) throw new Error('pcShell: the shell carries view preferences');
  return out;
}

/** The addresses a shell asks for (src= and href= of its own files): the test that the static list is complete. */
export function shellAssets(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/(?:src|href|data-src)="(\/[^"]*)"/g)) out.add(m[1]);
  return [...out];
}

/** The computer page's headers: the page port's CSP with the phone's artifact origin (https://<name>:8443) instead of the loopback
 * one, no framing by other sites, no forms, no plugins. The drawing page is not served here. */
export function securityHeadersPc(artifacts = ''): Record<string, string> {
  const other = artifacts ? ' ' + artifacts : '';
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'" + other +
      " data: blob:; media-src 'self' data: blob:; font-src 'self'; frame-src 'self'" + other +
      "; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'",
  };
}

/** The computer's web app manifest (Install AIB in Edge or Chrome): its own id and start page, next to the phone's. */
export function pcManifestOf(pcName: string): Record<string, unknown> {
  return {
    id: PC_PAGE,
    name: `AIB on ${pcName}`,
    short_name: 'AIB',
    description: `Your AIB on ${pcName}, from this computer.`,
    start_url: PC_PAGE,
    scope: '/',
    display: 'standalone',
    background_color: '#16151b',
    theme_color: '#16151b',
    icons: [
      { src: '/icons/icon-128.png', sizes: '128x128', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-256.png', sizes: '256x256', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
}

/** The keys of the remote bootstrap, exactly (a test checks the shape is this and nothing else). */
export const PC_BOOTSTRAP_KEYS = ['layout', 'pcName', 'device', 'instanceId', 'version', 'artifactOrigin', 'features'] as const;

/**
 * GET /api/remote/pc/bootstrap: built on its own, never filtered from the page bootstrap (MF3). Never a token, launch nonce, state
 * folder, process id or loopback address. `features` are the page's fixed feature switches (no values of this PC).
 */
export function pcBootstrap(o: { pcName: string; device: Device; instanceId: unknown; artifactOrigin: string }): Record<string, unknown> {
  const instanceId = typeof o.instanceId === 'string' ? o.instanceId.slice(0, 80) : '';
  return {
    layout: 'pc',
    pcName: o.pcName,
    device: { id: o.device.id, name: o.device.name, kind: 'computer', scopes: [...o.device.scopes] },
    instanceId,
    version: APP_VERSION,
    artifactOrigin: /^https:\/\/[^/]+$/.test(o.artifactOrigin) ? o.artifactOrigin : '',
    features: {
      promptReceipts: true,
      sessionLeases: true,
      formElicitation: true,
      asyncConnect: true,
      imageAttachments: true,
      fileAttachments: true,
      urlElicitation: true,
      authentication: false, // signing an agent in is done on the PC only
      setupRequests: true,
      requestWithdrawal: true,
      acpBreadth: true,
      sessionDiscovery: true,
      conversationOrganize: true,
    },
  };
}

// ---- per-device view preferences (MF4) -------------------------------------------------------------------------------------------

const DEVICE_ID = /^[A-Za-z0-9_-]{4,64}$/;

/**
 * The layout of each computer, apart from the PC's own (state/view_prefs.ts keeps the PC's): panel widths, text size, sidebar mode,
 * open tabs, last chat per project, Files tabs, theme. One file per device, `studio-view.device-<id>.json` in the state folder.
 * Chat names stay shared (they are the PC's: read from its store, renamed through /api/live/chat-name); read state and the marks are
 * other stores, shared already. A laptop never writes the PC's file, so the PC's right panel only moves when its owner drags it.
 */
export class DeviceViewPrefs {
  #stores = new Map<string, ViewPrefs>();
  constructor(readonly stateDir: string | null, readonly shared: () => ViewPrefs) {}

  static file(id: string): string {
    return `studio-view.device-${id}.json`;
  }

  for(id: string): ViewPrefs {
    if (!DEVICE_ID.test(id)) throw new Error('bad device id');
    let store = this.#stores.get(id);
    if (!store) {
      store = new ViewPrefs(this.stateDir, DeviceViewPrefs.file(id));
      this.#stores.set(id, store);
    }
    return store;
  }

  /** What the computer page seeds from: this device's layout, and the PC's shared chat names. */
  view(id: string): { revision: string; prefs: Record<string, string> } {
    const own = this.for(id).public();
    const prefs = { ...own.prefs };
    delete prefs[CHAT_NAMES];
    const names = this.shared().public().prefs[CHAT_NAMES];
    if (names !== undefined) prefs[CHAT_NAMES] = names;
    return { revision: own.revision, prefs };
  }

  /** POST from the computer page: this device's keys only; the shared chat names are never written here (Rename has its route). */
  async update(id: string, body: unknown): Promise<{ changed: boolean; refused: string[] }> {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const set = b.set && typeof b.set === 'object' && !Array.isArray(b.set) ? { ...b.set as Record<string, unknown> } : null;
    const refused: string[] = [];
    if (set && CHAT_NAMES in set) {
      delete set[CHAT_NAMES];
      refused.push(CHAT_NAMES);
    }
    const result = await this.for(id).update(set ? { ...b, set } : b);
    return { changed: result.changed, refused: [...refused, ...result.refused] };
  }

  /** A removed device: its layout goes too (phase 1c calls this from Remove). */
  forget(id: string): void {
    this.#stores.delete(id);
    if (!this.stateDir || !DEVICE_ID.test(id)) return;
    try {
      Deno.removeSync(inDir(this.stateDir, DeviceViewPrefs.file(id)));
    } catch { /* never saved */ }
  }
}

// ---- Settings for a computer -----------------------------------------------------------------------------------------------------

/** The fields of an agent row a computer sees: what New chat and the agent picker need. Never a command, path, argument,
 * environment name, install job or sign-in link. */
const AGENT_FIELDS = ['id', 'name', 'letter', 'builtin', 'beta', 'enabled', 'userOff', 'found', 'status'] as const;

/**
 * GET /api/remote/pc/settings: the Settings view a computer page needs to work (the agents New chat offers, the defaults it starts
 * with, the default chat view), never API keys, launch commands, editors' programs, server switches or paths. Settings on a computer
 * shows only Appearance (this computer) and This computer; everything else says "Change this on <PC>".
 */
export function remoteSettingsView(view: Record<string, unknown>): Record<string, unknown> {
  const settings = (view.settings && typeof view.settings === 'object' ? view.settings : {}) as Record<string, unknown>;
  const defaults = (settings.defaults && typeof settings.defaults === 'object' ? settings.defaults : {}) as Record<string, unknown>;
  const appearance = (settings.appearance && typeof settings.appearance === 'object' ? settings.appearance : {}) as Record<
    string,
    unknown
  >;
  const agents = Array.isArray(view.agents) ? view.agents : [];
  return {
    revision: typeof view.revision === 'string' ? view.revision : '',
    remote: true,
    settings: {
      defaults: { agent: defaults.agent ?? '', byAgent: defaults.byAgent ?? {}, projects: defaults.projects ?? {}, migrated: true },
      appearance: { defaultView: appearance.defaultView ?? '' },
    },
    agents: agents.map((row) => {
      const r = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of AGENT_FIELDS) if (k in r) out[k] = r[k];
      const signin = r.signin && typeof r.signin === 'object' ? (r.signin as Record<string, unknown>).state : undefined;
      if (typeof signin === 'string') out.signin = { state: signin };
      return out;
    }),
  };
}

/** GET /api/remote/pc/wsl-status: the distros and their state lines only; never the URLs waiting to open on the PC (sign-ins),
 * homes, helper versions or wsl.exe's path. */
export function remoteWslStatus(status: Record<string, unknown>): Record<string, unknown> {
  const distros = Array.isArray(status.distros) ? status.distros : [];
  return {
    available: status.available === true,
    distros: distros.map((d) => {
      const x = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
      return { name: x.name, key: x.key, state: x.state, line: x.line, isDefault: x.isDefault === true, removed: x.removed === true };
    }),
    openRequests: [],
    skipped: [],
  };
}

// ---- artifacts: the phone's artifact origin, never the loopback one --------------------------------------------------------------

/**
 * A bridged answer that names artifact links of the loopback artifact origin (http://127.0.0.1:<port>/a/<id>/...): each becomes a
 * short-lived signed link for this device on the phone's artifact port (https://<name>:8443/r/<ticket>/a/<id>/...), the same
 * links the phone opens. Without the artifact port the links are left out (''): the computer cannot reach the loopback origin.
 */
export function remoteArtifactLinks(text: string, loopback: string, remote: string, mint: (id: string) => string): string {
  if (!loopback || !text.includes(loopback)) return text;
  const esc = loopback.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const tickets = new Map<string, string>();
  const ticket = (id: string) => {
    let t = tickets.get(id);
    if (!t) tickets.set(id, t = mint(id));
    return t;
  };
  return text.replace(
    new RegExp(esc + '/a/([0-9a-f]{16})/', 'g'),
    (_m, id: string) => remote ? `${remote}/r/${ticket(id)}/a/${id}/` : 'about:blank#',
  ) // any other link of the loopback origin (the Files view's /f/<ticket>/ preview links): left out, never the PC's loopback port
    // (security review SF10; the computer's Files view shows Download for them)
    .replace(new RegExp(esc + '[^"\\s\\\\]*', 'g'), '');
}

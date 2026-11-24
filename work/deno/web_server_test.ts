/** server/web: the route table equals Python's, page-file mapping equals web_handler.studio_asset, CLI parsing matches studio.py. */
import { assert, assertEquals, assertThrows } from './_assert.ts';
import { Frozen } from './_frozen.ts';
import { DENO_ONLY, ROUTE_LIST } from '../../outputs/agent-studio/server/web/routes.ts';
import { studioAsset } from '../../outputs/agent-studio/server/web/server.ts';
import { parseOptions, UsageError } from '../../outputs/agent-studio/server/core/options.ts';
import { LIVE_POST_OPS } from '../../outputs/agent-studio/server/web/live_routes.ts';
import { REMOTE_ROUTES, REMOTE_STATIC } from '../../outputs/agent-studio/server/remote/server.ts';
import { LOADER } from '../../outputs/agent-studio/server/remote/pc_page.ts';

Deno.test('the route table is exactly the Python web server\'s (paths, scopes and kinds)', async () => {
  const py = new Frozen();
  const routes = await py.callItems('shims', 'studio_routes') as [string, string, string][];
  // The one documented exception: routes the Python server does not have (routes.ts DENO_ONLY). Kept to exactly this list.
  assertEquals(DENO_ONLY.map(([m, p]) => `${m} ${p}`), [
    'GET /api/live/project/changes', 'GET /api/live/project/changes/file', 'GET /api/live/project/artifacts', // the project right panel
    'GET /api/live/events', 'GET /api/live/event',
    'POST /api/live/allow/answer', // allow rules (page session only)
    'POST /api/live/allow/rules',
    'POST /api/live/allow/remove',
    'POST /api/live/allow/restore',
    'POST /api/live/allow/review',
    'POST /api/live/allow/enable',
    'POST /api/live/allow/builtin',
    'POST /api/live/swarm/tool', // swarm phase 1
    'POST /api/live/swarm/undo',
    'POST /api/live/swarm/merge-again',
    'GET /api/live/swarm',
    'POST /api/live/agents/install/uninstall',
    'GET /api/live/terminal',
    'GET /api/live/terminal/list',
    'POST /api/live/terminal/end',
    'POST /api/live/view-prefs',
    'POST /api/live/agent-options',
    'POST /api/live/model-servers/check', // model servers: ask a server for its models
    'GET /api/live/model-servers', // model servers: the list with each one's health
    'POST /api/live/desktop/notify',
    'GET /api/live/update/notes',
    'POST /api/live/update/notes',
    'POST /api/live/project-remove',
    'POST /api/live/project-add',
    'POST /api/live/cleanup/all', // folder chats P4a: Settings "Remove AIB's data from my repos"
    'GET /api/live/folders/gone',
    'GET /api/live/files/list',
    'GET /api/live/files/search',
    'GET /api/live/files/read',
    'GET /api/live/files/outside',
    'POST /api/live/files/exclude',
    'POST /api/live/files/open', // the file editor (live_files_routes.ts): page session only
    'POST /api/live/files/save',
    'POST /api/live/files/close',
    'GET /api/live/files/compare',
    'GET /api/live/files/socket',
    'GET /api/live/wsl/status',
    'GET /api/live/wsl/dirs',
    'GET /api/live/wsl/agents',
    'GET /api/live/wsl/agents/install',
    'POST /api/live/wsl/agents/install',
    'POST /api/live/wsl/agents/install/cancel',
    'POST /api/live/wsl/agents/enabled',
    'POST /api/live/wsl/agents/uninstall',
    'GET /api/live/wsl/prereqs',
    'POST /api/live/wsl/reconnect',
    'POST /api/live/wsl/open-url',
    'POST /api/live/docs/open',
    'GET /api/live/docs/list',
    'GET /api/live/docs/info',
    'GET /api/live/docs/built',
    'GET /api/live/docs/became',
    'POST /api/live/docs/from-artifact',
    'POST /api/live/docs/from-artifact/undo',
    'GET /api/live/docs/shown',
    'GET /api/live/docs/socket',
    'POST /api/live/docs/tool',
    'POST /api/live/docs/comment/send',
    'POST /api/live/docs/link',
    'POST /api/live/docs/page',
    'POST /api/live/docs/page/request',
    'POST /api/live/docs/claim/release',
    'POST /api/live/docs/notes/dismiss',
    'POST /api/live/docs/edit',
    'POST /api/live/docs/comment',
    'GET /api/live/docs/history',
    'GET /api/live/docs/history/version',
    'POST /api/live/docs/history/restore',
    'POST /api/live/docs/export',
    'POST /api/live/docs/duplicate',
    'POST /api/live/docs/trash',
    'POST /api/live/docs/reveal',
    'GET /api/live/devices',
    'POST /api/live/devices/access',
    'POST /api/live/devices/check',
    'POST /api/live/devices/pair',
    'POST /api/live/devices/pair/cancel',
    'POST /api/live/devices/approve',
    'POST /api/live/devices/reject',
    'POST /api/live/devices/remove',
    'POST /api/live/devices/remove-all',
    'POST /api/live/devices/scopes',
    'POST /api/live/devices/kind',
    'GET /api/live/devices/activity',
    'POST /api/live/devices/prefs',
    'POST /api/live/devices/tailscale/refresh',
    'POST /api/live/devices/tailscale/run',
    'GET /api/live/devices/tailscale/job',
    'POST /api/live/devices/tailscale/cancel',
    // Settings > Sync (pair your PCs; sync V1)
    'GET /api/live/pcsync',
    'GET /api/live/pcsync/marks',
    'GET /api/live/pcsync/devices',
    'POST /api/live/pcsync/on',
    'POST /api/live/pcsync/start',
    'POST /api/live/pcsync/cancel',
    'POST /api/live/pcsync/approve',
    'POST /api/live/pcsync/reject',
    'POST /api/live/pcsync/join',
    'POST /api/live/pcsync/share',
    'POST /api/live/pcsync/remove',
    'POST /api/live/pcsync/projects/link',
    'POST /api/live/pcsync/projects/confirm',
    'POST /api/live/pcsync/projects/unlink',
    'POST /api/live/pcsync/projects/switch',
    'POST /api/live/pcsync/projects/files',
    'POST /api/live/pcsync/projects/conflict',
    'POST /api/live/pcsync/projects/bin',
    'POST /api/live/pcsync/projects/restore',
    'POST /api/live/presence',
    'POST /api/live/desktop/windows', // multi-window K3
    'POST /api/live/artifacts/archive',
    'POST /api/live/artifacts/delete',
    'POST /api/live/artifacts/undelete',
    'POST /api/live/artifacts/purge',
    'GET /api/live/artifacts/states',
    'GET /api/live/artifacts/by-source',
    'POST /api/live/steer',
    'POST /api/live/tool-stop',
    'POST /api/live/schedule', // Send later
    'POST /api/live/schedule-edit',
    'POST /api/live/schedule-cancel',
    'POST /api/live/schedule-send-now',
    'POST /api/live/chat-name',
    'POST /api/live/page-session',
    'GET /api/live/idle',
    'GET /api/live/inbox', // the server-built inbox (Inbox v3.1)
    'POST /api/live/inbox/act',
  ]);
  const denoOnly = new Set(DENO_ONLY.map(([m, p]) => `${m} ${p}`));
  // The other exception: the monitor page (its files, /api/bootstrap and /api/activity) the app removed; the frozen Python
  // reference still has them.
  const removed = new Set(['/', '/index.html', '/conversation.html', '/app.js', '/style.css', '/sidebar.js', '/sidebar.css']
    .filter((p) => p !== '/').concat(['/api/bootstrap', '/api/activity']).map((p) => `GET ${p}`));
  assertEquals(ROUTE_LIST.filter(([m, p]) => removed.has(`${m} ${p}`)), [], 'the monitor page routes are gone');
  assertEquals(
    ROUTE_LIST.filter(([m, p]) => !denoOnly.has(`${m} ${p}`)).map(([m, p, s]) => [m, p, s]),
    routes.filter(([m, p]) => !removed.has(`${m} ${p}`)),
  );
  const kinds = new Map((await py.callItems('shims', 'studio_route_kinds') as [string, string, string][]).map(([m, p, k]) => [`${m} ${p}`, k]));
  for (const [m, p, , kind] of ROUTE_LIST) if (!denoOnly.has(`${m} ${p}`)) assertEquals(kind, kinds.get(`${m} ${p}`) ?? 'monitor', `${m} ${p}`);
});

Deno.test('studioAsset maps the same paths as web_handler.studio_asset', async () => {
  const py = new Frozen();
  const paths = ['/', '/chat.html', '/chat.js', '/style.css', '/app.js', '/sidebar.js', '/theme.css', '/missing.js', '/Chat.js', '/../x.js', '/a/b.js',
    '/.hidden.js', '/chat.py', '/index.html', '/conversation.html', '/-x.js', '/chat.js?x=1'];
  for (const path of paths) assertEquals(studioAsset(path), await py.call('web_handler', 'studio_asset', [path]), path);
});

Deno.test('CLI flags parse like studio.py', () => {
  const o = parseOptions(['--port', '0', '--state-dir=C:\\s', '--no-auto-reconnect', '--no-owner-announcements', '--enable-client-fs', '--host-idle-minutes', '2.5']);
  assertEquals([o.port, o.stateDir, o.autoReconnect, o.ownersDir, o.enableClientFs, o.hostIdleMinutes], [0, 'C:\\s', false, null, 'readwrite', 2.5]);
  assertEquals(parseOptions(['--enable-client-fs', 'read']).enableClientFs, 'read');
  assertEquals(parseOptions([]).port, 8767);
  assertThrows(() => parseOptions(['--nope']), UsageError);
  assertThrows(() => parseOptions(['--port', 'x']), UsageError);
  assertThrows(() => parseOptions(['--port', '70000']), UsageError); // port-guard: not bound (argv parsing)
  assertThrows(() => parseOptions(['--enable-client-fs', 'write']), UsageError);
  assertThrows(() => parseOptions(['--state-dir']), UsageError);
});

Deno.test('LIVE_POST_OPS equals Studio.LIVE_POST_OPS', async () => {
  const py = new Frozen();
  // Steer-on-send's two calls are Deno only (routes.ts DENO_ONLY lists their routes); everything else is Python's set.
  const denoOnly = ['steer', 'tool-stop', 'schedule', 'schedule-edit', 'schedule-cancel', 'schedule-send-now']; // Send later too
  assert(denoOnly.every((op) => (LIVE_POST_OPS as readonly string[]).includes(op)));
  assertEquals([...LIVE_POST_OPS].filter((op) => !denoOnly.includes(op)).sort(), await py.call('shims', 'live_post_ops'));
});

Deno.test('the phone port routes are not page routes, and the page port does not serve them', () => {
  const page = new Set(ROUTE_LIST.map(([m, p]) => `${m} ${p}`));
  // Remote PC phase 1b: the phone port answers / with its own loader (remote-loader.html, remote/pc_page.ts), not the page port's
  // monitor page; it is the one address both ports answer, each with its own file.
  for (const [m, p] of REMOTE_ROUTES) assertEquals(page.has(`${m} ${p}`), m === 'GET' && p === LOADER, `${m} ${p}`);
  for (const [, p] of REMOTE_ROUTES) if (p.startsWith('/api/')) assertEquals(p.startsWith('/api/remote/'), true, p);
  // the phone page's scripts and styles are plain page files the page port also has (no secrets in them); phone.html and the
  // phone API are only on the phone port
  // The service worker and the app icons are on the phone port only (pwa/ and icons/ are not page files).
  const phoneOnly = (path: string) => path === '/phone.html' || path === '/sw.js' || path.startsWith('/icons/');
  for (const path of Object.keys(REMOTE_STATIC)) assertEquals(studioAsset(path), phoneOnly(path) ? null : path.slice(1), path);
  assertEquals(studioAsset('/manifest.webmanifest'), null);
  for (const path of ['/', '/chat.html']) assertEquals(Object.keys(REMOTE_STATIC).includes(path), false, path);
});

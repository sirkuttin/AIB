/** server/web: the route table equals Python's, page-file mapping equals web_handler.studio_asset, CLI parsing matches studio.py. */
import { assertEquals, assertThrows } from './_assert.ts';
import { PyParity } from './_parity.ts';
import { DENO_ONLY, ROUTE_LIST } from '../../outputs/agent-studio/server/web/routes.ts';
import { studioAsset } from '../../outputs/agent-studio/server/web/server.ts';
import { parseOptions, UsageError } from '../../outputs/agent-studio/server/core/options.ts';
import { LIVE_POST_OPS } from '../../outputs/agent-studio/server/web/live_routes.ts';

Deno.test('the route table is exactly the Python web server\'s (paths, scopes and kinds)', async () => {
  await using py = new PyParity();
  const routes = await py.call('shims', 'studio_routes') as [string, string, string][];
  // The one documented exception: routes the Python server does not have (routes.ts DENO_ONLY). Kept to exactly this list.
  assertEquals(DENO_ONLY.map(([m, p]) => `${m} ${p}`), [
    'POST /api/live/agents/install/uninstall',
    'GET /api/live/terminal',
    'GET /api/live/terminal/list',
    'POST /api/live/terminal/end',
    'POST /api/live/view-prefs',
    'POST /api/live/agent-options',
    'POST /api/live/desktop/notify',
  ]);
  const denoOnly = new Set(DENO_ONLY.map(([m, p]) => `${m} ${p}`));
  assertEquals(ROUTE_LIST.filter(([m, p]) => !denoOnly.has(`${m} ${p}`)).map(([m, p, s]) => [m, p, s]), routes);
  const kinds = new Map((await py.call('shims', 'studio_route_kinds') as [string, string, string][]).map(([m, p, k]) => [`${m} ${p}`, k]));
  for (const [m, p, , kind] of ROUTE_LIST) if (!denoOnly.has(`${m} ${p}`)) assertEquals(kind, kinds.get(`${m} ${p}`) ?? 'monitor', `${m} ${p}`);
});

Deno.test('studioAsset maps the same paths as web_handler.studio_asset', async () => {
  await using py = new PyParity();
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
  assertThrows(() => parseOptions(['--port', '70000']), UsageError);
  assertThrows(() => parseOptions(['--enable-client-fs', 'write']), UsageError);
  assertThrows(() => parseOptions(['--state-dir']), UsageError);
});

Deno.test('LIVE_POST_OPS equals Studio.LIVE_POST_OPS', async () => {
  await using py = new PyParity();
  assertEquals([...LIVE_POST_OPS].sort(), await py.call('shims', 'live_post_ops'));
});

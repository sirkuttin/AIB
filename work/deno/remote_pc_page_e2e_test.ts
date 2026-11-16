/**
 * Remote control from other PCs, phase 1b: the computer page (server/remote/pc_page.ts, remote-auth.js, remote-loader.js), against
 * an in-process AIB with a fake agent host and a paired COMPUTER (no real Tailscale: this test plays Tailscale Serve with DevTools
 * Fetch interception and forged Serve headers, as the phone page tests do).
 *   - the static list is explicit and complete: every file chat.html and doc.html ask for is listed, nothing else is served (no
 *     page-auth.js, desktop-bridge.js, server source, licences), the shell carries no view preferences and frames :8443;
 *   - the remote bootstrap is exactly the allowlist (no token, launch key, state folder, process ids, loopback addresses), a phone
 *     token gets 403 not_computer;
 *   - per-device layout: a computer's prefs never touch the PC's, chat names stay shared, a computer cannot write them;
 *   - Settings for a computer: no commands, paths, keys; WSL status without URLs;
 *   - the service worker caches both shells and a computer's push opens /pc.html (the server names the page);
 *   - headless page: / (the loader) -> /pc.html for a computer; the real AIB page draws; no request carries a page credential and
 *     none is rate limited on the first load; the laptop's panel resize leaves the PC's width alone; Settings shows Appearance and
 *     This computer (help lines), the PC's sections say "Change this on <PC>"; Browse… is hidden in New project.
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { readRemoteArtifactPort, readRemotePort } from '../../outputs/agent-studio/server/remote/port.ts';
import { REMOTE_STATIC } from '../../outputs/agent-studio/server/remote/server.ts';
import { openTarget } from '../../outputs/agent-studio/server/remote/push.ts';
import {
  PC_BOOTSTRAP_KEYS,
  PC_STATIC,
  pcShell,
  remoteArtifactLinks,
  shellAssets,
} from '../../outputs/agent-studio/server/remote/pc_page.ts';
import { DEVICE_HEADER } from '../../outputs/agent-studio/server/remote/pc_bridge.ts';
import {
  fakeTailscale,
  LOGIN,
  NAME,
  pairPhone,
  pc,
  phoneHeaders,
  raw,
  type RemoteStudio,
  remoteStudio,
  serveStatus,
  writeSavedChat,
} from './_remote_fixture.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const APP = new URL('../../outputs/agent-studio/', import.meta.url);
const read = (name: string) => Deno.readTextFileSync(new URL(name, APP));

async function remoteOn(): Promise<RemoteStudio> {
  const fake = fakeTailscale();
  const s = await remoteStudio({ runner: fake.runner }, undefined, {
    saved: true,
  });
  fake.state.serve = serveStatus(readRemotePort(s.state)!);
  const [status] = await pc(s, 'POST', '/api/live/devices/access', {
    on: true,
  });
  assertEquals(status, 200);
  return s;
}

function get(
  s: RemoteStudio,
  path: string,
  token?: string,
  extra: Record<string, string> = {},
) {
  return raw(s.phonePort(), 'GET', path, {
    ...phoneHeaders({}, 'GET'),
    ...(token ? { [DEVICE_HEADER]: token } : {}),
    ...extra,
  });
}
function post(s: RemoteStudio, path: string, token: string, body: Json) {
  return raw(s.phonePort(), 'POST', path, {
    ...phoneHeaders({}, 'POST'),
    [DEVICE_HEADER]: token,
  }, JSON.stringify(body));
}

// ---- the static list, the shell, the service worker (no AIB running) ------------------------------------------------------------

Deno.test('computer page: the static list is explicit and covers every file chat.html and doc.html ask for', () => {
  const served = new Set([
    ...Object.keys(PC_STATIC),
    ...Object.keys(REMOTE_STATIC),
    '/pc.webmanifest',
    '/',
  ]);
  for (const file of ['chat.html', 'doc.html']) {
    const shell = pcShell(read(file), file === 'chat.html');
    for (const asset of shellAssets(shell)) {
      assert(served.has(asset), `${file} asks for ${asset}, not on the list`);
    }
    assert(
      !shell.includes('/page-auth.js') && !shell.includes('/desktop-bridge.js'),
      `${file}: no page credentials or desktop bridge`,
    );
    assert(
      !shell.includes('aibViewPrefs') && !shell.includes('data-theme-pref'),
      `${file}: no view preferences inside`,
    );
    assert(
      shell.includes('<script src="/remote-auth.js"></script>'),
      `${file}: remote-auth.js first`,
    );
    assert(
      !/<script src="[^"]+" defer>/.test(shell),
      `${file}: every page script waits for remote-auth.js`,
    );
  }
  // the scripts the page loads later
  for (
    const later of [
      '/elicitation-ui.js',
      '/vendor/xterm/xterm.js',
      '/vendor/xterm/addon-fit.js',
      '/vendor/xterm/addon-canvas.js',
    ]
  ) {
    assert(served.has(later), later);
  }
  // every listed file exists, none is a credential script, none is outside the app's page files
  for (const [path, file] of Object.entries(PC_STATIC)) {
    assert(
      Deno.statSync(new URL(file.replaceAll('\\', '/'), APP)).isFile,
      `${path} exists`,
    );
    assert(!['/page-auth.js', '/desktop-bridge.js'].includes(path), path);
    assert(!/\.\.|^\/server\//.test(path), path);
  }
  // the service worker's computer file list is the same list (minus what it precaches)
  const sw = read('pwa/sw.js');
  const pcFiles = [
    ...sw.slice(
      sw.indexOf('const PC_FILES = ['),
      sw.indexOf('];', sw.indexOf('const PC_FILES = [')),
    ).matchAll(/'(\/[^']+)'/g),
  ]
    .map((m) => m[1]);
  const precached = ['/remote-loader.js', '/remote-auth.js', '/remote-windows.js', '/remote.css'];
  const expected = [
    ...Object.keys(PC_STATIC).filter((p) => !precached.includes(p)),
    '/doc.html',
  ].sort();
  assertEquals([...pcFiles].sort(), expected, 'sw.js PC_FILES = PC_STATIC');
});

Deno.test('computer page: a push for a computer opens /pc.html, a phone /phone.html; artifact links leave the loopback origin', () => {
  assertEquals(openTarget('computer', 'c1', true), '/pc.html#chat=c1');
  assertEquals(openTarget('phone', 'c1', true), '/phone.html#chat=c1&sheet=1');
  assertEquals(openTarget('computer', '', false), '/pc.html');
  const loop = 'http://127.0.0.1:5123';
  const text = JSON.stringify({
    url: `${loop}/a/0123456789abcdef/v2/index.html`,
    file: `${loop}/f/xyz/a.png`,
  });
  const out = remoteArtifactLinks(
    text,
    loop,
    `https://${NAME}:8443`,
    (id) => 'T' + id.slice(0, 4),
  );
  assert(
    out.includes(
      `https://${NAME}:8443/r/T0123/a/0123456789abcdef/v2/index.html`,
    ),
    out,
  );
  assert(
    !remoteArtifactLinks(text, loop, '', () => 'x').includes(
      '/a/0123456789abcdef/v2',
    ),
    'no artifact port: no link',
  );
});

// ---- the remote routes (HTTP, a paired computer) --------------------------------------------------------------------------------

Deno.test({
  ...OPTS,
  name: 'computer page: allowlisted bootstrap, per-device layout, Settings without programs or keys, static refusals',
  async fn() {
    const s = await remoteOn();
    try {
      const computer = await pairPhone(
        s,
        'Laptop (Edge)',
        undefined,
        'computer',
      );
      const phone = await pairPhone(s, 'Pixel 9');
      // bootstrap: exactly the allowlist, nothing of the page's
      const boot = await get(s, '/api/remote/pc/bootstrap', computer.token);
      assertEquals(boot.status, 200, boot.text);
      assertEquals(
        Object.keys(boot.json).sort(),
        [...PC_BOOTSTRAP_KEYS].sort(),
      );
      assertEquals((boot.json.device as Json).kind, 'computer');
      for (
        const secret of [
          s.token,
          s.state,
          '127.0.0.1',
          'launchNonce',
          'stateDir',
          'hostPid',
          String(Deno.pid),
        ]
      ) {
        assert(!boot.text.includes(secret), `bootstrap carries ${secret}`);
      }
      assertEquals(
        (await get(s, '/api/remote/pc/bootstrap', phone.token)).json.code,
        'not_computer',
      );
      assertEquals((await get(s, '/api/remote/pc/bootstrap')).status, 401);
      // the phone bootstrap sends a computer to its page
      assertEquals(
        (await get(s, '/api/remote/bootstrap', computer.token)).json.layout,
        'pc',
      );
      assertEquals(
        (await get(s, '/api/remote/bootstrap', phone.token)).json.layout,
        'phone',
      );

      // layout per device: the PC's file never changes; chat names stay the PC's and are shared
      await s.ctx.viewPrefs.update({
        set: {
          'studio-layout-v1:<1400': '{"activity":300}',
          'studio-conversation-names': '{"claude:s1":"Menu fix"}',
        },
      });
      const before = JSON.stringify(s.ctx.viewPrefs.public().prefs);
      const saved = await post(s, '/api/remote/pc/view-prefs', computer.token, {
        set: {
          'studio-layout-v1:<1400': '{"activity":520}',
          'aib-theme': 'nord',
          'studio-conversation-names': '{}',
        },
      });
      assertEquals(saved.status, 200, saved.text);
      assertEquals(saved.json.refused, ['studio-conversation-names']);
      assertEquals(
        JSON.stringify(s.ctx.viewPrefs.public().prefs),
        before,
        "the PC's layout is untouched",
      );
      const mine = (await get(s, '/api/remote/pc/view-prefs', computer.token))
        .json.prefs as Record<string, string>;
      assertEquals(mine['studio-layout-v1:<1400'], '{"activity":520}');
      assertEquals(mine['aib-theme'], 'nord');
      assertEquals(
        mine['studio-conversation-names'],
        '{"claude:s1":"Menu fix"}',
        'chat names are the shared ones',
      );
      assertEquals(
        (await post(s, '/api/remote/pc/view-prefs', phone.token, { set: {} }))
          .json.code,
        'not_computer',
      );

      // Settings: what New chat needs, never a command, path, key or server switch
      const settings = await get(s, '/api/remote/pc/settings', computer.token);
      assertEquals(settings.status, 200, settings.text);
      for (
        const word of [
          '"command"',
          '"launcher"',
          '"resolved"',
          '"args"',
          '"env"',
          'betaKey',
          'keepAwake',
          '"editors"',
          '"launchers"',
        ]
      ) {
        assert(!settings.text.includes(word), `settings carries ${word}`);
      }
      assert(
        Array.isArray(settings.json.agents) &&
          (settings.json.agents as Json[]).length > 0,
        'agents listed',
      );
      const wsl = await get(s, '/api/remote/pc/wsl-status', computer.token);
      assertEquals(wsl.status, 200, wsl.text);
      assertEquals(wsl.json.openRequests, []);

      // the page files: the loader, the shell (no prefs, frames the artifact port), the list; nothing else
      const loader = await get(s, '/');
      assertEquals(loader.status, 200);
      assert(loader.text.includes('/remote-loader.js'));
      const shell = await get(s, '/pc.html');
      assertEquals(shell.status, 200);
      assert(
        !shell.text.includes('aibViewPrefs') &&
          !shell.text.includes('"activity":300'),
        'no prefs in the shell',
      );
      assert(!shell.text.includes(s.token), 'no page token in the shell');
      const csp = shell.headers.get('content-security-policy') ?? '';
      assert(!csp.includes('127.0.0.1'), csp);
      assertEquals(
        (await get(s, '/pc.webmanifest')).json.start_url,
        '/pc.html',
      );
      assertEquals(
        (await get(s, '/manifest.webmanifest')).json.start_url,
        '/phone.html',
      );
      for (
        const path of [
          '/page-auth.js',
          '/desktop-bridge.js',
          '/chat.html',
          '/vendor/xterm/LICENSE',
          '/server/main.ts',
          '/doc-drawing.html',
        ]
      ) {
        assertEquals((await get(s, path)).status, 404, path);
      }
      assertEquals((await get(s, '/chat.js')).status, 200);
      assertEquals((await get(s, '/vendor/xterm/xterm.js')).status, 200);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'computer page: artifacts open from the artifact port (signed links, its CSP frames :8443), never the loopback origin',
  async fn() {
    const fake = fakeTailscale();
    const s = await remoteStudio({ runner: fake.runner });
    try {
      s.ctx.artifacts.start(s.port);
      fake.state.serve = serveStatus(readRemotePort(s.state)!, false, readRemoteArtifactPort(s.state)!);
      assertEquals((await pc(s, 'POST', '/api/live/devices/access', { on: true }))[0], 200);
      const loop = s.ctx.artifacts.store.origin;
      const a = s.ctx.artifacts.store.create('claude:sess-c', 'Sales report', 'html', 'report.html', new TextEncoder().encode('<p>Hi</p>'));
      const computer = await pairPhone(s, 'Laptop (Edge)', undefined, 'computer');
      const item = await get(s, `/api/live/artifacts/item?id=${a.id}`, computer.token);
      assertEquals(item.status, 200, item.text);
      assert(!item.text.includes(loop), `the loopback artifact origin leaks: ${item.text.slice(0, 300)}`);
      const url = String(item.json.url ?? '');
      assert(url.startsWith(`https://${NAME}:8443/r/`) && url.endsWith(`/a/${a.id}/v1/report.html`), url);
      // the link loads on the artifact port, as the computer page's frame asks for it
      const frame = await raw(s.artifactPort(), 'GET', url.slice(`https://${NAME}:8443`.length), {
        Host: `${NAME}:8443`,
        'Tailscale-User-Login': LOGIN,
        'X-Forwarded-For': '100.64.0.7',
        'Sec-Fetch-Site': 'same-site',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'iframe',
      });
      assertEquals(frame.status, 200, frame.text);
      // the computer page may frame that origin (and only it, besides its own)
      const csp = (await get(s, '/pc.html')).headers.get('content-security-policy') ?? '';
      assert(csp.includes(`frame-src 'self' https://${NAME}:8443;`), csp);
      assert(!csp.includes(loop), csp);
    } finally {
      await s.close();
    }
  },
});

// ---- the page in a headless Chrome --------------------------------------------------------------------------------------------

/** This test is Tailscale Serve, forwarding every header the page sends (so a page credential would reach AIB's gate) and
 * recording what it saw. */
async function serveAll(
  page: Page,
  s: RemoteStudio,
  seen: {
    credential: string[];
    limited: string[];
    refused: string[];
    requests: number;
    bridged: number[];
  },
) {
  await page.send('Network.enable');
  await page.send('Fetch.enable', {
    patterns: [{ urlPattern: `https://${NAME}/*`, requestStage: 'Request' }],
  });
  page.listeners.set('Fetch.requestPaused', (p) => {
    void (async () => {
      const request = p.request as Json;
      const url = new URL(request.url as string);
      const method = request.method as string;
      const kind = p.resourceType as string;
      const headers: Record<string, string> = {
        Host: NAME,
        'Tailscale-User-Login': LOGIN,
        'X-Forwarded-For': '100.64.0.7',
      };
      for (
        const [k, v] of Object.entries(
          request.headers as Record<string, string>,
        )
      ) {
        if (/^(host|cookie|connection|content-length|sec-fetch-.*)$/i.test(k)) {
          continue;
        }
        headers[k] = v;
        if (
          /^(x-studio-token|x-aib-page-key|x-aib-page-session|x-studio-artifact-key)$/i
            .test(k)
        ) {
          seen.credential.push(`${k} ${url.pathname}`);
        }
      }
      if (
        method === 'POST' &&
        !Object.keys(headers).some((k) => k.toLowerCase() === 'origin')
      ) headers.Origin = `https://${NAME}`;
      if (kind === 'Document') {
        Object.assign(headers, {
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Dest': 'document',
        });
      } else if (kind === 'Fetch' || kind === 'XHR') {
        Object.assign(headers, {
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Dest': 'empty',
        });
      } else {Object.assign(headers, {
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'no-cors',
          'Sec-Fetch-Dest': kind.toLowerCase(),
        });}
      if (url.pathname.startsWith('/api/')) seen.requests++;
      if (
        url.pathname.startsWith('/api/live/') ||
        !url.pathname.startsWith('/api/remote/') &&
          url.pathname.startsWith('/api/')
      ) {
        seen.bridged.push(performance.now());
      }
      let answer = null;
      try {
        answer = await raw(
          s.phonePort(),
          method,
          url.pathname + url.search,
          headers,
          request.postData as string | undefined,
        );
      } catch { /* Serve answers 502 */ }
      if (!answer) {
        await page.send('Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: 502,
          responseHeaders: [],
          body: '',
        });
        return;
      }
      if (answer.status === 429) seen.limited.push(url.pathname);
      if (answer.status === 401 || answer.status === 403) {
        seen.refused.push(
          `${answer.status} ${method} ${url.pathname} ${answer.text.slice(0, 160)}`,
        );
      }
      const responseHeaders: Json[] = [];
      answer.headers.forEach((value, name) => {
        if (
          !/^(transfer-encoding|connection|content-length|keep-alive)$/i.test(
            name,
          )
        ) responseHeaders.push({ name, value });
      });
      let bin = '';
      for (let i = 0; i < answer.bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...answer.bytes.subarray(i, i + 0x8000));
      }
      await page.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: answer.status,
        responseHeaders,
        body: btoa(bin),
      });
    })().catch(() => {});
  });
}

Deno.test({
  ...OPTS,
  name: 'computer page in a browser: loader -> /pc.html, the real page draws, no page credential, own layout, limited Settings',
  ignore: !browserPath,
  async fn() {
    const s = await remoteOn();
    const browser = await Browser.launch();
    try {
      s.chats.push({
        id: 'c1',
        provider: 'claude',
        sessionId: 's1',
        cwd: s.project,
        busy: false,
        closed: false,
        attention: {
          state: 'idle',
          needs: 0,
          turnEndedAt: null,
          busySince: null,
        },
        subagents: {},
        events: [{
          seq: 1,
          kind: 'user',
          time: Date.now() / 1000 - 60,
          data: { text: 'Fix the menu' },
        }],
        permissions: [],
        elicitations: [],
      });
      s.chats.push({
        id: 'c2',
        provider: 'claude',
        sessionId: 's2',
        cwd: s.project,
        busy: false,
        closed: false,
        attention: { state: 'idle', needs: 0, turnEndedAt: null, busySince: null },
        subagents: {},
        events: [{ seq: 1, kind: 'user', time: Date.now() / 1000 - 30, data: { text: 'Second chat here' } }],
        permissions: [],
        elicitations: [],
      });
      // a saved chat with a picture (its address is /api/transcript/image?key=..., the one API address the page keys pictures for)
      const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
      const shotStamp = new Date(Date.now() - 3600_000).toISOString();
      writeSavedChat(s.claudeDir, s.project, {
        sessionId: 'pictured-1',
        rows: [
          {
            type: 'user',
            sessionId: 'pictured-1',
            cwd: s.project,
            timestamp: shotStamp,
            message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] },
          },
        ],
      });
      const computer = await pairPhone(s, 'Laptop (Edge)', undefined, 'computer');
      Deno.writeTextFileSync(`${s.project}/notes.txt`, 'Menu fix notes');
      await s.ctx.viewPrefs.update({
        set: { 'studio-layout-v1:<1400': '{"side":240,"activity":300}' },
      });
      const deskBefore = JSON.stringify(s.ctx.viewPrefs.public().prefs);
      const seen = {
        credential: [] as string[],
        limited: [] as string[],
        refused: [] as string[],
        requests: 0,
        bridged: [] as number[],
      };
      const page = await browser.open('about:blank', 1280, 860);
      await serveAll(page, s, seen);
      // not paired yet: the loader opens the pairing page, which says "computer" in a computer's browser
      await page.goto(`https://${NAME}/`);
      await page.waitFor(
        'location.pathname === "/phone.html" && !!document.getElementById("pairGo")',
        15000,
        'the pairing page',
      );
      assertEquals(
        await page.eval('document.getElementById("pairGo").textContent'),
        'Pair this computer',
      );
      assert(
        String(await page.eval('document.getElementById("pairName").value'))
          .startsWith('Laptop'),
        'a computer name',
      );
      await page.shot('pc-pair');
      // the device record where phones keep it (what pairing leaves behind)
      await page.goto(`https://${NAME}/remote.css`); // any page of this origin that runs nothing
      await page.eval(`new Promise((resolve, reject) => {
        const req = indexedDB.open('aib-phone', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => {
          const tx = req.result.transaction('kv', 'readwrite');
          tx.objectStore('kv').put({ token: ${JSON.stringify(computer.token)}, device: { id: ${JSON.stringify(computer.id)} } }, 'device');
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      })`);
      seen.requests = 0;
      seen.bridged.length = 0;
      await page.goto(`https://${NAME}/`);
      await page.waitFor(
        'location.pathname === "/pc.html"',
        15000,
        'the loader opens the computer page',
      );
      await page.waitFor(
        '!!document.querySelector("#connections [data-key]")',
        20000,
        'the chat list',
      );
      await page.waitFor(
        'document.getElementById("appVersion") && document.getElementById("appVersion").textContent.length > 0',
        10000,
        'version',
      );
      assertEquals(
        await page.eval('document.documentElement.dataset.remote'),
        'pc',
      );
      await page.shot('pc-page');
      assertEquals(seen.credential, [], 'no page credential on any request');
      // open the chat too (its state, events, files, artifacts), then look at the busiest second of the first load
      await page.eval(
        `document.querySelector('#connections [data-key]').click()`,
      );
      await page.waitFor(
        `document.getElementById('messages').textContent.includes('Fix the menu')`,
        10000,
        'the chat opens',
      );
      await new Promise((r) => setTimeout(r, 2000));
      const t = seen.bridged;
      let busiest = 0;
      for (let i = 0; i < t.length; i++) {
        busiest = Math.max(
          busiest,
          t.filter((x) => x >= t[i] && x < t[i] + 1000).length,
        );
      }
      console.log(
        `first load: ${seen.requests} API requests, ${t.length} bridged, busiest second ${busiest}`,
      );
      assertEquals(
        seen.limited,
        [],
        `no request rate limited on the first load (${seen.requests} API requests)`,
      );
      // (the fake agent host has no ownership or update service: those answer 400; the service worker cannot be fetched through
      // this test's interception)
      const errors = page.errors.filter((e) => !/Failed to load resource|fetching the script/.test(e));
      assertEquals(errors, [], 'no page errors');
      assertEquals(await page.violations(), [], 'no CSP violations');

      // the laptop's own layout: resizing the Activity column saves to this computer's prefs, never the PC's
      await page.eval(
        `document.getElementById('rs-activity') && document.getElementById('rs-activity').focus()`,
      );
      assert(
        await page.eval(`!!document.getElementById('rs-activity')`),
        'the Activity handle',
      );
      for (let i = 0; i < 4; i++) {
        await page.eval(
          `document.getElementById('rs-activity').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))`,
        );
      }
      await page.waitFor(
        `(() => { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('studio-layout-v1:')) return true; } return false; })()`,
        5000,
        'a layout key',
      );
      let mine: Record<string, string> = {};
      for (let i = 0; i < 40; i++) {
        mine = (await get(s, '/api/remote/pc/view-prefs', computer.token)).json
          .prefs as Record<string, string>;
        if (Object.keys(mine).some((k) => k.startsWith('studio-layout-v1:'))) {
          break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      assert(
        Object.keys(mine).some((k) => k.startsWith('studio-layout-v1:')),
        `the laptop's layout saved: ${JSON.stringify(mine)}`,
      );
      assertEquals(
        JSON.stringify(s.ctx.viewPrefs.public().prefs),
        deskBefore,
        "the PC's panel widths are untouched",
      );

      // Settings: Appearance and This computer; the PC's sections say where they are changed
      await page.click('#openSettings');
      await page.waitFor(
        '!!document.querySelector(".st-page .st-section")',
        8000,
        'Settings',
      );
      const sections = await page.eval<string[]>(
        `[...document.querySelectorAll('.st-section')].map((b) => b.textContent)`,
      );
      assert(
        sections.includes('This computer') && sections.includes('Appearance'),
        sections.join(', '),
      );
      assert(!sections.includes('AIB Linking (WSL)'), 'no WSL linking');
      assertEquals(
        await page.eval('document.querySelector(".st-head h2").textContent'),
        'Appearance on this computer',
      );
      await page.eval(
        `[...document.querySelectorAll('.st-section')].find((b) => b.textContent === 'AIB Linking').click()`,
      );
      await page.waitFor(
        `document.querySelector('.st-content').textContent.includes('Change this on ')`,
        5000,
        'the PC says',
      );
      await page.eval(
        `[...document.querySelectorAll('.st-section')].find((b) => b.textContent === 'This computer').click()`,
      );
      await page.waitFor(
        `document.querySelector('.st-content').textContent.includes('Lost a computer?')`,
        5000,
        'help lines',
      );
      const text = await page.eval<string>(
        `document.querySelector('.st-content').textContent`,
      );
      assert(
        text.includes(
          'Lost a computer? Remove it, then sign the agents out and in again.',
        ),
        text,
      );
      assert(
        text.includes('Use a browser profile without extensions for AIB.'),
        text,
      );
      await page.shot('pc-settings-this-computer');

      await page.key('Escape');
      // Files: see and download. A file opens read only, with Download instead of "Open in <editor>" (the PC's programs)
      await page.click('.sf-mode-files');
      await page.waitFor(
        `[...document.querySelectorAll('.fx-row')].some((r) => r.textContent.includes('notes.txt'))`,
        10000,
        'the file tree',
      );
      await page.eval(
        `[...document.querySelectorAll('.fx-row')].find((r) => r.textContent.includes('notes.txt')).click()`,
      );
      await page.waitFor(
        `[...document.querySelectorAll('button')].some((b) => b.textContent === 'Download')`,
        10000,
        'Download',
      );
      assert(
        !(await page.eval<boolean>(
          `[...document.querySelectorAll('button')].some((b) => /^Open in /.test(b.textContent))`,
        )),
        'no Open in editor',
      );
      assert(
        await page.eval<boolean>(
          `document.body.textContent.includes('Menu fix notes')`,
        ),
        'the file is shown',
      );
      await page.click('.sf-mode-chats');

      // Browse… (the PC's system folder picker) is not on a computer
      assertEquals(
        await page.eval(
          `(() => { const b = document.createElement('button'); b.className = 'np-browse'; document.body.append(b);
          const d = getComputedStyle(b).display; b.remove(); return d; })()`,
        ),
        'none',
      );
      // a saved chat's picture (/api/transcript/image) is fetched with the device key and shown from memory; any other API address
      // in an <img> (agent-written content can put one there) is never fetched with the key (security review SF7)
      const sessions = await get(s, '/api/sessions', computer.token);
      assertEquals(sessions.status, 200, sessions.text);
      const shotKey = String(
        (sessions.json.sessions as Json[]).map((x) => x.key).find((k) => String(k).endsWith('pictured-1.jsonl')),
      );
      const shown = await get(s, `/api/transcript?key=${encodeURIComponent(shotKey)}`, computer.token);
      assertEquals(shown.status, 200, shown.text);
      const im = (JSON.stringify(shown.json).match(/"images":\[\{"n":(\d+),"i":(\d+)/) ?? []).slice(1);
      assertEquals(im.length, 2, 'the saved chat has a picture');
      const shotSrc = `/api/transcript/image?key=${encodeURIComponent(shotKey)}&n=${im[0]}&i=${im[1]}`;
      await page.eval(
        `(() => { const i = document.createElement('img'); i.id = 'keyedImg'; i.src = ${JSON.stringify(shotSrc)}; document.body.append(i);
          const o = document.createElement('img'); o.id = 'otherImg'; o.src = '/api/live/read-state'; document.body.append(o); })()`,
      );
      await page.waitFor(`document.getElementById('keyedImg').src.startsWith('blob:')`, 5000, 'the keyed picture');
      assertEquals(
        await page.eval(`[document.getElementById('otherImg').getAttribute('src'), document.getElementById('otherImg').dataset.remoteSrc ?? null]`),
        ['/api/live/read-state', null],
        'another API address is not fetched with the key',
      );
      // that keyless picture request is refused (no device key), as it should be: not a request the page itself makes
      await page.waitFor(`document.getElementById('otherImg').complete`, 5000, 'the keyless picture answered');
      await page.eval(`document.getElementById('otherImg').remove()`);
      seen.refused = seen.refused.filter((r) => !r.includes(' GET /api/live/read-state '));
      // a computer's notification click opens /pc.html#chat=<live id> (the service worker, from the push): that chat opens
      await page.goto(`https://${NAME}/remote.css`);
      await page.send('Page.navigate', { url: `https://${NAME}/pc.html#chat=c2` });
      await page.waitFor(
        `document.getElementById('messages') && document.getElementById('messages').textContent.includes('Second chat here')`,
        15000,
        'the pushed chat opens',
      );
      assertEquals(seen.credential, [], 'still no page credential');
      assertEquals(
        seen.refused,
        [],
        'the page never asks for what a computer may not do (no 401 / 403)',
      );
      assertEquals(seen.limited, [], 'still nothing rate limited');
    } finally {
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});

/**
 * Phone UI v2 part 2 in a headless Chrome (no window) at 375 px, where this test plays Tailscale Serve (DevTools Fetch interception
 * with forged Serve headers), against an in-process AIB with a fake agent host:
 *  - home: ⋯ "This phone" menu; the card menu from ⋯ and from a long press (right-click); Rename, Mark as unread, Archive of a
 *    running chat (Keep running / End its session; End hidden without Send), Delete with its confirmation, Undo;
 *  - Theme: Follow PC (the PC's theme in the phone's light or dark, pairs and fallback), a pick on this phone wins (localStorage);
 *  - Install AIB: our button from a (faked) beforeinstallprompt in the menu and on Finish setup, prompt() called, hidden after
 *    accepted / appinstalled; the iPhone's Share steps; Firefox's menu steps; nothing on the chat list;
 *  - New chat: project -> agent (one that cannot start is greyed with its reason) -> model -> mode -> first message -> Start chat;
 *    the chat opens and the message reaches the agent; a mode that could not be set holds it (error shown, text kept in the box);
 *    without Start new chats the button is gone and a line says where to turn it on;
 *  - a chat's Artifacts page (▤ with a count; the empty page) and the viewer's version menu (v3 ▾, an older one, "v3 is available ·
 *    Switch");
 *  - no sideways scroll on every new screen.
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { LOGIN, NAME, pairPhone, pc, type Raw, raw, type RemoteStudio } from './_remote_fixture.ts';
import { NewChats, setAgentRows } from '../../outputs/agent-studio/server/remote/newchat.ts';
import { liveChat, v2Studio } from './_remote_v2b.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const enc = (t: string) => new TextEncoder().encode(t);
const NO_SIDEWAYS =
  `(() => { const d = document.documentElement; return d.scrollWidth <= d.clientWidth && document.body.scrollWidth <= d.clientWidth; })()`;
const WIDTHS = `(() => { const d = document.documentElement; return [d.scrollWidth, d.clientWidth]; })()`;

/** This test is Tailscale Serve: every request to https://<name>/ goes to the phone port with the headers Serve adds. `drop`: a
 * request it says yes to reaches AIB, but its answer is lost on the way back (the phone sees no answer: the network dropped). */
async function serveFor(page: Page, s: RemoteStudio, drop: (method: string, path: string) => boolean = () => false): Promise<void> {
  await page.send('Network.enable');
  await page.send('Fetch.enable', { patterns: [{ urlPattern: `https://${NAME}/*`, requestStage: 'Request' }] });
  page.listeners.set('Fetch.requestPaused', (p) => {
    void (async () => {
      const request = p.request as Json;
      const url = new URL(request.url as string);
      const method = request.method as string;
      const kind = p.resourceType as string;
      const headers: Record<string, string> = { Host: NAME, 'Tailscale-User-Login': LOGIN, 'X-Forwarded-For': '100.64.0.7' };
      for (const [k, v] of Object.entries(request.headers as Record<string, string>)) {
        if (/^(content-type|x-aib-device|accept|origin)$/i.test(k)) headers[k] = v;
      }
      if (method === 'POST' && !Object.keys(headers).some((k) => k.toLowerCase() === 'origin')) headers.Origin = `https://${NAME}`;
      if (kind === 'Document') {
        Object.assign(headers, { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' });
      } else if (kind === 'Fetch' || kind === 'XHR') {
        Object.assign(headers, { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' });
      } else Object.assign(headers, { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': kind.toLowerCase() });
      const jar = await page.send('Network.getCookies', { urls: [url.href] });
      const cookies = (jar.cookies as Json[]).map((c) => `${c.name}=${c.value}`).join('; ');
      if (cookies) headers.Cookie = cookies;
      let answer: Raw | null = null;
      try {
        answer = await raw(s.phonePort(), method, url.pathname + url.search, headers, request.postData as string | undefined);
      } catch { /* Serve answers 502 */ }
      if (answer && drop(method, url.pathname)) {
        await page.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionReset' });
        return;
      }
      if (!answer) {
        await page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 502, responseHeaders: [], body: '' });
        return;
      }
      const responseHeaders: Json[] = [];
      answer.headers.forEach((value, name) => {
        if (!/^(transfer-encoding|connection|content-length|keep-alive)$/i.test(name)) responseHeaders.push({ name, value });
      });
      let bin = '';
      for (let i = 0; i < answer.bytes.length; i += 0x8000) bin += String.fromCharCode(...answer.bytes.subarray(i, i + 0x8000));
      await page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: answer.status, responseHeaders, body: btoa(bin) });
    })().catch(() => {});
  });
}

async function phonePage(
  browser: Browser,
  s: RemoteStudio,
  phone: { token: string; id: string },
  ua?: string,
  drop?: (method: string, path: string) => boolean,
): Promise<Page> {
  const page = await browser.open('about:blank', 375, 812);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  if (ua) await page.send('Emulation.setUserAgentOverride', { userAgent: ua });
  await serveFor(page, s, drop);
  await page.goto(`https://${NAME}/phone.html`);
  await page.waitFor('!!document.getElementById("app").dataset.screen', 15000, 'the phone page');
  await page.eval(`new Promise((resolve, reject) => {
    const req = indexedDB.open('aib-phone', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => {
      const tx = req.result.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ token: ${JSON.stringify(phone.token)}, device: { id: ${JSON.stringify(phone.id)} } }, 'device');
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  })`);
  await page.goto(`https://${NAME}/phone.html`);
  await page.waitFor('document.getElementById("app").dataset.screen === "home" && !!document.querySelector(".ph-card")', 15000, 'home');
  return page;
}

/** A tap on an element of the chat list by script (a poll can move cards between finding one and a mouse click). */
async function tap(page: Page, selector: string): Promise<void> {
  try {
    await page.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, 8000, selector);
  } catch (error) {
    throw new Error(`${error}: the page shows ${await page.eval('document.getElementById("app").innerText.slice(0, 600)')}`);
  }
  await page.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
}

/** A real tap (a mouse click at the element's centre, so what is on top there gets it) once the element is there. */
async function press(page: Page, selector: string): Promise<void> {
  try {
    await page.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, 8000, selector);
  } catch (error) {
    throw new Error(`${error}: the page shows ${await page.eval('document.getElementById("app").innerText.slice(0, 600)')}`);
  }
  await page.click(selector);
}

async function noSideways(page: Page, where: string): Promise<void> {
  assert(await page.eval(NO_SIDEWAYS), `${where}: sideways scroll ${await page.eval(WIDTHS)}`);
}

/** A fake install prompt (Chrome's BeforeInstallPromptEvent): prompt() counted, userChoice resolves with `outcome`. */
const FAKE_PROMPT = (outcome: string) =>
  `(() => {
  window.__prompted = 0;
  const e = new Event('beforeinstallprompt', { cancelable: true });
  e.prompt = () => { window.__prompted++; return Promise.resolve(); };
  e.userChoice = Promise.resolve({ outcome: ${JSON.stringify(outcome)}, platform: 'web' });
  window.dispatchEvent(e);
  return e.defaultPrevented;
})()`;

Deno.test({
  ...OPTS,
  name:
    'phone page at 375 px: card menu (⋯ and long press): rename, mark unread, archive keep / end, delete with confirmation, Undo; Theme; Install AIB; no sideways scroll',
  ignore: !browserPath,
  async fn() {
    const s = await v2Studio();
    const browser = await Browser.launch();
    try {
      s.chats.push(liveChat('c1', s.project, { attention: { state: 'idle', needs: 0, turnEndedAt: null, busySince: null } }));
      s.chats.push(
        liveChat('c2', s.project, { events: [{ seq: 1, kind: 'user', time: Date.now() / 1000 - 30, data: { text: 'Second chat' } }] }),
      );
      s.chats.push(liveChat('c3', s.project, { attention: { state: 'opening', needs: 0, turnEndedAt: null, busySince: null } }));
      await s.ctx.viewPrefs.update({ set: { 'aib-theme': 'dracula' } });
      const phone = await pairPhone(s);
      const page = await phonePage(browser, s, phone);
      await noSideways(page, 'home');
      assert(await page.eval('!!document.getElementById("phNewChat")'), '+ New chat');
      assert(await page.eval(`document.querySelector('[data-menu-for="l:c3"]').disabled`), 'a chat still opening has no menu');
      assert(
        !(await page.eval<boolean>('document.querySelector(".ph-home").textContent.includes("Install")')),
        'no install banner on the list',
      );

      // the card menu from ⋯ (real taps from here on: what is on top at the tap's spot gets it)
      await press(page, '[data-menu-for="l:c1"]');
      await page.waitFor('!!document.getElementById("phMenu")', 5000, 'the card menu');
      assertEquals(await page.eval('[...document.querySelectorAll("#phMenu .ph-mi")].map((b) => b.dataset.mi)'), [
        'arts',
        'unread',
        'rename',
        'archive',
        'delete',
        'cancel',
      ]);
      await noSideways(page, 'card menu');
      // Rename, typed: select what is there, delete it, type the new name, Enter
      await page.click('#phMenu [data-mi="rename"]');
      await page.waitFor('!!document.getElementById("phRename")', 5000, 'rename box');
      await page.click('#phRename');
      await page.key('a', 2);
      await page.key('Backspace');
      await page.type('Checkout redesign');
      assertEquals(await page.eval('document.getElementById("phRename").value'), 'Checkout redesign');
      await page.key('Enter');
      await page.waitFor('!document.getElementById("phMenu")', 5000, 'menu closed');
      await page.waitFor(
        '[...document.querySelectorAll(".ph-title")].some((t) => t.textContent === "Checkout redesign")',
        15000,
        'renamed card',
      );
      assertEquals(s.ctx.viewPrefs.chatNames()['claude:sess-c1'], 'Checkout redesign');

      // a long press (right-click on a PC browser) opens the same menu; Mark as unread
      await page.eval(
        'document.querySelector(\'[data-menu-key="l:c1"]\').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))',
      );
      await page.waitFor('!!document.getElementById("phMenu")', 5000, 'menu by long press');
      await page.click('#phMenu [data-mi="unread"]');
      await page.waitFor('!document.getElementById("phMenu")', 5000, 'closed');
      assert(s.ctx.readState.public().chats['claude:sess-c1']?.markedUnreadAt! > 0, 'marked unread on the PC');
      await page.waitFor('!!document.querySelector(\'[data-chat="c1"] .ph-unread\')', 15000, 'the unread dot');

      // Archive a running chat: Keep running / End its session; Keep running, then Undo
      await press(page, '[data-menu-for="l:c1"]');
      await page.click('#phMenu [data-mi="archive"]');
      await page.waitFor('!!document.querySelector(\'#phMenu [data-how="end"]\')', 5000, 'the two choices');
      await noSideways(page, 'archive choices');
      await page.click('#phMenu [data-how="keep"]');
      await page.waitFor('!document.querySelector(\'[data-chat="c1"]\') && !!document.getElementById("phUndo")', 15000, 'archived, Undo');
      assert(!s.chats[0].closed, 'kept running');
      await page.click('#phUndo');
      await page.waitFor('!!document.querySelector(\'[data-chat="c1"]\')', 15000, 'back after Undo');

      // Send off: no "End its session", and Delete of a running chat says it needs Send
      await pc(s, 'POST', '/api/live/devices/scopes', { id: phone.id, scopes: ['phone.read'] });
      await page.waitFor('!!document.getElementById("phStartOff")', 15000, 'Start off line');
      assert(
        String(await page.eval('document.getElementById("phStartOff").textContent')).includes(
          'Settings → Remote control → this phone → Start new chats',
        ),
      );
      assert(!(await page.eval('!!document.getElementById("phNewChat")')), 'no + New chat');
      await press(page, '[data-menu-for="l:c1"]');
      await page.click('#phMenu [data-mi="archive"]');
      await page.waitFor('!!document.querySelector(\'#phMenu [data-how="keep"]\')', 5000, 'keep only');
      assert(!(await page.eval('!!document.querySelector(\'#phMenu [data-how="end"]\')')), 'no End without Send');
      await page.eval('document.querySelector("#phMenu .ph-shade").click()');
      await press(page, '[data-menu-for="l:c1"]');
      await page.click('#phMenu [data-mi="delete"]');
      await page.waitFor('!!document.getElementById("phDeleteText")', 5000, 'delete text');
      assert(!(await page.eval('!!document.getElementById("phDeleteGo")')), 'refused until it stops');
      await page.eval('document.querySelector("#phMenu .ph-shade").click()');

      // Send on: Delete says what happens, ends the session, Undo restores it
      await pc(s, 'POST', '/api/live/devices/scopes', {
        id: phone.id,
        scopes: ['phone.read', 'phone.answer', 'phone.prompt', 'phone.start', 'phone.approve', 'phone.push'],
      });
      await page.waitFor('!!document.getElementById("phNewChat")', 15000, 'Start back');
      await press(page, '[data-menu-for="l:c2"]');
      await page.click('#phMenu [data-mi="delete"]');
      await page.waitFor('!!document.getElementById("phDeleteGo")', 5000, 'Delete');
      const text = String(await page.eval('document.getElementById("phDeleteText").textContent'));
      assert(text.includes('Recently deleted') && text.includes('ends its session first'), text);
      await noSideways(page, 'delete confirmation');
      await page.click('#phDeleteGo');
      await page.waitFor('!!document.getElementById("phUndo")', 15000, 'deleted, Undo');
      assert(s.chats[1].closed, 'session ended');
      await page.click('#phUndo');
      const restoreBy = Date.now() + 10000;
      const deleted = () => !!(s.ctx.conversations.public().entries as unknown as Record<string, Json>)['claude:sess-c2']?.deletedAt;
      while (deleted() && Date.now() < restoreBy) await new Promise((r) => setTimeout(r, 100));
      assert(!deleted(), 'Undo restored it');

      // Theme: Follow PC (Dracula, the phone dark) -> Dracula; the phone light -> AIB teal light (Dracula is dark only)
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
      await page.waitFor('document.documentElement.dataset.theme === "dracula"', 5000, 'dracula');
      assertEquals(await page.eval('document.documentElement.dataset.theme'), 'dracula');
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
      await page.waitFor('document.documentElement.dataset.theme === "teal-light"', 5000, 'teal light');
      await page.click('#phPhoneMenu');
      await page.click('#phMenu [data-mi="theme"]');
      await page.waitFor('!!document.querySelector(\'#phMenu [data-pick="nord"]\')', 5000, 'theme list');
      assertEquals(await page.eval('document.querySelector(\'#phMenu [aria-checked="true"]\').dataset.pick'), 'follow');
      await noSideways(page, 'theme list');
      await page.click('#phMenu [data-pick="nord"]');
      await page.waitFor('document.documentElement.dataset.theme === "nord"', 5000, 'nord');
      assertEquals(await page.eval('localStorage.getItem("aib-phone-theme")'), 'nord');
      // the PC changes theme: a phone that follows the PC shows it on the next poll
      await page.eval('localStorage.removeItem("aib-phone-theme")');
      await s.ctx.viewPrefs.update({ set: { 'aib-theme': 'hc-dark' } });
      await page.waitFor('document.documentElement.dataset.theme === "hc-light"', 15000, 'high contrast pair in light');

      // Install AIB: no item without the event? (Chrome headless: the menu still explains); with it: our button calls prompt()
      assert(await page.eval(FAKE_PROMPT('dismissed')), 'the browser’s own bar is held back');
      await page.click('#phPhoneMenu');
      await page.waitFor('!!document.querySelector(\'#phMenu [data-mi="install"]\')', 5000, 'Install AIB item');
      await page.click('#phMenu [data-mi="install"]');
      await page.waitFor('window.__prompted === 1', 5000, 'prompt() called');
      await page.click('#phPhoneMenu');
      await page.waitFor('!!document.querySelector(\'#phMenu [data-mi="install"]\')', 5000, 'dismissed: the item stays');
      await page.eval('document.querySelector("#phMenu .ph-shade").click()');
      await page.eval(FAKE_PROMPT('accepted'));
      await page.click('#phPhoneMenu');
      await page.click('#phMenu [data-mi="install"]');
      await page.waitFor('window.__prompted === 1 && !document.getElementById("phMenu")', 5000, 'accepted');
      await page.click('#phPhoneMenu');
      await page.waitFor('!!document.getElementById("phMenu")', 5000, 'menu');
      assert(!(await page.eval('!!document.querySelector(\'#phMenu [data-mi="install"]\')')), 'hidden after accepted');
      await page.eval('document.querySelector("#phMenu .ph-shade").click()');
      // Finish setup: an Install AIB step with our button while the browser offers it; appinstalled hides it
      await page.eval('window.__aibPhone.install.installed = false');
      await page.eval(FAKE_PROMPT('accepted'));
      await page.eval('document.getElementById("setupOpen") ? document.getElementById("setupOpen").click() : null');
      if (await page.eval('document.getElementById("app").dataset.screen === "setup"')) {
        await page.waitFor('!!document.getElementById("installAib")', 5000, 'Install AIB on Finish setup');
        await noSideways(page, 'finish setup');
        await page.eval('window.dispatchEvent(new Event("appinstalled"))');
        await page.waitFor(
          '!document.getElementById("installAib") && document.querySelector(\'[data-step="install"]\').dataset.state === "done"',
          5000,
          'installed',
        );
      }
    } finally {
      setAgentRows(null);
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'phone page at 375 px: Install AIB on an iPhone is the Share steps, on Firefox its menu steps; standalone hides it',
  ignore: !browserPath,
  async fn() {
    const s = await v2Studio();
    const browser = await Browser.launch();
    try {
      s.chats.push(liveChat('c1', s.project));
      const phone = await pairPhone(s);
      const firefox = await phonePage(browser, s, phone, 'Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0');
      await firefox.click('#phPhoneMenu');
      await firefox.click('#phMenu [data-mi="install"]');
      await firefox.waitFor('!!document.getElementById("phInstallText")', 5000, 'Firefox steps');
      assert(String(await firefox.eval('document.getElementById("phInstallText").textContent')).includes('Add app to Home screen'));
      await noSideways(firefox, 'install steps');
      const iphone = await phonePage(
        browser,
        s,
        phone,
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
      );
      await iphone.click('#phPhoneMenu');
      await iphone.click('#phMenu [data-mi="install"]');
      await iphone.waitFor('!!document.getElementById("phInstallText")', 5000, 'iPhone steps');
      assert(String(await iphone.eval('document.getElementById("phInstallText").textContent')).includes('Add to Home Screen'));
      // running installed (display-mode: standalone): no Install AIB
      await iphone.eval('document.querySelector("#phMenu .ph-shade").click()');
      await iphone.eval('Object.defineProperty(navigator, "standalone", { value: true, configurable: true })');
      await iphone.click('#phPhoneMenu');
      await iphone.waitFor('!!document.getElementById("phMenu")', 5000, 'menu');
      assert(!(await iphone.eval('!!document.querySelector(\'#phMenu [data-mi="install"]\')')), 'standalone: hidden');
    } finally {
      setAgentRows(null);
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    'phone page at 375 px: New chat (greyed agent with reason, model, mode, first message), the message reaches the agent; a mode that fails holds it; Artifacts page and the version menu',
  ignore: !browserPath,
  async fn() {
    const s = await v2Studio();
    const browser = await Browser.launch();
    try {
      s.chats.push(liveChat('c1', s.project));
      const store = s.ctx.artifacts.store;
      const a = store.create('claude:sess-c1', 'Checkout flow preview', 'pdf', 'flow.pdf', enc('%PDF-1.4 v1'));
      store.addVersion(a.id, enc('%PDF-1.4 v2'));
      store.addVersion(a.id, enc('%PDF-1.4 v3'));
      const phone = await pairPhone(s);
      const page = await phonePage(browser, s, phone);

      await tap(page, '#phNewChat');
      await page.waitFor(
        'document.getElementById("app").dataset.screen === "new" && !!document.querySelector(".ph-pick[data-project]")',
        15000,
        'projects',
      );
      await noSideways(page, 'new chat: projects');
      await tap(page, `.ph-pick[data-project="${s.projectId}"]`);
      await page.waitFor(
        '!!document.querySelector(\'.ph-pick[data-agent="kimi"]\') && !!document.querySelector(".ph-pill[data-mode]")',
        15000,
        'agents and lists',
      );
      assert(await page.eval('document.querySelector(\'.ph-pick[data-agent="kimi"]\').disabled'), 'greyed');
      assert(String(await page.eval('document.querySelector(\'.ph-pick[data-agent="kimi"]\').textContent')).includes('Needs sign-in'));
      assertEquals(await page.eval('document.querySelector(".ph-pick[aria-pressed=true]").dataset.agent'), 'omp', 'the default agent');
      await page.click('.ph-pick[data-agent="claude"]');
      await page.waitFor('!!document.querySelector(\'.ph-pill[data-mode="bypassPermissions"]\')', 15000, 'modes');
      await page.click('.ph-pill[data-model="opus"]');
      await page.click('.ph-pill[data-mode="bypassPermissions"]');
      assertEquals(await page.eval('[...document.querySelectorAll(".ph-pill[data-mode]")].map((b) => b.textContent)'), [
        'Ask before editsdefault',
        'Bypass permissions',
      ]);
      assert(!(await page.eval<boolean>('document.body.textContent.toLowerCase().includes("warning")')), 'no warning on any mode');
      await noSideways(page, 'new chat: agent, model, mode');
      await page.eval(
        '(() => { const t = document.getElementById("phNewPrompt"); t.value = "Write the release notes"; t.dispatchEvent(new Event("input")); })()',
      );
      await page.click('#phNewStart');
      await page.waitFor(
        'document.getElementById("app").dataset.screen === "chat" && !!document.getElementById("phNewNote")',
        15000,
        'the new chat',
      );
      assert(
        String(await page.eval('document.getElementById("phNewNote").textContent')).includes('Claude Code · Opus · Bypass permissions'),
      );
      const deadline = Date.now() + 10000;
      while (!s.liveCalls.some(([n, b]) => n === 'prompt' && b.text === 'Write the release notes') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert(s.liveCalls.some(([n, b]) => n === 'prompt' && b.text === 'Write the release notes'), 'the first message reached the agent');
      assertEquals(s.liveCalls.find(([n]) => n === 'connect')![1].picks, { model: 'opus', mode: 'bypassPermissions' });
      await noSideways(page, 'the new chat');

      // a mode that cannot be set: the message is held, the error shows, the text waits in the box
      s.pick.results = [{ kind: 'mode', value: 'bypassPermissions', ok: false, message: 'Not here' }];
      await page.click('#phBack');
      await tap(page, '#phNewChat');
      await tap(page, `.ph-pick[data-project="${s.projectId}"]`);
      await page.waitFor('!!document.querySelector(\'.ph-pill[data-mode="bypassPermissions"]\')', 15000, 'modes');
      await page.click('.ph-pill[data-mode="bypassPermissions"]');
      await page.eval(
        '(() => { const t = document.getElementById("phNewPrompt"); t.value = "Held message"; t.dispatchEvent(new Event("input")); })()',
      );
      await page.click('#phNewStart');
      await page.waitFor(
        'document.getElementById("phPrompt") && document.getElementById("phPrompt").value === "Held message" && document.getElementById("phActError").textContent.includes("mode could not be set")',
        20000,
        'held',
      );
      assert(!s.liveCalls.some(([n, b]) => n === 'prompt' && b.text === 'Held message'));
      await page.click('#phSend');
      const until2 = Date.now() + 10000;
      while (!s.liveCalls.some(([n, b]) => n === 'prompt' && b.text === 'Held message') && Date.now() < until2) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert(s.liveCalls.some(([n, b]) => n === 'prompt' && b.text === 'Held message'), 'sent from the box');

      // Artifacts: ▤ with its count in c1, the page, the viewer's version menu
      await page.click('#phBack');
      await tap(page, '.ph-card[data-chat="c1"]');
      await page.waitFor(
        '!!document.querySelector("#phArtsBtn .ph-cnt") && document.querySelector("#phArtsBtn .ph-cnt").textContent === "1"',
        15000,
        '▤ 1',
      );
      await page.click('#phArtsBtn');
      await page.waitFor(
        'document.getElementById("app").dataset.screen === "arts" && !!document.querySelector(".ph-art[data-artifact]")',
        15000,
        'the Artifacts page',
      );
      assert(String(await page.eval('document.querySelector(".ph-art").textContent')).includes('v3 · 3 versions'));
      await noSideways(page, 'artifacts page');
      await page.click('.ph-art[data-artifact]');
      await page.waitFor('!!document.getElementById("phVersions")', 15000, 'version chip');
      assertEquals(await page.eval('document.getElementById("phVersions").textContent'), 'v3 ▾');
      await page.click('#phVersions');
      await page.waitFor('!!document.getElementById("phVersionList")', 5000, 'versions');
      assertEquals(await page.eval('[...document.querySelectorAll("#phVersionList .ph-vopt")].map((o) => o.dataset.v)'), ['3', '2', '1']);
      assert(String(await page.eval('document.querySelector("#phVersionList .ph-vopt").textContent')).includes('latest'));
      await noSideways(page, 'version menu');
      await page.click('#phVersionList [data-v="1"]');
      await page.waitFor(
        '!!document.getElementById("phVersionOld") && document.getElementById("phVersions").textContent === "v1 ▾"',
        15000,
        'v1',
      );
      assert(String(await page.eval('document.getElementById("phVersionOld").textContent')).includes('v3 is available'));
      await page.click('#phVersionSwitch');
      await page.waitFor(
        '!document.getElementById("phVersionOld") && document.getElementById("phVersions").textContent === "v3 ▾"',
        15000,
        'switched',
      );
      await page.click('#viewerClose');
      await page.click('#phBack');
      await page.waitFor('document.getElementById("app").dataset.screen === "chat"', 15000, 'back to the chat');

      // a chat with no artifacts: the empty page, from the card menu
      await page.click('#phBack');
      await page.waitFor('document.getElementById("app").dataset.screen === "home"', 15000, 'home');
      const fresh = await page.eval<string>('document.querySelector(\'[data-menu-for^="l:new-"]\').dataset.menuFor');
      await tap(page, `[data-menu-for="${fresh}"]`);
      await page.click('#phMenu [data-mi="arts"]');
      await page.waitFor('!!document.getElementById("phArtsEmpty")', 15000, 'the empty page');
      assert(String(await page.eval('document.getElementById("phArtsEmpty").textContent')).includes('No artifacts yet'));
      await noSideways(page, 'empty artifacts page');
    } finally {
      setAgentRows(null);
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    'phone page at 375 px (review 1, 2): the network drops during Start: no second chat; AIB restarts while it opens: the message comes back in the box and goes once',
  ignore: !browserPath,
  async fn() {
    const s = await v2Studio();
    const browser = await Browser.launch();
    try {
      s.chats.push(liveChat('c1', s.project));
      const phone = await pairPhone(s);
      let dropStart = true;
      const page = await phonePage(browser, s, phone, undefined, (method, path) => {
        if (method !== 'POST' || path !== '/api/remote/new' || !dropStart) return false;
        dropStart = false;
        return true;
      });
      s.pick.ready = false; // the chat takes its time to open

      await press(page, '#phNewChat');
      await press(page, `.ph-pick[data-project="${s.projectId}"]`);
      await page.waitFor('!!document.querySelector(".ph-pill[data-mode]")', 15000, 'lists');
      await page.click('#phNewPrompt');
      await page.type('Write the changelog');
      await page.click('#phNewStart');
      // the answer was lost: the phone says the chat may have started; Start again opens that one, not a second
      await page.waitFor(
        '!!document.getElementById("phNewError") && document.getElementById("phNewError").textContent.includes("may have started")',
        15000,
        'may have started',
      );
      assertEquals(s.liveCalls.filter(([n]) => n === 'connect').length, 1, 'it did start');
      await page.click('#phNewStart');
      await page.waitFor('document.getElementById("app").dataset.screen === "chat"', 15000, 'the chat it started');
      assertEquals(s.liveCalls.filter(([n]) => n === 'connect').length, 1, 'no second chat');
      const id = String(await page.eval('window.__aibPhone.chatId'));
      assertEquals(id, s.chats.at(-1)!.id);
      const job = s.ctx.phone.server!.newChats.job(phone.id, id)!;
      assert(job, 'the server knows this start');
      const cmid = job.clientMessageId;

      // AIB restarts on the PC while the chat opens: the phone puts the message back in the box and says why
      s.ctx.phone.server!.newChats = new NewChats();
      await page.waitFor('window.__aibPhone.newJob && window.__aibPhone.newJob.state === "gone"', 20000, 'the start is forgotten');
      s.chats.find((c) => c.id === id)!.ready = true;
      await page.waitFor(
        '!!document.getElementById("phPrompt") && document.getElementById("phPrompt").value === "Write the changelog" && ' +
          'document.getElementById("phActError").textContent.includes("AIB restarted")',
        20000,
        'back in the box, with why',
      );
      await page.click('#phSend');
      const until = Date.now() + 10000;
      while (!s.liveCalls.some(([n, b]) => n === 'prompt' && b.id === id) && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const sent = s.liveCalls.filter(([n, b]) => n === 'prompt' && b.id === id);
      assertEquals(sent.length, 1, 'sent once, as a normal message');
      assertEquals(sent[0][1].clientMessageId, cmid, 'with the same id (a repeat would be dropped)');
      assertEquals(s.chats.find((c) => c.id === id)!.events.filter((e) => e.kind === 'user').length, 1);
      await noSideways(page, 'restarted new chat');
    } finally {
      setAgentRows(null);
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});

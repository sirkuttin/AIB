/** Helpers for the phone page tests at phone widths: this test plays Tailscale Serve (DevTools Fetch interception with forged Serve
 * headers) in front of the phone port, signs a paired phone in and opens the list. (Same as remote_phone_v2b_e2e_test.ts.) */
import { type Page, type Browser } from './_doc_browser.ts';
import { LOGIN, NAME, raw, type Raw, type RemoteStudio } from './_remote_fixture.ts';

type Json = Record<string, unknown>;

/** This test is Tailscale Serve: every request to https://<name>/ goes to the phone port with the headers Serve adds. */
export async function serveFor(page: Page, s: RemoteStudio): Promise<void> {
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

export async function phonePage(browser: Browser, s: RemoteStudio, phone: { token: string; id: string }, ua?: string, width = 375, cards = true): Promise<Page> {
  const page = await browser.open('about:blank', width, 812);
  await page.send('Emulation.setDeviceMetricsOverride', { width, height: 812, deviceScaleFactor: 2, mobile: true });
  if (ua) await page.send('Emulation.setUserAgentOverride', { userAgent: ua });
  await serveFor(page, s);
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
  await page.waitFor('document.getElementById("app").dataset.screen === "home" && (!!document.querySelector(".ph-card") || !'+cards+')', 15000, 'home');
  return page;
}

/** A tap on an element of the chat list by script (a poll can move cards between finding one and a mouse click). */
export async function tap(page: Page, selector: string): Promise<void> {
  try {
    await page.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, 8000, selector);
  } catch (error) {
    throw new Error(`${error}: the page shows ${await page.eval('document.getElementById("app").innerText.slice(0, 600)')}`);
  }
  await page.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
}


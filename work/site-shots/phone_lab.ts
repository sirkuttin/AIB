/** Phone page shots: a headless phone-sized browser (412x915, device scale 2.625, Android Chrome UA) playing Tailscale Serve in front of an
 *  in-process Studio with phone access on, a paired fake phone and fake live chats (the remote e2e tests' harness: work/deno/_remote_v2b.ts,
 *  _remote_phone_page.ts). No real Tailscale, nothing real runs. Run with TEMP=C:\aib-demo\tmp. */
import { Browser } from '../deno/_doc_browser.ts';
import { pairPhone } from '../deno/_remote_fixture.ts';
import { liveChat, v2Studio } from '../deno/_remote_v2b.ts';
import { serveFor, tap } from '../deno/_remote_phone_page.ts';
import { NAME } from '../deno/_remote_fixture.ts';
import { RAW, sleep } from './lib.ts';

const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const save = async (page: any, name: string) => {
  await sleep(600);
  const r = await page.send('Page.captureScreenshot', { format: 'png' });
  await Deno.mkdir(RAW, { recursive: true });
  Deno.writeFileSync(`${RAW}/${name}.png`, Uint8Array.from(atob(String(r.data)), (c) => c.charCodeAt(0)));
  console.log('shot', name);
};

const s = await v2Studio();
const browser = await Browser.launch();
try {
  const now = Date.now();
  const ev = (list: any[]) => list.map((e, i) => ({ seq: i + 1, kind: e.kind, time: (now - 600000) / 1000 + i * 20, data: e.data }));
  const say = (text: string) => ({ kind: 'update', data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
  const user = (text: string) => ({ kind: 'user', data: { text } });
  const tool = (id: string, title: string, status = 'completed') => ({ kind: 'update', data: { update: { sessionUpdate: 'tool_call', toolCallId: id, title, status } } });
  const title = (t: string) => ({ sessionInfo: { title: t } });
  const iso = (ago: number) => new Date(now - ago * 1000).toISOString();
  s.chats.push(
    liveChat('c1', s.project, {
      provider: 'claude', busy: true, breadth: title('Bump Stripe SDK to v18'),
      attention: { state: 'needs_you', needs: 1, turnEndedAt: null, busySince: iso(420) },
      events: ev([user('Bump the Stripe SDK to v18 and fix whatever breaks.'), say('Stripe v18 drops the 2023-10-16 API version we pin, so this is two steps: upgrade the package, then move the webhook handler to the new event types.'), tool('t1', 'Read package.json'), tool('t2', "Searched 'apiVersion' in the project")]),
      permissions: [{ key: 'perm1', params: { toolCall: { title: 'Run npm install stripe@18.0.0', rawInput: { command: 'npm install stripe@18.0.0' } }, options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'always', name: 'Always allow', kind: 'allow_always' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } }],
    }),
    liveChat('c2', s.project, {
      provider: 'codex', sessionId: 'sess-c2', busy: true, breadth: title('Add CSV export'),
      attention: { state: 'working', needs: 0, turnEndedAt: null, busySince: iso(240) },
      events: ev([user('Add CSV export to the orders page.'), say('I added an Export CSV button and a test for quoting. Running the orders tests now.'), tool('t3', 'Write src/orders/exportCsv.ts'), tool('t4', 'Run the orders tests', 'in_progress')]),
    }),
    liveChat('c3', s.project, {
      provider: 'omp', sessionId: 'sess-c3', breadth: title('Update product page copy'),
      attention: { state: 'idle', needs: 0, turnEndedAt: iso(180), busySince: null },
      events: ev([user('Rewrite the product page headline.'), say('Done. The headline now reads "A backpack that keeps up", and the shipping note links to the shipping page.')]),
    }),
    liveChat('c4', s.project, {
      provider: 'claude', sessionId: 'sess-c4', breadth: title('Migrate product images to WebP'),
      attention: { state: 'idle', needs: 0, turnEndedAt: iso(7200), busySince: null },
      events: ev([user('Migrate product images to WebP.'), say('All 48 product photos now have WebP versions and the pages use them.')]),
    }),
  );
  const phone = await pairPhone(s, 'Pixel 8');
  for (const scheme of ['dark', 'light'] as const) {
    const page = await browser.open('about:blank', 412, 915);
    try {
      await page.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true });
      await page.send('Emulation.setUserAgentOverride', { userAgent: UA });
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await serveFor(page, s);
      await page.goto(`https://${NAME}/phone.html`);
      await page.waitFor('!!document.getElementById("app").dataset.screen', 15000, 'the phone page');
      await page.eval(`new Promise((resolve, reject) => { const req = indexedDB.open('aib-phone', 1); req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => { const tx = req.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ token: ${JSON.stringify(phone.token)}, device: { id: ${JSON.stringify(phone.id)} } }, 'device'); tx.oncomplete = () => resolve(true); tx.onerror = () => reject(tx.error); }; req.onerror = () => reject(req.error); })`);
      await page.goto(`https://${NAME}/phone.html`);
      await page.waitFor('document.getElementById("app").dataset.screen === "home" && !!document.querySelector(".ph-card")', 15000, 'home');
      await sleep(1500);
      await save(page, `phone-cards-${scheme}`);
      // the approval: open the chat that needs you
      await page.eval(`[...document.querySelectorAll('.ph-card')].find(c => c.innerText.includes('Stripe')).click()`);
      await sleep(2500);
      await save(page, `phone-approval-${scheme}`);
      await page.eval(`history.back()`).catch(() => {});
      await page.goto(`https://${NAME}/phone.html`);
      await page.waitFor('document.getElementById("app").dataset.screen === "home" && !!document.querySelector(".ph-card")', 15000, 'home again');
      await sleep(800);
      await tap(page, '.ph-fab');
      await sleep(1500);
      const leaf = (t: string) => page.eval(`(() => { const r = document.querySelector('.ph-new'); const e = [...r.querySelectorAll('*')].find(e => e.children.length === 0 && (e.innerText||'').trim() === ${JSON.stringify(t)}); if (e) { (e.closest('button, [role=button], label, .ph-row, div') || e).click(); return true; } return false; })()`);
      await leaf('shop'); await sleep(1200);
      await leaf('Claude Code').catch(() => {}); await sleep(1500);
      await save(page, `phone-new-chat-${scheme}`);
    } finally { await page.close(); }
  }
} finally {
  await browser.close();
  await s.close();
}
Deno.exit(0);

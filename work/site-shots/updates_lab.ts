/** Update button and "What's new" tab shots. A fake GitHub release server (as work/deno/update_notes_e2e_test.ts) with readable notes;
 *  the demo Studio (work/demo-studio/start.py, port 8860) runs as 0.1.0-beta.8 (AIB_UPDATE_CURRENT), finds beta.9, shows the Update button;
 *  then restarts as beta.9 on the same data (--keep) and opens the notes tab. No real update, nothing installed. */
import { APP_VERSION } from '../../outputs/agent-studio/server/core/app.ts';
import { Browser, clickText, desk, shot, sleep, THEMES } from './lib.ts';

const PORT = 8860, DIR = 'C:/aib-demo', PY = 'python';
const START = new URL('../demo-studio/start.py', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const OLD = '0.1.0-beta.8', OLDER = '0.1.0-beta.7';
const hash = async (d: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', d as Uint8Array<ArrayBuffer>))].map((b) => b.toString(16).padStart(2, '0')).join('');

const payload = new TextEncoder().encode('not a real AIB'.repeat(100));
const names = ['windows-x64.zip', 'windows-arm64.zip', 'macos-x64.zip', 'macos-arm64.zip', 'linux-x64.AppImage', 'linux-arm64.AppImage'].map((s) => `AIB-${APP_VERSION}-${s}`);
const h = await hash(payload);
const sums = names.map((n) => `${h}  ${n}\n`).join('');
let base = '';
const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, (req) => {
  const url = new URL(req.url);
  if (url.pathname.endsWith('/releases')) {
    const assets = names.map((name, i) => ({ name, state: 'uploaded', size: payload.length, url: `${base}/assets/${i}` }))
      .concat([{ name: 'SHA256SUMS', state: 'uploaded', size: sums.length, url: `${base}/assets/sums` }]);
    const rel = (v: string, body: string, date: string, extra = {}) => ({ tag_name: 'v' + v, draft: false, prerelease: true, html_url: 'https://example.invalid/' + v, published_at: date, body, assets: [], ...extra });
    return Response.json([
      rel(APP_VERSION, [
        '## Update button',
        '',
        '- **Update** sits at the top right of the window when a new version is ready. One click installs it; your chats keep running in the keeper.',
        '- Steer a working agent: press Enter while it works. The message shows "Sent while working".',
        '- A command an agent left running in the background shows "Still running in the background" with a Stop button.',
        '',
        '## Phone remote control',
        '',
        '- Answer approvals and questions from your phone over your own Tailscale network. No account, no relay of ours.',
      ].join('\n'), '2026-11-12T10:00:00Z', { assets }),
      rel(OLD, ['## Local docs', '', '- Docs live in the **aib-docs** folder of your project: shared by every agent, in git with your code.', '- Comments, History with Restore, rich blocks and drawings.'].join('\n'), '2026-11-05T10:00:00Z'),
      rel(OLDER, ['## The keeper', '', '- Quit, update or crash: your chats, helpers and terminals keep running.'].join('\n'), '2026-10-29T10:00:00Z'),
    ]);
  }
  if (url.pathname === '/assets/sums') return new Response(sums);
  if (url.pathname.startsWith('/assets/')) return new Response(payload as Uint8Array<ArrayBuffer>);
  return new Response('no', { status: 404 });
});
base = `http://127.0.0.1:${server.addr.port}`;

const py = async (args: string[], env: Record<string, string> = {}) => {
  const r = await new Deno.Command(PY, { args: [START, ...args], env, stdout: 'piped', stderr: 'piped' }).output();
  const out = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
  if (!r.success) throw new Error(out);
  return out;
};
const url = `http://127.0.0.1:${PORT}/chat.html`;
const b = await Browser.launch();
try {
  for (const t of THEMES) {
    const tag = t === 'teal-dark' ? 'dark' : 'light';
    // 1. the Update button (runs as beta.8, finds beta.9)
    await py(['--port', String(PORT), '--dir', DIR, '--keep'], { AIB_UPDATE_API_BASE: base, AIB_UPDATE_CURRENT: OLD });
    let p = await desk(b, url, t);
    try {
      await sleep(2500);
      await clickText(p, 'button.connection', 'Add rate limiting').catch(() => {});
      await clickText(p, 'button', 'Settings'); await sleep(1200);
      for (const sec of ['AIB server', 'Defaults', 'AIB Linking']) {
        await clickText(p, 'button, a, li, [role=tab]', sec).catch(() => {}); await sleep(600);
        if (await p.eval<boolean>(`[...document.querySelectorAll('button')].some(e=>e.innerText.trim()==='Check for updates')`)) break;
      }
      await clickText(p, 'button', 'Check for updates'); await sleep(4000);
      await p.key('Escape'); await sleep(500);
      await p.eval(`(() => { const x = [...document.querySelectorAll('button')].find(e => ['×','✕'].includes(e.innerText.trim()) && e.offsetParent && e.getBoundingClientRect().top < 80 && e.getBoundingClientRect().left > 1000); if (x) x.click(); })()`);
      await sleep(800);
      await p.waitFor(`(function(){var b=document.getElementById('updateButton');return !!b&&!b.hidden})()`, 45000, 'the Update button');
      await sleep(1200);
      await shot(p, `updates-update-button-${tag}`);
    } finally { await p.close(); }
    await py(['--stop', '--keep', '--port', String(PORT), '--dir', DIR]);
    // 2. restart as the new version on the same data: the notes tab opens once
    await py(['--port', String(PORT), '--dir', DIR, '--keep'], { AIB_UPDATE_API_BASE: 'http://127.0.0.1:9' });
    p = await desk(b, url, t);
    try {
      await p.waitFor(`Array.from(document.querySelectorAll('#chatTabs .ws-tab-title')).some(function(n){return n.textContent===${JSON.stringify(`What's new in AIB ${APP_VERSION}`)}})`, 45000, 'the notes tab');
      await sleep(1200);
      await shot(p, `updates-whats-new-${tag}`);
    } finally { await p.close(); }
    await py(['--stop', '--keep', '--port', String(PORT), '--dir', DIR]);
  }
} finally {
  await b.close();
  await py(['--stop', '--port', String(PORT), '--dir', DIR]).catch((e) => console.log('stop:', String(e).slice(0, 200)));
  await server.shutdown();
}

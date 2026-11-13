/** Settings > Remote control, step by step: the in-process Studio of work/deno/remote_setup_page_test.ts with the stateful fake Tailscale
 *  (_tailscale_sim.ts; nothing real runs) in a 1600x900 headless browser at device scale 2. Run with TEMP=C:\aib-demo\tmp. */
import { Browser } from '../deno/_doc_browser.ts';
import { nonce, pc, phoneHeaders, raw, remoteStudio } from '../deno/_remote_fixture.ts';
import { tailscaleSim } from '../deno/_tailscale_sim.ts';
import { desk, shot, sleep, THEMES } from './lib.ts';

const stepState = (n: number) => `(document.querySelector('.dv-steps li[data-step="${n}"]') || {}).className || ''`;
const clickAct = (page: any, act: string) =>
  page.waitFor(`(() => { const b = document.querySelector('.dv-steps button[data-act="${act}"]'); if (!b || b.disabled) return false; b.click(); return true; })()`, 10000, act);

const browser = await Browser.launch();
try {
  for (const theme of THEMES) {
    const tag = theme === 'teal-dark' ? 'dark' : 'light';
    const sim = tailscaleSim({ installed: false, https: false }, (c, sim) => {
      if (c.tool === 'winget') return { code: 0, effect: () => (sim.installed = true, sim.backend = 'NeedsLogin') };
    });
    const s = await remoteStudio({ runner: sim.runner, setupEnv: sim.env(), bindRetryMs: 300 }, undefined, { saved: true });
    s.saveChat({ sessionId: 'a1', prompt: 'Fix the checkout rounding bug', reply: 'Done. The total is now computed in whole cents.', ageSeconds: 900 });
    s.saveChat({ sessionId: 'a2', prompt: 'Add CSV export to the orders page', reply: 'The Export CSV button is in.', ageSeconds: 4000 });
    try {
      const p = await desk(browser, `http://127.0.0.1:${s.port}/chat.html`, theme);
      try {
        await p.waitFor('!!document.getElementById("openSettings")', 15000, 'chat page');
        await p.click('#openSettings');
        await p.waitFor(`document.body.classList.contains('settings-open')`, 8000, 'settings');
        await p.eval(`[...document.querySelectorAll('.st-section')].find((b) => b.textContent === 'Remote control').click()`);
        await p.waitFor(`!!document.querySelector('.dv-switch')`, 8000, 'remote control');
        await sleep(800);
        // 01: the switch is off
        await shot(p, `setup-00-switch-off-${tag}`);
        await pc(s, 'POST', '/api/live/devices/access', { on: true });
        await p.waitFor(`!!document.querySelector('.dv-steps')`, 10000, 'steps');
        await p.waitFor(`${stepState(1)}.includes('now')`, 10000, 'step 1');
        await sleep(800);
        await shot(p, `setup-01-switch-on-${tag}`);
        await clickAct(p, 'install');
        await p.waitFor(`!!document.querySelector('.dv-steps button[data-act="login"]')`, 15000, 'login');
        await clickAct(p, 'login');
        await p.waitFor(`${stepState(1)}.includes('wait')`, 8000, 'signing in');
        sim.sim.backend = 'Running';
        await p.waitFor(`${stepState(1)}.includes('ok') && ${stepState(2)}.includes('now')`, 15000, 'signed in');
        await sleep(600);
        await shot(p, `setup-02-tailscale-signed-in-${tag}`);
        await clickAct(p, 'https');
        await p.waitFor(`${stepState(2)}.includes('wait')`, 8000, 'https waits');
        await sleep(600);
        await shot(p, `setup-03-https-${tag}`);
        sim.sim.https = true;
        await p.waitFor(`${stepState(2)}.includes('ok') && ${stepState(3)}.includes('now')`, 15000, 'share next');
        await clickAct(p, 'share');
        await p.waitFor(`${stepState(3)}.includes('ok') && ${stepState(4)}.includes('now')`, 15000, 'shared');
        await p.waitFor(`document.getElementById('dvStatus').textContent.startsWith('✓ Reachable at https://')`, 8000, 'status');
        await p.waitFor(`!document.getElementById('dvAdd').disabled`, 8000, 'add a phone ready');
        await sleep(600);
        await shot(p, `setup-04-shared-${tag}`);
        await p.eval(`document.getElementById('dvAdd').click()`);
        await p.waitFor(`!!document.querySelector('.dv-pair .dv-qr') && !!document.querySelector('.dv-words')`, 10000, 'the QR');
        await sleep(1200);
        await p.eval(`document.querySelector('.dv-pair').scrollIntoView({block:'center'})`);
        await sleep(500);
        await shot(p, `setup-05-add-phone-qr-${tag}`);
        // the phone claims with the six words; the PC asks to approve
        const words = await p.eval<string>(`document.querySelector('.dv-words').textContent`);
        const claim = await raw(s.phonePort(), 'POST', '/api/remote/pair/claim', phoneHeaders({}, 'POST'), JSON.stringify({ code: words, name: 'Pixel 8', nonce: nonce() }));
        if (claim.status !== 200) throw new Error('claim ' + claim.status + claim.text);
        await p.waitFor(`!!document.querySelector('.dv-approve')`, 15000, 'approve prompt');
        await p.eval(`document.querySelector('.dv-approve').scrollIntoView({block:'center'})`);
        await sleep(800);
        await shot(p, `setup-06-approve-${tag}`);
        await p.eval(`(() => { const b = [...document.querySelectorAll('.dv-approve button')].find(b => /approve|allow|yes/i.test(b.innerText)); if (b) b.click(); })()`);
        await sleep(2500);
        await p.eval(`document.querySelector('.dv-list') && document.querySelector('.dv-list').scrollIntoView({block:'center'})`);
        await sleep(600);
        await shot(p, `setup-07-phones-list-${tag}`);
      } finally { await p.close(); }
    } finally { await s.close(); }
  }
} finally { await browser.close(); }
Deno.exit(0);

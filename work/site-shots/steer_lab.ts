/** Steering shots: the steer lab of work/deno/_steer_lab.ts (a real Studio + separate agent host + work/fake_acp.py --steer claude).
 *  Run with TEMP=C:\aib-demo\tmp so the lab's folders are not under a user profile. */
import { backgroundOf, openPage, sharedBrowser, SteerLab, until } from '../deno/_steer_lab.ts';
import { shot, sleep, THEMES } from './lib.ts';

const tidy = (page: any) => page.eval(`(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; const re = new RegExp('steer-bash:[^ ]+'); while ((n = w.nextNode())) n.nodeValue = n.nodeValue.replace(re, 'Run the build and tell me when it passes'); })()`);

for (const theme of THEMES) {
  const tag = theme === 'teal-dark' ? 'dark' : 'light';
  await using lab = new SteerLab();
  await lab.start();
  const chat = await lab.chat('claude', 'storefront');
  const gate = lab.gate();
  const page = await openPage(lab, chat, 1600, 900, theme);
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 2, mobile: false });
    await page.eval(`window.AibThemes.paint(${JSON.stringify(theme)})`);
    await chat.prompt(`steer-bash:${gate}`, 'first');
    await until(async () => (await chat.state()).busy, 'working', 30);
    await sleep(1500);
    await tidy(page);
    await shot(page, `steering-working-command-${tag}`);
    await page.waitFor(`[...document.querySelectorAll('#promptForm [aria-haspopup]')].some((e) => e.getBoundingClientRect().width > 0)`, 15000, 'the menu button');
    await page.click('#promptForm [aria-haspopup]');
    await page.waitFor(`!!document.querySelector('[role=menu]:not([hidden])')`, 4000, 'the menu');
    await tidy(page);
    await shot(page, `steering-send-menu-${tag}`);
    await page.key('Escape');
    await page.waitFor(`!document.querySelector('[role=menu]:not([hidden])')`, 4000, 'the menu closed');
    await chat.steer('what is 2+2?', 'b-1');
    await until(async () => (await backgroundOf(chat, 'toolu_steer_bash'))?.state === 'running', 'background', 30);
    await sleep(2500);
    await tidy(page);
    await shot(page, `steering-sent-while-working-${tag}`);
    await page.eval(`document.querySelector('#messages').scrollTop = 1e6`); await tidy(page);
    await sleep(800);
    await tidy(page);
    await shot(page, `steering-background-stop-${tag}`);
  } finally {
    await page.close();
    chat.open(gate);
  }
}
(await sharedBrowser()).killNow();
Deno.exit(0);

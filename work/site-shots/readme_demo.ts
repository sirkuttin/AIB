/** Shots from the realistic demo (work/demo-studio/readme_shots.py --port 8851, TEMP=C:\aib-demo\tmp): split panes with two providers, inbox. */
import { closeTabs, openInbox, clickLeaf, Browser, clickText, clickExact, ctrlBackslash, eachTheme, shot, sleep } from './lib.ts';
const URL = 'http://127.0.0.1:8851/chat.html';
const only = Deno.args[0];
const b = await Browser.launch();
const storefront = async (p: any) => {
  await sleep(3000);
  await p.click('button[aria-haspopup], .project-name'); await sleep(600);
  await clickLeaf(p, 'storefront', '[role=menu], [class*=pop], [class*=menu], body');
  await sleep(1500);
  await closeTabs(p); await sleep(500);
};
try {
  if (!only || only === 'inbox') await eachTheme(b, URL, async (p, _t, tag) => {
    await storefront(p);
    await clickText(p, 'button.connection', 'Bump Stripe SDK'); await sleep(3000);
    await shot(p, `inbox-approval-in-chat-${tag}`);
    await openInbox(p);
    await shot(p, `inbox-approval-and-list-${tag}`);
  });
  if (!only || only === 'steer') await eachTheme(b, URL, async (p, _t, tag) => {
    await storefront(p);
    await clickText(p, 'button.connection', 'Add CSV export'); await sleep(3000);
    await shot(p, `steering-working-${tag}`);
    await p.eval(`(() => { const send = [...document.querySelectorAll('button')].find(e => (e.innerText||'').trim() === 'Send' && e.offsetParent); const arrow = send && send.nextElementSibling; if (arrow) arrow.click(); })()`);
    await sleep(900);
    await shot(p, `steering-send-menu-${tag}`);
  });
  if (!only || only === 'files') await eachTheme(b, URL, async (p, _t, tag) => {
    await storefront(p);
    await clickText(p, 'button.connection', 'Add CSV export'); await sleep(2500);
    await clickExact(p, 'button', 'Files'); await sleep(2000);
    await shot(p, `files-sidebar-${tag}`);
  });
  if (!only || only === 'files2') await eachTheme(b, URL, async (p, _t, tag) => {
    await storefront(p);
    await clickText(p, 'button.connection', 'Add CSV export'); await sleep(2500);
    await clickExact(p, 'button', 'Files'); await sleep(1500);
    await clickLeaf(p, 'package.json', '#app, body'); await sleep(2500);
    await shot(p, `files-beside-chat-${tag}`);
    await clickText(p, 'button', 'Chats'); await sleep(800); await clickText(p, 'button.connection', 'Add CSV export'); await sleep(1500);
    await p.eval(`document.elementFromPoint(1285, 64).closest('button').click()`); await sleep(3500);
    await shot(p, `terminal-dock-${tag}`);
  });
  if (!only || only === 'hero') await eachTheme(b, URL, async (p, _t, tag) => {
    await storefront(p);
    await clickText(p, 'button.connection', 'Fix checkout rounding'); await sleep(2500);
    await clickText(p, 'button.connection', 'Add CSV export'); await sleep(2500);
    await ctrlBackslash(p); await sleep(2500);
    await shot(p, `hero-split-agents-${tag}`);
  });
} finally { await b.close(); }

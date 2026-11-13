/** More desktop shots from the realistic demo (port 8851): Changes + Merge, artifact menu, private/ menu, subagent card. */
import { clickLeaf, clickText, clickExact, closeTabs, eachTheme, shot, sleep } from './lib.ts';
import { Browser } from './lib.ts';
const URL = 'http://127.0.0.1:8851/chat.html';
const only = Deno.args[0];
const b = await Browser.launch();
const project = async (p: any, name: string) => {
  await sleep(3000);
  await p.click('button[aria-haspopup], .project-name'); await sleep(600);
  await clickLeaf(p, name, '[role=menu], [class*=pop], [class*=menu], body');
  await sleep(1500); await closeTabs(p); await sleep(500);
};
try {
  if (!only || only === 'changes') await eachTheme(b, URL, async (p, _t, tag) => {
    await project(p, 'storefront');
    await clickText(p, 'button.connection', 'Add CSV export'); await sleep(2500);
    await clickText(p, 'button', 'Changes'); await sleep(2000);
    await shot(p, `worktrees-changes-merge-open-${tag}`);
  });
  if (!only || only === 'artifact') await eachTheme(b, URL, async (p, _t, tag) => {
    await project(p, 'billing-api');
    await clickText(p, 'button.connection', 'October revenue'); await sleep(2500);
    await clickText(p, 'button', 'Artifacts'); await sleep(2500);
    await shot(p, `artifacts-open-${tag}`);
    await p.eval(`document.elementFromPoint(1576, 117).closest('button').click()`).catch(() => {});
    await sleep(900);
    await shot(p, `artifacts-menu-archive-delete-${tag}`);
  });
  if (only === 'merge') await eachTheme(b, URL, async (p, _t, tag) => {
    await project(p, 'storefront');
    await clickText(p, 'button.connection', 'Add CSV export'); await sleep(2500);
    await clickText(p, 'button', 'Changes'); await sleep(2000);
    await clickText(p, 'button', 'Merge into main'); await sleep(2500);
    await shot(p, `worktrees-merge-requested-${tag}`);
  });
  if (!only || only === 'private') await eachTheme(b, URL, async (p, _t, tag) => {
    await project(p, 'storefront');
    await clickText(p, 'button.connection', 'Add CSV export'); await sleep(2000);
    await clickExact(p, 'button', 'Files'); await sleep(1500);
    await p.eval(`(() => { const e = [...document.querySelectorAll('*')].filter(e => e.offsetParent && (e.innerText||'').trim().startsWith('private') && ![...e.children].some(c => (c.innerText||'').trim().startsWith('private')))[0]; const r = e.getBoundingClientRect(); window.__pr = [r.left + 20, r.top + r.height/2]; })()`);
    const [x, y] = await p.eval<number[]>('window.__pr');
    await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', clickCount: 1 });
    await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1 });
    await sleep(900);
    await shot(p, `private-git-exclude-${tag}`);
  });
  if (!only || only === 'subagent') await eachTheme(b, URL, async (p, _t, tag) => {
    await project(p, 'storefront');
    await clickText(p, 'button.connection', 'Fix checkout rounding'); await sleep(2500);
    await p.eval(`document.querySelector('#messages').scrollTop = 0`); await sleep(700);
    await shot(p, `chats-subagent-top-${tag}`);
  });
} finally { await b.close(); }

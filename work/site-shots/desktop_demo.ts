/** Desktop shots from the demo Studio (work/demo-studio/start.py --port 8840 --dir C:\aib-demo, AIB_DEMO_MODELS=1). */
import { neutralPaths, Browser, clickExact, clickText, eachTheme, shot, sleep } from './lib.ts';
const URL = 'http://127.0.0.1:8840/chat.html';
const only = Deno.args[0];
const b = await Browser.launch();
const open = async (p: any, title = 'Add rate limiting') => { await sleep(2500); await clickText(p, 'button.connection', title); await sleep(2500); await clickExact(p, 'button', 'Full').catch(() => {}); await sleep(500); };
try {
  if (!only || only === 'chats') await eachTheme(b, URL, async (p, _t, tag) => {
    await open(p);
    await shot(p, `chats-full-view-${tag}`);
    await clickExact(p, 'button', 'Chat'); await sleep(800); await shot(p, `chats-chat-view-${tag}`);
    await clickExact(p, 'button', 'Prompts'); await sleep(800); await shot(p, `chats-prompts-view-${tag}`);
  });
  if (!only || only === 'changes') await eachTheme(b, URL, async (p, _t, tag) => {
    await open(p);
    await clickText(p, 'button', 'Changes'); await sleep(1500);
    await shot(p, `worktrees-changes-${tag}`);
  });
  if (!only || only === 'artifacts') await eachTheme(b, URL, async (p, _t, tag) => {
    await open(p);
    await clickText(p, 'button', 'Artifacts'); await sleep(2000);
    await shot(p, `artifacts-panel-${tag}`);
  });
  if (!only || only === 'settings') await eachTheme(b, URL, async (p, _t, tag) => {
    await sleep(2500);
    await clickText(p, 'button', 'Settings'); await sleep(2000);
    await neutralPaths(p);
    await shot(p, `settings-agents-${tag}`);
    await p.eval(`[...document.querySelectorAll('h2,h3,strong')].find(e=>e.innerText.trim()==='Beta agents').scrollIntoView({block:'start'})`); await sleep(600);
    await shot(p, `settings-beta-agents-${tag}`);
  });
} finally { await b.close(); }

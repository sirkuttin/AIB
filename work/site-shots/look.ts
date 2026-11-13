import { Browser, desk, shot, sleep, clickText, ctrlBackslash } from './lib.ts';
const b = await Browser.launch();
try {
  const p = await desk(b, 'http://127.0.0.1:8851/chat.html', 'teal-dark');
  await sleep(3500);
  await p.click('.project-name, [class*=project] button, button[aria-haspopup]');
  await sleep(800);
  await shot(p, 'look');
  console.log(await p.eval(`document.body.innerText.slice(0,300)`));
} finally { await b.close(); }

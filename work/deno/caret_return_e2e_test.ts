/**
 * Coming back to AIB from another app puts the caret back in the message box (owner, 2026-11-15: "when i switch to another app
 * and come back, my cursor loses its focus in the text box"). focus-return.js notes the text box and its selection when the
 * window loses focus and restores both when it gets it back, unless you came back by clicking or typing somewhere else.
 *
 * A real Studio (the scroll lab: temp state folder, free port, never the live ports), one scripted chat, headless Chrome/Edge.
 * Headless Chrome has no other app to switch to, so the window's blur and focus are dispatched on the page, and the focus is
 * dropped to the page in between (what the desktop window does on Alt+Tab / the taskbar).
 *
 * Run (from app): deno test -A ../../work/deno/caret_return_e2e_test.ts   (ignored without Chrome or Edge)
 */
import { assert } from './_assert.ts';
import { browserPath, Lab, settle, shown } from './_scroll_lab.ts';

function caretTest(name: string, fn: (lab: Lab) => Promise<void>) {
  Deno.test({
    name,
    ignore: !browserPath,
    sanitizeResources: false,
    sanitizeOps: false,
    async fn() {
      const lab = await Lab.open(1400, 860);
      try {
        await fn(lab);
        assert(lab.page.errors.length === 0, `console errors: ${lab.page.errors.join(' | ')}`);
      } finally {
        await lab.close();
      }
    },
  });
}

const LEAVE = `(() => { window.dispatchEvent(new FocusEvent('blur')); document.activeElement && document.activeElement.blur(); return document.activeElement === document.body; })()`;
const BACK = `window.dispatchEvent(new FocusEvent('focus'))`;
const STATE = `(() => { const p = document.getElementById('prompt'), a = document.activeElement;
  return { inBox: a === p, on: a ? (a.id || a.tagName) : '', start: p.selectionStart, end: p.selectionEnd, value: p.value }; })()`;

async function chatWithText(lab: Lab) {
  const chat = await lab.chat();
  await chat.start();
  chat.say('Hello CARETREADY');
  await lab.select(chat);
  await shown(lab.page, 'CARETREADY');
  await lab.page.waitFor(`!document.getElementById('prompt').disabled`, 10000, 'the message box');
  await lab.page.click('#prompt');
  await lab.page.type('first line, then more words');
  // a selection in the middle: "then"
  await lab.page.eval(`(() => { const p = document.getElementById('prompt'); const i = p.value.indexOf('then'); p.setSelectionRange(i, i + 4); })()`);
  return chat;
}

caretTest('CR1 leaving the app and coming back puts the caret back in the message box, same selection', async (lab) => {
  const page = lab.page;
  const chat = await chatWithText(lab);
  const before = await page.eval<{ start: number; end: number; inBox: boolean }>(STATE);
  assert(before.inBox && before.end - before.start === 4, `before: ${JSON.stringify(before)}`);
  assert(await page.eval<boolean>(LEAVE), 'the focus left the box');
  await settle(300);
  await page.eval(BACK);
  await settle(400);
  const after = await page.eval<{ start: number; end: number; inBox: boolean; on: string }>(STATE);
  assert(after.inBox, `the caret is back in the box: ${JSON.stringify(after)}`);
  assert(after.start === before.start && after.end === before.end, `same selection: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  // and typing goes on there
  await page.type('NOW');
  const typed = await page.eval<{ value: string }>(STATE);
  assert(typed.value === 'first line, NOW more words', `typed into the box: ${typed.value}`);
  chat.end();
});

caretTest('CR2 coming back by clicking somewhere else leaves the focus where you clicked', async (lab) => {
  const page = lab.page;
  const chat = await chatWithText(lab);
  assert(await page.eval<boolean>(LEAVE), 'the focus left the box');
  await settle(300);
  await page.eval(BACK);
  await page.click('#title'); // the chat title: the click that brought you back (it starts a rename: the focus goes there)
  await settle(400);
  const after = await page.eval<{ inBox: boolean; on: string }>(STATE);
  assert(!after.inBox, `the focus stays where you clicked: ${JSON.stringify(after)}`);
  chat.end();
});

caretTest('CR3 the caret was not in a text box when you left: nothing is focused on return', async (lab) => {
  const page = lab.page;
  const chat = await chatWithText(lab);
  await page.eval(`document.getElementById('title').focus()`);
  await page.eval(`window.dispatchEvent(new FocusEvent('blur'))`);
  await page.eval(`document.activeElement.blur()`);
  await page.eval(BACK);
  await settle(400);
  const after = await page.eval<{ inBox: boolean; on: string }>(STATE);
  assert(!after.inBox, `the box did not take the focus: ${JSON.stringify(after)}`);
  chat.end();
});

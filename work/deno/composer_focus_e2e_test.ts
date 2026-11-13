/**
 * The message box keeps the keyboard focus, end to end (owner, beta.9 test build): a real Studio with the scripted agent
 * (work/scroll-fixture/agent.py) and a headless Chrome/Edge on chat.html (no window), as in scroll_e2e_test.ts.
 *
 *   C1  every way of sending leaves you in the message box: Enter (idle), Enter while the agent works, Alt+Enter, the Send button,
 *       the Send ▾ menu's items (after this turn, Interrupt and send). Was: the box was disabled while the message
 *       was on its way (chat.js renderHeaderBody, `sending`), which took the focus away; nothing gave it back.
 *   C2  a popup that closes gives the focus back to the box you were typing in: the Send ▾ menu (Escape, ▾ again), an approval
 *       card you answered, the title rename (Enter, Escape), Ctrl+K, a composer chip's menu opened with the mouse (Escape, a pick),
 *       the image viewer, the file picker (its change and cancel). Was: the focus fell to the page (the Send button it went to
 *       was disabled; the answered card was removed) or stayed on the chip / the title. The common part: focus-return.js.
 */
import { assert } from './_assert.ts';
import { browserPath, clickHere, Lab, type Page, settle, shown } from './_scroll_lab.ts';

const ACTIVE = `(() => { const a = document.activeElement; return a ? (a.id || a.className || a.tagName) : 'none'; })()`;
const inBox = async (page: Page) => (await page.eval<string>(ACTIVE)) === 'prompt';

function e2e(name: string, fn: (lab: Lab) => Promise<void>) {
  Deno.test({
    name,
    ignore: !browserPath,
    sanitizeResources: false,
    sanitizeOps: false,
    async fn() {
      const lab = await Lab.open(1600, 900);
      try {
        await fn(lab);
        assert(lab.page.errors.length === 0, `console errors: ${lab.page.errors.join(' | ')}`);
      } finally {
        await lab.close();
      }
    },
  });
}

/** A real click in the message box, then the words (as you would type them). */
async function typeInBox(page: Page, text: string) {
  await clickHere(page, '#prompt');
  await page.type(text);
}

e2e('C1 every way of sending keeps the focus in the message box', async (lab) => {
  const page = lab.page;
  const chat = await lab.chat();
  await lab.select(chat);
  await settle(800);
  const bad: string[] = [];
  const check = async (what: string) => {
    await settle(1500);
    if (!(await inBox(page))) bad.push(`${what}: focus on ${await page.eval(ACTIVE)}`);
  };
  await typeInBox(page, 'hello idle');
  await page.key('Enter');
  await check('Enter (idle)');
  await chat.start();
  chat.say('working WORKING');
  await shown(page, 'WORKING');
  await settle(1800);
  await typeInBox(page, 'a note while working');
  await page.key('Enter');
  await check('Enter while the agent works');
  await typeInBox(page, 'after this turn');
  await page.key('Enter', 1); // Alt
  await check('Alt+Enter');
  await typeInBox(page, 'with the button');
  await clickHere(page, '#send');
  await check('the Send button');
  // (Send now is greyed out here: the scripted agent cannot read messages mid-turn. The focus is given back after the send
  // whatever its way, steer included: chat.js composerFocusBack in the send's finally.)
  for (const label of ['after this turn', 'Interrupt and send']) {
    await typeInBox(page, `menu ${label}`);
    await clickHere(page, '.send-more');
    await page.waitFor('!document.querySelector(".send-menu").hidden', 5000, 'the Send menu');
    const ok = await page.eval<boolean>(`(() => { const b = [...document.querySelectorAll('.send-menu .send-item')].find((x) => x.textContent.includes(${JSON.stringify(label)}) && !x.disabled); if (b) b.classList.add('pick-me'); return !!b; })()`);
    if (!ok) {
      bad.push(`no enabled "${label}" item`);
      await page.key('Escape');
      continue;
    }
    await clickHere(page, '.send-menu .pick-me');
    await check(`Send ▾ ${label}`);
    if (label === 'Interrupt and send') {
      await chat.start(); // the interrupted turn ended: a new one, working again
      chat.say('working again AGAIN');
      await shown(page, 'AGAIN');
      await settle(1800);
    }
  }
  chat.end();
  assert(!bad.length, bad.join('\n'));
});

e2e('C2 a popup that closes gives the focus back to the message box', async (lab) => {
  const page = lab.page;
  const chat = await lab.chat();
  await lab.select(chat);
  await chat.start();
  chat.say('working WORKING');
  await shown(page, 'WORKING');
  await settle(1800);
  const bad: string[] = [];
  const check = async (what: string, ms = 400) => {
    await settle(ms);
    if (!(await inBox(page))) bad.push(`${what}: focus on ${await page.eval(ACTIVE)}`);
  };
  // Send ▾: Escape, then ▾ again
  await typeInBox(page, 'draft');
  await clickHere(page, '.send-more');
  await page.waitFor('!document.querySelector(".send-menu").hidden', 5000, 'the Send menu');
  await page.key('Escape');
  await check('Send ▾, Escape');
  await clickHere(page, '.send-more');
  await page.waitFor('!document.querySelector(".send-menu").hidden', 5000, 'the Send menu');
  await clickHere(page, '.send-more');
  await check('Send ▾, ▾ again');
  // an approval card, answered with the mouse
  await clickHere(page, '#prompt');
  chat.step({ ask: 'Run rm -rf build' });
  await page.waitFor('(document.getElementById("approvals").textContent || "").includes("rm -rf build")', 15000, 'the card');
  await settle(400);
  await page.eval(`[...document.querySelectorAll('#approvals button')].find((b) => /Allow/.test(b.textContent)).classList.add('allow-me')`);
  await clickHere(page, '#approvals .allow-me');
  await page.waitFor('!(document.getElementById("approvals").textContent || "").includes("rm -rf build")', 15000, 'the card answered');
  await check('approval card answered', 800);
  // the title rename: Escape, and Enter
  for (const key of ['Escape', 'Enter']) {
    await clickHere(page, '#prompt');
    await clickHere(page, '#renameCurrent');
    await page.waitFor('document.activeElement && document.activeElement.classList.contains("hd-title-input")', 5000, 'the title box');
    await page.key(key);
    await check(`title rename, ${key}`);
  }
  // Ctrl+K
  await clickHere(page, '#prompt');
  await page.key('k', 2);
  await page.waitFor('document.activeElement && document.activeElement.classList.contains("switcher-input")', 5000, 'Ctrl+K');
  await page.key('Escape');
  await check('Ctrl+K, Escape', 600);
  // a composer chip's menu, opened with the mouse: Escape, and a pick
  for (const how of ['Escape', 'pick']) {
    await clickHere(page, '#prompt');
    await clickHere(page, '#composerChips button[aria-haspopup]');
    await page.waitFor('!!document.querySelector(".chip-menu")', 5000, 'the chip menu');
    if (how === 'Escape') await page.key('Escape');
    else await clickHere(page, '.chip-menu [role="menuitemradio"]:not([aria-checked="true"]):not([disabled]), .chip-menu [role="menuitemradio"]');
    await check(`chip menu, ${how}`, 800);
  }
  // the image viewer, opened on a picture in the chat with the mouse
  await clickHere(page, '#prompt');
  await page.eval(`window.ImageViewer.open([{ src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', name: 'dot' }], 0, document.getElementById('send'))`);
  await settle(300);
  await page.key('Escape');
  await check('image viewer, Escape');
  // the file picker (never opened here: its change and cancel events, as the browser sends them when it closes)
  await page.eval(`document.getElementById('imageFiles').click = () => {}`); // no picker on anyone's screen
  for (const ev of ['change', 'cancel']) {
    await clickHere(page, '#prompt');
    await clickHere(page, '#attachImages');
    await page.eval(`document.getElementById('imageFiles').dispatchEvent(new Event(${JSON.stringify(ev)}))`);
    await check(`file picker, ${ev}`);
  }
  chat.end();
  assert(!bad.length, bad.join('\n'));
});

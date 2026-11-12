/**
 * Scrolling in the chat, end to end: a real Studio (Deno web server + in-process agent host, temp state folder, free port), the
 * scripted agent work/scroll-fixture/agent.py, and a headless Chrome/Edge on chat.html (no window). The test appends each step to
 * the chat's script and waits until the page draws it, then measures the list: scrollTop, scrollHeight, clientHeight, the gap to
 * the bottom, the follow flag (data-paused), the newest row's box against the list's box, and the row at the top of the view.
 * Where an update could flash, it also records the same numbers on every animation frame.
 *
 * Run (from outputs/agent-studio):
 *   deno test -A ../../work/deno/scroll_e2e_test.ts                      the passing tests; KNOWN_FAILING ones are listed as ignored
 *   AIB_SCROLL_ALL=1 deno test -A ../../work/deno/scroll_e2e_test.ts     also the known-failing ones (they fail until fixed)
 *   ... --filter "2b"                                                    one test by its number
 * Without Chrome or Edge (CHROME_PATH chooses one) every test is ignored. When a bug is fixed, delete its name from KNOWN_FAILING.
 */
import { assert } from './_assert.ts';
import {
  anchor,
  browserPath,
  type Chat,
  clickHere,
  following,
  framesProblems,
  Lab,
  m,
  type Page,
  png,
  settle,
  shown,
  sleep,
  startFrames,
  stopFrames,
  topOf,
  wheel,
  whereIs,
} from './_scroll_lab.ts';

const ALL = Deno.env.get('AIB_SCROLL_ALL') === '1';

/** Tests that fail on integration/beta8 today (each is a scrolling bug; see the comment in the test for the cause). */
export const KNOWN_FAILING = new Set<string>([
  '2b approval card pinned under a following list: it stays at the bottom and keeps following',
  '2d terminal dock opened and resized under a following list: it stays at the bottom and keeps following',
  '4a opening a big step at the bottom: it stays where you clicked, also when the next update arrives',
  '4c "Show all" on a long block at the bottom: the block stays where it was, also when the next update arrives',
  '6a opening a chat with unread messages lands on the "New" line',
  '6d scrolled up mid-turn, Full -> Chat -> Full brings you back to the row you were reading',
]);

function scrollTest(name: string, fn: (lab: Lab) => Promise<void>, size: [number, number] = [1600, 900]) {
  Deno.test({
    name,
    ignore: !browserPath || (KNOWN_FAILING.has(name) && !ALL),
    sanitizeResources: false,
    sanitizeOps: false,
    async fn() {
      const lab = await Lab.open(size[0], size[1]);
      try {
        await fn(lab);
        assert(lab.page.errors.length === 0, `console errors: ${lab.page.errors.join(' | ')}`);
      } finally {
        await lab.close();
      }
    },
  });
}

/** Enough history to scroll: n agent messages, each followed by one finished step. */
function seed(chat: Chat, n = 30, tag = 'Seed') {
  for (let i = 0; i < n; i++) {
    chat.say(`${tag} message ${i}. ` + 'Some words to fill a line or two. '.repeat(6));
    chat.tool(`${tag}-${i}`, `Read ${tag.toLowerCase()} file ${i}`, 'completed');
  }
}

/** Open a chat whose turn is running, seeded, and wait until it is drawn at the bottom. */
async function openSeeded(lab: Lab, n = 30): Promise<Chat> {
  const chat = await lab.chat();
  await chat.start();
  seed(chat, n);
  chat.say('Seed done SEEDEND');
  await lab.select(chat);
  await shown(lab.page, 'SEEDEND');
  await settle();
  return chat;
}

/** Type four lines in the composer and delete them with the keyboard (as when you send: the composer grows, then shrinks). */
async function typeAndClear(page: Page) {
  await page.eval('document.getElementById("prompt").focus()');
  await page.type('line one\nline two\nline three\nline four');
  await settle(400);
  await page.key('a', 2);
  await page.key('Backspace');
  await settle(600);
  assert((await page.eval('document.getElementById("prompt").value')) === '', 'composer cleared');
}

async function setView(page: Page, view: 'full' | 'chat' | 'prompts') {
  await clickHere(page, `#viewSwitch button[data-view="${view}"]`);
  await page.waitFor(`document.querySelector('#viewSwitch button[data-view="${view}"]').getAttribute('aria-checked') === 'true'`);
  await settle(1200);
}

/** Run one update while recording frames; returns the problems (empty: fine). */
async function update(page: Page, send: () => void, until: string, box = 'messages', wait = 1200): Promise<string> {
  await startFrames(page, box);
  send();
  await shown(page, until, box);
  await settle(wait);
  const frames = await stopFrames(page);
  const end = await m(page, box);
  return [following(end) && `after: ${following(end)} ${JSON.stringify(end)}`, framesProblems(frames)].filter(Boolean).join('; ');
}

async function assertFollowing(page: Page, what: string, box = 'messages') {
  const x = await m(page, box);
  const bad = following(x);
  assert(!bad, `${what}: ${bad} (scrollTop ${x.top}, scrollHeight ${x.height}, clientHeight ${x.client}, newest row ${x.lastTop}..${x.lastBottom})`);
}

// ---- 1. following: the newest row stays fully visible on every update ---------------------------------------------------------

async function followEverything(lab: Lab, box = 'messages') {
  const page = lab.page;
  const chat = await openSeeded(lab);
  const picture = await png(640, 420);
  const problems: string[] = [];
  const check = async (what: string, send: () => void, until: string) => {
    const p = await update(page, send, until, box);
    if (p) problems.push(`${what}: ${p}`);
  };
  await check('a message', () => chat.say('\n\nA new reply arrives NEWREPLY'), 'NEWREPLY');
  await check('a running step', () => chat.tool('run1', 'Run the test suite RUNSTEP'), 'RUNSTEP');
  await check(
    'the step turns done with long output',
    () => chat.toolDone('run1', Array.from({ length: 90 }, (_, i) => `ok test_${i}`).join('\n')),
    'RUNSTEP',
  );
  await check(
    'a message with a long code block (clamps)',
    () => chat.say('Here is the file:\n\n```\n' + Array.from({ length: 90 }, (_, i) => `line ${i}`).join('\n') + '\n```\n\nCODEEND'),
    'CODEEND',
  );
  await check('a picture in a message', () => {
    chat.tool('pic-sep', 'Take a screenshot', 'completed');
    chat.step({ u: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: picture } } });
    chat.say('PICDONE');
  }, 'PICDONE');
  await check('a step that returned a picture', () => {
    chat.tool('shot', 'Screenshot the page', 'completed', {
      content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data: picture } }],
    });
    chat.say('After the shot SHOTDONE');
  }, 'SHOTDONE');
  for (let i = 0; i < 5; i++) chat.tool(`fold${i}`, `Check part ${i} FOLDSTEP${i}`, 'completed');
  await shown(page, 'FOLDSTEP4', box);
  await settle();
  await check('a run of 5 steps folds into "5 steps" when a message arrives', () => chat.say('All parts checked FOLDED'), 'FOLDED');
  await check('the turn ends', () => chat.end(), 'FOLDED');
  assert(!problems.length, problems.join('\n'));
}

scrollTest('1a Full view, following: every kind of update keeps the newest row fully visible, no frame off the bottom', (lab) => followEverything(lab));

scrollTest('1b Chat view, following: every kind of update keeps the newest row fully visible, no frame off the bottom', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab);
  await setView(page, 'chat');
  await assertFollowing(page, 'after switching to Chat');
  const problems: string[] = [];
  for (let k = 0; k < 3; k++) {
    let p = await update(page, () => chat.tool(`live${k}`, `Live step ${k} LIVE${k}`, 'in_progress'), `Live step ${k}`);
    if (p) problems.push(`running step ${k}: ${p}`);
    p = await update(page, () => {
      chat.toolDone(`live${k}`, 'done\n'.repeat(40));
      chat.say(`\n\nChat reply ${k} CHATREPLY${k} ` + 'words '.repeat(80));
    }, `CHATREPLY${k}`);
    if (p) problems.push(`reply ${k}: ${p}`);
  }
  assert(!problems.length, problems.join('\n'));
});

scrollTest('1c narrow window (860 px), following: updates keep the newest row fully visible', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab);
  await page.viewport(860, 800); // the sidebar folds away under 900 px, so the chat is opened first at full width
  await settle(800);
  await assertFollowing(page, 'at 860 px');
  const p1 = await update(page, () => chat.say('\n\nNarrow reply NARROW1 ' + 'words '.repeat(120)), 'NARROW1');
  const p2 = await update(page, () => chat.tool('n2', 'Narrow step NARROW2', 'in_progress'), 'NARROW2');
  assert(!p1 && !p2, [p1, p2].join('\n'));
});

// ---- 2. the list gets shorter or longer from outside: a following list stays at the bottom ------------------------------------

scrollTest('2a composer grows to 4 lines: a following list stays at the bottom and keeps following', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab);
  await page.eval('document.getElementById("prompt").focus()');
  await page.type('line one\nline two\nline three\nline four');
  await settle(500);
  await assertFollowing(page, 'composer with 4 lines');
  const p = await update(page, () => chat.say('\n\nReply while typing TYPING'), 'TYPING');
  assert(!p, p);
});

scrollTest('2b approval card pinned under a following list: it stays at the bottom and keeps following', async (lab) => {
  // Today (after you typed in the composer and cleared it, as when sending): the card takes 185 px from the list, which is left
  // 138 px above the bottom with follow switched OFF (data-paused), so later replies only light the jump button. Measured order:
  // the list shrinks, Chrome's scroll anchoring moves scrollTop (+47 px, the earlier composer change) and fires a scroll event; the
  // scroll handler (chat.js ~4642, the 48 px rule) takes it for you scrolling up and pauses; the ResizeObserver (chat.js ~4685)
  // runs after that and does nothing because the list is paused.
  const page = lab.page;
  const chat = await openSeeded(lab);
  await typeAndClear(page);
  await assertFollowing(page, 'composer typed in and cleared');
  chat.step({ ask: 'Run rm -rf build' });
  await page.waitFor('(document.getElementById("approvals").textContent || "").includes("rm -rf build")', 15000, 'approval card');
  await settle();
  await assertFollowing(page, 'approval card shown');
  const p = await update(page, () => chat.say('\n\nReply after the card CARDREPLY'), 'CARDREPLY');
  assert(!p, p);
});

scrollTest('2c two queued messages: the queue box appears and a following list stays at the bottom', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab);
  await page.eval('document.getElementById("prompt").focus()');
  for (const text of ['queued one', 'queued two']) {
    await page.type(text);
    await page.key('Enter');
    await settle(1200);
  }
  await page.waitFor('!document.getElementById("queueBox").hidden && /2 queued/.test(document.getElementById("queueBox").textContent)', 15000, '"2 queued"');
  await settle();
  await assertFollowing(page, 'queue box with 2 queued');
  const p = await update(page, () => chat.say('\n\nReply with a queue QUEUEREPLY'), 'QUEUEREPLY');
  assert(!p, p);
});

scrollTest('2d terminal dock opened and resized under a following list: it stays at the bottom and keeps following', async (lab) => {
  // Today (after typing in and clearing the composer): opening the dock leaves the list above the bottom and paused; the next reply
  // is not followed ("1 new message ↓"). Same cause as 2b: the list shrinks, a scroll event pauses it before the ResizeObserver acts.
  const page = lab.page;
  const chat = await openSeeded(lab);
  await typeAndClear(page);
  await clickHere(page, '.aib-term-toggle');
  await page.waitFor('!!document.getElementById("terminalDock") && document.getElementById("terminalDock").getBoundingClientRect().height > 50', 15000, 'terminal dock');
  await settle(1500);
  await assertFollowing(page, 'terminal dock open');
  await page.eval('document.querySelector("#terminalDock .aib-term-divider").focus()');
  for (let i = 0; i < 3; i++) await page.key('ArrowUp');
  await settle(800);
  await assertFollowing(page, 'terminal dock made 72 px taller');
  const p = await update(page, () => chat.say('\n\nReply with the terminal open TERMREPLY'), 'TERMREPLY');
  assert(!p, p);
});

scrollTest('2e window resized (shorter, then narrower, then back): a following list stays at the bottom', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab);
  for (const [w, h] of [[1600, 650], [1000, 650], [1600, 900]]) {
    await page.viewport(w, h);
    await settle(800);
    await assertFollowing(page, `window ${w}x${h}`);
  }
  const p = await update(page, () => chat.say('\n\nReply after resizing RESIZED'), 'RESIZED');
  assert(!p, p);
});

// ---- 3. scrolled up, reading: nothing moves; the jump button counts and takes you back ----------------------------------------

scrollTest('3a scrolled up: updates do not move what you read, the jump button counts them and takes you back to following', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab);
  await wheel(page, -700);
  await settle(400);
  const before = await anchor(page);
  assert(before, 'a row at the top');
  const x0 = await m(page);
  assert(x0.paused && x0.gap >= 600, `scrolled up and paused: ${JSON.stringify(x0)}`);
  await startFrames(page);
  for (let i = 0; i < 3; i++) {
    chat.tool(`r${i}`, `Step while reading ${i}`, 'completed'); // a step first: text right after text joins the same message
    chat.say(`While you read ${i} READ${i} ` + 'more words '.repeat(20));
  }
  await shown(page, 'READ2');
  await settle(1500);
  const frames = await stopFrames(page);
  const moved = frames.filter((f) => Math.abs(f.top - x0.top) > 1);
  assert(!moved.length, `scrollTop moved in ${moved.length} frames: ${[...new Set(moved.map((f) => f.top))].slice(0, 6)} (was ${x0.top})`);
  const now = await whereIs(page, before!.text);
  assert(now !== null && Math.abs(now - before!.off) <= 1, `the row you read moved from ${before!.off} to ${now}`);
  const x1 = await m(page);
  assert(x1.jump === '3 new messages ↓', `jump button says ${JSON.stringify(x1.jump)}`);
  await clickHere(page, '#jumpNew');
  await settle(800);
  await assertFollowing(page, 'after the jump button');
  const p = await update(page, () => chat.say('\n\nAfter the jump AFTERJUMP'), 'AFTERJUMP');
  assert(!p, p);
});

scrollTest('3b scrolled up, then back to the end by hand: following resumes', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab);
  await wheel(page, -700);
  await settle(300);
  chat.say('\n\nArrives while up WHILEUP');
  await shown(page, 'WHILEUP');
  await settle();
  assert((await m(page)).paused, 'paused while up');
  await wheel(page, 5000);
  await settle(500);
  await assertFollowing(page, 'scrolled back to the end');
  const p = await update(page, () => chat.say('\n\nAfter coming back BACKREPLY'), 'BACKREPLY');
  assert(!p, p);
});

scrollTest('3c keyboard only: PageUp pauses and holds the view, End resumes following', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab);
  await page.eval('const b = document.getElementById("messages"); if (!b.hasAttribute("tabindex")) b.tabIndex = -1; b.focus()');
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 });
  await settle(800);
  const x0 = await m(page);
  assert(x0.paused && x0.gap > 300, `PageUp scrolled up and paused: ${JSON.stringify(x0)}`);
  const before = await anchor(page);
  chat.say('\n\nKey reader update KEYUP');
  await shown(page, 'KEYUP');
  await settle(1200);
  const now = await whereIs(page, before!.text);
  assert(now !== null && Math.abs(now - before!.off) <= 1, `the row you read moved from ${before!.off} to ${now}`);
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  await settle(800);
  await assertFollowing(page, 'after End');
  const p = await update(page, () => chat.say('\n\nAfter End KEYEND'), 'KEYEND');
  assert(!p, p);
});

// ---- 4. opening things near the bottom: what you clicked stays put ------------------------------------------------------------

async function openStep(lab: Lab, big: boolean) {
  const page = lab.page;
  const chat = await openSeeded(lab, 20);
  const diff = (n: number) => ({
    type: 'diff',
    path: `C:/proj/src/module_${n}.ts`,
    oldText: Array.from({ length: 30 }, (_, i) => `const a${i} = ${i};`).join('\n'),
    newText: Array.from({ length: 30 }, (_, i) => `const a${i} = ${i * 2}; // changed`).join('\n'),
  });
  if (big) {
    chat.step({
      u: {
        sessionUpdate: 'tool_call',
        toolCallId: 'edit-big',
        title: 'Edit four modules OPENME',
        kind: 'edit',
        status: 'completed',
        content: [diff(1), diff(2), diff(3), diff(4)],
      },
    });
  } else chat.tool('run-open', 'Run the build OPENME', 'completed', { rawOutput: Array.from({ length: 80 }, (_, i) => `out ${i}`).join('\n') });
  await shown(page, 'OPENME');
  await settle();
  await assertFollowing(page, 'before opening');
  const sel = '#messages .tool-line .tool-toggle';
  const t0 = await topOf(page, sel);
  await clickHere(page, sel);
  await sleep(150);
  const t1 = await topOf(page, sel);
  await settle(1500);
  const t2 = await topOf(page, sel);
  const x = await m(page);
  assert(t1 === t0 && t2 === t0, `the step you opened moved: ${t0} -> ${t1} (150 ms) -> ${t2} (1.6 s)`);
  // the opened detail is below; the list is not at the bottom any more. The next update must not pull the step out of view.
  chat.say('\n\nThe next update NEXTUPDATE');
  await shown(page, 'NEXTUPDATE');
  await settle();
  const t3 = await topOf(page, sel);
  const x3 = await m(page);
  assert(
    t3 !== null && t3 >= 0 && t3 < x3.client - 20,
    `after the next update the step you opened is at ${t3} px (list ${x3.client} px tall; ${x.gap} px of detail were below the view)`,
  );
}

scrollTest('4a opening a big step at the bottom: it stays where you clicked, also when the next update arrives', (lab) => openStep(lab, true));
// 4a today: the click is followed (600 ms touch window, chat.js ~4700), but the list stays "following" (no scroll event fired, so
// data-paused is not set) with the opened detail below the view; the next update scrolls to the end (showRows followBox, chat.js
// ~1424) and the step you opened is pushed off the top of the list.

scrollTest('4b opening a small step at the bottom: it stays where you clicked, also when the next update arrives', (lab) => openStep(lab, false));

// 4c today: same cause as 4a. "Show all" opens the block in place (its top stays at 369 px), but the list keeps following with
// 1117 px below the view; the next update scrolls to the end and the block's start is 786 px above the list's top.
scrollTest('4c "Show all" on a long block at the bottom: the block stays where it was, also when the next update arrives', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab, 20);
  chat.say('Long output:\n\n```\n' + Array.from({ length: 60 }, (_, i) => `row ${i}`).join('\n') + '\n```\n');
  chat.tool('after-block', 'Short step after the block LASTSTEP', 'completed');
  await shown(page, 'LASTSTEP');
  await settle();
  // bring the "Show all" button into view by hand (a small wheel, under the 48 px pause rule is not enough: scroll so it shows)
  const btn = '#messages .clamp-toggle';
  const pre = '#messages pre.clamp-block';
  let bt = await topOf(page, btn);
  const client = (await m(page)).client;
  if (bt !== null && bt > client - 30) {
    await wheel(page, -(bt - client + 80));
    await settle(400);
    bt = await topOf(page, btn);
  }
  const p0 = await topOf(page, pre);
  await clickHere(page, btn);
  await sleep(150);
  const p1 = await topOf(page, pre);
  await settle(1500);
  const p2 = await topOf(page, pre);
  assert(
    (await page.eval('[...document.querySelectorAll("#messages .clamp-toggle")].pop().textContent')) === 'Show less',
    'the block opened',
  );
  assert(p1 === p0 && p2 === p0, `the block you opened moved: ${p0} -> ${p1} (150 ms) -> ${p2} (1.6 s)`);
  chat.say('\n\nThe next update NEXTAFTERSHOW');
  await shown(page, 'NEXTAFTERSHOW');
  await settle();
  const p3 = await topOf(page, pre);
  const x3 = await m(page);
  assert(p3 !== null && p3 > -x3.client && p3 < x3.client, `after the next update the opened block starts at ${p3} px`);
});

scrollTest('4d "Show steps" in the Chat view at the bottom: the fold stays where you clicked, also when the next update arrives', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab, 12);
  for (let i = 0; i < 6; i++) chat.tool(`fold-${i}`, `Fold step ${i}`, 'completed');
  chat.say('After the steps FOLDEND');
  await shown(page, 'FOLDEND');
  await setView(page, 'chat');
  await assertFollowing(page, 'Chat view');
  const sel = '#messages .steps-toggle';
  const t0 = await topOf(page, sel);
  await clickHere(page, sel);
  await sleep(150);
  const t1 = await topOf(page, sel);
  await settle(1500);
  const t2 = await topOf(page, sel);
  assert(t1 === t0 && t2 === t0, `the fold you opened moved: ${t0} -> ${t1} (150 ms) -> ${t2} (1.6 s)`);
  chat.say('\n\nNext update SHOWSTEPSNEXT');
  await shown(page, 'SHOWSTEPSNEXT');
  await settle();
  const t3 = await topOf(page, sel);
  const x3 = await m(page);
  assert(t3 !== null && t3 >= 0 && t3 < x3.client - 20, `after the next update the fold is at ${t3} px (list ${x3.client} px)`);
});

// ---- 5. "Show earlier" ---------------------------------------------------------------------------------------------------------

scrollTest('5 "Show earlier" adds older rows above without moving the row you are looking at', async (lab) => {
  const page = lab.page;
  const chat = await lab.chat();
  await chat.start();
  for (let i = 0; i < 90; i++) {
    chat.say(`Old ${i}\n\n`);
    chat.tool(`old${i}`, `Old step ${i}`, 'completed');
  }
  chat.say('EARLYEND');
  await lab.select(chat);
  await shown(page, 'EARLYEND');
  await settle();
  await page.waitFor('!!document.querySelector("#messages .show-earlier")', 5000, 'Show earlier button');
  await page.eval('document.getElementById("messages").scrollTop = 0');
  await settle(400);
  const row = await page.eval<{ text: string; off: number }>(`(() => {
    const b = document.getElementById('messages'), e = b.querySelector('.show-earlier').nextElementSibling;
    return { text: e.textContent.replace(/\\s+/g, ' ').slice(0, 80), off: Math.round(e.getBoundingClientRect().top - b.getBoundingClientRect().top) };
  })()`);
  await clickHere(page, '#messages .show-earlier');
  await settle(1000);
  const now = await whereIs(page, row.text);
  assert(now !== null && Math.abs(now - row.off) <= 1, `the row under the button moved from ${row.off} to ${now}`);
  chat.say('\n\nUpdate after earlier EARLYNEXT');
  await shown(page, 'EARLYNEXT');
  await settle(1200);
  const again = await whereIs(page, row.text);
  assert(again !== null && Math.abs(again - row.off) <= 1, `after the next update it moved from ${row.off} to ${again}`);
});

// ---- 6. switching chats and views, unread, reload -------------------------------------------------------------------------------

scrollTest('6a opening a chat with unread messages lands on the "New" line', async (lab) => {
  // Today: no "New" line, the chat opens at the bottom. openConversation (chat.js ~1001) calls renderConversations() before the
  // first draw; AgentSidebarUI.sync -> markViewed (sidebar-ui.js ~252/283) marks the chat seen up to Date.now() because holdSeen
  // reads the box's paused flag, which the new chat has not set yet. placeNewLine (chat.js ~4600) then finds nothing unread.
  const page = lab.page;
  const a = await openSeeded(lab, 20);
  const b = await lab.chat();
  await b.start();
  b.say('The other chat OTHER');
  await lab.select(b);
  await shown(page, 'OTHER');
  await settle();
  a.tool('away1', 'Step while away', 'completed');
  a.say('Unread one UNREAD1 ' + 'words '.repeat(60));
  a.tool('away2', 'Second step while away', 'completed');
  a.say('Unread two UNREAD2');
  await settle(3500); // two polls of the conversation list
  await lab.select(a);
  await shown(page, 'UNREAD2');
  await settle();
  const line = await page.eval<number | null>(
    '(() => { const l = document.querySelector("#messages > .new-line"); return l ? Math.round(l.getBoundingClientRect().top - document.getElementById("messages").getBoundingClientRect().top) : null; })()',
  );
  const x = await m(page);
  assert(line !== null, `no "New" line (list at scrollTop ${x.top}, ${x.gap} px from the bottom)`);
  assert(line >= 0 && line < 60, `the "New" line is at ${line} px, not at the top of the view`);
  assert(x.paused, 'the list is paused on the New line');
});

scrollTest('6b switching to another chat and back: a following chat is still at the bottom and following', async (lab) => {
  const page = lab.page;
  const a = await openSeeded(lab, 20);
  const b = await lab.chat();
  await b.start();
  seed(b, 20, 'Other');
  b.say('Other chat end OTHEREND');
  await lab.select(b);
  await shown(page, 'OTHEREND');
  await settle();
  await assertFollowing(page, 'the other chat');
  await lab.select(a);
  await settle();
  await assertFollowing(page, 'back in the first chat');
  const p = await update(page, () => a.say('\n\nBack in the first chat FIRSTBACK'), 'FIRSTBACK');
  assert(!p, p);
});

scrollTest('6c switching Full / Chat / Prompts at the bottom stays at the bottom and keeps following', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab, 20);
  for (const v of ['chat', 'prompts', 'full'] as const) {
    await setView(page, v);
    await assertFollowing(page, `at the bottom, switched to ${v}`);
  }
  await setView(page, 'chat');
  const p = await update(page, () => chat.say('\n\nIn the Chat view VIEWREPLY'), 'VIEWREPLY');
  assert(!p, p);
});

// 6d today: scrolled 900 px up from the end of a 60-step turn ("Read seed file 42" at the top), Full -> Chat lands on the turn's
// prompt at scrollTop 22 (4800 px from the end) and Chat -> Full stays there. views-ui.js anchorOf (~395) keeps only the prompt that
// owns the top row (offset 0 unless the prompt itself is the top row) and restoreAnchor (~408) puts that prompt at the top.
scrollTest('6d scrolled up mid-turn, Full -> Chat -> Full brings you back to the row you were reading', async (lab) => {
  const page = lab.page;
  await openSeeded(lab, 60);
  await wheel(page, -900);
  await settle(400);
  const before = await anchor(page);
  const x0 = await m(page);
  await setView(page, 'chat');
  const inChat = await m(page);
  await setView(page, 'full');
  const now = await whereIs(page, before!.text);
  const x1 = await m(page);
  assert(
    now !== null && Math.abs(now - before!.off) <= 2,
    `"${before!.text.slice(0, 40)}" was at ${before!.off} px (scrollTop ${x0.top}); after Chat (scrollTop ${inChat.top}) and back it is at ${now} (scrollTop ${x1.top})`,
  );
});

scrollTest('6e reload at the bottom: the chat comes back at the bottom and follows', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab, 20);
  await page.goto(`http://127.0.0.1:${lab.web.port}/chat.html`);
  await shown(page, 'SEEDEND', 'messages', 20000);
  await settle(1500);
  await assertFollowing(page, 'after reload');
  const p = await update(page, () => chat.say('\n\nAfter reload RELOADREPLY'), 'RELOADREPLY');
  assert(!p, p);
});

// ---- 7. the subagent view (#submessages) -----------------------------------------------------------------------------------------

async function openSubagent(lab: Lab): Promise<(step: Record<string, unknown>) => void> {
  const page = lab.page;
  const chat = await lab.chat();
  await chat.start();
  chat.say('Starting a helper');
  chat.step({ u: { sessionUpdate: 'tool_call', toolCallId: 'agent-1', title: 'Agent', kind: 'think', status: 'pending', _meta: { claudeCode: { toolName: 'Agent' } } } });
  chat.step({ u: { sessionUpdate: 'subagent_update', sessionId: 'child-1', title: 'Review the code', capabilities: { cancel: {} }, state: { state: 'running' } } });
  const child = (u: Record<string, unknown>) => chat.step({ sid: 'child-1', u: { ...u, _meta: { claudeCode: { parentToolUseId: 'agent-1' } } } });
  for (let i = 0; i < 25; i++) {
    child({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Child message ${i}. ` + 'Helper words. '.repeat(15) + '\n\n' } });
    child({ sessionUpdate: 'tool_call', toolCallId: `c${i}`, title: `Child read ${i}`, kind: 'read', status: 'completed' });
  }
  await lab.select(chat);
  await page.waitFor(`!!document.querySelector('#subagentList button[data-key="child-1"]')`, 15000, 'subagent card');
  await clickHere(page, '#subagentList button[data-key="child-1"]');
  await shown(page, 'Child read 24', 'submessages');
  await settle();
  return child;
}

scrollTest('7a subagent view, following: live subagent steps and messages keep its newest row visible, no frame off the bottom', async (lab) => {
  const page = lab.page;
  const child = await openSubagent(lab);
  await assertFollowing(page, 'subagent view open', 'submessages');
  const problems: string[] = [];
  for (let k = 0; k < 3; k++) {
    let p = await update(page, () => child({ sessionUpdate: 'tool_call', toolCallId: `x${k}`, title: `Child step SUBSTEP${k}`, kind: 'execute', status: 'in_progress' }), `SUBSTEP${k}`, 'submessages');
    if (p) problems.push(`running step ${k}: ${p}`);
    p = await update(page, () => {
      child({ sessionUpdate: 'tool_call_update', toolCallId: `x${k}`, status: 'completed', rawOutput: 'o\n'.repeat(40) });
      child({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n\nChild reply SUBREPLY${k}\n\n\`\`\`\n` + 'code\n'.repeat(50) + '```\n' } });
    }, `SUBREPLY${k}`, 'submessages');
    if (p) problems.push(`reply ${k}: ${p}`);
  }
  assert(!problems.length, problems.join('\n'));
});

scrollTest('7b subagent view, scrolled up: updates do not move what you read; back at the end it follows again', async (lab) => {
  const page = lab.page;
  const child = await openSubagent(lab);
  await wheel(page, -600, 'submessages');
  await settle(300);
  const before = await anchor(page, 'submessages');
  const x0 = await m(page, 'submessages');
  assert(x0.paused, 'paused');
  child({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n\nWhile up SUBWHILEUP' } });
  await shown(page, 'SUBWHILEUP', 'submessages');
  await settle(1200);
  const now = await whereIs(page, before!.text, 'submessages');
  assert(now !== null && Math.abs(now - before!.off) <= 1, `the row you read moved from ${before!.off} to ${now}`);
  await wheel(page, 5000, 'submessages');
  await settle(400);
  await assertFollowing(page, 'back at the end', 'submessages');
  const p = await update(page, () => child({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n\nAfter coming back SUBBACK' } }), 'SUBBACK', 'submessages');
  assert(!p, p);
});

// ---- 8. real wheel input (Input.dispatchMouseEvent mouseWheel) while updates stream ----------------------------------------------

/** Record scrollTop every frame while `n` updates arrive; returns the distinct scrollTop values seen and the end state. */
async function streamWhileReading(page: Page, chat: Chat, n: number, tag: string, small = false) {
  await startFrames(page);
  for (let i = 0; i < n; i++) {
    if (small) chat.say(` ${tag}${i}`); // the same message grows by a word: the list barely gets taller
    else {
      chat.tool(`${tag}-t${i}`, `Step ${tag} ${i}`, 'completed');
      chat.say(`Reply ${tag}${i} ` + 'words '.repeat(20));
    }
    await shown(page, `${tag}${i}`);
    await settle(700);
  }
  await settle(800);
  const frames = await stopFrames(page);
  return { tops: [...new Set(frames.map((f) => f.top))], resumed: frames.filter((f) => !f.paused).length, end: await m(page) };
}

scrollTest('8a one wheel notch up while updates stream: follow stops at once and nothing pulls you back down', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab);
  await wheel(page, -100);
  await settle(300);
  const x0 = await m(page);
  assert(x0.paused && x0.gap >= 90, `one notch up pauses: ${JSON.stringify(x0)}`);
  const r = await streamWhileReading(page, chat, 3, 'NOTCH');
  assert(r.tops.length === 1 && r.tops[0] === x0.top, `scrollTop moved while reading: ${x0.top} -> ${r.tops.join(', ')}`);
  assert(r.resumed === 0 && r.end.paused, `follow came back on in ${r.resumed} frames`);
  assert(r.end.jump === '3 new messages ↓', `jump button: ${JSON.stringify(r.end.jump)}`);
});

scrollTest('8b small smooth-scroll ticks up (15 px each, 45 px total) stop following; small in-place growth does not resume it', async (lab) => {
  // Before beta.8: three 15 px ticks pause the list at 45 px from the bottom, then the first redraw turns follow back on (273 of the
  // recorded frames unpaused) and the list ends at the bottom (gap 0) although you never scrolled there.
  // The owner's bug class: an upward scroll that ends within 48 px of the bottom. resumeIfAtEnd (chat.js ~4741) still uses the old
  // 48 px rule after each redraw, so if a redraw leaves the gap at 2..48 px, follow comes back on without you reaching the bottom.
  const page = lab.page;
  const chat = await openSeeded(lab);
  for (let i = 0; i < 3; i++) await wheel(page, -15);
  await settle(300);
  const x0 = await m(page);
  assert(x0.paused && x0.gap >= 40 && x0.gap <= 48, `three 15 px ticks up: paused, 40-48 px from the bottom: ${JSON.stringify(x0)}`);
  const r = await streamWhileReading(page, chat, 3, 'TICK', true);
  assert(r.resumed === 0 && r.end.paused, `follow came back on in ${r.resumed} frames (end: ${JSON.stringify(r.end)})`);
  assert(r.tops.length === 1 && r.tops[0] === x0.top, `scrollTop moved: ${x0.top} -> ${r.tops.join(', ')}`);
  // one more real step after that must not pull the list down either
  const r2 = await streamWhileReading(page, chat, 1, 'TICKSTEP');
  assert(r2.tops.length === 1 && r2.tops[0] === x0.top && r2.end.paused, `then a new step moved the list: ${r2.tops.join(', ')}`);
});

/** Updates every 100-200 ms (the message grows by a word; every fourth update is a new step) until stop() is called. */
function pump(chat: Chat, tag: string) {
  let on = true, n = 0;
  const done = (async () => {
    while (on) {
      if (n % 4 === 3) chat.tool(`${tag}-s${n}`, `Fast step ${tag} ${n}`, 'completed');
      else chat.say(` ${tag}${n}`);
      n++;
      await sleep(n % 2 ? 100 : 200);
    }
  })();
  return async () => {
    on = false;
    await done;
    return n;
  };
}

/** While updates stream: from `from` on, the frames must stay paused and still at one scrollTop (what you scrolled to). */
async function heldWhileStreaming(page: Page, what: string, gesture: () => Promise<void>, chat: Chat, tag: string) {
  const stop = pump(chat, tag);
  await settle(600); // streaming at the bottom first
  await assertFollowing(page, `${what}: following while updates stream`);
  await gesture();
  await settle(300); // the scroll itself is over
  const x0 = await m(page);
  assert(x0.paused && x0.gap > 1, `${what}: paused above the bottom: ${JSON.stringify(x0)}`);
  await startFrames(page);
  await settle(2000);
  const frames = await stopFrames(page);
  const n = await stop();
  const tops = [...new Set(frames.map((f) => f.top))], resumed = frames.filter((f) => !f.paused).length;
  assert(resumed === 0, `${what}: follow came back on in ${resumed}/${frames.length} frames (${n} updates)`);
  assert(tops.length === 1 && tops[0] === x0.top, `${what}: scrollTop moved while updates streamed: ${x0.top} -> ${tops.join(', ')}`);
}

scrollTest('8b2 one real 100 px wheel notch up while updates stream every 100-200 ms: follow stops and stays off', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab);
  await heldWhileStreaming(page, 'one 100 px notch', () => wheel(page, -100), chat, 'FASTNOTCH');
});

scrollTest('8b3 smooth scroll (one wheel event, then the list moves up in small steps) while updates stream: follow stays off', async (lab) => {
  // A smooth scroll: the wheel event arrives while the list is still at the bottom (0 px), and the list moves on the next frames.
  // An update drawn in between must not take the 0 px for "you are back at the bottom" (resumeIfAtEnd ignored _userUp).
  const page = lab.page;
  const chat = await openSeeded(lab);
  await heldWhileStreaming(
    page,
    'smooth scroll',
    async () => {
      await page.eval(`(() => {
        const box = document.getElementById('messages');
        box.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
        // like Chrome's own animation, the scroll gives up if the page moves the list itself in between (a jump to the end)
        return new Promise((done) => {
          let k = 0, expect = box.scrollTop;
          const step = () => {
            if (k++ === 0) return setTimeout(() => requestAnimationFrame(step), 180); // an update lands before the list moves
            if (Math.abs(box.scrollTop - expect) > 1) return done(false);
            box.scrollTop -= 12;
            expect = box.scrollTop;
            if (k <= 10) requestAnimationFrame(step);
            else done(true);
          };
          requestAnimationFrame(step);
        });
      })()`);
    },
    chat,
    'SMOOTH',
  );
});

scrollTest('8c scrolling back down partway (not to the bottom) stays paused; updates do not move the list', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab);
  await wheel(page, -600);
  await settle(300);
  await wheel(page, 300);
  await wheel(page, 280);
  await settle(300);
  const x0 = await m(page);
  assert(x0.paused && x0.gap >= 10, `partway back down: still paused, ${x0.gap} px from the bottom: ${JSON.stringify(x0)}`);
  const r = await streamWhileReading(page, chat, 2, 'PART');
  assert(r.tops.length === 1 && r.tops[0] === x0.top && r.end.paused, `the list moved or resumed: ${r.tops.join(', ')} ${JSON.stringify(r.end)}`);
});

scrollTest('8d wheeling down to the very bottom resumes following', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab);
  await wheel(page, -600);
  await settle(300);
  chat.tool('wd', 'Arrives while up', 'completed');
  chat.say('Arrives while up WHEELUP');
  await shown(page, 'WHEELUP');
  await settle();
  assert((await m(page)).paused, 'paused while up');
  for (let i = 0; i < 8; i++) await wheel(page, 120);
  await settle(500);
  await assertFollowing(page, 'wheeled down to the bottom');
  const p = await update(page, () => chat.say('\n\nAfter wheeling down WHEELDOWN'), 'WHEELDOWN');
  assert(!p, p);
});

async function jumpButton(lab: Lab, words: number) {
  const page = lab.page;
  const chat = await openSeeded(lab);
  await wheel(page, -800);
  await settle(300);
  for (let i = 0; i < 2; i++) {
    chat.tool(`j${i}`, `Jump step ${i}`, 'completed');
    chat.say(`Jump reply ${i} JUMP${i} ` + 'words '.repeat(words));
  }
  await shown(page, 'JUMP1');
  await settle();
  assert((await m(page)).jump === '2 new messages ↓', `button: ${(await m(page)).jump}`);
  await clickHere(page, '#jumpNew');
  await settle(600);
  return chat;
}

scrollTest('8e jump button, long unread part: "2 new messages ↓" puts the New line at the top, then "↓ Latest" goes to the end and follows', async (lab) => {
  const page = lab.page;
  const chat = await jumpButton(lab, 400);
  const line = await topOf(page, '#messages > .new-line');
  const x1 = await m(page);
  assert(line !== null && line >= 0 && line <= 20, `first click puts the New line at the top: ${line} (${JSON.stringify(x1)})`);
  assert(x1.paused && x1.jump === '↓ Latest', `then the button reads "↓ Latest": ${JSON.stringify(x1)}`);
  await clickHere(page, '#jumpNew');
  await settle(600);
  await assertFollowing(page, 'after "↓ Latest"');
  const p = await update(page, () => chat.say('\n\nAfter Latest AFTERLATEST'), 'AFTERLATEST');
  assert(!p, p);
});

scrollTest('8f jump button, short unread part: one click reaches the end, the button goes and following is back', async (lab) => {
  const page = lab.page;
  const chat = await jumpButton(lab, 20);
  await assertFollowing(page, 'after one click (the unread part fits on screen)');
  const x = await m(page);
  assert(x.jump === null, `the button is gone: ${JSON.stringify(x.jump)}`);
  const p = await update(page, () => chat.say('\n\nAfter the click SHORTJUMP'), 'SHORTJUMP');
  assert(!p, p);
});

// ---- 9. a saved chat another program is writing (no live connection: /api/transcript every 1.5 s) ------------------------------

async function openSavedGrowing(lab: Lab) {
  const s = lab.savedChat('saved-scroll-1');
  s.user('Please look at the code');
  for (let i = 0; i < 30; i++) {
    s.say(`Saved message ${i}. ` + 'Some words to fill a line or two. '.repeat(6));
    s.tool('Read', { file_path: `C:/proj/src/file_${i}.ts` }, 'content\n'.repeat(5));
  }
  s.say('SAVEDEND');
  await lab.page.waitFor(`!!document.querySelector('button.connection[data-key="${s.key}"]')`, 20000, 'saved chat in the sidebar');
  await lab.select(s);
  await shown(lab.page, 'SAVEDEND', 'messages', 20000);
  await settle(2000);
  return s;
}

scrollTest('9a saved chat being written, following: long output and code blocks keep the newest row visible, no frame off the bottom', async (lab) => {
  const page = lab.page;
  const s = await openSavedGrowing(lab);
  await assertFollowing(page, 'saved chat open');
  const problems: string[] = [];
  for (let k = 0; k < 3; k++) {
    const p = await update(page, () => {
      if (k === 0) s.tool('Bash', { command: 'pytest -q' }, Array.from({ length: 90 }, (_, i) => `ok test_${i}`).join('\n'));
      s.say(`Growing ${k} SAVEDGROW${k}\n\n\`\`\`\n` + 'code line\n'.repeat(60) + '```\n');
    }, `SAVEDGROW${k}`, 'messages', 2000);
    if (p) problems.push(`update ${k}: ${p}`);
  }
  assert(!problems.length, problems.join('\n'));
});

scrollTest('9b saved chat being written, scrolled up: new rows do not move what you read', async (lab) => {
  const page = lab.page;
  const s = await openSavedGrowing(lab);
  await wheel(page, -800);
  await settle(400);
  const before = await anchor(page);
  const x0 = await m(page);
  await startFrames(page);
  s.say('While you read SAVEDWHILEUP');
  await shown(page, 'SAVEDWHILEUP', 'messages', 20000);
  await settle(2000);
  const frames = await stopFrames(page);
  const tops = [...new Set(frames.map((f) => f.top))];
  assert(tops.length === 1 && tops[0] === x0.top, `scrollTop moved: ${x0.top} -> ${tops.join(', ')}`);
  const now = await whereIs(page, before!.text);
  assert(now !== null && Math.abs(now - before!.off) <= 1, `the row you read moved from ${before!.off} to ${now}`);
});

'use strict';
// The bugs the README screenshots showed (branch fix/screenshot-findings), one block per fix. Fake DOM or plain module loads,
// no browser; the layout fixes (6, 7) were also measured in headless Chrome against a demo Studio.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { APP } = require('./_paths');
const D = require('./fake_dom.js');

/* tool-views.js + inbox-reply.js in one context (the inbox asks ToolViews how to name an approval, as the page does). */
function toolViews() {
  const window = {};
  const document = { createElement: () => ({ append() {}, classList: { add() {} }, setAttribute() {} }) };
  const ctx = vm.createContext({ window, document, URL, console });
  for (const f of ['markdown.js', 'tool-views.js', 'inbox-reply.js'])
    vm.runInContext(fs.readFileSync(path.join(APP, f), 'utf8'), ctx);
  return { TV: window.ToolViews, Rp: window.AgentInboxReply };
}

// ---- 1. approval card and inbox: the command itself ---------------------------------------------------------------------
test('1. an approval names the action plainly: verb, the command / path / URL in a code box, the description beside it', () => {
  const { TV, Rp } = toolViews();
  const stripe = {
    toolCallId: 'stripe-install',
    title: 'npm install stripe@18.0.0',
    kind: 'execute',
    rawInput: { command: 'npm install stripe@18.0.0', description: 'Upgrade the Stripe SDK to v18' },
  };
  const a = TV.actionOf(stripe);
  assert.deepEqual(
    [a.verb, a.target, a.code, a.note, a.line],
    ['Run', 'npm install stripe@18.0.0', true, 'Upgrade the Stripe SDK to v18', 'Run npm install stripe@18.0.0'],
  );
  // The inbox row says the same, not "Permission".
  assert.equal(Rp.permissionTitle({ key: 'p1', params: { toolCall: stripe } }), 'Run npm install stripe@18.0.0');
  const cases = [
    // Codex sends argv with a shell wrapper: the script is what runs.
    [{ kind: 'execute', title: 'bash', rawInput: { command: ['bash', '-lc', 'pytest -q'] } }, 'Run pytest -q'],
    [{ kind: 'execute', title: 'git status' }, 'Run git status'], // no input: the title is the command
    [
      {
        kind: 'edit',
        title: 'Edit totals.ts',
        rawInput: { file_path: '/r/src/totals.ts', old_string: 'a', new_string: 'b' },
      },
      'Edit /r/src/totals.ts',
    ],
    [
      {
        kind: 'edit',
        rawInput: { file_path: '/r/new.ts', content: 'x' },
        _meta: { claudeCode: { toolName: 'Write' } },
      },
      'Write /r/new.ts',
    ],
    [{ kind: 'delete', title: 'Delete old.log', rawInput: { path: '/r/old.log' } }, 'Delete /r/old.log'],
    [
      { kind: 'move', title: 'Move', rawInput: { source: '/r/a.ts', destination: '/r/b.ts' } },
      'Move /r/a.ts → /r/b.ts',
    ],
    [{ kind: 'read', title: 'Read', locations: [{ path: '/r/README.md' }] }, 'Read /r/README.md'],
    [
      { kind: 'search', title: 'grep', rawInput: { pattern: 'toFixed' }, _meta: { claudeCode: { toolName: 'Grep' } } },
      'Search toFixed',
    ],
    [
      { kind: 'fetch', title: 'Fetch docs', rawInput: { url: 'https://example.com/docs' } },
      'Fetch https://example.com/docs',
    ],
    [{ kind: 'switch_mode', title: 'Leave plan mode', rawInput: { mode: 'default' } }, 'Switch mode default'],
    [{ kind: 'think', title: 'Plan the change' }, 'Think Plan the change'],
    [{ kind: 'other', title: 'mcp__linear__create_issue' }, 'mcp__linear__create_issue'],
    [{}, 'A tool'],
  ];
  for (const [call, line] of cases) assert.equal(TV.actionOf(call).line, line, JSON.stringify(call));
  assert.equal(TV.actionOf(cases[0][0]).code, true);
  assert.equal(TV.actionOf({ kind: 'other', title: 'x' }).code, false);
});

test('1. the approval card draws the action in a code box with the description under it (chat.js approvalDetail)', () => {
  const src = fs.readFileSync(path.join(APP, 'chat.js'), 'utf8');
  const body = src.slice(src.indexOf('function approvalDetail('), src.indexOf('function renderApprovals('));
  assert.match(body, /ToolViews\.actionOf\(call\)/);
  assert.match(body, /act\.code \? 'code' : 'span', act\.target, 'approval-target'/);
  assert.match(body, /'approval-note'/);
  assert.match(body, /'Details'/); // the raw request is still there, folded
  const css = fs.readFileSync(path.join(APP, 'chat.css'), 'utf8');
  assert.match(css, /code\.approval-target \{[^}]*background: var\(--code-bg\)/);
});

// ---- 2. New chat: nothing of the chat we left -----------------------------------------------------------------------------
test('2. New chat feeds the chat panels (Changes chip, Merge / Discard, Files, Artifacts) with no chat before drawing', () => {
  const src = fs.readFileSync(path.join(APP, 'chat.js'), 'utf8');
  const show = src.slice(src.indexOf('  function showNewChat('), src.indexOf('  let newBranch ='));
  assert.ok(show.includes('selected = null;') && show.includes('syncChatPanels();'), 'showNewChat syncs the panels');
  assert.ok(show.indexOf('selected = null;') < show.indexOf('syncChatPanels();'), 'after the chat is let go');
  const panels = src.slice(src.indexOf('  function syncChatPanels('), src.indexOf('  function renderHeaderBody('));
  assert.match(panels, /AgentChangesUI\?\.sync\(\s*selected && \(current \|\| selected\.id\)/);
  assert.match(panels, /AgentFilesUI\?\.sync\(selected/);
  // And ChangesUI drops a chat's data and Merge / Discard when it is fed no chat.
  const C = require(path.join(APP, 'changes-ui.js'));
  assert.equal(typeof C.sync, 'function');
});

// ---- 3. the model label ---------------------------------------------------------------------------------------------------
test('3. the Default row never wraps a name that already says Default', () => {
  const A = require(path.join(APP, 'agent-choice.js'));
  const list = (name) => ({ current: 'm', choices: [{ value: 'm', name }] });
  assert.equal(A.defaultLabel(list('Default (recommended)')), 'Default (recommended)');
  assert.equal(A.defaultLabel(list('Default')), 'Default');
  assert.equal(A.defaultLabel(list('default model')), 'default model');
  assert.equal(A.defaultLabel(list('Sonnet 4.5')), 'Default (Sonnet 4.5)');
  assert.equal(A.defaultLabel(list('Defaultish')), 'Default (Defaultish)');
  assert.equal(A.defaultLabel({ current: '', choices: [] }), 'Default');
  assert.equal(A.defaultLabel(null), 'Default');
  const src = fs.readFileSync(path.join(APP, 'chat.js'), 'utf8');
  assert.ok(!src.includes("'Default (' + hit.name"), 'chat.js wraps the name itself again');
});

// ---- 4. tool rows: the project, not the copy folder ----------------------------------------------------------------------
test("4. tool rows name places in the project's words, never AIB's chat-1a2b3c4d copy folder", () => {
  const { TV } = toolViews();
  const copy = 'C:\\Users\\me\\AppData\\Local\\AgentStudio\\worktrees\\09391fd1ba\\chat-c1fb614c';
  const grep = (p) => ({
    role: 'tool',
    raw: {
      kind: 'search',
      status: 'completed',
      rawInput: { pattern: 'toFixed', path: p },
      _meta: { claudeCode: { toolName: 'Grep' } },
    },
  });
  // Nobody taught the copy yet (a mirrored chat): AIB's layout is still recognised.
  assert.equal(TV.summarize(grep(copy)).text, "Searched 'toFixed' in the project");
  assert.equal(TV.summarize(grep(copy + '\\src\\checkout')).text, "Searched 'toFixed' in src/checkout");
  TV.notePlace(copy, 'storefront');
  TV.notePlace('C:\\code\\storefront', 'storefront');
  assert.equal(TV.summarize(grep(copy)).text, "Searched 'toFixed' in storefront");
  assert.equal(TV.summarize(grep('C:/code/storefront/src')).text, "Searched 'toFixed' in src");
  assert.equal(TV.summarize(grep('/elsewhere/lib')).text, "Searched 'toFixed' in lib"); // outside: the last part, as before
  // An agent's own title with the folder in it (Codex writes one).
  const titled = {
    role: 'tool',
    raw: { kind: 'search', status: 'completed', title: 'Search toFixed in ' + copy + '\\src' },
  };
  assert.equal(TV.summarize(titled).text, 'Search toFixed in src');
  const root = { role: 'tool', raw: { kind: 'read', status: 'completed', title: 'List ' + copy } };
  assert.equal(TV.summarize(root).text, 'List storefront');
  assert.ok(!/chat-c1fb614c/.test(TV.actionOf({ kind: 'search', rawInput: { pattern: 'x', path: copy } }).line));
});

// ---- 5. the terminal follows the theme --------------------------------------------------------------------------------------
test('5. the terminal takes the active theme when made, when shown, and on every switch (sign-in terminals too)', () => {
  const shell = D.page({ ids: ['chat'] });
  let tokens = { '--term-bg': '#0e0f13', '--term-fg': '#edeae2' };
  shell.window.getComputedStyle = () => ({ getPropertyValue: (n) => tokens[n] || '' });
  const ctx = D.load(shell, ['terminal-ui.js']);
  const T = ctx.AibTerminal;
  assert.equal(T.pageTheme().background, '#0e0f13');
  tokens = { '--term-bg': '#f6f8fa', '--term-fg': '#1f2328' }; // GitHub-style light
  const theme = T.retheme(true);
  assert.deepEqual([theme.background, theme.foreground], ['#f6f8fa', '#1f2328']);
  // A token in another colour form reaches xterm as a plain colour (the page's canvas resolves it); without a canvas it passes.
  assert.equal(T.plainColour('#abcdef'), '#abcdef');
  assert.equal(T.plainColour(' rgb(1, 2, 3) '), 'rgb(1, 2, 3)');
  const src = fs.readFileSync(path.join(APP, 'terminal-ui.js'), 'utf8');
  assert.match(src, /signinTerms\.add\(term\)/);
  assert.match(src, /for \(const t of signinTerms\) if \(t && t\.options\) t\.options\.theme = theme;/);
  assert.match(
    src,
    /function show\(cur\) \{\s*const e = entryFor\(cur\);\s*e\.visible = true;\s*if \(e\.term && e\.term\.options\) e\.term\.options\.theme = pageTheme\(\);/,
  );
  assert.match(src, /attributeFilter: \['class', 'style', 'data-theme'\]/);
});

// ---- 6. the pinned question card and the plan ---------------------------------------------------------------------------------
// The main list's scroll position is owned by scroll-controller.js (its own tests: test_scroll_controller.js). These keep the
// three screenshot fixes in its terms, on the same small fake layout.
const { setup: scrollList, rows: scrollRows } = require('./scroll_fake.js');

test('6. a message list that follows the newest row keeps following when a pinned card or the terminal shrinks it', () => {
  const { box, ctl, ro } = scrollList(scrollRows(10, 60), { clientHeight: 465 });
  ctl.afterRedraw();
  assert.equal(box.gap, 0);
  box.clientHeight = 157; // the question card / the terminal dock takes the room
  ro.fire();
  assert.equal(box.gap, 0, 'following: back at the newest row before paint');
  assert.equal(ctl.following, true);
  box.userScroll(40); // scrolled up to read
  box.clientHeight = 120;
  ro.fire();
  assert.equal(box.scrollTop, 40, 'reading: left where you are');
});

test('6b. a message list that follows keeps following when its content grows after a redraw; not what you just opened', () => {
  const { box, ctl, ro } = scrollList(scrollRows(10, 60), { clientHeight: 400 });
  ctl.afterRedraw();
  box.children[9].h = 90; // a "Show all" toggle came in, a picture loaded: the last row grew
  ro.fire();
  assert.equal(box.gap, 0);
  box.userScroll(50);
  box.children[9].h = 200;
  ro.fire();
  assert.equal(box.scrollTop, 50, 'scrolled up to read: left alone');
  box.userScroll(box.scrollHeight); // back at the end
  const row = box.children[8],
    at = row.getBoundingClientRect().top;
  const toggle = { tagName: 'BUTTON', parentElement: row, getAttribute: (k) => (k === 'aria-expanded' ? 'false' : null) };
  toggle.closest = () => toggle;
  box.fire('click', { target: toggle }); // you opened a step near the end
  row.h = 500;
  ro.fire();
  assert.equal(row.getBoundingClientRect().top, at, 'what you opened stays where you clicked it');
});

// ---- 7. sidebar titles get the card's room --------------------------------------------------------------------------------------
test('7. a title the age would cut gets line 1 to itself, the age moves to the end of line 2; one that fits is left', () => {
  const S = require(path.join(APP, 'sidebar-ui.js'));
  const card = (need, avail) => {
    const cls = new Set(['connection']);
    const title = {
      get clientWidth() {
        return cls.has('age-low') ? avail + 29 : avail;
      },
      scrollWidth: need,
    };
    const kids = { '.connection-title': title, '.row-age': {}, '.row-status': {} };
    return {
      cls,
      classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
      querySelector: (sel) => kids[sel.replace(':scope > ', '')] || null,
    };
  };
  const cards = [card(170, 156), card(101, 156), card(156, 156)];
  cards[1].cls.add('age-low'); // left over from a longer title: measured again from scratch
  const box = { querySelectorAll: () => cards };
  assert.equal(S.fitTitles(box), 1);
  assert.deepEqual(
    cards.map((c) => c.cls.has('age-low')),
    [true, false, false],
  );
  const css = fs.readFileSync(path.join(APP, 'workspace.css'), 'utf8');
  assert.match(css, /aside \.connection\.age-low \.connection-title \{\s*flex: 1 1 calc\(100% - 22px\);/);
  assert.match(css, /aside \.connection\.age-low \.row-age \{\s*order: 4;/);
  const chat = fs.readFileSync(path.join(APP, 'chat.js'), 'utf8');
  assert.match(chat, /AgentSidebarUI\?\.watchTitles\?\.\(box\)/);
});

test('6c. one wheel notch up stops following at once; following resumes only at the very bottom', () => {
  const { box, ctl } = scrollList(scrollRows(20, 100), { clientHeight: 400 });
  ctl.afterRedraw();
  box.fire('wheel', { deltaY: -100 }); // one notch up: following stops before the list moves
  assert.equal(box.dataset.paused, '1');
  box.userScroll(box.scrollTop - 30); // the notch ends 30 px from the bottom
  assert.equal(box.dataset.paused, '1', 'still paused 30 px from the bottom after your own scroll up');
  box.userScroll(box.scrollTop + 5);
  assert.equal(box.dataset.paused, '1', 'down, but not all the way: still paused');
  box.userScroll(box.scrollHeight);
  assert.equal(box.dataset.paused, undefined, 'at the very bottom: following again');
  box.fire('wheel', { deltaY: 100 });
  assert.equal(box.dataset.paused, undefined, 'a wheel down never pauses');
  box.fire('keydown', { key: 'PageUp', target: { closest: () => null } });
  assert.equal(box.dataset.paused, '1', 'PageUp in the list pauses');
  box.userScroll(box.scrollTop - 360); // the page it moved
  box.userScroll(box.scrollHeight);
  box.fire('keydown', { key: 'ArrowUp', target: { closest: () => ({}) } });
  assert.equal(box.dataset.paused, undefined, 'typing in a box inside it does not');
  const short = scrollList(scrollRows(2, 100), { clientHeight: 400 });
  short.box.fire('wheel', { deltaY: -100 });
  assert.equal(short.box.dataset.paused, undefined, 'a list with nothing to scroll is never paused by the wheel');
});

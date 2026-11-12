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
test('6. a message list that follows the newest row keeps following when a pinned card or the terminal shrinks it', () => {
  const src = fs.readFileSync(path.join(APP, 'chat.js'), 'utf8');
  const block = src.slice(src.indexOf('  if (typeof ResizeObserver'), src.indexOf('  /* The list gets narrower or wider'));
  assert.match(block, /const box = \$\('messages'\)/);
  assert.match(block, /h < lastHeight && !box\.dataset\.paused/);
  assert.match(block, /box\.scrollTop = box\.scrollHeight/);
  // Run it: a following list that got shorter scrolls to its end; a list scrolled up (paused) is left alone.
  let cb = null;
  const box = { clientHeight: 465, scrollHeight: 465, scrollTop: 0, dataset: {} };
  const run = new Function('ResizeObserver', '$', block.replace(/^\s*\/\*[\s\S]*?\*\//, ''));
  run(
    function (fn) {
      cb = fn;
      this.observe = () => {};
    },
    () => box,
  );
  box.clientHeight = 157;
  box.scrollHeight = 366;
  cb();
  assert.equal(box.scrollTop, 366);
  box.dataset.paused = '1';
  box.scrollTop = 40;
  box.clientHeight = 120;
  cb();
  assert.equal(box.scrollTop, 40);
});

test('6b. a message list that follows keeps following when its content grows after a redraw; not right after your own click', () => {
  const src = fs.readFileSync(path.join(APP, 'chat.js'), 'utf8');
  const start = src.indexOf("  for (const id of ['messages']) {", src.indexOf('  /* Content that grows after a redraw'));
  assert.ok(start > 0, 'the content-growth watcher exists');
  const block = src.slice(start, src.indexOf('function fadeNewLine'));
  const boxes = {},
    observers = [];
  const mk = (id) => {
    const listeners = {};
    return (boxes[id] = {
      id,
      clientHeight: 400,
      scrollHeight: 400,
      scrollTop: 0,
      dataset: {},
      addEventListener: (t, fn) => (listeners[t] = fn),
      fire: (t) => listeners[t](),
    });
  };
  mk('messages');
  mk('submessages');
  const run = new Function('MutationObserver', '$', block.replace(/\/\*[\s\S]*?\*\/\s*$/, ''));
  run(
    function (fn) {
      this.observe = (target) => observers.push({ target, fn });
    },
    (id) => boxes[id],
  );
  const m = boxes.messages,
    grow = () => observers.find((o) => o.target === m).fn();
  // following, the content grew by a toggle row: back at the bottom
  m.scrollHeight = 430;
  grow();
  assert.equal(m.scrollTop, 430);
  // scrolled up to read: left alone
  m.dataset.paused = '1';
  m.scrollTop = 50;
  m.scrollHeight = 470;
  grow();
  assert.equal(m.scrollTop, 50);
  // following, but you just clicked inside (opened a step): left alone
  delete m.dataset.paused;
  m.scrollTop = 70;
  m.fire('pointerdown');
  m.scrollHeight = 600;
  grow();
  assert.equal(m.scrollTop, 70);
  // a picture finished loading while following
  m.fire('load');
  assert.equal(m.scrollTop, 70, 'still inside the click grace');
  // (the subagent view follows through scroll-controller.js now: work/test_scroll_controller.js)
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
  const src = fs.readFileSync(path.join(APP, 'chat.js'), 'utf8');
  const start = src.indexOf("  for (const id of ['messages']) {");
  const end = src.indexOf('  /* The message list gets shorter when something is pinned under it');
  assert.ok(start > 0 && end > start, 'the scroll handler block exists');
  const block = src.slice(start, end);
  const boxes = {};
  const mk = (id) => {
    const on = {};
    return (boxes[id] = {
      id,
      clientHeight: 400,
      scrollHeight: 2000,
      scrollTop: 1600,
      dataset: {},
      addEventListener: (t, fn) => (on[t] = fn),
      fire: (t, e) => on[t](e || {}),
    });
  };
  ['messages', 'submessages', 'commandDetails'].forEach(mk);
  const UNREAD = { holdUntil: 0 };
  const run = new Function('$', 'UNREAD', 'markNow', 'syncJump', 'fadeNewLine', 'markSeen', block);
  run((id) => boxes[id], UNREAD, () => ({ key: 'k' }), () => {}, () => {}, () => {});
  const m = boxes.messages;
  // one notch up that ends 30 px from the bottom: paused right away, and the scroll event that follows keeps it paused
  m.fire('wheel', { deltaY: -100 });
  assert.equal(m.dataset.paused, '1');
  m.scrollTop = 1570;
  m.fire('scroll');
  assert.equal(m.dataset.paused, '1', 'still paused 30 px from the bottom after your own scroll up');
  // scrolling down but not all the way: still paused
  m.scrollTop = 1595;
  m.fire('scroll');
  assert.equal(m.dataset.paused, '1');
  // at the very bottom: following again
  m.scrollTop = 1600;
  m.fire('scroll');
  assert.equal(m.dataset.paused, undefined);
  // a wheel down never pauses
  m.fire('wheel', { deltaY: 100 });
  assert.equal(m.dataset.paused, undefined);
  // PageUp in the list pauses; typing in a box inside it does not
  m.fire('keydown', { key: 'PageUp', target: { closest: () => null } });
  assert.equal(m.dataset.paused, '1');
  m.scrollTop = 1600;
  m.fire('scroll');
  m.fire('keydown', { key: 'ArrowUp', target: { closest: () => ({}) } });
  assert.equal(m.dataset.paused, undefined);
  // a list with nothing to scroll is never paused by the wheel
  m.scrollHeight = 400;
  m.scrollTop = 0;
  m.fire('scroll');
  m.fire('wheel', { deltaY: -100 });
  assert.equal(m.dataset.paused, undefined);
});

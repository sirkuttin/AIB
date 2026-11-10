const { APP: APP_DIR } = require('./_paths');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

class Node {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attrs = {};
    this.className = '';
    this.hidden = false;
    this._text = '';
    this.focused = false;
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  get textContent() {
    return this._text + this.children.map((x) => x.textContent).join('');
  }
  set innerHTML(v) {
    throw new Error('innerHTML must never be used');
  }
  append(...ns) {
    ns.forEach((n) => this.children.push(n));
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  getAttribute(k) {
    return this.attrs[k];
  }
  focus() {
    this.focused = true;
  }
  all() {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  button(label) {
    return this.all().find((n) => n.tagName === 'button' && n.textContent === label);
  }
}
function load() {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(APP_DIR, 'ownership-ui.js'), 'utf8'), {
    window,
    document: { createElement: (tag) => new Node(tag) },
    Object,
    Array,
    String,
    Promise,
    Error,
  });
  return window.AgentOwnershipUI;
}
const EVIL = '<img src=x onerror=alert(1)><script>alert(2)</script>';
const evidence = {
  verdict: 'possibly_active',
  summary: 'Another app may be using this conversation. Studio cannot be sure either way.',
  reasons: [
    { strength: 'weak', text: 'Transcript was written 40 seconds ago, and Studio is not the app writing it.' },
    { strength: 'weak', text: EVIL },
  ],
  notes: ['1 agent process(es) could not be inspected (different user or elevated).'],
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const codeError = (message, code, ownership) => Object.assign(Error(message), { code, ownership });

test('possibly_active asks, shows the evidence as text, and retries only after Continue anyway', async () => {
  const ui = load(),
    box = new Node('section'),
    calls = [];
  const connect = async (payload) => {
    calls.push(payload);
    if (!payload.continueAnyway) throw codeError('may be in use', 'possibly_active', evidence);
    return { id: 'c1' };
  };
  const pending = ui.guardedConnect(connect, { provider: 'omp', cwd: 'C:\\x', resume: 's1' }, box);
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(box.hidden, false);
  assert.match(box.textContent, /40 seconds ago/);
  assert.match(box.textContent, /could not be inspected/);
  assert.ok(box.textContent.includes(EVIL), 'untrusted text appears literally');
  assert.ok(!box.all().some((n) => ['img', 'script'].includes(n.tagName)), 'no element is created from untrusted text');
  assert.equal(box.button('Cancel').focused, true, 'the safe choice has focus');
  box.button('Continue anyway').onclick();
  assert.deepEqual(await pending, { id: 'c1' });
  assert.deepEqual(
    calls.map((c) => c.continueAnyway),
    [undefined, true],
  );
  assert.deepEqual([calls[1].provider, calls[1].resume], ['omp', 's1']);
  assert.equal(box.hidden, true);
  assert.equal(box.children.length, 0);
});

test('Cancel never retries and says nothing was opened or sent', async () => {
  const ui = load(),
    box = new Node('section');
  let calls = 0;
  const pending = ui.guardedConnect(
    async () => {
      calls++;
      throw codeError('may be in use', 'possibly_active', evidence);
    },
    {},
    box,
  );
  await tick();
  box.button('Cancel').onclick();
  await assert.rejects(
    pending,
    (error) => error.code === 'ownership_declined' && /Nothing was opened or sent/.test(error.message),
  );
  assert.equal(calls, 1);
  assert.equal(box.hidden, true);
});

test('owned_elsewhere explains itself, offers no continue button, and rethrows', async () => {
  const ui = load(),
    box = new Node('section');
  const ownership = {
    verdict: 'owned_elsewhere',
    summary: 'Another app is running this conversation. Studio will not continue it from here.',
    reasons: [{ strength: 'strong', text: 'devin-vscode (PID 12) announced that it is running this conversation.' }],
    notes: [],
  };
  await assert.rejects(
    ui.guardedConnect(
      async () => {
        throw codeError('in use', 'session_in_use', ownership);
      },
      {},
      box,
    ),
    (error) => error.code === 'session_in_use',
  );
  assert.equal(box.hidden, false);
  assert.match(box.textContent, /in use elsewhere/);
  assert.match(box.textContent, /devin-vscode \(PID 12\)/);
  assert.equal(box.button('Continue anyway'), undefined);
  box.button('Dismiss').onclick();
  assert.equal(box.hidden, true);
});

test('other errors and plain success pass straight through without a card', async () => {
  const ui = load(),
    box = new Node('section');
  assert.deepEqual(await ui.guardedConnect(async (p) => ({ ok: p.a }), { a: 1 }, box), { ok: 1 });
  assert.equal(box.children.length, 0);
  await assert.rejects(
    ui.guardedConnect(
      async () => {
        throw codeError('Lease held by another Studio', 'session_in_use');
      },
      {},
      box,
    ),
    /Lease held/,
  );
  await assert.rejects(
    ui.guardedConnect(
      async () => {
        throw Error('network');
      },
      {},
      box,
    ),
    /network/,
  );
  assert.equal(box.children.length, 0);
});

test('a second possibly_active after confirming is surfaced, not silently looped', async () => {
  const ui = load(),
    box = new Node('section');
  let calls = 0;
  const pending = ui.guardedConnect(
    async () => {
      calls++;
      throw codeError('still', 'possibly_active', evidence);
    },
    {},
    box,
  );
  await tick();
  box.button('Continue anyway').onclick();
  await assert.rejects(pending, (error) => error.code === 'possibly_active');
  assert.equal(calls, 2);
});

test('header hint never says free: no evidence still states the limit; evidence is labelled', () => {
  const ui = load(),
    hint = new Node('p');
  ui.renderHint(hint, { id: 's1' }, false, undefined);
  assert.equal(hint.hidden, false);
  assert.match(hint.textContent, /cannot prove it is free/);
  assert.doesNotMatch(hint.textContent, /\bsafe\b/i);
  ui.renderHint(hint, { id: 's1' }, false, evidence);
  assert.match(hint.textContent, /^May be active in another app\. Transcript was written 40 seconds ago/);
  assert.equal(hint.attrs['data-verdict'], 'possibly_active');
  ui.renderHint(hint, { id: 's1' }, false, { verdict: 'owned_elsewhere', reasons: [{ text: 'PID 9 has it.' }] });
  assert.match(hint.textContent, /^In use elsewhere\. PID 9/);
  ui.renderHint(hint, { id: 's1' }, true, evidence);
  assert.equal(hint.hidden, true);
  ui.renderHint(hint, null, false, evidence);
  assert.equal(hint.hidden, true);
});

test('header hint says "unknown", not the no-evidence text, when the check could not run here', () => {
  const ui = load(),
    hint = new Node('p');
  const conversation = { provider: 'omp', id: 's-unknown' };
  // The list-wide certainty from GET /api/live/ownership.
  ui.renderHint(hint, conversation, false, undefined, 'unknown');
  assert.equal(hint.hidden, false);
  assert.equal(hint.textContent, "Can't tell if this chat is open elsewhere on this system.");
  assert.equal(hint.textContent, ui.UNKNOWN);
  assert.doesNotMatch(hint.textContent, /cannot prove it is free|No other app was detected/);
  assert.equal(hint.attrs['data-verdict'], 'unknown');
  assert.match(hint.className, /ownership-unknown/);
  // An assessment of one conversation carries its own certainty.
  ui.renderHint(hint, conversation, false, { verdict: 'no_evidence', certainty: 'unknown', reasons: [] }, 'checked');
  assert.equal(hint.textContent, ui.UNKNOWN);
  // Checked (or no certainty at all, as before) keeps the no-evidence wording, which never says free.
  for (const certainty of ['checked', undefined]) {
    ui.renderHint(hint, conversation, false, { verdict: 'no_evidence', certainty: 'checked', reasons: [] }, certainty);
    assert.equal(hint.textContent, ui.NO_PROOF);
    assert.equal(hint.attrs['data-verdict'], 'no_evidence');
  }
  // Evidence is shown whatever the certainty: unknown only replaces "nothing found".
  ui.renderHint(hint, conversation, false, evidence, 'unknown');
  assert.match(hint.textContent, /^May be active in another app\. Transcript was written 40 seconds ago/);
  assert.equal(hint.attrs['data-verdict'], 'possibly_active');
  // Still hidden for a conversation this Studio is running, and dismissing "unknown" does not hide a later verdict.
  ui.renderHint(hint, conversation, true, undefined, 'unknown');
  assert.equal(hint.hidden, true);
  ui.renderHint(hint, conversation, false, undefined, 'unknown');
  ui.dismissHint(conversation, hint);
  assert.equal(hint.hidden, true);
  ui.renderHint(hint, conversation, false, evidence, 'unknown');
  assert.equal(hint.hidden, false);
});

test('sidebar badges appear only for conversations with evidence and carry the reason as a tooltip', () => {
  const ui = load();
  const none = new Node('small'),
    weak = new Node('small'),
    strong = new Node('small'),
    junk = new Node('small');
  ui.decorateRow(none, undefined);
  ui.decorateRow(weak, evidence);
  ui.decorateRow(strong, { verdict: 'owned_elsewhere', reasons: [{ text: 'PID 9' }] });
  ui.decorateRow(junk, { verdict: 'no_evidence', reasons: [] });
  assert.equal(none.children.length, 0);
  assert.equal(junk.children.length, 0);
  const badge = weak.all().find((n) => n.className.includes('badge-ownership'));
  assert.equal(badge.textContent, 'May be active elsewhere');
  assert.match(badge.title, /40 seconds ago/);
  assert.equal(strong.all().find((n) => n.className.includes('badge-ownership')).textContent, 'In use elsewhere');
});

test('selecting another conversation closes an open card and declines it', async () => {
  const ui = load(),
    box = new Node('section');
  const pending = ui.guardedConnect(
    async () => {
      throw codeError('may be in use', 'possibly_active', evidence);
    },
    {},
    box,
  );
  await tick();
  assert.equal(box.hidden, false);
  ui.clear(box);
  await assert.rejects(pending, (error) => error.code === 'ownership_declined');
  assert.equal(box.hidden, true);
  assert.equal(box.children.length, 0);
  ui.clear(box);
});

'use strict';
const { APP: APP_DIR } = require('./_paths');
// Model chip (in-use model, mismatch warning), queued settings changes (pending label + cancel) and the settings panel marks.
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const dir = path.join(APP_DIR);
globalThis.AgentConfigUI = require(path.join(dir, 'config-ui.js'));
globalThis.AgentChoice = require(path.join(dir, 'agent-choice.js'));
const chips = require(path.join(dir, 'composer-chips.js'));

// ---- a tiny DOM: enough for config-ui.js and composer-chips.js -------------------------------
class Node {
  constructor(tag, doc) {
    this.tag = tag;
    this.ownerDocument = doc;
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this.attrs = {};
    this.own = '';
    this.className = '';
    this.title = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.checked = false;
    this.label = '';
    this.type = '';
  }
  get textContent() {
    return this.own + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this.own = String(v);
    this.children = [];
  }
  get firstChild() {
    return this.children[0] || null;
  }
  append(...items) {
    for (const i of items)
      this.appendChild(typeof i === 'string' ? Object.assign(new Node('#text', this.ownerDocument), { own: i }) : i);
  }
  appendChild(n) {
    n.parent = this;
    this.children.push(n);
    return n;
  }
  insertBefore(n, ref) {
    n.parent = this;
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at < 0) this.children.push(n);
    else this.children.splice(at, 0, n);
    return n;
  }
  replaceChildren(...items) {
    this.children = [];
    this.append(...items);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  addEventListener(name, fn) {
    (this.listeners[name] = this.listeners[name] || []).push(fn);
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k];
  }
  contains(n) {
    for (let x = n; x; x = x.parent) if (x === this) return true;
    return false;
  }
  closest(sel) {
    for (let x = this; x; x = x.parent) if (x.matches(sel)) return x;
    return null;
  }
  matches(sel) {
    return sel.startsWith('.') ? String(this.className).split(/\s+/).includes(sel.slice(1)) : this.tag === sel;
  }
  find(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (c.matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) {
    return this.find(sel)[0] || null;
  }
  focus() {}
  click() {
    for (const fn of this.listeners.click || []) fn({ target: this });
  }
  fire(name) {
    for (const fn of this.listeners[name] || []) fn({ target: this });
  }
}
function makeDoc() {
  const doc = { createElement: (tag) => new Node(tag, doc), addEventListener() {} };
  return doc;
}
const settle = () => new Promise((r) => setImmediate(r));

const modelOption = (over = {}) => ({
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'sonnet',
  options: [{ value: 'sonnet', name: 'Sonnet 5.5' }],
  ...over,
});
const OPUS = { model: 'claude-opus-5-5', source: 'transcript' };

test('friendly names for the models Claude and the Claude API report', () => {
  const f = chips.friendlyModel;
  assert.equal(f('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(f('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
  assert.equal(f('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
  assert.equal(f('claude-opus-5'), 'Opus 5');
  assert.equal(f('claude-haiku-4-5[1m]'), 'Haiku 4.5');
  assert.equal(f('opus'), 'Opus');
  assert.equal(f('Sonnet 5.5'), 'Sonnet 5.5');
  assert.equal(f('strata'), 'strata', 'unknown ids are shown as they are');
  assert.equal(f('opusplan'), 'opusplan');
});

test('the Model chip shows the model in use; a different advertised model gets a warning with the exact wording', () => {
  const d = chips.describe({
    settings: { configOptions: [modelOption()] },
    inUse: OPUS,
    cwd: '/p',
    agent: 'Claude Code',
  });
  const chip = d.chips.find((c) => c.id === 'model');
  assert.equal(chip.value, 'Opus 5.5');
  assert.equal(chip.warn, 'The agent reports Sonnet 5.5, but its replies are coming from Opus 5.5.');
  const option = chip.subset.configOptions[0];
  assert.equal(
    option.currentValue,
    'claude-opus-5-5',
    'the popup selects what is in use, so picking the advertised model really changes it',
  );
  assert.equal(option.unlistedLabel, 'Opus 5.5');
});

test('no warning when the two agree, or when there is no evidence of a difference', () => {
  const same = chips.describe({
    settings: {
      configOptions: [modelOption({ currentValue: 'opus', options: [{ value: 'opus', name: 'Opus 5.5' }] })],
    },
    inUse: OPUS,
  });
  assert.equal(same.chips[0].warn, undefined);
  assert.equal(same.chips[0].value, 'Opus 5.5');
  const aliasOnly = chips.describe({
    settings: { configOptions: [modelOption({ currentValue: 'opus', options: [{ value: 'opus', name: 'Opus' }] })] },
    inUse: OPUS,
  });
  assert.equal(aliasOnly.chips[0].warn, undefined, 'a family-only alias matches any version of that family');
  const olderOpus = chips.describe({
    settings: {
      configOptions: [modelOption({ currentValue: 'opus', options: [{ value: 'opus', name: 'Opus 4.1' }] })],
    },
    inUse: OPUS,
  });
  assert.match(olderOpus.chips[0].warn, /reports Opus 4.1, but .* Opus 5.5/);
  const def = chips.describe({
    settings: {
      configOptions: [
        modelOption({
          currentValue: 'default',
          options: [{ value: 'default', name: 'Default (recommended)', description: 'Opus 5.5' }],
        }),
      ],
    },
    inUse: OPUS,
  });
  assert.equal(def.chips[0].warn, undefined, 'the description of "Default" names the model behind it');
  const opaque = chips.describe({
    settings: {
      configOptions: [modelOption({ currentValue: 'default', options: [{ value: 'default', name: 'Default' }] })],
    },
    inUse: OPUS,
  });
  assert.equal(opaque.chips[0].warn, undefined, 'never warn without evidence');
  const fast = chips.describe({
    settings: {
      configOptions: [
        modelOption({
          currentValue: 'fast',
          options: [
            { value: 'fast', name: 'Fast' },
            { value: 'deep', name: 'Deep' },
          ],
        }),
      ],
    },
    inUse: OPUS,
  });
  assert.equal(
    fast.chips[0].warn,
    'The agent reports Fast, but its replies are coming from Opus 5.5.',
    'two different named models',
  );
  const omp = chips.describe({
    settings: {
      configOptions: [
        modelOption({ currentValue: 'strata/strata', options: [{ value: 'strata/strata', name: 'Strata' }] }),
      ],
    },
    inUse: { model: 'strata', provider: 'strata', source: 'transcript' },
  });
  assert.equal(omp.chips[0].warn, undefined);
  assert.equal(omp.chips[0].value, 'strata');
});

test('never invent: nothing known shows no Model chip; only the in-use model shows a static chip; only advertised shows that', () => {
  assert.deepEqual(chips.describe({ settings: { configOptions: [] }, inUse: null, cwd: '', agent: '' }).chips, []);
  assert.deepEqual(chips.describe({ settings: null, inUse: { model: '  ' } }).chips, []);
  const only = chips.describe({ settings: null, inUse: OPUS }).chips;
  assert.deepEqual(
    only.map((c) => [c.id, c.value, !!c.subset]),
    [['model', 'Opus 5.5', false]],
  );
  const advertisedOnly = chips.describe({ settings: { configOptions: [modelOption()] } }).chips[0];
  assert.deepEqual([advertisedOnly.value, advertisedOnly.warn], ['Sonnet 5.5', undefined]);
});

test('pending changes label the chip with the queued choice', () => {
  const settings = {
    modes: {
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'plan', name: 'Plan' },
      ],
    },
    configOptions: [
      modelOption({
        currentValue: 'sonnet',
        options: [
          { value: 'sonnet', name: 'Sonnet 5.5' },
          { value: 'opus', name: 'Opus 5.5' },
        ],
      }),
    ],
  };
  const d = chips.describe({
    settings,
    pending: [
      { key: 'mode', kind: 'mode', value: 'plan' },
      { key: 'config:model', kind: 'config', configId: 'model', value: 'opus' },
      { key: 'config:other', value: 1 },
    ],
  });
  assert.deepEqual(
    d.chips.map((c) => c.pending && [c.pending.key, c.pending.name]),
    [
      ['config:model', 'Opus 5.5'],
      ['mode', 'Plan'],
    ],
  );
  assert.equal(chips.describe({ settings, pending: [] }).chips[1].pending, undefined);
});

function renderChips(model, opts = {}) {
  const doc = makeDoc(),
    box = doc.createElement('div'),
    panel = doc.createElement('div');
  const o = Object.assign({ settingsPanel: panel, disabled: false, busy: false, onError() {}, afterChange() {} }, opts);
  chips.render(box, model, o);
  return { doc, box, o };
}

test('rendered chip: in-use value with a warning marker whose tooltip carries the message', () => {
  const { box } = renderChips({ id: 'c1', settings: { configOptions: [modelOption()] }, inUse: OPUS });
  const chip = box.find('.chip-model')[0];
  assert.ok(chip.textContent.startsWith('Model'));
  assert.ok(chip.textContent.includes('Opus 5.5'));
  const warn = chip.find('.chip-warn')[0];
  assert.equal(warn.title, 'The agent reports Sonnet 5.5, but its replies are coming from Opus 5.5.');
  assert.ok(chip.title.includes(warn.title));
  assert.ok(chip.className.includes('chip-mismatch'));
});

test('rendered chip: pending label "→ after this turn" and a cancel button that cancels by key', async () => {
  const cancelled = [];
  const settings = {
    configOptions: [
      modelOption({
        currentValue: 'sonnet',
        options: [
          { value: 'sonnet', name: 'Sonnet 5.5' },
          { value: 'opus', name: 'Opus 5.5' },
        ],
      }),
    ],
  };
  const { box } = renderChips(
    {
      id: 'c2',
      settings,
      inUse: { model: 'claude-sonnet-5-5' },
      pending: [{ key: 'config:model', kind: 'config', configId: 'model', value: 'opus' }],
    },
    {
      busy: true,
      onCancelPending: (key) => {
        cancelled.push(key);
        return Promise.resolve();
      },
    },
  );
  const chip = box.find('.chip-model')[0];
  assert.ok(chip.textContent.includes('Opus 5.5 → after this turn'), chip.textContent);
  assert.ok(chip.title.includes('currently Sonnet 5.5'));
  const cancel = box.find('.chip-cancel')[0];
  assert.equal(cancel.getAttribute('aria-label'), 'Cancel the queued model change');
  cancel.click();
  await settle();
  assert.deepEqual(cancelled, ['config:model']);
});

test('chips stay usable while the agent works: a pick during a turn goes to onConfig and the popup explains the queue', async () => {
  const picks = [];
  const settings = {
    configOptions: [
      modelOption({
        currentValue: 'sonnet',
        options: [
          { value: 'sonnet', name: 'Sonnet 5.5' },
          { value: 'opus', name: 'Opus 5.5' },
        ],
      }),
    ],
  };
  const { box } = renderChips(
    { id: 'c3', settings },
    {
      busy: true,
      disabled: false,
      onConfig: (id, value, type) => {
        picks.push([id, value, type]);
        return Promise.resolve();
      },
    },
  );
  const button = box.find('.chip-model')[0];
  assert.ok(button.title.includes('applied when this turn ends'));
  button.click();
  const pop = box.find('.chip-pop')[0];
  const select = pop.find('select')[0];
  assert.equal(select.disabled, false);
  assert.ok(pop.textContent.includes('queued and applied when this turn ends'));
  select.value = 'opus';
  select.fire('change');
  await settle();
  assert.deepEqual(picks, [['model', 'opus', 'select']]);
});

test('popup of a chip whose pick is queued shows the queued value as selected, marked, with its own cancel', () => {
  const cancelled = [];
  const settings = {
    configOptions: [
      modelOption({
        currentValue: 'sonnet',
        options: [
          { value: 'sonnet', name: 'Sonnet 5.5' },
          { value: 'opus', name: 'Opus 5.5' },
        ],
      }),
    ],
  };
  const { box } = renderChips(
    { id: 'c4', settings, pending: [{ key: 'config:model', value: 'opus' }] },
    {
      busy: true,
      onCancelPending: (k) => {
        cancelled.push(k);
        return Promise.resolve();
      },
    },
  );
  box.find('.chip-model')[0].click();
  const pop = box.find('.chip-pop')[0];
  assert.equal(pop.find('select')[0].value, 'opus');
  assert.ok(pop.find('.config-queued')[0].textContent.includes('after this turn'));
  pop.find('.config-queued-cancel')[0].click();
  assert.deepEqual(cancelled, []); // asynchronous: runs in a microtask
  return settle().then(() => assert.deepEqual(cancelled, ['config:model']));
});

test('with a mismatch the popup lists the in-use model as a disabled "(in use)" entry and keeps the advertised choices', () => {
  const { box } = renderChips({ id: 'c5', settings: { configOptions: [modelOption()] }, inUse: OPUS });
  box.find('.chip-model')[0].click();
  const select = box.find('.chip-pop')[0].find('select')[0];
  const options = select.children.map((o) => [o.value, o.textContent, o.disabled]);
  assert.deepEqual(options[0], ['claude-opus-5-5', 'Opus 5.5 (in use)', true]);
  assert.deepEqual(options[1], ['sonnet', 'Sonnet 5.5', false]);
  assert.equal(select.value, 'claude-opus-5-5');
});

test('a single advertised model says so, and offers /model only when the agent has that command', () => {
  const insert = [];
  const model = { id: 'c6', settings: { configOptions: [modelOption()] } };
  let r = renderChips(model, { onInsertText: (t) => insert.push(t) });
  r.box.find('.chip-model')[0].click();
  let pop = r.box.find('.chip-pop')[0];
  assert.ok(pop.textContent.includes('This agent offers no other models for this conversation.'));
  assert.equal(pop.find('.chip-insert').length, 0, 'no /model command advertised: no suggestion');
  r = renderChips(Object.assign({}, model, { commands: [{ name: 'compact' }, { name: 'model' }] }), {
    onInsertText: (t) => insert.push(t),
  });
  r.box.find('.chip-model')[0].click();
  pop = r.box.find('.chip-pop')[0];
  assert.ok(pop.textContent.includes('/model opus'));
  pop.find('.chip-insert')[0].click();
  assert.deepEqual(insert, ['/model ']);
  const two = renderChips({
    id: 'c7',
    settings: {
      configOptions: [
        modelOption({
          options: [
            { value: 'sonnet', name: 'Sonnet 5.5' },
            { value: 'opus', name: 'Opus 5.5' },
          ],
        }),
      ],
    },
  });
  two.box.find('.chip-model')[0].click();
  assert.ok(!two.box.find('.chip-pop')[0].textContent.includes('no other models'));
});

test('a refused queued change is reported once, in words, and not repeated for the same failure', () => {
  const errors = [];
  const settings = {
    configOptions: [
      modelOption({
        currentValue: 'sonnet',
        options: [
          { value: 'sonnet', name: 'Sonnet 5.5' },
          { value: 'opus', name: 'Opus 5.5' },
        ],
      }),
    ],
  };
  const model = {
    id: 'c8',
    settings,
    failures: [
      { seq: 1, kind: 'config', configId: 'model', value: 'opus', message: 'Overloaded', time: Date.now() / 1000 },
    ],
  };
  const onError = (e) => errors.push(e.message);
  renderChips(model, { onError });
  renderChips(model, { onError });
  assert.deepEqual(errors, ['Model was not changed to Opus 5.5 after the turn: Overloaded It stays Sonnet 5.5.']);
  renderChips(
    Object.assign({}, model, { id: 'c9', failures: [{ seq: 1, kind: 'mode', value: 'plan', message: 'no', time: 1 }] }),
    { onError },
  );
  assert.equal(errors.length, 1, 'old failures (after a page reload) are not announced again');
});

test('settings panel: queued values are marked and the working agent gets a queue note instead of a lock', () => {
  const doc = makeDoc(),
    box = doc.createElement('div'),
    cancelled = [];
  const settings = {
    modes: {
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'plan', name: 'Plan' },
      ],
    },
    configOptions: [
      { id: 'verbose', name: 'Verbose', type: 'boolean', currentValue: false },
      modelOption({
        options: [
          { value: 'sonnet', name: 'Sonnet 5.5' },
          { value: 'opus', name: 'Opus 5.5' },
        ],
      }),
    ],
  };
  globalThis.AgentConfigUI.render(box, settings, {
    disabled: false,
    queueing: true,
    pending: { mode: 'plan', 'config:verbose': true },
    onCancelPending: (k) => cancelled.push(k),
  });
  const selects = box.find('select');
  assert.equal(selects[0].value, 'plan');
  assert.equal(box.find('input')[0].checked, true);
  assert.equal(box.find('.config-queued').length, 2);
  assert.ok(selects.every((s) => !s.disabled));
  assert.ok(box.textContent.includes('queued and applied when this turn ends'));
  box.find('.config-queued-cancel')[1].click();
  return settle().then(() => assert.deepEqual(cancelled, ['config:verbose']));
});

test('a new chat shows only the agent chip (the new-chat bar says where it starts)', () => {
  const d = chips.describe({ cwd: '', agent: 'OMP', agentId: 'omp', newChat: true });
  assert.deepEqual(
    d.chips.map((c) => c.id),
    ['agent'],
  );
});

test('an existing chat shows its agent first, read-only: no picker, no menu', () => {
  const settings = { configOptions: [modelOption()] };
  const { box } = renderChips({ id: 'e1', settings, cwd: '/p/proj', agent: 'Claude Code', agentId: 'claude' }, {});
  const first = box.children[0];
  assert.equal(first.find('.chip-agent').length, 1);
  assert.ok(first.textContent.includes('Claude Code') && first.textContent.includes('C'));
  assert.equal(box.find('select').length, 0, 'no picker once a chat exists');
  assert.equal(first.find('button').length, 0, 'read-only: nothing to click');
  assert.equal(box.find('.chip-pop-agent').length, 0);
});

test('the Ctx chip carries the session details as a hover / focus tooltip, kept current in place', () => {
  const usage = { used: 70000, size: 100000 };
  const d = chips.describe({
    cwd: '/p',
    agent: 'OMP',
    usage,
    details: ['Context 70,000 / 100,000 tokens (70%)', 'Session ID s-1'],
  });
  const ctx = d.chips.find((c) => c.id === 'ctx');
  assert.equal(ctx.value, '70%');
  assert.deepEqual(ctx.details, ['Context 70,000 / 100,000 tokens (70%)', 'Session ID s-1']);
  assert.equal(chips.describe({ cwd: '/p', agent: 'OMP', usage }).chips.find((c) => c.id === 'ctx').details.length, 0);
  assert.equal(
    chips.describe({ cwd: '/p', agent: 'OMP', details: ['Session ID s-1'] }).chips.find((c) => c.id === 'ctx').value,
    '\u2013',
    'details without usage still get a chip',
  );
  assert.equal(
    chips.describe({ cwd: '/p', agent: 'OMP' }).chips.find((c) => c.id === 'ctx'),
    undefined,
  );
  const { box } = renderChips(
    { id: 'e2', cwd: '/p', agent: 'OMP', agentId: 'omp', usage, details: ['Session ID s-1'] },
    {},
  );
  const tip = box.find('.chip-tip')[0];
  assert.ok(tip, 'the tooltip element exists');
  assert.equal(tip.getAttribute('role'), 'tooltip');
  assert.equal(tip.textContent, 'Session ID s-1');
});

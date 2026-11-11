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
    this.style = {};
    this.dataset = {};
    this.tabIndex = 0;
    const self = this;
    this.classList = {
      toggle(name, on) {
        const set = new Set(String(self.className).split(/\s+/).filter(Boolean));
        if (on === undefined ? !set.has(name) : on) set.add(name);
        else set.delete(name);
        self.className = [...set].join(' ');
      },
      add(name) {
        this.toggle(name, true);
      },
      contains(name) {
        return String(self.className).split(/\s+/).includes(name);
      },
    };
  }
  get isConnected() {
    let x = this;
    while (x.parent) x = x.parent;
    return x === this.ownerDocument.body || x === this.ownerDocument.root;
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
  focus() {
    this.ownerDocument.activeElement = this;
  }
  scrollIntoView() {}
  removeEventListener(name, fn) {
    this.listeners[name] = (this.listeners[name] || []).filter((f) => f !== fn);
  }
  key(key, extra = {}) {
    const event = Object.assign({ key, target: this, prevented: false }, extra);
    event.preventDefault = () => (event.prevented = true);
    event.stopPropagation = () => {};
    for (let x = this; x; x = x.parent) for (const fn of x.listeners.keydown || []) fn(event);
    return event;
  }
  click() {
    for (const fn of this.listeners.click || []) fn({ target: this });
  }
  fire(name) {
    for (const fn of this.listeners[name] || []) fn({ target: this });
  }
}
function makeDoc() {
  const listeners = {};
  const doc = {
    createElement: (tag) => new Node(tag, doc),
    addEventListener: (name, fn) => (listeners[name] = listeners[name] || []).push(fn),
    removeEventListener: (name, fn) => (listeners[name] = (listeners[name] || []).filter((f) => f !== fn)),
    fire: (name, target) => (listeners[name] || []).slice().forEach((fn) => fn({ target })),
    listeners,
    activeElement: null,
    defaultView: { innerWidth: 1440, innerHeight: 900 },
  };
  doc.getElementById = (id) => {
    const walk = (n) => {
      if (n.id === id) return n;
      for (const c of n.children) {
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(doc.body);
  };
  doc.body = new Node('body', doc);
  doc.root = new Node('main', doc);
  doc.body.appendChild(doc.root);
  return doc;
}
// The open choice menu (on <body>) and its rows.
const menuOf = (doc) => doc.body.find('.chip-menu')[0] || null;
const rowsOf = (doc) => (menuOf(doc) ? menuOf(doc).find('.chip-menu-item') : []);
const rowText = (r) => r.find('.chip-menu-name')[0].textContent;
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
  doc.root.appendChild(box);
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

test('chips stay usable while the agent works: a pick during a turn goes to onConfig and the menu explains the queue', async () => {
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
  const { box, doc } = renderChips(
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
  const menu = menuOf(doc);
  assert.ok(menu, 'the menu opens on one click');
  assert.equal(menu.find('select').length, 0, 'no drop-down inside the menu');
  assert.ok(menu.textContent.includes('queued and applied when this turn ends'));
  assert.equal(rowsOf(doc).length, 2);
  rowsOf(doc)[1].click();
  assert.equal(menuOf(doc), null, 'one click picks and closes');
  await settle();
  assert.deepEqual(picks, [['model', 'opus', 'select']]);
});

test('the menu of a chip whose pick is queued checks the queued value and marks it "after this turn"', () => {
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
  const { box, doc } = renderChips(
    { id: 'c4', settings, pending: [{ key: 'config:model', value: 'opus' }] },
    { busy: true, onCancelPending: () => Promise.resolve() },
  );
  box.find('.chip-model')[0].click();
  const rows = rowsOf(doc);
  assert.deepEqual(
    rows.map((r) => r.getAttribute('aria-checked')),
    ['false', 'true'],
  );
  assert.ok(rows[1].textContent.includes('after this turn'));
  assert.equal(box.find('.chip-cancel').length, 1, 'the chip keeps its own cancel');
});

test('with a mismatch the menu lists the in-use model first, checked and not pickable, then the advertised choices', () => {
  const picks = [];
  const { box, doc } = renderChips(
    { id: 'c5', settings: { configOptions: [modelOption()] }, inUse: OPUS },
    { onConfig: (...a) => picks.push(a) },
  );
  box.find('.chip-model')[0].click();
  const rows = rowsOf(doc);
  assert.deepEqual(
    rows.map((r) => [r.dataset.value, rowText(r), r.getAttribute('aria-checked'), r.getAttribute('aria-disabled')]),
    [
      ['claude-opus-5-5', 'Opus 5.5in use', 'true', 'true'],
      ['sonnet', 'Sonnet 5.5', 'false', undefined],
    ],
  );
  rows[0].click();
  assert.ok(menuOf(doc), 'a disabled row does nothing');
  assert.deepEqual(picks, []);
});

test('a single advertised model says so, and offers /model only when the agent has that command', () => {
  const insert = [];
  const model = { id: 'c6', settings: { configOptions: [modelOption()] } };
  let r = renderChips(model, { onInsertText: (t) => insert.push(t) });
  r.box.find('.chip-model')[0].click();
  let menu = menuOf(r.doc);
  assert.ok(menu.textContent.includes('This agent offers no other models for this conversation.'));
  assert.equal(menu.find('.chip-insert').length, 0, 'no /model command advertised: no suggestion');
  r = renderChips(Object.assign({}, model, { commands: [{ name: 'compact' }, { name: 'model' }] }), {
    onInsertText: (t) => insert.push(t),
  });
  r.box.find('.chip-model')[0].click();
  menu = menuOf(r.doc);
  assert.ok(menu.textContent.includes('/model opus'));
  menu.find('.chip-insert')[0].click();
  assert.deepEqual(insert, ['/model ']);
  assert.equal(menuOf(r.doc), null);
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
  assert.ok(!menuOf(two.doc).textContent.includes('no other models'));
});

// ---- the choice menu: rows, roles, keyboard, placement -----------------------------------------------------------
const RICH = {
  modes: {
    currentModeId: 'auto',
    availableModes: [
      { id: 'ask', name: 'Ask first', description: 'Asks before every edit' },
      { id: 'auto', name: 'Auto review' },
      { id: 'full', name: 'Full access' },
    ],
  },
  configOptions: [
    modelOption({
      currentValue: 'fast',
      options: [
        { group: 'g1', name: 'Small', options: [{ value: 'fast', name: 'Fast' }] },
        {
          group: 'g2',
          name: 'Large',
          options: [
            { value: 'deep', name: 'Deep', description: 'Slow' },
            { value: 'dense', name: 'Dense' },
          ],
        },
      ],
    }),
    {
      id: 'reasoning_effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'low',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
      ],
    },
  ],
};

function richChips(opts = {}) {
  const calls = [];
  const r = renderChips(
    { id: 'm1', settings: RICH },
    Object.assign(
      {
        onMode: (id) => calls.push(['mode', id]),
        onConfig: (id, value, type) => calls.push(['config', id, value, type]),
      },
      opts,
    ),
  );
  return Object.assign(r, { calls });
}

test('every choice chip (model, mode, effort) opens the same kind of menu: ARIA roles, a check on the current row', () => {
  const r = richChips();
  for (const [id, label, current, count] of [
    ['model', 'Model', 'Fast', 3],
    ['mode', 'Mode', 'Auto review', 3],
    ['effort', 'Effort', 'Low', 3],
  ]) {
    const chip = r.box.find('.chip-' + id)[0];
    assert.equal(chip.getAttribute('aria-haspopup'), 'menu');
    chip.click();
    assert.equal(chip.getAttribute('aria-expanded'), 'true');
    const menu = menuOf(r.doc);
    assert.equal(menu.getAttribute('role'), 'menu');
    assert.equal(menu.getAttribute('aria-label'), label);
    assert.ok(menu.className.includes('organize-menu'), 'the row ⋯ menu look');
    const rows = rowsOf(r.doc);
    assert.equal(rows.length, count);
    assert.ok(rows.every((x) => x.getAttribute('role') === 'menuitemradio'));
    const checked = rows.filter((x) => x.getAttribute('aria-checked') === 'true');
    assert.equal(checked.length, 1);
    assert.equal(rowText(checked[0]), current);
    assert.equal(checked[0].find('.chip-menu-check')[0].textContent, '\u2713');
    assert.equal(r.doc.activeElement, checked[0], 'focus starts on the current row');
    chip.click();
    assert.equal(menuOf(r.doc), null, 'a second click on the chip closes it');
    assert.equal(chip.getAttribute('aria-expanded'), 'false');
  }
});

test('descriptions show under their option; groups get a heading', () => {
  const r = richChips();
  r.box.find('.chip-model')[0].click();
  const menu = menuOf(r.doc);
  assert.deepEqual(
    menu.find('.chip-menu-group').map((g) => g.textContent),
    ['Small', 'Large'],
  );
  const deep = rowsOf(r.doc).find((x) => x.dataset.value === 'deep');
  assert.equal(deep.find('.chip-menu-desc')[0].textContent, 'Slow');
  r.box.find('.chip-mode')[0].click();
  assert.equal(rowsOf(r.doc)[0].find('.chip-menu-desc')[0].textContent, 'Asks before every edit');
});

test('picking a mode calls onMode, an effort calls onConfig; the value already chosen calls nothing', async () => {
  const r = richChips();
  r.box.find('.chip-mode')[0].click();
  rowsOf(r.doc)[2].click();
  r.box.find('.chip-effort')[0].click();
  rowsOf(r.doc)[0].click(); // Low: already chosen
  r.box.find('.chip-effort')[0].click();
  rowsOf(r.doc)[2].click();
  await settle();
  assert.deepEqual(r.calls, [
    ['mode', 'full'],
    ['config', 'reasoning_effort', 'high', 'select'],
  ]);
});

test('keyboard: Up / Down move (wrapping), Home / End, Enter picks, Escape closes and puts focus back on the chip', async () => {
  const r = richChips();
  const chip = r.box.find('.chip-effort')[0];
  chip.click();
  const rows = rowsOf(r.doc);
  assert.equal(r.doc.activeElement, rows[0]);
  r.doc.activeElement.key('ArrowDown');
  assert.equal(r.doc.activeElement, rows[1]);
  r.doc.activeElement.key('ArrowDown');
  r.doc.activeElement.key('ArrowDown');
  assert.equal(r.doc.activeElement, rows[0], 'wraps to the top');
  r.doc.activeElement.key('ArrowUp');
  assert.equal(r.doc.activeElement, rows[2], 'wraps to the bottom');
  r.doc.activeElement.key('Home');
  assert.equal(r.doc.activeElement, rows[0]);
  r.doc.activeElement.key('End');
  assert.equal(r.doc.activeElement, rows[2]);
  const esc = r.doc.activeElement.key('Escape');
  assert.ok(esc.prevented);
  assert.equal(menuOf(r.doc), null);
  assert.equal(r.doc.activeElement, chip, 'focus returns to the chip');
  chip.click();
  r.doc.activeElement.key('ArrowDown');
  const enter = r.doc.activeElement.key('Enter');
  assert.ok(enter.prevented);
  assert.equal(menuOf(r.doc), null);
  assert.equal(r.doc.activeElement, chip, 'after a pick, focus is back on the chip');
  await settle();
  assert.deepEqual(r.calls, [['config', 'reasoning_effort', 'medium', 'select']]);
});

test('after a pick the chips are rebuilt with the new value and the focus stays on that chip', async () => {
  const settings = JSON.parse(JSON.stringify(RICH));
  const doc = makeDoc(),
    box = doc.createElement('div');
  doc.root.appendChild(box);
  const o = {
    onConfig: (id, value) => {
      settings.configOptions[1].currentValue = value;
    },
    onError() {},
    afterChange: () => chips.render(box, { id: 'f1', settings }, o),
  };
  chips.render(box, { id: 'f1', settings }, o);
  box.find('.chip-effort')[0].click();
  doc.activeElement.key('End');
  doc.activeElement.key('Enter');
  await settle();
  const chip = box.find('.chip-effort')[0];
  assert.ok(chip.textContent.includes('High'), chip.textContent);
  assert.equal(doc.activeElement, chip, 'the rebuilt chip has the focus');
});

test('keyboard: type-ahead jumps to the next row starting with the typed letters', () => {
  const r = richChips();
  r.box.find('.chip-model')[0].click();
  const rows = rowsOf(r.doc);
  r.doc.activeElement.key('d');
  assert.equal(rowText(r.doc.activeElement), 'Deep');
  r.doc.activeElement.key('d');
  assert.equal(rowText(r.doc.activeElement), 'Dense', 'the same letter again: the next match');
  r.doc.activeElement.key('Escape');
  r.box.find('.chip-model')[0].click();
  r.doc.activeElement.key('d');
  r.doc.activeElement.key('e');
  r.doc.activeElement.key('n');
  assert.equal(rowText(r.doc.activeElement), 'Dense', 'several letters typed quickly match a prefix');
  assert.equal(rows.length, 3);
});

test('between turns of a closed chat the rows are shown but cannot be picked, with the reason', () => {
  const r = richChips({ disabled: true });
  r.box.find('.chip-mode')[0].click();
  const rows = rowsOf(r.doc);
  assert.ok(rows.every((x) => x.getAttribute('aria-disabled') === 'true'));
  assert.ok(menuOf(r.doc).textContent.includes('Settings change between turns.'));
  rows[0].click();
  assert.deepEqual(r.calls, []);
});

test('a pointer press outside closes the menu without a pick; a re-render closes it too', () => {
  const r = richChips();
  r.box.find('.chip-mode')[0].click();
  r.doc.fire('mousedown', r.box.find('.chip-mode')[0]); // on the chip: left to its click
  assert.ok(menuOf(r.doc));
  r.doc.fire('mousedown', r.doc.root);
  assert.equal(menuOf(r.doc), null);
  assert.equal((r.doc.listeners.mousedown || []).length, 0, 'its document listener is removed');
});

test('placement: above the chip when there is room, below otherwise, always inside the window, long lists scroll', () => {
  const vp = { width: 1440, height: 900 };
  let p = chips.place({ top: 840, bottom: 866, left: 300 }, { width: 240, height: 300 }, vp);
  assert.ok(p.up);
  assert.equal(p.top, 840 - 4 - 300);
  assert.equal(p.left, 300);
  p = chips.place({ top: 40, bottom: 66, left: 1400 }, { width: 240, height: 300 }, vp);
  assert.ok(!p.up);
  assert.equal(p.top, 70);
  assert.equal(p.left, 1440 - 8 - 240, 'pushed back inside the right edge');
  p = chips.place({ top: 840, bottom: 866, left: 10 }, { width: 240, height: 2000 }, vp);
  assert.ok(p.up);
  assert.equal(p.top, 8);
  assert.equal(p.maxHeight, 840 - 12, 'taller than the room: capped, the list scrolls');
  p = chips.place({ top: 700, bottom: 726, left: 600 }, { width: 900, height: 200 }, { width: 760, height: 800 });
  assert.equal(p.left, 8, 'narrow window: as far left as needed');
});

test('the New chat page: stand-in chips while the lists load, and an Agent chip that is a menu of agents', () => {
  const picked = [];
  const { box, doc } = renderChips(
    {
      id: 'new-chat',
      agent: 'Codex',
      agentId: 'codex',
      agents: [
        { id: 'claude', name: 'Claude Code' },
        { id: 'codex', name: 'Codex' },
      ],
      extraChips: [{ id: 'model', label: 'Model', value: 'Checking\u2026', title: 'Asking Codex' }],
    },
    { onAgent: (id) => picked.push(id) },
  );
  assert.equal(box.find('.chip-model')[0].tag, 'span', 'a stand-in is read-only');
  assert.ok(box.find('.chip-model')[0].textContent.includes('Checking'));
  const agent = box.find('.chip-agent')[0];
  assert.equal(agent.tag, 'button');
  agent.click();
  const rows = rowsOf(doc);
  assert.deepEqual(
    rows.map((x) => [rowText(x), x.getAttribute('aria-checked')]),
    [
      ['Claude Code', 'false'],
      ['Codex', 'true'],
    ],
  );
  rows[0].click();
  assert.deepEqual(picked, ['claude']);
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
  assert.equal(box.find('.chip-menu').length, 0);
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

test('the New chat Agent menu lists agents that are not ready greyed with the reason, and one "Set up in Settings" link opens Settings', () => {
  const picked = [];
  let setups = 0;
  const { box, doc } = renderChips(
    {
      id: 'new-chat',
      agent: 'Codex',
      agentId: 'codex',
      agents: [
        { id: 'codex', name: 'Codex' },
        { id: 'kimi', name: 'Kimi Code', group: 'Beta' },
        { id: 'gemini', name: 'Gemini CLI', group: 'Beta', disabled: true, reason: 'Needs sign-in' },
      ],
    },
    { onAgent: (id) => picked.push(id), onSetup: () => setups++ },
  );
  box.find('.chip-agent')[0].click();
  const rows = rowsOf(doc);
  assert.deepEqual(rows.map((r) => r.getAttribute('aria-disabled')), [undefined, undefined, 'true']);
  assert.equal(rows[2].find('.chip-menu-tag')[0].textContent, 'Needs sign-in');
  rows[2].click();
  assert.deepEqual(picked, [], 'a greyed agent cannot be chosen');
  rows[1].click();
  assert.deepEqual(picked, ['kimi'], 'a Ready Beta agent can');
  box.find('.chip-agent')[0].click();
  const link = menuOf(doc).find('.chip-setup');
  assert.equal(link.length, 1);
  assert.equal(link[0].textContent, 'Set up in Settings ›');
  link[0].click();
  assert.equal(setups, 1);
});

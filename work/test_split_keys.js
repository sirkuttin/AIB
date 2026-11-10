'use strict';
const { APP: APP_DIR } = require('./_paths');
/* Split view keys and the narrow-window rule, through split-ui.js's own API with a very small fake page.
   (These used to be checked by looking for text in the source files.) */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const mk = () => ({
  children: [],
  id: '',
  style: {},
  dataset: {},
  offsetWidth: 1000,
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  addEventListener() {},
  removeEventListener() {},
  append() {},
  prepend() {},
  insertBefore() {},
  replaceChildren() {},
  setAttribute() {},
  removeAttribute() {},
  focus() {},
  remove() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700 }),
});
const main = mk(),
  strip = mk(),
  chatView = mk();
main.children = [strip, chatView]; // the real chat view is what split-ui moves into the focused pane
globalThis.document = {
  querySelector: (selector) => (selector === 'main' ? main : null),
  getElementById: (id) => (id === 'chatTabs' ? strip : null),
  addEventListener() {},
  querySelectorAll: () => [],
  createElement: mk,
  body: mk(),
};
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.addEventListener = () => {};

const dir = APP_DIR;
const Tree = require(path.join(dir, 'split-tree.js'));
const Split = require(path.join(dir, 'split-ui.js'));
Split.init({
  selectedKey: () => 'a',
  convOf: () => null,
  titleOf: () => '',
  redraw() {},
  open() {},
  showStart() {},
  notice() {},
  singleTabs: () => ['a'],
  orderTabs: (list) => list,
  statusText: () => '',
  draftOf: () => '',
  agentName: () => '',
  mirror: { rows: () => null, paint() {}, stash() {}, wake() {} },
});

const press = (event) => {
  let prevented = 0;
  const used = Split.handleKey({
    preventDefault() {
      prevented++;
    },
    ...event,
  });
  return { used, prevented };
};

test('with one pane the page keeps its old keys: Ctrl+1 and Ctrl+Alt+arrows are not taken', () => {
  assert.equal(Split.active(), false);
  assert.deepEqual(press({ key: '1', ctrlKey: true }), { used: false, prevented: 0 });
  assert.deepEqual(press({ key: 'ArrowRight', ctrlKey: true, altKey: true }), { used: false, prevented: 0 });
  assert.deepEqual(press({ key: 'x' }), { used: false, prevented: 0 });
});

test('before any split the tab menu offers Split right and Split down', () => {
  assert.deepEqual(
    Split.menuItems('a').map((item) => item.label),
    ['Split right', 'Split down'],
  );
  assert.equal(Tree.NARROW, 900);
});

test('Ctrl+\\ splits the focused tab to the right; then Ctrl+1 and Ctrl+Alt+arrows belong to the panes', () => {
  assert.deepEqual(press({ key: '\\', ctrlKey: true }), { used: true, prevented: 1 });
  assert.equal(Split.active(), true);
  assert.equal(Tree.countGroups(Split.layout()), 2);
  assert.ok(Split.menuItems('a').some((item) => item.label === 'Move to next pane'));
  assert.equal(press({ key: '1', ctrlKey: true }).used, true);
  assert.equal(press({ key: 'ArrowRight', ctrlKey: true, altKey: true }).used, true);
  assert.equal(press({ key: '1', ctrlKey: true, shiftKey: true }).used, false, 'Ctrl+Shift+1 is not ours');
  assert.equal(press({ key: '1', ctrlKey: true, metaKey: true }).used, false);
});

test('under the narrow width the panes collapse to one: nothing is active and pane keys are not taken', () => {
  if (!Split.layout()) press({ key: '\\', ctrlKey: true });
  assert.ok(Split.layout(), 'two panes exist');
  assert.equal(Split.active(), true);
  globalThis.innerWidth = Tree.NARROW - 1;
  assert.equal(Split.active(), false);
  assert.equal(press({ key: '1', ctrlKey: true }).used, false);
  assert.equal(press({ key: 'ArrowLeft', ctrlKey: true, altKey: true }).used, false);
  globalThis.innerWidth = Tree.NARROW;
  assert.equal(Split.active(), true);
  assert.equal(press({ key: '1', ctrlKey: true }).used, true);
});

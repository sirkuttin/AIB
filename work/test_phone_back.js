'use strict';
/* Back steps on the phone page: navPlan, from the chain the history holds to the chain on screen. The page itself (the browser's
   Back through list, chat, Artifacts, an artifact, sheets, a notification link) runs in work/deno/remote_phone_back_e2e_test.ts. */
const { APP } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const P = require(path.join(APP, 'phone.js'));

const chain = (...keys) => keys.map((k) => ({ k }));
const plan = (have, want) => {
  const p = P.navPlan(have, want);
  return [p.back, p.push.map((e) => e.k)];
};

test('a step deeper adds one entry; the same chain (a poll redraw) adds none', () => {
  assert.deepEqual(plan(chain('root'), chain('root', 'chat:c1')), [0, ['chat:c1']]);
  assert.deepEqual(plan(chain('root', 'chat:c1'), chain('root', 'chat:c1', 'arts:k:c1')), [0, ['arts:k:c1']]);
  assert.deepEqual(plan(chain('root', 'chat:c1'), chain('root', 'chat:c1')), [0, []]);
});

test('closing a sheet or an in-page Back goes back; another chat replaces the one on screen', () => {
  assert.deepEqual(plan(chain('root', 'menu'), chain('root')), [1, []]);
  assert.deepEqual(plan(chain('root', 'chat:c1', 'arts:k:c1', 'viewer'), chain('root')), [3, []]);
  // a sheet's action opens a screen: the sheet's entry goes, the screen comes over the list
  assert.deepEqual(plan(chain('root', 'menu'), chain('root', 'arts:k:')), [1, ['arts:k:']]);
  // a banner or a notification opens another chat: back to the list, then that chat
  assert.deepEqual(plan(chain('root', 'chat:c1', 'viewer'), chain('root', 'chat:c2')), [2, ['chat:c2']]);
  // a #chat= link's own entry is left behind the same way
  assert.deepEqual(plan(chain('root', 'link'), chain('root', 'chat:c2')), [1, ['chat:c2']]);
});

test('the list is always the first entry: never gone back past, Back there leaves the page', () => {
  assert.deepEqual(plan(chain('root'), chain('root')), [0, []]);
  assert.deepEqual(plan([], chain('root', 'chat:c1')), [0, ['chat:c1']]);
  assert.deepEqual(plan(chain('root', 'inbox'), chain('root', 'inbox', 'chat:c1')), [0, ['chat:c1']]);
});

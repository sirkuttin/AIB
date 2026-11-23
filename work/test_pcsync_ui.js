'use strict';
// Settings > Sync (pcsync-ui.js): the plain status line for each state, the peer reachability words, the countdown, and the section
// in Settings (own section after Remote control; search finds it). The server side runs in work/deno/pcsync_pairing_e2e_test.ts.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { APP } = require('./_paths');
const UI = require(path.join(APP, 'pcsync-ui.js'));
const SET = require(path.join(APP, 'settings-ui.js'));

const on = { on: true, listening: true, pc: { signedIn: true }, serve: { shared: true }, peers: [], pairing: null, join: null, problem: '' };

test('status: one plain line per state', () => {
  assert.match(UI.statusText(null), /Loading/);
  assert.match(UI.statusText({ pc: { signedIn: false } }), /Tailscale is not running/);
  assert.equal(UI.statusText({ ...on, on: false }), 'Sync is off on this PC.');
  assert.match(UI.statusText({ ...on, serve: { shared: false } }), /not shared on Tailscale/);
  assert.match(UI.statusText({ ...on, serve: { shared: false, funnel: true } }), /Funnel is on/);
  assert.equal(UI.statusText(on), 'Ready. No PC is paired yet.');
  assert.equal(UI.statusText({ ...on, peers: [{}] }), 'Paired with 1 PC.');
  assert.equal(UI.statusText({ ...on, peers: [{}, {}] }), 'Paired with 2 PCs.');
  assert.match(UI.statusText({ ...on, pairing: { words: ['a'], pending: [] } }), /Type the six words/);
  assert.match(UI.statusText({ ...on, pairing: { words: [], pending: [{}] } }), /Approve/);
  assert.match(UI.statusText({ ...on, join: { state: 'waiting', name: 'desk' } }), /Waiting for desk/);
  assert.equal(UI.statusText({ ...on, problem: 'The sync port is busy.' }), 'The sync port is busy.');
});

test('reachability words and the countdown', () => {
  assert.equal(UI.reachText('online'), 'Connected');
  assert.equal(UI.reachText('offline'), 'Offline');
  assert.equal(UI.reachText('connecting'), 'Connecting');
  assert.match(UI.reachText('refused'), /No longer trusts this PC/);
  assert.equal(UI.reachText('unknown'), 'Checking');
  assert.equal(UI.countdown(300, 0), '5:00');
  assert.equal(UI.countdown(61, 0), '1:01');
  assert.equal(UI.countdown(5, 10000), '0:00');
});

test('Settings has its own Sync section after Remote control, and search finds the card', () => {
  const ids = SET.SECTIONS.map((s) => s.id);
  assert.equal(ids[ids.indexOf('devices') + 1], 'sync');
  for (const q of ['sync', 'pair', 'start a sync chain', 'aib-shared']) {
    assert.ok(SET.filterIndex(SET.INDEX, q).some((e) => e.id === 'sync-pcs' && e.section === 'sync'), q);
  }
});

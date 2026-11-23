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

test('matched projects: the line under a project says why it is matched', () => {
  assert.equal(UI.howText({ how: 'remote', confirmed: true }), 'Same git remote');
  assert.equal(UI.howText({ how: 'manual', confirmed: true }), 'Linked by hand');
  assert.match(UI.howText({ how: 'manual', confirmed: false }), /confirm/);
  assert.match(UI.howText({ how: 'remote', confirmed: true, missing: true }), /no longer on this PC/);
});

test('file status: one plain phrase per state, paused first, then syncing, conflicts, up to date', () => {
  const ok = { state: 'ok', reason: '', pending: 0, conflicts: [], conflictCount: 0, held: [], pause: null };
  assert.equal(UI.filesText(null, 'desk'), '');
  assert.equal(UI.filesText({ ...ok, state: 'off' }, 'desk'), '');
  assert.equal(UI.filesText(ok, 'desk'), 'Up to date');
  assert.equal(UI.filesText({ ...ok, pending: 3 }, 'desk'), 'Syncing 3 files');
  assert.equal(UI.filesText({ ...ok, pending: 1 }, 'desk'), 'Syncing 1 file');
  assert.equal(UI.filesText({ ...ok, conflictCount: 1 }, 'desk'), '1 conflict');
  assert.equal(UI.filesText({ ...ok, conflictCount: 2 }, 'desk'), '2 conflicts');
  assert.equal(UI.filesText({ ...ok, pause: { deletes: 12, total: 12 }, pending: 4, conflictCount: 1 }, 'desk'), 'Paused: big delete');
  assert.match(UI.filesText({ ...ok, state: 'wsl' }, 'desk'), /WSL projects comes in a later update/);
  assert.match(UI.filesText({ ...ok, state: 'offline' }, 'desk'), /Waiting for desk/);
  assert.match(UI.filesText({ ...ok, state: 'other_off' }, 'desk'), /off on desk/);
  assert.equal(UI.filesText({ ...ok, state: 'other_off' }, 'desk', 'aib-docs'), 'Waiting: aib-docs is off on desk.');
  assert.equal(UI.filesText({ ...ok, state: 'blocked', reason: 'Git already tracks aib-shared.' }, 'desk'), 'Git already tracks aib-shared.');
  assert.equal(UI.filesText({ ...ok, state: 'checking' }, 'desk'), 'Checking files.');
});

test('Settings has its own Sync section after Remote control, and search finds the card', () => {
  const ids = SET.SECTIONS.map((s) => s.id);
  assert.equal(ids[ids.indexOf('devices') + 1], 'sync');
  for (const q of ['sync', 'pair', 'start a sync chain', 'aib-shared']) {
    assert.ok(SET.filterIndex(SET.INDEX, q).some((e) => e.id === 'sync-pcs' && e.section === 'sync'), q);
  }
});

// ---- the sidebar sync mark (slice V6): the state that needs you most wins, one plain tooltip per state ----
const fv = (over) => ({ state: 'ok', reason: '', pending: 0, conflicts: [], conflictCount: 0, held: [], pause: null, ...over });
const mark = (files, docsFiles) => UI.markOf({ files, docsFiles }, 'ubuntu-pc');

test('mark: each state and its tooltip', () => {
  assert.deepEqual(mark(fv(), null), { state: 'ok', n: 0, text: 'Up to date with ubuntu-pc. PC to PC over Tailscale, no cloud.' });
  assert.deepEqual(mark(fv({ pending: 3 }), null), { state: 'syncing', n: 3, text: 'Syncing 3 files with ubuntu-pc. PC to PC, no cloud.' });
  assert.equal(mark(fv({ pending: 1 }), null).text, 'Syncing 1 file with ubuntu-pc. PC to PC, no cloud.');
  assert.deepEqual(mark(fv({ state: 'offline' }), null), { state: 'waiting', n: 0, text: 'ubuntu-pc is off or not reachable. Changes wait here.' });
  assert.equal(mark(fv({ state: 'other_off' }), null).text, 'aib-shared sync is off on ubuntu-pc. Changes wait here.');
  assert.deepEqual(mark(fv({ conflictCount: 2 }), null), { state: 'conflict', n: 2, text: '2 sync conflicts with ubuntu-pc. Click to open Sync settings.' });
  assert.equal(mark(fv({ conflictCount: 1 }), null).text, '1 sync conflict with ubuntu-pc. Click to open Sync settings.');
  assert.deepEqual(mark(fv({ pause: { deletes: 340, total: 400 } }), null), {
    state: 'paused',
    n: 340,
    text: 'Sync paused: 340 of 400 files were deleted on ubuntu-pc. Click to choose.',
  });
  assert.deepEqual(mark(fv({ state: 'off' }), fv({ state: 'off' })), { state: 'off', n: 0, text: 'Sync is off for this project. Click to open Sync settings.' });
  assert.equal(mark(null, null).state, 'off');
});

test('mark: aib-shared and docs are one mark, paused > conflict > waiting > syncing > up to date; an area that is off does not count', () => {
  assert.equal(mark(fv(), fv({ conflictCount: 1 })).state, 'conflict');
  assert.equal(mark(fv({ pending: 2 }), fv({ pause: { deletes: 5, total: 9 } })).state, 'paused');
  assert.equal(mark(fv({ conflictCount: 1 }), fv({ pause: { deletes: 5, total: 9 } })).state, 'paused');
  assert.equal(mark(fv({ state: 'offline' }), fv({ pending: 2 })).state, 'waiting');
  assert.equal(mark(fv({ pending: 1 }), fv({ pending: 2 })).text, 'Syncing 3 files with ubuntu-pc. PC to PC, no cloud.');
  assert.equal(mark(fv({ state: 'off' }), fv()).state, 'ok');
  assert.equal(mark(fv({ state: 'checking' }), null).state, 'syncing');
});

test('mark: folders match across slashes, case and a trailing slash', () => {
  assert.equal(UI.normFolder('C:\\Users\\Me\\Shop\\'), 'c:/users/me/shop');
  assert.equal(UI.normFolder('/home/me/shop/'), '/home/me/shop');
});

test('Device activity: a sync batch reads "ubuntu-pc synced 3 files to shop"', () => {
  const D = require(path.join(APP, 'devices-ui.js'));
  assert.equal(
    D.activityLine({ name: 'ubuntu-pc', device: '', action: 'sync', chat: '', result: '3 files to shop' }, 'T'),
    'T · ubuntu-pc synced 3 files to shop · PC to PC',
  );
});

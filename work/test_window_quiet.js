// Remote control from other PCs, phase 2: a presence answer that says `quiet` (you are at another device) keeps this window from
// chiming or showing a notification of its own (window-context.js soundMine), for 45 s or until an answer says otherwise.
'use strict';
const assert = require('assert');
const path = require('path');
const W = require(path.join(__dirname, '..', 'outputs', 'agent-studio', 'window-context.js'));

const realNow = Date.now;
let now = 1_000_000;
Date.now = () => now;
try {
  W._reset();
  assert.strictEqual(W.soundMine(), true, 'alone, no answer: this window chimes (today)');
  W.noteAnswer({ ok: true, soundOwner: null, openAll: [], windows: [], quiet: true }, []);
  assert.strictEqual(W.quiet(), true);
  assert.strictEqual(W.soundMine(), false, 'you are at another device: no chime here');
  now += 44_000;
  assert.strictEqual(W.soundMine(), false, 'still quiet within 45 s');
  now += 2_000;
  assert.strictEqual(W.soundMine(), true, 'no word for 45 s: back to today');
  W.noteAnswer({ ok: true, soundOwner: null, openAll: [], windows: [], quiet: true }, []);
  W.noteAnswer({ ok: true, soundOwner: null, openAll: [], windows: [] }, []);
  assert.strictEqual(W.soundMine(), true, 'an answer without quiet ends it');
  console.log('ok window quiet');
} finally {
  Date.now = realNow;
}

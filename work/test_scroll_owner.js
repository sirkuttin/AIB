'use strict';
/* One owner of the chat lists' scroll position (scroll design, step 6): scroll-controller.js is the only file that sets scrollTop on
   a managed list (#messages, #submessages, #commandDetails, .mirror-msgs). Any other assignment to scrollTop in the page code must
   be on a list the controller does not manage, and say so on its line ("not a managed list"), or belong to the old main-list
   code kept behind the one-release switch (localStorage aib-scroll-v2 = '0'), marked "old main-list scroll code" on its line.
   This stops the family of bugs coming back: every fix that added one more writer with one more guard. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { APP } = require('./_paths');

const WRITE = /\.scrollTop\s*(=(?!=)|\+=|-=)/;
const OK = /not a managed list|old main-list scroll code/;

test('only scroll-controller.js sets scrollTop on a managed list; every other write says which list it is', () => {
  const bad = [];
  let legacy = 0;
  /* the files that draw or move the chat lists; any other page file must not name them at all */
  const DRAWERS = new Set(['chat.js', 'split-ui.js', 'views-ui.js', 'textsize-ui.js', 'stream-ui.js', 'clamp-ui.js', 'tool-views.js']);
  const NAMES = /'messages'|"messages"|submessages|commandDetails|mirror-msgs/;
  for (const name of fs.readdirSync(APP)) {
    if (!name.endsWith('.js') || name === 'scroll-controller.js') continue;
    const text = fs.readFileSync(path.join(APP, name), 'utf8'),
      lines = text.split('\n');
    if (!DRAWERS.has(name)) {
      if (lines.some((l) => WRITE.test(l)) && NAMES.test(text)) bad.push(`${name}: sets scrollTop and names a managed list`);
      continue;
    }
    lines.forEach((line, i) => {
      if (!WRITE.test(line)) return;
      if (/old main-list scroll code/.test(line)) legacy++;
      if (!OK.test(line)) bad.push(`${name}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, [], 'scrollTop written outside scroll-controller.js without saying it is not a managed list');
  assert.ok(legacy > 0, 'the old main-list path is still here for the one-release switch (remove this check with it)');
});

test('the managed lists are attached to the controller and marked for CSS (overflow-anchor: none)', () => {
  const chat = fs.readFileSync(path.join(APP, 'chat.js'), 'utf8');
  assert.match(chat, /SCROLL_ROLES = \{ submessages: 'sub', commandDetails: 'command', \.\.\.\(SCROLL_V2 \? \{ messages: 'main' \} : \{\}\) \}/);
  assert.match(chat, /ScrollController\.attach\(box, \{ role: 'mirror'/);
  const css = fs.readFileSync(path.join(APP, 'chat.css'), 'utf8');
  assert.match(css, /\.scroll-list \{\s*overflow-anchor: none;/);
});

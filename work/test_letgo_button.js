'use strict';
/* The header's "Let another app open this chat" icon (Codex chats; chat.js renderLetGo, header.css): shown only on a connected Codex
   chat, the same 24 px icon button as the header's other icons, disabled once AIB let go, and a click asks the server to let go and says
   so when the chat is working. Run: node --test work/test_letgo_button.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makePage, El } = require('./chat_harness.js');
const { APP } = require('./_paths');

function page() {
  const posts = [];
  const answers = [{ ok: true, state: 'released' }];
  const p = makePage({
    routes: {
      '/api/live/session-op': (_q, body) => {
        posts.push(body);
        return { body: answers.shift() || { ok: true } };
      },
    },
  });
  p.document.createElementNS = () => new El('svg');
  return { ...p, posts, answers };
}

test('the Let go icon shows on a connected Codex chat only, and is disabled once AIB let go', () => {
  const p = page();
  const button = p.element('letGoCurrent');
  p.run("selected={provider:'codex',id:'t1'};current='conn-1';snapshot={closed:false};renderLetGo(true)");
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);
  assert.equal(button.children.length, 1, 'the icon is drawn');
  p.run("snapshot={closed:false,elsewhere:{app:'x',released:true}};renderLetGo(true)");
  assert.equal(button.disabled, true);
  p.run("selected={provider:'claude',id:'c1'};snapshot={closed:false};renderLetGo(true)");
  assert.equal(button.hidden, true, 'not shown for other providers');
  p.run("selected={provider:'codex',id:'t1'};renderLetGo(false)");
  assert.equal(button.hidden, true, 'nothing to let go of when the chat is not connected');
});

test('clicking asks the server to let go; a working chat says so', async () => {
  const p = page();
  const button = p.element('letGoCurrent');
  p.run("selected={provider:'codex',id:'t1'};current='conn-1';snapshot={closed:false};renderLetGo(true)");
  await button.listeners.click();
  assert.deepEqual(p.posts, [{ id: 'conn-1', op: 'let-go' }]);
  assert.equal(p.element('error').hidden, true);
  p.answers.push({ ok: true, state: 'busy', message: 'This chat is working, so AIB did not let go. Try again when it is idle.' });
  p.run('renderLetGo(true)');
  await button.listeners.click();
  assert.equal(p.element('error').hidden, false);
  assert.equal(p.element('error').textContent, 'This chat is working, so AIB did not let go. Try again when it is idle.');
});

test('page and style: one 24 px icon button with the tooltip, drawn like the header menu button', () => {
  const html = fs.readFileSync(path.join(APP, 'chat.html'), 'utf8');
  const tag = /<button id="letGoCurrent"[^>]*>/.exec(html)[0];
  assert.match(tag, /title="Let another app open this chat"/);
  assert.match(tag, /\bhidden\b/);
  assert.ok(html.indexOf('id="letGoCurrent"') < html.indexOf('id="organizeCurrent"'), 'next to the header menu button, before it');
  const css = fs.readFileSync(path.join(APP, 'header.css'), 'utf8');
  const shared = /#organizeCurrent\.hd-more,\s*#letGoCurrent\.hd-more\s*\{([^}]*)\}/.exec(css);
  assert.ok(shared, 'the two buttons share one rule');
  assert.match(shared[1], /width: 24px/);
  assert.match(shared[1], /height: 24px/);
});

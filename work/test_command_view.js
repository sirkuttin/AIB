'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  vm = require('node:vm');
const { loadChat } = require('./chat_harness.js');
const storage = () => ({ getItem: () => null, setItem() {}, removeItem() {} });
const elements = new Map();
const element = (id) => {
  if (!elements.has(id)) elements.set(id, { value: '', checked: false, hidden: false, addEventListener() {} });
  return elements.get(id);
};
const context = vm.createContext({
  localStorage: storage(),
  sessionStorage: storage(),
  document: { getElementById: element },
  window: { addEventListener() {} },
  fetch: () => new Promise(() => {}),
  setInterval() {},
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return timer;
  },
  clearTimeout,
  URLSearchParams,
  AbortController,
  Date,
  console,
});
const chat = loadChat(context);
test('only reported running or in-progress commands enter the running section', () => {
  for (const status of ['running', 'in-progress'])
    assert.equal(chat.run(`isRunningCommand({status:${JSON.stringify(status)}})`), true);
  for (const status of ['completed', 'failed', 'killed', 'cancelled', 'unknown'])
    assert.equal(chat.run(`isRunningCommand({status:${JSON.stringify(status)}})`), false);
});
test('completed command duration is fixed and unresolved timing stays explicit', () => {
  assert.equal(
    chat.run("commandDuration({status:'completed',started:'2026-01-01T00:00:00Z',ended:'2026-01-01T00:02:03Z'})"),
    '2m 3s',
  );
  assert.equal(chat.run("commandDuration({status:'killed',durationMs:4000})"), '4s');
  assert.equal(chat.run("commandDuration({status:'unknown',started:'2026-01-01T00:00:00Z'})"), 'Duration not recorded');
});

test('Enter submits, Shift+Enter and composition preserve text, and busy sends stay blocked', () => {
  let submitted = 0,
    prevented = 0;
  element('promptForm').requestSubmit = () => submitted++;
  element('prompt').value = 'message';
  element('send').disabled = false;
  chat.run("current='fixture'");
  const key = (overrides) =>
    element('prompt').onkeydown({
      key: 'Enter',
      preventDefault() {
        prevented++;
      },
      ...overrides,
    });
  key({});
  assert.equal(submitted, 1);
  for (const modifiers of [{ shiftKey: true }, { isComposing: true }, { ctrlKey: true }]) key(modifiers);
  assert.equal(submitted, 1);
  assert.equal(prevented, 1);
  element('send').disabled = true;
  key({});
  assert.equal(submitted, 1);
  chat.run("current=''");
  element('send').disabled = false;
  key({});
  assert.equal(submitted, 2, 'a chat that is not running submits too: Send reconnects and sends');
  element('prompt').value = ' ';
  key({});
  assert.equal(submitted, 2);
});

test('image-only messages remain visible and images stay scoped to their conversation', () => {
  chat.run(
    "snapshot={sessionId:'main'};events=[{kind:'user',time:1,data:{sessionId:'main',text:'',attachments:[{type:'image',mimeType:'image/png',data:'aGVsbG8='}]}},{kind:'user',time:2,data:{sessionId:'child',text:'private',attachments:[]}}]",
  );
  const rows = chat.run("liveRows('main')");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attachments.length, 1);
  assert.equal(rows[0].value, '');
});

test('transcript images allow embedded raster data and reject active or URL payloads', () => {
  for (const mimeType of ['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
    assert.equal(chat.run(`safeImageBlock({type:'image',mimeType:${JSON.stringify(mimeType)},data:'aGVsbG8='})`), true);
  for (const payload of [
    { type: 'image', mimeType: 'image/svg+xml', data: 'aGVsbG8=' },
    { type: 'image', mimeType: 'image/png', data: 'https://example.org/image.png' },
    { type: 'image', mimeType: 'image/png', data: '<script>' },
  ])
    assert.equal(chat.run(`safeImageBlock(${JSON.stringify(payload)})`), false);
});

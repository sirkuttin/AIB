'use strict';
// The first message of a new chat must reach the agent, or show an error with the text kept. It was lost when the user opened
// another chat while the new one was still starting (Kimi Code takes seconds to start: session/new, then the picks).
const test = require('node:test');
const assert = require('node:assert/strict');
const { makePage, byClass } = require('./chat_harness.js');

const conn = { id: 'conn-1', provider: 'kimi', sessionId: 'session_x', cwd: 'C:/p', closed: false };
function setup({ promptFails = false, moveOn = true } = {}) {
  const prompts = [];
  let page;
  page = makePage({
    routes: {
      '/api/live/connect': () => ({ body: { id: 'conn-1' } }),
      '/api/live/state': () => ({ body: { id: 'conn-1', ready: true, closed: false, pickResults: [] } }),
      '/api/live/list': () => {
        // the user clicks another chat in the sidebar while the new one finishes opening
        if (moveOn) page.run("selected = { provider: 'claude', id: 'other', cwd: 'C:/p' }");
        return { body: { connections: [conn], recovered: [], instanceId: 'A' } };
      },
      '/api/sessions': () => ({ body: { sessions: [] } }),
      '/api/live/prompt': (_q, body) => {
        prompts.push(body);
        return promptFails
          ? { status: 400, body: { error: 'This connection is not ready' } }
          : { body: { accepted: true } };
      },
    },
  });
  page.run("newDraft = { provider: 'kimi', cwd: 'C:/p', picked: true, model: '', mode: '', effort: '' }");
  page.element('cwd').value = 'C:/p';
  page.element('prompt').value = 'hello!';
  return { page, prompts };
}

test('the first message still reaches the new chat when the user opened another chat while it started', async () => {
  const { page, prompts } = setup();
  await page.run('startNewChat()');
  assert.equal(prompts.length, 1, 'the prompt was sent');
  assert.equal(prompts[0].id, 'conn-1');
  assert.equal(prompts[0].text, 'hello!');
  assert.equal(page.run('selected.id'), 'other', 'the page stays on the chat the user went to');
});

test('a refused first message is shown as an error and kept as the new chat draft', async () => {
  const { page, prompts } = setup({ promptFails: true });
  await page.run('startNewChat()');
  assert.equal(prompts.length, 1);
  assert.match(page.element('error').textContent, /not ready/);
  assert.match(page.element('error').textContent, /kept as its draft/);
  assert.equal(page.run("drafts.get('kimi:session_x')"), 'hello!');
});

test('an agent error that names a page shows the link as a link', () => {
  const page = makePage();
  const note =
    'Authentication required: Your current subscription does not have access to Kimi Code right now. Upgrade your plan: https://www.kimi.com/code/#pricing.';
  const row = { role: 'notice', label: 'error', value: note, time: 1 };
  const article = page.run('bubbleFull(' + JSON.stringify(row) + ')');
  const links = [];
  const walk = (n) =>
    (n.children || []).forEach((c) => (c && c.href ? links.push(c) : c && typeof c === 'object' && walk(c)));
  walk(article);
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'https://www.kimi.com/code/#pricing');
  assert.equal(links[0].rel, 'noopener noreferrer');
});

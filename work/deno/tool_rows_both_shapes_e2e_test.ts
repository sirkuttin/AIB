/**
 * Tool consolidation slice 3 (M4), in a headless browser: the chat page names and groups tool rows from BOTH shapes. An old
 * transcript's doc_create / doc_read rows and a new chat's `doc` + action rows read the same; the new `publish` and `helper` rows read
 * naturally. One doc is made through the new `doc` create call: its card appears.
 */
import { assert } from './_assert.ts';
import { browserPath, type Chat, Lab, shown } from './_scroll_lab.ts';

const meta = (tool: string) => ({ claudeCode: { toolName: 'mcp__studio_artifact__' + tool } });

Deno.test({
  name: 'old and new tool rows both render: doc rows, the doc card, and natural labels for publish and helper',
  ignore: !browserPath,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const lab = await Lab.open(1600, 900);
    try {
      const chat: Chat = await lab.chat();
      await chat.start();
      chat.say('Hello READY');
      await lab.select(chat);
      await shown(lab.page, 'READY');
      const page = lab.page;
      // the new shape: doc + action create, then read; and an old-name read row
      chat.tool('new-mk', 'mcp__studio_artifact__doc', 'in_progress', { rawInput: { action: 'create', doc: 'Notes' } });
      await page.waitFor(`!!document.querySelector('#messages .doc-tool')`, 15000, 'the running doc row (new shape)');
      const [status, made] = await lab.web.post('docs/open', { id: chat.id, name: 'Notes', create: '' });
      assert(status === 200, `docs/open: ${status} ${JSON.stringify(made)}`);
      const name = String(made.name);
      chat.toolDone('new-mk', JSON.stringify({ ok: true, doc: name, docTitle: 'Notes', created: true, pages: [{ id: 'p1', title: 'Page 1' }] }));
      await page.waitFor(`!!document.querySelector('#messages .doc-card')`, 15000, 'the doc card from a new-shape create');
      chat.tool('new-rd', 'mcp__studio_artifact__doc', 'in_progress', { rawInput: { action: 'read', doc: name } });
      chat.toolDone('new-rd', JSON.stringify({ ok: true, doc: name, rev: 1 }));
      chat.tool('old-rd', 'mcp__studio_artifact__doc_read', 'in_progress', { rawInput: { doc: name } });
      chat.toolDone('old-rd', JSON.stringify({ ok: true, doc: name, rev: 1 }));
      chat.tool('new-pub', 'studio_artifact: publish', 'in_progress', { kind: 'other', _meta: meta('publish'), rawInput: { title: 'Drop rates' } });
      chat.toolDone('new-pub', 'ok');
      chat.tool('new-help', 'studio_artifact: helper', 'in_progress', { kind: 'other', _meta: meta('helper'), rawInput: { action: 'work_land', work: 'sa_1' } });
      chat.toolDone('new-help', 'ok');
      await page.waitFor(`document.querySelectorAll('#messages .doc-tool').length >= 3`, 15000, 'three doc rows (create, new read, old read)');
      const words = await page.eval<string>(`Array.from(document.querySelectorAll('#messages .doc-tool')).map((e) => e.textContent).join(' | ')`);
      const read = (words.match(/Read Notes/g) || []).length;
      assert(read >= 2, `the new and the old read row say the same words: ${words}`);
      const all = await page.eval<string>(`document.getElementById('messages').textContent`);
      assert(/Drop rates/.test(all), `the publish row is named: ${all.slice(-400)}`);
      assert(/Helper · work land/.test(all), `the helper row is named: ${all.slice(-400)}`);
      assert(page.errors.length === 0, `console errors: ${page.errors.join(' | ')}`);
      chat.end();
    } finally {
      await lab.close();
    }
  },
});

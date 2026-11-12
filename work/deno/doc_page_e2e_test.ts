/**
 * The doc page in a real headless browser against a throwaway Studio (work/deno/_doc_browser.ts: its own free port, state folder
 * and project; a fake agent host whose turns the test ends; no window on the screen): what the user sees while agents work, and
 * what the page sends back. One browser, one Studio; each step uses its own doc. The last step restarts the Studio.
 * Skipped when no Chrome or Edge is installed. AIB_DOCPAGE_SHOTS=<folder> keeps a screenshot per step.
 */
import { assert, assertEquals } from './_assert.ts';
import { docId } from '../../outputs/agent-studio/server/docs/store.ts';
import { Browser, browserPath, type Page, sleep, type Studio, studio, temp } from './_doc_browser.ts';

type Json = Record<string, unknown>;
const inline = (content: string | string[], as = 'markdown') => ({
  from: { kind: 'inline', content },
  as,
});
const CHAT = 'claude:a', CODEX = 'codex:b';
const CTRL = 2, ALT = 1;

/** Open the doc page for a doc and wait until its editor is there. */
async function openDoc(
  b: Browser,
  s: Studio,
  name: string,
  extra = '',
  width = 1280,
): Promise<Page> {
  const page = await b.open(
    s.url(
      `/doc.html?chat=${encodeURIComponent(CHAT)}&name=${encodeURIComponent(name)}${extra}`,
    ),
    width,
  );
  try {
    await page.waitFor(
      `!!(document.querySelector('#docEditor .ProseMirror') && window.AIBDoc && window.AIBDoc.editor)`,
      10000,
      'the editor',
    );
  } catch (error) {
    const shown = await page.eval(
      `document.querySelector('#docError').textContent + ' | ' + document.querySelector('#docStatusText').textContent`,
    ).catch(() => '');
    throw new Error(
      `${(error as Error).message}\n  page: ${shown}\n  errors: ${page.errors.join('\n')}\n  log: ${page.logs.slice(-8).join('\n')}`,
    );
  }
  return page;
}
const editorText = (p: Page) => p.eval<string>(`document.querySelector('#docEditor .ProseMirror').innerText`);
const shows = (p: Page, words: string) =>
  p.waitFor(
    `document.querySelector('#docEditor').innerText.includes(${JSON.stringify(words)})`,
    8000,
    `"${words}" on the page`,
  );
const live = async (s: Studio, name: string) => s.ctx.docs.get(await docId(s.project, name))!;
type Doc = Awaited<ReturnType<typeof live>>;
const mdOf = (doc: Doc, page?: string) => doc.live.topBlocks(page).map((b) => doc.live.markdownOf(b.id));
async function until(
  check: () => boolean | Promise<boolean>,
  what: string,
  ms = 8000,
): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(30);
  }
}
/** In the page: put the caret right after `needle` (or select it), focused. */
const caretAfter = (needle: string, select = false) =>
  `(() => {
  const v = AIBDoc.editor.view; const n = ${JSON.stringify(needle)}; let at = -1;
  v.state.doc.descendants((node, pos) => { if (at < 0 && node.isText && node.text.includes(n)) at = pos + node.text.indexOf(n); });
  if (at < 0) return false;
  v.focus();
  const S = AIBDocEditor.selections.TextSelection;
  v.dispatch(v.state.tr.setSelection(${select} ? S.create(v.state.doc, at, at + n.length) : S.create(v.state.doc, at + n.length)));
  return true;
})()`;
async function read(s: Studio, chat: string, doc: string, page?: string) {
  const [, r] = await s.tool(chat, 'doc_read', page ? { doc, page } : { doc });
  return r as { rev: number; blocks: { id: string; h: string; md?: string }[] };
}
const replace = (
  doc: string,
  b: { id: string; h: string },
  rev: number,
  md: string,
) => ({
  doc,
  ops: [{
    op: 'replace',
    target: { kind: 'blocks', ids: [b.id] },
    ifHash: b.h,
    ifRev: rev,
    with: inline(md),
  }],
});

Deno.test({
  name: 'the doc page in a browser',
  ignore: !browserPath,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const downloads = await temp('aib-docpage-downloads-');
    Deno.env.set('AIB_DOWNLOADS_DIR', downloads);
    let s = await studio();
    const b = await Browser.launch();
    const pages: Page[] = [];
    const open = async (name: string, extra = '', width = 1280) => {
      const p = await openDoc(b, s, name, extra, width);
      pages.push(p);
      return p;
    };
    const step = (name: string, fn: () => Promise<void>) => t.step(name, fn);
    try {
      s.chat('c1', 'claude', 'a', null);
      s.chat('c2', 'codex', 'b', null);
      await s.ctx.artifacts.refresh();

      await step(
        'opens a doc; agent text renders with no tint, bar, name or marks',
        async () => {
          await s.tool(CHAT, 'doc_create', {
            doc: 'plan',
            markdown: '# Plan\n\nAlpha words.\n\nBeta words.\n',
          });
          const p = await open('plan');
          await shows(p, 'Beta words.');
          const r = await read(s, CHAT, 'plan');
          assert(
            (await s.tool(
              CHAT,
              'doc_edit',
              replace('plan', r.blocks[2], r.rev, 'Beta from Claude.'),
            ))[0],
          );
          await shows(p, 'Beta from Claude.');
          const marks = await p.eval<Json>(`(() => {
          const ed = document.querySelector('#docEditor');
          return {
            data: ed.querySelectorAll('[data-agent-edit], [data-by]').length,
            cls: ed.querySelectorAll('.agent-edit, .ag, .agblock, .who').length,
            title: [...ed.querySelectorAll('[title]')].filter((e) => /written by/i.test(e.title)).length,
            styled: [...ed.querySelectorAll('p span, p mark')].filter((e) => !e.closest('.agent-caret') && (e.className || e.getAttribute('style'))).length,
          };
        })()`);
          assertEquals(marks, { data: 0, cls: 0, title: 0, styled: 0 });
          assertEquals(
            await p.eval(
              `document.querySelector('#docStatusText').textContent`,
            ),
            'Saved',
          );
          await s.endTurn('c1', 'claude', 'a');
          await p.shot('01-open');
        },
      );

      await step(
        'presence appears during an agent edit and goes at turn end and on cancel; two agents show two names',
        async () => {
          await s.tool(CHAT, 'doc_create', {
            doc: 'pres',
            markdown: 'Intro.\n\n## Risks\n\nRisk one.\n',
          });
          const p = await open('pres');
          await shows(p, 'Risk one.');
          let r = await read(s, CHAT, 'pres');
          assert(
            (await s.tool(
              CHAT,
              'doc_edit',
              replace('pres', r.blocks[2], r.rev, 'Risk one, rewritten.'),
            ))[0],
          );
          await p.waitFor(
            `[...document.querySelectorAll('.agent-caret .agent-flag')].map((f) => f.textContent).join() === 'Claude Code'`,
            8000,
            'the name flag',
          );
          await p.waitFor(
            `document.querySelectorAll('#docEditor .agent-here').length === 1`,
            8000,
            'the outline',
          );
          await p.waitFor(
            `document.querySelector('#writingChips').textContent.includes('Claude Code is writing Risks')`,
            8000,
            'the chip naming the section',
          );
          await p.waitFor(
            `document.querySelectorAll('#pageList .agd.live').length === 1`,
            8000,
            'the page dot',
          );
          r = await read(s, CODEX, 'pres');
          assert(
            (await s.tool(
              CODEX,
              'doc_edit',
              replace('pres', r.blocks[0], r.rev, 'Intro from Codex.'),
            ))[0],
          );
          await p.waitFor(
            `[...document.querySelectorAll('.agent-caret .agent-flag')].map((f) => f.textContent).sort().join() === 'Claude Code,Codex'`,
            8000,
            'two names',
          );
          await p.waitFor(
            `document.querySelectorAll('#writingChips .writing').length === 2`,
          );
          await p.shot('02-presence');
          await s.endTurn('c1', 'claude', 'a');
          await p.waitFor(
            `[...document.querySelectorAll('.agent-caret .agent-flag')].map((f) => f.textContent).join() === 'Codex'`,
            8000,
            'Claude Code gone at its turn end',
          );
          // codex's turn is cancelled: busy, then its turn end moves
          s.chat('c2', 'codex', 'b', null, true);
          await s.ctx.artifacts.refresh();
          await s.endTurn('c2', 'codex', 'b');
          await p.waitFor(
            `document.querySelectorAll('.agent-caret, #docEditor .agent-here, #writingChips .writing, #pageList .agd.live').length === 0`,
            8000,
            'presence gone after the cancel',
          );
        },
      );

      await step(
        'a claimed section is dimmed with its label; Stop releases it; typing in it wins; the finished text swaps in',
        async () => {
          await s.tool(CHAT, 'doc_create', {
            doc: 'claim',
            markdown: 'Alpha.\n\nBeta.\n\nGamma.\n',
          });
          const p = await open('claim');
          await shows(p, 'Gamma.');
          let r = await read(s, CHAT, 'claim');
          const [a, bb, g] = r.blocks;
          assert(
            (await s.tool(CHAT, 'doc_claim', {
              doc: 'claim',
              ids: [a.id],
              intent: 'tightening the intro',
              ifRev: r.rev,
            }))[0],
          );
          await p.waitFor(
            `document.querySelectorAll('#docEditor .is-claimed').length === 1`,
            8000,
            'the dimmed block',
          );
          assert(
            String(
              await p.eval(
                `document.querySelector('.claim-label').textContent`,
              ),
            ).includes('Claude Code is rewriting this'),
          );
          assertEquals(
            await p.eval(
              `document.querySelector('.claim-label button').textContent`,
            ),
            'Stop and keep the text',
          );
          assert(
            await p.eval(
              `getComputedStyle(document.querySelector('#docEditor .is-claimed')).opacity < 1`,
            ),
            'dimmed, still shown',
          );
          await p.shot('03-claim');
          await p.click('[data-claim-stop]');
          await p.waitFor(
            `document.querySelectorAll('#docEditor .is-claimed, .claim-label').length === 0`,
            8000,
            'released',
          );
          const doc = await live(s, 'claim');
          assertEquals(doc.live.doc.getMap('claims').size, 0);
          assertEquals(
            (await s.tool(
              CHAT,
              'doc_edit',
              replace('claim', a, r.rev, 'Alpha, tighter.'),
            ))[1].code,
            'user_took_back',
          );
          assertEquals(mdOf(doc)[0], 'Alpha.');
          // the replacing edit swaps the finished text in and lets go
          assert(
            (await s.tool(CHAT, 'doc_claim', {
              doc: 'claim',
              ids: [bb.id],
              ifRev: r.rev,
            }))[0],
          );
          await p.waitFor(
            `document.querySelectorAll('#docEditor .is-claimed').length === 1`,
          );
          assert(
            (await s.tool(
              CHAT,
              'doc_edit',
              replace('claim', bb, r.rev, 'Beta, finished.'),
            ))[0],
          );
          await shows(p, 'Beta, finished.');
          await p.waitFor(
            `document.querySelectorAll('#docEditor .is-claimed').length === 0`,
            8000,
            'no dimming after the swap',
          );
          // typing in a claimed block is allowed; the user wins
          r = await read(s, CHAT, 'claim');
          const gamma = r.blocks.find((x) => x.id === g.id)!;
          assert(
            (await s.tool(CHAT, 'doc_claim', {
              doc: 'claim',
              ids: [g.id],
              ifRev: r.rev,
            }))[0],
          );
          await p.waitFor(
            `document.querySelectorAll('#docEditor .is-claimed').length === 1`,
          );
          assert(await p.eval(caretAfter('Gamma.')));
          await p.type(' Mine.');
          await until(
            () => mdOf(doc).includes('Gamma. Mine.'),
            'the typing on the server',
          );
          assertEquals(
            (await s.tool(
              CHAT,
              'doc_edit',
              replace('claim', gamma, r.rev, 'Gamma from Claude.'),
            ))[1].code,
            'guard_mismatch',
          );
          assert((await editorText(p)).includes('Gamma. Mine.'));
          await s.endTurn('c1', 'claude', 'a');
          await p.waitFor(
            `document.querySelectorAll('#docEditor .is-claimed').length === 0`,
            8000,
            'claim gone at turn end',
          );
          await p.click('.note-x').catch(() => {});
        },
      );

      await step(
        "never overwrite: the agent's rewrite of a paragraph the user is typing in is refused; one quiet note at turn end",
        async () => {
          await s.tool(CHAT, 'doc_create', {
            doc: 'never',
            markdown: 'Dates are 18 Nov.\n\nOther.\n',
          });
          const p = await open('never');
          await shows(p, 'Dates are 18 Nov.');
          const r = await read(s, CHAT, 'never');
          assert(await p.eval(caretAfter('18 Nov.')));
          await p.type(' Moved to 19.');
          const doc = await live(s, 'never');
          await until(
            () => mdOf(doc)[0] === 'Dates are 18 Nov. Moved to 19.',
            'the keystrokes on the server',
          );
          assertEquals(
            (await s.tool(
              CHAT,
              'doc_edit',
              replace('never', r.blocks[0], r.rev, 'Dates are 20 Nov.'),
            ))[1].code,
            'guard_mismatch',
          );
          assert(
            (await editorText(p)).includes('Dates are 18 Nov. Moved to 19.'),
          );
          assertEquals(
            await p.eval(`document.querySelectorAll('.qnote').length`),
            0,
            'no note while the agent works',
          );
          await s.endTurn('c1', 'claude', 'a');
          await p.waitFor(
            `document.querySelectorAll('.qnote').length === 1`,
            8000,
            'the note at turn end',
          );
          assert(
            String(await p.eval(`document.querySelector('.qnote').textContent`))
              .includes(
                "Claude Code didn't change this because you'd edited it.",
              ),
          );
          await p.click('.note-show');
          await p.waitFor(
            `document.querySelector('.qx .would') && document.querySelector('.qx .would').textContent === 'Dates are 20 Nov.'`,
            8000,
            'what it wrote',
          );
          await p.shot('04-note');
          await p.click('.note-insert');
          await until(
            () =>
              mdOf(doc).join('|') ===
                'Dates are 18 Nov. Moved to 19.|Dates are 20 Nov.|Other.',
            'inserted below',
          );
          await p.waitFor(
            `document.querySelectorAll('.qnote').length === 0`,
            8000,
            'the note dismissed',
          );
          await until(
            () => doc.agents.notes.length === 0,
            'dismissed on the server',
          );
          // a short turn: refused, then ended at once: one note, dismissed with ✕
          const r2 = await read(s, CHAT, 'never');
          assert(await p.eval(caretAfter('Other.')));
          await p.type(' Typed.');
          await until(() => mdOf(doc)[2] === 'Other. Typed.', 'typed');
          assertEquals(
            (await s.tool(
              CHAT,
              'doc_edit',
              replace('never', r2.blocks[2], r2.rev, 'Other from Claude.'),
            ))[1].code,
            'guard_mismatch',
          );
          await s.endTurn('c1', 'claude', 'a');
          await p.waitFor(`document.querySelectorAll('.qnote').length === 1`);
          await sleep(300);
          assertEquals(
            await p.eval(`document.querySelectorAll('.qnote').length`),
            1,
            'once',
          );
          await p.click('.note-x');
          await p.waitFor(`document.querySelectorAll('.qnote').length === 0`);
        },
      );

      await step("undo takes back only the user's own typing", async () => {
        await s.tool(CHAT, 'doc_create', {
          doc: 'undo',
          markdown: 'Mine.\n\nTheirs.\n',
        });
        const p = await open('undo');
        await shows(p, 'Theirs.');
        const doc = await live(s, 'undo');
        assert(await p.eval(caretAfter('Mine.')));
        await p.type(' Typed');
        await until(() => mdOf(doc)[0] === 'Mine. Typed', 'typed');
        const r = await read(s, CHAT, 'undo');
        assert(
          (await s.tool(
            CHAT,
            'doc_edit',
            replace('undo', r.blocks[1], r.rev, 'Theirs, by Claude.'),
          ))[0],
        );
        await shows(p, 'Theirs, by Claude.');
        await p.key('z', CTRL);
        await until(
          () => mdOf(doc).join('|') === 'Mine.|Theirs, by Claude.',
          'only the typing undone',
        );
        await s.endTurn('c1', 'claude', 'a');
      });

      await step(
        'pages: add, rename, reorder (Alt+arrows and drag), delete; an agent delete request: Keep, then Delete',
        async () => {
          await s.tool(CHAT, 'doc_create', {
            doc: 'pg',
            markdown: 'First page.\n',
            title: 'Overview',
          });
          const p = await open('pg');
          const doc = await live(s, 'pg');
          const titles = () => doc.live.pageList().map((x) => x.title);
          await p.click('#pageList .pib');
          await p.waitFor(
            `document.activeElement && document.activeElement.classList.contains('pg-ren')`,
            8000,
            'the name field',
          );
          await p.type('Rollout');
          await p.key('Enter');
          await until(
            () => titles().join() === 'Overview,Rollout',
            'added and renamed',
          );
          await p.click('#pageList .pg-add');
          await p.waitFor(
            `document.activeElement && document.activeElement.classList.contains('pg-ren')`,
          );
          await p.type('Risks');
          await p.key('Enter');
          await until(
            () => titles().join() === 'Overview,Rollout,Risks',
            'second page',
          );
          // rename by double click
          await p.eval(
            `document.querySelector('#pageList .pg[data-page="${
              doc.live.pageList()[1].id
            }"]').dispatchEvent(new MouseEvent('dblclick', {bubbles: true}))`,
          );
          await p.waitFor(
            `document.activeElement && document.activeElement.classList.contains('pg-ren') && document.activeElement.selectionEnd === document.activeElement.value.length`,
          );
          await p.type('Rollout plan');
          await p.key('Enter');
          await until(
            () => titles().join() === 'Overview,Rollout plan,Risks',
            'renamed by double click',
          );
          // Alt+↑ on Risks
          const risks = doc.live.pageList()[2].id;
          await p.eval(
            `document.querySelector('#pageList .pg[data-page="${risks}"]').focus()`,
          );
          await p.key('ArrowUp', ALT);
          await until(
            () => titles().join() === 'Overview,Risks,Rollout plan',
            'moved up',
          );
          // drag Overview below the last page
          const first = doc.live.pageList()[0].id;
          await p.eval(`(() => {
          const list = document.querySelector('#pageList');
          const row = list.querySelector('.pg[data-page="${first}"]');
          const rows = [...list.querySelectorAll('.pg')];
          const last = rows[rows.length - 1].getBoundingClientRect();
          const dt = new DataTransfer();
          row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
          const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: last.left + 20, clientY: last.bottom - 2 };
          list.dispatchEvent(new DragEvent('dragover', at));
          window.__dropLine = !!list.querySelector('.pg-drop');
          list.dispatchEvent(new DragEvent('drop', at));
          row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
        })()`);
          assert(await p.eval('window.__dropLine'), 'the teal drop line');
          await until(
            () => titles().join() === 'Risks,Rollout plan,Overview',
            'dragged to the end',
          );
          // delete from the row's ⋯ menu, with the confirm
          const rollout = doc.live.pageList()[1].id;
          await p.click(`#pageList .pg[data-page="${rollout}"] .more`);
          await p.click('.menu .mi.dng');
          await p.click('.pop .btn.dng');
          await until(() => titles().join() === 'Risks,Overview', 'deleted');
          // an agent's delete request
          const ask = async (title: string) => {
            const [ok, res] = await s.tool(CHAT, 'doc_page', {
              doc: 'pg',
              action: 'delete',
              page: title,
              ifRev: doc.live.rev,
            });
            assert(ok && res.pending === true, JSON.stringify(res));
          };
          await ask('Risks');
          await p.waitFor(
            `document.querySelector('#pageList .askline') && document.querySelector('#pageList .askline').textContent.startsWith('Claude Code wants to delete Risks')`,
            8000,
            'the request line',
          );
          await p.shot('05-request');
          await p.click('#pageList .req-keep');
          await p.waitFor(
            `document.querySelectorAll('.askline').length === 0`,
            8000,
            'kept',
          );
          assertEquals(titles().join(), 'Risks,Overview');
          await ask('Risks');
          await p.click('#pageList .req-delete');
          await until(
            () => titles().join() === 'Overview',
            'deleted on request',
          );
          await p.waitFor(
            `document.querySelectorAll('#pageList .pg').length === 1`,
          );
          // the last page has no Delete
          await p.click(`#pageList .pg .more`);
          assert(
            await p.eval(`document.querySelector('.menu .mi.dng').disabled`),
            'last page cannot be deleted',
          );
          await p.key('Escape');
          await s.endTurn('c1', 'claude', 'a');
        },
      );

      await step('underline: the U button and Ctrl+U put it on the words, on the server too', async () => {
        await s.tool(CHAT, 'doc_create', { doc: 'under', markdown: 'Ship only behind the flag.\n' });
        const p = await open('under');
        await shows(p, 'Ship only behind the flag.');
        const doc = await live(s, 'under');
        const marked = () => JSON.stringify(doc.live.topBlocks()[0].node);
        assert(await p.eval(caretAfter('only', true)));
        await p.click('#toolbar [data-tool="underline"]');
        await until(() => marked().includes('"underline"'), 'U button: underline on the server');
        await p.waitFor(`document.querySelector('#toolbar [data-tool="underline"]').getAttribute('aria-pressed') === 'true'`, 8000, 'U pressed');
        assertEquals(await p.eval(`[...document.querySelectorAll('#docEditor u')].map((u) => u.textContent).join()`), 'only');
        assert(await p.eval(caretAfter('flag', true)));
        await p.key('u', CTRL);
        await until(() => (marked().match(/"underline"/g) ?? []).length === 2, 'Ctrl+U: a second underline');
        assertEquals(await p.eval(`[...document.querySelectorAll('#docEditor u')].map((u) => u.textContent).join()`), 'only,flag');
      });

      await step('"/" inserts a rich block', async () => {
        await s.tool(CHAT, 'doc_create', { doc: 'slash', markdown: 'Text.\n' });
        const p = await open('slash');
        await shows(p, 'Text.');
        assert(await p.eval(caretAfter('Text.')));
        await p.key('Enter');
        await p.type('/call');
        await p.waitFor(
          `!!document.querySelector('.slash-menu .mi.on')`,
          8000,
          'the "/" menu',
        );
        assertEquals(
          await p.eval(
            `document.querySelector('.slash-menu .mi.on').dataset.block`,
          ),
          'callout',
        );
        await p.key('Enter');
        await p.type('Inside the callout');
        const doc = await live(s, 'slash');
        await until(
          () =>
            doc.live.topBlocks().some((x) =>
              x.node.type === 'callout' &&
              JSON.stringify(x.node).includes('Inside the callout')
            ),
          'a callout on the server',
        );
        assert(
          await p.eval(
            `!!document.querySelector('#docEditor .callout .callout-icon')`,
          ),
        );
        assertEquals(
          await p.eval(`document.querySelectorAll('.slash-menu').length`),
          0,
        );
      });

      await step(
        'placeholders: drag one with ⋮⋮, "Skip this section" deletes one',
        async () => {
          await s.tool(CHAT, 'doc_create', {
            doc: 'ph',
            markdown: 'Intro.\n\nOutro.\n',
          });
          const p = await open('ph');
          await shows(p, 'Outro.');
          const doc = await live(s, 'ph');
          const [ok, res] = await s.tool(CHAT, 'doc_edit', {
            doc: 'ph',
            ops: [{
              op: 'insert',
              target: { kind: 'root' },
              side: 'end',
              source: inline(['Risks: what could slip', 'Timeline'], 'pending'),
            }],
          });
          assert(ok, JSON.stringify(res));
          await p.waitFor(
            `document.querySelectorAll('#docEditor .pending').length === 2`,
            8000,
            'two placeholders',
          );
          assertEquals(
            await p.eval(
              `[...document.querySelectorAll('#docEditor .ph-title')].map((e) => e.textContent).join('|')`,
            ),
            'Risks: what could slip|Timeline',
          );
          assert(
            String(
              await p.eval(
                `document.querySelector('#docEditor .ph-who').textContent`,
              ),
            ).includes('will write this next'),
          );
          await p.shot('07-placeholders');
          // drag the second placeholder above Intro
          await p.eval(`(() => {
          const els = document.querySelectorAll('#docEditor .pending');
          const r = els[1].getBoundingClientRect();
          AIBDoc.showHandles(AIBDoc.blockAt(r.left + 20, r.top + 10));
          const handle = document.querySelector('#blockHandles .bh-drag');
          const dt = new DataTransfer();
          handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
          const first = document.querySelector('#docEditor .ProseMirror > p').getBoundingClientRect();
          const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: first.left + 2, clientY: first.top + 1 };
          const pm = document.querySelector('#docEditor .ProseMirror');
          pm.dispatchEvent(new DragEvent('dragover', at));
          pm.dispatchEvent(new DragEvent('drop', at));
          handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
        })()`);
          await until(
            () =>
              doc.live.topBlocks()[0].node.type === 'pending' &&
              doc.live.topBlocks().length === 4,
            'the placeholder moved to the top',
          );
          await p.click('#docEditor .pending .ph-skip');
          await until(
            () =>
              doc.live.topBlocks().filter((x) => x.node.type === 'pending')
                .length === 1,
            'one skipped',
          );
        },
      );

      await step(
        'comments: add on selected words, then send to the chat',
        async () => {
          await s.tool(CHAT, 'doc_create', {
            doc: 'cm',
            markdown: 'Saved cards move over unchanged.\n',
          });
          const p = await open('cm');
          await shows(p, 'Saved cards');
          assert(await p.eval(caretAfter('Saved cards', true)));
          await p.key('m', CTRL | ALT);
          await p.waitFor(
            `!!document.querySelector('#rail .composer textarea')`,
            8000,
            'the composer',
          );
          await p.eval(
            `document.querySelector('#rail .composer textarea').focus()`,
          );
          await p.type('Make this three short bullets.');
          await p.click('#rail .composer .thr-add');
          const doc = await live(s, 'cm');
          await until(
            () => doc.live.comments.list().threads.length === 1,
            'the thread on the server',
          );
          const thread = doc.live.comments.list().threads[0];
          assertEquals([thread.quote, thread.replies[0].text], [
            'Saved cards',
            'Make this three short bullets.',
          ]);
          await p.waitFor(
            `document.querySelectorAll('#rail .thr').length === 1 && !!document.querySelector('#docEditor .anch')`,
            8000,
            'the card and the anchor',
          );
          assertEquals(
            await p.eval(
              `document.querySelector('#docEditor .anch').textContent`,
            ),
            'Saved cards',
          );
          assertEquals(
            await p.eval(
              `document.querySelector('#rail .send-main').textContent`,
            ),
            'Send to Claude Code',
          );
          await p.click('#rail .send-main');
          await until(() =>
            s.queued.some((q) =>
              q.op === 'queue' &&
              String(q.text).includes('Make this three short bullets.')
            ), 'queued to the chat');
          await p.waitFor(
            `document.querySelector('#rail .donel') && document.querySelector('#rail .donel').textContent.startsWith('Sent to Claude Code')`,
            8000,
            'the sent line',
          );
          await p.shot('08-comments');
          await p.click('#rail .thr-resolve');
          await until(
            () => doc.live.comments.list().threads[0].resolved,
            'resolved',
          );
        },
      );

      await step(
        'history: Compare and restore one page; refused with its name while an agent writes',
        async () => {
          await s.tool(CHAT, 'doc_create', {
            doc: 'hist',
            markdown: 'First.\n',
            title: 'Overview',
          });
          await s.tool(CHAT, 'doc_page', {
            doc: 'hist',
            action: 'add',
            title: 'Risks',
            markdown: 'Risk A is real.',
          });
          const doc = await live(s, 'hist');
          const n1 = s.ctx.docs.snapshot(doc);
          assert(n1, 'a version with Risk A');
          const risks = doc.live.pageList()[1].id;
          let r = await read(s, CHAT, 'hist', 'Risks');
          assert(
            (await s.tool(CHAT, 'doc_edit', {
              ...replace('hist', r.blocks[0], r.rev, 'Risk B is real.'),
              page: 'Risks',
            }))[0],
          );
          r = await read(s, CHAT, 'hist');
          assert(
            (await s.tool(
              CHAT,
              'doc_edit',
              replace('hist', r.blocks[0], r.rev, 'Second.'),
            ))[0],
          );
          s.ctx.docs.snapshot(doc);
          await s.endTurn('c1', 'claude', 'a');
          const p = await open('hist', `&page=${risks}`);
          await shows(p, 'Risk B is real.');
          await p.click('#btnHistory');
          await p.waitFor(
            `document.querySelectorAll('#historyList .hv').length >= 2`,
            8000,
            'the versions',
          );
          await p.click(`#historyList .hv[data-version="${n1}"]`);
          await p.waitFor(
            `!document.querySelector('#docReadOnly').hidden && document.querySelector('#docReadOnly').innerText.includes('Risk A')`,
            8000,
            'the old version',
          );
          await p.click('.ver-compare');
          await p.waitFor(
            `!!document.querySelector('#docReadOnly .ins') && !!document.querySelector('#docReadOnly .delt')`,
            8000,
            'the rendered Compare',
          );
          assertEquals(
            await p.eval(
              `[...document.querySelectorAll('#docReadOnly .rd-pg')].map((e) => e.textContent).join('|')`,
            ),
            'Overview|Risks',
          );
          await p.shot('09-compare');
          await p.click('.ver-restore');
          await p.click('#docReadOnly .confirm .restore-page');
          await until(
            () => mdOf(doc, risks).join() === 'Risk A is real.',
            'the page restored',
          );
          assertEquals(mdOf(doc, doc.live.pageList()[0].id), ['Second.']);
          await p.waitFor(
            `document.querySelector('#docReadOnly').hidden`,
            8000,
            'back to now',
          );
          // an agent writes now: refused with its name
          r = await read(s, CHAT, 'hist');
          assert(
            (await s.tool(
              CHAT,
              'doc_edit',
              replace('hist', r.blocks[0], r.rev, 'Third.'),
            ))[0],
          );
          await p.click(`#historyList .hv[data-version="${n1}"]`);
          await p.click('.ver-restore');
          await p.click('#docReadOnly .confirm .restore-all');
          await p.waitFor(
            `document.querySelector('#docReadOnly .confirm p').textContent.includes('Claude Code is still writing')`,
            8000,
            'the refusal',
          );
          await s.endTurn('c1', 'claude', 'a');
          await p.click('.ver-back');
        },
      );

      await step(
        'Markdown export goes to Downloads and never overwrites',
        async () => {
          await s.tool(CHAT, 'doc_create', {
            doc: 'exp',
            markdown: 'Export me.\n',
            title: 'Overview',
          });
          const p = await open('exp');
          await shows(p, 'Export me.');
          for (const want of ['exp.md', 'exp (2).md']) {
            await p.click('#btnMore');
            await p.click('.more-menu [data-export="page"]');
            await p.waitFor(
              `document.querySelector('.toast') && document.querySelector('.toast').textContent.startsWith('Saved ${want} in Downloads')`,
              8000,
              want,
            );
            assert(
              (await Deno.readTextFile(`${downloads}/${want}`)).includes(
                'Export me.',
              ),
            );
            assert(
              await p.eval(
                `[...document.querySelectorAll('.toast button')].some((b) => b.textContent === 'Show in folder')`,
              ),
            );
            await p.eval(
              `document.querySelectorAll('.toast').forEach((t) => t.remove())`,
            );
          }
        },
      );

      await step(
        'the layout follows the pane width: page list or picker, docked rail or overlay; columns stack under 600 px',
        async () => {
          await s.tool(CHAT, 'doc_create', {
            doc: 'wide',
            markdown: 'Words.\n',
            title: 'Overview',
          });
          await s.tool(CHAT, 'doc_page', {
            doc: 'wide',
            action: 'add',
            title: 'Risks',
            markdown: 'More.',
          });
          const p = await open('wide');
          await shows(p, 'Words.');
          assert(await p.eval(caretAfter('Words.')));
          await p.eval(
            `AIBDoc.blockItems('', {here: true}).find((i) => i.data && i.data.block === 'columns').run()`,
          );
          await p.waitFor(`!!document.querySelector('#docEditor .columns')`);
          const state = () =>
            p.eval<Json>(`({
          list: document.querySelector('#pageList').offsetWidth,
          picker: !document.querySelector('#pagePicker').hidden,
          cols: getComputedStyle(document.querySelector('#docEditor .columns')).flexDirection,
        })`);
          assertEquals(await state(), {
            list: 190,
            picker: false,
            cols: 'row',
          });
          await p.click('#btnComments');
          assertEquals(
            await p.eval(
              `document.querySelector('#rail').classList.contains('rail-overlay')`,
            ),
            false,
          );
          await p.viewport(1000);
          await p.waitFor(
            `document.querySelector('#rail').classList.contains('rail-overlay')`,
            8000,
            'the overlay rail',
          );
          await p.viewport(800);
          await p.waitFor(
            `document.querySelector('#pageList').offsetWidth === 0`,
            8000,
            'the list folded',
          );
          assertEquals((await state()).picker, true);
          await p.viewport(520);
          await p.waitFor(
            `getComputedStyle(document.querySelector('#docEditor .columns')).flexDirection === 'column'`,
            8000,
            'columns stacked',
          );
          await p.shot('11-narrow');
          await p.click('#pagePicker');
          await p.waitFor(
            `document.querySelectorAll('.page-menu .pg').length === 2`,
            8000,
            'the picker lists the pages',
          );
          await p.key('Escape');
          await p.viewport(1280);
        },
      );

      await step('charts: Make chart from this table, Bar and Line, the Data table; toggles open per viewer', async () => {
        await s.tool(CHAT, 'doc_create', {
          doc: 'rich',
          markdown: 'Numbers.\n\n| Week | Old | New |\n|---|---|---|\n| W1 | 3 | 4 |\n| W2 | 5 | 6 |\n',
        });
        const p = await open('rich');
        await p.waitFor(`!!document.querySelector('#docEditor table')`, 8000, 'the table');
        await p.eval(`(() => {
          const r = document.querySelector('#docEditor table').getBoundingClientRect();
          AIBDoc.showHandles(AIBDoc.blockAt(r.left + 20, r.top + 10));
        })()`);
        await p.click('#blockHandles .bh-drag');
        await p.waitFor(
          `[...document.querySelectorAll('.block-menu .mi')].some((b) => b.textContent.includes('Make chart from this table'))`,
          8000,
          'the table menu',
        );
        await p.eval(
          `[...document.querySelectorAll('.block-menu .mi')].find((b) => b.textContent.includes('Make chart from this table')).click()`,
        );
        const doc = await live(s, 'rich');
        const chart = () => doc.live.topBlocks().find((x) => x.node.type === 'chart');
        await until(() => !!chart(), 'a chart on the server');
        await p.waitFor(`document.querySelectorAll('#docEditor .chart .ch-bar').length === 4`, 8000, 'four bars');
        assertEquals(await p.eval(`document.querySelector('#docEditor .ch-leg').textContent`), 'OldNew');
        await p.click('#docEditor .chart .seg [data-chart-type="line"]');
        await until(() => chart()!.node.attrs?.chartType === 'line', 'Line on the server');
        await p.waitFor(`document.querySelectorAll('#docEditor .chart .ch-line').length === 2`, 8000, 'two lines');
        assert(await p.eval(`getComputedStyle(document.querySelector('#docEditor .chart .ch-data')).display === 'none'`));
        await p.click('#docEditor .chart .chart-data-btn');
        assert(
          await p.eval(`getComputedStyle(document.querySelector('#docEditor .chart .ch-data')).display !== 'none'`),
          'the Data table opens',
        );
        await p.shot('13-chart');
        // a toggle: open or closed is this viewer's, never the doc's
        assert(await p.eval(caretAfter('Numbers.')));
        await p.eval(`AIBDoc.blockItems('', {here: true}).find((i) => i.data && i.data.block === 'toggle').run()`);
        await until(() => doc.live.topBlocks().some((x) => x.node.type === 'toggle'), 'a toggle on the server');
        await p.waitFor(`!!document.querySelector('#docEditor .toggle.open')`, 8000, 'open after insert');
        assert(!JSON.stringify(doc.live.topBlocks().find((x) => x.node.type === 'toggle')!.node).includes('open'), 'not in the doc');
        await p.click('#docEditor .toggle .tg-car');
        await p.waitFor(`!document.querySelector('#docEditor .toggle.open')`);
        await p.click('#docEditor .toggle .tg-car');
        await p.goto(s.url(`/doc.html?chat=${CHAT}&name=rich`));
        await p.waitFor(`!!document.querySelector('#docEditor .toggle.open')`, 8000, 'still open after a reload');
        await p.eval(
          `Object.keys(localStorage).filter((k) => k.startsWith('aib-doc-toggles:')).forEach((k) => localStorage.removeItem(k))`,
        );
        await p.goto(s.url(`/doc.html?chat=${CHAT}&name=rich`));
        await p.waitFor(
          `!!document.querySelector('#docEditor .toggle') && !document.querySelector('#docEditor .toggle.open')`,
          8000,
          'another viewer sees it closed',
        );
      });

      await step('a drawing shows its picture; full screen view', async () => {
        await s.tool(CHAT, 'doc_create', { doc: 'draw', markdown: 'Flow below.\n' });
        const [ok, made] = await s.tool(CHAT, 'drawing_create', { doc: 'draw', caption: 'Rollout flow' });
        assert(ok, JSON.stringify(made));
        assert((await s.tool(CHAT, 'drawing_edit', { drawing: made.drawing, doc: 'draw', ops: [{ op: 'add_box', text: 'Ship' }] }))[0]);
        await s.ctx.docs.flush(await live(s, 'draw'));
        const p = await open('draw');
        await p.waitFor(
          `(() => { const i = document.querySelector('#docEditor .drw-img'); return !!i && !i.hidden && i.naturalWidth > 0; })()`,
          10000,
          'the picture',
        );
        assertEquals(await p.eval(`document.querySelector('#docEditor .drawing .figcap').textContent`), 'Rollout flow');
        await p.click('#docEditor .drw-bar .btn');
        await p.waitFor(
          `(() => { const i = document.querySelector('.drw-full img'); return !!i && i.naturalWidth > 0; })()`,
          8000,
          'full screen',
        );
        await p.click('.drw-full .fs-head .btn');
        await s.endTurn('c1', 'claude', 'a');
      });

      await step('the header chip "Shown in 1 artifact: <title>" opens that artifact; a doc nothing is built from has none', async () => {
        await s.tool(CHAT, 'doc_create', { doc: 'shown', markdown: 'Dates.\n', title: 'Rollout' });
        const doc = await live(s, 'shown');
        const store = s.ctx.artifacts.service.store;
        const a = store.create('claude:a', 'Checkout v2 timeline', 'html', 't.html', new TextEncoder().encode('<p>x</p>'), { project: s.project });
        store.setFromDoc(a.id, { doc: 'shown', title: 'shown', page: doc.live.firstPage, pageTitle: 'Rollout', rev: 1 });
        const p = await open('shown');
        await shows(p, 'Dates.');
        await p.waitFor(`!document.querySelector('#docShown').hidden`, 8000, 'the chip');
        assertEquals(await p.eval(`document.querySelector('#docShown').textContent`), 'Shown in 1 artifact: Checkout v2 timeline');
        await p.eval(`window.__told = []; AIBDoc.tell = (m) => window.__told.push(m)`);
        await p.click('#docShown');
        assertEquals(await p.eval(`window.__told[0]`), { type: 'aib-doc:show-artifact', id: a.id, chat: 'claude:a' });
        assertEquals(await p.violations(), []);
        const q = await open('plan');
        await shows(q, 'Beta from Claude.');
        assertEquals(await q.eval(`document.querySelector('#docShown').hidden`), true);
      });

      await step('the ⋯ menu: Show in Files, Duplicate doc, Move doc to trash; chat.html can send the tab to a page', async () => {
        await s.tool(CHAT, 'doc_create', { doc: 'menu', markdown: 'Keep me.\n', title: 'Overview' });
        await s.tool(CHAT, 'doc_page', { doc: 'menu', action: 'add', title: 'Risks', markdown: 'Risky words.' });
        const p = await open('menu');
        await shows(p, 'Keep me.');
        await p.eval(`window.__told = []; AIBDoc.tell = (m) => window.__told.push(m)`);
        const doc = await live(s, 'menu');
        // chat.html to the tab: go to a page
        await p.eval(`window.postMessage({ type: 'aib-doc:goto', page: ${JSON.stringify(doc.live.pageList()[1].id)} }, location.origin)`);
        await shows(p, 'Risky words.');
        await p.click('#btnMore');
        await p.click('.more-menu [data-act="files"]');
        const dir = await p.eval<string>('AIBDoc.info.dir');
        assertEquals(await p.eval(`window.__told.find((m) => m.type === 'aib-doc:show-in-files')`), { type: 'aib-doc:show-in-files', dir });
        await p.click('#btnMore');
        await p.click('.more-menu [data-act="duplicate"]');
        await p.waitFor(
          `document.querySelector('.toast') && document.querySelector('.toast').textContent.startsWith('Made menu copy.')`,
          8000,
          'the copy',
        );
        assert(await s.ctx.docs.exists(s.project, 'menu copy'));
        const copy = await s.ctx.docs.open(s.project, 'menu copy');
        assertEquals(copy.live.pageList().map((x) => x.title), ['Overview', 'Risks']);
        assertEquals(mdOf(copy, copy.live.pageList()[1].id), ['Risky words.']);
        const trashed: string[] = [];
        (s.ctx as unknown as { trashLayer: unknown }).trashLayer = {
          kind: () => Promise.resolve('recycle'),
          trash: async (path: string) => {
            trashed.push(path);
            await Deno.remove(path, { recursive: true });
          },
        };
        await p.click('#btnMore');
        await p.click('.more-menu [data-act="trash"]');
        await p.click('.pop .btn.dng');
        await until(() => trashed.length === 1, 'the folder in the trash');
        assertEquals(trashed[0], doc.dir);
        await p.waitFor(`window.__told.some((m) => m.type === 'aib-doc:closed')`, 8000, 'closed told to chat.html');
        assert(!(await s.ctx.docs.exists(s.project, 'menu')), 'gone from the project');
      });

      await step('restore while keystrokes are in flight: the page tries again, then says so', async () => {
        await s.tool(CHAT, 'doc_create', { doc: 'flight', markdown: 'One.\n' });
        const doc = await live(s, 'flight');
        const n = (s.ctx.docs.history(doc) as { latest: number }).latest;
        assert(n, 'a version to restore');
        const p = await open('flight');
        await p.eval(`(() => {
          const real = window.fetch; window.__restores = 0;
          window.fetch = (u, o) => String(u).includes('/history/restore')
            ? (window.__restores++, Promise.resolve(new Response(JSON.stringify({ code: 'in_flight', error: 'Your last keystrokes have not reached AIB yet: nothing was restored. Try again in a moment.' }), { status: 409 })))
            : real(u, o);
        })()`);
        await p.click('#btnHistory');
        await p.click(`#historyList .hv[data-version="${n}"]`);
        await p.click('.ver-restore');
        await p.click('#docReadOnly .confirm .restore-all');
        await p.waitFor(
          `document.querySelector('#docReadOnly .confirm p').textContent.includes('have not reached AIB yet')`,
          8000,
          'the refusal after retries',
        );
        assertEquals(await p.eval('window.__restores'), 6);
      });

      await step(
        'reopen after a restart: no duplicate blocks; keystrokes that never reached AIB are named',
        async () => {
          await s.tool(CHAT, 'doc_create', {
            doc: 'restart',
            markdown: 'One.\n\nTwo.\n',
          });
          const p = await open('restart');
          await shows(p, 'Two.');
          const { root, port } = s;
          await s.close();
          await p.waitFor(
            `document.querySelector('#docStatusText').textContent.startsWith('Offline')`,
            8000,
            'offline',
          );
          assert(await p.eval(caretAfter('Two.')));
          await p.type(' Lost');
          await p.waitFor(
            `document.querySelector('#docStatusText').textContent === 'Offline · not saved yet'`,
          );
          s = await studio(root, port);
          await p.waitFor(
            `!document.querySelector('#docBanner').hidden && document.querySelector('#docBanner').textContent.includes('Not saved')`,
            20000,
            'the not-saved note',
          );
          await p.waitFor(
            `document.querySelector('#docStatusText').textContent === 'Saved'`,
            8000,
            'saved again',
          );
          const text = await editorText(p);
          assertEquals(text.split('One.').length - 1, 1, text);
          assertEquals(text.split('Two.').length - 1, 1, text);
          assert(!text.includes('Lost'), 'the lost words are not merged in');
          const doc = await live(s, 'restart');
          assertEquals(mdOf(doc), ['One.', 'Two.']);
          await p.click('#docBanner .linkish');
          assert(
            String(
              await p.eval(
                `document.querySelector('#docBanner .lost').textContent`,
              ),
            ).includes('Two. Lost'),
          );
          await p.shot('12-reopen');
        },
      );
    } finally {
      const csp: string[] = [];
      const errors: string[] = [];
      for (const p of pages) {
        csp.push(...(await p.violations().catch(() => [])));
        errors.push(...p.errors);
        await p.close();
      }
      await b.close();
      await s.done();
      await Deno.remove(downloads, { recursive: true }).catch(() => {});
      Deno.env.delete('AIB_DOWNLOADS_DIR');
      assertEquals(csp, [], 'no CSP violations on the doc page');
      assertEquals(errors, [], 'no errors on the doc page');
    }
  },
});

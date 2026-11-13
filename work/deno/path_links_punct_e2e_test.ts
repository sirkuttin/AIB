/**
 * Paths in a reply next to sentence punctuation, and outside paths the agent streamed in pieces, end to end: a real Studio (Deno web
 * server + in-process agent host, temp state folder, free port; never the live ports), the scripted agent, and a headless
 * Chrome/Edge on chat.html (no window).
 *
 * - `C:\...\release-checklist.md. Two more…`: the full stop ends the sentence, the path still links (outside the project and inside).
 * - The same after `,` `;` `:` `)` `!` `?` and closing quotes.
 * - An outside path that arrives split over two streamed chunks links: the server checks the chat's assembled reply text.
 * - A longer name (`notes.md.bak`) still does not count as naming `notes.md`.
 *
 * Run (from outputs/agent-studio): deno task test path_links_punct_e2e
 */
import { assert, assertEquals } from './_assert.ts';
import { browserPath, Lab, settle, shown } from './_scroll_lab.ts';

Deno.test({
  name: 'paths followed by sentence punctuation link (outside and inside the project); an outside path streamed in pieces links',
  ignore: !browserPath || Deno.build.os !== 'windows',
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const lab = await Lab.open(1400, 900);
    const outDir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-punct-links-' }));
    try {
      const page = lab.page;
      const names = ['release-checklist.md', 'comma.md', 'semi.txt', 'colon.txt', 'paren.md', 'bang.md', 'ask.md', 'quoted.md', 'split-in-two.md'];
      const out = Object.fromEntries(names.map((n) => [n, `${outDir}\\${n}`]));
      for (const p of Object.values(out)) Deno.writeTextFileSync(p, 'x\n');
      Deno.writeTextFileSync(`${outDir}\\never-named.md`, 'x\n');
      Deno.mkdirSync(`${lab.fx.workspace}\\notes`, { recursive: true });
      for (const n of ['inside-a.md', 'inside-b.md', 'inside-c.md']) Deno.writeTextFileSync(`${lab.fx.workspace}\\notes\\${n}`, 'x\n');

      const chat = await lab.chat();
      await chat.start();
      chat.say(
        `Updated ${out['release-checklist.md']}. Two more… then ${out['comma.md']}, ${out['semi.txt']}; ${out['colon.txt']}: ` +
          `(${out['paren.md']}) ${out['bang.md']}! ${out['ask.md']}? “${out['quoted.md']}”. Not this: ${outDir}\\never-named.md.bak\n\n`,
      );
      // the split path: two chunks, cut inside the file name
      const split = out['split-in-two.md'];
      const cut = split.length - 9;
      chat.say(`Also wrote ${split.slice(0, cut)}`);
      chat.say(`${split.slice(cut)}. Inside: notes/inside-a.md. Then notes/inside-b.md, and (notes/inside-c.md). PUNCTREADY`);
      await lab.select(chat);
      await shown(page, 'PUNCTREADY');
      const want = names.length + 3;
      await page.waitFor(`document.querySelectorAll('#messages a.fx-path').length >= ${want}`, 20000, 'the path links').catch(() => 0);
      const links = await page.eval<{ abs: string; path: string; text: string }[]>(
        `Array.from(document.querySelectorAll('#messages a.fx-path')).map((a) => ({ abs: a.dataset.abs, path: a.dataset.filePath, text: a.textContent }))`,
      );
      const outsideLinked = links.map((l) => l.abs).filter((a) => a.startsWith(outDir));
      assertEquals(outsideLinked.sort(), Object.values(out).sort(), 'every outside path links: ' + JSON.stringify(links));
      const insideLinked = links.filter((l) => !l.abs.startsWith(outDir)).map((l) => l.path).sort();
      assertEquals(insideLinked, ['notes/inside-a.md', 'notes/inside-b.md', 'notes/inside-c.md']);
      for (const l of links) assert(!/[.,;:)!?”]$/.test(l.text), 'no punctuation in the link text: ' + l.text);

      const q = (p: string) =>
        lab.web.get(`/api/live/files/outside?id=${encodeURIComponent(chat.id)}&path=${encodeURIComponent(p)}&peek=1`);
      assertEquals((await q(out['release-checklist.md']))[0], 200, 'named, then a full stop');
      assertEquals((await q(split))[0], 200, 'named in two streamed pieces');
      assertEquals((await q(`${outDir}\\never-named.md`))[0], 403, 'a longer name does not name it');
      await settle(200);
      assertEquals(page.errors, [], 'no console errors');
      chat.end();
    } finally {
      await lab.close();
      try {
        Deno.removeSync(outDir, { recursive: true });
      } catch { /* gone */ }
    }
  },
});

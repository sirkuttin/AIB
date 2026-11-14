/**
 * Paths outside the project in a reply, end to end: a real Studio (Deno web server + in-process agent host, temp state folder, free
 * port; never the live ports), the scripted agent, and a headless Chrome/Edge on chat.html (no window).
 *
 * The agent's reply names a screenshot, a text file and a binary file in a temp folder that is not the chat's folder, and a file
 * that does not exist. The named files become links (outside hint in the tooltip); the missing one stays plain text. A click opens
 * the read-only "Outside this project" tab: an image shows as an image, text as text, the binary file says so. A second chat that
 * never named the files is refused by the server.
 *
 * AIB_DOCPAGE_SHOTS=<folder> keeps screenshots (the reply with the links, the opened tab).
 * Run (from outputs/agent-studio): deno task test outside_links_e2e
 */
import { assert, assertEquals } from "./_assert.ts";
import { browserPath, Lab, settle, shown } from "./_scroll_lab.ts";

// a 1x1 PNG
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

Deno.test({
  name:
    "a path outside the project in a reply links when the chat named it: read-only tab, image shows, missing stays text, other chats refused",
  ignore: !browserPath || Deno.build.os !== "windows",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const lab = await Lab.open(1400, 900);
    const outDir = Deno.realPathSync(
      Deno.makeTempDirSync({ prefix: "aib-outside-links-" }),
    );
    try {
      const page = lab.page;
      const png = `${outDir}\\4-recently-deleted-light.png`,
        txt = `${outDir}\\notes.txt`,
        bin = `${outDir}\\blob.bin`,
        gone = `${outDir}\\missing-shot.png`;
      Deno.writeFileSync(png, PNG);
      Deno.writeTextFileSync(txt, "first line\nsecond line\n");
      Deno.writeFileSync(bin, new Uint8Array([1, 0, 2, 0, 3]));
      const chat = await lab.chat();
      await chat.start();
      chat.say(
        `Screenshot: ${png}, notes: ${txt}, data: ${bin}, never made: ${gone}. OUTREADY`,
      );
      const other = await lab.chat();
      await lab.select(chat);
      await shown(page, "OUTREADY");
      await page.waitFor(
        `document.querySelectorAll('#messages a.fx-path').length >= 3`,
        20000,
        "the outside links",
      );
      const links = await page.eval<
        { abs: string; title: string; text: string }[]
      >(
        `Array.from(document.querySelectorAll('#messages a.fx-path')).map((a) => ({ abs: a.dataset.abs, title: a.title, text: a.textContent }))`,
      );
      assertEquals(links.map((l) => l.abs), [png, txt, bin]);
      assert(
        links[0].title.includes("Outside this project") &&
          links[0].title.includes("Opens read-only"),
        links[0].title,
      );
      assertEquals(
        await page.eval(
          `document.querySelector('#messages').textContent.includes('never made: ${
            gone.replaceAll("\\", "\\\\")
          }.')`,
        ),
        true,
        "the missing file stays plain text",
      );
      await page.shot("outside-1-reply-with-links");

      // a click on the screenshot: the read-only tab, the image
      await page.eval(
        `document.querySelectorAll('#messages a.fx-path')[0].click()`,
      );
      await page.waitFor(
        `!!document.querySelector('#fileView:not([hidden]) img.sf-fv-img, #fileBeside:not([hidden]) img.sf-fv-img')`,
        15000,
        "the image",
      );
      const view = await page.eval<{ chip: string; foot: string; w: number }>(
        `(() => {
        const v = document.querySelector('#fileView:not([hidden])') || document.querySelector('#fileBeside:not([hidden])');
        const img = v.querySelector('img.sf-fv-img');
        return { chip: v.querySelector('.sf-fv-from').textContent, foot: v.querySelector('.fx-pv-foot').textContent, w: img.naturalWidth };
      })()`,
      );
      assert(view.chip.startsWith("Outside this project"), view.chip);
      assert(view.foot.includes("Read-only"), view.foot);
      assertEquals(view.w, 1, "the PNG itself is loaded");
      await page.shot("outside-2-image-tab");

      // text opens as text
      await page.eval(
        `document.querySelectorAll('#messages a.fx-path')[1].click()`,
      );
      await page.waitFor(
        `(document.querySelector('#fileView:not([hidden]), #fileBeside:not([hidden])') || document.body).textContent.includes('second line')`,
        15000,
        "the text",
      );
      // the binary file says so
      await page.eval(
        `document.querySelectorAll('#messages a.fx-path')[2].click()`,
      );
      await page.waitFor(
        `(document.querySelector('#fileView:not([hidden]), #fileBeside:not([hidden])') || document.body).textContent.includes('This is a binary file')`,
        15000,
        "the binary note",
      );

      // a chat that never named the files is refused, and so is a path nobody named
      const q = (id: string, p: string) =>
        lab.web.get(
          `/api/live/files/outside?id=${encodeURIComponent(id)}&path=${
            encodeURIComponent(p)
          }&peek=1`,
        );
      assertEquals((await q(chat.id, png))[0], 200);
      assertEquals(
        (await q(other.id, png))[0],
        403,
        "another chat never named it",
      );
      assertEquals((await q(chat.id, `${outDir}\\notes2.txt`))[0], 403);
      await settle(200);
      assertEquals(page.errors, [], "no console errors");
      chat.end();
    } finally {
      await lab.close();
      try {
        Deno.removeSync(outDir, { recursive: true });
      } catch { /* gone */ }
    }
  },
});

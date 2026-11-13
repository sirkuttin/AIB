/**
 * Archive and delete artifacts, end to end (owner decisions 2026-11-12): a real Studio (Deno web server + in-process agent host,
 * temp state folder and workspace, free port; never the live ports), the scripted agent work/scroll-fixture/agent.py, and a headless
 * Chrome/Edge on chat.html (no window). Every file this test deletes is in the fixture's temp workspace.
 *
 *  - The picker's row ⋯ and right-click: Archive moves an artifact to "Archived 1", Unarchive brings it back (row and viewer menu).
 *    Archiving a pinned one says "Unpinned and archived". Archive, Unarchive and a reload (events replay): it shows as live.
 *  - Delete from the viewer's ⋯: the agent's file leaves outputs/ (into the artifact's bin), the Recently deleted row says when and
 *    "Removed for good on …" and names the file; Restore puts the same bytes back. Undo in the note line does the same within 10 s,
 *    and the line stays while the pointer is on it.
 *  - Delete now: the inline "Delete for good? This can't be undone. Delete for good · Keep", no pop-up; Keep backs out.
 *  - Restore while a new file sits at the old path: the old one comes back as "<name> (restored).<ext>".
 *  - Nothing live left: "Nothing showing. Archived 1" opens the picker on that group.
 *  - Links in a reply read "· archived" / "· deleted" with exactly one states request; clicking a deleted one shows Restore.
 *
 * AIB_ARCHIVE_SHOTS=<folder> keeps screenshots (light and dark) of the picker groups, the row menu, Recently deleted with the inline
 * confirm and the link labels.
 *
 * Run (from outputs/agent-studio): deno test -A ../../work/deno/artifact_archive_e2e_test.ts
 */
import { assert } from "./_assert.ts";
import {
  browserPath,
  type Chat,
  Lab,
  type Page,
  settle,
  shown,
  sleep,
} from "./_scroll_lab.ts";
import { DENO_ONLY } from "../../outputs/agent-studio/server/web/routes.ts";

const SEP = Deno.build.os === "windows" ? "\\" : "/";
/** The server half (feat/artifact-bin-server) registers these routes; on a tree without it there is nothing to test end to end. */
const SERVER_READY = [
  "/api/live/artifacts/archive",
  "/api/live/artifacts/delete",
  "/api/live/artifacts/states",
].every((p) => DENO_ONLY.some((r) => r[1] === p));

function e2e(name: string, fn: (lab: Lab) => Promise<void>) {
  Deno.test({
    name,
    ignore: !browserPath || !SERVER_READY,
    sanitizeResources: false,
    sanitizeOps: false,
    async fn() {
      const lab = await Lab.open(1600, 900);
      try {
        await fn(lab);
        assert(
          lab.page.errors.length === 0,
          `console errors: ${lab.page.errors.join(" | ")}`,
        );
      } finally {
        await lab.close();
      }
    },
  });
}

async function openChat(lab: Lab): Promise<Chat> {
  const chat = await lab.chat();
  await chat.start();
  chat.say("Hello READY");
  await lab.select(chat);
  await shown(lab.page, "READY");
  return chat;
}

/** The agent's file in the workspace's outputs/ folder, published by path (an agent artifact: Delete takes the file). */
async function publishFile(
  lab: Lab,
  chat: Chat,
  name: string,
  title: string,
  body = "",
): Promise<{ id: string; path: string }> {
  const dir = `${lab.fx.workspace}${SEP}outputs`;
  Deno.mkdirSync(dir, { recursive: true });
  const path = `${dir}${SEP}${name}`;
  Deno.writeTextFileSync(
    path,
    body || `<h1>${title}</h1><p>${title} body.</p>`,
  );
  const [status, made] = await lab.web.post("artifacts/publish", {
    conversationId: chat.id,
    path,
    title,
  });
  assert(
    status === 200,
    `artifacts/publish: ${status} ${JSON.stringify(made)}`,
  );
  return { id: String(made.id), path };
}

async function showArtifacts(page: Page, count: number) {
  await page.click("#paneTab-artifacts");
  await page.waitFor(
    `ArtifactsUI.state().list.length >= ${count}`,
    15000,
    `${count} artifacts in the panel`,
  );
  await settle(300);
}

async function openPicker(page: Page) {
  await page.waitFor(
    `!document.querySelector('#artifactsPane .ar-pick').disabled`,
    10000,
    "the picker is a dropdown",
  );
  await page.click("#artifactsPane .ar-pick");
  await page.waitFor(
    `!document.querySelector('#artifactsPane > .ar-pop:not(.ar-rowmenu)').hidden`,
    5000,
    "the picker opens",
  );
}

const pop =
  `document.querySelector('#artifactsPane > .ar-pop:not(.ar-rowmenu)')`;
const rowSel = (id: string) =>
  `#artifactsPane .ar-pop .ar-it[data-key="row:${id}"]`;

/** Hover a row so its ⋯ shows, then click the ⋯. */
async function rowMenu(page: Page, id: string) {
  const box = await page.eval<[number, number]>(
    `(() => { const r = document.querySelector(${
      JSON.stringify(rowSel(id))
    }).getBoundingClientRect(); return [r.left + 20, r.top + r.height / 2]; })()`,
  );
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: box[0],
    y: box[1],
  });
  await page.click(`${rowSel(id)} .ar-dots`);
  await page.waitFor(
    `!document.querySelector('#artifactsPane .ar-rowmenu').hidden`,
    5000,
    "the row menu",
  );
}
const rowMenuIds = (page: Page) =>
  page.eval<string[]>(
    `[...document.querySelectorAll('#artifactsPane .ar-rowmenu .ar-it')].map((b) => b.dataset.id)`,
  );
const noteText = (page: Page) =>
  page.eval<string>(
    `(document.querySelector('#artifactsPane .ar-note:not([hidden]) .ar-note-t') || {}).textContent || ''`,
  );

/** AIB_ARCHIVE_SHOTS: a PNG of the right column in the light and the dark theme. */
async function shots(page: Page, name: string) {
  const dir = Deno.env.get("AIB_ARCHIVE_SHOTS");
  if (!dir) return;
  await Deno.mkdir(dir, { recursive: true });
  const before = await page.eval<string>(
    `document.documentElement.getAttribute('data-theme') || ''`,
  );
  const clip = await page.eval<
    { x: number; y: number; width: number; height: number }
  >(`(() => {
    const r = document.getElementById('subagentsPane').getBoundingClientRect();
    return { x: Math.max(0, r.left - 4), y: 0, width: Math.min(innerWidth - Math.max(0, r.left - 4), r.width + 8), height: innerHeight };
  })()`);
  for (const theme of ["teal-light", "teal-dark"]) {
    await page.eval(
      `document.documentElement.setAttribute('data-theme', ${
        JSON.stringify(theme)
      })`,
    );
    await sleep(150);
    const png = await page.send("Page.captureScreenshot", {
      format: "png",
      clip: { ...clip, scale: 1 },
    });
    Deno.writeFileSync(
      `${dir}/${name}-${theme.replace("teal-", "")}.png`,
      Uint8Array.from(atob(String(png.data ?? "")), (c) => c.charCodeAt(0)),
    );
  }
  if (before) {
    await page.eval(
      `document.documentElement.setAttribute('data-theme', ${
        JSON.stringify(before)
      })`,
    );
  }
}
/** A PNG of the chat messages (the link labels). */
async function messageShots(page: Page, name: string, marker: string) {
  const dir = Deno.env.get("AIB_ARCHIVE_SHOTS");
  if (!dir) return;
  await Deno.mkdir(dir, { recursive: true });
  const clip = await page.eval<
    { x: number; y: number; width: number; height: number }
  >(`(() => {
    const p = [...document.querySelectorAll('#messages .markdown')].find((m) => m.textContent.includes(${
    JSON.stringify(marker)
  }));
    const r = (p.closest('article') || p).getBoundingClientRect();
    return { x: r.left - 8, y: r.top - 8, width: r.width + 16, height: r.height + 16 };
  })()`);
  for (const theme of ["teal-light", "teal-dark"]) {
    await page.eval(
      `document.documentElement.setAttribute('data-theme', ${
        JSON.stringify(theme)
      })`,
    );
    await sleep(150);
    const png = await page.send("Page.captureScreenshot", {
      format: "png",
      clip: { ...clip, scale: 1 },
    });
    Deno.writeFileSync(
      `${dir}/${name}-${theme.replace("teal-", "")}.png`,
      Uint8Array.from(atob(String(png.data ?? "")), (c) => c.charCodeAt(0)),
    );
  }
}

const exists = (p: string) => {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
};

e2e(
  'row ⋯ and right-click: Archive to "Archived 1" and back; a pinned one says "Unpinned and archived"; a reload after archive and unarchive shows it live',
  async (lab) => {
    const page = lab.page;
    const chat = await openChat(lab);
    const a = await publishFile(lab, chat, "plan.html", "Release plan");
    const b = await publishFile(lab, chat, "notes.html", "Load test summary");
    await showArtifacts(page, 2);
    await openPicker(page);
    await shots(page, "1-picker-live");
    // the ⋯ menu of a live row
    await rowMenu(page, a.id);
    assert(
      JSON.stringify(await rowMenuIds(page)) ===
        JSON.stringify(["open", "pin", "archive", "delete"]),
      `row menu: ${await rowMenuIds(page)}`,
    );
    await shots(page, "2-row-menu");
    await page.click('#artifactsPane .ar-rowmenu .ar-it[data-id="archive"]');
    await page.waitFor(
      `/Archived "Release plan"\\./.test((document.querySelector('#artifactsPane .ar-note-t') || {}).textContent || '')`,
      8000,
      "the note",
    );
    // the picker redraws in place: "This chat" has one, "Archived 1" at the foot, closed
    const groups = await page.eval<string>(
      `[...${pop}.querySelectorAll('.ar-gh, .ar-foothead')].map((g) => g.textContent).join('|')`,
    );
    assert(
      /This chat/i.test(groups) && /Archived\s*1/.test(groups),
      `groups: ${groups}`,
    );
    assert(
      !(await page.eval<boolean>(
        `!!document.querySelector(${JSON.stringify(rowSel(a.id))})`,
      )),
      "the archived row is out of This chat",
    );
    assert(
      (await page.eval<string>(
        `document.querySelector('#paneTab-artifacts .pane-badge').textContent`,
      )) === "1",
      "the tab count drops",
    );
    // open the group: the row is there; right-click opens the same menu, with Unarchive
    await page.click(`#artifactsPane .ar-foothead[data-key="foot:archived"]`);
    await page.waitFor(
      `!!document.querySelector(${JSON.stringify(rowSel(a.id))})`,
      5000,
      "the archived row",
    );
    await shots(page, "3-picker-archived-open");
    const r = await page.eval<[number, number]>(
      `(() => { const r = document.querySelector(${
        JSON.stringify(rowSel(a.id))
      }).getBoundingClientRect(); return [r.left + 30, r.top + r.height / 2]; })()`,
    );
    await page.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: r[0],
      y: r[1],
      button: "right",
      clickCount: 1,
    });
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: r[0],
      y: r[1],
      button: "right",
      clickCount: 1,
    });
    await page.waitFor(
      `!document.querySelector('#artifactsPane .ar-rowmenu').hidden`,
      5000,
      "right-click opens the row menu",
    );
    assert(
      JSON.stringify(await rowMenuIds(page)) ===
        JSON.stringify(["open", "unarchive", "delete"]),
      `archived row menu: ${await rowMenuIds(page)}`,
    );
    await page.click('#artifactsPane .ar-rowmenu .ar-it[data-id="unarchive"]');
    await page.waitFor(
      `/Unarchived "Release plan"/.test((document.querySelector('#artifactsPane .ar-note-t') || {}).textContent || '')`,
      8000,
      "unarchived",
    );
    await page.key("Escape");
    // a pinned artifact: archive from the viewer's ⋯ unpins it and says so; Unarchive (viewer ⋯) does not pin it again
    const [ps] = await lab.web.post("artifacts/pin", {
      id: b.id,
      pinned: true,
    });
    assert(ps === 200, "pin");
    await page.waitFor(
      `ArtifactsUI.state().list.find((x) => x.id === ${
        JSON.stringify(b.id)
      }).pinned === true`,
      10000,
      "pinned",
    );
    await page.eval(`ArtifactsUI.open(${JSON.stringify(b.id)})`);
    await page.click('#artifactsPane .ar-bar .ar-ico[aria-haspopup="menu"]');
    await page.click(`#artifactsPane > .ar-pop .ar-it[data-id="archive"]`);
    await page.waitFor(
      `/Unpinned and archived "Load test summary"/.test((document.querySelector('#artifactsPane .ar-note-t') || {}).textContent || '')`,
      8000,
      "unpinned and archived",
    );
    // the viewer moved on to the live one; open the archived one: the strip and Unarchive in the menu
    await page.waitFor(
      `ArtifactsUI.state().selId === ${JSON.stringify(a.id)}`,
      5000,
      "the viewer moved to the live artifact",
    );
    await page.eval(`ArtifactsUI.open(${JSON.stringify(b.id)})`);
    await page.waitFor(
      `!document.querySelector('#artifactsPane .ar-archived').hidden`,
      5000,
      "the archived strip",
    );
    await page.click('#artifactsPane .ar-bar .ar-ico[aria-haspopup="menu"]');
    const menu = await page.eval<string[]>(
      `[...document.querySelectorAll('#artifactsPane > .ar-pop .ar-it')].map((b) => b.dataset.id)`,
    );
    assert(
      menu.includes("unarchive") && !menu.includes("pin"),
      `viewer menu on an archived artifact: ${menu}`,
    );
    await page.click(`#artifactsPane > .ar-pop .ar-it[data-id="unarchive"]`);
    await page.waitFor(
      `!ArtifactsUI.state().list.find((x) => x.id === ${
        JSON.stringify(b.id)
      }).archivedAt`,
      8000,
      "unarchived",
    );
    assert(
      !(await page.eval<boolean>(
        `!!ArtifactsUI.state().list.find((x) => x.id === ${
          JSON.stringify(b.id)
        }).pinned`,
      )),
      "Unarchive does not pin again",
    );
    // archive, unarchive, reload: the events replay and it shows as live (break 5)
    await lab.web.post("artifacts/archive", {
      conversationId: chat.id,
      ids: [a.id],
      archived: true,
    });
    await lab.web.post("artifacts/archive", {
      conversationId: chat.id,
      ids: [a.id],
      archived: false,
    });
    await page.goto(`http://127.0.0.1:${lab.web.port}/chat.html`);
    await lab.select(chat);
    await showArtifacts(page, 2);
    await settle(1500);
    const st = await page.eval<string>(
      `ArtifactsUI.state().list.map((x) => x.id + ':' + (x.archivedAt ? 'a' : '') + (x.deletedAt ? 'd' : '')).sort().join(',')`,
    );
    assert(!/:a|:d/.test(st), `both live after the reload: ${st}`);
    chat.end();
  },
);

e2e(
  "Delete takes the agent file into the bin and says so; Recently deleted names dates and the file; Restore and Undo bring the same bytes back; the note stays while hovered",
  async (lab) => {
    const page = lab.page;
    const chat = await openChat(lab);
    const keep = await publishFile(lab, chat, "keep.html", "Keeper flow");
    const body = "<h1>Report</h1><p>exact bytes 1234</p>";
    const r = await publishFile(lab, chat, "report.html", "Report", body);
    await showArtifacts(page, 2);
    await page.eval(`ArtifactsUI.open(${JSON.stringify(r.id)})`);
    await page.click('#artifactsPane .ar-bar .ar-ico[aria-haspopup="menu"]');
    await page.click(
      `#artifactsPane > .ar-pop .ar-it.ar-danger[data-id="delete"]`,
    );
    await page.waitFor(
      `/^Deleted "Report"\\. outputs\\/report\\.html went too\\. In Recently deleted for 30 days\\.$/.test((document.querySelector('#artifactsPane .ar-note-t') || {}).textContent || '')`,
      8000,
      "the delete note names the file",
    );
    assert(!exists(r.path), "the file left outputs/");
    assert(
      await page.eval<boolean>(
        `!document.querySelector('#artifactsPane .ar-note-undo').hidden`,
      ),
      "Undo is offered",
    );
    assert(
      (await page.eval<string>(`ArtifactsUI.state().selId`)) === keep.id,
      "the viewer moved to the other artifact",
    );
    // Undo within 10 s: file and artifact back
    await page.click("#artifactsPane .ar-note-undo");
    await page.waitFor(
      `/^Restored "Report"\\. outputs\\/report\\.html is back\\.$/.test((document.querySelector('#artifactsPane .ar-note-t') || {}).textContent || '')`,
      8000,
      "restored by Undo",
    );
    assert(
      exists(r.path) && Deno.readTextFileSync(r.path) === body,
      "the same bytes are back",
    );
    assert(
      (await page.eval<string>(`ArtifactsUI.state().selId`)) === r.id,
      "Undo shows it again",
    );
    // Delete from the row menu; the Recently deleted group says when, when for good, and the file
    await openPicker(page);
    await rowMenu(page, r.id);
    await page.click('#artifactsPane .ar-rowmenu .ar-it[data-id="delete"]');
    await page.waitFor(
      `/Deleted "Report"/.test((document.querySelector('#artifactsPane .ar-note-t') || {}).textContent || '')`,
      8000,
      "deleted",
    );
    assert(!exists(r.path), "the file went again");
    // the note stays while the pointer is on it (past the 10 s); the picker is closed first (it hangs over the note line)
    await page.key("Escape");
    await page.waitFor(`${pop}.hidden`, 3000, "the picker closes");
    const nb = await page.eval<[number, number]>(
      `(() => { const b = document.querySelector('#artifactsPane .ar-note').getBoundingClientRect(); return [b.left + 10, b.top + b.height / 2]; })()`,
    );
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: nb[0],
      y: nb[1],
    });
    await sleep(11000);
    assert(
      (await noteText(page)).startsWith('Deleted "Report"'),
      "held while hovered",
    );
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 5,
      y: 5,
    });
    await page.waitFor(
      `document.querySelector('#artifactsPane .ar-note').hidden`,
      12000,
      "the note goes once the pointer leaves (the time it had left)",
    );
    await openPicker(page);
    await page.click(`#artifactsPane .ar-foothead[data-key="foot:deleted"]`);
    await page.waitFor(
      `!!${pop}.querySelector('.ar-del')`,
      5000,
      "the deleted row",
    );
    const line = await page.eval<string>(
      `${pop}.querySelector('.ar-del .ar-del-line').textContent`,
    );
    assert(
      /^Deleted \d+ \w{3}, \d\d:\d\d\. Removed for good on \d+ \w{3}\. outputs\/report\.html went too; Restore puts it back\.$/
        .test(line),
      `row line: ${line}`,
    );
    await shots(page, "4-recently-deleted");
    await page.click(`#artifactsPane .ar-del [data-key="restore:${r.id}"]`);
    await page.waitFor(
      `/outputs\\/report\\.html is back/.test((document.querySelector('#artifactsPane .ar-note-t') || {}).textContent || '')`,
      8000,
      "restored from the row",
    );
    assert(
      exists(r.path) && Deno.readTextFileSync(r.path) === body,
      "same bytes after Restore",
    );
    chat.end();
  },
);

e2e(
  'Delete now asks in the row ("Delete for good? … Delete for good · Keep"); Keep backs out; Delete for good removes it and its bin; Restore onto an occupied path makes "(restored)"',
  async (lab) => {
    const page = lab.page;
    const chat = await openChat(lab);
    const a = await publishFile(lab, chat, "dup.html", "Duplicate page");
    const b = await publishFile(
      lab,
      chat,
      "report.html",
      "Old report",
      "<h1>old</h1>",
    );
    await showArtifacts(page, 2);
    const [d1] = await lab.web.post("artifacts/delete", { id: a.id });
    const [d2] = await lab.web.post("artifacts/delete", { id: b.id });
    assert(d1 === 200 && d2 === 200, "deleted");
    await page.waitFor(
      `ArtifactsUI.state().list.filter((x) => x.deletedAt).length === 2`,
      10000,
      "both in Recently deleted",
    );
    // the viewer has nothing live: "Nothing showing." and a link to the group
    await page.waitFor(
      `document.querySelector('#artifactsPane .ar-empty-t').textContent === 'Nothing showing.'`,
      8000,
      "the empty state",
    );
    await page.click(
      '#artifactsPane .ar-empty-hidden .ar-hidden-open[data-group="deleted"]',
    );
    await page.waitFor(
      `!!${pop} && !${pop}.hidden && !!${pop}.querySelector('.ar-del')`,
      5000,
      "the picker opens on Recently deleted",
    );
    await page.click(`#artifactsPane .ar-del [data-key="purge:${a.id}"]`);
    await page.waitFor(
      `!!${pop}.querySelector('.ar-confirm')`,
      5000,
      "the inline confirm",
    );
    const c = await page.eval<string>(
      `${pop}.querySelector('.ar-confirm').textContent`,
    );
    assert(
      c === "Delete for good? This can't be undone.Delete for goodKeep",
      `confirm: ${c}`,
    );
    await shots(page, "5-delete-now-confirm");
    await page.click(`#artifactsPane .ar-confirm [data-key="keep:${a.id}"]`);
    await page.waitFor(
      `!${pop}.querySelector('.ar-confirm')`,
      5000,
      "Keep backs out",
    );
    await page.click(`#artifactsPane .ar-del [data-key="purge:${a.id}"]`);
    await page.click(`#artifactsPane .ar-confirm [data-key="forgood:${a.id}"]`);
    await page.waitFor(
      `/"Duplicate page" is deleted for good\\./.test((document.querySelector('#artifactsPane .ar-note-t') || {}).textContent || '')`,
      8000,
      "purged",
    );
    assert(
      !(await page.eval<boolean>(
        `ArtifactsUI.state().list.some((x) => x.id === ${
          JSON.stringify(a.id)
        })`,
      )),
      "the row went",
    );
    const store = `${lab.fx.root}${SEP}state${SEP}artifacts`;
    assert(exists(`${store}${SEP}${b.id}`), `the store is at ${store}`);
    assert(
      !exists(`${store}${SEP}${a.id}`),
      "the purged artifact folder (and its bin) is gone",
    );
    // a new file sits at outputs/report.html: Restore brings the old one back next to it
    Deno.writeTextFileSync(b.path, "<h1>new</h1>");
    await page.click(`#artifactsPane .ar-del [data-key="restore:${b.id}"]`);
    await page.waitFor(
      `/A new file sits at outputs\\/report\\.html, so the old one is back as outputs\\/report \\(restored\\)\\.html\\./.test((document.querySelector('#artifactsPane .ar-note-t') || {}).textContent || '')`,
      8000,
      "restored as a copy",
    );
    assert(
      Deno.readTextFileSync(b.path) === "<h1>new</h1>",
      "the new file is untouched",
    );
    assert(
      Deno.readTextFileSync(
        b.path.replace("report.html", "report (restored).html"),
      ) === "<h1>old</h1>",
      "the old file next to it",
    );
    chat.end();
  },
);

e2e(
  'links in a reply read "· archived" / "· deleted" with one states request; clicking the deleted one shows Restore; every artifact archived: "Archived N" opens the group',
  async (lab) => {
    const page = lab.page;
    const chat = await openChat(lab);
    const live = await publishFile(lab, chat, "live.html", "Live page");
    const arch = await publishFile(lab, chat, "old.html", "Old roadmap draft");
    const del = await publishFile(
      lab,
      chat,
      "dup.html",
      "Beta 8 release notes (copy)",
    );
    await lab.web.post("artifacts/archive", {
      conversationId: chat.id,
      ids: [arch.id],
      archived: true,
    });
    await lab.web.post("artifacts/delete", { id: del.id });
    // count the states requests the page sends from here on
    await page.eval(
      `(() => { window.__states = []; const f = window.fetch; window.fetch = function (u, i) { if (String(u).includes('/api/live/artifacts/states')) window.__states.push(String(u)); return f.apply(this, arguments); }; })()`,
    );
    const gone = "ab12cd34ef56ab78";
    chat.say(
      `\n\nI published the timeline: [Live page](studio-artifact://${live.id}). The old draft is [Old roadmap draft](studio-artifact://${arch.id}), the duplicate was [Beta 8 release notes (copy)](studio-artifact://${del.id}) and [Gone](studio-artifact://${gone}). LINKS-DONE`,
    );
    await shown(page, "LINKS-DONE");
    await page.waitFor(
      `document.querySelectorAll('#messages a.artifact-link .artifact-state').length === 3`,
      10000,
      "three labels",
    );
    const labels = await page.eval<string[]>(
      `[...document.querySelectorAll('#messages a.artifact-link')].map((l) => l.textContent)`,
    );
    assert(labels[0] === "⧉ Live page", `live: ${labels[0]}`);
    assert(
      labels[1] === "⧉ Old roadmap draft · archived",
      `archived: ${labels[1]}`,
    );
    assert(
      labels[2] === "⧉ Beta 8 release notes (copy) · deleted",
      `deleted: ${labels[2]}`,
    );
    assert(labels[3] === "⧉ Gone · deleted", `gone: ${labels[3]}`);
    await settle(800);
    const asks = await page.eval<string[]>(`window.__states`);
    assert(asks.length <= 1, `at most one states request: ${asks.join(" ; ")}`);
    await messageShots(page, "6-link-labels", "LINKS-DONE");
    // clicking the deleted link: the viewer shows where it is, with Restore
    await page.click(`#messages a.artifact-link[data-artifact-id="${del.id}"]`);
    await page.waitFor(
      `!!document.querySelector('#artifactsPane .ar-deleted .ar-restore')`,
      8000,
      "the Restore message",
    );
    const msg = await page.eval<string>(
      `document.querySelector('#artifactsPane .ar-deleted .ar-msg').textContent`,
    );
    assert(
      /^"Beta 8 release notes \(copy\)" is in Recently deleted until \d+ \w{3}\. outputs\/dup\.html went too; Restore puts it back\. Restore$/
        .test(msg),
      `stage: ${msg}`,
    );
    await shots(page, "7-deleted-in-viewer");
    // Restore from the viewer's ⋯ (a deleted artifact's menu has only Restore); its link label follows
    await page.click('#artifactsPane .ar-bar .ar-ico[aria-haspopup="menu"]');
    const only = await page.eval<string[]>(
      `[...document.querySelectorAll('#artifactsPane > .ar-pop .ar-it')].map((b) => b.dataset.id)`,
    );
    assert(JSON.stringify(only) === '["undelete"]', `deleted menu: ${only}`);
    await page.click(`#artifactsPane > .ar-pop .ar-it[data-id="undelete"]`);
    await page.waitFor(
      `!ArtifactsUI.state().list.find((x) => x.id === ${
        JSON.stringify(del.id)
      }).deletedAt`,
      8000,
      "restored from the viewer menu",
    );
    await page.waitFor(
      `document.querySelector('#messages a.artifact-link[data-artifact-id="${del.id}"]').textContent === '⧉ Beta 8 release notes (copy)'`,
      8000,
      "the link label follows",
    );
    // every artifact archived from the viewer's ⋯ (it moves on each time): the empty state links to "Archived 3"
    for (const id of [del.id, live.id]) {
      await page.eval(`ArtifactsUI.open(${JSON.stringify(id)})`);
      await page.click('#artifactsPane .ar-bar .ar-ico[aria-haspopup="menu"]');
      await page.click(`#artifactsPane > .ar-pop .ar-it[data-id="archive"]`);
      await page.waitFor(
        `!!ArtifactsUI.state().list.find((x) => x.id === ${
          JSON.stringify(id)
        }).archivedAt`,
        8000,
        "archived",
      );
    }
    await page.waitFor(
      `document.querySelector('#artifactsPane .ar-empty-t').textContent === 'Nothing showing.'`,
      8000,
      "nothing showing",
    );
    const link = await page.eval<string>(
      `document.querySelector('#artifactsPane .ar-empty-hidden').textContent`,
    );
    assert(link === "Archived 3", `empty state: ${link}`);
    await shots(page, "8-nothing-showing");
    await page.click(
      '#artifactsPane .ar-empty-hidden .ar-hidden-open[data-group="archived"]',
    );
    await page.waitFor(
      `!!document.querySelector(${JSON.stringify(rowSel(arch.id))})`,
      5000,
      "the Archived group opens",
    );
    await rowMenu(page, arch.id);
    await page.click('#artifactsPane .ar-rowmenu .ar-it[data-id="unarchive"]');
    await page.waitFor(
      `!ArtifactsUI.state().list.find((x) => x.id === ${
        JSON.stringify(arch.id)
      }).archivedAt`,
      8000,
      "unarchived from the empty state",
    );
    await page.waitFor(
      `!(document.querySelector('#messages a.artifact-link[data-artifact-id="${arch.id}"] .artifact-state'))`,
      8000,
      "its link loses the label",
    );
    chat.end();
  },
);

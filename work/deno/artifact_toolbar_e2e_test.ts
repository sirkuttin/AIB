/**
 * The artifact viewer's toolbar is one row (lead decision 2026-11-16): at the default 320 px right panel it shows the picker
 * (its title ends in "…", the full title on hover), the version chip, the compact zoom (− 100% +), ↗ and ⋯ on one 40 px row;
 * "Request a change" is the first item of ⋯. A wider panel shows "Request a change" as a button again, still on one row.
 * Switching artifacts never changes the row's height or the panel's width.
 *
 * A real Studio (Deno web server + in-process agent host, temp state folder and workspace, free port; never the live ports), the
 * scripted agent work/scroll-fixture/agent.py, and a headless Chrome/Edge on chat.html (no window).
 * AIB_TOOLBAR_LOG=1 prints every measurement.
 *
 * Run (from app): deno test -A ../../work/deno/artifact_toolbar_e2e_test.ts
 */
import { assert } from "./_assert.ts";
import { browserPath, type Chat, Lab, type Page, settle, shown } from "./_scroll_lab.ts";

const SEP = Deno.build.os === "windows" ? "\\" : "/";
const LOG = !!Deno.env.get("AIB_TOOLBAR_LOG");

async function publish(lab: Lab, chat: Chat, name: string, title: string, versions = 1): Promise<string> {
  const dir = `${lab.fx.workspace}${SEP}outputs`;
  Deno.mkdirSync(dir, { recursive: true });
  const path = `${dir}${SEP}${name}`;
  let id = "";
  for (let v = 1; v <= versions; v++) {
    Deno.writeTextFileSync(path, `<h1>${title}</h1><p>version ${v}</p>`);
    const [status, made] = await lab.web.post("artifacts/publish", { conversationId: chat.id, path, title });
    assert(status === 200, `artifacts/publish: ${status} ${JSON.stringify(made)}`);
    id = String(made.id);
  }
  return id;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Bar {
  bar: Box;
  panel: number;
  items: Record<string, Box | null>;
  titleCut: boolean;
  pickTitle: string;
}
const MEASURE = `(() => {
  const bar = document.querySelector('#artifactsPane > .ar-bar');
  const r = (n) => { if (!n || n.hidden || !n.offsetParent) return null; const b = n.getBoundingClientRect();
    return { x: Math.round(b.left * 10) / 10, y: Math.round(b.top * 10) / 10, w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10 }; };
  const q = (s) => bar.querySelector(s);
  const t = q('.ar-pick-title');
  return {
    bar: r(bar),
    panel: Math.round(document.getElementById('subagentsPane').getBoundingClientRect().width),
    items: { pick: r(q('.ar-pick')), ver: r(q('.ar-ver')), request: r(q('.ar-request')), zoomOut: r(q('.ar-zoom-btn')),
      zoomPct: r(q('.ar-zoom-pct')), zoomIn: r(bar.querySelectorAll('.ar-zoom-btn')[1]), ext: r(q('.ar-ext')), more: r(q('.ar-more')) },
    titleCut: !!t && t.scrollWidth > t.clientWidth,
    pickTitle: q('.ar-pick').title,
  };
})()`;
const measure = (page: Page) => page.eval<Bar>(MEASURE);
/** AIB_TOOLBAR_SHOTS=<folder>: a PNG of the right panel's top. */
async function shot(page: Page, name: string) {
  const dir = Deno.env.get("AIB_TOOLBAR_SHOTS");
  if (!dir) return;
  Deno.mkdirSync(dir, { recursive: true });
  const c = await page.eval<{ x: number; y: number; width: number; height: number }>(
    `(() => { const r = document.getElementById('subagentsPane').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: 240 }; })()`,
  );
  const png = await page.send("Page.captureScreenshot", { format: "png", clip: { ...c, scale: 1 } });
  Deno.writeFileSync(`${dir}/${name}.png`, Uint8Array.from(atob(String(png.data ?? "")), (ch) => ch.charCodeAt(0)));
}
const rows = (b: Bar) => new Set(Object.values(b.items).filter((x): x is Box => !!x).map((x) => Math.round(x.y + x.h / 2))).size;

/** The owner's resize, by keyboard on the right panel's handle (16 px a step): Home is its narrowest, Enter its default. */
async function setPanel(page: Page, px: number) {
  await page.eval(`(() => {
    const h = document.getElementById('rs-activity'), w = () => document.getElementById('subagentsPane').getBoundingClientRect().width;
    const key = (k) => h.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    key('Enter');
    for (let i = 0; i < 80 && Math.abs(w() - ${px}) >= 8; i++) key(w() < ${px} ? 'ArrowLeft' : 'ArrowRight');
  })()`);
  await settle(150);
}

Deno.test({
  name: "artifact toolbar: one row at the default 320 px panel, Request a change first in ⋯, nothing jumps between artifacts",
  ignore: !browserPath,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const lab = await Lab.open(1600, 900);
    try {
      const page = lab.page;
      const chat = await lab.chat();
      await chat.start();
      chat.say("Hello READY");
      await lab.select(chat);
      await shown(page, "READY");
      const longTitle = "Checkout redesign timeline with every milestone and owner";
      await publish(lab, chat, "short.html", "Plan", 1);
      const longId = await publish(lab, chat, "long.html", longTitle, 3);
      await page.click("#paneTab-artifacts");
      await page.waitFor(`ArtifactsUI.state().list.length >= 2`, 15000, "two artifacts");
      await page.eval(`ArtifactsUI.open(${JSON.stringify(longId)})`);
      await page.waitFor(`!!document.querySelector('#artifactsPane > .ar-bar .ar-ver') && /v3/.test(document.querySelector('#artifactsPane > .ar-bar .ar-ver').textContent)`, 15000, "v3 shown");
      await settle(400);
      const a = await measure(page);
      if (LOG) console.log("320 long", JSON.stringify(a));
      await shot(page, "320-long");
      assert(a.panel === 320, `the default panel is 320 px (got ${a.panel})`);
      assert(rows(a) === 1, `one row at 320 px: ${JSON.stringify(a.items)}`);
      assert(a.bar.h <= 41, `the bar is one row high (got ${a.bar.h} px)`);
      for (const k of ["pick", "ver", "zoomOut", "zoomPct", "zoomIn", "ext", "more"]) assert(!!a.items[k], `${k} shows at 320 px`);
      assert(!a.items.request, "Request a change is not a button at 320 px");
      assert(a.titleCut && a.pickTitle === longTitle, "a long title ends in … with the full title on hover");
      const right = Math.max(...Object.values(a.items).filter((x): x is Box => !!x).map((x) => x.x + x.w));
      assert(right <= a.bar.x + a.bar.w - 9, `nothing overflows the bar (${right} vs ${a.bar.x + a.bar.w})`);

      // ⋯: Request a change first; it puts the artifact in the message box
      await page.click("#artifactsPane > .ar-bar .ar-more");
      await page.waitFor(`!document.querySelector('#artifactsPane > .ar-pop:not(.ar-rowmenu)').hidden`, 5000, "the menu");
      const first = await page.eval<string>(`document.querySelector('#artifactsPane > .ar-pop:not(.ar-rowmenu) .ar-it').dataset.id`);
      assert(first === "request", `Request a change is the first item (got ${first})`);
      await page.click(`#artifactsPane > .ar-pop:not(.ar-rowmenu) .ar-it[data-id="request"]`);
      await page.waitFor(`document.getElementById('prompt').value.includes('studio-artifact://${longId}')`, 5000, "the link chip in the box");
      await page.eval(`document.getElementById('prompt').value = ''; document.getElementById('prompt').dispatchEvent(new Event('input', { bubbles: true }))`);

      // switching to the short one: the same row, same height, same panel width, the buttons stay where they were
      const shortId = await page.eval<string>(`ArtifactsUI.state().list.find((x) => x.title === 'Plan').id`);
      await page.eval(`ArtifactsUI.open(${JSON.stringify(shortId)})`);
      await page.waitFor(`document.querySelector('#artifactsPane > .ar-bar .ar-pick').title === 'Plan'`, 10000, "Plan shown");
      await settle(300);
      const b = await measure(page);
      if (LOG) console.log("320 short", JSON.stringify(b));
      await shot(page, "320-short");
      assert(b.bar.h === a.bar.h && b.panel === a.panel, `no jump: bar ${a.bar.h}->${b.bar.h}, panel ${a.panel}->${b.panel}`);
      for (const k of ["zoomOut", "zoomPct", "zoomIn", "ext", "more"]) {
        assert(b.items[k]!.x === a.items[k]!.x, `${k} stays put (${a.items[k]!.x} -> ${b.items[k]!.x})`);
      }

      // a wide panel: Request a change is a button again, still one row
      await setPanel(page, 520);
      const w = await measure(page);
      if (LOG) console.log("520", JSON.stringify(w));
      await shot(page, "520-short");
      assert(rows(w) === 1 && w.bar.h === a.bar.h, `one row at 520 px: ${JSON.stringify(w.items)}`);
      assert(!!w.items.request, "Request a change shows as a button at 520 px");
      // every width from 280 to 520: never a second row
      for (let px = 280; px <= 520; px += 16) {
        await setPanel(page, px);
        const m = await measure(page);
        assert(rows(m) === 1 && m.bar.h === a.bar.h, `one row at ${px} px: ${JSON.stringify(m.items)}`);
      }
      await page.eval(`ArtifactsUI.open(${JSON.stringify(longId)})`);
      for (let px = 280; px <= 520; px += 16) {
        await setPanel(page, px);
        const m = await measure(page);
        assert(rows(m) === 1 && m.bar.h === a.bar.h, `one row at ${px} px with the long title: ${JSON.stringify(m.items)}`);
      }
      assert(page.errors.length === 0, `console errors: ${page.errors.join(" | ")}`);
    } finally {
      await lab.close();
    }
  },
});

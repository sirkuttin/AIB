/**
 * Poll budget (2026-11-27 slowness: ~32 chats, several windows, every request 1-6 s). A real AIB server (own temp state folder,
 * free port), a headless Chrome on chat.html with the REAL poll periods, a realistic fixture (40 saved chats, three of them with
 * 10,000-message histories, 3 live chats, a 9,000-file aib-shared folder in the project), then an idle stretch is counted:
 * requests per path from the page (fetch wrapper) and the server process's CPU. Prints the table; asserts the budget.
 *
 * Run (from app):  deno test -A ../work/deno/perf_polls_test.ts      AIB_PERF_SECONDS=60 (default)
 */
import { assert } from "./_assert.ts";
import { browserPath, Lab, sleep } from "./_scroll_lab.ts";
import { metrics } from "./_perf_lab.ts";
Lab.pollScale = 1;

const SECONDS = Number(Deno.env.get("AIB_PERF_SECONDS") ?? 60);
const COUNT =
  `window.__reqs = []; (() => { const f = window.fetch.bind(window); window.fetch = (...a) => {
  const u = new URL(typeof a[0] === 'string' ? a[0] : a[0].url, location.href); const t = performance.now();
  const rec = (s) => window.__reqs.push({ p: u.pathname, q: u.searchParams.get('session') || u.searchParams.get('key') || '', s, ms: Math.round(performance.now() - t), at: Date.now() });
  const p = f(...a); p.then((r) => rec(r.status), () => rec(0)); return p; }; })();`;

async function cpuSeconds(pid: number): Promise<number> {
  const out = await new Deno.Command("powershell.exe", {
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${pid}).TotalProcessorTime.TotalSeconds`,
    ],
    stdout: "piped",
    stderr: "null",
  }).output();
  return Number(new TextDecoder().decode(out.stdout).trim()) || 0;
}

function seed(lab: Lab) {
  for (let i = 0; i < 40; i++) {
    // rows are 1 s apart: 10,000 of them must still end in the past (a transcript "written" in the future reads as working)
    const s = lab.savedChat(`perf-chat-${String(i).padStart(2, "0")}`, 6 * 3600_000);
    const n = i < 3 ? 5000 : 150; // pairs: 10,000 rows in the long ones
    for (let k = 0; k < n; k++) {
      s.user(`question ${k} of chat ${i}`);
      s.say(`answer ${k}. ` + "Words that fill a line or two. ".repeat(4));
    }
  }
  const shared = `${lab.fx.workspace}/aib-shared`;
  for (let d = 0; d < 90; d++) {
    Deno.mkdirSync(`${shared}/dir-${d}`, { recursive: true });
    for (let f = 0; f < 100; f++) {
      Deno.writeTextFileSync(
        `${shared}/dir-${d}/file-${f}.md`,
        `file ${d}/${f}\n`,
      );
    }
  }
}

Deno.test({
  name:
    "an idle window with 40 chats and a big aib-shared stays inside its request and CPU budget",
  ignore: !browserPath,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const lab = await Lab.open(1600, 900, undefined, { fastPoll: false });
    try {
      seed(lab);
      const chats = [await lab.chat(), await lab.chat(), await lab.chat()];
      await lab.page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: COUNT,
      });
      await lab.page.goto(`http://127.0.0.1:${lab.web.port}/chat.html`);
      await lab.page.waitFor(
        '!!document.getElementById("messages")',
        15000,
        "chat page",
      );
      await lab.select(chats[0]);
      await sleep(40000); // first loads: Activity reads the 40 chats three at a time
      await lab.page.eval("window.__reqs.length = 0");
      await lab.page.send("Performance.enable", { timeDomain: "timeTicks" });
      await lab.page.eval(
        `window.__muts = 0; window.__mk = {}; new MutationObserver((l) => { window.__muts += l.length; for (const r of l) { const t = r.target; const e = t.nodeType === 1 ? t : t.parentElement; const k = r.type + ' ' + (e ? e.tagName + '.' + String(e.className).slice(0, 30) : '?'); window.__mk[k] = (window.__mk[k] || 0) + 1; } }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); 0`,
      );
      const pid = lab.web.process.pid;
      const cpu0 = await cpuSeconds(pid);
      const page0 = await metrics(lab.page, false);
      const t0 = Date.now();
      await sleep(SECONDS * 1000);
      const wall = (Date.now() - t0) / 1000;
      const cpu = ((await cpuSeconds(pid)) - cpu0) / wall * 100;
      const page1 = await metrics(lab.page, false);
      const pageCpu = (page1.TaskDuration - page0.TaskDuration) / wall * 100;
      const mutations = await lab.page.eval<number>("window.__muts");
      const mutKeys = await lab.page.eval<Record<string, number>>("window.__mk");
      console.log(`PERF mutations by target: ${JSON.stringify(Object.entries(mutKeys).sort((a, b) => b[1] - a[1]).slice(0, 8))}`);
      const reqs = await lab.page.eval<{ p: string; s: number; ms: number }[]>(
        "window.__reqs",
      );
      const by: Record<string, { n: number; ms: number; s304: number }> = {};
      for (const r of reqs) {
        const b = (by[r.p] ??= { n: 0, ms: 0, s304: 0 });
        b.n++;
        b.ms += r.ms;
        if (r.s === 304) b.s304++;
      }
      const perMin = (n: number) => Math.round(n * 60 / wall);
      const rows = Object.entries(by).sort((a, b) => b[1].n - a[1].n).map((
        [p, b],
      ) =>
        `${String(perMin(b.n)).padStart(5)}/min  avg ${
          String(Math.round(b.ms / b.n)).padStart(5)
        } ms  304:${b.s304}  ${p}`
      );
      const asked: Record<string, number> = {};
      for (const r of reqs as { p: string; q?: string }[]) {
        if (r.p === "/api/commands") asked[r.q ?? ""] = (asked[r.q ?? ""] ?? 0) + 1;
      }
      console.log(
        `PERF commands asked per chat: ${JSON.stringify(Object.entries(asked).sort((a, b) => b[1] - a[1]).slice(0, 6))}`,
      );
      console.log(
        `PERF idle ${wall.toFixed(0)} s: ${
          perMin(reqs.length)
        } requests/min, server CPU ${cpu.toFixed(1)}% of a core, page CPU ${
          pageCpu.toFixed(1)
        }%, DOM mutations ${mutations} (${
          Math.round(mutations * 60 / wall)
        }/min)\n${rows.join("\n")}`,
      );
      assert(
        Math.round(mutations * 60 / wall) <= 6000,
        `idle: ${mutations} DOM mutations in ${
          wall.toFixed(0)
        } s: polls that find nothing new must not touch the DOM`,
      );
      assert(pageCpu < 9, `idle: page CPU ${pageCpu.toFixed(1)}% (budget 9%)`);
      assert(
        perMin(reqs.length) <= 200,
        `idle: ${perMin(reqs.length)} requests/min (budget 200)`,
      );
      assert(cpu < 10, `idle: server CPU ${cpu.toFixed(1)}% (budget 10%)`);
    } finally {
      await lab.close();
    }
  },
});

Deno.test({
  name:
    "a hidden window stops polling its lists, Activity and docs; showing it again reads at once",
  ignore: !browserPath,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const lab = await Lab.open(1600, 900, undefined, { fastPoll: false });
    try {
      for (let i = 0; i < 12; i++) {
        const s = lab.savedChat(`hidden-chat-${i}`);
        for (let k = 0; k < 20; k++) {
          s.user(`q ${k}`);
          s.say(`a ${k}`);
        }
      }
      const chats = [await lab.chat(), await lab.chat()];
      await lab.page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: COUNT,
      });
      await lab.page.goto(`http://127.0.0.1:${lab.web.port}/chat.html`);
      await lab.page.waitFor(
        '!!document.getElementById("messages")',
        15000,
        "chat page",
      );
      await lab.select(chats[0]);
      await sleep(12000);
      // the window is hidden (minimised, or a tab behind another): document.hidden reads true
      await lab.page.eval(
        `Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); window.__reqs.length = 0; 0`,
      );
      await sleep(20000);
      const hidden = await lab.page.eval<{ p: string }[]>("window.__reqs");
      const polls = hidden.filter((r) =>
        !/presence|devices|folders\/gone|bootstrap/.test(r.p)
      );
      assert(
        polls.length <= 4,
        `hidden for 20 s: ${polls.length} polls (${
          [...new Set(polls.map((r) => r.p))].join(", ")
        }), want at most 4`,
      );
      await lab.page.eval(
        `Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); 0`,
      );
      await sleep(4000);
      const back = await lab.page.eval<{ p: string }[]>("window.__reqs");
      assert(
        back.some((r) => r.p === "/api/sessions"),
        "showing the window again lists the chats at once",
      );
    } finally {
      await lab.close();
    }
  },
});

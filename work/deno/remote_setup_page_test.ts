/**
 * Settings > Remote control in a headless Chrome (no window) on a throwaway in-process AIB with the stateful fake Tailscale
 * (_tailscale_sim.ts; nothing real runs): the nav says Remote control; clicking through Install Tailscale -> Sign in to Tailscale ->
 * Turn on HTTPS -> Share AIB turns each step green by itself; Add a phone is ready at the end; the re-check reads Tailscale every
 * 3 s while a step waits and never while Settings is closed or another section is shown; at 375 px nothing scrolls sideways; and
 * the in-app notice when AIB starts with its share missing re-shares from its Share again button.
 */
import { assert, assertEquals } from "./_assert.ts";
import { Browser, browserPath, type Page } from "./_doc_browser.ts";
import {
  pc,
  type RemoteStudio,
  remoteStudio,
  tempDir,
} from "./_remote_fixture.ts";
import { assertSafe, LOGIN_URL, tailscaleSim } from "./_tailscale_sim.ts";
import { LINUX_INSTALL } from "../../outputs/agent-studio/server/remote/install.ts";

const FAKE_SHELL = new URL("./_fake_setup_shell.ts", import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, "$1");

const OPTS = { sanitizeResources: false, sanitizeOps: false };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function openRemote(
  page: Page,
  s: RemoteStudio,
  width = 1280,
): Promise<void> {
  await page.viewport(width, 900);
  await page.goto(`http://127.0.0.1:${s.port}/chat.html`);
  await page.waitFor(
    '!!document.getElementById("openSettings")',
    15000,
    "chat page",
  );
  if (width >= 768) {
    await page.click("#openSettings");
    await page.waitFor(
      `document.body.classList.contains('settings-open')`,
      8000,
      "settings open",
    );
    await page.eval(
      `[...document.querySelectorAll('.st-section')].find((b) => b.textContent === 'Remote control').click()`,
    );
  } else {
    await page.waitFor(`!!window.AgentSettingsUI`, 8000, "settings script");
    await page.eval(`window.AgentSettingsUI.open('devices')`); // the narrow layout folds the side bar away
  }
  await page.waitFor(
    `!!document.querySelector('.dv-steps')`,
    8000,
    "the steps",
  );
}
const stepState = (n: number) =>
  `(document.querySelector('.dv-steps li[data-step="${n}"]') || {}).className || ''`;
const clickAct = (page: Page, act: string) =>
  page.waitFor(
    `(() => { const b = document.querySelector('.dv-steps button[data-act="${act}"]'); if (!b || b.disabled) return false; b.click(); return true; })()`,
    10000,
    act,
  );

Deno.test({
  ...OPTS,
  ignore: !browserPath,
  name:
    "Remote control in the page: Install, Sign in, Turn on HTTPS and Share AIB each turn green by themselves; Add a phone is ready",
  async fn() {
    const sim = tailscaleSim({ installed: false, https: false }, (c, sim) => {
      if (c.tool === "winget") {
        return {
          code: 0,
          effect: () => (sim.installed = true, sim.backend = "NeedsLogin"),
        };
      }
    });
    const s = await remoteStudio({
      runner: sim.runner,
      setupEnv: sim.env(),
      bindRetryMs: 300,
    });
    const browser = await Browser.launch();
    try {
      await pc(s, "POST", "/api/live/devices/access", { on: true });
      const page = await browser.open("about:blank", 1280, 900);
      await openRemote(page, s);
      const nav = await page.eval<string[]>(
        `[...document.querySelectorAll('.st-section')].map((b) => b.textContent)`,
      );
      assert(
        nav.includes("Remote control") && !nav.includes("Devices"),
        nav.join("|"),
      );
      await page.waitFor(
        `${stepState(1)}.includes('now')`,
        8000,
        "step 1 asks to install",
      );
      await clickAct(page, "install");
      await page.waitFor(
        `!!document.querySelector('.dv-steps button[data-act="login"]')`,
        15000,
        "installed: Sign in shows by itself",
      );
      await clickAct(page, "login");
      await page.waitFor(
        `${stepState(1)}.includes('wait')`,
        8000,
        "signing in",
      );
      assertEquals(sim.opened, [LOGIN_URL]);
      const fallback = await page.waitFor(
        `[...document.querySelectorAll('.dv-steps a')].find((a) => a.textContent === 'Open the sign-in page again')?.href ?? ''`,
        8000,
        "the fallback link",
      );
      assertEquals(fallback, LOGIN_URL);
      sim.sim.backend = "Running";
      await page.waitFor(
        `${stepState(1)}.includes('ok') && ${stepState(2)}.includes('now')`,
        15000,
        "signed in: HTTPS is next",
      );
      await clickAct(page, "https");
      await page.waitFor(
        `${stepState(2)}.includes('wait')`,
        8000,
        "HTTPS waits",
      );
      sim.sim.https = true;
      await page.waitFor(
        `${stepState(2)}.includes('ok') && ${stepState(3)}.includes('now')`,
        15000,
        "HTTPS on: Share is next",
      );
      await clickAct(page, "share");
      await page.waitFor(
        `${stepState(3)}.includes('ok') && ${stepState(4)}.includes('now')`,
        15000,
        "shared",
      );
      await page.waitFor(
        `document.getElementById('dvStatus').textContent.startsWith('✓ Reachable at https://')`,
        8000,
        "status",
      );
      await page.waitFor(
        `!document.getElementById('dvAdd').disabled`,
        8000,
        "Add a phone is ready",
      );
      const changes = await page.eval<string>(
        `document.querySelector('.dv-changes summary').textContent`,
      );
      assert(/What AIB changed on this PC \([3-9]\)/.test(changes), changes);
      assertEquals(page.errors, [], "console errors");
      assertSafe(sim.calls);
      await page.shot("remote-setup-done");
      await page.close();
    } finally {
      await browser.close();
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  ignore: !browserPath,
  name:
    "Remote control re-check: every 3 s while a step waits; none while another section is shown or Settings is closed",
  async fn() {
    const sim = tailscaleSim({ https: false });
    const s = await remoteStudio({
      runner: sim.runner,
      setupEnv: sim.env(),
      bindRetryMs: 300,
    });
    const browser = await Browser.launch();
    try {
      await pc(s, "POST", "/api/live/devices/access", { on: true });
      s.ctx.phone.setup.httpsLink =
        "https://login.tailscale.com/f/serve?node=x";
      await pc(s, "POST", "/api/live/devices/tailscale/run", {
        action: "open-https",
      }); // step 2 now waits (no job runs)
      const page = await browser.open("about:blank", 1280, 900);
      await openRemote(page, s);
      await page.waitFor(
        `${stepState(2)}.includes('wait')`,
        8000,
        "step 2 waits",
      );
      const statusReads = () =>
        sim.reads.filter((r) => r[0] === "status").length;
      await sleep(1000);
      let before = statusReads();
      await sleep(7000);
      const waiting = statusReads() - before;
      assert(
        waiting >= 2 && waiting <= 3,
        `about every 3 s while waiting: ${waiting}`,
      );
      // another section: nothing
      await page.eval(
        `[...document.querySelectorAll('.st-section')].find((b) => b.textContent === 'Editors').click()`,
      );
      before = statusReads();
      await sleep(7000);
      assertEquals(statusReads() - before, 0, "another section shown");
      // closed
      await page.key("Escape");
      await page.waitFor(
        `!document.body.classList.contains('settings-open')`,
        8000,
        "closed",
      );
      before = statusReads();
      await sleep(7000);
      assertEquals(statusReads() - before, 0, "Settings closed");
      // nothing waits: 30 s, so none in 7 s
      sim.sim.https = true;
      await openRemote(page, s);
      await page.waitFor(
        `${stepState(2)}.includes('ok')`,
        10000,
        "HTTPS green",
      );
      await sleep(1000);
      before = statusReads();
      await sleep(7000);
      assertEquals(statusReads() - before, 0, "nothing waits: every 30 s");
      await page.close();
    } finally {
      await browser.close();
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  ignore: !browserPath,
  name:
    "Remote control at 375 px: the Linux install terminal runs exactly the install line (exit 1 red, exit 0 checks again); nothing sideways",
  async fn() {
    const sim = tailscaleSim({
      serve: {
        "443":
          "http://127.0.0.1:30000/a-very-long-path/that-goes-on-and-on/and-on-and-on",
        "8443": "tcp://127.0.0.1:22",
      },
    });
    const s = await remoteStudio({
      runner: sim.runner,
      setupEnv: sim.env({ os: () => "linux" }),
      bindRetryMs: 300,
    });
    const shellLog = `${s.root}/shell.log`;
    const browser = await Browser.launch();
    try {
      await pc(s, "POST", "/api/live/devices/access", { on: true });
      const page = await browser.open("about:blank", 375, 812);
      await openRemote(page, s, 375);
      await page.waitFor(
        `!!document.querySelector('.dv-confirm')`,
        8000,
        "the replace confirm",
      );
      // the Linux install step's terminal on the card, with the fake shell: exit 1 keeps the step red, exit 0 checks again
      sim.sim.installed = false;
      await s.ctx.phone.check(); // a fresh read (past the 2.5 s cache)
      await page.waitFor(
        `!!document.querySelector('.dv-steps button[data-act="term-install"]')`,
        10000,
        "Install opens the terminal",
      );
      Deno.env.set(
        "AIB_REMOTE_SETUP_SHELL",
        JSON.stringify([
          Deno.execPath(),
          "run",
          "-A",
          "--quiet",
          FAKE_SHELL,
          shellLog,
          "1",
        ]),
      );
      await clickAct(page, "term-install");
      await page.waitFor(
        `!!document.querySelector('.dv-term .st-beta-term-view canvas, .dv-term .st-beta-term-view .xterm')`,
        15000,
        "the terminal",
      );
      await page.waitFor(
        `/exit code 1/.test(document.querySelector('.dv-term > .st-note').textContent)`,
        20000,
        "exit 1 says so",
      );
      assertEquals(
        Deno.readTextFileSync(shellLog),
        LINUX_INSTALL,
        "exactly the install line",
      );
      const wideTerm = await page.eval<number[]>(
        `(() => { const t = document.querySelector('.dv-term'); return [t.scrollWidth, t.clientWidth]; })()`,
      );
      assert(wideTerm[0] <= wideTerm[1], `the terminal fits: ${wideTerm}`);
      Deno.env.set(
        "AIB_REMOTE_SETUP_SHELL",
        JSON.stringify([
          Deno.execPath(),
          "run",
          "-A",
          "--quiet",
          FAKE_SHELL,
          shellLog,
          "0",
        ]),
      );
      sim.sim.installed = true;
      sim.sim.backend = "NeedsLogin";
      await page.eval(`document.querySelector('.dv-term .st-link').click()`);
      await page.waitFor(
        `!!document.querySelector('.dv-steps button[data-act="term-install"]')`,
        10000,
        "closed",
      );
      await clickAct(page, "term-install");
      await page.waitFor(
        `!!document.querySelector('.dv-steps button[data-act="login"]')`,
        25000,
        "exit 0: checked again, Sign in shows",
      ).catch(async (e) => {
        throw new Error(
          `${e.message}: ${await page.eval(
            'document.querySelector(".dv-steps").textContent',
          )} log=${Deno.readTextFileSync(shellLog)}`,
        );
      });
      Deno.env.delete("AIB_REMOTE_SETUP_SHELL");
      sim.sim.backend = "Running";
      await s.ctx.phone.check();
      await page.eval(`document.querySelector('.dv-changes').open = true`);
      // chat.html itself is 490 px wide at 375 (its two columns; remote_phone_e2e_test.ts CHAT_HTML_375): the Remote control cards
      // must fit their own card with nothing sticking out sideways
      const wide = await page.eval<{ cards: number[][]; over: string[] }>(
        `(() => {
        const slots = [...document.querySelectorAll('.dv-slot')];
        const cards = slots.map((s) => [s.scrollWidth, s.clientWidth]);
        const over = slots.flatMap((s) => { const r = s.getBoundingClientRect(); return [...s.querySelectorAll('*')].filter((n) => n.offsetParent && n.getBoundingClientRect().right > r.right + 1).map((n) => n.className || n.tagName); }).slice(0, 5);
        return { cards, over };
      })()`,
      );
      assert(
        wide.cards.length === 2 && wide.cards.every(([sw, cw]) => sw <= cw) &&
          !wide.over.length,
        `nothing sideways: ${JSON.stringify(wide)}`,
      );
      assertEquals(
        await page.eval<number>("document.documentElement.scrollWidth"),
        490,
        "the page is as wide as before (chat.html at 375)",
      );
      assertEquals(page.errors, [], "console errors");
      await page.shot("remote-setup-375");
      await page.close();
    } finally {
      await browser.close();
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  ignore: !browserPath,
  name:
    "AIB starts with the switch on and its share missing: an in-app notice (not an OS notification) whose Share again re-shares",
  async fn() {
    const sim = tailscaleSim();
    const root = await tempDir("aib-remote-");
    Deno.mkdirSync(`${root}/state`, { recursive: true });
    Deno.writeTextFileSync(
      `${root}/state/phone-access.json`,
      JSON.stringify({ version: 1, on: true, via: "tailscale", shared: true }),
    );
    const s = await remoteStudio({
      runner: sim.runner,
      setupEnv: sim.env(),
      bindRetryMs: 300,
    }, root);
    const browser = await Browser.launch();
    try {
      await s.ctx.phone.start();
      assertEquals(sim.calls, [], "nothing re-added silently");
      const page = await browser.open("about:blank", 1280, 900);
      await page.goto(`http://127.0.0.1:${s.port}/chat.html`);
      await page.waitFor(
        `!!document.getElementById('dvMissingNotice')`,
        15000,
        "the notice",
      );
      const text = await page.eval<string>(
        `document.getElementById('dvMissingNotice').textContent`,
      );
      assert(
        text.includes("Phones can’t reach AIB") && text.includes("Share again"),
        text,
      );
      assert(
        await page.eval<boolean>(
          `!!document.getElementById('dvMissingNotice').closest('.toast-stack')`,
        ),
        "in the page notice stack",
      );
      await page.click("#dvShareAgain");
      await page.waitFor(
        `!document.getElementById('dvMissingNotice')`,
        8000,
        "notice gone",
      );
      for (
        let i = 0;
        i < 100 && !(sim.sim.serve["443"] && sim.sim.serve["8443"]);
        i++
      ) await sleep(50);
      assertEquals(Object.keys(sim.sim.serve).sort(), ["443", "8443"]);
      assertEquals(page.errors, [], "console errors");
      await page.close();
    } finally {
      await browser.close();
      await s.close();
    }
  },
});

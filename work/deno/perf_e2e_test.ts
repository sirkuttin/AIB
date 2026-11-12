/**
 * The chat page under load, end to end: a real Studio (temp state folder, free port, in-process agent host), the scripted agent
 * work/scroll-fixture/agent.py, and a headless Chrome/Edge (no window) on chat.html. One long live chat (2,500 agent messages
 * with markdown and code, finished steps with long outputs and diffs: ~5,000 rows, the newest 150 drawn) and 15 helpers, then
 * the chat streams for a few minutes: a message growing, steps starting and finishing, a helper message every tick.
 *
 * Measured with the DevTools protocol (_perf_lab.ts): JS heap after a forced GC, DOM nodes and event listeners (detached ones
 * count while something holds them), main-thread busy time per second of wall clock, and typing latency (a real key press in the
 * composer -> the next frame). What it guards, with the numbers before the fixes on the same machine:
 *   - DOM nodes / listeners: every redraw kept the previous window alive (copy-ui) -> +770 nodes and +100 listeners a second
 *   - streaming busy time: one forced layout per long block on every mutation (clamp-ui) and a full restyle and layout of the
 *     window on each poll -> ~25% of a core, tasks up to 100 ms
 *   - typing: each key laid out the whole history (composer autosize + an unconstrained #messages) -> p90 ~190 ms while streaming
 *
 * Run (from outputs/agent-studio):  deno test -A ../../work/deno/perf_e2e_test.ts
 *   AIB_PERF_MINUTES=10 for the long run (default 3). Without Chrome or Edge the test is ignored. Gives up after 15 minutes.
 */
import { assert } from "./_assert.ts";
import { browserPath, Lab, sleep } from "./_scroll_lab.ts";
import {
  metrics,
  openLongChat,
  type Sample,
  sampleFor,
  streamer,
  typingLatency,
} from "./_perf_lab.ts";

const MINUTES = Math.min(13, Number(Deno.env.get("AIB_PERF_MINUTES") ?? 3));
const HELPERS = 15;

Deno.test({
  name:
    `a long chat streaming for ${MINUTES} min: memory, DOM nodes and listeners stay flat, CPU stays low, typing stays smooth`,
  ignore: !browserPath,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      giveUp = setTimeout(
        () => reject(new Error("perf test gave up after 15 minutes")),
        15 * 60 * 1000,
      );
    });
    const lab = await Lab.open();
    try {
      await Promise.race([deadline, run(lab)]);
    } finally {
      clearTimeout(giveUp);
      await lab.close();
    }
  },
});

async function run(lab: Lab) {
  const page = lab.page;
  const chat = await openLongChat(lab, 2500, HELPERS);
  const log = (label: string, s: Sample) =>
    console.log(label, JSON.stringify(s));

  // Idle: the turn is open, nothing arrives.
  await sleep(3000);
  const idle = await sampleFor(page, 20, 10, (s) => log("idle", s));
  const idleCpu = Math.max(...idle.map((s) => s.cpu));
  const typingIdle = await typingLatency(page, 20);
  console.log("typing idle", JSON.stringify(typingIdle));

  // Streaming: warm up, then measure.
  const st = streamer(chat, HELPERS);
  try {
    await sleep(30_000);
    const typing = typingLatency(page, 40);
    const samples = await sampleFor(
      page,
      MINUTES * 60 - 30,
      15,
      (s) => log("streaming", s),
    );
    const typingStreaming = await typing;
    console.log("typing streaming", JSON.stringify(typingStreaming));
    const first = samples[0], last = samples[samples.length - 1];
    const cpu = samples.reduce((n, s) => n + s.cpu, 0) / samples.length;
    const drawn = await page.eval<number>(
      `document.getElementById('messages').children.length`,
    );
    const m = await metrics(page);
    console.log(
      `drawn rows ${drawn}, nodes ${m.Nodes}, listeners ${m.JSEventListeners}, ticks ${st.count()}, mean cpu ${
        cpu.toFixed(1)
      }%`,
    );

    assert(idleCpu < 5, `idle: ${idleCpu}% of a core (want < 5%)`);
    assert(
      last.nodes - first.nodes < 1500,
      `DOM nodes grew ${first.nodes} -> ${last.nodes} while streaming (a redraw kept old rows alive?)`,
    );
    assert(
      last.listeners - first.listeners < 150,
      `listeners grew ${first.listeners} -> ${last.listeners} while streaming`,
    );
    assert(
      last.heapMB - first.heapMB < 2 + MINUTES,
      `JS heap grew ${first.heapMB} -> ${last.heapMB} MB while streaming`,
    );
    assert(
      cpu < 15,
      `streaming: ${cpu.toFixed(1)}% of a core on average (want < 15%)`,
    );
    assert(drawn < 400, `${drawn} rows drawn: the window should stay near 150`);
    // keydown -> next frame includes waiting for that frame (up to 16.7 ms at 60 Hz)
    assert(
      typingIdle.median <= 20,
      `typing while idle: median ${typingIdle.median} ms`,
    );
    assert(
      typingStreaming.median <= 20 && typingStreaming.max < 60,
      `typing while streaming: ${JSON.stringify(typingStreaming)}`,
    );
    assert(
      page.errors.length === 0,
      `console errors: ${page.errors.join(" | ")}`,
    );
  } finally {
    await st.stop();
  }
}

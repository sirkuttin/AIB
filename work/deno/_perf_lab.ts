/**
 * The page performance harness (perf_e2e_test.ts): the scroll lab's Studio + scripted agent + headless Chrome, a long live chat
 * (hundreds of messages and finished steps with long outputs, ~15 helpers) that keeps streaming, and DevTools measurements of the
 * chat page: JS heap after a forced GC, DOM nodes, event listeners, main-thread busy time (TaskDuration / ScriptDuration per
 * second of wall clock), layouts and style recalcs, and typing latency (a real key press → the next frame).
 */
import { type Chat, Lab, shown, sleep } from "./_scroll_lab.ts";
import type { Page } from "./_doc_browser.ts";

export interface Sample {
  t: number; // seconds since streaming began
  heapMB: number;
  nodes: number;
  listeners: number;
  documents: number;
  /** busy share of one core over the last interval (TaskDuration delta / wall delta), percent */
  cpu: number;
  /** script share of one core over the last interval, percent */
  script: number;
  layouts: number; // per second
  styles: number; // per second
}

export async function metrics(
  page: Page,
  gc = true,
): Promise<Record<string, number>> {
  if (gc) await page.send("HeapProfiler.collectGarbage");
  const r = await page.send("Performance.getMetrics");
  const out: Record<string, number> = {};
  for (const m of r.metrics as { name: string; value: number }[]) {
    out[m.name] = m.value;
  }
  return out;
}

/** Seed a long live chat: `pairs` agent messages each followed by a finished step (every third with a long output). */
export function seedLong(chat: Chat, pairs: number) {
  const code = Array.from(
    { length: 18 },
    (_, k) => `  const value${k} = compute(${k}); // step ${k}`,
  ).join("\n");
  const fence = "```";
  for (let i = 0; i < pairs; i++) {
    const md = i % 4 === 0
      ? `\n\n## Part ${i}\n\nHistory message ${i} with **bold**, \`code\` and a list:\n\n- one item\n- two items\n\n${fence}js\n${code}\n${fence}\n`
      : `\n\nHistory message ${i}. ` +
        "Words that fill a line or two of the chat. ".repeat(5);
    chat.say(md);
    if (i % 5 === 1) {
      chat.tool(`h-${i}`, `Edit src/file${i}.ts`, "completed", {
        kind: "edit",
        content: [{
          type: "diff",
          path: `C:\\work\\src\\file${i}.ts`,
          oldText: "a\nb\nc\n".repeat(10),
          newText: "a\nB\nc\n".repeat(10),
        }],
      });
      continue;
    }
    const out = i % 3 === 0
      ? Array.from({ length: 60 }, (_, k) => `line ${k} of output ${i}`).join(
        "\n",
      )
      : `ok ${i}`;
    chat.tool(`h-${i}`, `Run step ${i}`, "completed", { rawOutput: out });
  }
}

export function helper(chat: Chat, k: number, u: Record<string, unknown>) {
  chat.step({
    sid: `child-${k}`,
    u: { ...u, _meta: { claudeCode: { parentToolUseId: `agent-${k}` } } },
  });
}

export async function openLongChat(
  lab: Lab,
  pairs: number,
  helpers: number,
): Promise<Chat> {
  const chat = await lab.chat();
  await chat.start();
  for (let k = 0; k < helpers; k++) {
    chat.tool(`agent-${k}`, `Task helper ${k}`, "in_progress");
    chat.step({
      u: {
        sessionUpdate: "subagent_update",
        sessionId: `child-${k}`,
        title: `Helper ${k}`,
        capabilities: { cancel: {} },
        state: { state: "running" },
      },
    });
  }
  seedLong(chat, pairs);
  chat.say("\n\nSeed done PERFSEEDEND");
  await lab.select(chat);
  await shown(lab.page, "PERFSEEDEND", "messages", 120000);
  return chat;
}

/** Keep the chat streaming: a main message growing, a step every few ticks, a helper message every tick. */
export function streamer(chat: Chat, helpers: number, tickMs = 300) {
  let n = 0, stop = false;
  const run = (async () => {
    while (!stop) {
      n++;
      chat.say(`word${n} `);
      if (helpers) {
        const k = n % helpers;
        helper(chat, k, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `helper ${k} says ${n}. ` },
        });
        if (n % 4 === 0) {
          helper(chat, k, {
            sessionUpdate: "tool_call",
            toolCallId: `c${k}-${n}`,
            title: `Read file ${n}`,
            kind: "read",
            status: "completed",
          });
        }
      }
      if (n % 7 === 0) {
        chat.tool(`s-${n}`, `Live step ${n}`, "in_progress");
      }
      if (n % 7 === 3) {
        chat.toolDone(
          `s-${n - 3}`,
          Array.from({ length: 30 }, (_, k) => `out ${k}`).join("\n"),
        );
        chat.say(`\n\nNext paragraph ${n}. `);
      }
      await sleep(tickMs);
    }
  })();
  return {
    stop: async () => {
      stop = true;
      await run;
    },
    count: () => n,
  };
}

/** Typing latency: press a key in the composer; the page measures from the event's timestamp to the next animation frame. */
export async function typingLatency(
  page: Page,
  presses = 20,
): Promise<{ median: number; p90: number; max: number }> {
  await page.eval(`(() => {
    const p = document.getElementById('prompt');
    p.focus();
    window.__lat = [];
    if (!window.__latOn) {
      window.__latOn = true;
      p.addEventListener('keydown', (e) => { const t0 = e.timeStamp; requestAnimationFrame(() => window.__lat.push(performance.now() - t0)); });
    }
  })()`);
  for (let i = 0; i < presses; i++) {
    await page.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      text: "a",
      windowsVirtualKeyCode: 65,
    });
    await page.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
    });
    await sleep(97 + (i % 5) * 31);
  }
  await sleep(200);
  const lat = (await page.eval<number[]>(
    `(() => { const l = window.__lat; document.getElementById('prompt').value = ''; return l; })()`,
  )).sort((a, b) => a - b);
  const at = (q: number) =>
    Math.round(lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] ?? -1);
  return {
    median: at(0.5),
    p90: at(0.9),
    max: Math.round(lat[lat.length - 1] ?? -1),
  };
}

/** Sample metrics every `everyS` seconds for `seconds`. */
export async function sampleFor(
  page: Page,
  seconds: number,
  everyS: number,
  log?: (s: Sample) => void,
): Promise<Sample[]> {
  await page.send("Performance.enable", { timeDomain: "timeTicks" });
  const out: Sample[] = [];
  const t0 = Date.now();
  let prev = await metrics(page, false);
  let prevWall = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    await sleep(everyS * 1000);
    const busy = await metrics(page, false); // durations without the forced GC below
    const wall = (Date.now() - prevWall) / 1000;
    const cur: Record<string, number> = {
      ...(await metrics(page)),
      TaskDuration: busy.TaskDuration,
      ScriptDuration: busy.ScriptDuration,
      LayoutCount: busy.LayoutCount,
      RecalcStyleCount: busy.RecalcStyleCount,
    };
    const s: Sample = {
      t: Math.round((Date.now() - t0) / 1000),
      heapMB: +(cur.JSHeapUsedSize / 1048576).toFixed(1),
      nodes: cur.Nodes,
      listeners: cur.JSEventListeners,
      documents: cur.Documents,
      cpu: +((100 * (cur.TaskDuration - prev.TaskDuration)) / wall).toFixed(1),
      script: +((100 * (cur.ScriptDuration - prev.ScriptDuration)) / wall)
        .toFixed(1),
      layouts: +((cur.LayoutCount - prev.LayoutCount) / wall).toFixed(1),
      styles: +((cur.RecalcStyleCount - prev.RecalcStyleCount) / wall).toFixed(
        1,
      ),
    };
    out.push(s);
    log?.(s);
    prev = await metrics(page, false);
    prevWall = Date.now();
  }
  return out;
}

/** CPU profile for `seconds`: self time per function (ms), the top `n`. */
export async function profile(
  page: Page,
  seconds: number,
  n = 25,
): Promise<string[]> {
  await page.send("Profiler.enable");
  await page.send("Profiler.setSamplingInterval", { interval: 200 });
  await page.send("Profiler.start");
  await sleep(seconds * 1000);
  const { profile: p } = await page.send("Profiler.stop") as {
    profile: {
      nodes: {
        id: number;
        callFrame: { functionName: string; url: string; lineNumber: number };
        children?: number[];
      }[];
      samples: number[];
      timeDeltas: number[];
    };
  };
  const self = new Map<number, number>();
  p.samples.forEach((id, i) =>
    self.set(id, (self.get(id) ?? 0) + (p.timeDeltas[i] ?? 0))
  );
  const byId = new Map(p.nodes.map((x) => [x.id, x]));
  const parent = new Map<number, number>();
  for (const x of p.nodes) {
    for (const c of x.children ?? []) parent.set(c, x.id);
  }
  const name = (id: number) => {
    const f = byId.get(id)!.callFrame;
    return `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${
      f.lineNumber + 1
    }`;
  };
  const selfBy = new Map<string, number>(), totalBy = new Map<string, number>();
  for (const [id, us] of self) {
    selfBy.set(name(id), (selfBy.get(name(id)) ?? 0) + us);
    const seen = new Set<string>();
    for (
      let cur: number | undefined = id;
      cur !== undefined;
      cur = parent.get(cur)
    ) {
      const k = name(cur);
      if (seen.has(k)) continue;
      seen.add(k);
      totalBy.set(k, (totalBy.get(k) ?? 0) + us);
    }
  }
  const fmt = (m: Map<string, number>) =>
    [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, us]) =>
      `${(us / 1000).toFixed(0).padStart(6)} ms  ${k}`
    );
  return ["-- self", ...fmt(selfBy), "-- total", ...fmt(totalBy)];
}

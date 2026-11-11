/**
 * The real page in a headless browser (no window: Chrome or Edge with --headless=new, its own throwaway profile):
 * the agent adds box b1 on the server, the page renders it from Y, then the page's self-test moves b1 by +100 and selects it
 * the way a drag ends. The server must then hold the new x (Excalidraw -> Y) and see b1 as selected (awareness), so the
 * agent's next edit of b1 is refused with user_editing. Skipped when no Chrome or Edge is installed.
 */
import { assert, assertEquals } from '../_assert.ts';
import { readModels } from '../../../outputs/agent-studio/server/docs/drawing/model.ts';
import { drawing_edit, DrawingHub } from '../../../outputs/agent-studio/server/docs/drawing/tools.ts';
import { startDemo } from '../../../outputs/agent-studio/server/docs/drawing/demo_server.ts';

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const browser = BROWSERS.find((p) => {
  try {
    return Deno.statSync(p).isFile;
  } catch {
    return false;
  }
});

Deno.test({
  name: 'the page: agent box shows up, a drag in Excalidraw reaches Y, the selection reaches awareness',
  ignore: !browser,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const hub = new DrawingHub();
    const ac = new AbortController();
    const port = 8793; // clear of the live Studio ports (8767, 8768, 8777, 8778)
    const server = startDemo(hub, port, ac.signal);
    const profile = await Deno.makeTempDir({ prefix: 'aib-drawing-profile-' });
    try {
      const first = drawing_edit(hub, { drawing: 'd1', ops: [{ op: 'add_box', text: 'Agent box', id: 'b1' }] });
      assert(first.ok);
      const x0 = readModels(hub.doc, 'd1')[0].x as number;
      // The moment the page reports b1 selected, the agent tries to relabel it.
      let refusal = '';
      hub.awareness.on('change', () => {
        const sel = [...hub.awareness.getStates().values()].some((s) => (s as { selected?: string[] }).selected?.includes('b1'));
        if (sel && !refusal) {
          const v = readModels(hub.doc, 'd1').find((m) => m.id === 'b1')!.v;
          const res = drawing_edit(hub, { drawing: 'd1', ops: [{ op: 'set_text', id: 'b1', text: 'Agent was here', ifV: v }] });
          refusal = res.ok ? 'accepted' : res.error;
        }
      });
      const shot = `${profile}/shot.png`;
      const chrome = new Deno.Command(browser!, {
        args: [
          '--headless=new',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          `--user-data-dir=${profile}`,
          '--window-size=1200,800',
          '--remote-debugging-port=0',
          'about:blank',
        ],
        stdout: 'null',
        stderr: 'null',
      }).spawn();
      try {
        const title = await drive(profile, `http://127.0.0.1:${port}/?drawing=d1&selftest=1`, shot);
        assert(title.startsWith('selftest: ok'), title);
        assert(title.includes('label=Agent box'), title);
      } finally {
        try {
          chrome.kill();
        } catch { /* gone */ }
        await chrome.status;
      }
      const b1 = readModels(hub.doc, 'd1').find((m) => m.id === 'b1')!;
      assertEquals(b1.x, x0 + 100, 'the drag reached the server');
      assertEquals(b1.text, 'Agent box');
      assertEquals(refusal, 'user_editing', 'the selection reached awareness and blocked the agent');
      assert(Deno.statSync(shot).size > 10_000, 'screenshot written');
      const keep = Deno.env.get('AIB_DRAWING_SHOT');
      if (keep) Deno.copyFileSync(shot, keep);
    } finally {
      ac.abort();
      await server.finished;
      hub.destroy();
      await Deno.remove(profile, { recursive: true }).catch(() => {});
    }
  },
});

/** Opens `url` in the headless browser over the DevTools protocol, waits for the page's self-test title, saves a screenshot. */
async function drive(profile: string, url: string, shot: string): Promise<string> {
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    try {
      port = parseInt(Deno.readTextFileSync(`${profile}/DevToolsActivePort`), 10) || 0;
    } catch { /* not written yet */ }
    if (!port) await new Promise((r) => setTimeout(r, 100));
  }
  assert(port, 'DevTools port');
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let next = 1;
  const waiting = new Map<number, (v: { result?: Record<string, unknown> }) => void>();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) waiting.get(msg.id)!(msg), waiting.delete(msg.id);
  };
  const call = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<{ result?: Record<string, unknown> }>((r) => {
      const id = next++;
      waiting.set(id, r);
      ws.send(JSON.stringify({ id, method, params }));
    });
  try {
    let title = '';
    for (let i = 0; i < 150 && !title.startsWith('selftest:'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      const res = await call('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
      title = String((res.result?.result as { value?: string })?.value ?? '');
    }
    await new Promise((r) => setTimeout(r, 300));
    const png = await call('Page.captureScreenshot', { format: 'png' });
    Deno.writeFileSync(shot, Uint8Array.from(atob(String(png.result?.data ?? '')), (c) => c.charCodeAt(0)));
    return title;
  } finally {
    ws.close();
  }
}

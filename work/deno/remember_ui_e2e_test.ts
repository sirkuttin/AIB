/**
 * Real binaries (slow: one `deno desktop` build; AIB_SLOW_TESTS=1, Windows only): AIB opens where you left off after you quit it
 * and start a copy unzipped into ANOTHER folder (the owner's manual-update flow, beta.8). Each folder has its own WebView2 profile
 * (AIB.exe.WebView2 next to the exe, made by the runtime before any AIB code runs), so the page's localStorage starts empty there;
 * the project, its tabs and the open chat must come from the data folder (studio-view.json, view-prefs.js).
 *
 *   1. Build AIB once, unzip it into two folders A and B. Fake saved chats in three projects (Alpha, Beta, Delta).
 *   2. Start A on an invisible desktop (_hidden_desktop.ts) with a temp data folder, temp APPDATA/LOCALAPPDATA and port 8826, CDP 8946
 *      (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS). Open Beta's chat, then pick Delta (no tabs there, so Beta's chat stays in the middle)
 *      and close the window AT ONCE (WM_CLOSE 50 ms later): with the old 500 ms debounce that pick never reached the data folder.
 *   3. Start B from its own folder on the same data folder: its localStorage had nothing, yet Delta is the project and Beta's chat
 *      is open in the middle, as in A (before the fix, reopening that chat moved the sidebar to Beta). Both seen with beta.8-test4.
 * Only processes this test started are killed. Gives up after 15 minutes.
 */
import { assert, assertEquals } from './_assert.ts';
import { Fixture, until } from './_host_fixture.ts';
import { HiddenDesktop } from './_hidden_desktop.ts';
import { APP_VERSION, REPO_ROOT } from '../../outputs/agent-studio/server/core/app.ts';
import { projectKey } from '../../outputs/agent-studio/server/desktop/project_delete.ts';

const SLOW = Deno.build.os === 'windows' && Deno.env.get('AIB_SLOW_TESTS') === '1';
const PORT = 8826;
const CDP = 8946;
const WM_CLOSE = 0x0010;
const DEC = new TextDecoder();
type Json = Record<string, unknown>;

async function build(out: string): Promise<void> {
  const args = ['run', '-A', `${REPO_ROOT}\\tools\\build.ts`, '--targets', 'windows-x64', '--out', out, '--no-smoke'];
  const r = await new Deno.Command(Deno.execPath(), { args, stdout: 'piped', stderr: 'piped' }).output();
  if (!r.success) throw new Error(`build failed: ${DEC.decode(r.stderr)}`);
}

async function unzip(zip: string, into: string): Promise<void> {
  Deno.mkdirSync(into, { recursive: true });
  const r = await new Deno.Command('C:\\Windows\\System32\\tar.exe', { args: ['-xf', zip, '-C', into] }).output();
  assert(r.success, `unzip ${zip}`);
}

async function cdpEval(expression: string): Promise<unknown> {
  const targets = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json() as Json[];
  const page = targets.find((t) => t.type === 'page' && String(t.url).startsWith(`http://127.0.0.1:${PORT}`));
  if (!page) throw new Error('no page target yet');
  const ws = new WebSocket(String(page.webSocketDebuggerUrl));
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  try {
    const answer = new Promise<Json>((resolve) => (ws.onmessage = (e) => resolve(JSON.parse(e.data))));
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    const reply = await answer;
    return ((reply.result as Json)?.result as Json)?.value;
  } finally {
    ws.close();
  }
}

async function exited(pid: number): Promise<boolean> {
  const r = await new Deno.Command('tasklist', { args: ['/FI', `PID eq ${pid}`, '/NH'], stdout: 'piped' }).output();
  return !DEC.decode(r.stdout).includes(String(pid));
}

/** Kill every process whose program is under `folder` (only this test's copies of AIB live there). */
async function killUnder(folder: string): Promise<void> {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${
    folder.replaceAll("'", "''")
  }', 'OrdinalIgnoreCase') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  await new Deno.Command('powershell', { args: ['-NoProfile', '-NonInteractive', '-Command', script] }).output();
}

/** Fake saved Claude chats, one per project folder. */
function savedChats(root: string, claude: string): string[] {
  const folders: string[] = [];
  ['Alpha', 'Beta', 'Delta'].forEach((name, i) => {
    const cwd = `${root}\\projects\\${name}`;
    Deno.mkdirSync(cwd, { recursive: true });
    folders.push(cwd);
    const stamp = new Date(Date.now() - (i + 1) * 60_000).toISOString();
    const rows = [
      { type: 'user', sessionId: `s-${name}`, cwd, timestamp: stamp, message: { role: 'user', content: `Work on ${name}` } },
      {
        type: 'assistant',
        sessionId: `s-${name}`,
        cwd,
        timestamp: stamp,
        message: { role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'Done.' }] },
      },
    ];
    Deno.mkdirSync(`${claude}\\enc`, { recursive: true });
    Deno.writeTextFileSync(`${claude}\\enc\\s-${name}.jsonl`, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  });
  return folders;
}

Deno.test({
  name: 'real binaries: quit right after picking a project, start a copy from another folder, the same project and chat open',
  ignore: !SLOW,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      giveUp = setTimeout(() => reject(new Error('gave up after 15 minutes')), 15 * 60_000);
    });
    await using fx = new Fixture();
    const desk = new HiddenDesktop();
    const saved = Deno.env.toObject();
    try {
      await Promise.race([deadline, run(fx, desk, saved)]);
    } finally {
      clearTimeout(giveUp);
      await killUnder(`${fx.root}\\install`);
      desk.close();
      for (const k of Object.keys(Deno.env.toObject())) if (!(k in saved)) Deno.env.delete(k);
      for (const [k, v] of Object.entries(saved)) Deno.env.set(k, v);
    }
  },
});

async function run(fx: Fixture, desk: HiddenDesktop, saved: Record<string, string>): Promise<void> {
  const dist = `${fx.root}\\dist`;
  const started = Date.now();
  await build(dist);
  console.log(`build: ${((Date.now() - started) / 1000).toFixed(0)} s`);
  const appA = `${fx.root}\\install\\A`, appB = `${fx.root}\\install\\B`;
  await unzip(`${dist}\\AIB-${APP_VERSION}-windows-x64.zip`, appA);
  await unzip(`${dist}\\AIB-${APP_VERSION}-windows-x64.zip`, appB);
  const claude = `${fx.root}\\claude`;
  const folders = savedChats(fx.root, claude);
  // The three projects were added before (AIB lists a data folder's agent history only for added projects).
  const added: Record<string, { path: string; at: number }> = {};
  for (const path of folders) added[projectKey(path)] = { path, at: 1 };
  Deno.writeTextFileSync(`${fx.state}\\studio-added-projects.json`, JSON.stringify({ version: 1, savedAt: 1, start: 'fresh', added }));
  const env: Record<string, string> = {
    AGENT_STUDIO_STATE_DIR: fx.state,
    APPDATA: `${fx.root}\\appdata`,
    LOCALAPPDATA: `${fx.root}\\localappdata`,
    AIB_UPDATE_API_BASE: 'http://127.0.0.1:9', // no update check reaches anything
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP}`,
  };
  for (const d of [env.APPDATA, env.LOCALAPPDATA]) Deno.mkdirSync(d, { recursive: true });
  Deno.writeTextFileSync(`${fx.state}\\desktop-port.json`, JSON.stringify({ port: PORT }));
  const flags = [
    '--state-dir',
    fx.state,
    '--omp-sessions',
    `${fx.root}\\omp`,
    '--claude-projects',
    claude,
    '--owners-dir',
    fx.owners,
  ];
  const spawn = (dir: string) => {
    try {
      for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
      return desk.spawn([`${dir}\\AIB\\AIB.exe`, ...flags], `${dir}\\AIB`);
    } finally {
      for (const k of Object.keys(env)) saved[k] === undefined ? Deno.env.delete(k) : Deno.env.set(k, saved[k]);
    }
  };
  const ready = () => cdpEval(`!!(window.AgentWorkspaceUI && AgentWorkspaceUI._items().length >= 3)`);
  const active = async () => String(await cdpEval(`AgentWorkspaceUI._state().active`)).split('/').pop();
  const title = () => cdpEval(`document.getElementById('title').textContent`);

  // ---- A: the first copy. Open Beta's chat, then pick Delta (no tabs there: Beta's chat stays in the middle) and close at once.
  const aPid = spawn(appA);
  await until(ready, "A's page with the three projects", 120);
  assertEquals(await active(), 'alpha', 'a fresh data folder starts on the first project');
  const key = (name: string) => cdpEval(`AgentWorkspaceUI.paletteProjects().find((p) => p.name === '${name}').key`).then(String);
  const beta = await key('Beta'), delta = await key('Delta');
  await cdpEval(`AgentWorkspaceUI.selectProject(${JSON.stringify(beta)}), 1`);
  await until(() => cdpEval(`!!document.querySelector('#connections button[data-key="claude:s-Beta"]')`), "Beta's chat in the list", 20);
  await cdpEval(`document.querySelector('#connections button[data-key="claude:s-Beta"]').click(), 1`);
  await until(async () => (await title()) === 'Work on Beta', "Beta's chat open in A", 30);
  await until(async () => JSON.parse(String(await cdpEval(`localStorage.getItem('studio-workspace-v1')`))).last?.[beta], 'its tab noted', 10);
  const win = await until(() => desk.windows().find((w) => w.pid === aPid && w.visible && w.title === 'AIB') ?? null, "A's window", 30);
  await cdpEval(`AgentWorkspaceUI.selectProject(${JSON.stringify(delta)}), 1`);
  await new Promise((r) => setTimeout(r, 50));
  assert(desk.post(win, WM_CLOSE), 'WM_CLOSE posted');
  await until(() => exited(aPid), 'A exited', 60);
  const file = JSON.parse(Deno.readTextFileSync(`${fx.state}\\studio-view.json`));
  const ws = JSON.parse(file.prefs['studio-workspace-v1']);
  assertEquals(ws.active, delta, 'the pick reached the data folder before AIB.exe was gone (the old 500 ms debounce lost it)');
  assertEquals(ws.last[beta], 'claude:s-Beta', "and Beta's open chat");

  // ---- B: another folder, an empty WebView2 profile, the same data folder
  assert(!exists(`${appB}\\AIB\\AIB.exe.WebView2\\EBWebView\\Default\\Local Storage`), "B's WebView profile has no localStorage yet");
  spawn(appB);
  await until(ready, "B's page", 120);
  assertEquals(await until(async () => (await title()) === 'Work on Beta' ? 'ok' : null, "Beta's chat open in B", 30), 'ok');
  await new Promise((r) => setTimeout(r, 3000)); // a few list polls: nothing moves the sidebar afterwards either
  assertEquals(await active(), 'delta', "the project you had open (it used to jump to the reopened chat's project, Beta)");
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

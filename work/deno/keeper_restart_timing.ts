/**
 * Dev restart timing (not a test; run by hand): how long a source-run restart takes until a working chat is seen again, streaming.
 * Prints one JSON line per run and a summary.
 *
 *   split            web server and agent host, no keeper: restart the web server only (the host keeps the agent). The dev loop
 *                    before the keeper; host-side code needed `deploy --host`, which waits until no chat works.
 *   merged+keeper    the default: one process (no agent host) with the keeper: restart it (it rebuilds the chat from the keeper).
 *   split+keeper     keeper step 1 only (web server, host, keeper; restart the host). With step 2 the keeper always means one
 *                    process, so this mode now measures merged+keeper again; kept for the record (step 1: about 6.4 s, the web
 *                    server's 5 s reattach throttle plus its heartbeat).
 *
 * "Restart" = kill the process (TerminateProcess), start the same command again, and time from the spawn until /api/live/state shows
 * the chat busy with a new chunk after the restart. Ports 8821-8829, temp state folders, only PIDs this script started are killed.
 *
 *   deno run -A work/deno/keeper_restart_timing.ts [runs]
 */
import { DENO, Fixture, MAIN, nativePath, openConversation, SEP, sleep, until, Web } from './_host_fixture.ts';
import { WORK } from './_parity.ts';
import { keeperBinary, readKeeperInfo } from '../../outputs/agent-studio/server/keeper/client.ts';
import { pidAlive, readInfo } from '../../outputs/agent-studio/server/host/host_client.ts';

type Json = Record<string, unknown>;
const KEEPER_AGENT = nativePath(new URL('keeper-fixture/agent.py', WORK));
const RUNS = Number(Deno.args[0] ?? 5);

function chunks(state: Json): number {
  return ((state.events ?? []) as Json[]).filter((e) =>
    e.kind === 'update' && ((e.data as Json)?.update as Json)?.sessionUpdate === 'agent_message_chunk'
  ).length;
}

class Lab extends Fixture {
  keeper = false;
  keeperBin = '';
  override agentFlags(): string[] {
    const flags = super.agentFlags();
    flags[flags.indexOf('--claude-launcher') + 1] = KEEPER_AGENT;
    return flags;
  }
  override get env(): Record<string, string> {
    return this.keeper ? { ...super.env, AIB_KEEPER: '1', AIB_KEEPER_BIN: this.keeperBin } : super.env; // '1': anything but '0' is on
  }
  async startOn(port: number, extra: string[]): Promise<Web> {
    const [child, log] = this.spawn(
      [DENO, 'run', '-A', '--quiet', MAIN, 'serve', '--port', String(port), ...this.agentFlags(), '--host-idle-minutes', '0', ...extra],
      `web-${port}`,
    );
    const web = new Web(child, port, log);
    await web.waitReady(this);
    return web;
  }
  override async cleanup(): Promise<void> {
    // The keeper first: with live chats and no client it would start the server again (its orphan command).
    const k = readKeeperInfo(this.state);
    if (k && pidAlive(k.pid)) Deno.kill(k.pid, 'SIGKILL');
    await super.cleanup().catch(() => {});
  }
}

async function seenAgain(web: Web, id: string, before: number, started: number): Promise<number> {
  await until(
    async () => {
      const [status, boot] = await web.get('/api/live/bootstrap');
      if (status !== 200) return false;
      web.token = String(boot.token);
      const s = await web.state(id);
      return s && s.id === id && s.busy && chunks(s) > before;
    },
    'chat streaming again',
    60,
  );
  return Date.now() - started;
}

async function one(mode: 'split' | 'split+keeper' | 'merged+keeper', port: number): Promise<Json> {
  const lab = new Lab();
  lab.keeper = mode !== 'split';
  if (lab.keeper) lab.keeperBin = await keeperBinary();
  const extra = mode === 'merged+keeper' ? ['--in-process'] : [];
  let logOf = '';
  try {
    let web = await lab.startOn(port, extra);
    logOf = web.logPath;
    const id = await openConversation(web, lab);
    await web.post('prompt', { id, text: 'stream:4000:50', clientMessageId: 'timing' });
    await until(async () => chunks(await web.state(id)) > 5, 'streaming', 30);
    await sleep(500);
    let started: number;
    if (mode === 'split+keeper') {
      const host = (await readInfo(lab.state))!.pid as number;
      const before = chunks(await web.state(id));
      Deno.kill(host, 'SIGKILL');
      started = Date.now();
      await until(() => !pidAlive(host), 'host gone', 10);
      // the web server starts a new host on its next call; the page polls about every second
      return { mode, ms: await seenAgain(web, id, before, started) };
    }
    const before = chunks(await web.state(id));
    await web.kill();
    started = Date.now();
    web = await lab.startOn(port, extra);
    const ms = await seenAgain(web, id, before, started);
    return { mode, ms };
  } catch (error) {
    const hostLog = lab.read(lab.state + SEP + 'agent-host.log');
    throw new Error(`${error}
--- web log ---
${lab.read(logOf).slice(-1500)}
--- host log ---
${hostLog.slice(-1500)}`);
  } finally {
    await lab.cleanup();
  }
}

const results: Json[] = [];
let port = 8821;
for (let i = 0; i < RUNS; i++) {
  for (
    const mode of (Deno.env.get('TIMING_STEP1') ? ['split', 'split+keeper', 'merged+keeper'] : ['split', 'merged+keeper']) as (
      'split' | 'split+keeper' | 'merged+keeper'
    )[]
  ) {
    let r: Json;
    try {
      r = await one(mode, port);
    } catch (error) {
      r = { mode, failed: String(error) };
    }
    port = port >= 8827 ? 8821 : port + 2; // the artifact origin takes port + 1
    console.log(JSON.stringify(r));
    results.push(r);
  }
}
const by = (mode: string) => results.filter((r) => r.mode === mode && r.ms !== undefined).map((r) => Number(r.ms)).sort((a, b) => a - b);
for (const mode of ['split', 'split+keeper', 'merged+keeper']) {
  const v = by(mode);
  if (!v.length) continue;
  console.log(`${mode}: median ${v[Math.floor(v.length / 2)]} ms, min ${v[0]}, max ${v[v.length - 1]} (${v.length} runs)`);
}
void SEP;

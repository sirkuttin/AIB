/**
 * Test helper for work/test_refile_e2e.py: runs AIB's re-file core (server/worktrees/refile.ts) once, on the folders given, and prints
 * its result as one JSON line. Only temp folders a test made are passed; under AGENT_STUDIO_TEST=1 the owner's ~/.claude is refused.
 *
 *   deno run -A work/refile_cli.ts claude <stateDir> <projectsRoot> <sessionId> <fromFolder> <toFolder>
 *   deno run -A work/refile_cli.ts clean  <projectsRoot> <worktreesRoot>
 *   deno run -A work/refile_cli.ts codex-studio <stateDir> <codexHome> <node> <adapter> <copyFolder> <projectFolder>
 *
 * codex-studio is the Codex re-file path through AIB itself: a real Studio (no keeper) starts a Codex chat with the real adapter in
 * the copy folder and tells it the codeword (the stub model API answers), closes it, then runs Studio.moveChatToFolder as a Discard
 * does: the moved-chat mapping, the rollout backup, and the chat opened once in the project folder (connect -> session/load with
 * cwd = project, no prompt). Then Continue from a page that still sends the copy folder: the chat must open in the project folder and
 * still know the codeword. The agent gets CODEX_HOME = <codexHome> (a temp folder with the stub's config.toml) and the caller's HOME;
 * the owner's ~/.codex is refused (refile.codexHome under AGENT_STUDIO_TEST=1).
 */
import * as refile from '../outputs/agent-studio/server/worktrees/refile.ts';
import { Connection } from '../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../outputs/agent-studio/server/host/studio.ts';

type Json = Record<string, unknown>;

const replyText = (c: Connection, from = 0) =>
  c.events.slice(from)
    .filter((e) => e.kind === 'update')
    .map((e) => (e.data as Json).update as Json)
    .filter((u) => u && u.sessionUpdate === 'agent_message_chunk')
    .map((u) => String(((u.content as Json) ?? {}).text ?? ''))
    .join('');

async function idle(c: Connection, seconds = 120): Promise<void> {
  const until = Date.now() + seconds * 1000;
  await new Promise((r) => setTimeout(r, 300));
  while (c.busy && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  if (c.busy) throw new Error('the turn did not end');
}

async function codexStudio(stateDir: string, home: string, node: string, adapter: string, copy: string, project: string): Promise<Json> {
  const codexHome = refile.codexHome({ CODEX_HOME: home }, '');
  if (!codexHome) return { error: "refused: the owner's ~/.codex" };
  const env: Record<string, string> = { CODEX_HOME: codexHome };
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
    const v = Deno.env.get(name);
    if (v) env[name] = v;
  }
  const studio = new Studio({ ompCommand: 'unused', stateDir, port: 0, ownersDir: null, noArtifactTool: true }, { keeper: null });
  studio.ownerProbe = () => null; // no other process holds these temp sessions (the process scan is not what this test is about)
  studio.agentLaunch = () => Promise.resolve([[node, adapter], {}]);
  studio.agentHomes = () => ({ claudeProjects: null, codexHome });
  const cwds: string[] = [];
  studio.connectionFactory = (command, cwd, provider, options) => {
    cwds.push(cwd);
    return new Connection(command, cwd, provider, { ...(options ?? {}), env: { ...(options?.env ?? {}), ...env } });
  };
  try {
    const made = await studio.connect('codex', copy, null);
    await made.prompt('the codeword is TEAL-42');
    await idle(made);
    const first = replyText(made);
    const sessionId = String(made.sessionId);
    await studio.liveCall('disconnect', { id: made.id });
    // what a Discard does once the copy is gone (host/studio.ts worktreeDiscard -> moveChatToFolder)
    await studio.moveChatToFolder({ session: `codex:${sessionId}`, project, path: copy, branch: 'studio/chat-e2e19' } as never, 'discarded');
    const moved = refile.readMoved(stateDir)[`codex:${sessionId}`] ?? null;
    const loadCwd = cwds[cwds.length - 1] ?? '';
    // Continue from a page that still sends the copy folder (the transcript's old cwd)
    const again = await studio.connect('codex', copy, sessionId);
    const mark = again.events.length;
    await again.prompt('what is the codeword?');
    await idle(again);
    const out = { sessionId, first, moved, loadCwd, continuedIn: again.cwd, reply: replyText(again, mark), log: '' };
    try {
      out.log = Deno.readTextFileSync(`${stateDir}/refile.log`);
    } catch { /* none */ }
    await studio.liveCall('disconnect', { id: again.id });
    return out;
  } finally {
    await studio.close().catch(() => {});
  }
}

const [op, ...a] = Deno.args;
if (op === 'claude') {
  const root = refile.claudeProjectsRoot({ CLAUDE_CONFIG_DIR: a[1].replace(/[\\/]projects$/, '') }, null);
  if (!root) {
    console.log(JSON.stringify({ error: 'refused: not a temp folder' }));
    Deno.exit(1);
  }
  console.log(JSON.stringify(refile.refileClaude({ stateDir: a[0], projectsRoot: root, sessionId: a[2], from: a[3], to: a[4] })));
} else if (op === 'clean') {
  const [removed, kept] = refile.cleanEmptyCopyFolders(a[0], a[1]);
  console.log(JSON.stringify({ removed, kept }));
} else if (op === 'codex-studio') {
  console.log(JSON.stringify(await codexStudio(a[0], a[1], a[2], a[3], a[4], a[5])));
  Deno.exit(0);
} else {
  console.log(JSON.stringify({ error: 'usage: refile_cli.ts claude|clean|codex-studio ...' }));
  Deno.exit(2);
}

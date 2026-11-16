/**
 * WSL audit (docs/wsl/audit-beta10.md), Group A: swarm helpers and a WSL chat. Helpers are off for WSL chats (mcp.ts
 * WSL_TOOL_GROUPS.swarm false: a WSL chat gets no main role, so no helper tools in its tool list). The swarm service is the
 * enforcing side ("never taken from the agent's word"): its own role check (Swarm.mainChat) must refuse a WSL chat too, so a
 * WSL worktree chat that reaches POST /api/live/swarm/tool with its key never starts a helper agent in the distro.
 * No agent and no distro: the host is a stub giving the live state a WSL worktree chat has (Connection.public()).
 */
import { assert, assertEquals } from './_assert.ts';
import { Refusal, Swarm } from '../../outputs/agent-studio/server/swarm/service.ts';
import { setSwarmEnabled } from '../../outputs/agent-studio/server/swarm/settings.ts';

type Json = Record<string, unknown>;

const BRIEF: Json = {
  title: 'Login tests',
  job: 'tests',
  goal: 'Make the login tests pass every time.',
  owns: ['test/login/**'],
  done_when: 'the login tests pass',
  reply_with: 'cause in one line',
  test_cmd: 'none: audit probe',
};

Deno.test({
  name: 'KNOWN-BROKEN: audit wsl swarm: the swarm service refuses start_helper for a WSL worktree chat (no helper agent started)',
  async fn() {
    const stateDir = Deno.makeTempDirSync({ prefix: 'aib-wsl-audit-swarm-' });
    try {
      setSwarmEnabled(stateDir, true);
      const calls: [string, unknown][] = [];
      const state: Json = {
        id: 'wslchat1',
        provider: 'claude',
        sessionId: 's1',
        cwd: 'wsl://ubuntu/home/u/.aib-server/data-x/worktrees/app-abc',
        projectRoot: 'wsl://ubuntu/home/u/app',
        worktree: { branch: 'aib/chat-1', base: 'main' },
        wsl: { distro: 'ubuntu', name: 'Ubuntu', linuxPath: '/home/u/.aib-server/data-x/worktrees/app-abc' },
        closed: false,
      };
      const swarm = new Swarm({
        stateDir,
        host: {
          liveList: () => Promise.resolve({ active: [state] }),
          liveState: (id) => Promise.resolve(id === state.id ? state : null),
          liveCall: (name, body) => {
            calls.push([name, body]);
            return Promise.resolve([500, { error: 'stub' }] as [number, unknown]);
          },
        },
        settings: { builtinEnabled: () => true, betaEnabled: () => true },
      });
      const [status, payload] = await swarm.tool(state.id, 'start_helper', BRIEF);
      assertEquals(calls.filter(([n]) => n === 'connect'), [], 'no helper chat is started for a WSL chat');
      assert(status >= 400, `refused: ${status} ${JSON.stringify(payload)}`);
      assertEquals((payload as Json).code, 'wsl');
      assertEquals((payload as Json).error, 'Helpers are not available in WSL projects yet');
    } finally {
      Deno.removeSync(stateDir, { recursive: true });
    }
  },
});

/** A Swarm whose host knows one live chat (`state`) and records every liveCall. */
function swarmFor(stateDir: string, state: Json, calls: [string, unknown][]): Swarm {
  return new Swarm({
    stateDir,
    host: {
      liveList: () => Promise.resolve({ active: [state] }),
      liveState: (id) => Promise.resolve(id === state.id ? state : null),
      liveCall: (name, body) => {
        calls.push([name, body]);
        return Promise.resolve([500, { error: 'stub' }] as [number, unknown]);
      },
    },
    settings: { builtinEnabled: () => true, betaEnabled: () => true },
  });
}

Deno.test('F7: Swarm.mainChat refuses any WSL chat (ref cwd, ref projectRoot or a wsl block), and still accepts a Windows worktree chat', async () => {
  const stateDir = Deno.makeTempDirSync({ prefix: 'aib-wsl-audit-swarm-' });
  try {
    const wt = { branch: 'aib/chat-1', base: 'main' };
    const cases: Json[] = [
      { id: 'a', cwd: 'wsl://ubuntu/home/u/app', projectRoot: 'wsl://ubuntu/home/u/app', worktree: wt },
      { id: 'b', cwd: 'C:\\x', projectRoot: 'wsl://ubuntu/home/u/app', worktree: wt },
      { id: 'c', cwd: 'C:\\x', projectRoot: 'C:\\x', worktree: wt, wsl: { distro: 'ubuntu' } },
      { id: 'd', cwd: 'wsl://ubuntu/home/u/app' }, // in place: refused as WSL first (the clearer reason)
    ];
    for (const state of cases) {
      const swarm = swarmFor(stateDir, { provider: 'claude', closed: false, ...state }, []);
      let code = '';
      try {
        await swarm.mainChat(state.id);
      } catch (e) {
        if (e instanceof Refusal) code = e.code;
      }
      assertEquals(code, 'wsl', `chat ${state.id}`);
    }
    const win: Json = { id: 'w', provider: 'claude', closed: false, cwd: 'C:\\wt\\app-1', projectRoot: 'C:\\repo\\app', worktree: wt };
    assertEquals((await swarmFor(stateDir, win, []).mainChat('w')).id, 'w', 'a Windows worktree chat is a main chat as before');
  } finally {
    Deno.removeSync(stateDir, { recursive: true });
  }
});

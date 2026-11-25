/**
 * WSL audit (docs/wsl/audit-beta10.md), Group A: swarm helpers and a WSL chat. Helpers work in WSL projects since 2026-11-25
 * (mcp.ts WSL_TOOL_GROUPS.swarm true; the worktree, landing and registry steps run in the distro: wsl/helpers.ts). The swarm service
 * is the enforcing side ("never taken from the agent's word"): Swarm.mainChat accepts a WSL main chat, and a start_helper in a project
 * whose distro cannot run helpers (an older AIB helper without helper.*, or a distro that is not answering) is refused up front, so no
 * helper agent starts that could not be landed. No agent and no distro: the host is a stub giving the live state a WSL worktree chat
 * has (Connection.public()), and a FakeWslHost stands in for the distro.
 * The full flows (start, report, land, conflicts, stop, unlanded work) are wsl_helpers_test.ts.
 */
import { assert, assertEquals } from './_assert.ts';
import { Refusal, Swarm } from '../../app/server/swarm/service.ts';
import { setSwarmEnabled } from '../../app/server/swarm/settings.ts';
import { setWslHostResolver } from '../../app/server/wsl/access.ts';
import { WslHelperError } from '../../app/server/wsl/contract.ts';
import { WSL_TOOL_GROUPS } from '../../app/server/artifacts/mcp.ts';
import { FakeWslHost } from './_wsl_fake.ts';

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

Deno.test('audit wsl swarm: helpers are on for WSL projects (the tool group)', () => {
  assertEquals(WSL_TOOL_GROUPS.swarm, true);
});

Deno.test({
  name: 'audit wsl swarm: start_helper in a WSL project whose distro helper is too old is refused before any chat starts',
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
      const host = new FakeWslHost(stateDir + '\\unused-keeper');
      host.handlers['helper.work'] = () => {
        throw new WslHelperError('no such method', 'no_method');
      };
      setWslHostResolver((d) => (d === 'ubuntu' ? host : null));
      const swarm = swarmFor(stateDir, state, calls);
      const [status, payload] = await swarm.tool(state.id, 'start_helper', BRIEF);
      assertEquals(calls.filter(([n]) => n === 'connect'), [], 'no helper chat is started');
      assert(status >= 400, `refused: ${status} ${JSON.stringify(payload)}`);
      assertEquals((payload as Json).code, 'wsl');
      assert(String((payload as Json).error).includes('too old to run helpers'), String((payload as Json).error));
    } finally {
      setWslHostResolver(null);
      Deno.removeSync(stateDir, { recursive: true });
    }
  },
});

Deno.test('audit wsl swarm: Swarm.mainChat accepts a WSL main chat (ref cwd, ref projectRoot, a wsl block) and still refuses a helper', async () => {
  const stateDir = Deno.makeTempDirSync({ prefix: 'aib-wsl-audit-swarm-' });
  try {
    const wt = { branch: 'aib/chat-1', base: 'main' };
    const cases: Json[] = [
      { id: 'a', cwd: 'wsl://ubuntu/home/u/app', projectRoot: 'wsl://ubuntu/home/u/app', worktree: wt },
      { id: 'b', cwd: 'C:\\x', projectRoot: 'wsl://ubuntu/home/u/app', worktree: wt },
      { id: 'c', cwd: 'C:\\x', projectRoot: 'C:\\x', worktree: wt, wsl: { distro: 'ubuntu' } },
      { id: 'd', cwd: 'wsl://ubuntu/home/u/app' }, // a chat in the project folder: its project is the folder it works in
    ];
    for (const state of cases) {
      const swarm = swarmFor(stateDir, { provider: 'claude', closed: false, ...state }, []);
      const caller = await swarm.mainChat(state.id);
      assertEquals(caller.id, state.id, `chat ${state.id}`);
    }
    assertEquals(
      (await swarmFor(stateDir, { id: 'd', provider: 'claude', closed: false, cwd: 'wsl://ubuntu/home/u/app' }, []).mainChat('d'))
        .projectRoot,
      'wsl://ubuntu/home/u/app',
    );
    const win: Json = { id: 'w', provider: 'claude', closed: false, cwd: 'C:\\wt\\app-1', projectRoot: 'C:\\repo\\app', worktree: wt };
    assertEquals((await swarmFor(stateDir, win, []).mainChat('w')).id, 'w', 'a Windows worktree chat is a main chat as before');
    // a helper (the registry lists it) is no main chat, WSL or not
    const wslHelper: Json = {
      id: 'h',
      provider: 'codex',
      sessionId: 'x',
      closed: false,
      cwd: 'wsl://ubuntu/home/u/wt/helper-1',
      projectRoot: 'wsl://ubuntu/home/u/app',
      worktree: wt,
    };
    const swarm = swarmFor(stateDir, wslHelper, []);
    await swarm.registry.update('hx', () => ({
      id: 'hx',
      title: 'T',
      project: 'wsl://ubuntu/home/u/app',
      parent: { live: 'p', lasting: 'claude:p' },
      chat: { live: 'h', lasting: 'codex:x', provider: 'codex', model: '', mode: 'auto' },
      brief: { goal: 'g', owns: [], avoid: [], done_when: 'd', reply_with: 'r', test_cmd: 'none', read_only: false, context_files: [] },
      picked_by: 'rule',
      rule: 'tests',
      why: '',
      worktree: { path: 'wsl://ubuntu/home/u/wt/helper-1', branch: 'studio/helper-1', base: 'main', start: 'abc' },
      state: 'working',
      reason: '',
      createdAt: 1,
      turnEndedAt: '',
      cursor: 0,
      reports: [],
      merge: null,
      notes: [],
    }));
    let code = '';
    try {
      await swarm.mainChat('h');
    } catch (e) {
      if (e instanceof Refusal) code = e.code;
    }
    assertEquals(code, 'nested');
  } finally {
    Deno.removeSync(stateDir, { recursive: true });
  }
});

/**
 * Maki end to end with the real program: AIB installs Maki from its GitHub release (the real download, SHA-256 checked) into a temp
 * state folder, then runs it against the local stub model API (work/stub_model_api.js, which speaks the Anthropic API) through the
 * key and address saved in Settings (ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL). In-process AIB, no keeper, no window.
 *
 *   sign-in check   no key: Needs sign-in (Maki exits before initialize); with the key: Ready
 *   chat            a reply; a write outside the project asks for approval, AIB's card answers Allow once and the file is written;
 *                   Stop ends a long turn at once; the chat ends and is resumed (session/load) with its history
 *
 * Isolation: HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG_* and TEMP point into the temp folder for this whole test process, so
 * neither the sign-in check nor the chat can read or write the owner's Maki folders (%APPDATA%\maki, ~/.config/maki ...). The test
 * skips (passes with a note) when github.com cannot be reached.
 */
import { assert, assertEquals } from './_assert.ts';
import { agentTempDirSync } from './_agent_tmp.ts';
import { pause, until } from './_connection.ts';
import { WORK } from './_work.ts';
import type { Connection } from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { pathOf } from '../../app/server/state/paths.ts';
import { releaseAsset } from '../../app/server/agents/release_install.ts';
import { betaAgent } from '../../app/server/agents/beta_catalog.ts';
import { resolveBeta } from '../../app/server/agents/beta_agents.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const WIN = Deno.build.os === 'windows';
const STUB = (() => {
  const path = decodeURIComponent(new URL('stub_model_api.js', WORK).pathname);
  return WIN ? path.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('/', '\\') : path;
})();
const HOME_VARS = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
];

function said(c: Connection): string {
  return c.events.filter((e) => e.kind === 'update').map((e) => {
    const update = (e.data as Json).update as Json;
    return update.sessionUpdate === 'agent_message_chunk' ? String((update.content as Json).text) : '';
  }).join('');
}

/** The owner's real Maki folders, read before the test changes the environment. */
function ownerMakiFolders(): string[] {
  const env = Deno.env.toObject();
  const out: string[] = [];
  if (env.APPDATA) out.push(pathOf(env.APPDATA, 'maki'));
  if (env.LOCALAPPDATA) out.push(pathOf(env.LOCALAPPDATA, 'maki'));
  if (env.HOME) {
    out.push(
      pathOf(env.HOME, '.config', 'maki'),
      pathOf(env.HOME, '.local', 'share', 'maki'),
    );
  }
  return out;
}

const exists = (path: string) => {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
};

class StubApi {
  readonly child: Deno.ChildProcess;
  port = 0;
  constructor(readonly log: string, script: string) {
    this.child = new Deno.Command('node', {
      args: [STUB, '--port', '0', '--stdin', '--log', log, '--script', script],
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'null',
    }).spawn();
  }
  async start(): Promise<void> {
    const reader = this.child.stdout.getReader();
    let text = '';
    const deadline = Date.now() + 15000;
    while (!/STUB_PORT=(\d+)/.test(text) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    void this.child.stdout.cancel().catch(() => {});
    this.port = Number(/STUB_PORT=(\d+)/.exec(text)?.[1] ?? 0);
    if (!this.port) {
      throw new Error('the stub model API did not start: ' + text);
    }
  }
  calls(): Json[] {
    try {
      return Deno.readTextFileSync(this.log).split('\n').filter((l) => l.trim())
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }
  async stop(): Promise<void> {
    try {
      await this.child.stdin.close();
    } catch { /* gone */ }
    try {
      this.child.kill();
    } catch { /* gone */ }
    await this.child.status.catch(() => {});
  }
}

Deno.test({
  name: 'Maki e2e: AIB installs the real release, sign-in check, chat reply, approval, Stop, resume',
  ...T,
  async fn() {
    if (!releaseAsset(betaAgent('maki'))) {
      console.log(
        `skipped: Maki publishes no build for ${Deno.build.os}-${Deno.build.arch}`,
      );
      return;
    }
    const owner = ownerMakiFolders();
    const ownerBefore = owner.map(exists);
    const saved = Object.fromEntries(
      [
        ...HOME_VARS,
        'TEMP',
        'TMP',
        'TMPDIR',
        'AGENT_STUDIO_TEST',
        'AGENT_STUDIO_ALLOW_REAL_AGENT',
      ].map(
        (k) => [k, Deno.env.get(k)],
      ),
    );
    const root = Deno.realPathSync(
      agentTempDirSync('aib-maki-e2e-'), // outside the home folder (the real-agent rule, _agent_tmp.ts)
    );
    const home = pathOf(root, 'home');
    for (const name of HOME_VARS) {
      const folder = name === 'APPDATA'
        ? pathOf(home, 'AppData', 'Roaming')
        : name === 'LOCALAPPDATA'
        ? pathOf(home, 'AppData', 'Local')
        : name.startsWith('XDG_')
        ? pathOf(home, 'xdg', name.slice(4).toLowerCase())
        : home;
      Deno.mkdirSync(folder, { recursive: true });
      Deno.env.set(name, folder);
    }
    const tmp = pathOf(root, 'tmp');
    Deno.mkdirSync(tmp);
    for (const name of ['TEMP', 'TMP', 'TMPDIR']) Deno.env.set(name, tmp);
    Deno.env.set('AGENT_STUDIO_TEST', '1');
    Deno.env.set('AGENT_STUDIO_ALLOW_REAL_AGENT', '1'); // the real Maki may start: everything it sees is in the temp folder

    const state = pathOf(root, 'state');
    const project = pathOf(root, 'proj');
    Deno.mkdirSync(project);
    Deno.writeTextFileSync(pathOf(project, 'README.md'), 'a test project\n');
    const outside = pathOf(root, 'outside.txt'); // outside the project: Maki asks before writing it
    const script = pathOf(root, 'script.json');
    Deno.writeTextFileSync(
      script,
      JSON.stringify({
        rules: [
          {
            when: 'please write the file',
            reply: {
              tools: [{
                id: 'toolu_mk1',
                name: 'write',
                input: {
                  path: outside.replaceAll('\\', '/'),
                  content: 'MAKI_WROTE',
                },
              }],
            },
          },
          { when: 'toolu_mk1', reply: { text: 'WRITE_DONE' } },
        ],
      }),
    );
    const stub = new StubApi(pathOf(root, 'stub.log'), script);
    const aib = new Aib({
            stateDir: state,
      port: 0,
      ownersDir: null,
    });
    aib.ownerProbe = () => null;
    try {
      // ---- 1. Install: the real archive from github.com, checked against the pinned SHA-256 ----
      const [status, started] = await aib.installCall('start', 'maki');
      assertEquals(status, 200, JSON.stringify(started));
      await aib.installer!.jobs.get('maki')?.done;
      const view = (await aib.installCall('status', 'maki'))[1] as Json;
      if (
        view.state === 'failed' &&
        /reach github|answered \d+|part way/.test(String(view.message))
      ) {
        console.log(
          `skipped: the Maki release could not be downloaded (${view.message})`,
        );
        return;
      }
      assertEquals(
        [view.state, view.message],
        ['done', ''],
        JSON.stringify(view),
      );
      const program = pathOf(
        state,
        'agents',
        'maki',
        '0.7.2',
        WIN ? 'maki.exe' : 'maki',
      );
      assert(exists(program), program);
      const row = await resolveBeta('maki', { stateDir: state });
      assertEquals([row.found, row.source, row.argv], [true, 'studio', [
        program,
        'acp',
      ]]);

      // ---- 2. Sign-in check: no key at all = Needs sign-in; the key and address from Settings = Ready ----
      let check = (await aib.signinCall('check', 'maki', true))[1] as Json;
      assertEquals(check.state, 'signin', JSON.stringify(check));
      await stub.start();
      await aib.settings.update({
        agents: {
          betaKey: { maki: 'stub-key-not-real' },
          betaUrl: { maki: `http://127.0.0.1:${stub.port}` },
        },
      });
      assertEquals(aib.betaEnv('maki'), {
        ANTHROPIC_API_KEY: 'stub-key-not-real',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`,
      });
      check = (await aib.signinCall('check', 'maki', true))[1] as Json;
      assertEquals(check.state, 'ready', JSON.stringify(check));

      // ---- 3. A chat: reply, models list and modes ----
      const c = await aib.connect('maki', project);
      assert(c.sessionId, 'session/new answered');
      const pub = c.public() as Json;
      const config = JSON.stringify(pub.configOptions ?? pub);
      assert(
        config.includes('"model"') && config.includes('anthropic/'),
        'its models arrive as the model config option: ' + config.slice(0, 300),
      );
      assert(JSON.stringify(pub).includes('"plan"'), 'its modes (build, plan)');
      await aib.liveCall('prompt', {
        id: c.id,
        text: 'hello, the codeword is KIWI-7',
        clientMessageId: 'm1',
      });
      await until(
        () => said(c).includes('STUB codeword=KIWI-7') && !c.busy,
        'the first reply',
        120,
      );

      // ---- 4. A tool call that needs approval: AIB shows the card, Allow once, Maki writes the file ----
      await aib.liveCall('prompt', {
        id: c.id,
        text: 'please write the file',
        clientMessageId: 'm2',
      });
      await until(() => c.permissions.size === 1, 'the approval card', 60);
      const [key, card] = [...c.permissions.entries()][0];
      const options = ((card.params as Json).options as Json[]).map((o) => o.optionId);
      assertEquals(options, [
        'allow_once',
        'allow_always',
        'reject_once',
        'reject_always',
      ]);
      await aib.liveCall('permission', {
        id: c.id,
        key,
        option: 'allow_once',
      });
      await until(
        () => said(c).includes('WRITE_DONE') && !c.busy,
        'the turn after the approval',
        60,
      );
      assertEquals(Deno.readTextFileSync(outside), 'MAKI_WROTE');

      // ---- 5. Stop: a turn the model holds for 40 s ends at once ----
      await aib.liveCall('prompt', {
        id: c.id,
        text: 'take your time STUB_WAIT=40',
        clientMessageId: 'm3',
      });
      await until(
        () =>
          c.busy &&
          stub.calls().some((x) => String(x.last ?? '').includes('STUB_WAIT=40')),
        'the long turn',
        60,
      );
      const stopAt = Date.now();
      await aib.liveCall('cancel', { id: c.id });
      await until(() => !c.busy, 'the turn to stop', 20);
      assert(
        Date.now() - stopAt < 20000,
        'stopped well before the model answered',
      );

      // ---- 6. Resume: end the chat, open it again from its session id (session/load): it remembers the codeword ----
      const session = c.sessionId!;
      await pause(500); // Maki saves its session right after a turn
      await c.close();
      const again = await aib.connect('maki', project, session);
      assertEquals(again.sessionId, session);
      const calls = stub.calls().length;
      const replayed = said(again).length; // Maki replays the history on session/load
      await aib.liveCall('prompt', { id: again.id, text: 'what was it again?', clientMessageId: 'm4' });
      await until(() => !again.busy && stub.calls().length > calls, 'the resumed turn', 120);
      // the model was sent the old history (the stub answers with the codeword it finds there)
      await until(() => said(again).slice(replayed).includes('STUB codeword=KIWI-7'), 'the resumed reply', 30);
      assertEquals(
        stub.calls().filter((x) => x.path === '/v1/messages').every((x) => x.method === 'POST'),
        true,
      );
    } finally {
      await aib.close().catch(() => {});
      await stub.stop();
      for (const [k, v] of Object.entries(saved)) {
        v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      }
      for (let i = 0; i < 20; i++) {
        try {
          Deno.removeSync(root, { recursive: true });
          break;
        } catch {
          await pause(250);
        }
      }
      // the owner's own Maki folders were never made by this test
      owner.forEach((folder, i) => assertEquals(exists(folder), ownerBefore[i], folder));
    }
  },
});

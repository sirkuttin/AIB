/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): allow rules in a WSL chat with the distro's real helper (`allow.facts`; audit
 * F1). A fake agent (work/fake_acp.py, the distro's python3) in a temp folder under AIB_WSL_ROOT asks to edit files by their absolute
 * Linux paths and to run `git status`: "Always allow" on the first edit saves an edit rule keyed by the project's ref, the second
 * edit in that folder is answered without a card, `git status` is answered by the Safe reads, and an edit through a link inside the
 * project that points to a folder outside it asks, with no Always allow. Everything lives under /tmp/aib-wsl-test-<random>.
 */
import { assert, assertEquals } from './_assert.ts';
import { until } from './_connection.ts';
import { cleanRoot, inDistro, KEY, prepareRoot, readyHost, ROOT, T } from './_wsl_e2e.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { refOf } from '../../app/server/platform/location.ts';

type Json = Record<string, unknown>;

function studioIn(state: string): Aib {
  const studio = new Aib({ stateDir: state, port: 0, ownersDir: null, noArtifactTool: true }, { keeper: null });
  studio.ownerProbe = () => null;
  studio.connectionFactory = (_command, cwd, provider, options) =>
    new Connection(['python3', `${ROOT}/fake_acp.py`, '--cancel-aware'], cwd, provider, {
      ...options,
      wsl: options?.wsl ? { ...options.wsl, program: '/usr/bin/python3' } : options?.wsl,
    });
  return studio;
}

const said = (c: Connection) =>
  c.events.filter((e) => e.kind === 'update').map((e) => {
    const u = (e.data as Json).update as Json;
    return u.sessionUpdate === 'agent_message_chunk' ? String((u.content as Json).text) : '';
  }).join('');
const autos = (c: Connection) => c.events.filter((e) => e.kind === 'permission_auto').map((e) => String((e.data as Json).label));
const card = (c: Connection) => ((c.public() as Json).permissions as Json[])[0];

Deno.test({
  name: 'wsl e2e: allow rules in a WSL chat: Always allow on an edit, the next edit answered, git status answered, a link out asks',
  ...T,
  async fn() {
    const state = Deno.makeTempDirSync({ prefix: 'aib-wsl-allow-e2e-' });
    await prepareRoot();
    const studios: Aib[] = [];
    try {
      // a plain (not git) project folder, so the chat works in it; `link` inside it points to a folder outside the project
      const made = await inDistro(
        'mkdir -p "$1/proj/src" "$1/outside" && echo a > "$1/proj/src/a.ts" && ln -s "$1/outside" "$1/proj/link" && echo ok',
        [ROOT],
      );
      assertEquals(made.out.trim(), 'ok', made.err);
      const host = await readyHost();
      assert(host.helperVersion !== null, 'the helper is ready');
      const proj = `${ROOT}/proj`;
      const ref = refOf({ kind: 'wsl', distro: KEY, linuxPath: proj });
      const a = studioIn(state);
      studios.push(a);
      a.allow!.store.setEnabled(true);
      const c = await a.connect('claude', ref);
      assertEquals([c.cwd, c.agentCwd], [ref, proj]);

      // 1. an edit inside the project: a card with AIB's Always allow; answer it and save the rule
      await a.liveCall('prompt', { id: c.id, text: `allowedit:${proj}/src/a.ts`, clientMessageId: 'm1' });
      await until(() => c.permissions.size === 1, 'the first edit card', 30);
      const first = card(c);
      const draft = (first.allow as Json).project as Json;
      assertEquals([draft.available, draft.hideAgentAlways], [true, true], JSON.stringify(draft));
      const [status, saved] = await a.liveCall('allow-answer', { id: c.id, key: first.key, option: 'yes', scope: 'project' });
      assertEquals(status, 200, JSON.stringify(saved));
      const rule = ((saved as Json).rules as Json[])[0];
      assertEquals([rule.project, rule.kind, rule.folder], [ref, 'edit', 'src']);
      await until(() => !c.busy, 'turn end', 30);

      // 2. a second edit in that folder: answered by the rule, no card
      await a.liveCall('prompt', { id: c.id, text: `allowedit:${proj}/src/b.ts`, clientMessageId: 'm2' });
      await until(() => autos(c).length === 1, 'answered by the rule', 30);
      await until(() => !c.busy, 'turn end', 30);
      assertEquals([c.permissions.size, autos(c)[0]], [0, 'Edits in src/']);

      // 3. git status: the built-in Safe reads
      await a.liveCall('prompt', { id: c.id, text: 'allow:git status', clientMessageId: 'm3' });
      await until(() => autos(c).length === 2, 'Safe reads', 30);
      await until(() => !c.busy, 'turn end', 30);
      assertEquals(autos(c)[1], 'Safe reads');

      // 4. a project-wide rule, then an edit through the link to outside: still a card, and no Always allow for it
      a.allow!.store.add({ kind: 'edit', scope: 'project', project: ref, folder: '', label: 'Edits anywhere in the project', from: 'settings' });
      await a.liveCall('prompt', { id: c.id, text: `allowedit:${proj}/link/x.ts`, clientMessageId: 'm4' });
      await until(() => c.permissions.size === 1, 'the link-out card', 30);
      const out = (card(c).allow as Json).project as Json;
      assertEquals([out.available, out.reason], [false, 'Not available: AIB never auto-allows files outside the project.']);
      await a.liveCall('permission', { id: c.id, key: card(c).key, option: 'no' });
      await until(() => !c.busy, 'turn end', 30);
      assertEquals(autos(c).length, 2, 'the link out was never auto-allowed');
      assert(said(c).includes('allow outcome=no;'), said(c));
    } finally {
      for (const s of studios) await s.close().catch(() => {});
      await cleanRoot();
      Deno.removeSync(state, { recursive: true });
    }
  },
});

/**
 * WSL audit (docs/wsl/audit-beta10.md): allow rules (feat/allow-rules-1) and a WSL chat. The matcher (server/allow/matcher.ts,
 * paths.ts) checks every path with Windows rules (node:path resolve, Deno.realPathSync) against the chat's folder, and a WSL chat's
 * folder (Connection.allowContext().cwd / .project) is its `wsl://` ref. What a WSL chat gets today:
 *   - an edit inside its own project: no "Always allow" (the draft says "path could not be resolved"), and the card hides the
 *     agent's own "Always allow" button too (hideAgentAlways): the user cannot say "always" for edits at all;
 *   - a command (even a built-in Safe read such as `git status`): "runs outside the chat folder", also with the agent's own Always
 *     hidden;
 *   - an MCP / fetch project rule: saved under the AIB process's working folder joined with the ref
 *     (`<Deno.cwd()>\wsl:\ubuntu\home\u\app`), so it stops applying when AIB starts from another folder, and the Settings list shows
 *     that odd path;
 *   - the project-rule sweep (aib.ts allowAnswer) and rulesHere fold case, so /home/u/App and /home/u/app share project rules.
 * The context comes from a real WSL Connection (FakeWslHost lab): no assumption about what allowContext gives.
 * Fixed on wsl/fix-allow (allow/linux.ts): a WSL chat's context is its Linux folder, the project's ref and a LinuxView over facts from
 * its distro's helper (`allow.facts`); the probes below that were KNOWN-BROKEN pass now and run always (names kept).
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, pause, until } from './_connection.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { KeeperLink } from '../../app/server/keeper/link.ts';
import { KeeperClient, keeperBinary, readKeeperInfo } from '../../app/server/keeper/client.ts';
import { pidAlive } from '../../app/server/host/host_client.ts';
import { setWslHostResolver } from '../../app/server/wsl/access.ts';
import { factsNow } from '../../app/server/allow/linux.ts';
import { type AllowRule, match, type MatchContext, rulesHere } from '../../app/server/allow/matcher.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const REF = 'wsl://ubuntu/home/u/app';
Deno.env.set('AIB_WSL_ROOT', '/tmp/aib-wsl-test-audit');

class WslLab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-wsl-audit-allow-' }));
  readonly state = this.dir + SEP + 'state';
  readonly work = this.dir + SEP + 'app';
  readonly host: FakeWslHost;
  readonly aibs: Aib[] = [];

  constructor() {
    Deno.mkdirSync(this.work, { recursive: true });
    this.host = new FakeWslHost(this.dir + SEP + 'linux-keeper', 'Ubuntu', {});
    this.host.folders.set('/home/u/app', this.work);
    this.host.folders.set('/home/u', this.dir);
    setWslHostResolver((d) => (d === 'ubuntu' ? this.host : null));
  }

  aib(): Aib {
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'] });
    const aib = new Aib({ stateDir: this.state, port: 0, ownersDir: null }, { keeper });
    aib.ownerProbe = () => null;
    aib.connectionFactory = (_command, cwd, provider, options) => {
      const wsl = options?.wsl ? { ...options.wsl, program: undefined } : options?.wsl;
      return new Connection(fake('--cancel-aware', '--breadth'), cwd, provider, { ...options, wsl });
    };
    this.aibs.push(aib);
    return aib;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const s of this.aibs.reverse()) await s.close().catch(() => {});
    setWslHostResolver(null);
    await this.host.stopKeeper();
    const info = readKeeperInfo(this.state);
    if (info && pidAlive(info.pid)) {
      try {
        const client = await KeeperClient.connect(info);
        await client.shutdown(true).catch(() => {});
        client.close();
      } catch { /* gone */ }
      await until(() => !pidAlive(info.pid), 'keeper exit', 5).catch(() => Deno.kill(info.pid, 'SIGKILL'));
    }
    for (let i = 0; i < 20; i++) {
      try {
        Deno.removeSync(this.dir, { recursive: true });
        return;
      } catch {
        await pause(200);
      }
    }
  }
}

const OPTIONS = [
  { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
  { optionId: 'yes', kind: 'allow_once', name: 'Yes' },
  { optionId: 'no', kind: 'reject_once', name: 'No' },
];
const claudeCall = (tool: string, rawInput: Json, kind = 'other') => ({
  sessionId: 's',
  toolCall: { toolCallId: 't1', kind, rawInput, _meta: { claudeCode: { toolName: tool } } },
  options: OPTIONS,
});
/** Claude Code's Edit in a WSL chat: an absolute Linux path inside the project (Claude always sends absolute paths). */
const EDIT_ABS = claudeCall('Edit', { file_path: '/home/u/app/src/main.ts', old_string: 'a', new_string: 'b' }, 'edit');
const EDIT_REL = claudeCall('Edit', { file_path: 'src/main.ts', old_string: 'a', new_string: 'b' }, 'edit');
const SAFE_READ = claudeCall('Bash', { command: 'git status' }, 'execute');
const MCP = claudeCall('mcp__context7__search', {});

type Drafts = { project: Json; global: Json; off: string };

/** One WSL chat with allow rules on; `fn` gets its live allow context. */
async function withWslChat(fn: (aib: Aib, c: Connection, ctx: (p: unknown) => MatchContext) => Promise<void> | void) {
  await keeperBinary();
  await using lab = new WslLab();
  const aib = lab.aib();
  aib.allow!.store.setEnabled(true);
  const c = await aib.connect('claude', REF);
  assertEquals([c.cwd, c.agentCwd], [REF, '/home/u/app']);
  await fn(aib, c, (p) => c.allowContext(p));
}

Deno.test({
  name: 'audit wsl allow: what a WSL chat\'s allow context is (cwd and project are the ref; no scratch folder)',
  ...T,
  async fn() {
    await withWslChat((_s, _c, ctx) => {
      const x = ctx(EDIT_ABS);
      // fixed: the Linux folder is what paths are checked against; rules stay keyed by the ref; still no scratch folder
      assertEquals([x.cwd, x.project, x.scratch, x.stateDir, !!x.linux], ['/home/u/app', REF, null, null, true]);
    });
  },
});

Deno.test({
  name: 'audit wsl allow (after the fix): with the distro facts an edit inside the WSL project offers Always allow (an edit rule)',
  ...T,
  async fn() {
    await withWslChat(async (aib, c, ctx) => {
      for (const p of [EDIT_ABS, EDIT_REL]) {
        await c.allowPrefetch(p, factsNow());
        const d = aib.allow!.drafts(p, ctx(p)) as unknown as Drafts;
        assertEquals([d.project.available, d.project.hideAgentAlways], [true, true], JSON.stringify(d.project));
        assertEquals((d.project.rules as Json[])[0], { scope: 'project', project: REF, kind: 'edit', folder: 'src', label: 'Edits in src/' });
      }
      assertEquals(aib.allow!.decide(SAFE_READ, ctx(SAFE_READ)).allow, true);
    });
  },
});

Deno.test({
  name: 'KNOWN-BROKEN: audit wsl allow: an edit inside the WSL project offers Always allow (or keeps the agent\'s own Always)',
  ...T,
  async fn() {
    await withWslChat((aib, _c, ctx) => {
      const d = aib.allow!.drafts(EDIT_ABS, ctx(EDIT_ABS)) as unknown as Drafts;
      assert(d.project.available === true || d.project.hideAgentAlways === false, `the user has no Always choice: ${JSON.stringify(d.project)}`);
    });
  },
});

Deno.test({
  name: 'KNOWN-BROKEN: audit wsl allow: the built-in Safe reads answer `git status` in a WSL chat as they do in a Windows chat',
  ...T,
  async fn() {
    await withWslChat((aib, _c, ctx) => {
      const r = aib.allow!.decide(SAFE_READ, ctx(SAFE_READ));
      assert(r.allow, JSON.stringify(r));
    });
  },
});

Deno.test({
  name: 'KNOWN-BROKEN: audit wsl allow: a project MCP rule from a WSL chat is keyed by the ref, not by AIB\'s working folder',
  ...T,
  async fn() {
    await withWslChat((aib, _c, ctx) => {
      const d = aib.allow!.drafts(MCP, ctx(MCP)) as unknown as Drafts;
      assertEquals(d.project.available, true);
      const rule = (d.project.rules as Json[])[0];
      // today: `${Deno.cwd()}\wsl:\ubuntu\home\u\app`
      assertEquals(rule.project, REF, `saved under ${rule.project}`);
    });
  },
});

Deno.test({
  name: 'KNOWN-BROKEN: audit wsl allow: a WSL project rule still applies after AIB starts from another working folder',
  ...T,
  async fn() {
    await withWslChat((aib, _c, ctx) => {
      const d = aib.allow!.drafts(MCP, ctx(MCP)) as unknown as Drafts;
      const rules = (d.project.rules as Json[]).map((r, i) => ({ ...r, id: `r${i}`, added: 1 })) as unknown as AllowRule[];
      assert(match(MCP, { ...ctx(MCP), limitMs: 2000 }, rules, { safeReads: true, syntax: true, scratch: true }).allow, 'applies now');
      const before = Deno.cwd();
      const other = Deno.makeTempDirSync({ prefix: 'aib-wsl-audit-cwd-' });
      try {
        Deno.chdir(other); // the installed AIB.exe and a dev run start in different folders
        assertEquals(rulesHere(rules, REF).length, 1, 'the project rule is lost when the working folder changes');
      } finally {
        Deno.chdir(before);
        Deno.removeSync(other, { recursive: true });
      }
    });
  },
});

Deno.test({
  name: 'KNOWN-BROKEN: audit wsl allow: project rules of /home/u/App do not apply in /home/u/app (Linux paths are case-sensitive)',
  ...T,
  fn() {
    const rule = { id: 'r1', kind: 'mcp', scope: 'project', project: 'wsl://ubuntu/home/u/App', server: 's', tool: 't', label: 'x', added: 1 };
    assertEquals(rulesHere([rule as unknown as AllowRule], REF).length, 0);
  },
});

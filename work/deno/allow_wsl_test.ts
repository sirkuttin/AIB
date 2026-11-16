/**
 * Allow rules in a WSL chat (allow/linux.ts, allow/wsl_facts.ts; audit F1, F3, F6, F9): the matcher checks a WSL chat's paths with
 * Linux rules against its Linux folder, over facts a helper gives. Here the helper answers from a small table of a Linux tree (folders,
 * files, links), resolved with the same physicalRealish the real helper runs, so links, `..` after a link and dangling links behave as
 * the kernel walks them. The real distro is covered by wsl_allow_e2e_test.ts. Temp state folders only.
 */
import { assert, assertEquals } from './_assert.ts';
import { AllowGate } from '../../outputs/agent-studio/server/allow/gate.ts';
import { factsNow, type LinkFs, LinuxFacts, LinuxView, physicalRealish } from '../../outputs/agent-studio/server/allow/linux.ts';
import { type MatchContext, projectKey, rulesHere, sameProject } from '../../outputs/agent-studio/server/allow/matcher.ts';
import { COLLECT_FACTS, prefetch, type WslFactsSource } from '../../outputs/agent-studio/server/allow/wsl_facts.ts';
import type { AllowRule } from '../../outputs/agent-studio/server/allow/matcher.ts';
import type { WslHost } from '../../outputs/agent-studio/server/wsl/contract.ts';

type Json = Record<string, unknown>;
const REF = 'wsl://ubuntu/home/u/app';
const ROOT = '/home/u/app';

/** A Linux tree: folders, files, links (path -> target). */
class Tree {
  dirs = new Set([
    '/',
    '/home',
    '/home/u',
    ROOT,
    `${ROOT}/src`,
    `${ROOT}/lib`,
    '/home/u/App',
    '/home/u/App/src',
    '/etc',
    '/usr',
    '/usr/bin',
    '/tmp',
  ]);
  files = new Set([`${ROOT}/src/main.ts`, '/etc/passwd', `${ROOT}/package.json`, '/home/u/App/src/main.ts']);
  links = new Map<string, string>([[`${ROOT}/out`, '/etc'], [`${ROOT}/src/here`, `${ROOT}/src`], [`${ROOT}/dangling`, '/nowhere/x']]);
  pathDirs: { dir: string; real: string | null }[] = [{ dir: '/usr/bin', real: '/usr/bin' }];
  claude: Json | null = { askPrograms: [], askTools: [], riskyEnv: '' };
  pin = 'pin-1';
  calls = 0;
  down = false;

  /** realpath(3) over the table (links followed, loops refused). */
  #real(path: string, depth = 0): string | null {
    if (depth > 20) return null;
    const parts = path.split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
      const next = `${cur}/${p}`;
      const target = this.links.get(next);
      if (target !== undefined) {
        const r = this.#real(target.startsWith('/') ? target : `${cur}/${target}`, depth + 1);
        if (!r) return null;
        cur = r === '/' ? '' : r;
      } else if (this.dirs.has(next) || this.files.has(next)) cur = next;
      else return null;
    }
    return cur || '/';
  }

  readonly fs: LinkFs = {
    lstat: (path) => (this.links.has(path) ? { link: true } : this.dirs.has(path) || this.files.has(path) ? { link: false } : 'missing'),
    realpath: (path) => this.#real(path),
  };

  answer(params: Json): Json {
    this.calls++;
    const stat = (p: string) => {
      const r = this.#real(p);
      return { exists: !!r && (this.dirs.has(r) || this.files.has(r)), isDir: !!r && this.dirs.has(r) };
    };
    const paths = ((params.paths as string[]) ?? []).map((p) => ({ real: physicalRealish(p, this.fs), ...stat(p) }));
    const scans = ((params.scans as string[]) ?? []).map((d) => [...this.links.keys()].some((l) => l.slice(0, l.lastIndexOf('/')) === d));
    const pins = ((params.pins as unknown[]) ?? []).map(() => this.pin);
    return {
      paths,
      scans,
      pins,
      ...(params.base ? { base: { pathDirs: this.pathDirs, own: ['/home/u/.aib-server'], claude: this.claude } } : {}),
    };
  }

  host(): WslHost {
    return {
      state: 'ready',
      call: (method: string, params: Json) => {
        if (this.down) return Promise.reject(new Error('helper gone'));
        if (method !== 'allow.facts') return Promise.reject(new Error(`no ${method}`));
        return Promise.resolve(this.answer(params));
      },
    } as unknown as WslHost;
  }
}

const OPTIONS = [
  { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
  { optionId: 'yes', kind: 'allow_once', name: 'Yes' },
];
const claudeCall = (tool: string, rawInput: Json, kind = 'other') => ({
  sessionId: 's',
  toolCall: { toolCallId: 't1', kind, rawInput, _meta: { claudeCode: { toolName: tool } } },
  options: OPTIONS,
});
const edit = (path: string) => claudeCall('Edit', { file_path: path, old_string: 'a', new_string: 'b' }, 'edit');
const bash = (command: string) => claudeCall('Bash', { command }, 'execute');

/** One WSL chat in ROOT (project REF) with a gate in a temp state folder, its facts from the tree. */
class Lab {
  readonly dir = Deno.makeTempDirSync({ prefix: 'aib-allow-wsl-' });
  readonly gate = new AllowGate(this.dir);
  readonly facts = new LinuxFacts();
  readonly tree = new Tree();
  cwd = ROOT;
  project = REF;
  constructor() {
    this.gate.store.setEnabled(true);
  }
  src(): WslFactsSource {
    return { host: () => this.tree.host(), cwd: () => this.cwd, claude: true, claudeDir: () => undefined, pathEnv: () => undefined };
  }
  ctx(_params: unknown, since = 0, needs?: LinuxView['opts']['needs']): MatchContext {
    const view = new LinuxView(this.facts, { since, needs: needs ?? null });
    const base = view.base();
    const claude = base?.claude ?? (view.recording ? COLLECT_FACTS : null);
    return {
      provider: 'claude',
      toolName: null,
      mode: null,
      cwd: this.cwd,
      project: this.project,
      scratch: null,
      stateDir: null,
      facts: claude,
      linux: view,
    };
  }
  /** What Connection does for a live request: fetch, then decide with facts no older than the request. */
  async decide(params: unknown) {
    const since = factsNow();
    await prefetch(this.gate, this.facts, this.src(), params, since, (view) => this.ctx(params, since, view.opts.needs));
    return this.gate.decide(params, this.ctx(params, since));
  }
  async drafts(params: unknown) {
    const since = factsNow();
    await prefetch(this.gate, this.facts, this.src(), params, since, (view) => this.ctx(params, since, view.opts.needs));
    return this.gate.drafts(params, this.ctx(params)) as unknown as { project: Json; global: Json };
  }
  /** "Always allow (this project)": save the draft's rules. */
  async always(params: unknown): Promise<Json[]> {
    const d = await this.drafts(params);
    assert(d.project.available === true, JSON.stringify(d.project));
    return (d.project.rules as Json[]).map((r) => this.gate.store.add({ ...r, from: 'card' } as never) as unknown as Json);
  }
  [Symbol.dispose]() {
    Deno.removeSync(this.dir, { recursive: true });
  }
}

Deno.test('allow wsl: an edit inside the project offers Always allow (keyed by the ref); after it a second edit is answered', async () => {
  using lab = new Lab();
  assertEquals((await lab.decide(edit(`${ROOT}/src/main.ts`))).allow, false, 'no rule yet: asks');
  const [rule] = await lab.always(edit(`${ROOT}/src/main.ts`));
  assertEquals([rule.project, rule.folder, rule.kind], [REF, 'src', 'edit']);
  const r = await lab.decide(edit(`${ROOT}/src/new.ts`));
  assert(r.allow, JSON.stringify(r));
  assertEquals((await lab.decide(edit('src/other.ts'))).allow, true, 'a relative path inside the folder');
  assertEquals((await lab.decide(edit(`${ROOT}/package.json`))).allow, false, "outside the rule's folder (src/)");
});

Deno.test('allow wsl: outside the project, `..` escapes, a link out of the project and a dangling link all ask', async () => {
  using lab = new Lab();
  lab.gate.store.add({ kind: 'edit', scope: 'project', project: REF, folder: '', label: 'Edits anywhere in the project', from: 'card' });
  assertEquals((await lab.decide(edit(`${ROOT}/src/x.ts`))).allow, true, 'the rule works');
  for (const p of ['/etc/passwd', '/home/u/other/x.ts', `${ROOT}/../other/x.ts`, 'src/../../x.ts', `${ROOT}/out/passwd`, 'out/x.ts']) {
    const r = await lab.decide(edit(p));
    assertEquals(r.allow, false, `${p}: ${JSON.stringify(r)}`);
  }
  // physically out/.. is /etc/.. = / (lexically it would be the project folder itself)
  assertEquals((await lab.decide(edit('out/../x.ts'))).allow, false, 'a link then ..');
  assertEquals((await lab.decide(edit(`${ROOT}/dangling`))).allow, false, 'writing through a dangling link would create its target');
  assertEquals((await lab.decide(edit(`${ROOT}/src/here/y.ts`))).allow, true, 'a link that stays inside the project');
  assertEquals((await lab.decide(edit(`${ROOT}/.git/config`))).allow, false, 'protected folder');
  const d = await lab.drafts(edit(`${ROOT}/out/passwd`));
  assertEquals([d.project.available, d.project.reason, d.project.hideAgentAlways], [
    false,
    'Not available: AIB never auto-allows files outside the project.',
    true,
  ]);
});

Deno.test('allow wsl: Linux paths are case-sensitive (App and app are different projects and folders)', async () => {
  using lab = new Lab();
  lab.gate.store.add({ kind: 'edit', scope: 'project', project: 'wsl://ubuntu/home/u/App', folder: '', label: 'x', from: 'card' });
  assertEquals((await lab.decide(edit(`${ROOT}/src/main.ts`))).allow, false, "App's rule never applies in app");
  lab.gate.store.add({ kind: 'edit', scope: 'project', project: REF, folder: '', label: 'y', from: 'card' });
  assertEquals((await lab.decide(edit('/home/u/App/src/main.ts'))).allow, false, 'App is outside app');
  assert(!sameProject('wsl://ubuntu/home/u/App', REF) && sameProject('wsl://Ubuntu/home/u/app', REF));
  assert(sameProject('C:\\Work\\App', 'c:\\work\\app'), 'Windows paths still fold case');
  assertEquals(projectKey('wsl://Ubuntu/home/u/app'), REF);
});

Deno.test('allow wsl: commands inside and outside the folder; built-in Safe reads; globs over links', async () => {
  using lab = new Lab();
  for (const c of ['git status', 'ls', 'ls src', 'cat src/main.ts', 'grep -rn foo src', 'git log --oneline -5', 'ls lib/*.ts']) {
    const r = await lab.decide(bash(c));
    assert(r.allow && r.label === 'Safe reads', `${c}: ${JSON.stringify(r)}`);
  }
  for (
    const c of [
      'ls /etc',
      'cat out/passwd',
      'cat ../other/x',
      'ls *.json',
      'ls src/*.ts',
      'cat ~/.bashrc',
      'rm src/main.ts',
      'ls ~/.aib-server',
    ]
  ) {
    const r = await lab.decide(bash(c));
    assertEquals(r.allow, false, `${c}: ${JSON.stringify(r)}`);
  }
  // a command rule: drafted and pinned in the distro, then the next run is answered; a changed script asks again
  const [rule] = await lab.always(bash('npm run lint'));
  assertEquals([rule.project, rule.words, rule.pins], [REF, ['npm', 'run', 'lint'], { [REF]: 'pin-1' }]);
  assertEquals((await lab.decide(bash('npm run lint'))).allow, true);
  lab.tree.pin = 'pin-2';
  assertEquals((await lab.decide(bash('npm run lint'))).allow, false, 'the script changed');
  // a PowerShell request in a WSL chat has no rules
  assertEquals((await lab.decide(claudeCall('PowerShell', { command: 'Get-ChildItem' }, 'execute'))).allow, false);
});

Deno.test('allow wsl: a folder on PATH inside the project, the Claude settings facts and a helper that cannot answer all ask', async () => {
  {
    using lab = new Lab();
    lab.tree.pathDirs = [{ dir: `${ROOT}/bin`, real: `${ROOT}/bin` }, { dir: '/usr/bin', real: '/usr/bin' }];
    assertEquals((await lab.decide(bash('git status'))).allow, false, 'a git in the project could run');
  }
  {
    using lab = new Lab();
    lab.tree.pathDirs = [{ dir: '/home/u/bin', real: `${ROOT}/bin` }];
    assertEquals((await lab.decide(bash('git status'))).allow, false, 'a PATH folder that links into the project');
  }
  {
    using lab = new Lab();
    lab.tree.claude = { askPrograms: [], askTools: ['edit'], riskyEnv: '' };
    lab.gate.store.add({ kind: 'edit', scope: 'project', project: REF, folder: '', label: 'x', from: 'card' });
    assertEquals(await lab.decide(edit(`${ROOT}/src/x.ts`)), { allow: false, reason: 'your Claude settings ask before edits' });
    lab.tree.claude = { askPrograms: [], askTools: [], riskyEnv: '/home/u/.claude/settings.json sets PATH' };
    assertEquals((await lab.decide(edit(`${ROOT}/src/x.ts`))).allow, false);
  }
  {
    using lab = new Lab();
    lab.tree.claude = null; // the distro's Claude settings could not be read
    const d = await lab.drafts(edit(`${ROOT}/src/x.ts`));
    assertEquals([d.project.available, d.project.hideAgentAlways], [false, false], "AIB cannot match: the agent's own Always stays");
    assertEquals((await lab.decide(bash('git status'))).allow, false);
  }
  {
    using lab = new Lab();
    lab.tree.down = true;
    assertEquals((await lab.decide(bash('git status'))).allow, false, 'no facts: asks');
    const d = lab.gate.drafts(edit(`${ROOT}/src/x.ts`), lab.ctx(edit(`${ROOT}/src/x.ts`))) as unknown as { project: Json };
    assertEquals([d.project.available, d.project.hideAgentAlways], [false, false]);
  }
});

Deno.test('allow wsl: facts older than the request count as unknown for a decision', async () => {
  using lab = new Lab();
  assertEquals((await lab.decide(bash('git status'))).allow, true);
  const later = factsNow() + 1000;
  assertEquals(lab.gate.decide(bash('git status'), lab.ctx(bash('git status'), later)).allow, false, 'stale facts never allow');
});

Deno.test('allow wsl: a rule saved in a WSL chat is keyed by the ref and still applies after AIB starts in another folder', () => {
  const rule = {
    id: 'r',
    kind: 'mcp',
    scope: 'project',
    project: REF,
    server: 's',
    tool: 't',
    label: 'x',
    added: 1,
  } as unknown as AllowRule;
  const before = Deno.cwd();
  const other = Deno.makeTempDirSync({ prefix: 'aib-allow-wsl-cwd-' });
  try {
    Deno.chdir(other);
    assertEquals(rulesHere([rule], REF).length, 1);
    assertEquals(rulesHere([rule], 'wsl://ubuntu/home/u/app2').length, 0);
    // beta10 saved it under AIB's working folder: still found for its project, never for another
    const legacy = { ...rule, project: 'C:\\Users\\x\\agent-studio\\wsl:\\ubuntu\\home\\u\\app' } as AllowRule;
    assertEquals([rulesHere([legacy], REF).length, rulesHere([legacy], 'wsl://ubuntu/home/u/App').length], [1, 0]);
  } finally {
    Deno.chdir(before);
    Deno.removeSync(other, { recursive: true });
  }
});

Deno.test('physicalRealish: links followed, `..` after a link taken physically, missing tails kept, unsafe forms refused', () => {
  const t = new Tree();
  const r = (p: string) => physicalRealish(p, t.fs);
  assertEquals(r(`${ROOT}/src/main.ts`), `${ROOT}/src/main.ts`);
  assertEquals(r(`${ROOT}/src/new/dir/x.ts`), `${ROOT}/src/new/dir/x.ts`);
  assertEquals(r(`${ROOT}/out/passwd`), '/etc/passwd');
  assertEquals(r(`${ROOT}/out/../x`), '/x');
  assertEquals(r(`${ROOT}/src/../package.json`), `${ROOT}/package.json`);
  assertEquals(r(`${ROOT}/src/here/./main.ts`), `${ROOT}/src/main.ts`);
  assertEquals(r(`${ROOT}/dangling`), null);
  assertEquals(r(`${ROOT}/missing/../x`), null);
  assertEquals(r(`${ROOT}/src/main.ts/x`), `${ROOT}/src/main.ts/x`, 'the table has no ENOTDIR; the real helper refuses it');
  assertEquals(r('relative/x'), null);
  assertEquals(r('/'), '/');
});

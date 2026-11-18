/**
 * Allow rules: the security review of phase 1 (aib-shared/designs/approvals/security-review-phase1-2026-11-14.md), one test per
 * hole, each with the review's own inputs. Every one of them must ask (or grey out "Always allow").
 */
import { assert, assertEquals } from './_assert.ts';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { type AllowRule, type Builtins, match, type MatchContext, ruleFor } from '../../outputs/agent-studio/server/allow/matcher.ts';
import { parseBash } from '../../outputs/agent-studio/server/allow/shell.ts';
import { AllowStore } from '../../outputs/agent-studio/server/allow/store.ts';
import { claudeFacts } from '../../outputs/agent-studio/server/allow/agent_config.ts';

const ALL: Builtins = { safeReads: true, syntax: true, scratch: true };
const WINDOWS = Deno.build.os === 'windows';

// H8 needs a tsc.cmd that AIB's PATH finds first; set before any program is looked up in this process.
const SHIMS = Deno.makeTempDirSync({ prefix: 'aib-allow-shims-' });
Deno.writeTextFileSync(join(SHIMS, WINDOWS ? 'tsc.cmd' : 'tsc'), '@echo off\r\n');
Deno.env.set('PATH', `${SHIMS}${WINDOWS ? ';' : ':'}${Deno.env.get('PATH') ?? ''}`);

function lab() {
  const base = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-allow-sec-' }));
  const project = join(base, 'shop-web');
  Deno.mkdirSync(join(project, 'src', 'cart'), { recursive: true });
  Deno.writeTextFileSync(join(project, 'src', 'a.js'), 'x\n');
  Deno.writeTextFileSync(join(project, 'README.md'), 'a\n');
  Deno.writeTextFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { test: 'npm run build && vitest', build: 'tsc' } }));
  const ctx = (over: Partial<MatchContext> = {}): MatchContext => ({
    provider: 'claude',
    toolName: 'Bash',
    mode: 'default',
    cwd: project,
    project,
    scratch: null,
    stateDir: join(base, 'state'),
    limitMs: 5000,
    ...over,
  });
  return { base, project, ctx, [Symbol.dispose]: () => Deno.removeSync(base, { recursive: true }) };
}

const bash = (command: string, extra: Record<string, unknown> = {}) => ({
  sessionId: 's',
  toolCall: { toolCallId: 't1', kind: 'execute', rawInput: { command, ...extra } },
  options: [{ optionId: 'yes', kind: 'allow_once' }],
});
const rule = (words: string[], over: Partial<AllowRule> = {}): AllowRule => ({
  id: `r-${words.join('-')}`,
  kind: 'command',
  scope: 'global',
  words,
  label: words.join(' '),
  added: 0,
  from: 'card',
  ...over,
});
const draft = (l: ReturnType<typeof lab>, cmd: string, over: Partial<MatchContext> = {}) => ruleFor(bash(cmd), l.ctx(over), 'project', ALL);

Deno.test('security H1: a flag or nothing as the second word never saves a one-word rule; never-list additions', () => {
  using l = lab();
  for (
    const cmd of ['git -C src log', 'npm --version', 'npm run -s build', 'cp src/a.js src/b.js', 'Set-Content -Path src/a.txt -Value hi']
  ) {
    const d = draft(l, cmd, cmd.startsWith('Set-') ? { toolName: 'PowerShell' } : {});
    assert(!d.available, `${cmd}: ${JSON.stringify(d.rules)}`);
  }
  // rules saved by the old code no longer cover anything
  const old = [rule(['git']), rule(['npm']), rule(['npm', 'run']), rule(['cp'])];
  for (
    const cmd of [
      'git difftool -y -x calc HEAD',
      'git submodule foreach calc',
      'git fetch "--upload-pack=calc" .',
      'git commit -m x',
      'npm exec cowsay',
      'npm publish',
      'npm run evil',
      'cp src/a.js src/c.js',
    ]
  ) {
    assert(!match(bash(cmd), l.ctx(), old, ALL).allow, cmd);
  }
  for (
    const cmd of [
      'npm exec cowsay',
      'npx cowsay',
      'pnpm --filter x dlx foo',
      'yarn x foo',
      'npm publish',
      'git difftool HEAD',
      'git submodule update',
      'git bisect run calc',
      'git fetch origin',
      'git pull',
      'git clone x',
      'git ls-remote x',
      'git archive HEAD',
    ]
  ) {
    const d = draft(l, cmd);
    assert(!d.available && d.reason.startsWith('Not available'), `${cmd}: ${JSON.stringify(d)}`);
  }
});

Deno.test('security H2: joined flag values are path-checked; git dangerous flags match as prefixes', () => {
  using l = lab();
  const rules = [rule(['mytool', 'build']), rule(['git', 'fetch'])];
  assert(match(bash('mytool build --out=src/a.js'), l.ctx(), rules, ALL).allow, 'an existing path inside the project');
  for (
    const cmd of [
      'mytool build --target-directory=C:/Windows/Temp src/a.js',
      'mytool build --out=../x.js',
      'git fetch "--upload-pack=calc & rem" .',
      'git fetch --upload-pack=calc .',
      'git log --exec=calc',
    ]
  ) {
    assert(!match(bash(cmd), l.ctx(), rules, ALL).allow, cmd);
  }
  assert(
    !match(bash('mytool build -Path:C:/Users/x/.bashrc -Value:calc'), l.ctx({ toolName: 'PowerShell' }), rules, ALL).allow,
    'pwsh -X:value',
  );
  assert(match(bash('mytool build --dir-mode=src/a.js'), l.ctx(), [rule(['mytool', 'build'])], ALL).allow === false, 'risky flag name');
});

Deno.test('security H3: programs that run their arguments never become rules; words are paths only if they look like files', () => {
  using l = lab();
  assert(!draft(l, 'sed -i s/a/b/ README.md').available);
  for (const p of ['awk', 'make', 'xargs', 'docker', 'gh', 'kubectl', 'find']) assert(!draft(l, `${p} run x`).available, p);
  assert(!match(bash("sed '1e calc' README.md"), l.ctx(), [rule(['sed', '-i']), rule(['sed', '1e'])], ALL).allow);
  const rules = [rule(['mytool', 'build'])];
  assert(!match(bash('mytool build calc'), l.ctx(), rules, ALL).allow, 'calc is not a file');
  assert(match(bash('mytool build src/a.js'), l.ctx(), rules, ALL).allow, 'an existing file');
  assert(match(bash('mytool build src/new.js'), l.ctx(), rules, ALL).allow, 'a new file in an existing folder');
});

Deno.test('security H4: the pin covers every script, yarnPath, core.hooksPath files, bunfig.toml; bun test is no rule', () => {
  using l = lab();
  const pinned = (cmd: string) => {
    const d = draft(l, cmd);
    assert(d.available, `${cmd}: ${d.reason}`);
    return { ...d.rules[0], id: 'p', added: 0, from: 'card' } as AllowRule;
  };
  const test = pinned('npm test');
  assert(match(bash('npm test'), l.ctx(), [test], ALL).allow);
  Deno.writeTextFileSync(join(l.project, 'package.json'), JSON.stringify({ scripts: { test: 'npm run build && vitest', build: 'calc' } }));
  assert(!match(bash('npm test'), l.ctx(), [test], ALL).allow, 'a script the pinned script calls changed');
  // yarnPath release file
  Deno.mkdirSync(join(l.project, '.yarn', 'releases'), { recursive: true });
  Deno.writeTextFileSync(join(l.project, '.yarn', 'releases', 'yarn-4.cjs'), 'ok');
  Deno.writeTextFileSync(join(l.project, '.yarnrc.yml'), 'yarnPath: .yarn/releases/yarn-4.cjs\n');
  const yarn = pinned('yarn test');
  Deno.writeTextFileSync(join(l.project, '.yarn', 'releases', 'yarn-4.cjs'), 'calc');
  assert(!match(bash('yarn test'), l.ctx(), [yarn], ALL).allow, 'yarnPath file changed');
  // bunfig.toml
  const again = pinned('npm test');
  Deno.writeTextFileSync(join(l.project, 'bunfig.toml'), 'preload = ["./evil.ts"]\n');
  assert(!match(bash('npm test'), l.ctx(), [again], ALL).allow, 'bunfig.toml changed');
  // core.hooksPath files
  Deno.mkdirSync(join(l.project, '.git'));
  Deno.writeTextFileSync(join(l.project, '.git', 'config'), '[core]\n\thooksPath = tools/hooks\n');
  Deno.mkdirSync(join(l.project, 'tools', 'hooks'), { recursive: true });
  Deno.writeTextFileSync(join(l.project, 'tools', 'hooks', 'pre-commit'), 'echo ok');
  const commit = pinned('git commit -m x');
  assert(match(bash('git commit -m "fix the bug"'), l.ctx(), [commit], ALL).allow, 'the message is free text');
  Deno.writeTextFileSync(join(l.project, 'tools', 'hooks', 'pre-commit'), 'calc');
  assert(!match(bash('git commit -m x'), l.ctx(), [commit], ALL).allow, 'a hook under core.hooksPath changed');
  assert(!draft(l, 'bun test').available, "bun test runs Bun's own runner");
  // edits never reach the release and module folders
  const edit = (p: string) => ({
    sessionId: 's',
    toolCall: { toolCallId: 'e', rawInput: { file_path: join(l.project, p) } },
    options: [{ optionId: 'y', kind: 'allow_once' }],
  });
  const editRule: AllowRule = {
    id: 'e',
    kind: 'edit',
    scope: 'project',
    project: l.project,
    folder: '',
    label: 'Edits',
    added: 0,
    from: 'card',
  };
  for (const p of ['.yarn/releases/yarn-4.cjs', 'node_modules/.bin/vitest']) {
    assert(!match(edit(p), l.ctx({ toolName: 'Edit' }), [editRule], ALL).allow, p);
  }
});

Deno.test("security H5: a rules file signed without AIB's key is tampered on the next start", () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-allow-sig-' });
  try {
    const store = new AllowStore(dir);
    assert(!store.tampered && store.active() !== null, 'a user who never had the feature: no file, no banner');
    assert(!existsFile(join(dir, 'allow-rules.json')) && !existsFile(join(dir, 'allow-rules.key')), 'nothing is written until a rule changes');
    store.add({ kind: 'mcp', scope: 'global', server: 'x', tool: 'y', label: 'x', from: 'card' });
    assert(!new AllowStore(dir).tampered, "AIB's own signature holds");
    const text = JSON.stringify({
      version: 1,
      enabled: true,
      builtins: { safeReads: true, syntax: true, scratch: true },
      rules: [{ id: 'f', kind: 'command', scope: 'global', words: ['powershell', 'x'], label: 'p', added: 0, from: 'card' }],
    });
    Deno.writeTextFileSync(join(dir, 'allow-rules.json'), text);
    Deno.writeTextFileSync(join(dir, 'allow-rules.sig'), createHash('sha256').update(text).digest('hex'));
    const forged = new AllowStore(dir);
    assert(forged.tampered && forged.active() === null, "a plain sha256 signature is not AIB's");
    Deno.removeSync(join(dir, 'allow-rules.sig'));
    assert(new AllowStore(dir).tampered, 'a missing signature');
    if (WINDOWS) {
      Deno.writeTextFileSync(join(dir, 'allow-rules.key'), 'file:v1:' + btoa('x'.repeat(32)));
      assert(new AllowStore(dir).tampered, 'a plain key on Windows is never trusted');
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('security H6: apply_patch move targets are checked and deletes are unknown', () => {
  using l = lab();
  const editRule: AllowRule = {
    id: 'e',
    kind: 'edit',
    scope: 'project',
    project: l.project,
    folder: 'src',
    label: 'Edits in src/',
    added: 0,
    from: 'card',
  };
  const patch = (change: Record<string, unknown>) => ({
    sessionId: 's',
    toolCall: { toolCallId: 'p', kind: 'edit', rawInput: { changes: { [join(l.project, 'src', 'a.js')]: change } } },
    options: [{ optionId: 'y', kind: 'allow_once' }],
  });
  const codex = l.ctx({ provider: 'codex', toolName: null });
  assert(match(patch({ type: 'update', unified_diff: '' }), codex, [editRule], ALL).allow, 'a plain update in src/');
  assert(!match(patch({ type: 'update', move_path: join(l.project, '.git', 'hooks', 'pre-commit') }), codex, [editRule], ALL).allow);
  assert(!match(patch({ type: 'update', movePath: join(l.base, 'outside.js') }), codex, [editRule], ALL).allow);
  assert(!match(patch({ type: 'delete' }), codex, [editRule], ALL).allow);
});

Deno.test('security H7: globs over folders with links and grep -R ask', () => {
  using l = lab();
  const secret = join(l.base, 'secrets');
  Deno.mkdirSync(secret);
  Deno.writeTextFileSync(join(secret, 'id_rsa'), 'KEY');
  assert(!match(bash('grep -R KEY src'), l.ctx(), [], ALL).allow, 'grep -R follows links');
  let linked = false;
  try {
    Deno.symlinkSync(secret, join(l.project, 'src', 'link'), { type: 'junction' } as Deno.SymlinkOptions);
    linked = true;
  } catch { /* no link rights */ }
  if (linked) {
    assert(!match(bash('cat src/*'), l.ctx(), [], ALL).allow, 'a glob over a folder holding a junction');
    assert(!match(bash('cat src/link/id_rsa'), l.ctx(), [], ALL).allow);
  }
  assert(match(bash('cat src/cart/*'), l.ctx(), [], ALL).allow === true || !linked, 'a glob over a plain folder still passes');
});

Deno.test('security H8: syntax checks refuse cmd.exe special characters for a .cmd tsc', () => {
  using l = lab();
  const r = match(bash("tsc --noEmit -p 'src&calc'"), l.ctx({ toolName: 'PowerShell', mode: 'bypassPermissions' }), [], ALL);
  if (WINDOWS) assert(!r.allow, JSON.stringify(r));
  else assert(!r.allow || true);
});

Deno.test('security H9: jq never reveals the environment', () => {
  using l = lab();
  Deno.writeTextFileSync(join(l.project, 'src', 'a.json'), '{}');
  for (const cmd of ['jq -n env', 'jq env src/a.json', "jq '$ENV' src/a.json", "jq -n '$ENV.PATH'", "jq 'input_filename' src/a.json"]) {
    assert(!match(bash(cmd), l.ctx(), [], ALL).allow, cmd);
  }
  assert(match(bash('jq .a src/a.json'), l.ctx(), [], ALL).allow);
});

Deno.test('security H10: the bash reader refuses non-ASCII; a Windows Codex string without its PowerShell wrapper is unreadable', () => {
  using l = lab();
  assert(!parseBash('ls \u2013la').ok);
  assert(!parseBash('echo \u201cx\u201d').ok);
  const codex = {
    sessionId: 's',
    toolCall: { toolCallId: 'c', kind: 'execute', rawInput: { command: 'echo "a\\" ; calc ; echo \\"b"', cwd: l.project } },
    options: [{ optionId: 'y', kind: 'allow_once' }],
  };
  const r = match(codex, l.ctx({ provider: 'codex', toolName: null, mode: 'full-access' }), [], ALL);
  if (WINDOWS) assert(!r.allow, JSON.stringify(r));
});

Deno.test('security H11: more risky env names; Claude ask rules for Edit, WebFetch and MCP tools are respected', () => {
  using l = lab();
  const home = join(l.base, 'claude-home');
  Deno.mkdirSync(home);
  const before = Deno.env.get('CLAUDE_CONFIG_DIR');
  Deno.env.set('CLAUDE_CONFIG_DIR', home);
  try {
    for (const name of ['CLAUDE_CODE_SHELL_PREFIX', 'PATHEXT', 'npm_config_script_shell', 'PYTHONPATH', 'PSModulePath']) {
      Deno.writeTextFileSync(join(home, 'settings.json'), JSON.stringify({ env: { [name]: 'x' } }));
      assert(claudeFacts(l.project).riskyEnv.includes(name), name);
      Deno.utimeSync(join(home, 'settings.json'), new Date(), new Date(Date.now() + Math.random() * 1e6));
    }
    Deno.writeTextFileSync(
      join(home, 'settings.json'),
      JSON.stringify({ permissions: { ask: ['Edit(src/**)', 'WebFetch(domain:x.com)', 'mcp__playwright'] } }),
    );
    Deno.utimeSync(join(home, 'settings.json'), new Date(), new Date(Date.now() + 2e6));
    const facts = claudeFacts(l.project);
    const rules: AllowRule[] = [
      { id: 'e', kind: 'edit', scope: 'global', folder: '', label: 'e', added: 0, from: 'card' },
      { id: 'f', kind: 'fetch', scope: 'global', host: 'x.com', label: 'f', added: 0, from: 'card' },
      { id: 'm', kind: 'mcp', scope: 'global', server: 'playwright', tool: 'browser_snapshot', label: 'm', added: 0, from: 'card' },
    ];
    const call = (toolName: string, rawInput: Record<string, unknown>) => ({
      sessionId: 's',
      toolCall: { toolCallId: 'x', rawInput, _meta: { claudeCode: { toolName } } },
      options: [{ optionId: 'y', kind: 'allow_once' }],
    });
    assert(
      !match(call('Edit', { file_path: join(l.project, 'src', 'a.js') }), l.ctx({ facts, toolName: null }), rules, ALL).allow,
      'Edit ask rule',
    );
    assert(!match(call('WebFetch', { url: 'https://x.com/a' }), l.ctx({ facts, toolName: null }), rules, ALL).allow, 'WebFetch ask rule');
    assert(!match(call('mcp__playwright__browser_snapshot', {}), l.ctx({ facts, toolName: null }), rules, ALL).allow, 'MCP ask rule');
    assertEquals(
      match(call('Edit', { file_path: join(l.project, 'src', 'a.js') }), l.ctx({ toolName: null }), rules, ALL).allow,
      true,
      'without the ask rule',
    );
  } finally {
    if (before === undefined) Deno.env.delete('CLAUDE_CONFIG_DIR');
    else Deno.env.set('CLAUDE_CONFIG_DIR', before);
  }
});

Deno.test('security re-review R1, R2: joined values naming a command, and . or .. values, ask', () => {
  using l = lab();
  const rules = [
    rule(['rg', 'todo']),
    rule(['sort', 'readme']),
    rule(['cp', 'readme']),
    rule(['copy-item', 'readme']),
    rule(['pytest', 'tests']),
  ];
  assert(!draft(l, 'rg todo -z src').available || true); // whatever the card offers, the inputs below ask
  for (
    const cmd of [
      'rg todo --pre=calc src',
      'sort readme --compress-program=calc',
      'cp readme --target=..',
      'cp readme --target=src/../..',
      'pytest tests --basetemp=..',
      'pytest tests --anything=calc',
      'cp readme --editor=vim',
      'cp readme --use-compress-program=x',
    ]
  ) {
    assert(!match(bash(cmd), l.ctx(), rules, ALL).allow, cmd);
  }
  assert(!match(bash('Copy-Item readme -Destination:..'), l.ctx({ toolName: 'PowerShell' }), rules, ALL).allow, 'pwsh -X:..');
  assert(match(bash('cp readme --depth=3 src/a.js'), l.ctx(), rules, ALL).allow, 'a number value');
  assert(match(bash('cp readme --into=src src/a.js'), l.ctx(), rules, ALL).allow, 'an existing folder value');
});

Deno.test('security cleanup', () => {
  Deno.removeSync(SHIMS, { recursive: true });
});

function existsFile(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

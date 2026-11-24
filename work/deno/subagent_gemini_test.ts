/**
 * Subagent worktrees, Gemini part (server/subagents/gemini.ts), without an agent. The real Gemini CLI end to end is
 * work/deno/e2e_gemini_subagent_test.ts.
 *   the fence: per subagent name, the policy denies write_file/replace outside the chat's subagent folder (and any `..`), always
 *     the shell and MCP tools; matched the way Gemini 0.68 matches (its argsPattern RegExp over the stable JSON of the arguments)
 *   sign-in: only an API key with no other method picked gets the redirect; a Google login gets the fence only
 *   the hook's path move: relative and folder paths go into the worktree; anything outside, or climbing out with `..`, is refused
 *   the chat home: links the user's folders, copies files, never writes the user's folder, and unlinks before it is removed
 *   ownSubagentPath accepts a Gemini chat's .gem-<chat>/sub-* worktree (so landing can release it), and nothing else new
 */
import { assert, assertEquals } from './_assert.ts';
import {
  agentNames,
  agentOfTitle,
  buildHome,
  geminiAuth,
  mergedSettings,
  parseJsonc,
  policyToml,
  relativeInside,
  removeHome,
} from '../../app/server/subagents/gemini.ts';
import { ownSubagentPath } from '../../app/server/subagents/service.ts';
import { join } from '../../app/server/platform/path.ts';

const WIN = Deno.build.os === 'windows';

/** Gemini's stableStringify for flat arguments: keys sorted, JSON.stringify values, no spaces. */
function stable(args: Record<string, unknown>): string {
  return '{' + Object.keys(args).sort().map((k) => JSON.stringify(k) + ':' + JSON.stringify(args[k])).join(',') + '}';
}

/** The rules of a policy file, parsed just enough: toolName(s), subagent, argsPattern, decision. */
function rules(toml: string): { tools: string[]; subagent: string; pattern: RegExp | null }[] {
  const out: { tools: string[]; subagent: string; pattern: RegExp | null }[] = [];
  for (const block of toml.split('[[rule]]').slice(1)) {
    const value = (key: string) => {
      const m = new RegExp(`^${key} = (.*)$`, 'm').exec(block);
      return m ? m[1] : null;
    };
    const unq = (s: string) => JSON.parse(s); // TOML basic strings are JSON strings for what AIB writes
    const tool = value('toolName')!;
    const tools = tool.startsWith('[') ? JSON.parse(tool) : [unq(tool)];
    const p = value('argsPattern');
    assertEquals(unq(value('decision')!), 'deny');
    out.push({ tools, subagent: unq(value('subagent')!), pattern: p ? new RegExp(unq(p)) : null });
  }
  return out;
}

function denied(toml: string, subagent: string, tool: string, args: Record<string, unknown>): boolean {
  return rules(toml).some((r) => r.subagent === subagent && r.tools.includes(tool) && (!r.pattern || r.pattern.test(stable(args))));
}

Deno.test('the fence denies a subagent edit outside its folder, and the shell and MCP tools always', () => {
  const sub = WIN ? 'C:\\st\\worktrees\\abc123\\.gem-c1' : '/st/worktrees/abc123/.gem-c1';
  const sep = WIN ? '\\' : '/';
  const toml = policyToml(['generalist', 'my-agent'], sub);
  for (const name of ['generalist', 'my-agent']) {
    assert(denied(toml, name, 'write_file', { file_path: 'sub.txt', content: 'x' }), 'relative');
    assert(denied(toml, name, 'replace', { file_path: WIN ? 'C:\\proj\\a.ts' : '/proj/a.ts', old_string: 'a', new_string: 'b' }), 'project');
    assert(!denied(toml, name, 'write_file', { file_path: `${sub}${sep}sub-c1-1${sep}sub.txt`, content: 'x' }), 'its worktree');
    assert(denied(toml, name, 'write_file', { file_path: `${sub}${sep}sub-c1-1${sep}..${sep}..${sep}x.txt`, content: 'x' }), 'dotdot');
    assert(denied(toml, name, 'write_file', { file_path: `${sub}x${sep}sub-c1-1${sep}a.txt`, content: 'x' }), 'a sibling folder');
    assert(denied(toml, name, 'run_shell_command', { command: 'echo hi' }), 'shell');
    assert(rules(toml).some((r) => r.subagent === name && r.tools.includes('mcp_*')), 'mcp');
  }
  assert(!denied(toml, 'other', 'write_file', { file_path: 'sub.txt' }), 'rules are per subagent name; the parent has none');
  const off = policyToml(['generalist'], null);
  assert(denied(off, 'generalist', 'write_file', { file_path: `${sub}${sep}sub-c1-1${sep}sub.txt` }), 'no redirect: every edit denied');
});

Deno.test('only an API-key sign-in gets the redirect', () => {
  assertEquals(geminiAuth({ GEMINI_API_KEY: 'k' }, {}), 'api-key');
  assertEquals(geminiAuth({ GEMINI_API_KEY: 'k' }, { security: { auth: { selectedType: 'gemini-api-key' } } }), 'api-key');
  assertEquals(geminiAuth({ GEMINI_API_KEY: 'k' }, { security: { auth: { selectedType: 'oauth-personal' } } }), 'google-login');
  assertEquals(geminiAuth({}, {}), 'google-login');
  assertEquals(geminiAuth({}, { selectedAuthType: 'gemini-api-key' }), 'google-login', 'a method with no key in the environment');
});

Deno.test('settings with comments parse; AIB adds its hook after the user’s own', () => {
  const s = parseJsonc('{\n // a comment\n "hooks": {"BeforeTool": [{"matcher": "x", "hooks": []}]}, /* b */ "a": "http://x",\n}') as Record<string, unknown>;
  assertEquals(s.a, 'http://x');
  const merged = mergedSettings(s, 'cmd', { AIB_HOOK_KEY: 'k', AIB_HOOK_CHAT: 'c' }) as { hooks: { BeforeTool: { matcher: string; hooks: { env: unknown }[] }[] } };
  assertEquals(merged.hooks.BeforeTool.length, 2);
  assertEquals(merged.hooks.BeforeTool[1].matcher, 'write_file|replace');
  assertEquals(merged.hooks.BeforeTool[1].hooks[0].env, { AIB_HOOK_KEY: 'k', AIB_HOOK_CHAT: 'c' });
  assertEquals((s.hooks as { BeforeTool: unknown[] }).BeforeTool.length, 1, 'the user’s object is not changed');
  assertEquals(agentOfTitle("Delegating to agent 'generalist'"), 'generalist');
});

Deno.test('the hook moves folder paths into the worktree and refuses the rest', () => {
  const folder = WIN ? 'C:\\proj' : '/proj';
  const wtp = WIN ? 'C:\\st\\worktrees\\abc\\.gem-c\\sub-c-1' : '/st/worktrees/abc/.gem-c/sub-c-1';
  const j = (...p: string[]) => p.join(WIN ? '\\' : '/');
  assertEquals(relativeInside('src/a.ts', folder, wtp), ['src', 'a.ts']);
  assertEquals(relativeInside(j(folder, 'src', 'a.ts'), folder, wtp), ['src', 'a.ts']);
  assertEquals(relativeInside(j(wtp, 'b.ts'), folder, wtp), ['b.ts']);
  if (WIN) assertEquals(relativeInside('c:/PROJ/x.txt', folder, wtp), ['x.txt'], 'case and slashes');
  assertEquals(relativeInside('../x.txt', folder, wtp), null);
  assertEquals(relativeInside(j(folder, '..', 'x.txt'), folder, wtp), null);
  assertEquals(relativeInside(WIN ? 'D:\\other\\x.txt' : '/other/x.txt', folder, wtp), null);
  assertEquals(relativeInside(folder, folder, wtp), null);
  assertEquals(relativeInside('', folder, wtp), null);
});

Deno.test('the chat home links folders, copies files and never writes the user’s folder', () => {
  const temp = Deno.makeTempDirSync({ prefix: 'aib-gem-home-', dir: Deno.env.get('TEMP') ?? undefined });
  try {
    const real = join(temp, 'user');
    Deno.mkdirSync(join(real, '.gemini', 'tmp', 'proj'), { recursive: true });
    Deno.mkdirSync(join(real, '.gemini', 'agents'), { recursive: true });
    Deno.writeTextFileSync(join(real, '.gemini', 'agents', 'helper.md'), '---\nname: my-helper\n---\nhi');
    Deno.writeTextFileSync(join(real, '.gemini', 'settings.json'), '{"x": 1}');
    Deno.writeTextFileSync(join(real, '.gemini', 'projects.json'), '{"projects": {}}');
    Deno.writeTextFileSync(join(real, '.gemini', 'tmp', 'proj', 'chat.json'), 'history');
    const before = Deno.readTextFileSync(join(real, '.gemini', 'settings.json'));
    const home = join(temp, 'home');
    buildHome(home, real, { x: 1, hooks: {} }, join(temp, 'shared'));
    assertEquals(Deno.readTextFileSync(join(home, '.gemini', 'tmp', 'proj', 'chat.json')), 'history', 'history shared through the link');
    assert(Deno.lstatSync(join(home, '.gemini', 'tmp')).isSymlink, 'a folder is a link');
    assert(!Deno.lstatSync(join(home, '.gemini', 'projects.json')).isSymlink, 'a file is a copy');
    Deno.writeTextFileSync(join(home, '.gemini', 'projects.json'), 'changed');
    assertEquals(Deno.readTextFileSync(join(real, '.gemini', 'projects.json')), '{"projects": {}}', 'a copy is never written back');
    assertEquals(Deno.readTextFileSync(join(real, '.gemini', 'settings.json')), before);
    assert(agentNames(temp, real).includes('my-helper'), 'custom agents are fenced by name');
    removeHome(home);
    assertEquals(Deno.readTextFileSync(join(real, '.gemini', 'tmp', 'proj', 'chat.json')), 'history', 'removing the home never empties the target');
    // no ~/.gemini yet: tmp and history go to AIB's shared folder
    const bare = join(temp, 'bare');
    buildHome(join(temp, 'home2'), bare, {}, join(temp, 'shared'));
    assert(Deno.lstatSync(join(temp, 'home2', '.gemini', 'tmp')).isSymlink);
    removeHome(join(temp, 'home2'));
    assert(Deno.statSync(join(temp, 'shared', 'tmp')).isDirectory);
  } finally {
    Deno.removeSync(temp, { recursive: true });
  }
});

Deno.test('a Gemini chat’s worktree is AIB’s own path; other nestings are not', () => {
  const temp = Deno.makeTempDirSync({ prefix: 'aib-gem-own-', dir: Deno.env.get('TEMP') ?? undefined });
  try {
    const root = join(temp, 'worktrees');
    const gem = join(root, 'abc123', '.gem-c1', 'sub-c1-1');
    Deno.mkdirSync(gem, { recursive: true });
    assert(ownSubagentPath(root, { path: gem }));
    assert(ownSubagentPath(root, { path: join(root, 'abc123', 'sub-x-1') }), 'the Claude layout still holds (gone: record only)');
    assert(!ownSubagentPath(root, { path: join(root, 'abc123', 'other', 'sub-c1-1') }), 'any other middle folder');
    assert(!ownSubagentPath(root, { path: join(root, 'abc123', '.gem-c1') }));
  } finally {
    Deno.removeSync(temp, { recursive: true });
  }
});

Deno.test('a taken-over chat gets its setup back; the start sweep removes only folders no chat uses', async () => {
  const { restore, sweep, idsInArgs, policyToml: _p } = await import('../../app/server/subagents/gemini.ts');
  const temp = Deno.makeTempDirSync({ prefix: 'aib-gem-sweep-', dir: Deno.env.get('TEMP') ?? undefined });
  try {
    const state = join(temp, 'state'), root = join(state, 'worktrees'), project = join(temp, 'proj');
    Deno.mkdirSync(project, { recursive: true });
    const { repoHash } = await import('../../app/server/worktrees/worktrees.ts');
    const make = (id: string, redirect: boolean) => {
      Deno.mkdirSync(join(state, 'gemini', id, 'policy'), { recursive: true });
      Deno.writeTextFileSync(join(state, 'gemini', id, 'policy', 'aib-subagents.toml'), '');
      if (redirect) {
        Deno.mkdirSync(join(state, 'gemini', id, 'home', '.gemini'), { recursive: true });
        Deno.writeTextFileSync(join(state, 'gemini', id, 'home', '.gemini', 'settings.json'), '{}');
        Deno.mkdirSync(join(root, repoHash(project), `.gem-${id}`), { recursive: true });
      }
    };
    const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32);
    make(a, true);
    make(b, false);
    make(c, true);
    const ra = restore(state, root, a, project)!;
    assert(ra.subFolder.endsWith(`.gem-${a}`) && !ra.off);
    const rb = restore(state, root, b, project)!;
    assertEquals(rb.subFolder, '');
    assert(rb.off);
    assertEquals(restore(state, root, 'd'.repeat(32), project), null);
    assertEquals(restore(state, root, '../x', project), null);
    assertEquals(idsInArgs(['node', 'g.js', '--acp', '--admin-policy', join(state, 'gemini', c, 'policy')]), [c]);
    assertEquals(sweep(state, root, new Set([a]), 3600), 0, 'young folders stay');
    assertEquals(sweep(state, root, new Set([a, c]), 0), 1);
    assert(restore(state, root, a, project) && restore(state, root, c, project), 'kept: open or running');
    assertEquals(restore(state, root, b, project), null, 'the unused one went');
  } finally {
    Deno.removeSync(temp, { recursive: true });
  }
});

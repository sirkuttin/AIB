/**
 * The aib-shared rule in a builder's own prompt (owner 2026-11-27): AIB's Claude PreToolUse hook on the Agent tool appends one short
 * paragraph to the call's prompt (hook 6 of the keeper's forwarder), only when the project has an aib-shared folder. The Go side
 * (keeper/hookforward_test.go TestHookPreToolSharedRuleSuffix) refuses any other prompt change.
 *   - the rewrite: appended once, only for a hook 6 chat, only with an aib-shared folder, only to a text prompt, never to a read-only type
 *   - the keeper's constant is the same text as AIB's
 *   - an older forwarder (hook 5) is never asked for it
 *   - Codex, Qwen and Antigravity need no rule: their fences allow the write through the link (shared_fence.ts)
 */
import { assert, assertEquals } from './_assert.ts';
import { hookForwarderAppendsSharedRule, hookForwarderOf } from '../../app/server/keeper/client.ts';
import { SHARED_RULE_SUFFIX, SUBAGENT_PROMPT } from '../../app/server/subagents/claude_config.ts';
import { type SubagentChat, SubagentWorktrees } from '../../app/server/subagents/service.ts';
import { join } from '../../app/server/platform/path.ts';

const WIN = Deno.build.os === 'windows';

function git(cwd: string, ...args: string[]): void {
  const out = new Deno.Command('git', { args: ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], cwd, stdout: 'piped', stderr: 'piped' })
    .outputSync();
  if (!out.success) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(out.stderr)}`);
}

function repo(dir: string): string {
  Deno.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  Deno.writeTextFileSync(join(dir, 'tracked.txt'), 'one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

async function updatedInput(chatHooks: SubagentChat['hooks'], withShared: boolean, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-sharedrule-' });
  try {
    const state = join(dir, 'state'), root = join(state, 'worktrees');
    const project = repo(join(dir, 'proj'));
    if (withShared) Deno.mkdirSync(join(project, 'aib-shared'));
    const chat: SubagentChat = { id: 'dd11ee22ff', provider: 'claude', lasting: 'claude:s1', folder: project, project, hooks: chatHooks };
    const service = new SubagentWorktrees(state, root, (id) => (id === chat.id ? chat : null));
    const answer = await service.hook('pre-tool', chat.id, { tool_name: 'Agent', tool_use_id: 'toolu_x', tool_input: input });
    return JSON.parse(answer.body).hookSpecificOutput?.updatedInput ?? {};
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

const hooks6 = { readOnly: new Set(['Explore']), userWorktreeHook: false, sharedRule: true };

Deno.test('shared rule: a hook 6 chat with an aib-shared folder gets the paragraph after the call\'s own prompt, once', async () => {
  const call = { subagent_type: 'general-purpose', description: 'd', prompt: 'do the thing' };
  assertEquals(await updatedInput(hooks6, true, call), { ...call, prompt: 'do the thing' + SHARED_RULE_SUFFIX, isolation: 'worktree' });
  // never twice
  const again = await updatedInput(hooks6, true, { ...call, prompt: 'do the thing' + SHARED_RULE_SUFFIX });
  assertEquals(again.prompt, 'do the thing' + SHARED_RULE_SUFFIX);
});

Deno.test('shared rule: no aib-shared folder, an older forwarder, no text prompt or a read-only type: the prompt is the call\'s own', async () => {
  const call = { subagent_type: 'general-purpose', prompt: 'do the thing' };
  assertEquals((await updatedInput(hooks6, false, call)).prompt, 'do the thing', 'no aib-shared folder');
  const older = { readOnly: new Set(['Explore']), userWorktreeHook: false };
  assertEquals((await updatedInput(older, true, call)).prompt, 'do the thing', 'a forwarder older than hook 6');
  const noPrompt = await updatedInput(hooks6, true, { subagent_type: 'general-purpose' });
  assertEquals(noPrompt, { subagent_type: 'general-purpose', isolation: 'worktree' });
  assertEquals(await updatedInput(hooks6, true, { subagent_type: 'Explore', prompt: 'look' }), {}, 'a read-only type passes unchanged (no answer)');
});

Deno.test('shared rule: the keeper\'s constant is the same text (keeper/hookforward.go sharedRuleSuffix)', () => {
  const go = Deno.readTextFileSync(new URL('../../keeper/hookforward.go', import.meta.url));
  const block = /const sharedRuleSuffix = ((?:"(?:[^"\\]|\\.)*"\s*\+?\s*)+)/.exec(go);
  assert(block, 'the constant is in hookforward.go');
  const literals = [...block![1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string);
  assertEquals(literals.join(''), SHARED_RULE_SUFFIX);
  assert(!SUBAGENT_PROMPT.includes('heredoc'), 'the parent prompt no longer repeats the rule');
});

Deno.test('shared rule: only a forwarder that answers hook 6 appends it (older keepers keep working, they just do not)', async () => {
  const fakes = Deno.makeTempDirSync({ prefix: 'aib-sharedrule-keeper-' });
  try {
    for (const [version, appends] of [[1, false], [4, false], [5, false], [6, true]] as const) {
      const program = join(fakes, WIN ? `fwd${version}.cmd` : `fwd${version}.sh`);
      Deno.writeTextFileSync(program, WIN ? `@echo off\r\necho hook ${version}\r\n` : `#!/bin/sh\necho hook ${version}\n`);
      if (!WIN) Deno.chmodSync(program, 0o755);
      assertEquals(await hookForwarderOf(program, fakes), program, `hook ${version} still gives hooks`);
      assertEquals(hookForwarderAppendsSharedRule(program), appends, `hook ${version}`);
    }
  } finally {
    Deno.removeSync(fakes, { recursive: true });
  }
});

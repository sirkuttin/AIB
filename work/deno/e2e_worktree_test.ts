/**
 * End-to-end tests of worktree-per-chat, one step per user flow (the port of work/test_worktree_e2e.py).
 *
 * Every step drives a real Studio the way the page does: a real agent host and a real web server (split mode) over a temp state
 * folder with server.worktreePerChat on, real temp git repos, and the fake ACP agent (which edits files and commits in its folder on
 * command). Everything goes through the HTTP API with the page token. No browser, no real agent.
 *
 * A class of the Python file is one Deno.test here; its steps share one host and web server (each step makes its own project
 * repo); the restart and takeover tests need their own. Waits are conditions with generous deadlines, never fixed sleeps.
 */
import {
  assert,
  assertEquals,
  baseName,
  Chat,
  CODE_ROOT,
  Env,
  FakeHost,
  git,
  isDir,
  Json,
  makeRepo,
  normcase,
  parentOf,
  pidAlive,
  porcelain,
  quote,
  readInfo,
  repoHash,
  SERVER_KIND,
  snapshotFiles,
  SPLIT,
  T,
  waitFor,
} from './_e2e.ts';
import { E2EFixture } from './_e2e.ts';
import { SEP } from './_host_fixture.ts';

const LINES = 'a\nb\nc\nd\ne\nf\n';
const has = (text: string, ...words: string[]) => words.every((w) => text.includes(w));
const assertIn = (needle: string, hay: string, message = '') => assert(hay.includes(needle), `${message} ${JSON.stringify(needle)} not in ${JSON.stringify(hay)}`);
const assertNotIn = (needle: string, hay: string, message = '') => assert(!hay.includes(needle), `${message} ${JSON.stringify(needle)} is in ${JSON.stringify(hay)}`);
const lines = (text: string) => text.split('\n').filter((l) => l !== '');
const join = (...parts: string[]) => parts.join(SEP);
const bootOf = (web: { boot: Json }) => web.boot as Record<string, unknown>;
const sortedEquals = (a: string[], b: string[], message = '') => assertEquals([...a].sort(), [...b].sort(), message);

/** One class of the Python file: one host and web server for all its steps. */
function suite(name: string, steps: (t: Deno.TestContext, env: Env, make: (id: string, files?: Record<string, string>, useGit?: boolean) => string) => Promise<void>) {
  Deno.test({
    name,
    ...T,
    async fn(t) {
      await using env = await Env.start();
      await steps(t, env, (id, files, useGit = true) => env.project(id, files, useGit));
    },
  });
}

// ===================================================================================================================
suite('NewChatTests', async (t, env, make) => {
  await t.step('test_1_new_chat_gets_a_worktree_on_a_studio_branch', async () => {
    const project = make('t1');
    const chat = await env.openChat(project);
    const cwd = await chat.cwd();
    const slug = baseName(cwd);
    assertEquals(normcase(parentOf(cwd)), normcase(join(env.state, 'worktrees', repoHash(project))), 'under <state>/worktrees, one folder per repo');
    assert(Deno.statSync(join(cwd, 'tracked.txt')).isFile);
    assertEquals(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), `studio/${slug}`);
    assertEquals(env.branches(project), [`studio/${slug}`]);
    assertEquals(git(project, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main', 'the project folder stays on its own branch');
    assertEquals(porcelain(project), '');
    assertIn(normcase(cwd), normcase(git(project, 'worktree', 'list', '--porcelain').replaceAll('/', SEP)));
    const state = await chat.state();
    assertEquals([state.projectRoot, state.cwd], [project, cwd]);
    assertEquals(state.worktree, { branch: `studio/${slug}`, base: 'main' });
    const listed = ((await env.web.listing()).connections as Json[]).find((c) => c.id === chat.id)!;
    assertEquals([listed.projectRoot, listed.worktree], [project, { branch: `studio/${slug}`, base: 'main' }], 'the sidebar card: one project, this branch');
    const [status, branch] = await env.web.get(`/api/live/branch?cwd=${quote(cwd)}`);
    assertEquals([status, branch.branch], [200, `studio/${slug}`], 'the chat header label');
    assertEquals((await chat.changes()).worktree, { branch: `studio/${slug}` });
    const record = await env.recordOf(chat);
    assertEquals([record.branch, record.base, record.status, record.project], [`studio/${slug}`, 'main', 'ready', project]);
    assertEquals(record.session, `claude:${await chat.session()}`);
  });

  await t.step('test_2_uncommitted_project_edits_are_copied_and_the_project_is_untouched', async () => {
    const project = make('t2', { 'sub/deep.txt': 'deep\n' });
    env.write(project, {
      'tracked.txt': 'one\nedited\n',
      'new.txt': 'brand new\n',
      'sub/deep.txt': 'deep\nedited deep\n',
      'sub/fresh/x.txt': 'x\n',
      'ignored.log': 'ignored\n',
    });
    const image = new Uint8Array(5120);
    for (let i = 0; i < image.length; i++) image[i] = i % 256;
    Deno.writeFileSync(join(project, 'image.bin'), image);
    const before = snapshotFiles(project);
    const statusBefore = porcelain(project);
    const headBefore = git(project, 'rev-parse', 'HEAD');
    const chat = await env.openChat(project);
    const wt = await chat.cwd();
    assertEquals(env.read(wt, 'tracked.txt'), 'one\nedited\n');
    assertEquals(env.read(wt, 'new.txt'), 'brand new\n');
    assertEquals(env.read(wt, 'sub/deep.txt'), 'deep\nedited deep\n');
    assertEquals(env.read(wt, 'sub/fresh/x.txt'), 'x\n');
    assertEquals(Array.from(Deno.readFileSync(join(wt, 'image.bin'))).join(','), Array.from(image).join(','));
    assertEquals(env.read(wt, 'ignored.log'), null, 'ignored files are not copied');
    assertEquals(snapshotFiles(project), before, 'the project folder is byte for byte unchanged');
    assertEquals([porcelain(project), git(project, 'rev-parse', 'HEAD'), env.branches(project)], [statusBefore, headBefore, [`studio/${baseName(wt)}`]]);
    assertEquals(git(project, 'stash', 'list'), '');
    assertEquals(git(project, 'rev-parse', 'main'), headBefore, 'main itself never moved: the copy is a side commit on the chat branch');
  });

  await t.step('test_11_a_project_that_is_not_a_git_repository_runs_in_place', async () => {
    const project = make('t11', { 'notes.txt': 'hello\n' }, false);
    const before = Object.keys(env.records()).sort();
    const chat = await env.openChat(project);
    const state = await chat.state();
    assertEquals([state.cwd, state.projectRoot], [project, project]);
    assert(!('worktree' in state));
    assert(!('worktree' in (((await env.web.listing()).connections as Json[]).find((c) => c.id === chat.id)!)));
    assertEquals(Object.keys(env.records()).sort(), before, 'no worktree registered');
    assert(!isDir(join(project, '.git')), 'Studio never turns a plain folder into a repository');
    assertEquals(await chat.send('edit:made.txt|by the agent\\n'), 'edited made.txt');
    assertEquals(env.read(project, 'made.txt'), 'by the agent\n', 'the agent works right in the folder');
    assertEquals(await chat.worktreeStatus(), { worktree: false });
    assertEquals(await chat.send('say:still fine'), 'still fine');
    const [code] = await env.web.post('worktree/merge', { id: chat.id, title: 'T' });
    assert(code >= 400, 'nothing to merge in a chat without a worktree');
  });
});

// ---------------------------------------------------------------------------------------------------------------
suite('ChangesTests', async (t, env, make) => {
  await t.step('test_3_changes_show_only_the_chats_own_work_even_after_it_commits', async () => {
    const project = make('t3', { 'f.txt': LINES });
    env.write(project, { 'tracked.txt': 'one\nuser edit\n', 'mine.txt': 'my own work\n' }); // the user's, before the chat: copied into its copy
    const chat = await env.openChat(project);
    assertEquals(await chat.changedPaths(), [], "copied user edits are not the chat's changes");
    let data = await chat.changes();
    assertEquals([data.scope, (data.totals as Json).files], ['branch', 0]);
    await chat.send('edit:chat.txt|one\\ntwo\\n');
    await chat.send('edit:f.txt|CHAT\\nb\\nc\\nd\\ne\\nf\\n');
    assertEquals(await chat.changedPaths(), ['chat.txt', 'f.txt']);
    await chat.send('commit:the chat commit');
    data = await chat.changes();
    assertEquals(data.files.map((f) => f.path as string).sort(), ['chat.txt', 'f.txt'], 'still shown once committed');
    const byPath = Object.fromEntries(data.files.map((f) => [f.path as string, f]));
    assertEquals([byPath['chat.txt'].status, byPath['chat.txt'].added], ['A', 2]);
    assertEquals([byPath['f.txt'].added, byPath['f.txt'].removed], [1, 1]);
    assertEquals(git(await chat.cwd(), 'status', '--porcelain=v1', '-uall', '--', 'chat.txt', 'f.txt'), '', 'really committed');
    // the user keeps saving: that is synced, and still not the chat's work
    await env.syncReady(chat, project);
    env.write(project, 'mine.txt', 'my own work\nsecond line\n');
    await waitFor(async () => env.read(await chat.cwd(), 'mine.txt') === 'my own work\nsecond line\n', "the user's save in the copy");
    await waitFor(async () => ((await env.recordOf(chat)).syncedPaths as string[] | undefined ?? []).includes('mine.txt'), "the save counted as the user's");
    assertEquals(await chat.changedPaths(), ['chat.txt', 'f.txt']);
    assertEquals(env.read(await chat.cwd(), 'tracked.txt'), 'one\nuser edit\n');
    const [status, diff] = await env.web.get(`/api/live/changes/file?id=${chat.id}&scope=uncommitted&path=f.txt`);
    assertEquals(status, 200);
    assertIn('CHAT', JSON.stringify(diff));
  });
});

// ---------------------------------------------------------------------------------------------------------------
suite('LiveSyncTests', async (t, env, make) => {
  await t.step('test_4_a_file_the_chat_has_not_touched_syncs_and_the_next_prompt_names_it', async () => {
    const project = make('t4', { 'f.txt': LINES });
    const chat = await env.openChat(project);
    const canary = await env.syncReady(chat, project);
    const started = Date.now();
    env.write(project, 'f.txt', 'user\nb\nc\nd\ne\nf\n');
    await waitFor(async () => env.read(await chat.cwd(), 'f.txt') === 'user\nb\nc\nd\ne\nf\n', 'the saved file in the copy');
    assert(Date.now() - started < 30000, 'within the debounce (generous bound for a loaded machine)');
    assertEquals(env.read(project, 'f.txt'), 'user\nb\nc\nd\ne\nf\n', "the project file is the user's own");
    await waitFor(async () => ((await env.recordOf(chat)).syncedPaths as string[] | undefined ?? []).includes('f.txt'), 'synced paths recorded');
    assertEquals(await chat.changedPaths(), [], "a synced file is not the chat's change");
    const said = await chat.send('context');
    assertIn('<studio-context>', said);
    assertIn('The user changed these files since your last turn', said);
    assertIn('f.txt', said);
    assertIn(canary, said);
    assertEquals(await chat.send('context'), 'CONTEXT none', 'told once, not on every turn');
    assertEquals((await chat.events('user')).filter((e) => String(e.text).includes('<studio-context>')), [], "the note is not part of the user's message");
  });

  await t.step('test_5a_a_file_both_edited_is_combined_when_the_lines_differ', async () => {
    const project = make('t5a', { 'f.txt': LINES });
    const chat = await env.openChat(project);
    await env.syncReady(chat, project);
    await chat.send('edit:f.txt|A-chat\\nb\\nc\\nd\\ne\\nf\\n'); // uncommitted: the chat has touched it
    env.write(project, 'f.txt', 'a\nb\nc\nd\ne\nF-user\n');
    await waitFor(async () => JSON.stringify((await env.recordOf(chat)).pendingSync) === '["f.txt"]', 'the clash candidate recorded');
    assertEquals(env.read(await chat.cwd(), 'f.txt'), 'A-chat\nb\nc\nd\ne\nf\n', 'not written under the chat while it is working on it');
    await chat.send('say:next'); // the end of that turn combines the two
    await waitFor(async () => env.read(await chat.cwd(), 'f.txt') === 'A-chat\nb\nc\nd\ne\nF-user\n', 'both edits combined');
    const record = await waitFor(async () => {
      const r = await env.recordOf(chat);
      return (r.pendingSync as unknown[] | undefined)?.length ? null : r;
    }, 'nothing pending');
    assertEquals((record.syncConflicts as unknown[] | undefined) ?? [], []);
    assertEquals(await chat.changedPaths(), ['f.txt']);
    assertEquals(env.read(project, 'f.txt'), 'a\nb\nc\nd\ne\nF-user\n', 'the project folder is never touched');
    assert((await chat.worktreeStatus()).state !== 'conflicts');
  });

  await t.step('test_5b_edits_on_the_same_lines_clash_block_merge_and_resolving_clears_it', async () => {
    const project = make('t5b', { 'g.txt': LINES });
    const chat = await env.openChat(project);
    await env.syncReady(chat, project);
    await chat.send('edit:g.txt|X-chat\\nb\\nc\\nd\\ne\\nf\\n');
    env.write(project, 'g.txt', 'Y-user\nb\nc\nd\ne\nf\n');
    await waitFor(async () => JSON.stringify((await env.recordOf(chat)).pendingSync) === '["g.txt"]', 'the clash candidate recorded');
    await chat.send('say:next');
    const record = await waitFor(async () => {
      const r = await env.recordOf(chat);
      return (r.syncConflicts as unknown[] | undefined)?.length ? r : null;
    }, 'syncConflicts');
    assertEquals(record.syncConflicts, ['g.txt']);
    const marked = env.read(await chat.cwd(), 'g.txt')!;
    assert(marked.includes('<<<<<<<') && marked.includes('X-chat') && marked.includes('Y-user'), marked);
    assertEquals(env.read(project, 'g.txt'), 'Y-user\nb\nc\nd\ne\nf\n', "the user's own file has no markers");
    const status = await chat.worktreeStatus();
    assertEquals([status.state, status.enabled], ['conflicts', false]);
    assertIn('g.txt', String(status.message));
    const mainBefore = git(project, 'rev-parse', 'main').trim();
    const refused = await chat.merge('T', 409);
    assertIn('g.txt', String(refused.error));
    assertEquals(git(project, 'rev-parse', 'main').trim(), mainBefore, 'nothing landed on main');
    const said = await chat.send('context');
    assertIn('g.txt', said);
    assert(/clash|conflict/.test(said.toLowerCase()), said);
    // the chat resolves it in its own copy
    await chat.send('edit:g.txt|X-chat and Y-user\\nb\\nc\\nd\\ne\\nf\\n');
    await chat.send('say:resolved');
    await waitFor(async () => !((await env.recordOf(chat)).syncConflicts as unknown[] | undefined)?.length, 'the conflict cleared');
    const after = await waitFor(async () => {
      const s = await chat.worktreeStatus();
      return s.state !== 'conflicts' ? s : null;
    }, 'Merge unblocked');
    assertEquals([after.state, after.enabled], ['ready', true]);
    assertEquals((await chat.send('context')).split('<<<<<<<').length - 1, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
suite('MergeTests', async (t, env, make) => {
  await t.step('test_6_a_clean_merge_lands_only_the_chats_commits_and_keeps_the_users_edits', async () => {
    const project = make('t6', { 'u.txt': 'u1\nu2\n' });
    env.write(project, 'u.txt', 'u1\nu2\nuser edit\n'); // before the chat: in its copy from the start
    const chat = await env.openChat(project);
    const wt = await chat.cwd();
    const canary = await env.syncReady(chat, project);
    env.write(project, 'later.txt', 'saved later\n');
    await waitFor(() => env.read(wt, 'later.txt') === 'saved later\n', 'later.txt synced');
    await chat.send('edit:a.txt|first\\n');
    await chat.send('commit:agent commit a');
    await chat.send('edit:b.txt|uncommitted b\\n');
    const before = git(project, 'rev-parse', 'main').trim();
    const status = await chat.worktreeStatus();
    assertEquals([status.state, status.enabled], ['ready', true]);
    const result = await chat.merge('My title');
    assertEquals([result.state, result.commits, result.message], ['merged', 2, 'Merged into main (2 commits)']);
    assertEquals(lines(git(project, 'log', '--format=%s', `${before}..main`)), ['AIB: work from chat My title'], "the user's synced edits moved the chat's base, so its work lands as one commit");
    const tree = git(project, 'ls-tree', '-r', '--name-only', 'main').split(/\s+/).filter(Boolean);
    for (const name of ['a.txt', 'b.txt']) assert(tree.includes(name), name);
    for (const name of [canary, 'later.txt']) assert(!tree.includes(name), name);
    assertEquals(git(project, 'show', 'main:u.txt'), 'u1\nu2\n', "the user's edit never lands");
    // the user's unsaved edits survived stash, merge, unstash
    assertEquals(env.read(project, 'u.txt'), 'u1\nu2\nuser edit\n');
    assertEquals(env.read(project, 'later.txt'), 'saved later\n');
    assertEquals(env.read(project, 'a.txt'), 'first\n', 'the merged work is in the project folder');
    assertEquals(git(project, 'stash', 'list'), '', 'the stash Studio made is gone');
    assertEquals(git(project, 'ls-files', '-u'), '');
    const porcelainLines = lines(porcelain(project)).sort();
    assert(porcelainLines.includes(' M u.txt'), porcelainLines.join('|'));
    assertEquals(porcelainLines.filter((l) => ['a.txt', 'b.txt'].includes(l.slice(3))), [], 'the merged work is committed, not left as uncommitted edits');
    // the chat's copy continues from the new base
    const newBase = git(project, 'rev-parse', 'main').trim();
    assertEquals(git(wt, 'rev-parse', 'HEAD~1').trim(), newBase, "reset to the new base (plus the side commit that holds the user's edits)");
    sortedEquals(git(wt, 'diff', '--name-only', newBase, 'HEAD').split(/\s+/).filter(Boolean), ['u.txt', 'later.txt', canary], "that commit is only the user's edits");
    assertEquals(env.read(wt, 'u.txt'), 'u1\nu2\nuser edit\n', "its copy still has the user's newest version");
    assertEquals(await chat.changedPaths(), []);
    assertEquals((await chat.worktreeStatus()).state, 'nochanges');
    const notes = await chat.notes();
    assertEquals(notes[notes.length - 1].message, 'Merged into main (2 commits)');
    // a follow-up prompt works, and so does a second merge from the new base
    assertEquals(await chat.send('say:go on'), 'go on');
    await chat.send('edit:c.txt|second\\n');
    await chat.send('commit:agent commit c');
    assertEquals((await chat.merge()).message, 'Merged into main (1 commit)');
    assertEquals(git(project, 'show', 'main:c.txt'), 'second\n');
    assertEquals(env.read(project, 'u.txt'), 'u1\nu2\nuser edit\n');
  });

  /** The user's uncommitted edit and the chat's commit hit the same line of tracked.txt: merging lands, re-applying the edit clashes. */
  async function clashedChat(name: string) {
    const project = env.project(name);
    env.write(project, { 'tracked.txt': 'user line\n', 'mine.txt': 'user only\n' });
    const chat = await env.openChat(project);
    await chat.send('edit:tracked.txt|chat line\\n');
    await chat.send('commit:chat edit');
    const result = await chat.merge();
    assertEquals(result.state, 'merged');
    assertEquals(result.clash, ['tracked.txt']);
    await chat.settle();
    return { project, chat, result };
  }

  await t.step('test_7_when_re_applying_the_users_edits_clashes_the_note_guides_and_the_line_clears', async () => {
    const { project, chat, result } = await clashedChat('clash-resolve');
    const note = (await chat.notes()).filter((n) => n.actions).pop()!;
    assertIn('tracked.txt', String(note.message));
    assertIn(String(result.stash), String(note.message));
    assertEquals((note.actions as Json[]).map((a) => [a.id, a.label]), [['keep-mine', 'Keep my version'], ['leave', "I'll sort it myself"]]);
    const told = String((await chat.events('user')).pop()!.text);
    assertIn('tracked.txt', told, 'the chat is told, so it can offer to combine');
    assertIn(String(result.stash), told);
    const line = 'tracked.txt has unresolved edits. Ask the chat to fix it.';
    const [status, amber] = await env.web.get(`/api/live/worktree/clash?project=${quote(project)}`);
    assertEquals([status, amber.unresolved, amber.line, amber.files], [200, true, line, ['tracked.txt']]);
    // "I'll sort it myself" changes nothing
    const snapshot = () => [porcelain(project), git(project, 'stash', 'list'), env.read(project, 'tracked.txt'), git(project, 'rev-parse', 'main')];
    const before = snapshot();
    const left = await chat.clash('leave');
    assert(left.ok);
    assertIn(String(result.stash), String(left.message));
    assertEquals(snapshot(), before);
    assert((await env.web.get(`/api/live/worktree/clash?project=${quote(project)}`))[1].unresolved, 'the amber line stays until it is really resolved');
    // "Keep my version": the user's side wins and the line goes away
    const kept = await chat.clash('keep-mine');
    assert(kept.ok && kept.dropped, JSON.stringify(kept));
    assertEquals(env.read(project, 'tracked.txt'), 'user line\n');
    assertEquals(env.read(project, 'mine.txt'), 'user only\n');
    assertEquals(git(project, 'stash', 'list'), '');
    assertEquals(git(project, 'ls-files', '-u'), '');
    assertEquals(git(project, 'show', 'main:tracked.txt'), 'chat line\n', 'main holds the merged work');
    assertEquals((await env.web.get(`/api/live/worktree/clash?project=${quote(project)}`))[1], { unresolved: false });
    assertEquals((await chat.clash('keep-mine', 404)).code, 'no_clash');
  });

  await t.step('test_7b_the_chat_combines_the_clash_itself_and_checks_it', async () => {
    const { project, chat } = await clashedChat('clash-combine');
    assert((await env.web.get(`/api/live/worktree/clash?project=${quote(project)}`))[1].unresolved);
    const markers = env.read(project, 'tracked.txt')!;
    assertIn('<<<<<<<', markers);
    let said = await chat.send('call-tool:check');
    assert(said.startsWith('TOOL 409'), 'markers are still in: not done. ' + said);
    assert((await env.web.get(`/api/live/worktree/clash?project=${quote(project)}`))[1].unresolved);
    await chat.send(`write:${join(project, 'tracked.txt')}|chat line\nuser line\n`); // the chat edits the file in the project folder
    said = await chat.send('call-tool:check');
    assert(said.startsWith('TOOL 200'), said);
    assertIn('tracked.txt', said);
    assertEquals((await env.web.get(`/api/live/worktree/clash?project=${quote(project)}`))[1], { unresolved: false });
    assertEquals(env.read(project, 'tracked.txt')!.replaceAll('\r\n', '\n'), 'chat line\nuser line\n'); // (the fake writes in text mode: CRLF on Windows)
    assertEquals(lines(git(project, 'stash', 'list')).length, 1, 'the stash stays as a backup');
  });

  await t.step('test_8_the_merge_tool_merges_with_its_own_key_and_is_refused_with_anothers', async () => {
    const project = make('t8');
    const mine = await env.openChat(project);
    const other = await env.openChat(project);
    await mine.send('edit:mine.txt|mine\\n');
    await mine.send('commit:mine commit');
    await other.send('edit:other.txt|other\\n');
    await other.send('commit:other commit');
    const mainBefore = git(project, 'rev-parse', 'main').trim();
    // another conversation's id with this chat's key
    let said = await other.send(`call-tool:merge:${mine.id}`);
    assert(/^TOOL 40[13] /.test(said), said);
    assertEquals(git(project, 'rev-parse', 'main').trim(), mainBefore, 'nothing merged');
    assertEquals((await mine.worktreeStatus()).state, 'ready', 'the other chat is untouched');
    // no Merge button any more (owner, 2026-11-16): its request route is gone; the agent merges with its tool, no press needed
    const [code, asked] = await env.web.post('worktree/merge-request', { id: mine.id });
    assertEquals(code, 404, JSON.stringify(asked));
    // another chat's key is still refused
    said = await other.send(`call-tool:merge:${mine.id}`);
    assert(/^TOOL 40[13] /.test(said), said);
    assertEquals(git(project, 'rev-parse', 'main').trim(), mainBefore, 'nothing merged');
    // its own key merges its own chat
    said = await mine.send('call-tool:merge', 200, 'merge-e2e');
    assert(said.startsWith('TOOL 200 '), said);
    const reply = JSON.parse(said.slice('TOOL 200 '.length));
    assertEquals([reply.state, reply.message], ['merged', 'Merged into main (1 commit)']);
    assertEquals(git(project, 'show', 'main:mine.txt'), 'mine\n');
    assert(!git(project, 'ls-tree', '-r', '--name-only', 'main').includes('other.txt'));
    assertEquals(git(await mine.cwd(), 'rev-parse', 'HEAD').trim(), git(project, 'rev-parse', 'main').trim());
    // no credentials at all, and a made-up key
    for (const headers of [{}, { 'X-Studio-Artifact-Key': 'not-a-key' }] as Record<string, string>[]) {
      const response = await fetch(`http://127.0.0.1:${env.web.port}/api/live/worktree/tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${env.web.port}`, ...headers },
        body: JSON.stringify({ conversationId: other.id, action: 'merge' }),
      });
      await response.text();
      assert([401, 403].includes(response.status), `${JSON.stringify(headers)} gave ${response.status}`);
    }
    assertEquals((await other.worktreeStatus()).state, 'ready', 'still not merged');
  });
});

// ---------------------------------------------------------------------------------------------------------------
suite('DiscardArchiveTests', async (t, env, make) => {
  const archive = (chat: Chat, session: string, action = 'archive') =>
    env.web.post('conversation-state', { action, provider: 'claude', sessionId: session, title: 't' });

  await t.step('test_9a_there_is_no_discard_any_more_and_nothing_is_removed', async () => {
    // owner, 2026-11-16: no Discard (nor Merge) for any chat; an old copy chat's unmerged work is discarded only by the owner's
    // one-off migration script (--discard), with AIB quit
    const project = make('t9a');
    const chat = await env.openChat(project);
    await chat.send('edit:work.txt|some work\\n');
    const wt = await chat.cwd();
    assertEquals(env.branches(project).length, 1);
    for (const body of [{ id: chat.id }, { id: chat.id, confirm: true }]) {
      const [code] = await env.web.post('worktree-discard', body);
      assertEquals(code, 404, JSON.stringify(body));
    }
    assert(isDir(wt));
    assertEquals(env.branches(project).length, 1);
    assert(env.record(wt) !== null);
  });

  await t.step('test_9b_archiving_a_chat_without_changes_cleans_up', async () => {
    const project = make('t9b');
    const chat = await env.openChat(project);
    const wt = await chat.cwd();
    const session = await chat.session();
    assertEquals(env.branches(project).length, 1);
    await chat.disconnect();
    let [code, payload] = await archive(chat, session);
    assertEquals(code, 200, JSON.stringify(payload));
    assertEquals((payload.worktree as Json).removed, true, JSON.stringify(payload));
    assert(!('keptChanges' in (payload.worktree as Json)));
    await waitFor(() => !isDir(wt), 'the folder removed');
    assertEquals(env.branches(project), []);
    assertEquals(env.record(wt), null);
    [code, payload] = await archive(chat, session, 'unarchive');
    assertEquals(code, 200);
    assert(!('worktree' in payload), 'unarchive brings the chat back and nothing else');
  });

  await t.step('test_9c_archiving_a_chat_with_changes_keeps_them', async () => {
    const project = make('t9c');
    const chat = await env.openChat(project);
    await chat.send('edit:kept.txt|precious\\n');
    await chat.send('commit:a commit');
    await chat.send('edit:loose.txt|uncommitted\\n');
    const wt = await chat.cwd();
    const branch = env.branches(project)[0];
    const session = await chat.session();
    await chat.disconnect();
    const [code, payload] = await archive(chat, session);
    assertEquals(code, 200, JSON.stringify(payload));
    assertEquals(payload.worktree, { branch, removed: false, keptChanges: true });
    assert(isDir(wt));
    assertEquals(env.branches(project), [branch]);
    assertEquals(env.read(wt, 'loose.txt'), 'uncommitted\n');
    assertEquals(env.record(wt)!.status, 'ready');
    assertEquals((await archive(chat, session, 'unarchive'))[0], 200);
    const resumed = await env.openChat(project, { resume: session });
    assertEquals(await resumed.cwd(), wt, 'unarchived and continuable in the same copy');
    assertEquals(env.read(wt, 'kept.txt'), 'precious\n');
  });
});

// ---------------------------------------------------------------------------------------------------------------
suite('TwoChatTests', async (t, env, make) => {
  await t.step('test_12_two_chats_in_one_project_each_get_a_copy_and_both_merge', async () => {
    const project = make('t12', { 'shared.txt': LINES });
    const one = await env.openChat(project);
    const two = await env.openChat(project);
    assert((await one.cwd()) !== (await two.cwd()));
    assertEquals(new Set(env.branches(project)).size, 2);
    assertEquals(
      [...new Set(((await env.web.listing()).connections as Json[]).filter((c) => [one.id, two.id].includes(c.id as string)).map((c) => c.projectRoot))],
      [project],
      'one sidebar project',
    );
    await one.send('edit:one.txt|from one\\n');
    await one.send('commit:commit one');
    await two.send('edit:two.txt|from two\\n');
    await two.send('commit:commit two');
    assertEquals(env.read(await one.cwd(), 'two.txt'), null, 'each has its own copy');
    assertEquals(env.read(await two.cwd(), 'one.txt'), null);
    const first = await one.merge('One');
    assertEquals(first.state, 'merged');
    const baseAfterOne = git(project, 'rev-parse', 'main').trim();
    assertEquals((await two.worktreeStatus()).state, 'ready');
    const second = await two.merge('Two');
    assertEquals(second.state, 'merged', JSON.stringify(second));
    const tree = git(project, 'ls-tree', '-r', '--name-only', 'main').split(/\s+/);
    assert(tree.includes('one.txt'));
    assert(tree.includes('two.txt'));
    const log = lines(git(project, 'log', '--format=%s', 'main'));
    assert(log.includes('commit one'));
    assert(log.includes('commit two'));
    git(project, 'merge-base', '--is-ancestor', baseAfterOne, 'main'); // B was brought up to the new base before it landed (throws if not)
    assertEquals(git(await two.cwd(), 'rev-parse', 'HEAD').trim(), git(project, 'rev-parse', 'main').trim());
    assertEquals(git(await one.cwd(), 'rev-parse', 'HEAD').trim(), baseAfterOne, 'A has not moved');
    assertEquals(env.read(project, 'one.txt'), 'from one\n');
    assertEquals(env.read(project, 'two.txt'), 'from two\n');
    assertEquals(porcelain(project), '');
    assertEquals(git(project, 'stash', 'list'), '');
    assertEquals(await one.send('say:still here'), 'still here');
  });
});

// ===================================================================================================================
// RestartTests: each test has its own host: they stop and start processes.
async function withEnv(fn: (env: Env) => Promise<void>) {
  await using env = await Env.start();
  await fn(env);
}

function snapshot(env: Env, project: string, wt: string) {
  const record = env.record(wt)!;
  const pick = Object.fromEntries(['path', 'branch', 'base', 'snapshot', 'user', 'diffBase', 'status', 'session', 'project'].map((k) => [k, record[k] ?? null]));
  return {
    record: pick,
    branches: env.branches(project),
    head: git(wt, 'rev-parse', 'HEAD'),
    main: git(project, 'rev-parse', 'main'),
    status: porcelain(wt),
    project_status: porcelain(project),
    worktrees: git(project, 'worktree', 'list', '--porcelain'),
  };
}

async function work(env: Env, name: string): Promise<{ project: string; chat: Chat }> {
  const project = env.project(name);
  const chat = await env.openChat(project);
  await chat.send('edit:committed.txt|safe\\n');
  await chat.send('commit:committed work');
  await chat.send('edit:loose.txt|not committed\\n');
  return { project, chat };
}

Deno.test({
  name: 'RestartTests test_10a_restarting_only_the_web_server_reattaches_with_nothing_changed',
  ignore: !SPLIT,
  ...T,
  fn: () =>
    withEnv(async (env) => {
      const { project, chat } = await work(env, 'web-restart');
      const wt = await chat.cwd();
      const hostPid = (await readInfo(env.state))!.pid;
      const before = snapshot(env, project, wt);
      const changedBefore = await chat.changedPaths();
      await env.web.kill();
      assert(pidAlive(hostPid), 'the host outlives the web server');
      const web = await env.fx.startWeb();
      env.web = web;
      assertEquals(bootOf(web).hostPid, hostPid);
      assertEquals(bootOf(web).connections, [chat.id]);
      const again = new Chat(env, chat.id, web);
      const state = await again.state();
      assertEquals([state.cwd, state.projectRoot, state.worktree], [before.record.path, project, { branch: before.record.branch, base: 'main' }]);
      assertEquals(snapshot(env, project, wt), before);
      assertEquals(await again.changedPaths(), changedBefore);
      assertEquals((await again.worktreeStatus()).state, 'ready');
      assertEquals(await again.send('say:after restart'), 'after restart');
      assertEquals((await again.merge()).state, 'merged');
      assertEquals(git(project, 'show', 'main:committed.txt'), 'safe\n');
    }),
});

Deno.test({
  name: 'RestartTests test_10b_restarting_the_agent_host_keeps_worktrees_and_branches',
  ignore: !SPLIT,
  ...T,
  fn: () =>
    withEnv(async (env) => {
      const { project, chat } = await work(env, 'host-restart');
      const wt = await chat.cwd();
      const session = await chat.session();
      const before = snapshot(env, project, wt);
      const oldPid = (await readInfo(env.state))!.pid;
      await env.web.kill();
      const stopped = await env.fx.runCli('--stop-host');
      assertEquals(stopped.code, 0, stopped.stdout + stopped.stderr);
      await waitFor(() => !pidAlive(oldPid), 'the host stopped');
      const web = await env.fx.startWeb();
      env.web = web;
      assert(bootOf(web).hostPid !== oldPid, 'a new host');
      assertEquals(snapshot(env, project, wt), before, 'worktree, branch, registry and files are all intact');
      assertEquals(env.read(wt, 'loose.txt'), 'not committed\n');
      // The new host reopens the chat by itself (durable recovery); if it has not, the sidebar's resume does the same. Either way: the same copy.
      let resumed: Chat;
      try {
        const found = await waitFor(async () => ((await web.listing()).connections as Json[]).find((c) => c.sessionId === session && c.ready), 'the chat recovered by the new host', 20);
        resumed = new Chat(env, found.id as string, web);
      } catch {
        resumed = await env.openChat(project, { resume: session });
      }
      assertEquals(await resumed.cwd(), wt, 'continues in the same copy');
      assertEquals((await resumed.state()).worktree, { branch: before.record.branch, base: 'main' });
      assertEquals(await resumed.changedPaths(), ['committed.txt', 'loose.txt']);
      assertEquals(snapshot(env, project, wt), before, 'reopening changed nothing');
      assertEquals(await resumed.send('say:back'), 'back');
      assertEquals((await resumed.merge()).state, 'merged');
      assertEquals(git(project, 'show', 'main:committed.txt'), 'safe\n');
    }),
});

/** rm -rf that also removes read-only files (git objects on Windows). */
function removeByHand(path: string): boolean {
  if (!isDir(path)) return true;
  try {
    Deno.removeSync(path, { recursive: true });
  } catch {
    if (Deno.build.os === 'windows') {
      new Deno.Command('cmd', { args: ['/c', 'attrib', '-r', `${path}\\*`, '/s', '/d'], stdout: 'null', stderr: 'null' }).outputSync();
      try {
        Deno.removeSync(path, { recursive: true });
      } catch { /* still held */ }
    }
  }
  return !isDir(path);
}

Deno.test({
  name: 'RestartTests test_10c_a_worktree_folder_deleted_by_hand_is_recreated_from_its_branch_on_resume',
  ...T,
  fn: () =>
    withEnv(async (env) => {
      const { project, chat } = await work(env, 'hand-delete');
      const wt = await chat.cwd();
      const branch = (await env.recordOf(chat)).branch as string;
      const session = await chat.session();
      await chat.disconnect();
      await waitFor(() => removeByHand(wt), 'the worktree folder deleted by hand');
      assertEquals(env.branches(project), [branch], 'the branch is still there');
      const resumed = await env.openChat(project, { resume: session });
      assertEquals(await resumed.cwd(), wt, 'the same place');
      assert(isDir(wt));
      assertEquals(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), branch);
      assertEquals(env.read(wt, 'committed.txt'), 'safe\n', 'what the chat committed came back');
      assertIn(baseName(wt), git(project, 'worktree', 'list', '--porcelain'));
      assertEquals(env.record(wt)!.status, 'ready');
      assertEquals((await resumed.state()).worktree, { branch, base: 'main' });
      assertEquals(await resumed.send('say:alive'), 'alive');
      assertEquals((await resumed.merge()).state, 'merged');
      assertEquals(git(project, 'show', 'main:committed.txt'), 'safe\n');
    }),
});

// ===================================================================================================================
// TakeoverTests: a real web server that finds an agent host from another code folder (fake hosts, in temp folders only).
Deno.test({
  name: 'TakeoverTests test_13a_an_idle_host_from_another_code_root_is_taken_over',
  ignore: !SPLIT,
  ...T,
  async fn() {
    await using fx = new E2EFixture();
    const old = await FakeHost.start(fx, 0, { appId: 'dev.aib.app' });
    const web = await fx.startWeb();
    assertEquals(bootOf(web).hostMode, 'split');
    await waitFor(() => old.stopped(), 'the idle foreign host was asked to stop');
    assert(old.calls().includes('stop'));
    assert(bootOf(web).hostPid !== old.pid, 'a host of our own now');
    assertEquals((await readInfo(fx.state))!.codeRoot, CODE_ROOT);
    assertEquals(bootOf(web).hostTakeoverWaiting ?? 0, 0);
    assert(pidAlive(bootOf(web).hostPid as number));
    await web.post('settings', { server: { worktreePerChat: true } });
    const project = makeRepo(join(fx.root, 'proj-takeover'));
    const [status, connection] = await web.post('connect', { provider: 'claude', cwd: project, background: true, ownCopy: true });
    assertEquals(status, 200, JSON.stringify(connection));
    const chat = new Chat(null, connection.id as string, web);
    await waitFor(async () => (await chat.state()).ready, 'chat ready on the new host');
    assert('worktree' in (await chat.state()));
  },
});

Deno.test({
  name: 'TakeoverTests test_13b_a_busy_host_is_not_taken_over_and_is_waited_for',
  ignore: !SPLIT,
  ...T,
  async fn() {
    await using fx = new E2EFixture();
    const old = await FakeHost.start(fx, 2);
    const web = await fx.startWeb();
    assertEquals(bootOf(web).hostTakeoverWaiting, 2, 'the banner: waiting for 2 chats');
    assert(!old.stopped(), 'a busy host is never stopped');
    assert(pidAlive(old.pid));
    assertEquals((await readInfo(fx.state))!.pid, old.pid, 'its file is still the live one');
    assert(bootOf(web).hostMode !== 'split-own');
    old.setActive(0); // its chats finish: the web server switches over by itself
    await waitFor(async () => (await web.get('/api/live/bootstrap'))[1].hostTakeoverWaiting === 0 && old.stopped(), 'the takeover once the chats finished');
    await waitFor(async () => {
      const info = await readInfo(fx.state);
      return info && info.pid !== old.pid;
    }, 'a host of our own');
  },
});

void SERVER_KIND;
void has;

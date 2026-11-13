/**
 * One set of notification rules for the page and the server (outputs/agent-studio/notify-rules.js; review break 10). The page reads
 * a chat with its own code (sidebar-ui.js rootOf / pathKey with the folder kinds the server reports, workspace-state.js folder rules,
 * the conversation marks, the project preferences) and asks notify-rules.js flags; the server's AttentionWatcher reads the same
 * stores and asks the same function. For a table of chats both must say the same: may it notify, is it muted, is it held.
 * Real folders on disk (a git worktree whose .git is a file, a Claude scratch folder, a .claude/worktrees folder).
 */
import { assertEquals } from './_assert.ts';
import { APP_ROOT } from '../../outputs/agent-studio/server/core/app.ts';
import { folderKinds } from '../../outputs/agent-studio/server/desktop/folders.ts';
import { RULES } from '../../outputs/agent-studio/server/attention/rules.ts';
import { AttentionWatcher } from '../../outputs/agent-studio/server/attention/watcher.ts';

type Json = Record<string, unknown>;
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const g = globalThis as unknown as Json;

/** The page's modules, loaded the way chat.html loads them (classic scripts on the global object). notify-rules.js is already
 * there: the server's rules.ts imported the very file, and the page's scripts find it on the global object as in the browser. */
function loadPage(): { S: Json; W: Json; R: Json } {
  for (const name of ['workspace-state.js', 'sidebar-ui.js']) {
    (0, eval)(Deno.readTextFileSync(APP_ROOT + SEP + name));
  }
  return { S: g.AgentSidebarUI as Json, W: g.AgentWorkspaceState as Json, R: g.AgentNotifyRules as Json };
}

/** The page's reading of one live chat (workspace-ui.js normalize + notifyChats), with the kinds /api/live/folders/kinds gives. */
// deno-lint-ignore no-explicit-any
function pageFlags(page: any, c: Json, marks: Json, prefs: Json): Json {
  const base = String(c.projectRoot || c.cwd || '');
  const kinds = new Map<string, Json>();
  for (const [k, v] of Object.entries(folderKinds([base], true))) if (v.worktree || v.scratch) kinds.set(k, v as unknown as Json);
  page.S.setWorktreeHook((path: string) => {
    const k = kinds.get(path);
    return k && k.worktreeOf ? { of: k.worktreeOf, branch: k.branch || '' } : null;
  });
  const conv = { provider: c.provider, sessionId: c.sessionId, id: c.id, cwd: c.cwd, projectRoot: c.projectRoot, live: c };
  const root = page.S.rootOf(conv);
  const projectKey = page.S.pathKey(root) || 'none';
  const path = page.S.projectOf(conv).path || root;
  if (!kinds.has(path)) {
    for (const [k, v] of Object.entries(folderKinds([path], true))) if (v.worktree || v.scratch) kinds.set(k, v as unknown as Json);
  }
  const k = kinds.get(path) || {};
  const entry = (marks[`${c.provider}:${c.sessionId}`] || {}) as Json;
  return page.R.flags(
    {
      archived: !!entry.archivedAt,
      deleted: !!entry.deletedAt,
      held: !!entry.holdAt,
      projectKey,
      worktree: !!k.worktree || page.W.isWorktreePath(path),
      scratch: !!k.scratch || page.W.isScratchPath(path),
    },
    prefs,
  );
}

Deno.test('notification rules: the page and the server read the same chats the same way (one shared module)', () => {
  const page = loadPage();
  assertEquals(page.R === (RULES as unknown as Json), true, 'the server uses the very module the page loads');
  const source = Deno.readTextFileSync(APP_ROOT + SEP + 'notify-rules.js');
  assertEquals(source.includes('root.AgentNotifyRules = api;'), true);
  const root = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-rules-' }));
  try {
    const repo = `${root}${SEP}Repo`;
    const claudeWt = `${repo}${SEP}.claude${SEP}worktrees${SEP}feature`;
    const linked = `${root}${SEP}linked-wt`;
    const scratch = `${root}${SEP}scratch-1234`;
    const other = `${root}${SEP}Other`;
    const muted = `${root}${SEP}Quiet`;
    const hidden = `${root}${SEP}Hidden`;
    for (const d of [repo, claudeWt, linked, scratch, other, muted, hidden]) Deno.mkdirSync(d, { recursive: true });
    Deno.mkdirSync(`${repo}${SEP}.git${SEP}worktrees${SEP}linked-wt`, { recursive: true });
    // a git worktree folder elsewhere: its .git is a FILE pointing into <repo>/.git/worktrees/<name>
    Deno.writeTextFileSync(`${linked}${SEP}.git`, `gitdir: ${repo}${SEP}.git${SEP}worktrees${SEP}linked-wt\n`);
    const key = (p: string) => RULES.pathKey(p);
    const prefs = {
      projects: {
        [key(muted)]: { name: '', color: '', hidden: false, muted: true },
        [key(hidden)]: { name: '', color: '', hidden: true },
      },
    };
    const marks: Json = {
      'claude:archived': { archivedAt: 5 },
      'claude:deleted': { deletedAt: 5 },
      'claude:held': { holdAt: 5 },
    };
    const chat = (sessionId: string, cwd: string, projectRoot?: string): Json => ({
      id: 'c-' + sessionId,
      provider: 'claude',
      sessionId,
      cwd,
      projectRoot: projectRoot ?? cwd,
    });
    const chats = [
      chat('plain', other),
      chat('archived', other),
      chat('deleted', other),
      chat('held', other),
      chat('muted', muted),
      chat('hidden', hidden),
      chat('scratch', scratch),
      chat('claude-wt', claudeWt), // a .claude/worktrees chat: filed under its repository, as on the page
      chat('linked-wt', linked),
      chat('sub-folder', `${other}${SEP}src`, other),
      chat('windows-case', other.toUpperCase()),
    ];
    const watcher = new AttentionWatcher(
      {
        host: {} as never,
        conversations: { public: () => ({ entries: marks }) } as never,
        projectPrefs: { public: () => prefs } as never,
        viewPrefs: { public: () => ({ prefs: {} }) } as never,
      },
      { stateDir: null, onFire: () => {} },
    );
    const rows: [string, Json, Json][] = [];
    for (const c of chats) {
      const server = RULES.flags(watcher.facts(c, marks), prefs) as unknown as Json;
      rows.push([String(c.sessionId), pageFlags(page, c, marks, prefs), server]);
    }
    for (const [name, mine, theirs] of rows) assertEquals(theirs, mine, name);
    // and the answers themselves (what the rules say, not only that both sides agree)
    const by = Object.fromEntries(rows.map(([n, , s]) => [n, s]));
    const may = (n: string) => RULES.notifies('needs', by[n] as never);
    const finished = (n: string) => RULES.notifies('turn', by[n] as never);
    assertEquals(
      ['plain', 'archived', 'deleted', 'held', 'muted', 'hidden', 'scratch', 'sub-folder'].map((n) => [n, may(n), finished(n)]),
      [
        ['plain', true, true],
        ['archived', false, false],
        ['deleted', false, false],
        ['held', true, false], // a parked chat: its question still notifies, "finished" does not
        ['muted', false, false],
        ['hidden', false, false],
        ['scratch', false, false],
        ['sub-folder', true, true],
      ],
    );
    // A worktree folder whose repository AIB cannot name (an unknown .git/worktrees target) is not a project: no notification.
    assertEquals((by['linked-wt'] as Json).eligible, (pageFlags(page, chats[8], marks, prefs) as Json).eligible);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test('notification rules: the desktop app choices, the 60 s groups and the push text', () => {
  const app = RULES.appPrefs(undefined);
  assertEquals(app, { desktop: true, sound: 'needs', notifyFor: 'needs' }, 'the app starts on, Needs you only');
  assertEquals([RULES.desktopWants('needs', app), RULES.desktopWants('turn', app)], [true, false]);
  const both = RULES.appPrefs(JSON.stringify({ notifyFor: 'both' }));
  assertEquals([RULES.desktopWants('needs', both), RULES.desktopWants('turn', both)], [true, true]);
  assertEquals(RULES.desktopWants('needs', RULES.appPrefs('{"desktop":false}')), false);
  assertEquals(RULES.appPrefs('not json').notifyFor, 'needs');

  let g1 = RULES.addToGroup(null, [{ key: 'claude:a', title: 'Blog', kind: 'needs', chat: 'c1' }], 1000).group;
  assertEquals(RULES.describe(g1), {
    tag: 'studio-attention',
    title: 'Blog',
    body: 'Needs you',
    target: { type: 'chat', key: 'claude:a' },
  });
  assertEquals(RULES.pushText(g1), { title: 'A chat needs you', body: 'Blog', tag: 'aib-attention', chat: 'c1', sheet: true });
  g1 = RULES.addToGroup(g1, [{ key: 'claude:b', title: 'Shop', kind: 'turn', chat: 'c2' }], 30_000).group;
  assertEquals(RULES.describe(g1).title, '2 agents are waiting for you');
  assertEquals(RULES.pushText(g1), {
    title: '2 chats are waiting for you',
    body: 'Blog\nShop',
    tag: 'aib-attention',
    chat: 'c1',
    sheet: true,
  });
  const later = RULES.addToGroup(g1, [{ key: 'claude:c', title: 'Docs', kind: 'turn', chat: 'c3' }], 30_000 + 61_000).group;
  assertEquals(
    RULES.pushText(later),
    { title: 'Chat finished', body: 'Docs', tag: 'aib-attention', chat: 'c3', sheet: false },
    'a new group after 60 s',
  );
});

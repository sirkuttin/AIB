/**
 * Local-only folders and agents (architect review breaks 5, 8 and 9; owner decisions 2a, 5a, Q4 a): what a chat is told about
 * aib-shared/ (Connection.localOnlyText, appended to the ACP system prompt), the extra writable folders a worktree chat gets
 * (ACP `additionalDirectories`, only for agents that advertise it), and the host side (host/aib.ts): the default `/aib-shared`
 * exclude before the chat's copy is made, the main folder's aib-shared/ and the copy's link to it for a worktree chat, and nothing
 * at all for a project that commits aib-shared/. Fake ACP agent only; temp repos and temp state folders only.
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, until } from './_connection.ts';
import { withEnv } from './_agents.ts';
import { runGit, Sandbox, write } from './_worktree_fixtures.ts';
import {
  ARTIFACT_PROMPT,
  Connection,
  LOCAL_ONLY_WORKTREE_PROMPT,
  SHARED_FOLDER_PROMPT,
} from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { TESTS_DIR } from '../../app/server/core/app.ts';
import { artifactToolCommand } from '../../app/server/artifacts/mcp.ts';
import { BLOCK_START } from '../../app/server/worktrees/local_only.ts';
import { join, SEP } from '../../app/server/platform/ospath.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };

const BOTH = { agentCapabilities: { sessionCapabilities: { systemPrompt: {}, additionalDirectories: {} } } };
const PROMPT_ONLY = { agentCapabilities: { sessionCapabilities: { systemPrompt: {} } } };
const NEITHER = { agentCapabilities: { sessionCapabilities: {} } };
const MAIN = Deno.build.os === 'windows' ? 'C:\\work\\proj' : '/work/proj';
const SHARED = join(MAIN, 'aib-shared');
const NOTES = join(MAIN, 'notes');

function connection(initial: unknown, worktree: boolean, localOnly: Connection['localOnly']): Connection {
  const c = new Connection([`${TESTS_DIR}${SEP}combined-fixture${SEP}agent.mjs`], Deno.cwd(), 'claude', { start: false } as never);
  c.initial = initial;
  if (worktree) c.worktree = { branch: 'studio/chat-1', base: 'main' };
  c.localOnly = localOnly;
  return c;
}

const texts = (out: Json) => (((out.systemPrompt as Json | undefined)?.content ?? []) as Json[]).map((x) => String(x.text));

// ---- the connection (unit) -------------------------------------------------------------------------------------------------------
Deno.test('local only: a worktree chat is told about aib-shared/ and the other main folder paths; it gets them as extra folders', () => {
  const lo = { entries: [SHARED, NOTES], dirs: [SHARED], shared: SHARED };
  const c = connection(BOTH, true, lo);
  const text = c.localOnlyText();
  assertEquals(text, SHARED_FOLDER_PROMPT + ' ' + LOCAL_ONLY_WORKTREE_PROMPT.replace('{paths}', NOTES));
  assertEquals(SHARED_FOLDER_PROMPT, 'aib-shared/ in the project folder is shared by every agent and chat, never committed.');
  assert(text.includes(NOTES) && text.includes('not in this copy') && !text.includes(SHARED), 'aib-shared/ is in the copy too (its link)');
  const own = [{ name: 'studio_artifact', ...artifactToolCommand() }];
  const out = c.artifactPrompt(own) as Json;
  assertEquals(texts(out)[0], ARTIFACT_PROMPT);
  assertEquals(texts(out).at(-1), text, 'after the artifact and worktree notes');
  assertEquals(texts(c.artifactPrompt([]) as Json), [text], 'sent even when the chat has no artifact tool');
  assertEquals(c.extraFolders(), { additionalDirectories: [SHARED] }, 'only existing folders, never the main folder itself');
});

Deno.test('local only: a main-folder chat gets the aib-shared/ wording and no extra folder', () => {
  const c = connection(BOTH, false, { entries: [SHARED], dirs: [SHARED], shared: SHARED });
  assertEquals(c.localOnlyText(), SHARED_FOLDER_PROMPT);
  assertEquals(texts(c.artifactPrompt([]) as Json), [SHARED_FOLDER_PROMPT]);
  assertEquals(c.extraFolders(), {}, 'the folders are inside its own folder already');
});

Deno.test('local only: aib-shared/ not ignored (tracked, negated, off) means no aib-shared/ text; nothing known means no change at all', () => {
  const told = connection(BOTH, true, { entries: [NOTES], dirs: [NOTES], shared: '' });
  assertEquals(told.localOnlyText(), LOCAL_ONLY_WORKTREE_PROMPT.replace('{paths}', NOTES));
  assert(!told.localOnlyText().includes('aib-shared'));
  assertEquals(connection(BOTH, false, { entries: [NOTES], dirs: [NOTES], shared: '' }).localOnlyText(), '');
  for (const worktree of [true, false]) {
    const none = connection(BOTH, worktree, null);
    assertEquals([none.localOnlyText(), none.artifactPrompt([]), none.extraFolders()], ['', {}, {}]);
  }
});

Deno.test('local only: agents that advertise neither capability get no note and no field; system prompt alone gets the note only', () => {
  const lo = { entries: [SHARED], dirs: [SHARED], shared: SHARED };
  const bare = connection(NEITHER, true, lo);
  assertEquals([bare.artifactPrompt([]), bare.extraFolders()], [{}, {}]);
  const promptOnly = connection(PROMPT_ONLY, true, lo);
  assertEquals(texts(promptOnly.artifactPrompt([]) as Json).length, 1);
  assertEquals(promptOnly.extraFolders(), {});
  const notADict = connection({ agentCapabilities: { sessionCapabilities: { additionalDirectories: true } } }, true, lo);
  assertEquals(notADict.extraFolders(), {}, 'presence of a capability object is support; true is not one');
});

// ---- through the host (E2E-3 and E2E-10) -----------------------------------------------------------------------------------------
class Host {
  readonly box = new Sandbox();
  readonly log = join(this.box.base, 'agent.log');
  readonly aibs: Aib[] = [];
  readonly #restore = withEnv({ FAKE_ACP_LOG: this.log });

  aib(flags: string[]): Aib {
    const aib = new Aib({ claudeLauncher: import.meta.filename!, nodeCommand: 'node', stateDir: this.box.state, port: 0 });
    aib.ownerProbe = () => null;
    aib.settings.worktreePerChat = () => true;
    aib.connectionFactory = (_command, cwd, provider, options) => new Connection(fake(...flags), cwd, provider, options);
    this.aibs.push(aib);
    return aib;
  }

  /** The params of every `method` call the agents received, in order. */
  received(method: string): Json[] {
    let text = '';
    try {
      text = Deno.readTextFileSync(this.log);
    } catch { /* nothing yet */ }
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.method === method).map((m) => m.params);
  }

  exclude(): string {
    try {
      return Deno.readTextFileSync(join(this.box.project, '.git', 'info', 'exclude'));
    } catch {
      return '';
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const s of this.aibs.reverse()) await s.close().catch(() => {});
    this.#restore();
    this.box[Symbol.dispose]();
  }
}

const systemTexts = (params: Json) => texts(params);

Deno.test({
  name: 'local only (host): a worktree chat gets /aib-shared excluded first, the link to the main aib-shared/, the grant and the note, on new and load',
  ...T,
  async fn() {
    await using host = new Host();
    const p = host.box.project;
    write(p, 'aib-shared/old.md', 'notes made before AIB\n'); // must not reach the copy's snapshot: the exclude comes first
    const aib = host.aib(['--extra-dirs']);
    const c = await aib.connect('claude', p, null, { ownCopy: true });
    await until(() => c.ready, 'the chat is ready', 30);
    assert(c.worktree, 'a worktree chat');
    assert(host.exclude().includes(BLOCK_START) && host.exclude().includes('\n/aib-shared\n'), host.exclude());
    const sharedDir = join(p, 'aib-shared');
    assert(Deno.statSync(sharedDir).isDirectory);
    assert(!runGit(c.cwd, 'ls-files').includes('aib-shared/'), 'aib-shared/ was excluded before the snapshot');
    assert(Deno.lstatSync(join(c.cwd, 'aib-shared')).isSymlink, 'the copy has the link, not a copy');
    assertEquals(Deno.readTextFileSync(join(c.cwd, 'aib-shared', 'old.md')), 'notes made before AIB\n');
    Deno.writeTextFileSync(join(c.cwd, 'aib-shared', 'from-chat.md'), 'chat\n');
    assertEquals(Deno.readTextFileSync(join(sharedDir, 'from-chat.md')), 'chat\n', 'written through the link: in the main folder at once');
    assert(!runGit(c.cwd, 'status', '--porcelain', '--untracked-files=all').includes('aib-shared'), 'git shows nothing of it');
    const made = host.received('session/new');
    assertEquals(made.length, 1);
    assertEquals(made[0].additionalDirectories, [sharedDir, c.scratchDir], 'and the scratch folder of the chat (allow rules), outside the worktree');
    assert(systemTexts(made[0]).some((t) => t.includes('House rules from AIB') && t.includes(c.scratchDir!)), 'the brief has the literal scratch path');
    const note = systemTexts(made[0]).at(-1)!;
    assertEquals(note, SHARED_FOLDER_PROMPT);
    const sessionId = c.sessionId!;
    await aib.close();

    const again = host.aib(['--extra-dirs']);
    const reopened = await again.connect('claude', p, sessionId);
    await until(() => reopened.ready, 'the chat is reopened', 30);
    const loaded = host.received('session/load');
    assertEquals(loaded.length, 1);
    assertEquals(loaded[0].additionalDirectories, [sharedDir, reopened.scratchDir], 'session/load carries the grant too');
    assertEquals(systemTexts(loaded[0]).at(-1), SHARED_FOLDER_PROMPT);
    assert(Deno.lstatSync(join(reopened.cwd, 'aib-shared')).isSymlink, 'the reused copy keeps its link');
  },
});

Deno.test({
  name: 'local only (host): an agent without the capabilities gets no field and no note; a main-folder chat gets the aib-shared/ wording',
  ...T,
  async fn() {
    await using host = new Host();
    const plain = await host.aib([]).connect('claude', host.box.project);
    await until(() => plain.ready, 'the chat is ready', 30);
    const params = host.received('session/new')[0];
    assert(!('additionalDirectories' in params) && !('systemPrompt' in params), JSON.stringify(params));
    await host.aibs[0].close();

    const inPlace = host.aib(['--extra-dirs']);
    inPlace.settings.worktreePerChat = () => false;
    const c = await inPlace.connect('claude', host.box.project);
    await until(() => c.ready, 'the chat is ready', 30);
    assertEquals(c.worktree, null);
    const second = host.received('session/new')[1];
    assertEquals(second.additionalDirectories, [c.scratchDir], 'only the scratch folder (allow rules)');
    assertEquals(systemTexts(second).at(-1), SHARED_FOLDER_PROMPT);
  },
});

Deno.test({
  name: 'local only (host): a project that commits aib-shared/ gets no AIB line, no aib-shared/ text and no grant',
  ...T,
  async fn() {
    await using host = new Host();
    const p = host.box.project;
    write(p, 'aib-shared/a.md', 'committed\n');
    runGit(p, 'add', '-A');
    runGit(p, 'commit', '-q', '-m', 'aib-shared is part of this project');
    const before = host.exclude();
    const c = await host.aib(['--extra-dirs']).connect('claude', p);
    await until(() => c.ready, 'the chat is ready', 30);
    assertEquals(host.exclude(), before, 'the exclude file is untouched');
    const params = host.received('session/new')[0];
    assertEquals(params.additionalDirectories, [c.scratchDir], 'only the scratch folder (allow rules)');
    assert(!systemTexts(params).some((t) => t.includes('aib-shared')), JSON.stringify(systemTexts(params)));
    assertEquals(c.localOnly, null);
  },
});

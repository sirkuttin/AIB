/**
 * Local-only folders and agents (architect review breaks 5, 8 and 9; owner decisions 2a, 5a, Q4 a): what a chat is told about
 * private/ (Connection.localOnlyText, appended to the ACP system prompt), the extra writable folders a worktree chat gets
 * (ACP `additionalDirectories`, only for agents that advertise it), and the host side (host/studio.ts): the default `/private`
 * exclude before the chat's copy is made, an empty private/ in the main folder for a worktree chat, and nothing at all for a project
 * that commits private/. Fake ACP agent only; temp repos and temp state folders only.
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, until } from './_connection.ts';
import { withEnv } from './_agents.ts';
import { runGit, Sandbox, write } from './_worktree_fixtures.ts';
import {
  ARTIFACT_PROMPT,
  Connection,
  LOCAL_ONLY_PROMPT,
  LOCAL_ONLY_WORKTREE_PROMPT,
} from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { TESTS_DIR } from '../../outputs/agent-studio/server/core/app.ts';
import { artifactToolCommand } from '../../outputs/agent-studio/server/artifacts/mcp.ts';
import { BLOCK_START } from '../../outputs/agent-studio/server/worktrees/local_only.ts';
import { join, SEP } from '../../outputs/agent-studio/server/platform/ospath.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };

const BOTH = { agentCapabilities: { sessionCapabilities: { systemPrompt: {}, additionalDirectories: {} } } };
const PROMPT_ONLY = { agentCapabilities: { sessionCapabilities: { systemPrompt: {} } } };
const NEITHER = { agentCapabilities: { sessionCapabilities: {} } };
const MAIN = Deno.build.os === 'windows' ? 'C:\\work\\proj' : '/work/proj';
const PRIVATE = join(MAIN, 'private');
const NOTES = join(MAIN, 'notes');

function connection(initial: unknown, worktree: boolean, localOnly: Connection['localOnly']): Connection {
  const c = new Connection([`${TESTS_DIR}${SEP}combined-fixture${SEP}agent.py`], Deno.cwd(), 'omp', { start: false } as never);
  c.initial = initial;
  if (worktree) c.worktree = { branch: 'studio/chat-1', base: 'main' };
  c.localOnly = localOnly;
  return c;
}

const texts = (out: Json) => (((out.systemPrompt as Json | undefined)?.content ?? []) as Json[]).map((x) => String(x.text));

// ---- the connection (unit) -------------------------------------------------------------------------------------------------------
Deno.test('local only: a worktree chat is told the main folder paths and may use the main private/; it gets them as extra folders', () => {
  const lo = { entries: [PRIVATE, NOTES], dirs: [PRIVATE], private: PRIVATE };
  const c = connection(BOTH, true, lo);
  const text = c.localOnlyText();
  assertEquals(
    text,
    LOCAL_ONLY_WORKTREE_PROMPT.replace('{paths}', `${PRIVATE}, ${NOTES}`) + ` You may create and use ${PRIVATE} for local-only notes.`,
  );
  assert(text.includes(PRIVATE) && text.includes('not in this copy'), text);
  const own = [{ name: 'studio_artifact', ...artifactToolCommand() }];
  const out = c.artifactPrompt(own) as Json;
  assertEquals(texts(out)[0], ARTIFACT_PROMPT);
  assertEquals(texts(out).at(-1), text, 'after the artifact and worktree notes');
  assertEquals(texts(c.artifactPrompt([]) as Json), [text], 'sent even when the chat has no artifact tool');
  assertEquals(c.extraFolders(), { additionalDirectories: [PRIVATE] }, 'only existing folders, never the main folder itself');
});

Deno.test('local only: a main-folder chat gets the private/ wording and no extra folder', () => {
  const c = connection(BOTH, false, { entries: [PRIVATE], dirs: [PRIVATE], private: PRIVATE });
  assertEquals(c.localOnlyText(), LOCAL_ONLY_PROMPT);
  assertEquals(texts(c.artifactPrompt([]) as Json), [LOCAL_ONLY_PROMPT]);
  assertEquals(c.extraFolders(), {}, 'the folders are inside its own folder already');
});

Deno.test('local only: private/ not ignored (tracked, negated, off) means no private/ text; nothing known means no change at all', () => {
  const told = connection(BOTH, true, { entries: [NOTES], dirs: [NOTES], private: '' });
  assertEquals(told.localOnlyText(), LOCAL_ONLY_WORKTREE_PROMPT.replace('{paths}', NOTES));
  assert(!told.localOnlyText().includes('You may create'));
  assertEquals(connection(BOTH, false, { entries: [NOTES], dirs: [NOTES], private: '' }).localOnlyText(), '');
  for (const worktree of [true, false]) {
    const none = connection(BOTH, worktree, null);
    assertEquals([none.localOnlyText(), none.artifactPrompt([]), none.extraFolders()], ['', {}, {}]);
  }
});

Deno.test('local only: agents that advertise neither capability get no note and no field; system prompt alone gets the note only', () => {
  const lo = { entries: [PRIVATE], dirs: [PRIVATE], private: PRIVATE };
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
  readonly studios: Studio[] = [];
  readonly #restore = withEnv({ FAKE_ACP_LOG: this.log });

  studio(flags: string[]): Studio {
    const studio = new Studio({ ompCommand: 'unused', stateDir: this.box.state, port: 0 });
    studio.ownerProbe = () => null;
    studio.settings.worktreePerChat = () => true;
    studio.connectionFactory = (_command, cwd, provider, options) => new Connection(fake(...flags), cwd, provider, options);
    this.studios.push(studio);
    return studio;
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
    for (const s of this.studios.reverse()) await s.close().catch(() => {});
    this.#restore();
    this.box[Symbol.dispose]();
  }
}

const systemTexts = (params: Json) => texts(params);

Deno.test({
  name: 'local only (host): a worktree chat gets /private excluded first, an empty main private/, the grant and the note, on new and load',
  ...T,
  async fn() {
    await using host = new Host();
    const p = host.box.project;
    write(p, 'private/old.md', 'notes made before AIB\n'); // must not reach the copy's snapshot: the exclude comes first
    const studio = host.studio(['--extra-dirs']);
    const c = await studio.connect('omp', p);
    await until(() => c.ready, 'the chat is ready', 30);
    assert(c.worktree, 'a worktree chat');
    assert(host.exclude().includes(BLOCK_START) && host.exclude().includes('/private'), host.exclude());
    const privateDir = join(p, 'private');
    assert(Deno.statSync(privateDir).isDirectory);
    assert(!runGit(c.cwd, 'ls-files').includes('private/'), 'private/ was excluded before the snapshot');
    const made = host.received('session/new');
    assertEquals(made.length, 1);
    assertEquals(made[0].additionalDirectories, [privateDir]);
    const note = systemTexts(made[0]).at(-1)!;
    assert(note.includes(privateDir) && note.includes('not in this copy'), note);
    const sessionId = c.sessionId!;
    await studio.close();

    const again = host.studio(['--extra-dirs']);
    const reopened = await again.connect('omp', p, sessionId);
    await until(() => reopened.ready, 'the chat is reopened', 30);
    const loaded = host.received('session/load');
    assertEquals(loaded.length, 1);
    assertEquals(loaded[0].additionalDirectories, [privateDir], 'session/load carries the grant too');
    assert(systemTexts(loaded[0]).at(-1)!.includes(privateDir));
  },
});

Deno.test({
  name: 'local only (host): an agent without the capabilities gets no field and no note; a main-folder chat gets the private/ wording',
  ...T,
  async fn() {
    await using host = new Host();
    const plain = await host.studio([]).connect('omp', host.box.project);
    await until(() => plain.ready, 'the chat is ready', 30);
    const params = host.received('session/new')[0];
    assert(!('additionalDirectories' in params) && !('systemPrompt' in params), JSON.stringify(params));
    await host.studios[0].close();

    const inPlace = host.studio(['--extra-dirs']);
    inPlace.settings.worktreePerChat = () => false;
    const c = await inPlace.connect('omp', host.box.project);
    await until(() => c.ready, 'the chat is ready', 30);
    assertEquals(c.worktree, null);
    const second = host.received('session/new')[1];
    assert(!('additionalDirectories' in second));
    assertEquals(systemTexts(second).at(-1), LOCAL_ONLY_PROMPT);
  },
});

Deno.test({
  name: 'local only (host): a project that commits private/ gets no AIB line, no private/ text and no grant',
  ...T,
  async fn() {
    await using host = new Host();
    const p = host.box.project;
    write(p, 'private/a.md', 'committed\n');
    runGit(p, 'add', '-A');
    runGit(p, 'commit', '-q', '-m', 'private is part of this project');
    const before = host.exclude();
    const c = await host.studio(['--extra-dirs']).connect('omp', p);
    await until(() => c.ready, 'the chat is ready', 30);
    assertEquals(host.exclude(), before, 'the exclude file is untouched');
    const params = host.received('session/new')[0];
    assert(!('additionalDirectories' in params));
    assert(!systemTexts(params).some((t) => t.includes('private')), JSON.stringify(systemTexts(params)));
    assertEquals(c.localOnly, null);
  },
});

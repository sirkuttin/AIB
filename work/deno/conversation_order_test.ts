/**
 * The left list's manual order (drag to reorder), the server side: the stored rank per chat, per section, kept after a restart,
 * seen by another writer, refused for bad keys, and sent to the phone as one list order (Pinned, Chats, On hold).
 *
 * Run (from app): deno test -A ../work/deno/conversation_order_test.ts
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { ConversationState } from '../../app/server/state/conversations.ts';
import { conversationAction } from '../../app/server/web/shared.ts';

const tempDir = () => Deno.makeTempDirSync({ prefix: 'aib-order-' });
const rankOf = (s: ConversationState, key: string) => s.public().entries[key]?.rank;

Deno.test('conversation order: reorder stores ranks 1..n, other chats keep theirs, and it survives a restart', async () => {
  const dir = tempDir();
  try {
    const a = new ConversationState(dir);
    await a.apply('pin', 'claude', 's-pinned');
    await a.reorder(['claude:s3', 'codex:s1', 'claude:s2']);
    assertEquals([rankOf(a, 'claude:s3'), rankOf(a, 'codex:s1'), rankOf(a, 'claude:s2')], [1, 2, 3]);
    assertEquals(rankOf(a, 'claude:s-pinned'), undefined, 'a chat outside the list keeps no rank');
    await a.reorder(['claude:s-pinned']); // another section is ranked on its own
    assertEquals(rankOf(a, 'claude:s-pinned'), 1);
    assertEquals(rankOf(a, 'claude:s3'), 1, 'the other section is untouched');
    assert(a.public().entries['claude:s-pinned'].pinnedAt > 0, 'the pin is kept');
    await a.reorder(['claude:s2', 'claude:s3']);
    assertEquals([rankOf(a, 'claude:s2'), rankOf(a, 'claude:s3'), rankOf(a, 'codex:s1')], [1, 2, 2]);

    const b = new ConversationState(dir); // a restart, or another AIB on the state folder
    assertEquals([rankOf(b, 'claude:s2'), rankOf(b, 'claude:s3')], [1, 2]);
    assert(b.public().revision !== '', 'a revision for other windows');
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('conversation order: another writer sees the new order (the revision changes)', async () => {
  const dir = tempDir();
  try {
    const a = new ConversationState(dir);
    const b = new ConversationState(dir);
    const before = b.public().revision;
    await a.reorder(['claude:x', 'claude:y']);
    const seen = b.public();
    assert(seen.revision !== before);
    assertEquals(seen.entries['claude:y'].rank, 2);
    const same = a.public().revision;
    await a.reorder(['claude:x', 'claude:y']); // nothing changes: no new revision
    assertEquals(a.public().revision, same);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('conversation order: bad keys are refused and nothing is saved', async () => {
  const dir = tempDir();
  try {
    const s = new ConversationState(dir);
    for (const bad of [null, [], 'claude:a', [5], ['nope'], ['claude:ok', 'zzz-not-a-provider:a'], ['claude:a\nb']]) {
      await assertRejects(() => s.reorder(bad as never));
    }
    await assertRejects(() => s.reorder(Array.from({ length: 501 }, (_, i) => `claude:s${i}`)));
    assertEquals(s.public().entries, {});
    await s.reorder(['claude:a', 'claude:a', 'claude:b']); // a repeated key counts once
    assertEquals([rankOf(s, 'claude:a'), rankOf(s, 'claude:b')], [1, 2]);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('conversation order: the conversation-state route takes action reorder; the phone sees one list rank (Pinned, Chats, On hold)', async () => {
  const dir = tempDir();
  try {
    const s = new ConversationState(dir);
    await s.apply('pin', 'claude', 'p1');
    await s.apply('hold', 'claude', 'h1');
    const self = { conversations: s, aibOwns: () => false, liveCall: () => [200, {}], liveList: () => ({}) };
    const reply = await conversationAction(self as never, { action: 'reorder', keys: ['claude:m1', 'claude:m2', 'claude:p1', 'claude:h1'] });
    assertEquals(reply[0], 200);
    const e = s.public().entries;
    const phone = (k: string) => ConversationState.listRank(e[k]);
    assert(phone('claude:p1') < phone('claude:m1'), 'pinned first');
    assert(phone('claude:m1') < phone('claude:m2'), 'then by rank');
    assert(phone('claude:m2') < phone('claude:h1'), 'on hold last');
    assertEquals(ConversationState.listRank(undefined), 0, 'never placed by hand: no rank, lists first');
    await assertRejects(() => conversationAction(self as never, { action: 'reorder', keys: 'x' }));
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

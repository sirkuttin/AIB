/**
 * AIB's own lines are history (owner rule, 2026-11-17): a CLOSED chat's read-only view, built from the agent's saved transcript,
 * shows the conversation's kept lines (history/lines.ts: "turn finished · time" dividers, AIB notes) after their own turns, in
 * order, with their own time, on the PC (the saved-chat view, /api/transcript pages) and on the phone (the saved chat screen,
 * /api/remote/saved). Each line comes once, also when the history is read page by page.
 *
 * An in-process AIB with a real saved Claude Code transcript and a conversation-lines file, a fake agent host, and a headless
 * Chrome (no window) for the PC page and the phone page.
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath } from './_doc_browser.ts';
import { pairPhone, pc } from './_remote_fixture.ts';
import { phoneCall, v2Studio } from './_remote_v2b.ts';
import { phonePage, tap } from './_remote_phone_page.ts';
import { placeLines } from '../../outputs/agent-studio/server/history/lines.ts';
import { withKeptLines } from '../../outputs/agent-studio/server/remote/saved.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const SID = 'sess-closed-1';
const T0 = Math.floor(Date.now() / 1000) - 3600;

/** A closed chat of three turns, and AIB's lines of it as the ledger keeps them (each after the user message of its turn). */
function seed(s: Awaited<ReturnType<typeof v2Studio>>): void {
  const at = (m: number) => new Date((T0 + m * 60) * 1000).toISOString();
  const base = { sessionId: SID, cwd: s.project };
  const user = (text: string, m: number) => ({ type: 'user', ...base, timestamp: at(m), message: { role: 'user', content: text } });
  const said = (text: string, m: number) => ({
    type: 'assistant',
    ...base,
    timestamp: at(m),
    message: { role: 'assistant', model: 'fixture', content: [{ type: 'text', text }] },
  });
  s.saveChat({
    sessionId: SID,
    ageSeconds: 600,
    rows: [
      user('Fix the cart total', 0),
      said('CART-FIXED in src/cart.ts.', 1),
      user('Now run the tests', 3),
      said('TESTS-PASS: 41 passed.', 4),
      user('Write the release note', 6),
      said('NOTE-WRITTEN in CHANGELOG.md.', 7),
    ],
  });
  const lines = [
    { kind: 'turn_end', data: { stopReason: 'end_turn' }, time: T0 + 2 * 60, after: 'Fix the cart total' },
    {
      kind: 'studio_note',
      data: { message: 'Merged subagent “cart-fix” into main · 2 files', kind: 'swarm-merged', actions: [{ id: 'swarm-undo', helper: 'h1' }] },
      time: T0 + 2 * 60 + 5,
      after: 'Fix the cart total',
    },
    { kind: 'turn_end', data: { stopReason: 'end_turn' }, time: T0 + 5 * 60, after: 'Now run the tests' },
    { kind: 'studio_note', data: { message: 'Didn’t land “docs-pass”: it changed nothing' }, time: T0 + 8 * 60 + 5, after: 'Write the release note' },
    { kind: 'turn_end', data: { stopReason: 'cancelled' }, time: T0 + 8 * 60, after: 'Write the release note' },
  ];
  const dir = `${s.state}${SEP}conversation-lines`;
  Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(`${dir}${SEP}claude_${SID}.jsonl`, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

/** The story the reader sees: the words of each message and line, in order. */
const STORY = [
  'Fix the cart total',
  'CART-FIXED',
  'turn finished',
  'cart-fix',
  'Now run the tests',
  'TESTS-PASS',
  'turn finished',
  'Write the release note',
  'NOTE-WRITTEN',
  'Didn’t land',
  'cancelled',
];

/** Each STORY word's place in `text`, in order (-1: not found after the one before). */
function inOrder(text: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (const w of STORY) {
    const i = text.indexOf(w, from);
    out.push(i);
    if (i >= 0) from = i + w.length;
  }
  return out;
}

Deno.test({
  ...OPTS,
  name: 'placeLines: each line after its own turn (before the next user message, or at the end); unknown turns left out',
  fn() {
    const events = [
      { kind: 'user', text: 'one' },
      { kind: 'assistant', text: 'a' },
      { kind: 'tool' },
      { kind: 'user', text: 'two' },
      { kind: 'assistant', text: 'b' },
    ];
    const line = (after: string, kind = 'turn_end') => ({ kind, data: {}, time: 1, after });
    const placed = placeLines(events, [line('gone'), line('one'), line('one', 'studio_note'), line('two')]);
    assertEquals(placed.map((l) => [l.n, l.at]), [[1, 3], [2, 3], [3, 5]]);
    // phone seqs: between the transcript events around them, never a whole number; a note's buttons left out
    const shaped = withKeptLines(
      [{ seq: 1, kind: 'user' }, { seq: 3, kind: 'update' }, { seq: 4, kind: 'user' }],
      placed.map((l) => ({ ...l, data: { actions: [1], message: 'x' } })),
      0,
    );
    assertEquals(shaped.map((e) => e.seq), [1, 3, 3.5, 3.501, 4, 5.5]);
    assert(shaped.every((e) => !(e.data as Json | undefined)?.actions));
  },
});

Deno.test({
  ...OPTS,
  name: 'a closed chat shows its turn ends and AIB notes from the ledger, in order, on the PC and on the phone',
  ignore: !browserPath,
  async fn() {
    const s = await v2Studio();
    const browser = await Browser.launch();
    try {
      seed(s);

      // ---- the PC's transcript pages: every line once, also page by page ----
      const [, list] = await pc(s, 'GET', '/api/sessions');
      const key = String(((list.sessions as Json[]).find((x) => x.id === SID) ?? {}).key ?? '');
      assert(key, JSON.stringify(list));
      const [status, whole] = await pc(s, 'GET', `/api/transcript?key=${encodeURIComponent(key)}&limit=120`);
      assertEquals(status, 200, JSON.stringify(whole));
      assertEquals((whole.lines as Json[]).map((l) => [l.kind, l.at]), [
        ['turn_end', 2],
        ['studio_note', 2],
        ['turn_end', 4],
        ['studio_note', 6],
        ['turn_end', 6],
      ]);
      assertEquals((whole.lines as Json[])[0].time, T0 + 120, 'its own time');
      const seen: number[] = [];
      for (let before = 6; before > 0; before -= 2) {
        const [, page] = await pc(s, 'GET', `/api/transcript?key=${encodeURIComponent(key)}&limit=2&before=${before}`);
        seen.push(...(page.lines as Json[]).map((l) => Number(l.n)));
      }
      assertEquals(seen.sort(), [0, 1, 2, 3, 4], 'pages carry each line once');
      const [, filtered] = await pc(s, 'GET', `/api/transcript?key=${encodeURIComponent(key)}&q=cart`);
      assertEquals(filtered.lines, undefined, 'a search shows no lines');

      // ---- the phone's saved chat: as live events, lines in place, Load earlier joins up ----
      const phone = await pairPhone(s);
      const one = await phoneCall(s, phone.token, 'GET', `/api/remote/saved?key=claude:${SID}&tail=50`);
      assertEquals(one.status, 200, one.text);
      const kinds = (one.json.events as Json[]).map((e) => e.kind === 'update' ? 'agent' : String(e.kind));
      assertEquals(kinds, ['user', 'agent', 'turn_end', 'studio_note', 'user', 'agent', 'turn_end', 'user', 'agent', 'studio_note', 'turn_end']);
      const note = (one.json.events as Json[]).find((e) => e.kind === 'studio_note')!;
      assertEquals(note.time, T0 + 125);
      assertEquals((note.data as Json).actions, undefined, 'no Undo on a closed chat');
      const tail = await phoneCall(s, phone.token, 'GET', `/api/remote/saved?key=claude:${SID}&tail=2`);
      const last = tail.json.events as Json[];
      assertEquals(last.map((e) => e.kind), ['user', 'update', 'studio_note', 'turn_end']);
      assertEquals(tail.json.firstSeq, 5);
      const older = await phoneCall(s, phone.token, 'GET', `/api/remote/saved?key=claude:${SID}&tail=2&before=5`);
      assertEquals((older.json.events as Json[]).map((e) => e.kind), ['user', 'update', 'turn_end']);
      assertEquals(older.json.firstSeq, 3);

      // ---- the PC page: the saved-chat view ----
      const page = await browser.open('about:blank', 1280, 900);
      await page.goto(`http://127.0.0.1:${s.port}/chat.html`);
      const row = `button.connection[data-key="claude:${SID}"]`;
      await page.waitFor(`!!document.querySelector(${JSON.stringify(row)})`, 20000, 'the saved chat in the sidebar');
      await page.click(row);
      await page.waitFor(`document.querySelectorAll('#messages .turn-divider').length === 3`, 20000, 'three turn ends');
      const pcText = await page.eval<string>(`document.getElementById('messages').textContent`);
      const pcOrder = inOrder(pcText);
      assert(pcOrder.every((i) => i >= 0), `PC order: ${JSON.stringify(STORY.map((w, i) => [w, pcOrder[i]]))}\n${pcText}`);
      const dividers = await page.eval<string[]>(`[...document.querySelectorAll('#messages .turn-divider')].map((d) => d.textContent)`);
      for (const d of dividers) assert(/ · \d{1,2}:\d{2}/.test(d), `a divider with its time: ${d}`);
      await page.shot('saved-chat-lines-pc');
      assertEquals(page.errors, [], 'PC console errors');
      await page.close();

      // ---- the phone page: the saved chat screen ----
      const ph = await phonePage(browser, s, phone);
      await tap(ph, `.ph-card.nr[data-saved="claude:${SID}"]`);
      await ph.waitFor(
        `document.getElementById("app").dataset.screen === "saved" && document.querySelectorAll(".ph-list .ph-turn").length === 3`,
        15000,
        'the saved chat with its turn ends',
      );
      const phText = await ph.eval<string>(`document.querySelector('.ph-list').textContent`);
      const phOrder = inOrder(phText);
      assert(phOrder.every((i) => i >= 0), `phone order: ${JSON.stringify(STORY.map((w, i) => [w, phOrder[i]]))}\n${phText}`);
      assertEquals(await ph.eval<number>(`document.querySelectorAll('.ph-list .ph-aibnote').length`), 2, 'both AIB notes');
      assertEquals(await ph.eval<number>(`document.querySelectorAll('.ph-list .ph-note-act').length`), 0, 'no Undo on a closed chat');
      const turns = await ph.eval<string[]>(`[...document.querySelectorAll('.ph-list .ph-turn')].map((d) => d.textContent)`);
      assert(turns[0].startsWith('turn finished · ') && turns[2].startsWith('cancelled · '), turns.join(' | '));
      await ph.shot('saved-chat-lines-phone');
      assertEquals(ph.errors, [], 'phone console errors');
      await ph.close();
    } finally {
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});

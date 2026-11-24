/**
 * Mark handled in the inbox for a WSL project's chat (owner report 2026-11-16: "I can't mark handled in the inbox notification for a
 * WSL project"). chat.html in a real headless Chrome against an AIB in this process whose fake agent host lists a Windows chat and
 * WSL chats (cwd `wsl://ubuntu/...`, listed with their distro and as saved sessions read in the distro): a failed turn, a reply that
 * asks something, and a finished turn. Clicking Mark handled (× on a finished row) clears each row, the mark is saved, and no row
 * comes back over the next polls.
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath } from './_doc_browser.ts';
import { remoteAib } from './_remote_fixture.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const REF = 'wsl://ubuntu/home/u/app';

Deno.test({
  ...OPTS,
  name: 'inbox: Mark handled clears a WSL chat (failed, asks, finished) as it does a Windows chat',
  ignore: !browserPath,
  async fn() {
    const s = await remoteAib();
    // the WSL chats are also saved sessions read in the distro (wsl/transcripts.ts distroSessions: key wsl.<distro>.<provider>/...)
    const saved = (n: number, title: string) => ({
      id: 'sess-' + n,
      sessionId: 'sess-' + n,
      provider: 'claude',
      providerName: 'Claude Code',
      key: `wsl.ubuntu.claude/-home-u-app/sess-${n}.jsonl`,
      cwd: REF,
      projectRoot: REF,
      title,
      name: title,
      created: 1,
      modified: 2,
      hasMessages: true,
      wsl: { distro: 'ubuntu', name: 'Ubuntu', linuxPath: '/home/u/app' },
    });
    s.ctx.transcripts = {
      root: s.state,
      sessions: () => Promise.resolve([saved(2, 'Linux failed'), saved(3, 'Linux finished'), saved(4, 'Linux asks')]),
      agents: () => Promise.resolve([]),
      sessionCwd: () => Promise.resolve(null),
    } as unknown as typeof s.ctx.transcripts;
    const chat = (n: number, title: string, cwd: string, attention: Json) => ({
      id: 'c' + n,
      provider: 'claude',
      sessionId: 'sess-' + n,
      cwd,
      projectRoot: cwd,
      busy: false,
      closed: false,
      attention,
      subagents: {},
      breadth: { sessionInfo: { title } },
      events: [{ seq: 1, kind: 'user', time: 1, data: { text: 'work on ' + title } }],
      permissions: [] as Json[],
      elicitations: [],
      ...(cwd.startsWith('wsl://') ? { wsl: { distro: 'ubuntu', name: 'Ubuntu', linuxPath: '/home/u/app' } } : {}),
    });
    const failed = (minutes: number) => ({
      state: 'idle',
      needs: 0,
      turnEndedAt: null,
      busySince: null,
      failedAt: new Date(Date.now() - minutes * 60_000).toISOString(),
      error: 'Usage limit reached. It resets at 3:40 PM.',
    });
    const idle = { state: 'idle', needs: 0, turnEndedAt: null, busySince: null };
    s.chats.push(
      chat(1, 'Windows failed', s.root, failed(5)),
      chat(2, 'Linux failed', REF, failed(4)),
      chat(3, 'Linux finished', REF, idle),
      chat(4, 'Linux asks', REF, {
        ...idle,
        asksAt: new Date(Date.now() - 3 * 60_000).toISOString(),
        question: 'Should I fix the first one?',
      }),
    );
    // the listing of a WSL chat names its distro (Connection.public: wsl), as the real agent host's does
    const backend = s.ctx.host as unknown as { liveList: () => Promise<Json> };
    const list = backend.liveList.bind(backend);
    backend.liveList = async () => {
      const out = await list();
      for (const c of out.connections as Json[]) {
        const fake = s.chats.find((x) => x.id === c.id) as Json | undefined;
        if (fake?.wsl) c.wsl = fake.wsl;
      }
      return out;
    };
    const marks = s.ctx.conversations;
    await marks.apply('your_turn', 'claude', 'sess-3');
    const browser = await Browser.launch();
    try {
      const page = await browser.open('about:blank', 1280, 900);
      await page.goto(`http://127.0.0.1:${s.port}/chat.html`);
      await page.waitFor('!!window.AgentWorkspaceUI && !!document.querySelector(".ws-inbox-btn .ws-badge")', 20000, 'the badge');
      await page.click('.ws-inbox-btn');
      await page.waitFor('!document.getElementById("wsInbox").hidden', 8000, 'inbox open');
      const rows = () => page.eval<string[]>('Array.from(document.querySelectorAll("#wsInbox .ws-inbox-item")).map((n) => n.dataset.key)');
      await page.waitFor('document.querySelectorAll("#wsInbox .ws-inbox-item").length === 4', 10000, 'four rows');
      for (const n of [1, 2, 4, 3]) {
        const key = 'claude:sess-' + n;
        const clicked = await page.eval<boolean>(`(() => {
          const r = document.querySelector('#wsInbox .ws-inbox-item[data-key="${key}"]');
          // a failed turn: Mark handled; a finished one (To review): the × that marks it read (the same markDone)
          const b = r && (r.querySelector('.ws-inbox-handled') || r.querySelector('.ws-qa-read'));
          if (!b || b.disabled) return false;
          b.click();
          return true;
        })()`);
        assert(clicked, `${key}: a Mark handled button to click (${JSON.stringify(await rows())})`);
        await page.waitFor(`!document.querySelector('#wsInbox .ws-inbox-item[data-key="${key}"]')`, 8000, `${key} cleared`);
        const entry = marks.public().entries[key];
        assert(entry && Number(entry.handledAt) > 0, `${key}: handledAt saved (${JSON.stringify(entry)})`);
        assertEquals(Number(entry.yourTurnAt), 0, `${key}: your turn cleared`);
      }
      // the rows stay gone over the next polls
      await new Promise((r) => setTimeout(r, 3000));
      assertEquals(await rows(), [], 'no row comes back');
      assertEquals(page.errors, [], 'console errors');
      await page.close();
    } finally {
      await browser.close();
      await s.close();
    }
  },
});

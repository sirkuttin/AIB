/**
 * The real app (server/main.ts serve, the same start-up path as the desktop app's server) on an empty data folder, with Claude Code
 * history in ~/.claude of a temp home folder (HOME / USERPROFILE point there; no --claude-projects flag, so the app finds it the
 * way it finds a user's). It must come up with no projects and no chats, and no start-up step may write an AIB history file.
 * Temp folders only; never the real ~/.claude or AIB data.
 */
import { assert, assertEquals } from './_assert.ts';
import { Fixture } from './_host_fixture.ts';

const SEP = Deno.build.os === 'windows' ? '\\' : '/';
/** Files only a used AIB writes. None may exist after a start on an empty data folder. */
const HISTORY_FILES = [
  'studio-conversations.json',
  'studio-projects.json',
  'studio-removed-projects.json',
  'studio-read-state.json',
  'studio-folders.json',
  'studio-worktrees.json',
  'studio-added-projects.json',
];

/** One saved Claude Code chat in `cwd`. */
function claudeChat(claude: string, id: string, cwd: string): void {
  const folder = claude + SEP + 'enc-' + id;
  Deno.mkdirSync(folder, { recursive: true });
  const stamp = '2026-11-10T10:00:00Z';
  const rows = [
    { type: 'user', sessionId: id, cwd, timestamp: stamp, message: { role: 'user', content: `Work in ${id}` } },
    { type: 'assistant', sessionId: id, cwd, timestamp: stamp, message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'Done.' }] } },
  ];
  Deno.writeTextFileSync(folder + SEP + id + '.jsonl', rows.map((r) => JSON.stringify(r)).join(String.fromCharCode(10)) + String.fromCharCode(10));
}

/** The shared fixture, minus its transcript folders (the app finds ~/.claude itself) and its seeded project list. */
class HomeFixture extends Fixture {
  readonly home = this.root + SEP + 'home';
  constructor() {
    super();
    Deno.removeSync(this.state + SEP + 'studio-added-projects.json'); // an empty data folder
    Deno.mkdirSync(this.home + SEP + '.claude' + SEP + 'projects', { recursive: true });
  }
  override agentFlags(): string[] {
    const flags = super.agentFlags();
    for (const flag of ['--claude-projects', '--omp-sessions']) flags.splice(flags.indexOf(flag), 2);
    return flags;
  }
  override get env(): Record<string, string> {
    return {
      ...super.env,
      HOME: this.home,
      USERPROFILE: this.home,
      APPDATA: this.root + SEP + 'appdata',
      LOCALAPPDATA: this.root + SEP + 'localappdata',
    };
  }
}

Deno.test({
  name: 'the real app on an empty data folder, with ~/.claude history: no projects, no chats, no history file written',
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      giveUp = setTimeout(() => reject(new Error('gave up after 15 minutes')), 15 * 60_000);
    });
    await using fx = new HomeFixture();
    const run = async () => {
      const projects = fx.home + SEP + '.claude' + SEP + 'projects';
      const folders = ['Alpha', 'Beta', 'Gamma'].map((n) => fx.root + SEP + 'work' + SEP + n);
      folders.forEach((f, i) => {
        Deno.mkdirSync(f, { recursive: true });
        claudeChat(projects, `chat-${i}`, f);
      });
      const web = await fx.startWeb(['--in-process', '--no-auto-reconnect', '--no-owner-announcements']);
      const [, sessions] = await web.get('/api/sessions');
      assertEquals(sessions.sessions, []);
      const [, prefs] = await web.get('/api/live/project-prefs');
      assertEquals(prefs.added, {});
      const written = [...Deno.readDirSync(fx.state)].map((e) => e.name).filter((n) => HISTORY_FILES.includes(n));
      assertEquals(written, [], 'no start-up step wrote an AIB history file');
      // the app does read that ~/.claude: adding one of the folders lists its chat
      const [status] = await web.post('project-add', { path: folders[1] });
      assertEquals(status, 200);
      const [, after] = await web.get('/api/sessions');
      assertEquals((after.sessions as { cwd: string }[]).map((s) => s.cwd), [folders[1]]);
      assert(Deno.statSync(fx.state + SEP + 'studio-added-projects.json').isFile);
      await web.kill();
    };
    try {
      await Promise.race([deadline, run()]);
    } finally {
      clearTimeout(giveUp);
    }
  },
});

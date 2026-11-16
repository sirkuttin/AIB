/**
 * Remote control from other PCs: the fixes of the Phase 1 security review (private/designs/remote-pc/security-review-phase1).
 *   MF1   artifacts/preview: a relative path is refused (relative, ./, ../ forms), and the file it RESOLVES to is checked
 *   SF1   saved transcripts: a computer reads only listed chats' transcripts, subagents and background output
 *   SF2   home folder / drive root by real path (a junction, trailing dots)
 *   SF3   the blocked list follows CLAUDE_CONFIG_DIR, CODEX_HOME, GEMINI_CLI_HOME and the beta agents' sign-in folders
 *   SF8   project-remove only for added projects (no existence oracle)
 *   SF9   the computer's own routes share the rate limit
 *   SF10  Files preview links of the loopback origin are left out
 *   SF11  restore cannot bring back a home-folder project stored on the mark
 * Test servers on random ports, temp state (never the owner's), no browser.
 */
import { assert, assertEquals } from './_assert.ts';
import { readRemotePort } from '../../outputs/agent-studio/server/remote/port.ts';
import { DEVICE_HEADER, RateLimit } from '../../outputs/agent-studio/server/remote/pc_bridge.ts';
import {
  BLOCKED_HOME_DIRS,
  isAbsolute,
  isBlocked,
  isHomeOrRoot,
  linuxBlocked,
  movedSigninDirs,
} from '../../outputs/agent-studio/server/remote/path_guard.ts';
import { remoteArtifactLinks } from '../../outputs/agent-studio/server/remote/pc_page.ts';
import { artifactPost } from '../../outputs/agent-studio/server/web/studio_routes.ts';
import { Principal, REMOTE_PC } from '../../outputs/agent-studio/server/web/security.ts';
import {
  type FakeChat,
  fakeTailscale,
  pairPhone,
  pc,
  phoneHeaders,
  raw,
  type RemoteStudio,
  remoteStudio,
  serveStatus,
  tempDir,
  writeSavedChat,
} from './_remote_fixture.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const WIN = Deno.build.os === 'windows';
const HOME = (WIN ? Deno.env.get('USERPROFILE') : Deno.env.get('HOME')) ?? '';
const sep = WIN ? '\\' : '/';
const inHome = (...parts: string[]) => [HOME, ...parts].join(sep);
const q = encodeURIComponent;

async function remoteOn(): Promise<RemoteStudio> {
  const fake = fakeTailscale();
  const s = await remoteStudio({ runner: fake.runner }, undefined, { saved: true });
  fake.state.serve = serveStatus(readRemotePort(s.state)!);
  const [status] = await pc(s, 'POST', '/api/live/devices/access', { on: true });
  assertEquals(status, 200);
  (s.ctx.phone.server!.bridge as unknown as { limit: RateLimit }).limit = new RateLimit(1e6, 1e6);
  return s;
}

function chat(id: string, cwd: string): FakeChat {
  return {
    id,
    provider: 'claude',
    sessionId: 'sess-' + id,
    cwd,
    busy: false,
    closed: false,
    attention: { state: 'idle', needs: 0, turnEndedAt: null, busySince: null },
    subagents: {},
    events: [],
    permissions: [],
    elicitations: [],
  };
}

function call(s: RemoteStudio, token: string, method: string, path: string, body?: Json) {
  return raw(
    s.phonePort(),
    method,
    path,
    { ...phoneHeaders({}, method), [DEVICE_HEADER]: token },
    body === undefined ? (method === 'POST' ? '{}' : undefined) : JSON.stringify(body),
  );
}

function refused(r: { status: number; json: Json; text: string }, codes: string[], what: string) {
  assert(r.status === 403 && codes.includes(String(r.json.code)), `${what}: ${r.status} ${r.text}`);
}

// ---- unit: the guard ---------------------------------------------------------------------------------------------------------------

Deno.test('path guard: a path that is not absolute is blocked (MF1 b)', () => {
  const state = WIN ? 'C:\\aib-state-test' : '/tmp-aib-state-test';
  for (const p of ['state/devices.json', './state/devices.json', 'sub/../state/x', '.ssh', '..\\x', 'x']) {
    assert(isBlocked(p, state), `relative ${p}`);
  }
  if (WIN) {
    assert(isBlocked('C:state\\devices.json', state), 'drive-relative');
    assert(isBlocked('\\Users\\x\\.ssh', state), 'root-relative');
    assert(isAbsolute('C:\\x') && isAbsolute('c:/x') && isAbsolute('\\\\?\\C:\\x') && !isAbsolute('C:x') && !isAbsolute('\\x'));
  }
  assert(!isBlocked(inHome('code', 'app'), state), 'an absolute path outside the blocked folders');
  assert(!isBlocked('', state), 'empty: the route says what is wrong');
});

Deno.test('path guard: moved sign-in folders and the beta agents (SF3)', () => {
  const base = WIN ? 'D:\\cfg' : '/srv/cfg';
  const env: Record<string, string> = {
    CLAUDE_CONFIG_DIR: `${base}${sep}claude`,
    CODEX_HOME: `${base}${sep}codex`,
    GEMINI_CLI_HOME: `${base}${sep}gem`,
    VIBE_HOME: 'relative-ignored',
  };
  const moved = movedSigninDirs((n) => env[n]);
  assertEquals(moved, [env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, `${env.GEMINI_CLI_HOME}/.gemini`]);
  // through isBlocked: set for real for the length of the check, then put back
  const before = Object.fromEntries(['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME'].map((n) => [n, Deno.env.get(n)]));
  try {
    for (const n of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME']) Deno.env.set(n, env[n]);
    assert(isBlocked(`${env.CLAUDE_CONFIG_DIR}${sep}.credentials.json`, null), 'CLAUDE_CONFIG_DIR');
    assert(isBlocked(`${env.CODEX_HOME}${sep}auth.json`, null), 'CODEX_HOME');
    assert(isBlocked(`${env.GEMINI_CLI_HOME}${sep}.gemini${sep}oauth_creds.json`, null), 'GEMINI_CLI_HOME/.gemini');
    assert(!isBlocked(`${env.GEMINI_CLI_HOME}${sep}code`, null), 'the rest of GEMINI_CLI_HOME');
  } finally {
    for (const [n, v] of Object.entries(before)) v === undefined ? Deno.env.delete(n) : Deno.env.set(n, v);
  }
  for (const d of ['.copilot', '.qwen', '.cursor', '.kimi', '.cline', '.vibe', '.omp']) assert(BLOCKED_HOME_DIRS.includes(d), d);
  assert(isBlocked(inHome('.local', 'share', 'opencode', 'auth.json'), null), 'opencode auth.json');
  assert(isBlocked(inHome('.copilot', 'config.json'), null), 'copilot');
  assert(linuxBlocked('/home/sam/.config/goose/config.yaml') && linuxBlocked('/root/.kimi/x'), 'WSL homes too');
});

Deno.test('path guard: home folder and drive root by real path (SF2)', async () => {
  const root = await tempDir('aib-sec-home-');
  try {
    const home = `${root}${sep}home`;
    await Deno.mkdir(home);
    const link = `${root}${sep}link`;
    await Deno.symlink(home, link, WIN ? { type: 'junction' } : undefined);
    assert(isHomeOrRoot(home, home), 'the home folder');
    assert(isHomeOrRoot(link, home), 'a junction or link to the home folder');
    assert(isHomeOrRoot(`${link}${sep}`, home), 'with a trailing separator');
    if (WIN) {
      assert(isHomeOrRoot(`${home}.`, home), 'a trailing dot');
      assert(isHomeOrRoot(`${home}::$INDEX_ALLOCATION`, home), 'the NTFS directory alias');
      assert(isHomeOrRoot(`${link}\\..\\${'link'}`, home), "'..' then the link");
    }
    await Deno.mkdir(`${home}${sep}code`);
    assert(!isHomeOrRoot(`${home}${sep}code`, home), 'a folder in it is fine');
    assert(!isHomeOrRoot(`${link}${sep}code`, home), 'and through the link');
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test('the loopback origin is never sent to a computer: Files preview links are left out (SF10)', () => {
  const loop = 'http://127.0.0.1:51234';
  const text = JSON.stringify({ viewUrl: `${loop}/f/abc123/pic%20one.png`, a: `${loop}/a/0123456789abcdef/index.html` });
  const out = remoteArtifactLinks(text, loop, 'https://pc.ts.net:8443', (id) => 't-' + id);
  assert(!out.includes('127.0.0.1'), out);
  const parsed = JSON.parse(out);
  assertEquals(parsed.viewUrl, '');
  assertEquals(parsed.a, 'https://pc.ts.net:8443/r/t-0123456789abcdef/a/0123456789abcdef/index.html');
});

// ---- e2e on the phone port ----------------------------------------------------------------------------------------------------------

Deno.test({
  ...OPTS,
  name: 'artifacts/preview: relative paths are refused, and the RESOLVED file is checked (MF1)',
  async fn() {
    const s = await remoteOn();
    try {
      // a chat whose folder holds AIB's state folder (stands in for a home-folder project holding .claude and .codex)
      s.chats.push(chat('t9', s.root));
      await Deno.writeTextFile(`${s.project}${sep}notes.json`, '{"ok":true}');
      const laptop = await pairPhone(s, 'Laptop', undefined, 'computer');
      for (const path of ['state/devices.json', './state/devices.json', 'projects/../state/devices.json', `state${sep}devices.json`]) {
        const r = await call(s, laptop.token, 'POST', '/api/live/artifacts/preview', { conversationId: 't9', path });
        refused(r, ['blocked_folder'], `relative ${path}`);
        assert(!r.text.includes('tokenHash'), 'the device store never comes back');
      }
      refused(
        await call(s, laptop.token, 'POST', '/api/live/artifacts/preview', { conversationId: 't9', path: `${s.state}${sep}devices.json` }),
        ['blocked_folder'],
        'absolute',
      );
      // the handler's own check, on the file the path resolves to (the bridge's lexical check bypassed)
      const principal = new Principal(REMOTE_PC, new Set(['phone.read', 'pc.files']), null, laptop.id);
      for (const path of ['state/devices.json', './state/devices.json', 'projects/../state/devices.json']) {
        const [status, payload] = await artifactPost(s.ctx, { headers: new Headers(), principal }, '/api/live/artifacts/preview', {
          conversationId: 't9',
          path,
        });
        assertEquals([status, (payload as Json).code], [403, 'blocked_folder'], `resolved ${path}: ${JSON.stringify(payload)}`);
      }
      // a file of the chat's folder outside the blocked folders still previews
      const ok = await call(s, laptop.token, 'POST', '/api/live/artifacts/preview', {
        conversationId: 't9',
        path: `${s.project}${sep}notes.json`,
      });
      assertEquals(ok.status, 200, ok.text);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: "saved transcripts: a computer reads only listed chats', never a removed or never-added project's (SF1)",
  async fn() {
    const s = await remoteOn();
    try {
      s.saveChat({ sessionId: 'listed-1', prompt: 'listed chat' });
      const sub = `${s.claudeDir}${sep}enc${sep}listed-1${sep}subagents`;
      await Deno.mkdir(sub, { recursive: true });
      await Deno.writeTextFile(
        `${sub}${sep}agent-a1.jsonl`,
        JSON.stringify({ type: 'user', sessionId: 'listed-1', cwd: s.project, timestamp: new Date().toISOString(), message: { role: 'user', content: 'sub' } }) + '\n',
      );
      const other = `${s.root}${sep}elsewhere`;
      await Deno.mkdir(other);
      writeSavedChat(s.claudeDir, other, { sessionId: 'secret-1', prompt: 'never added', reply: 'the-secret-reply' });
      const laptop = await pairPhone(s, 'Laptop', undefined, 'computer');

      const sessions = await call(s, laptop.token, 'GET', '/api/sessions');
      assertEquals(sessions.status, 200, sessions.text);
      const keys = (sessions.json.sessions as Json[]).map((x) => String(x.key));
      assert(keys.some((k) => k.endsWith('listed-1.jsonl')), keys.join(', '));
      assert(!keys.some((k) => k.includes('secret-1')), 'never-added project listed');

      const listedKey = keys.find((k) => k.endsWith('listed-1.jsonl'))!;
      const secretKey = listedKey.replace('listed-1.jsonl', 'secret-1.jsonl');
      // the PC itself still reads it (nothing changes for the PC)
      const [pcStatus] = await pc(s, 'GET', `/api/transcript?key=${q(secretKey)}`);
      assertEquals(pcStatus, 200, 'the PC reads any transcript');

      const ok = await call(s, laptop.token, 'GET', `/api/transcript?key=${q(listedKey)}`);
      assertEquals(ok.status, 200, ok.text);
      const subKey = listedKey.replace(/\.jsonl$/, '/subagents/agent-a1.jsonl');
      assertEquals((await call(s, laptop.token, 'GET', `/api/transcript?key=${q(subKey)}`)).status, 200, 'a listed chat\'s subagent');
      assertEquals((await call(s, laptop.token, 'GET', `/api/agents?session=${q(listedKey)}`)).status, 200);

      for (
        const path of [
          `/api/transcript?key=${q(secretKey)}`,
          `/api/transcript/image?key=${q(secretKey)}&n=0&i=0`,
          `/api/agents?session=${q(secretKey)}`,
          `/api/commands?session=${q(secretKey)}`,
          `/api/command?session=${q(secretKey)}&id=x`,
          `/api/transcript?key=${q(listedKey.replace(/\.jsonl$/, '/../secret-1.jsonl'))}`,
          `/api/transcript?key=${q(listedKey.replace(/\.jsonl$/, '') + '/..\\secret-1.jsonl')}`,
          `/api/transcript`,
        ]
      ) {
        const r = await call(s, laptop.token, 'GET', path);
        refused(r, ['not_listed'], path);
        assert(!r.text.includes('the-secret-reply'), path);
      }
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'project-remove, restore and the computer routes: no oracle, no home folder back, one rate limit (SF8, SF11, SF9)',
  async fn() {
    const s = await remoteOn();
    try {
      const laptop = await pairPhone(s, 'Laptop', undefined, 'computer');
      // SF8: check on a folder that is not an added project tells nothing
      for (const path of [inHome('.ssh'), `${s.root}${sep}nope`, s.root, 'projects/shop']) {
        refused(
          await call(s, laptop.token, 'POST', '/api/live/project-remove', { path, check: true }),
          ['blocked_folder', 'outside_projects'],
          `project-remove ${path}`,
        );
      }
      const own = await call(s, laptop.token, 'POST', '/api/live/project-remove', { path: s.project, check: true });
      assert(own.status === 200, `an added project: ${own.status} ${own.text}`);

      // SF11: a mark whose stored folders are a home folder: restore from a computer is refused
      const [marked] = await pc(s, 'POST', '/api/live/conversation-state', {
        action: 'delete',
        provider: 'claude',
        sessionId: 'home-chat',
        cwd: HOME,
        projectRoot: HOME,
      });
      assertEquals(marked, 200);
      refused(
        await call(s, laptop.token, 'POST', '/api/live/conversation-state', { action: 'restore', provider: 'claude', sessionId: 'home-chat' }),
        ['not_a_project', 'blocked_folder'],
        'restore of a home-folder project',
      );

      // SF9: the computer's own routes take from the same bucket as the bridge
      (s.ctx.phone.server!.bridge as unknown as { limit: RateLimit }).limit = new RateLimit(1, 0.001);
      const first = await call(s, laptop.token, 'GET', '/api/remote/pc/settings?recheck=1');
      assertEquals(first.status, 200, first.text);
      const second = await call(s, laptop.token, 'GET', '/api/remote/pc/settings?recheck=1');
      assertEquals([second.status, second.json.code], [429, 'rate_limited']);
    } finally {
      await s.close();
    }
  },
});

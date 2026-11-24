/**
 * Sync between PCs, slice V3: project matching (server/pcsync/projects.ts, repo_id.ts). Two in-process AIB servers
 * (_pcsync_fixture.ts) with temp git repos on both sides. Covered: the same remote in ssh and https form is matched (both PCs hold the
 * same project sync id, both switches off), a different subfolder of one repo is not, a name-only match is only a suggestion and
 * never automatic, a manual link needs the other PC's OK, unlink reaches the other PC (also when it was off), the Docs and aib-shared
 * switches survive a restart, no absolute path is ever in a frame (every text frame sent is captured), and a WSL project's remote
 * is read through the (fake) WSL helper without starting a stopped distro.
 */
import { assert, assertEquals } from './_assert.ts';
import { pc, tempDir } from './_remote_fixture.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { setWslHostResolver } from '../../app/server/wsl/access.ts';
import { normalizeRemote, readRepoIdentity } from '../../app/server/pcsync/repo_id.ts';
import { closeAll, type Json, type Node, paired, until } from './_pcsync_fixture.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
/** No text frame names a folder: not a root of either PC, not a drive or a leading slash as a value. */
function checkPathless(frames: string[], roots: string[]) {
  assert(frames.length > 0, 'frames were captured');
  for (const frame of frames) {
    for (const root of roots) {
      assert(!frame.includes(root) && !frame.includes(JSON.stringify(root).slice(1, -1)), `a folder path is in a frame: ${frame.slice(0, 200)}`);
    }
    assert(!/"[A-Za-z]:|"\/|"\\\\/.test(frame), `an absolute path is in a frame: ${frame.slice(0, 200)}`);
  }
}
const sep = Deno.build.os === 'windows' ? '\\' : '/';

Deno.test('normalizeRemote: ssh, https and .git forms are the same remote; local paths and no remote are nothing', () => {
  const same = [
    'git@github.com:Acme/Shop.git',
    'https://github.com/acme/shop',
    'https://github.com/acme/shop.git',
    'https://user@GitHub.com/acme/shop.git/',
    'ssh://git@github.com:22/acme/shop.git',
    'git://github.com/acme/shop.git',
    'github.com:acme/shop',
  ];
  for (const url of same) assertEquals(normalizeRemote(url), 'github.com/acme/shop', url);
  assertEquals(normalizeRemote('https://gitlab.com/acme/shop'), 'gitlab.com/acme/shop');
  for (const url of ['', '   ', 'C:\\repos\\shop.git', '/srv/git/shop.git', '../shop', 'file:///srv/git/shop.git', null, 7]) {
    assertEquals(normalizeRemote(url), null, String(url));
  }
});

async function git(cwd: string, ...args: string[]) {
  const out = await new Deno.Command('git', { args, cwd, stdout: 'piped', stderr: 'piped' }).output();
  if (!out.success) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(out.stderr)}`);
}

/** A temp git repo `name` under `parent` with `origin` set (no network is ever used); returns the project folder (a subfolder or the top). */
async function repo(parent: string, name: string, remote: string | null, sub = ''): Promise<string> {
  const top = `${parent}${sep}${name}`;
  await Deno.mkdir(top, { recursive: true });
  await git(top, 'init', '-q');
  if (remote) await git(top, 'remote', 'add', 'origin', remote);
  if (!sub) return top;
  const dir = `${top}${sep}${sub.split('/').join(sep)}`;
  await Deno.mkdir(dir, { recursive: true });
  return dir;
}

/** Every text frame any WebSocket in this process sends (both PCs, client and server ends). */
function captureFrames(): { frames: string[]; stop: () => void } {
  const frames: string[] = [];
  const original = WebSocket.prototype.send;
  WebSocket.prototype.send = function (this: WebSocket, data: Parameters<WebSocket['send']>[0]) {
    if (typeof data === 'string') frames.push(data);
    return original.call(this, data);
  };
  return { frames, stop: () => (WebSocket.prototype.send = original) };
}

const view = async (n: Node) => {
  const [, v] = await pc(n.s, 'GET', '/api/live/pcsync');
  return (v.peers as Json[])[0];
};
const projectsOf = async (n: Node) => (await view(n)).projects as {
  links: { sync: string; name: string; otherName: string; how: string; confirmed: boolean; docs: boolean; shared: boolean }[];
  suggestions: { mine: string; theirs: string; name: string }[];
  mine: { oid: string; name: string }[];
  theirs: { oid: string; name: string }[];
  known: boolean;
};
const refreshBoth = async (a: Node, b: Node) => {
  await a.s.ctx.pcsync.projects.refresh(true);
  await b.s.ctx.pcsync.projects.refresh(true);
};
const connected = (n: Node) => n.s.ctx.pcsync.links.links().length === 1;
/** Both PCs have read the other's offers (the lists arrive over the link). */
const knowEachOther = async (a: Node, b: Node) => {
  await until('both links up', () => connected(a) && connected(b));
  await refreshBoth(a, b);
  await until('both know the other PC\'s projects', async () => (await projectsOf(a)).known && (await projectsOf(b)).known);
};

Deno.test({
  ...OPTS,
  name: 'matching: ssh and https remotes match by remote (names may differ), a different subfolder does not, both PCs hold one sync id, switches off',
  async fn() {
    const cap = captureFrames();
    const [a, b] = await paired();
    try {
      const aDir = await tempDir('aib-v3-a-'), bDir = await tempDir('aib-v3-b-');
      await a.s.ctx.addedProjects.add(
        await repo(aDir, 'storefront', 'git@github.com:Acme/Shop.git'),
        await repo(aDir, 'mono', 'git@github.com:acme/mono.git', 'packages/api'),
        await repo(aDir, 'whole', 'git@github.com:acme/whole.git'),
      );
      await b.s.ctx.addedProjects.add(
        await repo(bDir, 'shop-clone', 'https://github.com/acme/shop'),
        await repo(bDir, 'monorepo', 'https://github.com/acme/mono.git', 'packages/web'),
        await repo(bDir, 'whole', 'https://github.com/acme/whole.git', 'inner'),
      );
      await knowEachOther(a, b);
      await until('the shop link on both PCs', async () => (await projectsOf(a)).links.length === 1 && (await projectsOf(b)).links.length === 1);
      const [la] = (await projectsOf(a)).links;
      const [lb] = (await projectsOf(b)).links;
      assertEquals([la.name, la.otherName, la.how, la.confirmed, la.docs, la.shared], ['storefront', 'shop-clone', 'remote', true, false, false]);
      assertEquals([lb.name, lb.otherName, lb.how, lb.confirmed, lb.docs, lb.shared], ['shop-clone', 'storefront', 'remote', true, false, false]);
      assertEquals(la.sync, lb.sync, 'one project sync id on both PCs');
      // nothing else matched on its own: the other subfolder of mono, and a project in a subfolder against the repo top
      await new Promise((r) => setTimeout(r, 400));
      assertEquals((await projectsOf(a)).links.length, 1);
      assertEquals((await projectsOf(b)).links.length, 1);
      const free = (await projectsOf(a)).mine.map((p) => p.name).sort();
      assertEquals(free, ['api', 'shop', 'whole']);
      // the persisted table has the link and no more
      assertEquals(a.s.ctx.pcsync.projects.confirmedLinks().length, 1);

      // frames: offers and links were sent, and not one of them holds a folder path
      const text = cap.frames.join('\n');
      assert(text.includes('project.offer') && text.includes('project.link'), 'offers and a link crossed the wire');
      checkPathless(cap.frames, [a.root, b.root, aDir, bDir]);
    } finally {
      cap.stop();
      await closeAll([a, b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'name-only: the same folder name with another remote is only a suggestion, never linked on its own; Link to… by hand, then OK, switches, unlink',
  async fn() {
    const [a, b] = await paired();
    try {
      const aDir = await tempDir('aib-v3-a-'), bDir = await tempDir('aib-v3-b-');
      await a.s.ctx.addedProjects.add(await repo(aDir, 'notes', 'git@github.com:acme/notes.git'), await repo(aDir, 'alpha', null));
      await b.s.ctx.addedProjects.add(await repo(bDir, 'notes', 'git@github.com:other/notes.git'), await repo(bDir, 'beta', null));
      await knowEachOther(a, b);
      await new Promise((r) => setTimeout(r, 400));
      const first = await projectsOf(a);
      assertEquals(first.links.length, 0, 'a name-only match is never linked automatically');
      assertEquals((await projectsOf(b)).links.length, 0);
      const suggest = first.suggestions.filter((s) => s.name === 'notes');
      assertEquals(suggest.length, 1);
      // Link to… lists every unlinked project of the other PC, not only the same-name ones
      assert(first.theirs.some((p) => p.name === 'beta') && first.mine.some((p) => p.name === 'alpha'));
      const peerId = (await view(a)).id as string;
      // by hand, the pair that is not even the same name
      const alpha = first.mine.find((p) => p.name === 'alpha')!, beta = first.theirs.find((p) => p.name === 'beta')!;
      const [bad] = await pc(a.s, 'POST', '/api/live/pcsync/projects/link', { peer: peerId, mine: alpha.oid, theirs: 'nope-nope-nope' });
      assertEquals(bad, 404);
      const [ok, made] = await pc(a.s, 'POST', '/api/live/pcsync/projects/link', { peer: peerId, mine: alpha.oid, theirs: beta.oid });
      assertEquals(ok, 200, JSON.stringify(made));
      await until('B shows the proposal', async () => (await projectsOf(b)).links.length === 1);
      const [onA] = (await projectsOf(a)).links;
      const [onB] = (await projectsOf(b)).links;
      assertEquals([onA.name, onA.how, onA.confirmed, onB.name, onB.how, onB.confirmed], ['alpha', 'manual', true, 'beta', 'manual', false]);
      assertEquals(onA.sync, onB.sync);
      // B has not said yes: its switches refuse, a switch needs a confirmed link
      const [refused] = await pc(b.s, 'POST', '/api/live/pcsync/projects/switch', { sync: onB.sync, which: 'docs', on: true });
      assertEquals(refused, 409);
      assertEquals(b.s.ctx.pcsync.projects.confirmedLinks().length, 0, 'an unconfirmed link is not offered to later slices');
      const [yes] = await pc(b.s, 'POST', '/api/live/pcsync/projects/confirm', { sync: onB.sync });
      assertEquals(yes, 200);
      for (const [n, which] of [[a, 'docs'], [b, 'shared']] as [Node, string][]) {
        const [s] = await pc(n.s, 'POST', '/api/live/pcsync/projects/switch', { sync: onA.sync, which, on: true });
        assertEquals(s, 200);
      }
      assertEquals((await projectsOf(a)).links[0].docs, true);
      assertEquals((await projectsOf(b)).links[0].shared, true);
      const [badSwitch] = await pc(a.s, 'POST', '/api/live/pcsync/projects/switch', { sync: onA.sync, which: 'files', on: true });
      assertEquals(badSwitch, 400);
      // the name-only pair is still only a suggestion, and linking it again is refused for the linked ones
      const [dupe] = await pc(a.s, 'POST', '/api/live/pcsync/projects/link', { peer: peerId, mine: alpha.oid, theirs: beta.oid });
      assertEquals(dupe, 409);

      // unlink on A reaches B at once
      const [un] = await pc(a.s, 'POST', '/api/live/pcsync/projects/unlink', { sync: onA.sync });
      assertEquals(un, 200);
      await until('B dropped the link', async () => (await projectsOf(b)).links.length === 0);
      assertEquals((await projectsOf(a)).links.length, 0);
      // ... and the pair is free to link again
      assert((await projectsOf(a)).mine.some((p) => p.name === 'alpha'));

      // unlink while the other PC is off: kept, and sent when it is back
      await refreshBoth(a, b);
      const again = await projectsOf(a);
      const [relink] = await pc(a.s, 'POST', '/api/live/pcsync/projects/link', {
        peer: peerId,
        mine: again.mine.find((p) => p.name === 'alpha')!.oid,
        theirs: again.theirs.find((p) => p.name === 'beta')!.oid,
      });
      assertEquals(relink, 200);
      await until('B has it again', async () => (await projectsOf(b)).links.length === 1);
      b.s.ctx.pcsync.links.stop();
      await until('A sees B gone', () => !connected(a));
      const [offline] = await pc(a.s, 'POST', '/api/live/pcsync/projects/unlink', { sync: (await projectsOf(a)).links[0].sync });
      assertEquals(offline, 200);
      assertEquals((await projectsOf(b)).links.length, 1, 'B was not told yet');
      b.s.ctx.pcsync.links.start();
      await until('B was told when it came back', async () => (await projectsOf(b)).links.length === 0, 12000);
    } finally {
      await closeAll([a, b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'persistence: the links and the Docs and aib-shared switches survive a restart of either PC',
  async fn() {
    const [a, b] = await paired();
    try {
      const aDir = await tempDir('aib-v3-a-'), bDir = await tempDir('aib-v3-b-');
      await a.s.ctx.addedProjects.add(await repo(aDir, 'shop', 'git@github.com:acme/shop2.git'));
      await b.s.ctx.addedProjects.add(await repo(bDir, 'shop', 'https://github.com/acme/shop2'));
      await knowEachOther(a, b);
      await until('linked', async () => (await projectsOf(a)).links.length === 1 && (await projectsOf(b)).links.length === 1);
      const sync = (await projectsOf(a)).links[0].sync;
      const [s1] = await pc(a.s, 'POST', '/api/live/pcsync/projects/switch', { sync, which: 'docs', on: true });
      assertEquals(s1, 200);
      for (const n of [a, b]) {
        await n.restart();
        const [links] = [(await projectsOf(n)).links];
        assertEquals(links.length, 1, 'the link is still there');
        assertEquals(links[0].sync, sync);
      }
      assertEquals([(await projectsOf(a)).links[0].docs, (await projectsOf(a)).links[0].shared], [true, false]);
      assertEquals([(await projectsOf(b)).links[0].docs, (await projectsOf(b)).links[0].shared], [false, false]);
      // after both restarts the link comes back and matching does not make a second link
      await until('linked again', () => connected(a) && connected(b));
      await new Promise((r) => setTimeout(r, 600));
      assertEquals((await projectsOf(a)).links.length, 1);
      assertEquals((await projectsOf(b)).links.length, 1);
    } finally {
      await closeAll([a, b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'WSL: a WSL project\'s remote is read through the helper (never a stopped distro), offered as a WSL project, and no Linux path is sent',
  async fn() {
    const cap = captureFrames();
    const [a, b] = await paired();
    const host = new FakeWslHost('unused', 'Ubuntu');
    try {
      const aDir = await tempDir('aib-v3-a-'), distro = await tempDir('aib-v3-distro-');
      const LINUX = '/home/u/wslapp';
      const folder = await repo(distro, 'wslapp', 'https://github.com/acme/wslapp.git');
      host.folders.set(LINUX, folder);
      host.handlers['git.identity'] = async (p: Json) => await readRepoIdentity(host.windowsFor(String(p.folder)));
      setWslHostResolver((d: string) => (d === 'ubuntu' ? host : null));
      await a.s.ctx.addedProjects.add(await repo(aDir, 'wslapp-win', 'git@github.com:acme/wslapp.git'));
      await b.s.ctx.addedProjects.add('wsl://ubuntu' + LINUX);
      await knowEachOther(a, b);
      await until('the WSL project linked', async () => (await projectsOf(a)).links.length === 1 && (await projectsOf(b)).links.length === 1);
      const [onA] = (await projectsOf(a)).links;
      assertEquals([onA.name, onA.otherName, onA.how], ['wslapp-win', 'wslapp', 'remote']);
      assert(host.calls.some(([m, p]) => m === 'git.identity' && p.folder === LINUX), 'the helper was asked for the remote');
      assert(cap.frames.some((f) => f.includes('"wsl":true')), 'the offer says it is a WSL project');
      checkPathless(cap.frames, [a.root, b.root, aDir, distro, LINUX, folder]);

      // a distro that is off is never started and keeps its last answer
      const calls = host.calls.length;
      host.state = 'stopped';
      await b.s.ctx.pcsync.projects.refresh(true);
      assertEquals(host.calls.length, calls, 'no helper call for a distro that is not ready');
      assertEquals((await projectsOf(b)).links.length, 1);
    } finally {
      setWslHostResolver(null);
      cap.stop();
      await closeAll([a, b]);
    }
  },
});

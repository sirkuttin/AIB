/**
 * The .deb self-update (server/desktop/updater.ts, update_helper.ts kind 'deb', tools/linux/): the pkexec argument check that mirrors
 * aib-install-deb, pkexec's answers as outcomes, the install target of a .deb install, the Install now flow (the password step runs
 * BEFORE the helper and the quit; a closed prompt, a missing pkexec or polkit agent leave AIB open with the manual line and the file's
 * path), the helper's deb start, the packaging step that adds the script and the polkit action to a .deb, and the Debian Version
 * `deno desktop` writes. Everything is faked: no pkexec, no apt, no real app. The real install runs in deb_update_e2e_test.ts (WSL).
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import {
  compare,
  DEB_INSTALLER,
  debInstallArgs,
  debOutcome,
  postUpdateInstall,
  type PrivilegedResult,
  UpdateError,
  UpdateService,
  type UpdateServiceOptions,
} from '../../outputs/agent-studio/server/desktop/updater.ts';
import {
  DEB_EXE,
  dpkgOwns,
  type HelperArgs,
  installTarget,
  removeUpdateLeftovers,
  run as runHelper,
  type StartResult,
} from '../../outputs/agent-studio/server/desktop/update_helper.ts';
import { addDebUpdater, DEB_INSTALLER_PATH, DEB_POLICY_PATH, readAr, tarEntry, tarPaths, writeAr } from '../../tools/linux_package.ts';

const HOME = '/home/ann';
const GOOD = `${HOME}/.local/state/agent-studio/updates/0.13.2/AIB-0.13.2-linux-x64.deb`;

Deno.test("debInstallArgs: only AIB's own download in the home folder gets a password prompt (the aib-install-deb rules)", () => {
  assertEquals(debInstallArgs(GOOD, HOME), [DEB_INSTALLER, GOOD]);
  assertEquals(debInstallArgs(GOOD, HOME + '/'), [DEB_INSTALLER, GOOD], 'a trailing slash on HOME');
  const ok = [
    `${HOME}/.local/state/agent-studio/updates/0.13.2-beta.1/AIB-0.13.2-beta.1-linux-x64.deb`,
    `${HOME}/.local/state/agent-studio/updates/0.13.2-beta.12.test.3/AIB-0.13.2-beta.12.test.3-linux-arm64.deb`,
    `${HOME}/x/updates/1.0.0/AIB-1.0.0-linux-x64.deb`, // XDG_STATE_HOME elsewhere in the home folder
  ];
  for (const p of ok) assertEquals(debInstallArgs(p, HOME), [DEB_INSTALLER, p], p);
  const refused: [string, string][] = [
    ['relative', '.local/state/agent-studio/updates/0.13.2/AIB-0.13.2-linux-x64.deb'],
    ['outside home', '/tmp/updates/0.13.2/AIB-0.13.2-linux-x64.deb'],
    ['a home with the same start', '/home/anna/updates/0.13.2/AIB-0.13.2-linux-x64.deb'],
    ['..', `${HOME}/a/../updates/0.13.2/AIB-0.13.2-linux-x64.deb`],
    ['.', `${HOME}/./updates/0.13.2/AIB-0.13.2-linux-x64.deb`],
    ['//', `${HOME}//updates/0.13.2/AIB-0.13.2-linux-x64.deb`],
    ['a space', `${HOME}/my state/updates/0.13.2/AIB-0.13.2-linux-x64.deb`],
    ['a quote', `${HOME}/x"/updates/0.13.2/AIB-0.13.2-linux-x64.deb`],
    ['a newline', `${HOME}/x\n/updates/0.13.2/AIB-0.13.2-linux-x64.deb`],
    ['folder and file versions differ', `${HOME}/updates/0.13.1/AIB-0.13.2-linux-x64.deb`],
    ['not a version', `${HOME}/updates/latest/AIB-latest-linux-x64.deb`],
    ['no updates folder', `${HOME}/downloads/0.13.2/AIB-0.13.2-linux-x64.deb`],
    ['another arch word', `${HOME}/updates/0.13.2/AIB-0.13.2-linux-amd64.deb`],
    ['an AppImage', `${HOME}/updates/0.13.2/AIB-0.13.2-linux-x64.AppImage`],
    ['another name', `${HOME}/updates/0.13.2/evil-0.13.2-linux-x64.deb`],
    ['an option', '-oDpkg::Pre-Invoke=x'],
    ['empty', ''],
  ];
  for (const [why, p] of refused) assertEquals(debInstallArgs(p, HOME), null, why);
  assertEquals(debInstallArgs(GOOD, ''), null, 'no HOME');
  assertEquals(debInstallArgs(GOOD, 'home/ann'), null, 'a relative HOME');
  assertEquals(debInstallArgs('/updates/0.13.2/AIB-0.13.2-linux-x64.deb', '/'), null, 'HOME=/ (root) is not a user folder');
});

Deno.test('debOutcome: pkexec and aib-install-deb exit codes become the reason shown with the manual line', () => {
  const r = (code: number, stderr = ''): PrivilegedResult => ({ code, stderr });
  assertEquals(debOutcome(r(0)), { ok: true });
  const no = (x: ReturnType<typeof debOutcome>) => (x.ok ? ['ok', ''] : [x.reason, x.message]);
  assertEquals(no(debOutcome(null))[0], 'no_pkexec');
  assert(no(debOutcome(null))[1].includes('pkexec is not installed'));
  assertEquals(no(debOutcome(r(126, 'Error executing command as another user: Request dismissed'))), [
    'cancelled',
    'The password prompt was closed, so nothing was installed.',
  ]);
  assertEquals(no(debOutcome(r(127, 'Error executing command as another user: No authentication agent found.')))[0], 'no_agent');
  assertEquals(no(debOutcome(r(127, 'Error executing command as another user: Not authorized')))[0], 'not_allowed');
  for (const code of [64, 65, 66]) {
    const [reason, message] = no(debOutcome(r(code, 'noise\naib-install-deb: the path goes through a link\n')));
    assertEquals(reason, 'refused');
    assert(message.includes('(the path goes through a link)'), message);
  }
  const [reason, message] = no(debOutcome(r(70, 'E: dpkg was interrupted\naib-install-deb: apt-get could not install 0.13.2\n')));
  assertEquals(reason, 'failed');
  assert(message.includes('apt could not install the update') && message.includes('unchanged'), message);
  assertEquals(no(debOutcome(r(71, 'aib-install-deb: aib is at version 0.13.1')))[0], 'failed');
  assertEquals(no(debOutcome(r(1)))[1], 'The update did not install.');
  assert(no(debOutcome(r(9, 'x'.repeat(1000))))[1].length < 300, 'the detail is cut');
});

Deno.test('installTarget: a .deb install (/usr/lib/aib/aib owned by dpkg) is kind deb; an AppImage still wins; others unchanged', () => {
  const yes = () => true;
  const no = () => false;
  assertEquals(installTarget('linux', DEB_EXE, {}, yes), { kind: 'deb', target: DEB_EXE });
  assertEquals(installTarget('linux', '/usr/bin/aib', {}, yes), { kind: 'deb', target: DEB_EXE }, 'the PATH link');
  assertEquals(installTarget('linux', DEB_EXE, {}, no), null, 'copied there by hand: dpkg does not own it');
  assertEquals(installTarget('linux', '/opt/aib/aib', {}, yes), null);
  assertEquals(installTarget('linux', DEB_EXE, { APPIMAGE: '/home/u/AIB.AppImage' }, yes), {
    kind: 'appimage',
    target: '/home/u/AIB.AppImage',
  });
  assertEquals(installTarget('windows', 'C:\\AIB\\AIB.exe', {}, yes), { kind: 'windows-zip', target: 'C:\\AIB' });
  assertEquals(installTarget('darwin', '/Applications/AIB.app/Contents/MacOS/AIB', {}, yes), {
    kind: 'macos-zip',
    target: '/Applications/AIB.app',
  });
  // dpkg's file list: the plain name or the multiarch one
  const lists: Record<string, string> = { '/var/lib/dpkg/info/aib:arm64.list': '/.\n/usr\n/usr/lib/aib\n/usr/lib/aib/aib\n' };
  const read = (f: string) => {
    if (!(f in lists)) throw new Deno.errors.NotFound(f);
    return lists[f];
  };
  assert(dpkgOwns(DEB_EXE, read));
  assert(!dpkgOwns('/usr/lib/aib/aib.so', read));
  assert(!dpkgOwns(DEB_EXE, () => '/usr/lib/aib/aibx\n'));
  assert(
    !dpkgOwns(DEB_EXE, () => {
      throw new Error('unreadable');
    }),
  );
  // apt leaves no *.old-* files: the startup cleanup does nothing for a .deb install
  assertEquals(removeUpdateLeftovers({ target: { kind: 'deb', target: DEB_EXE } }), []);
});

// ---- the Install now flow on a .deb install ----------------------------------------------------------------------------
const VERSION = '0.13.2';
const NAME = `AIB-${VERSION}-linux-x64.deb`;
const PAYLOAD = new TextEncoder().encode('!<arch>\nfake deb '.repeat(40));

async function sha(data: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A .deb install whose update is downloaded from a local feed folder and verified (its SHA256SUMS), ready to install. */
class DebCase {
  dir = Deno.makeTempDirSync({ prefix: 'aib-deb-update-test-' });
  feed = `${this.dir}/feed`;
  state = `${this.dir}/state`;
  launched: HelperArgs[] = [];
  quit: (boolean | undefined)[] = [];
  /** Each pkexec call: its arguments and what launched/quit looked like at that moment. */
  asked: { argv: string[]; launchedBefore: number; quitBefore: number }[] = [];
  answers: PrivilegedResult[] = [];
  busy = 0;
  svc!: UpdateService;
  async ready(o: UpdateServiceOptions = {}) {
    Deno.mkdirSync(`${this.feed}/${VERSION}`, { recursive: true });
    Deno.writeFileSync(`${this.feed}/${VERSION}/${NAME}`, PAYLOAD);
    Deno.writeTextFileSync(`${this.feed}/${VERSION}/SHA256SUMS`, `${await sha(PAYLOAD)}  ${NAME}\n`);
    this.svc = new UpdateService(this.state, {
      key: ['linux', 'x64'],
      current: '0.13.2-beta.1',
      env: { HOME: '/home/ann' },
      repo: 'OWNER/aib', // no GitHub: the feed only
      feedDir: this.feed,
      getTestBuilds: () => true,
      exists: () => true, // dpkg is there: the .deb is the asset this machine takes
      app: { desktop: true, pid: 4242, exe: DEB_EXE },
      dpkgOwns: () => true,
      debArgs: (p) => [DEB_INSTALLER, p], // the real check (above) needs POSIX paths; this test may run on Windows
      privileged: (argv) => {
        this.asked.push({ argv, launchedBefore: this.launched.length, quitBefore: this.quit.length });
        return Promise.resolve(this.answers.length ? this.answers.shift()! : { code: 0, stderr: '' });
      },
      launcher: (a) => void this.launched.push(a),
      quit: (release) => void this.quit.push(release),
      busyChats: () => this.busy,
      now: () => 1_000_000,
      ...o,
    });
    const st = await this.svc.checkFeed();
    assertEquals([st.state, st.inPlace, st.instructions], ['ready', true, undefined], 'a .deb install offers Install now');
    return this.svc.state.downloaded!.path;
  }
  [Symbol.dispose]() {
    Deno.removeSync(this.dir, { recursive: true });
  }
}

Deno.test('.deb Install now: the password step (pkexec aib-install-deb <file>) runs first, then the helper starts and AIB quits', async () => {
  using c = new DebCase();
  const path = await c.ready();
  assertEquals((await c.svc.install()).state, 'installing');
  assertEquals(c.asked, [{ argv: [DEB_INSTALLER, path], launchedBefore: 0, quitBefore: 0 }], 'before the helper and the quit');
  assertEquals(c.launched.length, 1);
  const a = c.launched[0];
  assertEquals([a.kind, a.target, a.exe, a.installer, a.version, a.sha256], ['deb', DEB_EXE, DEB_EXE, path, VERSION, await sha(PAYLOAD)]);
  assertEquals(c.quit, [false]);
});

for (
  const [what, answer, says] of [
    [
      'the password prompt is closed',
      { code: 126, stderr: 'Error executing command as another user: Request dismissed' },
      'password prompt was closed',
    ],
    ['pkexec is not installed', null, 'pkexec is not installed'],
    [
      'no polkit agent runs (SSH)',
      { code: 127, stderr: 'Error executing command as another user: No authentication agent found.' },
      'no password prompt runs',
    ],
    [
      'aib-install-deb refuses the file',
      { code: 64, stderr: 'aib-install-deb: the path goes through a link' },
      'refused the downloaded file',
    ],
    ['apt fails', { code: 70, stderr: 'aib-install-deb: apt-get could not install 0.13.2' }, 'apt could not install'],
  ] as [string, PrivilegedResult, string][]
) {
  Deno.test(`.deb Install now when ${what}: nothing installs, AIB stays open, the manual line with the file's path`, async () => {
    using c = new DebCase();
    const path = await c.ready();
    c.answers.push(answer);
    const error = await assertRejects(() => c.svc.install(), UpdateError) as UpdateError;
    assertEquals(error.code, 'manual');
    assertEquals(error.extra.path, path);
    assert(error.message.includes(says), error.message);
    assert(error.message.includes(`sudo apt install "${path}"`), "today's manual line, with the path: " + error.message);
    assertEquals([c.launched.length, c.quit.length], [0, 0], 'no helper, no quit');
    const st = c.svc.status();
    assertEquals([st.state, st.inPlace, st.installWhenIdle], ['ready', true, false], 'Update can be clicked again');
    // the route answers 400 with the message (the page opens it in the popover)
    c.answers.push(answer);
    const [code, body] = await postUpdateInstall(c.svc, {});
    assertEquals([code, body.code, body.path], [400, 'manual', path]);
    assert(String(body.error).includes(says));
  });
}

Deno.test('.deb Install when chats finish: the password is asked when the install runs; a closed prompt is not asked again', async () => {
  using c = new DebCase();
  await c.ready();
  c.busy = 2;
  assertEquals(await c.svc.install(true), { state: 'waiting', chats: 2 });
  assertEquals(c.asked.length, 0, 'no prompt while chats work');
  c.busy = 0;
  c.answers.push({ code: 126, stderr: 'Request dismissed' });
  await assertRejects(() => c.svc.tick(), UpdateError);
  assertEquals([c.asked.length, c.launched.length, c.svc.state.installWhenIdle], [1, 0, false]);
  await c.svc.tick();
  assertEquals(c.asked.length, 1, 'the next tick does not open the prompt again');
});

Deno.test('.deb Install now: a second click while the password prompt is open waits for it (409 busy)', async () => {
  using c = new DebCase();
  let answer!: (r: PrivilegedResult) => void;
  await c.ready({ privileged: () => new Promise<PrivilegedResult>((r) => (answer = r)) });
  const first = c.svc.install();
  await new Promise((r) => setTimeout(r, 20));
  const [code, body] = await postUpdateInstall(c.svc, {});
  assertEquals([code, body.code], [409, 'busy']);
  answer({ code: 0, stderr: '' });
  assertEquals((await first).state, 'installing');
  assertEquals(c.launched.length, 1);
});

Deno.test('.deb Install now with the keeper: the chats are left to the new version (the helper holds the keeper), as elsewhere', async () => {
  using c = new DebCase();
  await c.ready({
    keeper: () =>
      Promise.resolve({
        reason: '',
        protocol: 3,
        features: ['a'],
        version: '0.13.2-beta.1',
        dataDir: '/home/ann/.local/state/agent-studio',
      }),
  });
  c.svc.state.downloaded!.keeper = { protocols: [3], needs: ['a'] };
  c.busy = 1;
  assertEquals(await c.svc.install(), { state: 'installing', chats: 1 });
  assertEquals(c.asked.length, 1);
  assertEquals(c.launched[0].keeper, '/home/ann/.local/state/agent-studio');
  assertEquals(c.quit, [true], 'release: the app leaves the chats running');
});

Deno.test('.deb install: the update file must be a .deb; data outside the home folder gets the manual line without a prompt', async () => {
  using c = new DebCase();
  const path = await c.ready({ debArgs: () => null });
  const error = await assertRejects(() => c.svc.install(), UpdateError) as UpdateError;
  assertEquals([error.code, error.extra.path, c.asked.length], ['manual', path, 0]);
  assert(error.message.includes('outside your home folder'), error.message);
  // a .deb install that could only download an AppImage installs by hand (and the other way round, updater_test)
  c.svc.state.downloaded = { ...c.svc.state.downloaded!, name: 'AIB-0.13.2-linux-x64.AppImage' };
  assertEquals(c.svc.canInstallInPlace(), false);
  // not owned by dpkg (copied by hand): no self-update
  using d = new DebCase();
  await assertRejects(() => d.ready({ dpkgOwns: () => false }));
});

// ---- the helper's deb kind ----------------------------------------------------------------------------------------------
Deno.test('helper (deb): waits for the app, starts the new version with the same arguments, holds the keeper until it started', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-deb-helper-test-' });
  try {
    const events: string[] = [];
    let alive = 2;
    const started: string[][] = [];
    const args = {
      installer: `${dir}/gone.deb`, // apt has installed it; the helper does not read it again
      sha256: '0'.repeat(64),
      pid: 77,
      exe: DEB_EXE,
      log: `${dir}/install.log`,
      version: VERSION,
      kind: 'deb',
      target: DEB_EXE,
      args: ['--state-dir', '/home/ann/s'],
      marker: `${dir}/started-${VERSION}.ok`,
      keeper: '/home/ann/s',
    };
    const deps = (result: StartResult) => ({
      alive: () => alive-- > 0,
      sleep: () => {},
      unpack: () => Promise.reject(new Error('a .deb is not unpacked')),
      start: (command: string[]) => (events.push('start'), started.push(command), Promise.resolve(result)),
      tray: () => () => {},
      keepKeeper: () => (events.push('hold'), Promise.resolve({ what: 'keeper', release: () => void events.push('release') })),
    });
    assertEquals(await runHelper(args, deps({ code: null, confirmed: true })), 0);
    assertEquals(started, [[DEB_EXE, '--state-dir', '/home/ann/s']]);
    assertEquals(events, ['hold', 'start', 'release']);
    const log = Deno.readTextFileSync(args.log);
    assert(log.includes('is installed (apt); starting it') && log.includes('the new version is running'), log);
    // no start confirmation: no rollback (it would need a password), the log says how to go back
    alive = 0;
    assertEquals(await runHelper(args, deps({ code: 1 })), 7);
    assert(Deno.readTextFileSync(args.log).includes('github.com/sirkuttin/AIB/releases'));
    assertEquals(started.length, 2, 'not started a second time');
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

// ---- packaging ----------------------------------------------------------------------------------------------------------
async function gz(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await new Response(new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer(),
  );
}
async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await new Response(new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(),
  );
}

Deno.test('packaging: the .deb gets /usr/lib/aib/aib-install-deb (0755, LF) and the polkit action, with its folders', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-deb-pack-test-' });
  try {
    const enc = new TextEncoder();
    const dirEntry = (p: string) => tarEntry(p, new Uint8Array(), 0o755, 0, true);
    const data = new Uint8Array([
      ...dirEntry('./usr/'),
      ...dirEntry('./usr/lib/'),
      ...dirEntry('./usr/lib/aib/'),
      ...tarEntry('./usr/lib/aib/aib', enc.encode('#!/bin/sh\n'), 0o755, 0),
      ...dirEntry('./usr/share/'),
      ...new Uint8Array(1024),
    ]);
    const header = (name: string) => {
      const h = new Uint8Array(60).fill(0x20);
      h.set(enc.encode(name.padEnd(16, ' ')), 0);
      h.set(enc.encode('0'.padEnd(12)), 16);
      h.set(enc.encode('0'.padEnd(6)), 28);
      h.set(enc.encode('0'.padEnd(6)), 34);
      h.set(enc.encode('100644'.padEnd(8)), 40);
      h.set(enc.encode('`\n'), 58);
      return h;
    };
    const deb = `${dir}/aib.deb`;
    Deno.writeFileSync(
      deb,
      writeAr([
        { name: 'debian-binary', header: header('debian-binary'), data: enc.encode('2.0\n') },
        { name: 'control.tar.gz', header: header('control.tar.gz'), data: await gz(new Uint8Array(1024)) },
        { name: 'data.tar.gz', header: header('data.tar.gz'), data: await gz(data) },
      ]),
    );
    await addDebUpdater(deb);
    const tar = await gunzip(readAr(Deno.readFileSync(deb)).find((m) => m.name === 'data.tar.gz')!.data);
    const paths = tarPaths(tar);
    for (const p of ['usr/share/polkit-1/', 'usr/share/polkit-1/actions/', DEB_INSTALLER_PATH, DEB_POLICY_PATH, 'usr/lib/aib/aib']) {
      assert(paths.includes(p), `${p} in ${paths.join(', ')}`);
    }
    assertEquals(paths.filter((p) => p === 'usr/share/').length, 1, 'an existing folder is not added twice');
    // read the two files back with their modes
    const files: Record<string, { mode: number; text: string }> = {};
    for (let p = 0; p + 512 <= tar.length;) {
      const h = tar.subarray(p, p + 512);
      if (h.every((b) => b === 0)) break;
      const name = new TextDecoder().decode(h.subarray(0, 100)).replace(/\0.*$/s, '').replace(/^\.\//, '');
      const size = parseInt(new TextDecoder().decode(h.subarray(124, 136)).replace(/\0.*$/s, '').trim() || '0', 8);
      const mode = parseInt(new TextDecoder().decode(h.subarray(100, 108)).replace(/\0.*$/s, '').trim(), 8);
      files[name] = { mode, text: new TextDecoder().decode(tar.subarray(p + 512, p + 512 + size)) };
      p += 512 + Math.ceil(size / 512) * 512;
    }
    const script = files[DEB_INSTALLER_PATH];
    assertEquals(script.mode & 0o7777, 0o755);
    assert(script.text.startsWith('#!/bin/sh\n') && !script.text.includes('\r'), 'a POSIX script with LF line ends');
    assert(script.text.includes('--allow-downgrades') && script.text.includes('PKEXEC_UID'));
    const policy = files[DEB_POLICY_PATH];
    assertEquals(policy.mode & 0o7777, 0o644);
    assert(policy.text.includes('<message>Authentication is required to update AIB</message>'));
    assert(policy.text.includes('<annotate key="org.freedesktop.policykit.exec.path">/usr/lib/aib/aib-install-deb</annotate>'));
    assert(policy.text.includes('<allow_active>auth_admin</allow_active>'), 'an administrator password every time');
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

// ---- versions: what dpkg sees ---------------------------------------------------------------------------------------------
/** dpkg's version order (lib/dpkg/version.c verrevcmp, no epoch or revision: `deno desktop` writes neither). */
function dpkgCompare(a: string, b: string): number {
  const order = (c: string) => (c === '~' ? -1 : c === '' ? 0 : /[A-Za-z]/.test(c) ? c.charCodeAt(0) : c.charCodeAt(0) + 256);
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    let first = 0;
    while ((i < a.length && !/[0-9]/.test(a[i])) || (j < b.length && !/[0-9]/.test(b[j]))) {
      const ac = i < a.length && !/[0-9]/.test(a[i]) ? order(a[i]) : 0;
      const bc = j < b.length && !/[0-9]/.test(b[j]) ? order(b[j]) : 0;
      if (ac !== bc) return ac - bc;
      i++, j++;
    }
    while (a[i] === '0') i++;
    while (b[j] === '0') j++;
    while (i < a.length && /[0-9]/.test(a[i]) && j < b.length && /[0-9]/.test(b[j])) {
      if (!first) first = a.charCodeAt(i) - b.charCodeAt(j);
      i++, j++;
    }
    if (i < a.length && /[0-9]/.test(a[i])) return 1;
    if (j < b.length && /[0-9]/.test(b[j])) return -1;
    if (first) return first;
  }
  return 0;
}
/** The Version `deno desktop` writes into the .deb control file (seen in AIB-0.13.0-beta.test.2-linux-x64.deb: 0.13.0~beta.test.2). */
const debVersion = (v: string) => v.replaceAll('-', '~');

Deno.test('Debian versions: sane, ordered as AIB orders them except a release after its own test builds (hence --allow-downgrades)', () => {
  const pairs: [string, string, boolean][] = [
    // [from, to, dpkg sees an upgrade]
    ['0.13.2-beta.1', '0.13.2', true], // beta -> release
    ['0.13.1', '0.13.2', true],
    ['0.13.2-beta.1', '0.13.2-beta.2', true],
    ['0.13.2-test.1', '0.13.2', true], // X.test.M -> X
    ['0.13.2-beta.1.test.2', '0.13.2-beta.1', false], // X.test.M -> X: dpkg puts X.test.M above X
    ['0.13.0-beta.test.2', '0.13.0-beta', false],
    ['0.13.2-beta.1.test.2', '0.13.2', true],
  ];
  for (const [from, to, upgrade] of pairs) {
    assertEquals(compare(to, from), 1, `AIB: ${to} is newer than ${from}`);
    const d = Math.sign(dpkgCompare(debVersion(to), debVersion(from)));
    assertEquals(d, upgrade ? 1 : -1, `dpkg: ${debVersion(from)} -> ${debVersion(to)}`);
    for (const v of [debVersion(from), debVersion(to)]) assert(/^[0-9][A-Za-z0-9.+~]*$/.test(v), `a valid Debian upstream version: ${v}`);
  }
  assertEquals(dpkgCompare('0.13.0~beta.test.2', '0.13.0'), -1);
});

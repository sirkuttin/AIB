/**
 * The .deb self-update (server/desktop/updater.ts, update_helper.ts kind 'deb', tools/linux/): the pkexec argument check that mirrors
 * aib-install-deb, pkexec's answers as outcomes, pkexec only by its absolute path, the install target of a .deb install, the Install
 * now flow (the click answers at once with 'authorizing'; the password step runs in the background BEFORE the helper and the quit;
 * the chats are checked again after it; a closed prompt, a missing pkexec or polkit agent, a refused or unverifiable file leave AIB
 * open with why and the manual line; a partial install says how to finish it), that Install when chats finish, the background tick
 * and a remote device never open the password prompt, the helper's deb start, the packaging step that adds the script and the polkit
 * action to a .deb, and the Debian Version `deno desktop` writes. Everything is faked: no pkexec, no apt, no real app. The real
 * install (and the root script's own SHA256SUMS check and downgrade refusal) runs in deb_update_e2e_test.ts (WSL).
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import {
  compare,
  DEB_INSTALLER,
  debInstallArgs,
  debOutcome,
  findPkexec,
  PKEXEC_PATHS,
  postUpdateInstall,
  type PrivilegedResult,
  runPkexec,
  UpdateError,
  UpdateService,
  type UpdateServiceOptions,
} from '../../outputs/agent-studio/server/desktop/updater.ts';
import { remoteInstall, remoteUpdate } from '../../outputs/agent-studio/server/remote/update.ts';
import {
  DEB_EXE,
  dpkgOwns,
  type HelperArgs,
  installTarget,
  removeUpdateLeftovers,
  run as runHelper,
  type StartResult,
} from '../../outputs/agent-studio/server/desktop/update_helper.ts';
import {
  addDebUpdater,
  DEB_INSTALLER_PATH,
  DEB_POLICY_PATH,
  readAr,
  tarEntry,
  tarPaths,
  withUpdaterRelations,
  writeAr,
} from '../../tools/linux_package.ts';

const HOME = '/home/ann';
const V = '0.13.2';
const GOOD = `${HOME}/.local/state/agent-studio/updates/0.13.2/AIB-0.13.2-linux-x64.deb`;

Deno.test("debInstallArgs: only AIB's own download in the home folder gets a password prompt (the aib-install-deb rules)", () => {
  assertEquals(debInstallArgs(GOOD, HOME, V), [DEB_INSTALLER, GOOD, V]);
  assertEquals(debInstallArgs(GOOD, HOME + '/', V), [DEB_INSTALLER, GOOD, V], 'a trailing slash on HOME');
  const ok = [
    `${HOME}/.local/state/agent-studio/updates/0.13.2-beta.1/AIB-0.13.2-beta.1-linux-x64.deb`,
    `${HOME}/.local/state/agent-studio/updates/0.13.2-beta.12.test.3/AIB-0.13.2-beta.12.test.3-linux-arm64.deb`,
    `${HOME}/x/updates/1.0.0/AIB-1.0.0-linux-x64.deb`, // XDG_STATE_HOME elsewhere in the home folder
  ];
  for (const p of ok) {
    const v = p.split('/').at(-2)!;
    assertEquals(debInstallArgs(p, HOME, v), [DEB_INSTALLER, p, v], p);
  }
  // the version the window offered goes to root as the second argument; a file of another version gets no prompt
  assertEquals(debInstallArgs(GOOD, HOME, '0.13.3'), null, 'not the offered version');
  assertEquals(debInstallArgs(GOOD, HOME, ''), null, 'no offered version');
  assertEquals(debInstallArgs(GOOD, HOME, '0.13.2 -y'), null, 'an offered version with extra words');
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
  for (const [why, p] of refused) assertEquals(debInstallArgs(p, HOME, V), null, why);
  assertEquals(debInstallArgs(GOOD, '', V), null, 'no HOME');
  assertEquals(debInstallArgs(GOOD, 'home/ann', V), null, 'a relative HOME');
  assertEquals(debInstallArgs('/updates/0.13.2/AIB-0.13.2-linux-x64.deb', '/', V), null, 'HOME=/ (root) is not a user folder');
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
  // the root script's own checks: not the release's file (69), not newer (73): refused; no SHA256SUMS (68, 74): unverified
  for (const [code, says] of [[69, 'its SHA-256 is not the one in SHA256SUMS'], [73, '0.13.2 is not newer']] as const) {
    const [why, text] = no(debOutcome(r(code, `aib-install-deb: ${says}`)));
    assertEquals(why, 'refused', String(code));
    assert(text.includes(says) && text.includes('nothing was installed'), text);
  }
  for (const code of [68, 74]) {
    const [why, text] = no(debOutcome(r(code, 'aib-install-deb: could not fetch https://github.com/x/SHA256SUMS')));
    assertEquals(why, 'unverified');
    assert(text.includes("could not get the release's checksums from GitHub") && text.includes('nothing was installed'), text);
  }
  // 75: a tool the script needs is missing (setpriv; curl and wget): says which, nothing installed
  const [twhy, ttext] = no(
    debOutcome(r(75, 'aib-install-deb: setpriv is not installed (it comes with util-linux); nothing was installed')),
  );
  assertEquals(twhy, 'failed');
  assert(ttext.includes('needs a system tool') && ttext.includes('setpriv is not installed'), ttext);
  // 72: apt failed after unpacking: partly installed, says how to finish, never "unchanged"
  const [pwhy, ptext] = no(debOutcome(r(72, 'aib-install-deb: apt-get failed after unpacking 0.13.2: partly installed')));
  assertEquals(pwhy, 'partial');
  assert(ptext.includes('partly installed') && ptext.includes('sudo dpkg --configure -a') && !ptext.includes('unchanged'), ptext);
});

Deno.test('pkexec: only by its absolute system path (/usr/bin/pkexec, then /bin/pkexec), never looked up on PATH', async () => {
  assertEquals(PKEXEC_PATHS, ['/usr/bin/pkexec', '/bin/pkexec']);
  const there = (set: string[]) => (p: string) => {
    if (!set.includes(p)) throw new Deno.errors.NotFound(p);
    return { isFile: true };
  };
  assertEquals(findPkexec(PKEXEC_PATHS, there(['/usr/bin/pkexec', '/bin/pkexec'])), '/usr/bin/pkexec');
  assertEquals(findPkexec(PKEXEC_PATHS, there(['/bin/pkexec'])), '/bin/pkexec');
  assertEquals(findPkexec(PKEXEC_PATHS, there([])), null, 'none: no pkexec (the manual line), not a PATH search');
  assertEquals(findPkexec(['pkexec', 'bin/pkexec'], () => ({ isFile: true })), null, 'a bare or relative name is never used');
  assertEquals(findPkexec(PKEXEC_PATHS, () => ({ isFile: false })), null, 'a folder is not pkexec');
  // a pkexec only on PATH is not found: runPkexec answers "no pkexec" without running anything
  const dir = Deno.makeTempDirSync({ prefix: 'aib-pkexec-path-test-' });
  try {
    assertEquals(await runPkexec([DEB_INSTALLER, GOOD], [`${dir}/nowhere/pkexec`]), null);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
  // the source: Deno.Command gets the found absolute path, never the bare name 'pkexec'
  const src = Deno.readTextFileSync(new URL('../../outputs/agent-studio/server/desktop/updater.ts', import.meta.url));
  assert(!/new Deno\.Command\(\s*['"]pkexec['"]/.test(src), 'no Deno.Command("pkexec")');
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
  /** Runs while the (fake) password prompt is open. */
  duringPrompt: (() => void) | null = null;
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
      debArgs: (p, _home, v) => [DEB_INSTALLER, p, v], // the real check (above) needs POSIX paths; this test may run on Windows
      privileged: async (argv) => {
        this.asked.push({ argv, launchedBefore: this.launched.length, quitBefore: this.quit.length });
        await new Promise((r) => setTimeout(r, 5)); // the prompt is open a moment
        this.duringPrompt?.();
        return this.answers.length ? this.answers.shift()! : { code: 0, stderr: '' };
      },
      launcher: (a) => void this.launched.push(a),
      quit: (release) => void this.quit.push(release),
      busyChats: () => this.busy,
      now: () => 1_000_000,
      ...o,
    });
    const st = await this.svc.checkFeed();
    assertEquals([st.state, st.inPlace, st.instructions], ['ready', true, undefined], 'a .deb install offers Install now');
    assertEquals(
      [st.password, st.authorizing, st.askOnPc, st.restarting, st.installError],
      [true, false, false, false, ''],
      'the .deb fields',
    );
    return this.svc.state.downloaded!.path;
  }
  [Symbol.dispose]() {
    Deno.removeSync(this.dir, { recursive: true });
  }
}

Deno.test('.deb Install now: answers at once (authorizing), the window says AIB asks for the password, then helper and quit', async () => {
  using c = new DebCase();
  const path = await c.ready();
  assertEquals(await c.svc.install(), { state: 'authorizing' }, 'the click is answered at once, not after the prompt');
  assertEquals(c.svc.status().authorizing, true, 'while the prompt is open the status says so (the window shows it)');
  assertEquals([c.launched.length, c.quit.length], [0, 0]);
  await c.svc.debSettled();
  assertEquals(
    c.asked,
    [{ argv: [DEB_INSTALLER, path, VERSION], launchedBefore: 0, quitBefore: 0 }],
    'before the helper and the quit; with the offered version',
  );
  assertEquals(c.launched.length, 1);
  const a = c.launched[0];
  assertEquals([a.kind, a.target, a.exe, a.installer, a.version, a.sha256], ['deb', DEB_EXE, DEB_EXE, path, VERSION, await sha(PAYLOAD)]);
  assertEquals(c.quit, [false]);
  assertEquals(c.svc.status().authorizing, false);
  // the route: 200 {state: 'authorizing'} at once
  using d = new DebCase();
  await d.ready();
  const [code, body] = await postUpdateInstall(d.svc, {});
  assertEquals([code, body.state, body.ok], [200, 'authorizing', true]);
  await d.svc.debSettled();
});

Deno.test({
  name: '.deb Install now: a download saved group-writable (umask 002) is closed before the password prompt, so the root script takes it',
  ignore: Deno.build.os === 'windows',
  async fn() {
    using c = new DebCase();
    const path = await c.ready();
    const folder = path.slice(0, path.lastIndexOf('/'));
    const updates = folder.slice(0, folder.lastIndexOf('/'));
    // what an older build left: the file 664, its folders 775 (aib-install-deb: "can be written by others")
    Deno.chmodSync(path, 0o664);
    Deno.chmodSync(folder, 0o775);
    Deno.chmodSync(updates, 0o775);
    let others: number[] = [];
    c.duringPrompt = () => void (others = [path, folder, updates].map((p) => Deno.statSync(p).mode! & 0o022));
    assertEquals((await c.svc.install()).state, 'authorizing');
    await c.svc.debSettled();
    assertEquals(others, [0, 0, 0], 'file, version folder and updates folder: no group or other write while the root script runs');
  },
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
    [
      "the file is not the release's (root's own SHA-256 vs SHA256SUMS)",
      { code: 69, stderr: "aib-install-deb: the file is not the release's AIB-0.13.2-linux-x64.deb" },
      "the file is not the release's",
    ],
    [
      "root could not fetch the release's SHA256SUMS",
      { code: 68, stderr: 'aib-install-deb: could not fetch https://github.com/sirkuttin/AIB/releases/download/v0.13.2/SHA256SUMS' },
      "could not get the release's checksums",
    ],
    ['the version is not newer', { code: 73, stderr: 'aib-install-deb: 0.13.2 is not newer' }, 'is not newer'],
    ['apt fails', { code: 70, stderr: 'aib-install-deb: apt-get could not install 0.13.2' }, 'apt could not install'],
  ] as [string, PrivilegedResult, string][]
) {
  Deno.test(`.deb Install now when ${what}: nothing installs, AIB stays open, the status says why with the manual line`, async () => {
    using c = new DebCase();
    const path = await c.ready();
    c.answers.push(answer);
    assertEquals((await c.svc.install()).state, 'authorizing');
    await c.svc.debSettled();
    const st = c.svc.status();
    assert(st.installError!.includes(says), st.installError);
    assert(st.installError!.includes(`sudo apt install "${path}"`), "today's manual line, with the path: " + st.installError);
    assertEquals([c.launched.length, c.quit.length], [0, 0], 'no helper, no quit');
    assertEquals([st.state, st.inPlace, st.installWhenIdle, st.authorizing], ['ready', true, false, false], 'Update can be clicked again');
    // the next click starts afresh (the old reason goes)
    assertEquals((await c.svc.install()).state, 'authorizing');
    assertEquals(c.svc.status().installError, '');
    await c.svc.debSettled();
    assertEquals(c.launched.length, 1);
  });
}

Deno.test('.deb partly installed (apt failed after unpacking): says so and how to finish it, never "unchanged"; no restart', async () => {
  using c = new DebCase();
  await c.ready();
  c.answers.push({ code: 72, stderr: "aib-install-deb: apt-get failed after unpacking 0.13.2: aib is now '0.13.2 iF ', partly installed" });
  await c.svc.install();
  await c.svc.debSettled();
  const e = c.svc.status().installError!;
  assert(e.includes('only partly installed') && e.includes('sudo dpkg --configure -a') && e.includes('restart AIB'), e);
  assert(!e.includes('unchanged') && !e.includes('sudo apt install'), 'no "nothing changed", no manual line: ' + e);
  assertEquals([c.launched.length, c.quit.length], [0, 0]);
});

Deno.test('.deb Install when chats finish never opens the password prompt: it waits for Install now on the PC', async () => {
  using c = new DebCase();
  await c.ready();
  c.busy = 2;
  const e = await assertRejects(() => c.svc.install(true), UpdateError) as UpdateError;
  assertEquals(e.code, 'password_on_pc');
  assert(e.message.includes('needs your system password on the PC') && e.message.includes('Click Install now in AIB on the PC'), e.message);
  const st = c.svc.status();
  assertEquals([st.askOnPc, st.installWhenIdle], [true, false], 'Install now waits on the PC; no automatic install');
  c.busy = 0;
  await c.svc.tick();
  await c.svc.tick();
  assertEquals([c.asked.length, c.launched.length, c.quit.length], [0, 0, 0], 'chats done: still no prompt, no install');
  // the route answers 409 with the message
  const [code, body] = await postUpdateInstall(c.svc, { whenIdle: true });
  assertEquals([code, body.code], [409, 'password_on_pc']);
  // a wait saved by an older build (installWhenIdle in state.json): the tick turns it into Install now on the PC, no prompt
  c.svc.state.installWhenIdle = true;
  await c.svc.tick();
  assertEquals([c.asked.length, c.svc.state.installWhenIdle, c.svc.status().askOnPc], [0, false, true]);
  // only the click on the PC asks
  assertEquals((await c.svc.install()).state, 'authorizing');
  assertEquals(c.svc.status().askOnPc, false);
  await c.svc.debSettled();
  assertEquals([c.asked.length, c.launched.length], [1, 1]);
});

Deno.test('.deb Install now with chats working that cannot be handed over: no prompt now, no automatic install later', async () => {
  using c = new DebCase();
  await c.ready();
  c.busy = 1;
  const e = await assertRejects(() => c.svc.install(), UpdateError) as UpdateError;
  assertEquals([e.code, e.extra.password, e.extra.chats], ['chats_working', true, 1]);
  assert(e.message.includes('click Install now again once they finish') && !e.message.includes('so it waits'), e.message);
  assertEquals(c.svc.status().askOnPc, true);
  c.busy = 0;
  await c.svc.tick();
  assertEquals(c.asked.length, 0);
});

Deno.test('.deb from a phone or a paired computer: never a password prompt; 409 password_on_pc and Install now waits on the PC', async () => {
  using c = new DebCase();
  await c.ready();
  assertEquals(remoteUpdate(c.svc)?.password, true, 'the device can say it finishes on the PC');
  assertEquals(remoteUpdate(c.svc)?.canInstall, true);
  for (const body of [{}, { whenIdle: true }, { whenIdle: false }]) {
    const [code, reply] = await remoteInstall(c.svc, body);
    assertEquals([code, reply.code], [409, 'password_on_pc'], JSON.stringify(body));
    assert(String(reply.error).includes('needs your system password on the PC') && String(reply.error).includes('from here'));
    assertEquals((reply.update as { password?: boolean }).password, true);
  }
  await c.svc.tick();
  assertEquals([c.asked.length, c.launched.length, c.quit.length], [0, 0, 0]);
  assertEquals(c.svc.status().askOnPc, true);
});

Deno.test('.deb: a chat that starts while the prompt is open is seen after it: installed, AIB restarts once the chats finish', async () => {
  using c = new DebCase();
  await c.ready();
  c.duringPrompt = () => void (c.busy = 1);
  assertEquals((await c.svc.install()).state, 'authorizing');
  await c.svc.debSettled();
  assertEquals(c.asked.length, 1, 'installed');
  assertEquals([c.launched.length, c.quit.length], [0, 0], 'no quit over the chat that started during the prompt');
  assertEquals(c.svc.status().restarting, true);
  const [code, body] = await postUpdateInstall(c.svc, {});
  assertEquals([code, body.code], [409, 'busy'], 'no second prompt for an installed update');
  await c.svc.tick();
  assertEquals(c.quit.length, 0, 'still working');
  c.busy = 0;
  await c.svc.tick();
  assertEquals([c.asked.length, c.launched.length, c.quit], [1, 1, [false]], 'chats done: restart, no second password prompt');
  assertEquals(c.launched[0].kind, 'deb');
});

Deno.test('.deb Install now: a second click while the password prompt is open waits for it (409 busy)', async () => {
  using c = new DebCase();
  let answer!: (r: PrivilegedResult) => void;
  await c.ready({ privileged: () => new Promise<PrivilegedResult>((r) => (answer = r)) });
  assertEquals((await c.svc.install()).state, 'authorizing');
  const [code, body] = await postUpdateInstall(c.svc, {});
  assertEquals([code, body.code], [409, 'busy']);
  const [rcode, rbody] = await remoteInstall(c.svc, {});
  assertEquals([rcode, rbody.code], [409, 'busy']);
  answer({ code: 0, stderr: '' });
  await c.svc.debSettled();
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
  assertEquals(await c.svc.install(), { state: 'authorizing', chats: 1 });
  await c.svc.debSettled();
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
    // the control file as `deno desktop` writes it (seen in AIB-0.13.0-beta.test.2-linux-x64.deb), shortened
    const control = 'Package: aib\nVersion: 0.13.2\nArchitecture: amd64\nMaintainer: aib <noreply@deno.com>\n' +
      'Depends: libgtk-3-0, libnss3\nSection: utils\nPriority: optional\nDescription: aib desktop application\n';
    const controlTar = new Uint8Array([
      ...dirEntry('./'),
      ...tarEntry('./control', enc.encode(control), 0o644, 0),
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
        { name: 'control.tar.gz', header: header('control.tar.gz'), data: await gz(controlTar) },
        { name: 'data.tar.gz', header: header('data.tar.gz'), data: await gz(data) },
      ]),
    );
    await addDebUpdater(deb);
    // the control file now says what the root script needs (the app's own Depends kept, in front)
    const ctl = await gunzip(readAr(Deno.readFileSync(deb)).find((m) => m.name === 'control.tar.gz')!.data);
    assertEquals(tarPaths(ctl).at(-1), 'control');
    const ctlSize = parseInt(new TextDecoder().decode(ctl.subarray(512 + 124, 512 + 135)), 8); // control: header at 512, data at 1024
    const ctlText = new TextDecoder().decode(ctl.subarray(1024, 1024 + ctlSize));
    assert(ctlText.includes('\nDepends: libgtk-3-0, libnss3, util-linux (>= 2.36) | setpriv, curl | wget\n'), ctlText);
    assert(ctlText.includes('\nRecommends: pkexec | policykit-1\nDescription: aib desktop application\n'), ctlText);
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
    // root checks the file itself: its own copy read as the user, the release's SHA256SUMS fetched over HTTPS, only forward
    assert(script.text.includes('RELEASES=https://github.com/sirkuttin/AIB/releases/download'));
    assert(script.text.includes('url=$base/v$version/SHA256SUMS'));
    assert(script.text.includes('/usr/bin/curl') && script.text.includes('--proto "=$proto"') && script.text.includes('--max-time'));
    assert(script.text.includes('setpriv --reuid="$uid"'), "the copy is read with the user's permissions");
    // M1: the user-side reader's file is never hashed or installed: root copies it into a new file in a new root-only folder first
    assert(script.text.includes('head -c $((MAX_DEB + 1)) -- "$copy" >"$deb"'), "root's own new file from the user-side copy");
    assert(script.text.includes('rm -rf -- "$work/user"'), 'the user-side copy and its folder go before anything is made readable');
    assert(script.text.includes('sha256sum -- "$deb"') && !script.text.includes('sha256sum -- "$copy"'), 'root hashes only its own file');
    assert(
      script.text.includes('dpkg-deb --field "$deb" Package') && script.text.includes('--no-remove -o DPkg::Lock::Timeout=120 "$deb"'),
    );
    const at = (s: string) => script.text.indexOf(s);
    assert(at('rm -rf -- "$work/user"') < at('chmod 755 "$work" "$work/root"'), 'never widened while the user-side copy is there');
    assert(at('sha256sum -- "$deb"') < at('chmod 644 "$deb"'), 'readable only after the hash');
    // S3, S4, the notes
    assert(script.text.includes('[ "$#" -eq 2 ]') && script.text.includes('[ "$version" = "$expected" ]'), 'the offered version');
    assert(script.text.includes('command -v setpriv') && script.text.includes('fail 75'), 'a missing setpriv says so');
    assert(script.text.includes('timeout -k 10 300 setpriv'), 'the reader is killed even when traced');
    assert(script.text.includes('/usr/bin/curl -q ') && script.text.includes('/usr/bin/wget --no-config '), 'no user config files');
    assert(script.text.includes('file:///etc/aib/?*) proto=file'), 'S1: file:// only under /etc/aib');
    assert(
      script.text.includes('TEST_HOOK=/etc/aib/test-hook') && script.text.includes('root_only 74 "$TEST_HOOK"'),
      'test hook: root only',
    );
    // T1: the hook's scratch folder must be root's alone too, and the hook has a hard time limit and its own exit code (76)
    assert(
      script.text.includes('TEST_HOOK_RUN=/etc/aib/hook-run') && script.text.includes('root_only 74 "$TEST_HOOK_RUN"'),
      'test hook: its scratch folder is root only',
    );
    assert(
      at('root_only 74 "$TEST_HOOK_RUN"') < at('timeout -k 5 "$HOOK_LIMIT" /bin/sh "$TEST_HOOK"'),
      'the folder is checked before the hook runs',
    );
    assert(script.text.includes('HOOK_LIMIT=120 ') && script.text.includes('fail 76 "the test hook'), 'time limit, own code');
    // N2: a file:// source with no curl does not claim wget is missing
    assert(script.text.includes('elif [ "$proto" = file ]; then\n  fail 75 "curl is not installed'), 'file:// needs curl: says so');
    assert(script.text.includes('dpkg --compare-versions "$debversion" gt "$installed"'), 'only newer');
    assert(script.text.includes('SOURCE_FILE=/etc/aib/update-release-url'), 'the only override: a root-owned file');
    assert(!/\$\{?AIB_|getenv|\$HOME/.test(script.text), 'nothing from the environment decides where SHA256SUMS comes from');
    const policy = files[DEB_POLICY_PATH];
    assertEquals(policy.mode & 0o7777, 0o644);
    assert(policy.text.includes('<message>Authentication is required to update AIB</message>'));
    assert(policy.text.includes('<annotate key="org.freedesktop.policykit.exec.path">/usr/lib/aib/aib-install-deb</annotate>'));
    assert(policy.text.includes('<allow_active>auth_admin</allow_active>'), 'an administrator password every time');
    assert(policy.text.includes('<allow_any>no</allow_any>'), 'no prompt over SSH and the like');
    assert(policy.text.includes('<allow_inactive>no</allow_inactive>'), 'no prompt in an inactive session');
    assert(!policy.text.includes('auth_admin_keep'), 'never the five-minute keep');
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("packaging: Depends and Recommends for the self-update are added once, kept with the app's own, continuation lines too", () => {
  const add = 'util-linux (>= 2.36) | setpriv, curl | wget';
  assertEquals(
    withUpdaterRelations('Package: aib\nDepends: libgtk-3-0\nDescription: x\n'),
    `Package: aib\nDepends: libgtk-3-0, ${add}\nRecommends: pkexec | policykit-1\nDescription: x\n`,
  );
  assertEquals(
    withUpdaterRelations('Package: aib\nDescription: x\n'),
    `Package: aib\nDepends: ${add}\nRecommends: pkexec | policykit-1\nDescription: x\n`,
    'no Depends yet: added before Description',
  );
  assertEquals(
    withUpdaterRelations('Package: aib\nDepends: a,\n b\nRecommends: c\nDescription: x\n'),
    `Package: aib\nDepends: a, b, ${add}\nRecommends: c, pkexec | policykit-1\nDescription: x\n`,
    'a folded field is joined, the existing Recommends kept',
  );
  const once = withUpdaterRelations('Package: aib\nDepends: libgtk-3-0\nDescription: x\n');
  assertEquals(withUpdaterRelations(once), once, 'a second build step adds nothing');
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

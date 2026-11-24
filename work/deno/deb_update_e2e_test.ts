/**
 * The .deb self-update for real, in the Ubuntu WSL distro as a stand-in Linux machine (skips cleanly without it, without Deno for
 * Linux, curl or setpriv in it, when a real `aib` package is installed there, or when an /etc/aib this test did not make exists).
 * Headless: wsl.exe with piped stdio, no window, no password prompt.
 *
 * A crashed run (the PC went down: no `finally`) leaves /etc/aib with this test's marker, its user, sudoers drop-in and folder. The
 * next run removes them first (cleanStale: only this test's own names, only when older than STALE_MIN, so a run in progress in
 * another checkout is left alone) instead of skipping forever.
 *
 * Set-up (all undone at the end, also after a failure): a throwaway folder /tmp/aib-deb-e2e-<random>, a throwaway user whose home is
 * inside it, a sudoers drop-in that lets only that user run only /usr/lib/aib/aib-install-deb without a password (checked with
 * visudo before it is put in place), and a stand-in `pkexec` the driver calls by its absolute path (AIB itself only uses
 * /usr/bin/pkexec or /bin/pkexec) that goes through `sudo -n` (or answers "dismissed" for the cancel case, or swaps the file first
 * for the swap case). The root script fetches the release's SHA256SUMS itself; here it reads them from root-owned files under
 * /etc/aib/test-sums/v<version>/, because the test writes the root-owned /etc/aib/update-release-url (file:///etc/aib/test-sums):
 * the only override the script takes, which nothing the user controls can set (a file:// source must lie in root's own /etc/aib,
 * every folder root's alone), and which goes with /etc/aib at the end. The last install also runs with /etc/aib/test-hook (the
 * script runs it only from root's own /etc/aib): it plays a program of the user's that took the user-side reader's descriptor to
 * the first copy and writes another package through it after root's hash. Small test packages named `aib` are built here
 * with tools/linux_package.ts the way tools/build.ts adds the self-update to the real .deb (the real root script and polkit action; a
 * shell script stands in for the app): 0.13.2-beta.1.test.2 (installed first with dpkg), 0.13.2-beta.1, 0.13.2, an older 0.13.1,
 * and an "evil" 0.13.2-beta.1 with other content. At the end the package is purged; the user, the drop-in, /etc/aib and the folder go.
 *
 * What it proves, with AIB's own code running in the distro (work/deno/_deb_update_driver.ts):
 *   - aib-install-deb refuses everything that is not the caller's own AIB download (links, outside home, another package, another
 *     version, not the version AIB offered, folders others can write, a root-owned file, one or three arguments, no PKEXEC_UID), a
 *     file whose SHA-256 (root's own copy) is not the release's, a version whose SHA256SUMS cannot be fetched, a release-source
 *     file others can write, a file:// source outside /etc/aib, through a link or in a folder others can write, and anything not
 *     newer than the installed version (older, equal), and installs nothing then;
 *   - what is hashed and installed is a file root made itself (another inode than the user-side copy), and a descriptor to the
 *     user-side copy kept open past the hash cannot change what is installed;
 *   - a closed password prompt and no pkexec leave the old version installed, no helper started, AIB open, why and the manual line;
 *   - a file swapped while the password prompt is open (same name, same Version, an `aib` package) is refused by root;
 *   - Install when chats finish, the phone's Install and the ticks never call pkexec;
 *   - Install now installs the new .deb with apt BEFORE AIB quits (0.13.2~beta.1.test.2 -> 0.13.2~beta.1 is a downgrade for dpkg,
 *     the one allowed), then the real update helper starts the new version with the old app's arguments and it confirms its start;
 *     then a beta -> release step the same way.
 * Keeper take-over itself is the same helper code as on Windows (deb_update_test.ts checks the deb kind holds the keeper; `deno task
 * test:update-e2e` runs the real take-over).
 */
import { assert, assertEquals } from './_assert.ts';
import { addDebUpdater, readAr, tarEntry, writeAr } from '../../tools/linux_package.ts';

const DISTRO = 'Ubuntu';
const SYSTEM_ROOT = Deno.env.get('SystemRoot') ?? 'C:\\Windows';
const WSL = `${SYSTEM_ROOT}\\System32\\wsl.exe`;
const dec = new TextDecoder();
const enc = new TextEncoder();

type Run = { code: number; out: string; err: string };

/** `sh -c script` in the distro as root (args are $1..). */
async function asRoot(script: string, ...args: string[]): Promise<Run> {
  const out = await new Deno.Command(WSL, {
    args: ['--distribution', DISTRO, '--user', 'root', '--exec', 'sh', '-c', script, 'sh', ...args],
    env: { SystemRoot: SYSTEM_ROOT, WSL_UTF8: '1', WSLENV: '' },
    clearEnv: true,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  return { code: out.code, out: dec.decode(out.stdout), err: dec.decode(out.stderr) };
}

function listedDistros(): string[] {
  if (Deno.build.os !== 'windows') return [];
  try {
    const out = new Deno.Command(WSL, { args: ['-l', '-q'], stdout: 'piped', stderr: 'null', stdin: 'null' }).outputSync();
    return new TextDecoder('utf-16le').decode(out.stdout).split(/\r?\n/).map((l) => l.replaceAll('\0', '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** This test's mark in the /etc/aib it makes (a leftover with it is this test's own, from a run that never reached `finally`). */
const MARKER = '/etc/aib/.deb-update-e2e-test';
/** Leftovers younger than this may belong to a run in progress (another checkout): left alone. A run takes about two minutes. */
const STALE_MIN = 30;

/**
 * Removes what a crashed run of this test left (older than STALE_MIN minutes): /etc/aib with MARKER (and the test package, only if
 * its Description says it is this test's), and per sudoers drop-in aib-deb-e2e-<id>: the drop-in, user aibe2e<id[0:8]> and
 * /tmp/aib-deb-e2e-<id>. Prints one line per thing removed.
 */
async function cleanStale(): Promise<Run> {
  return await asRoot(
    `m=$1; min=$2
    if [ -f "$m" ] && [ -n "$(find "$m" -mmin +"$min" 2>/dev/null)" ]; then
      if dpkg-query -W -f='\${Description}' aib 2>/dev/null | grep -q deb_update_e2e_test; then dpkg --purge aib >/dev/null 2>&1; echo "purged the test package"; fi
      rm -rf /etc/aib && echo "removed /etc/aib"
    fi
    for f in /etc/sudoers.d/aib-deb-e2e-*; do
      id=\${f#/etc/sudoers.d/aib-deb-e2e-}
      printf '%s\\n' "$id" | grep -Eqx '[0-9a-f]{12}' || continue
      [ -n "$(find "$f" -mmin +"$min" 2>/dev/null)" ] || continue
      u=aibe2e$(printf '%s' "$id" | cut -c1-8)
      rm -f "$f"; pkill -u "$u" 2>/dev/null; getent passwd "$u" >/dev/null && userdel "$u" 2>/dev/null; rm -rf -- "/tmp/aib-deb-e2e-$id"
      echo "removed run $id"
    done
    exit 0`,
    MARKER,
    String(STALE_MIN),
  );
}

/** Why the test cannot run here ('' = it can): the distro, the tools it needs, Deno for Linux, no real aib, no /etc/aib. */
async function blocker(): Promise<string> {
  if (!listedDistros().some((d) => d.toLowerCase() === DISTRO.toLowerCase())) return `no ${DISTRO} WSL distro`;
  const stale = await cleanStale().catch((e) => ({ code: 1, out: '', err: String(e) }));
  if (stale.out.trim()) console.log(`deb_update_e2e_test: a crashed run's leftovers: ${stale.out.trim().replaceAll('\n', '; ')}`);
  const r = await asRoot(
    'for c in dpkg dpkg-deb apt-get sudo visudo useradd userdel runuser getent realpath setpriv timeout sha256sum awk find; do command -v $c >/dev/null || { echo "no $c"; exit 1; }; done; ' +
      '[ -x /usr/bin/curl ] || { echo "no /usr/bin/curl"; exit 1; }; ' +
      `[ -e ${MARKER} ] && { echo "another run of this test is in progress (or crashed less than ${STALE_MIN} minutes ago: /etc/aib has its mark)"; exit 1; }; ` +
      '[ -e /etc/aib ] && { echo "/etc/aib exists and was not made by this test (the test writes its own and removes it)"; exit 1; }; ' +
      'if dpkg-query -W -f="\\${Status}" aib 2>/dev/null | grep -q installed; then echo "a real aib package is installed"; exit 1; fi; ' +
      'u=$(getent passwd 1000 | cut -d: -f6); for d in "$u/.deno/bin/deno" /usr/local/bin/deno /usr/bin/deno; do [ -x "$d" ] && { echo "deno=$d"; exit 0; }; done; echo "no deno for Linux"; exit 1',
  ).catch((e) => ({ code: 1, out: String(e), err: '' }));
  return r.code === 0 ? '' : r.out.trim() || r.err.trim() || 'WSL is not usable';
}

const WHY = await blocker();
if (WHY) console.log(`deb_update_e2e_test: skipped (${WHY})`);

// ---- test packages --------------------------------------------------------------------------------------------------------
async function gz(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await new Response(new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer(),
  );
}
function arHeader(name: string): Uint8Array {
  const h = new Uint8Array(60).fill(0x20);
  const put = (at: number, text: string) => h.set(enc.encode(text), at);
  put(0, name);
  put(16, '0');
  put(28, '0');
  put(34, '0');
  put(40, '100644');
  put(58, '`\n');
  return h;
}
const dirEntry = (p: string) => tarEntry(p, new Uint8Array(), 0o755, undefined, true);
const join = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, o), o += p.length;
  return out;
};

/** The stand-in app: records that it ran (version, user, arguments) and confirms its start as AIB does (started-<version>.ok). */
const fakeApp = (version: string, evil: boolean) =>
  `#!/bin/sh
# AIB ${version} stand-in (deb_update_e2e_test)${evil ? ' EVIL: not the release' : ''}
state=
for a in "$@"; do [ "$prev" = --state-dir ] && state=$a; prev=$a; done
[ -n "$state" ] || exit 3
echo "${version} $(id -un) $*" >> "$state/fake-app-runs.txt"
: > "$state/updates/started-${version}.ok"
`;

/** A package named `package` at AIB version `version` (Version: every "-" a "~", as deno desktop writes it), with the self-update. */
async function buildDeb(path: string, version: string, arch: string, packageName = 'aib', evil = false): Promise<void> {
  const control =
    `Package: ${packageName}\nVersion: ${
      version.replaceAll('-', '~')
    }\nArchitecture: ${arch}\nMaintainer: aib <noreply@example.invalid>\n` +
    `Section: utils\nPriority: optional\nDescription: AIB test package (deb_update_e2e_test)\n`;
  const controlTar = join([dirEntry('./'), tarEntry('./control', enc.encode(control), 0o644), new Uint8Array(1024)]);
  const dataTar = join([
    dirEntry('./'),
    dirEntry('./usr/'),
    dirEntry('./usr/lib/'),
    dirEntry('./usr/lib/aib/'),
    tarEntry('./usr/lib/aib/aib', enc.encode(fakeApp(version, evil)), 0o755),
    dirEntry('./usr/share/'),
    new Uint8Array(1024),
  ]);
  Deno.writeFileSync(
    path,
    writeAr([
      { name: 'debian-binary', header: arHeader('debian-binary'), data: enc.encode('2.0\n') },
      { name: 'control.tar.gz', header: arHeader('control.tar.gz'), data: await gz(controlTar) },
      { name: 'data.tar.gz', header: arHeader('data.tar.gz'), data: await gz(dataTar) },
    ]),
  );
  await addDebUpdater(path); // what tools/build.ts does to the real .deb
  assert(readAr(Deno.readFileSync(path)).length === 3);
}

const toWsl = (p: string) => p.replace(/^([A-Za-z]):/, (_m, d: string) => `/mnt/${d.toLowerCase()}`).replaceAll('\\', '/');
const here = (name: string) => toWsl(decodeURIComponent(new URL(name, import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'));

async function sha(data: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

type Driven = {
  status: { state: string; inPlace: boolean; password?: boolean; available?: { path: string } };
  result: {
    ok?: { state: string };
    error?: string;
    code?: string;
    extra?: { path?: string };
    steps?: { ok?: unknown; code?: string; status?: number; error?: string }[];
  };
  after: { installError?: string; authorizing?: boolean; askOnPc?: boolean; restarting?: boolean };
  launched: number;
  quit: boolean | null;
};

Deno.test({
  name:
    '.deb self-update in WSL: root checks the file against the release itself and only goes forward; no prompt but from a click; Install now installs and restarts',
  ignore: !!WHY,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const id = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
    const ROOT = `/tmp/aib-deb-e2e-${id}`;
    const USER = `aibe2e${id.slice(0, 8)}`;
    const SUDOERS = `/etc/sudoers.d/aib-deb-e2e-${id}`;
    const SOURCE = '/etc/aib/update-release-url'; // the root script's only override (root-owned)
    const SUMS = '/etc/aib/test-sums'; // the release's SHA256SUMS as root fetches them here (file://, root-owned)
    const HOOK = '/etc/aib/test-hook'; // the root script's test hook (root-owned)
    const HOOK_RUN = '/etc/aib/hook-run'; // the hook's scratch folder: root-owned, 0700; the script runs the hook only if it is root's
    const HOME = `${ROOT}/home`;
    const STATE = `${HOME}/.local/state/agent-studio`;
    const PKEXEC = `${ROOT}/bin/pkexec`; // the stand-in, by its absolute path, as AIB calls /usr/bin/pkexec
    const win = Deno.makeTempDirSync({ prefix: 'aib-deb-e2e-' });
    const ok = async (what: string, script: string, ...args: string[]) => {
      const r = await asRoot(script, ...args);
      assertEquals(r.code, 0, `${what}: ${r.out}\n${r.err}`);
      return r.out;
    };
    let installed = false;
    let etc = false;
    try {
      // -- the throwaway machine: folder, user, Deno for Linux, sudo for the stand-in pkexec, the packages, the release source
      const arch = (await ok('arch', 'dpkg --print-architecture')).trim();
      const word = arch === 'arm64' ? 'arm64' : 'x64';
      const deno = (await ok(
        'deno',
        'u=$(getent passwd 1000 | cut -d: -f6); for d in "$u/.deno/bin/deno" /usr/local/bin/deno /usr/bin/deno; do [ -x "$d" ] && { echo "$d"; exit 0; }; done; exit 1',
      )).trim();
      const versions = ['0.13.2-beta.1.test.2', '0.13.2-beta.1', '0.13.2'];
      for (const v of [...versions, '0.13.1']) await buildDeb(`${win}\\AIB-${v}-linux-${word}.deb`, v, arch);
      await buildDeb(`${win}\\notaib.deb`, '0.13.2', arch, 'notaib');
      await buildDeb(`${win}\\evil.deb`, versions[1], arch, 'aib', true); // same name and Version as 0.13.2-beta.1, other content
      const sudoers = `${USER} ALL=(root) NOPASSWD: /usr/lib/aib/aib-install-deb\n`;
      const pkexec = `#!/bin/sh
# stand-in for pkexec (deb_update_e2e_test): never a password prompt. run/pkexec-mode: cancel = "dismissed";
# swap = an agent replaces the file while the prompt is open (same name, same Version, an aib package), then the password is typed
here=$(dirname "$0")/..
[ "$1" = /usr/lib/aib/aib-install-deb ] || { echo "Error executing command as another user: Not authorized" >&2; exit 127; }
echo "$*" >> "$here/run/pkexec-calls.txt"
case $(cat "$here/run/pkexec-mode" 2>/dev/null) in
  cancel) echo "Error executing command as another user: Request dismissed" >&2; exit 126 ;;
  swap) cp "$here/debs/evil.deb" "$2" || exit 1 ;;
esac
exec sudo -n "$@"
`;
      Deno.writeTextFileSync(`${win}\\sudoers`, sudoers);
      Deno.writeTextFileSync(`${win}\\pkexec`, pkexec);
      await ok(
        'set-up',
        `set -e
        mkdir -m 755 "$1" "$1/bin" "$1/debs" "$1/feeds"
        useradd -M -N -g nogroup -d "$1/home" -s /usr/sbin/nologin "$2"
        mkdir -m 700 "$1/home" && chown "$2" "$1/home"
        mkdir -m 755 "$1/run" "$1/tmp" "$1/denodir" && chown "$2" "$1/run" "$1/tmp" "$1/denodir" "$1/feeds"
        cp "$3" "$1/bin/deno" && chmod 755 "$1/bin/deno"
        tr -d '\\r' < "$4/pkexec" > "$1/bin/pkexec" && chmod 755 "$1/bin/pkexec"
        cp "$4"/*.deb "$1/debs/" && chmod 644 "$1"/debs/*
        tr -d '\\r' < "$4/sudoers" > "$1/sudoers" && visudo -cqf "$1/sudoers"
        install -m 0440 -o root -g root "$1/sudoers" "$5"`,
        ROOT,
        USER,
        deno,
        toWsl(win),
        SUDOERS,
      );
      etc = true; // the blocker made sure /etc/aib did not exist: from here on, the clean-up removes it
      await ok(
        'the release source (root-owned, its sums in root-owned /etc/aib/test-sums; the mark first, so a crash leaves it findable)',
        'mkdir -m 755 /etc/aib && echo "$1" > "$2" && mkdir -m 755 "$3" && printf "file://%s\\n" "$3" > "$4" && chmod 644 "$2" "$4"',
        ROOT,
        MARKER,
        SUMS,
        SOURCE,
      );
      const uid = (await ok('uid', 'id -u "$1"', USER)).trim();
      const debOf = (v: string) => `${ROOT}/debs/AIB-${v}-linux-${word}.deb`;
      const hashOf = async (file: string) => await sha(Deno.readFileSync(`${win}\\${file}`));
      const version = async () => (await asRoot("dpkg-query -W -f='${Version}' aib 2>/dev/null")).out.trim();
      /** The release's SHA256SUMS as root fetches it (root-owned): `name` with `hash`. */
      const publish = (v: string, lines: [string, string][]) =>
        ok(
          'publish SHA256SUMS',
          'mkdir -p "$1/v$2" && printf "%s" "$3" > "$1/v$2/SHA256SUMS"',
          SUMS,
          v,
          lines.map(([hash, name]) => `${hash}  ${name}\n`).join(''),
        );
      // the old version, installed by hand
      await ok('install the old version', 'dpkg -i "$1" >/dev/null', debOf(versions[0]));
      installed = true;
      assertEquals(await version(), '0.13.2~beta.1.test.2');
      await ok(
        'the package carries the script and the policy',
        'stat -c "%a %U" /usr/lib/aib/aib-install-deb | grep -qx "755 root" && grep -q "Authentication is required to update AIB" /usr/share/polkit-1/actions/dev.aib.app.update.policy && grep -q "<allow_any>no</allow_any>" /usr/share/polkit-1/actions/dev.aib.app.update.policy',
      );

      /** A feed folder with one version (its .deb and SHA256SUMS), owned by the user; and the release's SHA256SUMS for root. */
      const feed = async (v: string) => {
        const name = `AIB-${v}-linux-${word}.deb`;
        const hash = await hashOf(name);
        const dir = `${ROOT}/feeds/${v}`;
        await ok(
          'feed',
          'mkdir -p "$1/$2" && cp "$3" "$1/$2/" && printf "%s  %s\\n" "$4" "$5" > "$1/$2/SHA256SUMS" && chown -R "$6" "$1"',
          dir,
          v,
          debOf(v),
          hash,
          name,
          USER,
        );
        await publish(v, [['0'.repeat(64), `AIB-${v}-linux-other.deb`], [hash, name]]);
        return dir;
      };
      /** The old AIB (the driver) as the user; pkexec: the stand-in's absolute path (or a missing one). */
      const driver = async (current: string, feedDir: string, o: { pkexec?: string; mode?: string } = {}) => {
        const r = await asRoot(
          'cd "$1/tmp" && exec runuser -u "$2" -- env -i HOME="$1/home" USER="$2" PATH="$3" TMPDIR="$1/tmp" DENO_DIR="$1/denodir" DENO_NO_UPDATE_CHECK=1 NO_COLOR=1 ' +
            '"$1/bin/deno" run -A --no-config --no-lock "$4" "$5"',
          ROOT,
          USER,
          '/usr/sbin:/usr/bin:/sbin:/bin',
          here('./_deb_update_driver.ts'),
          JSON.stringify({
            current,
            feed: feedDir,
            state: STATE,
            helper: here('../../app/server/desktop/update_helper.ts'),
            tmp: `${ROOT}/tmp`,
            pkexec: o.pkexec ?? PKEXEC,
            mode: o.mode ?? 'click',
          }),
        );
        assertEquals(r.code, 0, `driver: ${r.out}\n${r.err}`);
        return JSON.parse(r.out.trim().split('\n').pop()!) as Driven;
      };
      const userRun = (script: string, ...args: string[]) =>
        asRoot(`u=$1; shift; exec runuser -u "$u" -- sh -c '${script}' sh "$@"`, USER, ...args);
      const calls = async () => (await asRoot('cat "$1/run/pkexec-calls.txt" 2>/dev/null', ROOT)).out.trim();

      await t.step("aib-install-deb refuses what is not the caller's own AIB download, or not the release's, or not newer", async () => {
        const v = '0.13.2';
        const name = `AIB-${v}-linux-${word}.deb`;
        const at = (x: string, ver = v) => `${HOME}/${x}/updates/${ver}/AIB-${ver}-linux-${word}.deb`;
        // the files, made by the user (umask 022): each case its own updates/<version> folder
        const made = await userRun(
          'set -e; h=$1/home; d=$2; v=$3; w=$4\n' +
            'put() { mkdir -p "$h/$1/updates/$2" && cp "$3" "$h/$1/updates/$2/AIB-$2-linux-$w.deb"; }\n' +
            'put good $v "$d/AIB-$v-linux-$w.deb"\n' +
            'mkdir -p "$h/link/updates/$v" && ln -s "$h/good/updates/$v/AIB-$v-linux-$w.deb" "$h/link/updates/$v/AIB-$v-linux-$w.deb"\n' +
            'put group $v "$d/AIB-$v-linux-$w.deb" && chmod 777 "$h/group/updates"\n' +
            'put other 0.13.4 "$d/notaib.deb"\n' +
            'put ver 0.13.3 "$d/AIB-$v-linux-$w.deb"\n' +
            'put swapped 0.13.2-beta.1 "$d/evil.deb"\n' +
            'put nosums 0.13.5 "$d/AIB-$v-linux-$w.deb"\n' +
            'put older 0.13.1 "$d/AIB-0.13.1-linux-$w.deb"\n' +
            'put equal 0.13.2-beta.1.test.2 "$d/AIB-0.13.2-beta.1.test.2-linux-$w.deb"\n' +
            'mkdir -p "$1/tmp/out/updates/$v" && cp "$h/good/updates/$v/AIB-$v-linux-$w.deb" "$1/tmp/out/updates/$v/"',
          ROOT,
          `${ROOT}/debs`,
          v,
          word,
        );
        assertEquals(made.code, 0, made.err);
        await ok(
          "a root-owned file in the user's folder",
          'mkdir -p "$1/rootfile/updates/$2" && cp "$1/good/updates/$2/$3" "$1/rootfile/updates/$2/" && chown -R "$4" "$1/rootfile" && chown root "$1/rootfile/updates/$2/$3"',
          HOME,
          v,
          name,
          USER,
        );
        // the release's SHA256SUMS for each version a case uses (none for 0.13.5: the fetch fails)
        const good = await hashOf(name);
        await publish(v, [[good, name]]);
        await publish('0.13.4', [[await hashOf('notaib.deb'), `AIB-0.13.4-linux-${word}.deb`]]); // listed, but another package
        await publish('0.13.3', [[good, `AIB-0.13.3-linux-${word}.deb`]]); // listed, but Version 0.13.2 inside
        await publish(versions[1], [[await hashOf(`AIB-${versions[1]}-linux-${word}.deb`), `AIB-${versions[1]}-linux-${word}.deb`]]);
        await publish('0.13.1', [[await hashOf(`AIB-0.13.1-linux-${word}.deb`), `AIB-0.13.1-linux-${word}.deb`]]);
        await publish(versions[0], [[await hashOf(`AIB-${versions[0]}-linux-${word}.deb`), `AIB-${versions[0]}-linux-${word}.deb`]]);
        const script = '/usr/lib/aib/aib-install-deb';
        const P = { PKEXEC_UID: uid };
        const cases: [string, string[], Record<string, string>, number, string][] = [
          ['a link', [at('link'), v], P, 64, 'goes through a link'],
          ['outside the home folder', [`${ROOT}/tmp/out/updates/${v}/${name}`, v], P, 64, 'not in the home folder'],
          ['a folder others can write', [at('group'), v], P, 64, 'can be written by others'],
          ['a root-owned file', [`${HOME}/rootfile/updates/${v}/${name}`, v], P, 64, 'does not belong'],
          ['another package (listed in SHA256SUMS)', [at('other', '0.13.4'), '0.13.4'], P, 65, 'not an AIB package'],
          ['another version inside (listed in SHA256SUMS)', [at('ver', '0.13.3'), '0.13.3'], P, 65, 'not 0.13.3'],
          [
            "same name and Version, other content: root's own SHA-256 is not the release's",
            [at('swapped', versions[1]), versions[1]],
            P,
            69,
            "is not the release's",
          ],
          ['no SHA256SUMS for the version (the fetch fails)', [at('nosums', '0.13.5'), '0.13.5'], P, 68, 'could not fetch'],
          ['an older version (genuine, listed)', [at('older', '0.13.1'), '0.13.1'], P, 73, 'is not newer'],
          ['the installed version again', [at('equal', versions[0]), versions[0]], P, 73, 'is not newer'],
          // S3: the version AIB offered (the window's) must be the folder's, the file name's and the package's
          ['not the version AIB offered (a genuine, newer release)', [at('good'), '0.13.3'], P, 64, 'AIB offered version 0.13.3'],
          ['an offered version that is no version', [at('good'), '0.13.2 x'], P, 64, 'has characters a version never has'],
          ['one argument (no offered version)', [at('good')], P, 64, 'expects two arguments'],
          ['three arguments', [at('good'), v, '-y'], P, 64, 'expects two arguments'],
          ['a relative path', [`good/updates/${v}/${name}`, v], P, 64, 'not absolute'],
          ['..', [`${HOME}/good/../good/updates/${v}/${name}`, v], P, 64, 'not plain'],
          ['not through pkexec', [at('good'), v], {}, 66, 'without pkexec'],
          ['asked for by root', [at('good'), v], { PKEXEC_UID: '0' }, 66, 'not by root'],
        ];
        const install = (...args: string[]) => asRoot('exec env -i "$@"', `PKEXEC_UID=${uid}`, script, ...args);
        for (const [what, args, env, code, says] of cases) {
          const r = await asRoot('exec env -i "$@"', ...Object.entries(env).map(([k, val]) => `${k}=${val}`), script, ...args);
          assertEquals(r.code, code, `${what}: ${r.err}`);
          assert(r.err.includes(says), `${what}: ${r.err}`);
        }
        // a SHA256SUMS line with another hash for the right name: refused the same way
        await publish(v, [['f'.repeat(64), name]]);
        const mismatch = await install(at('good'), v);
        assertEquals(mismatch.code, 69, mismatch.err);
        // the release source must be root's alone: writable by others, it is not trusted
        await ok('loosen the source', 'chmod 666 "$1"', SOURCE);
        const loose = await install(at('good'), v);
        await ok('restore the source', 'chmod 644 "$1"', SOURCE);
        assertEquals(loose.code, 74, loose.err);
        assert(loose.err.includes('can be written by others'), loose.err);
        // S1: a file:// source only in root's own /etc/aib, every folder on the way root's alone and no link (a leftover pointing
        // into /tmp, where any user can make the folder, is never taken)
        await publish(v, [[good, name]]);
        const source = async (what: string, base: string, says: string, setUp = 'true') => {
          await ok(`source: ${what}`, `${setUp} && printf "%s\\n" "$1" > "$2"`, base, SOURCE);
          const r = await install(at('good'), v);
          assertEquals(r.code, 74, `${what}: ${r.err}`);
          assert(r.err.includes(says), `${what}: ${r.err}`);
        };
        await ok('a sums folder in /tmp', `mkdir -p "$1/sums/v$2" && cp "${SUMS}/v$2/SHA256SUMS" "$1/sums/v$2/"`, ROOT, v);
        await source('in /tmp', `file://${ROOT}/sums`, 'points outside /etc/aib');
        await source('/etc/aib/.. tricks', 'file:///etc/aib/../tmp', 'not a plain path');
        await source(
          'a folder others can write',
          `file://${SUMS}/loose`,
          `${SUMS}/loose can be written by others`,
          `mkdir ${SUMS}/loose && cp -r ${SUMS}/v${v} ${SUMS}/loose/ && chmod 777 ${SUMS}/loose`,
        );
        await source('a link on the way', 'file:///etc/aib/linked', '/etc/aib/linked is a link', `ln -s ${SUMS} /etc/aib/linked`);
        await ok(
          'restore the source',
          `rm -rf ${SUMS}/loose /etc/aib/linked "${ROOT}/sums" && printf "file://%s\\n" "$1" > "$2"`,
          SUMS,
          SOURCE,
        );
        // run as the user, without root: refused before anything
        const plain = await userRun('/usr/lib/aib/aib-install-deb "$1" "$2"', at('good'), v);
        assertEquals(plain.code, 66, plain.err);
        assertEquals(await version(), '0.13.2~beta.1.test.2', 'nothing was installed');
        await ok('no root copies left in /tmp', '! ls -d /tmp/aib-install-deb.* 2>/dev/null');
        await ok(
          'clean the cases',
          'cd "$1" && rm -rf good link group other ver swapped nosums older equal rootfile "$2/tmp/out" "$3"/*',
          HOME,
          ROOT,
          SUMS,
        );
      });

      const feed1 = await feed(versions[1]);

      await t.step(
        'a closed password prompt: nothing installed, no helper, AIB stays open with why, the manual line and the path',
        async () => {
          await ok('cancel mode', 'echo cancel > "$1/run/pkexec-mode"', ROOT);
          const r = await driver(versions[0], feed1);
          assertEquals(
            [r.status.state, r.status.inPlace, r.status.password],
            ['ready', true, true],
            'the .deb install offers Install now (dpkg owns /usr/lib/aib/aib), with a password',
          );
          const path = r.status.available!.path;
          assertEquals(path, `${STATE}/updates/${versions[1]}/AIB-${versions[1]}-linux-${word}.deb`);
          assertEquals(r.result.ok?.state, 'authorizing', JSON.stringify(r.result));
          const why = r.after.installError ?? '';
          assert(why.includes('password prompt was closed') && why.includes(`sudo apt install "${path}"`), why);
          assertEquals([r.launched, r.quit, r.after.authorizing], [0, null, false]);
          assertEquals(await version(), '0.13.2~beta.1.test.2');
          assertEquals(
            await calls(),
            `/usr/lib/aib/aib-install-deb ${path} ${versions[1]}`,
            'pkexec: exactly the verified file and the offered version',
          );
          await ok('allow mode', 'rm -f "$1/run/pkexec-mode" "$1/run/pkexec-calls.txt"', ROOT);
        },
      );

      await t.step('no pkexec at the fixed path: the manual line, nothing installed', async () => {
        const r = await driver(versions[0], feed1, { pkexec: `${ROOT}/bin/no-such-pkexec` });
        assert((r.after.installError ?? '').includes('pkexec is not installed'), JSON.stringify(r));
        assertEquals([r.launched, r.quit], [0, null]);
        assertEquals(await version(), '0.13.2~beta.1.test.2');
      });

      await t.step('Install when chats finish, the phone and the ticks never call pkexec: Install now waits on the PC', async () => {
        const r = await driver(versions[0], feed1, { mode: 'scheduled' });
        const [idle, phone] = r.result.steps!;
        assertEquals([idle.code, phone.status, phone.code], ['password_on_pc', 409, 'password_on_pc'], JSON.stringify(r.result));
        assertEquals(r.after.askOnPc, true);
        assertEquals(await calls(), '', 'pkexec was never run');
        assertEquals([r.launched, r.quit], [0, null]);
        assertEquals(await version(), '0.13.2~beta.1.test.2');
      });

      await t.step(
        'the file is swapped while the password prompt is open: root checks its own copy against SHA256SUMS and refuses',
        async () => {
          await ok('swap mode', 'echo swap > "$1/run/pkexec-mode"', ROOT);
          const r = await driver(versions[0], feed1);
          assertEquals(r.result.ok?.state, 'authorizing', JSON.stringify(r.result));
          const why = r.after.installError ?? '';
          assert(why.includes('refused the downloaded file') && why.includes("is not the release's"), why);
          assertEquals([r.launched, r.quit], [0, null]);
          assertEquals(await version(), '0.13.2~beta.1.test.2', 'the swapped package was not installed');
          await ok(
            'allow mode, a fresh download',
            'rm -rf "$1/run/pkexec-mode" "$1/run/pkexec-calls.txt" "$2/updates/$3"',
            ROOT,
            STATE,
            versions[1],
          );
        },
      );

      /** Install now, then wait for the helper to start the new version and its start confirmation. */
      const update = async (from: string, to: string, feedDir: string) => {
        const r = await driver(from, feedDir);
        assertEquals(r.result.ok?.state, 'authorizing', JSON.stringify(r.result));
        assertEquals(r.after.installError ?? '', '', JSON.stringify(r.after));
        assertEquals([r.launched, r.quit], [1, false], 'the helper started, then AIB quit');
        assertEquals(await version(), to.replaceAll('-', '~'), 'apt installed it before AIB quit');
        let log = '';
        for (let i = 0; i < 120 && !/the new version is running|could not start|nothing was/.test(log); i++) {
          await new Promise((res) => setTimeout(res, 500));
          log = (await asRoot('cat "$1/updates/install.log" 2>/dev/null', STATE)).out;
        }
        assert(log.includes(`${to} is installed (apt); starting it`), log);
        assert(log.includes('the new version is running (it confirmed its start)'), log);
        const runs = (await ok('runs', 'cat "$1/fake-app-runs.txt"', STATE)).trim().split('\n');
        assertEquals(runs.pop(), `${to} ${USER} --state-dir ${STATE}`, "the new version, as the user, with the old app's arguments");
        await ok('reset the log', 'rm -f "$1/updates/install.log"', STATE);
      };

      await t.step(
        'Install now: 0.13.2-beta.1.test.2 -> 0.13.2-beta.1 (a downgrade for dpkg, the one allowed) installs, then AIB restarts on it',
        async () => {
          await update(versions[0], versions[1], feed1);
        },
      );

      await t.step(
        "Install now: beta -> release 0.13.2 the same way, while a descriptor to the user-side copy writes another package after root's hash: root installs only its own file",
        async () => {
          // M1: the user-side reader runs as the user, so a program of the user's can take its descriptor to the first copy
          // (pidfd_getfd; WSL has no Yama, like Debian's ptrace_scope 0). The hook plays that program: at "read" it opens the
          // first copy for writing and keeps it open; at "hashed" (after root's SHA-256 and package checks, before apt) it writes
          // evil.deb (another aib package) through it. Root's script runs the hook only from its own /etc/aib.
          // T1: the hook's scratch files are in root's own /etc/aib/hook-run (0700), never in a folder a user can make; the root script
          // runs the hook only when that folder is root's alone, and the loop below has a time limit of its own (60 s).
          const run = HOOK_RUN;
          const hook = `#!/bin/sh
# deb_update_e2e_test: a program of the user's holding the user-side reader's descriptor to the first copy
run=${run}
case $1 in
  read)
    stat -c %i -- "$2" > "$run/hook-read-inode"
    sh -c 'exec 3<>"$1" || exit 1; : > "$2/hook-open"; i=0; while [ ! -e "$2/hook-go" ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i + 1)); done; [ -e "$2/hook-go" ] || exit 1; cat "$3" >&3; echo $? > "$2/hook-wrote"' \\
      sh "$2" "$run" "${ROOT}/debs/evil.deb" </dev/null >/dev/null 2>&1 &
    i=0; while [ ! -e "$run/hook-open" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
    ;;
  hashed)
    stat -c %i -- "$2" > "$run/hook-hashed-inode"
    : > "$run/hook-go"
    i=0; while [ ! -e "$run/hook-wrote" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
    sha256sum -- "$2" | cut -d' ' -f1 > "$run/hook-hashed-sha"
    ;;
esac
exit 0
`;
          Deno.writeTextFileSync(`${win}\\test-hook`, hook);
          await ok(
            'the test hook (root-owned, in /etc/aib) and its root-only scratch folder',
            'mkdir -m 700 "$3" && tr -d "\\r" < "$1" > "$2" && chmod 644 "$2"',
            `${toWsl(win)}/test-hook`,
            HOOK,
            HOOK_RUN,
          );
          try {
            await update(versions[1], versions[2], await feed(versions[2]));
          } finally {
            await ok('remove the hook', 'rm -f "$1"', HOOK);
          }
          const read = async (f: string) => (await ok(f, 'cat "$1/$2"', run, f)).trim();
          assertEquals(await read('hook-wrote'), '0', 'the descriptor to the first copy was open and evil.deb was written through it');
          const [userInode, rootInode] = [await read('hook-read-inode'), await read('hook-hashed-inode')];
          assert(
            userInode && rootInode && userInode !== rootInode,
            `root hashed and installed its own new file (${userInode} vs ${rootInode})`,
          );
          assertEquals(await read('hook-hashed-sha'), await hashOf(`AIB-${versions[2]}-linux-${word}.deb`), "root's file is unchanged");
          assertEquals(await version(), '0.13.2', 'the release is installed, not the package written through the descriptor');
          await ok('the genuine app is installed', 'grep -q "AIB 0.13.2 stand-in" /usr/lib/aib/aib && ! grep -q EVIL /usr/lib/aib/aib');
        },
      );

      await t.step(
        "T1: root runs the test hook only when the hook's scratch folder is root's alone (else exit 74, hook not run); a failing or endless hook ends with its own code (76)",
        async () => {
          // the script run directly as root the way pkexec starts it, on the 0.13.1 download in the user's home; it stops at the hook
          // ("read") or right after it, at the release's checksums (none published for 0.13.1: 68)
          const file = `${HOME}/updates/0.13.1/AIB-0.13.1-linux-${word}.deb`;
          await ok(
            'a download for the direct runs',
            'mkdir -p "$1/updates/0.13.1" && cp "$2" "$3" && chmod 644 "$3" && chown -R "$4" "$1/updates" && chmod 755 "$1/updates" "$1/updates/0.13.1"',
            HOME,
            debOf('0.13.1'),
            file,
            USER,
          );
          const short = `${ROOT}/aib-install-deb-short`; // the same script with a 2 s hook limit
          await ok(
            'a copy with a short hook limit',
            'sed "s/^HOOK_LIMIT=120 /HOOK_LIMIT=2 /" /usr/lib/aib/aib-install-deb > "$1" && grep -q "^HOOK_LIMIT=2 " "$1" && chmod 755 "$1"',
            short,
          );
          const installHook = (body: string) =>
            ok(
              'install a hook',
              'printf "#!/bin/sh\\n: > /etc/aib/hook-ran\\n%s\\n" "$1" > /etc/aib/test-hook && chmod 644 /etc/aib/test-hook && rm -f /etc/aib/hook-ran',
              body,
            );
          const direct = (script: string) =>
            asRoot('PKEXEC_UID="$1" "$2" "$3" 0.13.1 </dev/null', uid, script, file);
          const ran = async () => (await asRoot('[ -e /etc/aib/hook-ran ]')).code === 0;
          const folder = (script: string) => ok('hook folder', script, HOOK_RUN);
          const SCRIPT = '/usr/lib/aib/aib-install-deb';
          try {
            await installHook('exit 0');
            // not root's alone: not there, a user's folder, a user-writable folder, a link: refused, and the hook never ran
            for (
              const [what, make, expect] of [
                ['missing', 'rm -rf "$1"', 'is not a folder'],
                ['owned by the user', `rm -rf "$1" && mkdir -m 700 "$1" && chown ${USER} "$1"`, 'does not belong to root'],
                ['writable by others', 'rm -rf "$1" && mkdir "$1" && chmod 777 "$1"', 'can be written by others'],
                ['a link', 'rm -rf "$1" && ln -s /tmp "$1"', 'is a link'],
              ] as const
            ) {
              await folder(make);
              const r = await direct(SCRIPT);
              assertEquals(r.code, 74, `${what}: ${r.err}`);
              assert(r.err.includes(expect), `${what}: ${r.err}`);
              assert(!(await ran()), `${what}: the hook was not run`);
            }
            await folder('rm -rf "$1" && mkdir -m 700 "$1"');
            // root's own folder: the hook runs; a failing hook has its own code and message
            await installHook('exit 3');
            let r = await direct(SCRIPT);
            assertEquals(r.code, 76, r.err);
            assert(r.err.includes('the test hook') && r.err.includes('failed or took longer'), r.err);
            assert(await ran(), 'the hook ran');
            // an endless hook (and anything it started) is stopped by the time limit
            await installHook('sleep 60');
            const t0 = Date.now();
            r = await direct(short);
            assertEquals(r.code, 76, r.err);
            assert(Date.now() - t0 < 30000, `stopped by the time limit, took ${Date.now() - t0} ms`);
            assertEquals((await asRoot('pgrep -f "[s]leep 60" >/dev/null')).code, 1, 'no hook process is left');
            // a good hook: the script goes on to the release's checksums (none for 0.13.1)
            await installHook('exit 0');
            r = await direct(SCRIPT);
            assertEquals(r.code, 68, r.err);
            assert(await ran(), 'the hook ran');
          } finally {
            await asRoot('rm -rf /etc/aib/test-hook /etc/aib/hook-run /etc/aib/hook-ran');
          }
        },
      );
    } finally {
      // everything this test made in the distro, and only that
      if (/^\/tmp\/aib-deb-e2e-[0-9a-f]{12}$/.test(ROOT) && /^aibe2e[0-9a-f]{8}$/.test(USER)) {
        await asRoot(
          `${installed ? 'dpkg --purge aib >/dev/null 2>&1;' : ''} ${etc ? 'rm -rf /etc/aib;' : ''} ` +
            'rm -f "$3"; pkill -u "$2" 2>/dev/null; sleep 0.5; userdel "$2" 2>/dev/null; rm -rf -- "$1"; ' +
            '[ ! -e "$1" ] && [ ! -e "$3" ] && ! getent passwd "$2" >/dev/null && { [ "$4" = 0 ] || [ ! -e /etc/aib ]; }',
          ROOT,
          USER,
          SUDOERS,
          etc ? '1' : '0',
        ).then((r) => assertEquals(r.code, 0, `clean-up: ${r.out} ${r.err}`));
        if (installed) {
          assertEquals((await asRoot('dpkg-query -W aib 2>/dev/null')).code === 0 ? 'left' : 'gone', 'gone', 'the test package is purged');
        }
      }
      Deno.removeSync(win, { recursive: true });
    }
  },
});

Deno.test({
  name: "deb update e2e: a crashed run's /etc/aib (with this test's mark), user, sudoers drop-in and folder are removed at the next start",
  ignore: !!WHY,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // what a run that never reached `finally` leaves: /etc/aib with the mark and a file:// source into /tmp, its user, drop-in, folder
    const id = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
    const ROOT = `/tmp/aib-deb-e2e-${id}`;
    const USER = `aibe2e${id.slice(0, 8)}`;
    const SUDOERS = `/etc/sudoers.d/aib-deb-e2e-${id}`;
    const leave = (age: string) =>
      asRoot(
        `set -e; mkdir -m 755 /etc/aib "$1"; echo "$1" > "$4"; printf "file://%s/sums\\n" "$1" > /etc/aib/update-release-url
        useradd -M -N -g nogroup -d "$1/home" -s /usr/sbin/nologin "$2"
        printf '%s ALL=(root) NOPASSWD: /usr/lib/aib/aib-install-deb\\n' "$2" > "$3"; chmod 440 "$3"
        touch -d "$5" "$4" "$3"`,
        ROOT,
        USER,
        SUDOERS,
        MARKER,
        age,
      );
    const gone = () =>
      asRoot('[ ! -e /etc/aib ] && [ ! -e "$1" ] && [ ! -e "$3" ] && ! getent passwd "$2" >/dev/null', ROOT, USER, SUDOERS);
    if ((await asRoot('[ -e /etc/aib ]')).code === 0) {
      console.log('deb_update_e2e_test: the leftover check skipped (/etc/aib exists now: another run, never touched)');
      return;
    }
    try {
      // a fresh one may be a run in progress in another checkout: left alone, and the blocker says why
      const fresh = await leave('1 minute ago');
      assertEquals(fresh.code, 0, fresh.err);
      assertEquals((await cleanStale()).out.trim(), '');
      assertEquals((await asRoot('[ -e "$1" ] && [ -e "$2" ]', MARKER, SUDOERS)).code, 0, 'a fresh run is left alone');
      assert((await blocker()).includes('another run of this test is in progress'), 'the blocker says why it skips');
      // aged past STALE_MIN: everything goes, and the blocker no longer skips because of it
      await asRoot('touch -d "2 hours ago" "$1" "$2"', MARKER, SUDOERS);
      const out = (await cleanStale()).out;
      assert(out.includes('removed /etc/aib') && out.includes(`removed run ${id}`), out);
      assertEquals((await gone()).code, 0, 'nothing of the crashed run is left');
      assertEquals(await blocker(), '', 'the test runs again');
      // an /etc/aib without the mark is not this test's: never removed, the test skips with why
      await asRoot('mkdir -m 755 /etc/aib && touch -d "2 hours ago" /etc/aib');
      assertEquals((await cleanStale()).out.trim(), '');
      assert((await blocker()).includes('was not made by this test'));
    } finally {
      await asRoot(
        'rm -rf /etc/aib "$1" "$3"; pkill -u "$2" 2>/dev/null; getent passwd "$2" >/dev/null && userdel "$2"; exit 0',
        ROOT,
        USER,
        SUDOERS,
      );
      assertEquals((await gone()).code, 0, 'clean-up');
    }
  },
});

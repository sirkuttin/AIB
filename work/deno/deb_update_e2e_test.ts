/**
 * The .deb self-update for real, in the Ubuntu WSL distro as a stand-in Linux machine (skips cleanly without it, without Deno for
 * Linux in it, or when a real `aib` package is installed there). Headless: wsl.exe with piped stdio, no window, no password prompt.
 *
 * Set-up (all undone at the end, also after a failure): a throwaway folder /tmp/aib-deb-e2e-<random>, a throwaway user whose home is
 * inside it, a sudoers drop-in that lets only that user run only /usr/lib/aib/aib-install-deb without a password (checked with
 * visudo before it is put in place), and a stand-in `pkexec` on that user's PATH that goes through `sudo -n` (or answers "dismissed"
 * for the cancel case). Three small test packages named `aib` are built here with tools/linux_package.ts the way tools/build.ts adds
 * the self-update to the real .deb (the real root script and polkit action; a shell script stands in for the app): 0.13.2-beta.1.test.2
 * (installed first with dpkg), 0.13.2-beta.1 and 0.13.2. At the end the package is purged, the user, the drop-in and the folder go.
 *
 * What it proves, with AIB's own code running in the distro (work/deno/_deb_update_driver.ts):
 *   - aib-install-deb refuses everything that is not the caller's own AIB download (links, outside home, another package, another
 *     version, folders others can write, a root-owned file, two arguments, no PKEXEC_UID) and installs nothing then;
 *   - a closed password prompt and a missing pkexec leave the old version installed, no helper started, AIB open, the manual line;
 *   - Install now installs the new .deb with apt BEFORE AIB quits (0.13.2~beta.1.test.2 -> 0.13.2~beta.1 is a downgrade for dpkg),
 *     then the real update helper starts the new version with the old app's arguments and it confirms its start; then a beta ->
 *     release step the same way.
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

/** Why the test cannot run here ('' = it can): the distro, the tools it needs, Deno for Linux, and no real aib installed. */
async function blocker(): Promise<string> {
  if (!listedDistros().some((d) => d.toLowerCase() === DISTRO.toLowerCase())) return `no ${DISTRO} WSL distro`;
  const r = await asRoot(
    'for c in dpkg dpkg-deb apt-get sudo visudo useradd userdel runuser getent realpath; do command -v $c >/dev/null || { echo "no $c"; exit 1; }; done; ' +
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
const fakeApp = (version: string) =>
  `#!/bin/sh
# AIB ${version} stand-in (deb_update_e2e_test)
state=
for a in "$@"; do [ "$prev" = --state-dir ] && state=$a; prev=$a; done
[ -n "$state" ] || exit 3
echo "${version} $(id -un) $*" >> "$state/fake-app-runs.txt"
: > "$state/updates/started-${version}.ok"
`;

/** A package named `package` at AIB version `version` (Version: every "-" a "~", as deno desktop writes it), with the self-update. */
async function buildDeb(path: string, version: string, arch: string, packageName = 'aib'): Promise<void> {
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
    tarEntry('./usr/lib/aib/aib', enc.encode(fakeApp(version)), 0o755),
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

Deno.test({
  name:
    '.deb self-update in WSL: the root script refuses foreign files; cancel and no pkexec install nothing; Install now installs and restarts',
  ignore: !!WHY,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const id = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
    const ROOT = `/tmp/aib-deb-e2e-${id}`;
    const USER = `aibe2e${id.slice(0, 8)}`;
    const SUDOERS = `/etc/sudoers.d/aib-deb-e2e-${id}`;
    const HOME = `${ROOT}/home`;
    const STATE = `${HOME}/.local/state/agent-studio`;
    const win = Deno.makeTempDirSync({ prefix: 'aib-deb-e2e-' });
    const ok = async (what: string, script: string, ...args: string[]) => {
      const r = await asRoot(script, ...args);
      assertEquals(r.code, 0, `${what}: ${r.out}\n${r.err}`);
      return r.out;
    };
    let installed = false;
    try {
      // -- the throwaway machine: folder, user, Deno for Linux, sudo for the stand-in pkexec, the packages
      const arch = (await ok('arch', 'dpkg --print-architecture')).trim();
      const word = arch === 'arm64' ? 'arm64' : 'x64';
      const deno = (await ok(
        'deno',
        'u=$(getent passwd 1000 | cut -d: -f6); for d in "$u/.deno/bin/deno" /usr/local/bin/deno /usr/bin/deno; do [ -x "$d" ] && { echo "$d"; exit 0; }; done; exit 1',
      )).trim();
      const versions = ['0.13.2-beta.1.test.2', '0.13.2-beta.1', '0.13.2'];
      for (const v of versions) await buildDeb(`${win}\\AIB-${v}-linux-${word}.deb`, v, arch);
      await buildDeb(`${win}\\notaib.deb`, '0.13.2', arch, 'notaib');
      const sudoers = `${USER} ALL=(root) NOPASSWD: /usr/lib/aib/aib-install-deb\n`;
      const pkexec = `#!/bin/sh
# stand-in for pkexec (deb_update_e2e_test): never a password prompt; "dismissed" when run/pkexec-mode says cancel
here=$(dirname "$0")/..
[ "$1" = /usr/lib/aib/aib-install-deb ] || { echo "Error executing command as another user: Not authorized" >&2; exit 127; }
echo "$*" >> "$here/run/pkexec-calls.txt"
case $(cat "$here/run/pkexec-mode" 2>/dev/null) in
  cancel) echo "Error executing command as another user: Request dismissed" >&2; exit 126 ;;
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
      const uid = (await ok('uid', 'id -u "$1"', USER)).trim();
      const debOf = (v: string) => `${ROOT}/debs/AIB-${v}-linux-${word}.deb`;
      const version = async () => (await asRoot("dpkg-query -W -f='${Version}' aib 2>/dev/null")).out.trim();
      // the old version, installed by hand
      await ok('install the old version', 'dpkg -i "$1" >/dev/null', debOf(versions[0]));
      installed = true;
      assertEquals(await version(), '0.13.2~beta.1.test.2');
      await ok(
        'the package carries the script and the policy',
        'stat -c "%a %U" /usr/lib/aib/aib-install-deb | grep -qx "755 root" && grep -q "Authentication is required to update AIB" /usr/share/polkit-1/actions/dev.aib.app.update.policy',
      );

      /** A feed folder with one version (its .deb and SHA256SUMS), owned by the user. */
      const feed = async (v: string) => {
        const name = `AIB-${v}-linux-${word}.deb`;
        const hash = await sha(Deno.readFileSync(`${win}\\${name}`));
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
        return dir;
      };
      /** The old AIB (the driver) as the user, with the stand-in pkexec on PATH unless withPkexec is false. */
      const driver = async (current: string, feedDir: string, withPkexec = true) => {
        const r = await asRoot(
          'cd "$1/tmp" && exec runuser -u "$2" -- env -i HOME="$1/home" USER="$2" PATH="$3" TMPDIR="$1/tmp" DENO_DIR="$1/denodir" DENO_NO_UPDATE_CHECK=1 NO_COLOR=1 ' +
            '"$1/bin/deno" run -A --no-config --no-lock "$4" "$5"',
          ROOT,
          USER,
          `${withPkexec ? `${ROOT}/bin:` : ''}/usr/sbin:/usr/bin:/sbin:/bin`,
          here('./_deb_update_driver.ts'),
          JSON.stringify({
            current,
            feed: feedDir,
            state: STATE,
            helper: here('../../outputs/agent-studio/server/desktop/update_helper.ts'),
            tmp: `${ROOT}/tmp`,
          }),
        );
        assertEquals(r.code, 0, `driver: ${r.out}\n${r.err}`);
        const line = r.out.trim().split('\n').pop()!;
        return JSON.parse(line) as {
          status: { state: string; inPlace: boolean; available?: { path: string } };
          result: { ok?: { state: string }; error?: string; code?: string; extra?: { path?: string } };
          launched: number;
          quit: boolean | null;
        };
      };
      const userRun = (script: string, ...args: string[]) =>
        asRoot(`u=$1; shift; exec runuser -u "$u" -- sh -c '${script}' sh "$@"`, USER, ...args);

      await t.step("aib-install-deb refuses what is not the caller's own AIB download, and installs nothing", async () => {
        const v = '0.13.2';
        const name = `AIB-${v}-linux-${word}.deb`;
        // the files, made by the user (umask 022)
        const made = await userRun(
          'set -e; h=$1/home; d=$2; n=$3; v=$4\n' +
            'for x in good link group; do mkdir -p "$h/$x/updates/$v"; done\n' +
            'cp "$d/AIB-$v-linux-$5.deb" "$h/good/updates/$v/$n"\n' +
            'ln -s "$h/good/updates/$v/$n" "$h/link/updates/$v/$n"\n' +
            'cp "$h/good/updates/$v/$n" "$h/group/updates/$v/$n" && chmod 777 "$h/group/updates"\n' +
            'mkdir -p "$h/other/updates/$v" && cp "$d/notaib.deb" "$h/other/updates/$v/$n"\n' +
            'mkdir -p "$h/ver/updates/0.13.3" && cp "$h/good/updates/$v/$n" "$h/ver/updates/0.13.3/AIB-0.13.3-linux-$5.deb"\n' +
            'mkdir -p "$1/tmp/out/updates/$v" && cp "$h/good/updates/$v/$n" "$1/tmp/out/updates/$v/$n"',
          ROOT,
          `${ROOT}/debs`,
          name,
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
        const script = '/usr/lib/aib/aib-install-deb';
        const cases: [string, string[], Record<string, string>, number, string][] = [
          ['a link', [`${HOME}/link/updates/${v}/${name}`], { PKEXEC_UID: uid }, 64, 'goes through a link'],
          ['outside the home folder', [`${ROOT}/tmp/out/updates/${v}/${name}`], { PKEXEC_UID: uid }, 64, 'not in the home folder'],
          ['a folder others can write', [`${HOME}/group/updates/${v}/${name}`], { PKEXEC_UID: uid }, 64, 'can be written by others'],
          ['a root-owned file', [`${HOME}/rootfile/updates/${v}/${name}`], { PKEXEC_UID: uid }, 64, 'does not belong'],
          ['another package', [`${HOME}/other/updates/${v}/${name}`], { PKEXEC_UID: uid }, 65, 'not an AIB package'],
          ['another version', [`${HOME}/ver/updates/0.13.3/AIB-0.13.3-linux-${word}.deb`], { PKEXEC_UID: uid }, 65, 'not 0.13.3'],
          ['two arguments', [`${HOME}/good/updates/${v}/${name}`, '-y'], { PKEXEC_UID: uid }, 64, 'exactly one argument'],
          ['a relative path', [`good/updates/${v}/${name}`], { PKEXEC_UID: uid }, 64, 'not absolute'],
          ['..', [`${HOME}/good/../good/updates/${v}/${name}`], { PKEXEC_UID: uid }, 64, 'not plain'],
          ['not through pkexec', [`${HOME}/good/updates/${v}/${name}`], {}, 66, 'without pkexec'],
          ['asked for by root', [`${HOME}/good/updates/${v}/${name}`], { PKEXEC_UID: '0' }, 66, 'not by root'],
        ];
        for (const [what, args, env, code, says] of cases) {
          const r = await asRoot('exec env -i "$@"', ...Object.entries(env).map(([k, val]) => `${k}=${val}`), script, ...args);
          assertEquals(r.code, code, `${what}: ${r.err}`);
          assert(r.err.includes(says), `${what}: ${r.err}`);
        }
        // run as the user, without root: refused before anything
        const plain = await userRun('/usr/lib/aib/aib-install-deb "$1"', `${HOME}/good/updates/${v}/${name}`);
        assertEquals(plain.code, 66, plain.err);
        assertEquals(await version(), '0.13.2~beta.1.test.2', 'nothing was installed');
        await ok('clean the cases', 'rm -rf "$1/good" "$1/link" "$1/group" "$1/other" "$1/ver" "$1/rootfile" "$2/tmp/out"', HOME, ROOT);
      });

      const feed1 = await feed(versions[1]);

      await t.step('a closed password prompt: nothing installed, no helper, AIB stays open with the manual line and the path', async () => {
        await ok('cancel mode', 'echo cancel > "$1/run/pkexec-mode"', ROOT);
        const r = await driver(versions[0], feed1);
        assertEquals(
          [r.status.state, r.status.inPlace],
          ['ready', true],
          'the .deb install offers Install now (dpkg owns /usr/lib/aib/aib)',
        );
        const path = r.status.available!.path;
        assertEquals(path, `${STATE}/updates/${versions[1]}/AIB-${versions[1]}-linux-${word}.deb`);
        assertEquals(r.result.code, 'manual', JSON.stringify(r.result));
        assert(
          r.result.error!.includes('password prompt was closed') && r.result.error!.includes(`sudo apt install "${path}"`),
          r.result.error,
        );
        assertEquals(r.result.extra?.path, path);
        assertEquals([r.launched, r.quit], [0, null]);
        assertEquals(await version(), '0.13.2~beta.1.test.2');
        const calls = (await ok('calls', 'cat "$1/run/pkexec-calls.txt"', ROOT)).trim();
        assertEquals(calls, `/usr/lib/aib/aib-install-deb ${path}`, 'pkexec was asked for exactly the verified file');
        await ok('allow mode', 'rm -f "$1/run/pkexec-mode" "$1/run/pkexec-calls.txt"', ROOT);
      });

      await t.step('no pkexec on the machine: the manual line, nothing installed', async () => {
        const r = await driver(versions[0], feed1, false);
        assertEquals(r.result.code, 'manual', JSON.stringify(r.result));
        assert(r.result.error!.includes('pkexec is not installed'), r.result.error);
        assertEquals([r.launched, r.quit], [0, null]);
        assertEquals(await version(), '0.13.2~beta.1.test.2');
      });

      /** Install now, then wait for the helper to start the new version and its start confirmation. */
      const update = async (from: string, to: string, feedDir: string) => {
        const r = await driver(from, feedDir);
        assertEquals(r.result.ok?.state, 'installing', JSON.stringify(r.result));
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
        'Install now: 0.13.2-beta.1.test.2 -> 0.13.2-beta.1 (a downgrade for dpkg) installs, then AIB restarts on it',
        async () => {
          await update(versions[0], versions[1], feed1);
        },
      );

      await t.step('Install now: beta -> release 0.13.2 the same way', async () => {
        await update(versions[1], versions[2], await feed(versions[2]));
      });
    } finally {
      // everything this test made in the distro, and only that
      if (/^\/tmp\/aib-deb-e2e-[0-9a-f]{12}$/.test(ROOT) && /^aibe2e[0-9a-f]{8}$/.test(USER)) {
        await asRoot(
          `${
            installed ? 'dpkg --purge aib >/dev/null 2>&1;' : ''
          } rm -f "$3"; pkill -u "$2" 2>/dev/null; sleep 0.5; userdel "$2" 2>/dev/null; rm -rf -- "$1"; ` +
            '[ ! -e "$1" ] && [ ! -e "$3" ] && ! getent passwd "$2" >/dev/null',
          ROOT,
          USER,
          SUDOERS,
        ).then((r) => assertEquals(r.code, 0, `clean-up: ${r.out} ${r.err}`));
        if (installed) {
          assertEquals((await asRoot('dpkg-query -W aib 2>/dev/null')).code === 0 ? 'left' : 'gone', 'gone', 'the test package is purged');
        }
      }
      Deno.removeSync(win, { recursive: true });
    }
  },
});

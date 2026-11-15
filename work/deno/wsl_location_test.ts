/**
 * platform/location.ts (docs/wsl/design.md sections 2 and 11): the canonical WSL ref, locOf / refOf, fromWslUnc (only the two WSL
 * share hosts, pure parsing), the /mnt/<x> mapping, validDistro / validLinuxPath, locKey (Linux paths case-sensitive, the distro
 * folded when the ref is built), isForeignPath, and a lint: no `new URL(` on a ref anywhere in the server.
 */
import { assert, assertEquals } from './_assert.ts';
import {
  canonicalFolder,
  fromWslUnc,
  insideLinux,
  isForeignPath,
  isWslRef,
  joinLinux,
  locKey,
  locOf,
  mntToWindows,
  normLinuxPath,
  projectPathOf,
  refOf,
  validDistro,
  validLinuxPath,
} from '../../outputs/agent-studio/server/platform/location.ts';
import { WSL_REF_PREFIX } from '../../outputs/agent-studio/server/wsl/contract.ts';

const WIN = Deno.build.os === 'windows';

Deno.test('refOf folds the distro and keeps the Linux path as written; locOf reads it back', () => {
  const ref = refOf({
    kind: 'wsl',
    distro: 'Ubuntu',
    linuxPath: '/home/u/My App',
  });
  assertEquals(ref, 'wsl://ubuntu/home/u/My App');
  assert(ref.startsWith(WSL_REF_PREFIX));
  assertEquals(locOf(ref), {
    kind: 'wsl',
    distro: 'ubuntu',
    linuxPath: '/home/u/My App',
  });
  assertEquals(locOf('wsl://Ubuntu/home/u'), {
    kind: 'wsl',
    distro: 'ubuntu',
    linuxPath: '/home/u',
  }, 'an unfolded ref still reads');
  assertEquals(locOf('wsl://ubuntu'), {
    kind: 'wsl',
    distro: 'ubuntu',
    linuxPath: '/',
  });
  assertEquals(locOf('  wsl://ubuntu/x  '), {
    kind: 'wsl',
    distro: 'ubuntu',
    linuxPath: '/x',
  });
  let threw = '';
  try {
    refOf({ kind: 'win' });
  } catch (error) {
    threw = (error as Error).name;
  }
  assertEquals(threw, 'TypeError');
});

Deno.test('locOf: this PC\'s own paths are {kind:"win"}; a bad ref or (on Windows) a drive-less path is null', () => {
  assertEquals(locOf(WIN ? 'C:\\w\\app' : '/home/u/app'), { kind: 'win' });
  assertEquals(locOf('relative\\x'), { kind: 'win' });
  for (
    const bad of ['wsl://', 'wsl://bad name/x', 'wsl://ubuntu/a/../b', 'wsl://ubuntu/a//b', 'wsl://ubuntu/a/', 'wsl:ubuntu/x', 'WSL:/x']
  ) {
    assertEquals(locOf(bad), null, bad);
  }
  assertEquals(locOf('wsl://ubuntu/a\\b'), null, 'no backslash in a Linux path AIB stores');
  assertEquals(locOf('wsl://ubuntu/a\nb'), null);
  assertEquals(locOf(42), null);
  if (WIN) assertEquals(locOf('/home/u/app'), null, 'on Windows /home/u is not C:\\home\\u');
});

Deno.test('isForeignPath: wsl: refs everywhere, drive-less absolute paths only on Windows; never throws', () => {
  for (const yes of ['wsl://ubuntu/x', 'WSL://Ubuntu/x', 'wsl:anything']) assert(isForeignPath(yes), yes);
  assert(isForeignPath('/home/u', true));
  assert(isForeignPath('/', true));
  assert(!isForeignPath('/home/u', false), 'a POSIX AIB (and the WSL helper) treats /home/u as its own');
  for (const no of ['C:\\x', 'c:/x', '\\\\server\\share', '//server/share', '\\x', 'x', '', null, undefined, 3, {}]) {
    assert(!isForeignPath(no, true), String(no));
  }
});

Deno.test('fromWslUnc: only \\\\wsl$ and \\\\wsl.localhost, any slash style; the path normalised, ".." refused', () => {
  assertEquals(fromWslUnc('\\\\wsl.localhost\\Ubuntu\\home\\u\\app'), {
    kind: 'wsl',
    distro: 'ubuntu',
    linuxPath: '/home/u/app',
  });
  assertEquals(fromWslUnc('\\\\wsl$\\Ubuntu-22.04\\home\\u\\'), {
    kind: 'wsl',
    distro: 'ubuntu-22.04',
    linuxPath: '/home/u',
  });
  assertEquals(fromWslUnc('//wsl.localhost/Ubuntu/srv'), {
    kind: 'wsl',
    distro: 'ubuntu',
    linuxPath: '/srv',
  });
  assertEquals(fromWslUnc('\\\\?\\UNC\\wsl.localhost\\Ubuntu\\x'), {
    kind: 'wsl',
    distro: 'ubuntu',
    linuxPath: '/x',
  });
  assertEquals(fromWslUnc('\\\\WSL.LOCALHOST\\Ubuntu'), {
    kind: 'wsl',
    distro: 'ubuntu',
    linuxPath: '/',
  });
  assertEquals(fromWslUnc('\\\\wsl.localhost\\Ubuntu\\a\\.\\b'), {
    kind: 'wsl',
    distro: 'ubuntu',
    linuxPath: '/a/b',
  });
  for (
    const bad of [
      '\\\\server\\share\\x',
      '\\\\wsl.localhost.evil.com\\Ubuntu\\x',
      '\\\\wsl\\Ubuntu\\x',
      '\\\\wsl.localhost\\bad name\\x',
      '\\\\wsl.localhost\\Ubuntu\\a\\..\\..\\etc',
      '\\\\wsl.localhost\\Ubuntu\\C:\\x',
      'C:\\x',
      '/home/u',
      '',
    ]
  ) {
    assertEquals(fromWslUnc(bad), null, bad);
  }
});

Deno.test('/mnt/<x> is a Windows drive seen from WSL: such a pick is a Windows project', () => {
  assertEquals(mntToWindows('/mnt/c/Users/u/app'), 'C:\\Users\\u\\app');
  assertEquals(mntToWindows('/mnt/d'), 'D:\\');
  assertEquals(mntToWindows('/mnt/wsl/x'), null);
  assertEquals(mntToWindows('/home/u'), null);
  assertEquals(projectPathOf({ kind: 'wsl', distro: 'ubuntu', linuxPath: '/mnt/c/w' }), 'C:\\w');
  assertEquals(projectPathOf({ kind: 'wsl', distro: 'Ubuntu', linuxPath: '/home/u' }), 'wsl://ubuntu/home/u');
  assertEquals(canonicalFolder('\\\\wsl.localhost\\Ubuntu\\mnt\\c\\w'), 'C:\\w');
  assertEquals(canonicalFolder('\\\\wsl$\\Ubuntu\\home\\u'), 'wsl://ubuntu/home/u');
  assertEquals(canonicalFolder('wsl://Ubuntu/home/u'), 'wsl://ubuntu/home/u');
  assertEquals(canonicalFolder('wsl://ubuntu/a/../b'), null);
  assertEquals(canonicalFolder(' C:\\w '), 'C:\\w');
});

Deno.test('validDistro and validLinuxPath', () => {
  for (const ok of ['Ubuntu', 'Ubuntu-22.04', 'debian', 'my_distro.1']) assert(validDistro(ok), ok);
  for (const bad of ['', 'a b', 'a/b', 'a\\b', '.', '..', 'x'.repeat(65), 'ü']) assert(!validDistro(bad), bad);
  assert(validDistro('ubuntu', ['Ubuntu', 'Debian']), 'known names compare case-insensitively');
  assert(!validDistro('Fedora', ['Ubuntu']));
  for (const ok of ['/', '/home', '/home/u/My App', '/a/.b/c']) assert(validLinuxPath(ok), ok);
  for (const bad of ['', 'home', '/a/', '/a//b', '/a/./b', '/a/../b', '/a\0b', '/a\nb', '/a\\b', '/' + 'x'.repeat(5000)]) {
    assert(!validLinuxPath(bad), JSON.stringify(bad));
  }
  assertEquals(normLinuxPath('//home//u/./app/'), '/home/u/app');
  assertEquals(normLinuxPath('/a/../b'), null);
  assertEquals(normLinuxPath('a/b'), null);
});

Deno.test('locKey: refs case-sensitive (Foo and foo are two projects), the distro folded; Windows paths case-folded', () => {
  assertEquals(locKey('wsl://Ubuntu/home/u/Foo'), 'wsl://ubuntu/home/u/Foo');
  assert(locKey('wsl://ubuntu/home/u/Foo') !== locKey('wsl://ubuntu/home/u/foo'));
  assertEquals(locKey('wsl://UBUNTU/x'), locKey('wsl://ubuntu/x'));
  assertEquals(locKey('C:/W/App', true), 'c:\\w\\app');
  assertEquals(locKey('/home/U', false), '/home/U');
});

Deno.test('Linux joins and inside checks follow POSIX rules and refuse climbing out', () => {
  assertEquals(joinLinux('/home/u/app', 'src/x.ts'), '/home/u/app/src/x.ts');
  assertEquals(joinLinux('/home/u/app', 'a//b/./c'), '/home/u/app/a/b/c');
  assertEquals(joinLinux('/home/u/app', '../etc'), null);
  assertEquals(joinLinux('/home/u/app', '/etc'), null);
  assert(insideLinux('/home/u/app/x', '/home/u/app'));
  assert(insideLinux('/home/u/app', '/home/u/app'));
  assert(!insideLinux('/home/u/apple', '/home/u/app'));
  assert(!insideLinux('/home/u/App/x', '/home/u/app'), 'case-sensitive');
  assert(insideLinux('/x', '/'));
  assert(isWslRef('WSL://x') && !isWslRef('C:\\x') && !isWslRef(null));
});

/** Every server file that mentions WSL refs; `new URL(` must never get one (it lowercases the host and encodes spaces). */
Deno.test('lint: a WSL ref is never URL-parsed in the server', () => {
  const root = new URL('../../outputs/agent-studio/server/', import.meta.url);
  const offenders: string[] = [];
  const walk = (dir: URL) => {
    for (const entry of Deno.readDirSync(dir)) {
      if (entry.isDirectory) walk(new URL(entry.name + '/', dir));
      else if (entry.name.endsWith('.ts')) {
        const file = new URL(entry.name, dir);
        const text = Deno.readTextFileSync(file);
        const lines = text.split('\n');
        const wslFile = /server\/(wsl|platform\/location)/.test(file.pathname);
        lines.forEach((line, i) => {
          if (!line.includes('new URL(')) return;
          // Files of the WSL layer never parse URLs at all; elsewhere a `new URL(` on a ref, a path or a project folder is refused.
          if (
            wslFile ||
            /new URL\([^)]*\b(refs?|\w*Ref|[Ww]sl\w*|WSL\w*|linuxPath|projectPath|cwd)\b/
              .test(line)
          ) {
            offenders.push(`${file.pathname.split('/server/')[1]}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }
  };
  walk(root);
  assertEquals(offenders, []);
  // and the reason, so the rule is not "fixed" by switching to URL: the Linux path would come back changed
  assert(new URL('wsl://ubuntu/home/u/My App').pathname !== '/home/u/My App');
});

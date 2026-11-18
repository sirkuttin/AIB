/**
 * Maki (beta_catalog.ts `maki`, release_install.ts): its catalog entry, AIB's own install from the GitHub release (download, SHA-256
 * check, unpack only the program) and how AIB finds Maki on this computer. Nothing here downloads: a fake fetch serves archives the
 * test builds, every folder is a temp folder. The real binary is driven by maki_e2e_test.ts.
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { join, PY, tempDir, touch } from './_agents.ts';
import { BETA_AGENTS, type BetaAgent, betaAgent } from '../../outputs/agent-studio/server/agents/beta_catalog.ts';
import { resolveBeta, signinArgv } from '../../outputs/agent-studio/server/agents/beta_agents.ts';
import {
  allowedDownload,
  downloadAsset,
  extractProgram,
  findReleaseInstall,
  fromTarGz,
  fromZip,
  programFile,
  releaseAsset,
  ReleaseError,
  releaseUrl,
  sha256Hex,
} from '../../outputs/agent-studio/server/agents/release_install.ts';
import { Installer, InstallRefused } from '../../outputs/agent-studio/server/agents/installer.ts';
import { installPlan } from '../../outputs/agent-studio/server/agents/beta_setup.ts';
import { BetaSigner } from '../../outputs/agent-studio/server/agents/beta_signin.ts';
import { BETA_IDS as ELIGIBLE_BETA } from '../../outputs/agent-studio/server/agents/eligibility.ts';

const WIN = Deno.build.os === 'windows';
const sanitize = { sanitizeOps: false, sanitizeResources: false };
const maki = betaAgent('maki')!;
const envWith = (...dirs: string[]) => ({
  PATH: dirs.join(WIN ? ';' : ':'),
  ComSpec: 'C:\\Windows\\System32\\cmd.exe',
});

// ---- archives the tests build -------------------------------------------------------------------------------------------

async function squeeze(
  data: Uint8Array,
  format: 'gzip' | 'deflate-raw',
): Promise<Uint8Array> {
  const out = await new Response(
    new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(
      new CompressionStream(format),
    ),
  )
    .arrayBuffer();
  return new Uint8Array(out);
}

/** A .zip with these entries (deflated unless `stored`). CRCs are left 0: AIB checks the archive's SHA-256, not CRCs. */
async function makeZip(
  entries: [string, Uint8Array][],
  stored = false,
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const body = stored ? data : await squeeze(data, 'deflate-raw');
    const n = enc.encode(name);
    const local = new Uint8Array(30 + n.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, stored ? 0 : 8, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, n.length, true);
    local.set(n, 30);
    local.set(body, 30 + n.length);
    const central = new Uint8Array(46 + n.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, stored ? 0 : 8, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, n.length, true);
    cv.setUint32(42, offset, true);
    central.set(n, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  return concat([...locals, ...centrals, end]);
}

/** A .tar.gz (ustar) with these regular files. */
async function makeTarGz(entries: [string, Uint8Array][]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const [name, data] of entries) {
    const h = new Uint8Array(512);
    h.set(enc.encode(name), 0);
    h.set(enc.encode('0000755\0'), 100);
    h.set(enc.encode(data.length.toString(8).padStart(11, '0') + '\0'), 124);
    h[156] = 48; // '0'
    h.set(enc.encode('ustar\0'), 257);
    parts.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  return await squeeze(concat(parts), 'gzip');
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const PROGRAM = new TextEncoder().encode(
  '#!/bin/sh\necho fake maki\n'.repeat(50),
);

/** A Maki catalog entry whose asset for `platform` is this archive (its real size and SHA-256). */
async function fakeMaki(
  platform: string,
  file: string,
  archive: Uint8Array,
): Promise<BetaAgent> {
  const asset = {
    file,
    sha256: await sha256Hex(archive),
    bytes: archive.length,
  };
  return {
    ...maki,
    release: { ...maki.release!, assets: { [platform]: asset } },
  };
}

/** A fetch that answers every URL with `body` (and records what was asked). */
function fakeFetch(
  body: Uint8Array,
  log: string[] = [],
  url = '',
): typeof fetch {
  return ((input: string | URL | Request) => {
    log.push(String(input));
    const res = new Response(body as Uint8Array<ArrayBuffer>, { status: 200 });
    if (url) Object.defineProperty(res, 'url', { value: url });
    return Promise.resolve(res);
  }) as typeof fetch;
}

/** Swap Maki's catalog entry for the test (the catalog array is readonly to the type system only). */
function withCatalog(agent: BetaAgent): { [Symbol.dispose](): void } {
  const list = BETA_AGENTS as BetaAgent[];
  const at = list.findIndex((a) => a.id === 'maki');
  const real = list[at];
  list[at] = agent;
  return { [Symbol.dispose]: () => void (list[at] = real) };
}

async function finish(installer: Installer, id = 'maki') {
  await installer.jobs.get(id)?.done;
  return await installer.status(id);
}

// ---- the catalog entry ----------------------------------------------------------------------------------------------------

Deno.test('Maki: `maki acp`, sign-in with `maki auth login` or an Anthropic key, after Kilo in the Beta list (PC and phone)', () => {
  assertEquals(BETA_AGENTS[BETA_AGENTS.findIndex((a) => a.id === 'kilo') + 1].id, 'maki');
  assert(ELIGIBLE_BETA.includes('maki'), 'the phone list knows it');
  assertEquals([maki.name, maki.license, maki.commands, maki.args], [
    'Maki',
    'MIT',
    ['maki'],
    ['acp'],
  ]);
  assertEquals(maki.signin, {
    kind: 'terminal',
    terminalArgs: ['auth', 'login'],
    keyEnv: 'ANTHROPIC_API_KEY',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    baseUrlHint: 'https://api.anthropic.com',
  });
  assertEquals(maki.exitsWhenSignedOut, true);
  assert(
    !maki.npm && !maki.vendorInstall,
    'installed from its release only: no npm package, no install script',
  );
  assert(maki.docs.startsWith('https://maki.sh/'));
  assert(
    maki.signinDirs!.includes('AppData/Roaming/maki') &&
      maki.signinDirs!.includes('.local/share/maki'),
    'its auth folder',
  );
});

Deno.test('Maki release: v0.7.2 archives for Windows (x64, Arm via x64), macOS and Linux, each with a pinned SHA-256', () => {
  const rel = maki.release!;
  assertEquals([rel.repo, rel.tag, rel.version, rel.program], [
    'tontinton/maki',
    'v0.7.2',
    '0.7.2',
    'maki',
  ]);
  assertEquals(Object.keys(rel.assets).sort(), [
    'darwin-aarch64',
    'darwin-x86_64',
    'linux-aarch64',
    'linux-x86_64',
    'windows-aarch64',
    'windows-x86_64',
  ]);
  for (const [platform, asset] of Object.entries(rel.assets)) {
    assert(/^[0-9a-f]{64}$/.test(asset.sha256 ?? ''), platform);
    assert(asset.bytes > 10_000_000 && asset.bytes < 100_000_000, platform);
    assert(
      asset.file.startsWith('maki-v0.7.2-') &&
        /\.(zip|tar\.gz)$/.test(asset.file),
      platform,
    );
    assertEquals(
      asset.file.endsWith('.zip'),
      platform.startsWith('windows'),
      platform,
    );
    assertEquals(
      releaseUrl(rel, asset),
      `https://github.com/tontinton/maki/releases/download/v0.7.2/${asset.file}`,
    );
  }
  assertEquals(
    rel.assets['windows-aarch64'],
    rel.assets['windows-x86_64'],
    'Windows on Arm runs the x64 build',
  );
  assertEquals(releaseAsset(maki, 'freebsd-x86_64'), null);
  assertEquals([programFile(rel, 'windows'), programFile(rel, 'linux')], [
    'maki.exe',
    'maki',
  ]);
  for (const os of ['windows', 'darwin', 'linux'] as const) {
    assertEquals(installPlan(maki, os).kind, 'download');
  }
});

Deno.test('downloads come only from github.com and its release CDN, over https', () => {
  assert(
    allowedDownload(
      'https://github.com/tontinton/maki/releases/download/v0.7.2/x.zip',
    ),
  );
  assert(
    allowedDownload(
      'https://release-assets.githubusercontent.com/github-production-release-asset/1/2?x=y',
    ),
  );
  assert(allowedDownload('https://objects.githubusercontent.com/a/b'));
  for (
    const bad of [
      'http://github.com/a',
      'https://github.com.evil.example/a',
      'https://maki.sh/install.sh',
      'file:///c:/x',
      'nonsense',
    ]
  ) {
    assert(!allowedDownload(bad), bad);
  }
  const rel = maki.release!;
  for (const file of ['../x.zip', 'a b.zip', 'x.zip?y']) {
    let threw = false;
    try {
      releaseUrl(rel, { file, sha256: '0'.repeat(64), bytes: 1 });
    } catch {
      threw = true;
    }
    assert(threw, file);
  }
});

// ---- unpacking ------------------------------------------------------------------------------------------------------------

Deno.test('unpack: the program at the root of a .zip (deflated or stored) or a .tar.gz, nothing else', async () => {
  const other = new TextEncoder().encode('readme');
  for (const stored of [false, true]) {
    const zip = await makeZip(
      [['README.md', other], ['maki.exe', PROGRAM]],
      stored,
    );
    assertEquals(
      await fromZip(zip, 'maki.exe'),
      PROGRAM,
      stored ? 'stored' : 'deflated',
    );
    assertEquals(
      await extractProgram(
        zip,
        'maki-v0.7.2-x86_64-pc-windows-msvc.zip',
        'maki.exe',
      ),
      PROGRAM,
    );
  }
  const tgz = await makeTarGz([['./README.md', other], ['./maki', PROGRAM]]);
  assertEquals(await fromTarGz(tgz, 'maki'), PROGRAM);
  assertEquals(
    await extractProgram(
      tgz,
      'maki-v0.7.2-x86_64-unknown-linux-musl.tar.gz',
      'maki',
    ),
    PROGRAM,
  );
  // a program in a sub-folder, or a look-alike path, is not the one at the root
  await assertRejects(
    async () => await fromZip(await makeZip([['bin/maki.exe', PROGRAM]]), 'maki.exe'),
    ReleaseError,
  );
  await assertRejects(
    async () => await fromZip(await makeZip([['../maki.exe', PROGRAM]]), 'maki.exe'),
    ReleaseError,
  );
  await assertRejects(
    async () => await fromTarGz(await makeTarGz([['x/maki', PROGRAM]]), 'maki'),
    ReleaseError,
  );
  // not an archive at all
  await assertRejects(
    async () => await fromZip(PROGRAM, 'maki.exe'),
    ReleaseError,
  );
  await assertRejects(
    async () => await fromTarGz(PROGRAM, 'maki'),
    ReleaseError,
  );
});

Deno.test('download: the exact size from GitHub only; a redirect elsewhere, a short or a long body is refused', async () => {
  const body = new Uint8Array(1000).fill(7);
  const asset = {
    file: 'x.zip',
    sha256: await sha256Hex(body),
    bytes: body.length,
  };
  const url = 'https://github.com/tontinton/maki/releases/download/v0.7.2/x.zip';
  const log: string[] = [];
  assertEquals(
    await downloadAsset(url, asset, {
      fetch: fakeFetch(
        body,
        log,
        'https://release-assets.githubusercontent.com/a',
      ),
    }),
    body,
  );
  assertEquals(log, [url]);
  const refused = async (p: Promise<unknown>, words: RegExp) => {
    const error = await assertRejects(() => p, ReleaseError);
    assert(words.test(error.message), error.message);
  };
  await refused(
    downloadAsset(url, asset, {
      fetch: fakeFetch(body, [], 'https://evil.example/x'),
    }),
    /somewhere other than GitHub/,
  );
  await refused(
    downloadAsset(url, { ...asset, bytes: 999 }, { fetch: fakeFetch(body) }),
    /larger than/,
  );
  await refused(
    downloadAsset(url, { ...asset, bytes: 1001 }, { fetch: fakeFetch(body) }),
    /part way/,
  );
  await refused(
    downloadAsset('https://maki.sh/install.sh', asset, {
      fetch: fakeFetch(body),
    }),
    /only downloads agents from github/,
  );
  const notFound = (() => Promise.resolve(new Response('nope', { status: 404 }))) as typeof fetch;
  await refused(downloadAsset(url, asset, { fetch: notFound }), /answered 404/);
  const offline = (() => Promise.reject(new TypeError('dns'))) as typeof fetch;
  await refused(
    downloadAsset(url, asset, { fetch: offline }),
    /Could not reach github.com/,
  );
});

// ---- AIB's own install ------------------------------------------------------------------------------------------------------

const PLATFORM = WIN ? 'windows-x86_64' : `${Deno.build.os}-x86_64`;
const FILE = WIN ? 'maki-v0.7.2-x86_64-pc-windows-msvc.zip' : 'maki-v0.7.2-x86_64-unknown-linux-musl.tar.gz';
const archiveFor = () => (WIN ? makeZip([['maki.exe', PROGRAM]]) : makeTarGz([['maki', PROGRAM]]));

Deno.test(
  'Install: downloads the release, checks its SHA-256, unpacks the program; AIB then starts that copy first',
  sanitize,
  async () => {
    using dir = tempDir();
    const archive = await archiveFor();
    using _ = withCatalog(await fakeMaki(PLATFORM, FILE, archive));
    const log: string[] = [];
    const installer = new Installer(dir.root, {
      fetch: fakeFetch(archive, log),
      platform: PLATFORM,
      diskFree: () => 1e12,
    });
    const started = await installer.start('maki');
    assertEquals(started.state, 'running');
    const done = await finish(installer);
    assertEquals([done.state, done.message], ['done', '']);
    assertEquals(log, [
      `https://github.com/tontinton/maki/releases/download/v0.7.2/${FILE}`,
    ]);
    const folder = join(dir.root, 'agents', 'maki', '0.7.2');
    const program = join(folder, WIN ? 'maki.exe' : 'maki');
    assertEquals(Deno.readFileSync(program), PROGRAM);
    assertEquals([...Deno.readDirSync(folder)].map((e) => e.name).sort(), [
      '.complete',
      WIN ? 'maki.exe' : 'maki',
    ]);
    const marker = JSON.parse(Deno.readTextFileSync(join(folder, '.complete')));
    assertEquals([marker.package, marker.version, marker.file], [
      'github:tontinton/maki',
      '0.7.2',
      FILE,
    ]);
    if (!WIN) {
      assert((Deno.statSync(program).mode! & 0o111) !== 0, 'executable');
    }
    // detection: AIB's own copy wins over a maki on PATH
    const onPath = join(dir.root, 'bin');
    touch(join(onPath, WIN ? 'maki.exe' : 'maki'), '');
    const row = await resolveBeta('maki', {
      stateDir: dir.root,
      env: envWith(onPath),
      findNode: () => '',
    });
    assertEquals([row.source, row.argv, row.found], [
      'studio',
      [program, 'acp'],
      true,
    ]);
    assertEquals(
      signinArgv(row, 'maki'),
      [program, 'auth', 'login'],
      'Sign in runs `maki auth login` in the card terminal',
    );
    // Install again: already there
    assertEquals((await installer.start('maki')).state, 'done');
    // Uninstall removes AIB's copy only
    const gone = await installer.uninstall('maki');
    assertEquals(gone.removed, ['0.7.2']);
    assertEquals(findReleaseInstall(maki, dir.root), null);
    assert(
      Deno.statSync(join(onPath, WIN ? 'maki.exe' : 'maki')).isFile,
      'the PATH copy is not touched',
    );
  },
);

Deno.test(
  'Install: a download that does not match the pinned SHA-256 is never used, and its folder is removed',
  sanitize,
  async () => {
    using dir = tempDir();
    const archive = await archiveFor();
    const agent = await fakeMaki(PLATFORM, FILE, archive);
    const tampered = archive.slice();
    tampered[tampered.length - 30] ^= 0xff;
    using _ = withCatalog(agent);
    const installer = new Installer(dir.root, {
      fetch: fakeFetch(tampered),
      platform: PLATFORM,
      diskFree: () => 1e12,
    });
    await installer.start('maki');
    const view = await finish(installer);
    assertEquals(view.state, 'failed');
    assert(/did not match the checksum/.test(view.message), view.message);
    assert(
      !isDir(join(dir.root, 'agents', 'maki', '0.7.2')),
      'nothing is left to run',
    );
    const row = await resolveBeta('maki', {
      stateDir: dir.root,
      env: envWith(),
      findNode: () => '',
    });
    assertEquals(row.found, false);
  },
);

Deno.test(
  'Install: refused before anything starts on a computer Maki publishes no build for; needs no Node.js',
  sanitize,
  async () => {
    using dir = tempDir();
    const installer = new Installer(dir.root, {
      fetch: fakeFetch(new Uint8Array(1)),
      platform: 'freebsd-x86_64',
      nodeProbe: () => '',
    });
    const error = await assertRejects(
      () => installer.start('maki'),
      InstallRefused,
    );
    assert(
      /publishes no build for this computer \(freebsd-x86_64\)/.test(
        error.message,
      ),
      error.message,
    );
    // a supported computer installs without Node.js (the npm path would refuse: nodeProbe says it does not start)
    const archive = await archiveFor();
    using _ = withCatalog(await fakeMaki(PLATFORM, FILE, archive));
    const ok = new Installer(dir.root, {
      fetch: fakeFetch(archive),
      platform: PLATFORM,
      nodeProbe: () => '',
      diskFree: () => 1e12,
    });
    await ok.start('maki');
    assertEquals((await finish(ok)).state, 'done');
  },
);

Deno.test(
  'Install: Cancel stops the download and leaves no folder',
  sanitize,
  async () => {
    using dir = tempDir();
    const archive = await archiveFor();
    using _ = withCatalog(await fakeMaki(PLATFORM, FILE, archive));
    // a body that sends half, then waits until the fetch is aborted
    const slow = ((_url: string, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(archive.slice(0, archive.length >> 1));
          init?.signal?.addEventListener(
            'abort',
            () => c.error(new DOMException('aborted', 'AbortError')),
          );
        },
      });
      return Promise.resolve(new Response(stream));
    }) as typeof fetch;
    const installer = new Installer(dir.root, {
      fetch: slow,
      platform: PLATFORM,
      diskFree: () => 1e12,
    });
    await installer.start('maki');
    await new Promise((r) => setTimeout(r, 200));
    const after = await installer.cancel('maki');
    assertEquals(after.state, 'idle');
    assert(!isDir(join(dir.root, 'agents', 'maki', '0.7.2')));
  },
);

// ---- detection --------------------------------------------------------------------------------------------------------------

Deno.test("detection: a maki on PATH, else install.ps1's %LOCALAPPDATA%\\maki\\maki.exe (Windows)", async () => {
  using dir = tempDir();
  const bin = join(dir.root, 'bin');
  const program = touch(join(bin, WIN ? 'maki.exe' : 'maki'), '');
  if (!WIN) Deno.chmodSync(program, 0o755);
  let row = await resolveBeta('maki', {
    env: envWith(bin),
    findNode: () => '',
  });
  assertEquals([row.source, row.argv], ['path', [program, 'acp']]);
  if (WIN) {
    const local = join(dir.root, 'local');
    const known = touch(join(local, 'maki', 'maki.exe'), '');
    row = await resolveBeta('maki', {
      env: { ...envWith(), LOCALAPPDATA: local },
      findNode: () => '',
    });
    assertEquals([row.source, row.argv], ['path', [known, 'acp']]);
  }
  row = await resolveBeta('maki', {
    env: envWith(join(dir.root, 'empty')),
    findNode: () => '',
  });
  assertEquals([row.found, row.problem], [
    false,
    `Not installed. Install it with: ${maki.install}`,
  ]);
});

Deno.test(
  'sign-in check: Maki stopping before it answers (no provider set up) reads as Needs sign-in',
  sanitize,
  async () => {
    using dir = tempDir();
    // a program that exits at once, like `maki acp` with no API key and no saved sign-in
    const quits = {
      argv: [PY, '-c', 'pass'],
      base: [PY],
      found: true,
      source: 'path',
      path: PY,
      problem: '',
      text: PY,
      shim: false,
    };
    const signer = new BetaSigner(dir.root, () => quits, () => ({}), {
      checkTimeout: 20,
    });
    assertEquals(await signer.probe('maki', quits.argv), 'signin');
    assertEquals(
      await signer.probe('kilo', quits.argv),
      'unknown',
      'other agents: a crash is not a sign-in answer',
    );
  },
);

function isDir(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

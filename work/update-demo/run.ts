/**
 * A local AIB that shows its own Update button. No GitHub, nothing installed, and nothing of the real AIB install or data folder
 * is touched: the app runs from the build's own folder under `dist/update-demo`, with its own data folder and its own
 * APPDATA/LOCALAPPDATA, and the "newer version" is a build made here, put in a local test feed.
 *
 * What happens (all of it is existing code, no patch to the app):
 *   1. `tools/build.ts --version <base>.test.2 --feed <feed>` builds AIB and writes one feed version: the zip, its SHA256SUMS,
 *      release.json and notes.md (server/desktop/updater.ts reads exactly that folder).
 *   2. The same build runs here, but the updater takes it to be `<base>.test.1` (`AIB_UPDATE_CURRENT`, honoured only together
 *      with `AIB_TEST_FEED_DIR` — updater.ts:1094), so the feed's `.test.2` is newer and offered.
 *   3. The updater downloads the feed's zip, checks it against the feed's SHA256SUMS, and says `ready`; the page then shows the
 *      teal Update button at the right end of the tab strip, with that build's own notes in "What's new".
 *
 * Usage (from the repo root):
 *   deno run -A work/update-demo/run.ts              build + feed + run headless; prints the page link to open in a browser
 *   deno run -A work/update-demo/run.ts --window     the same, but the built app opens its own window
 *   deno run -A work/update-demo/run.ts --check      the app is already running: only ask it for the feed now and report
 *   --rebuild                                        build again even when the feed version is already there
 * Windows only: the feed needs the windows-x64 asset.
 */
import { APP_VERSION } from '../../app/server/core/app.ts';

const REPO = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/[\\/]$/, '');
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const OUT = `${REPO}${SEP}dist${SEP}update-demo`;
const FEED = `${OUT}${SEP}feed`;
const APP_DIR = `${OUT}${SEP}.build${SEP}windows-x64${SEP}AIB`;
const BASE = APP_VERSION.replace(/\.test\..*$/, ''); // a test build of the source's own version
const NEW = `${BASE}.test.2`; // what the feed offers
const RUNS_AS = `${BASE}.test.1`; // what the running app takes itself to be
const ASSET = `AIB-${NEW}-windows-x64.zip`;
const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};
const has = (p: string) => {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
};
const usage = `Usage: deno run -A work/update-demo/run.ts [--window] [--rebuild]
       deno run -A work/update-demo/run.ts --check

  --window    Open the demo in its own window.
  --rebuild   Rebuild the app and its local update feed.
  --check     Query the already running demo.
  -h, --help  Show this help.`;
const args = new Set(Deno.args);
const unknown = [...args].find((arg) => !['--window', '--rebuild', '--check', '-h', '--help'].includes(arg));
if (unknown || (args.has('--check') && (args.has('--window') || args.has('--rebuild')))) {
  console.error(`${unknown ? `Unknown option: ${unknown}` : '--check cannot be combined with --window or --rebuild.'}\n${usage}`);
  Deno.exit(2);
}
if (args.has('-h') || args.has('--help')) {
  console.log(usage);
  Deno.exit(0);
}
const flag = (name: string) => args.has(`--${name}`);

if (Deno.build.os !== 'windows') throw Error('the local test feed builds a windows-x64 asset: run this on Windows');

/** The build and the feed folder, unless they are already there. */
async function ensureBuild(): Promise<void> {
  if (has(`${FEED}${SEP}${NEW}`) && !flag('rebuild')) return console.log(`feed: ${FEED}${SEP}${NEW} (already there; --rebuild for a new one)`);
  console.log(`build: AIB ${NEW} (windows-x64, no WSL pair) -> ${OUT}, feed ${FEED}`);
  const b = new Deno.Command('deno', {
    args: [
      'run',
      '-A',
      'tools/build.ts',
      '--targets',
      'windows-x64',
      '--no-wsl',
      '--no-smoke',
      '--version',
      NEW,
      '--out',
      OUT,
      '--feed',
      FEED,
      '--keep',
    ],
    cwd: REPO,
    stdout: 'inherit',
    stderr: 'inherit',
  }).outputSync();
  if (!b.success) throw Error(`tools/build.ts failed (exit ${b.code})`);
}

/** The app the build made: `<out>/.build/windows-x64/AIB/AIB.exe` (+ its keeper), the folder that goes into the zip. */
function ensureApp(): string {
  const exe = `${APP_DIR}${SEP}AIB.exe`;
  if (!has(exe)) throw Error(`${exe} is missing: run with --rebuild (the build keeps it with --keep)`);
  return exe;
}

/** The app's environment: its own folders, its own feed, its own version. */
function appEnv(key: string): Record<string, string> {
  const home = `${OUT}${SEP}home`;
  for (const d of ['AppData/Roaming', 'AppData/Local']) Deno.mkdirSync(`${home}${SEP}${d.replaceAll('/', SEP)}`, { recursive: true });
  return {
    USERPROFILE: home,
    HOME: home,
    APPDATA: `${home}${SEP}AppData${SEP}Roaming`,
    LOCALAPPDATA: `${home}${SEP}AppData${SEP}Local`,
    AGENT_STUDIO_STATE_DIR: `${OUT}${SEP}data`,
    AGENT_STUDIO_LOG_LEVEL: 'INFO',
    AIB_TEST_FEED_DIR: FEED,
    AIB_UPDATE_CURRENT: RUNS_AS,
    AIB_PAGE_KEY: key,
  };
}

/** Asks this AIB for its feed now (what focusing the window does) and prints what the updater answered. */
async function feedReport(port: number, key: string, ask: boolean): Promise<void> {
  const boot = await (await fetch(`http://127.0.0.1:${port}/api/live/bootstrap`, { headers: { 'X-AIB-Page-Key': key } })).json();
  const token = boot.token as string;
  if (!token) throw Error(`bootstrap gave no token: ${JSON.stringify(boot).slice(0, 200)}`);
  if (ask)
    await fetch(`http://127.0.0.1:${port}/api/live/update/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, 'X-Studio-Token': token },
      body: JSON.stringify({ feed: true }),
    });
  let st: Record<string, unknown> = {};
  for (let i = 0; i < 120; i++) {
    st = await (await fetch(`http://127.0.0.1:${port}/api/live/update`, { headers: { 'X-Studio-Token': token } })).json();
    if (!st.checking && st.state !== 'idle' && st.state !== 'checking') break;
    await sleep(500);
  }
  const available = (st.available || {}) as Record<string, unknown>;
  console.log(`\nstate ${st.state}; running AIB ${st.current}; feed says ${available.version || '-'}; desktop ${st.desktop}, update source configured ${st.configured}`);
  if (available.name) console.log(`file ${available.name}${available.path ? ` at ${available.path}` : ''}`);
  if (st.instructions) console.log(`note: ${st.instructions}`);
  if (st.state !== 'ready') console.log('not ready: no Update button yet — look at the app log');
  else console.log(`\nThe Update button is up: teal, at the right end of the tab strip, its tooltip names AIB ${available.version}.`);
}

if (flag('check')) {
  const info = JSON.parse(await Deno.readTextFile(`${OUT}${SEP}run.json`)) as { port: number; key: string };
  await feedReport(info.port, info.key, true);
} else {
  await ensureBuild();
  const exe = await ensureApp();
  const key = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  const logFile = `${OUT}${SEP}app.log`;
  const log = await Deno.open(logFile, { create: true, append: true });
  console.log(`run: ${exe} as AIB ${RUNS_AS}, feed ${FEED} (holds ${NEW})`);
  const child = new Deno.Command(exe, {
    args: flag('window') ? ['--port', '0'] : ['serve', '--in-process', '--port', '0'],
    cwd: APP_DIR,
    env: appEnv(key),
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  const writeLog = child.stderr.pipeTo(log.writable).catch((error) => console.error(`Writing ${logFile}:`, error));
  // The app names the port it listens on ("AIB: http://127.0.0.1:N") on stdout; take it from there, echo the rest.
  let port = 0,
    seen = '';
  const drain = (async () => {
    for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
      if (port) console.log(chunk.trimEnd());
      else port ||= Number((seen += chunk).match(/AIB: http:\/\/127\.0\.0\.1:(\d+)/)?.[1] ?? 0);
    }
  })();
  for (let i = 0; i < 120 && !port; i++) await sleep(250);
  if (!port) {
    throw Error('the app never said which port it listens on: see ' + logFile);
  }
  await Deno.writeTextFile(`${OUT}${SEP}run.json`, JSON.stringify({ port, key }));
  await feedReport(port, key, true);
  console.log(`\nPage: http://127.0.0.1:${port}/#aib-key=${key}\nOpen that link and click Update, or click it in the app window. Ctrl+C here stops this AIB.`);
  await child.status;
  await Promise.all([drain, writeLog]);
}

/**
 * AIB's Deno entry point: the web server (studio.py's main) and the agent host (agent_host.py). Same flags as the Python programs.
 *
 *   deno run -A server/main.ts [serve] [--port N] [--state-dir D] ...      the web server, attached to (or starting) the agent host
 *   deno run -A server/main.ts [serve] --in-process ...                     the web server with the agents inside it (tests, debugging)
 *   deno run -A server/main.ts --stop-host [--force]                       ask the agent host to stop
 *   deno run -A server/main.ts host [--state-dir D] ...                    the agent host itself (normally started by the web server)
 *   deno run -A server/main.ts mcp-artifact                                the studio_artifact stdio MCP server agents run (artifact_mcp.py)
 *   deno run -A server/main.ts deploy [--port N] [--host] [--wait] ...     restart a running server without cutting off a turn (deploy.py)
 *   AIB [--port N] ...                    in a `deno desktop` build with no subcommand: the web server plus the native window, tray
 *                                         and single-instance lock (desktop/window.ts). `AIB serve` and every subcommand open no window.
 *
 * The web server starts the Deno agent host (`main.ts host`, or `<binary> host` for a compiled build). A Python agent host (the
 * old app) already running for the state folder is recognised and taken over once no chat works there (host_client.ts findHost);
 * this program never starts one.
 */
import { APP_ROOT, APP_VERSION, isCompiled, isDesktopApp, launchDir, selfCommand } from './core/app.ts';
import * as log from './core/log.ts';
import { Options, parseOptions, UsageError } from './core/options.ts';
import { apply as applyStatePaths } from './state/paths.ts';
import './state/migrate.ts'; // registers the data move with paths.ts
import { leaveSplitHost, pidAlive, readInfo, SOURCE_COMMAND, stopHost } from './host/host_client.ts';
import { decideKeeper, KeeperLink } from './keeper/link.ts';
import { keeperRunning, PROTOCOL as KEEPER_PROTOCOL } from './keeper/client.ts';
import { attachHost } from './host/host_proxy.ts';
import type { LiveBackend } from './host/backend.ts';
import { orphanCommand, Studio } from './host/studio.ts';
import { hostMain, loadMcp, studioOptions } from './host/agent_host.ts';
import { UpdateService } from './desktop/updater.ts';
import { makeContext, WebServer } from './web/server.ts';
import { openSource } from './transcripts/monitor.ts';
import { ensureHiddenConsole } from './platform/console.ts';
import { configure as configureArtifactKeys } from './artifacts/keys.ts';
import * as worktrees from './worktrees/worktrees.ts';
import { mergesRunning } from './worktrees/merge.ts';
import { choosePortPair, DesktopApp, lastPortPair, portFree, portGiven, saveLastPort } from './desktop/window.ts';
import { startedMarker } from './desktop/updater.ts';
import { guardDataFolder, nativeNotice, watchSignal } from './desktop/single_instance.ts';
import { ensureStartMenuShortcut } from './desktop/shortcut.ts';
import { trayIconPng } from './desktop/tray_icon.ts';
import { servePort, startBlank, startRedirect } from './desktop/serve_address.ts';

const sep = Deno.build.os === 'windows' ? '\\' : '/';

/** Subcommands of a desktop binary that never show a window. */
const NO_WINDOW = new Set(['host', 'mcp-artifact', 'deploy', 'update-helper', 'serve']);

export { selfCommand };

/** remote_studio.host_command: the command line that starts an agent host configured like this web server. */
export function hostCommand(o: Options, compiled = isCompiled(), env: Record<string, string | undefined> = envObject()): string[] {
  // Linux AppImage: `$APPIMAGE host`, its own mount. Deno.execPath() is inside the app's FUSE mount, which goes away when the app
  // exits: a host left running "to finish the chats" would lose its program (docs/agent-host.md, "Lifecycle").
  const self = compiled && Deno.build.os === 'linux' && env.APPIMAGE ? [env.APPIMAGE] : selfCommand();
  const command = [
    ...self,
    'host',
    '--state-dir',
    String(o.stateDir),
    '--omp-sessions',
    o.ompSessions,
    '--claude-projects',
    o.claudeProjects,
    '--omp-command',
    o.ompCommand,
    '--node-command',
    o.nodeCommand,
    '--claude-launcher',
    o.claudeLauncher,
    '--codex-launcher',
    o.codexLauncher,
  ];
  if (!o.autoReconnect) command.push('--no-auto-reconnect');
  command.push(...(o.ownersDir ? ['--owners-dir', o.ownersDir] : ['--no-owner-announcements']));
  if (o.noArtifactTool) command.push('--no-artifact-tool');
  if (o.enableClientTerminal) command.push('--enable-client-terminal');
  if (o.enableClientFs) command.push('--enable-client-fs', o.enableClientFs);
  if (o.mcpConfig) command.push('--mcp-config', o.mcpConfig);
  command.push('--host-port', String(o.hostPort), '--idle-exit-minutes', String(o.hostIdleMinutes));
  // The built app's host (window or serve): its own tray icon while chats run with no app, and a short exit once nothing works and
  // no app is attached, so it never lingers invisibly (docs/agent-host.md, "Lifecycle"). A source run keeps the idle timer only.
  if (compiled) command.push('--tray', '--exit-unattached-seconds', String(APP_HOST_EXIT_SECONDS));
  return command;
}

/** <data>/updates/started-<APP_VERSION>.ok: tells a waiting update helper this version is up (built app only). Never throws. */
function writeStartedMarker(stateDir: string): void {
  if (!isCompiled()) return;
  try {
    Deno.mkdirSync(`${stateDir}${sep}updates`, { recursive: true });
    Deno.writeTextFileSync(startedMarker(`${stateDir}${sep}updates`, APP_VERSION), String(Date.now()));
    log.announce('studio', 'started: wrote the start confirmation for AIB %s', APP_VERSION);
  } catch { /* no update waits on it, or the folder is unwritable */ }
}

function envObject(): Record<string, string | undefined> {
  try {
    return Deno.env.toObject();
  } catch {
    return {};
  }
}

/** An agent host process runs for this folder (its host file names a live pid). */
function hostRunning(info: Record<string, unknown> | null): boolean {
  return !!info && typeof info.pid === 'number' && pidAlive(info.pid);
}

/** How long the built app's host stays after the last app left with no chat working. */
export const APP_HOST_EXIT_SECONDS = 10;

function usage(message: string): never {
  console.error(`usage: aib [serve] [options]\naib: error: ${message}`);
  Deno.exit(2);
}

export async function main(argv: string[]): Promise<void> {
  // A `deno desktop` runtime sets DENO_SERVE_ADDRESS, which makes Deno.serve ignore the port it is given (spike 2026-11-10). AIB
  // binds its own ports in every mode (the page and the artifact origin on port + 1, the agent host's port), so drop it first. Its
  // port is kept: in window mode it redirects to our page (desktop/serve_address.ts). In a desktop binary the listeners are not
  // Deno.serve (platform/http_serve.ts), and every mode without the app window keeps the runtime's startup window hidden.
  let runtimePort: number | null = null;
  try {
    runtimePort = servePort(Deno.env.get('DENO_SERVE_ADDRESS'));
    Deno.env.delete('DENO_SERVE_ADDRESS');
  } catch { /* no env access */ }
  // A tray-only start (--start-in-tray, the keeper's orphan restart) takes the startup window too: nothing may show until Open AIB.
  if (isDesktopApp() && (NO_WINDOW.has(argv[0]) || argv.includes('--stop-host') || argv.includes('--start-in-tray'))) {
    (await import('./desktop/native.ts')).tameStartupWindow();
    // The runtime's wait for its server ends at once, and its window loads an empty page. Not for a tray-only start: that one is the
    // desktop app, and its own redirect on this port (below, once the page listens) sends a window the runtime opens to AIB.
    if (runtimePort && !argv.includes('--start-in-tray')) startBlank(runtimePort);
  }
  if (argv[0] === 'host') Deno.exit(await hostMain(argv.slice(1)));
  if (argv[0] === 'mcp-artifact') Deno.exit(await (await import('./artifacts/mcp.ts')).main());
  if (argv[0] === 'deploy') Deno.exit(await (await import('./host/deploy.ts')).main(argv.slice(1)));
  if (argv[0] === 'update-helper') Deno.exit(await (await import('./desktop/update_helper.ts')).main(argv.slice(1)));
  ensureHiddenConsole();
  const args = argv[0] === 'serve' ? argv.slice(1) : argv;
  const desktop = isDesktopApp() && argv[0] !== 'serve'; // the window only for a plain `AIB [options]` launch
  // After an update: delete the previous version's *.old-<stamp> files once nothing runs from them (never throws; desktop app only).
  // (`serve` of the built app too: an update keeps the arguments, so a served app updates the same way.)
  // Again a few times after: the update helper runs from the old files until this version has confirmed its start.
  if (isDesktopApp() && !argv.includes('--stop-host')) (await import('./desktop/update_helper.ts')).removeUpdateLeftoversSoon();
  let options: Options;
  try {
    options = parseOptions(args);
  } catch (error) {
    if (error instanceof UsageError) usage(error.message);
    throw error;
  }
  const mcpServers = loadMcp(options, usage); // studio.finish_agent_options: an invalid --mcp-config is a usage error
  await applyStatePaths(options as never, usage, APP_ROOT, !options.stopHost);
  const stateDir = String(options.stateDir);
  // One AIB per data folder, whatever the mode: a second desktop launch shows the running app's window and exits; anything else
  // that finds the folder taken says so and exits with code 2 (desktop/single_instance.ts). Before the log, the host or any state.
  const folderLock = options.stopHost ? null : await guardDataFolder(stateDir, {
    mode: desktop ? 'desktop' : 'server',
    port: desktop ? null : options.port,
    quiet: options.startInTray,
    notice: async (message) => {
      (await import('./desktop/native.ts')).tameStartupWindow();
      await nativeNotice(message);
    },
  });
  // The desktop app logs at INFO unless a level was asked for (window navigations, the keeper, the redirect: evidence for bugs).
  const levelGiven = args.some((a) => a.startsWith('--log-level')) || !!Deno.env.get(log.ENV_LEVEL);
  log.setup('studio', { level: desktop && !levelGiven ? 'INFO' : options.logLevel, stateDir, filename: 'studio.log' });
  if (!Deno.env.get(log.ENV_LEVEL)) Deno.env.set(log.ENV_LEVEL, String(options.logLevel)); // a host this server starts logs alike
  if (options.stopHost) {
    const result = await stopHost(stateDir, options.force, 20, `AIB --stop-host${options.force ? ' --force' : ''} (pid ${Deno.pid})`);
    console.log(result.message);
    for (const item of (result.active ?? []) as Record<string, unknown>[]) console.log(`  ${item.provider} in ${item.cwd}: ${item.state}`);
    Deno.exit(result.stopped || !result.running ? 0 : 2);
  }
  if (desktop && isDesktopApp()) {
    // An update cut off in the middle of its file swap: put the previous version back and start that (it is whole again).
    const { recoverInterruptedUpdate } = await import('./desktop/update_helper.ts');
    if (recoverInterruptedUpdate(`${stateDir}${sep}updates`)) {
      log.announce('studio', 'an interrupted update was undone; starting AIB again');
      folderLock?.release();
      const { spawnDetached } = await import('./platform/spawn_detached.ts');
      (await spawnDetached([Deno.execPath(), ...Deno.args], `${stateDir}${sep}updates${sep}restart.log`, launchDir())).close();
      Deno.exit(0);
    }
  }
  if (desktop) {
    // The same port as last time when it is free, so the page's origin (and its localStorage drafts) stays the same across restarts
    // and updates; else the first free pair from 8777, like the Tauri app.
    if (!portGiven(args)) options.port = lastPortPair(stateDir, portFree) ?? choosePortPair(portFree);
  }
  let studio: Studio | null = null;
  let host: LiveBackend;
  let webInstanceId: string;
  // One process with the keeper (owner decisions D3 and "the keeper is always on", docs/agent-host.md "The keeper"): the agents run
  // in the keeper and outlive this process, so the separate agent host has no job left. When the keeper cannot run (program missing,
  // no Go in a source run, it does not start) decideKeeper logs why and AIB falls back to the split agent host (or, --in-process,
  // agents as children of this process); Settings > About shows the reason. AIB_KEEPER=0 (tests, debugging) turns it off.
  // A split host that still runs for the folder (an older version such as beta.3) is stopped when idle, else drained.
  const keeperOn = await decideKeeper(stateDir);
  let merged = !options.inProcess && keeperOn && !hostRunning(await readInfo(stateDir));
  if (!options.inProcess && keeperOn && !merged) {
    merged = await leaveSplitHost(stateDir, (line) => {
      console.log(line);
      log.announce('studio', '%s', line);
    });
  }
  if (options.inProcess || merged) {
    // Agents run inside this process (studio.py --in-process): restarting it ends every conversation, unless they run in the keeper.
    // The one-process app keeps the agent host's recovery and queue files (studio-*-host.json), so switching modes keeps the list.
    studio = new Studio(studioOptions(options, mcpServers), merged ? { port: 'host' } : {});
    host = studio;
    webInstanceId = studio.instanceId;
    void studio.adoptKeeper(); // chats whose agents still run in the keeper: taken over now, while the server starts (state waits)
    if (merged) log.announce('studio', 'one process: agents run in the keeper, no separate agent host');
  } else {
    webInstanceId = crypto.randomUUID().replaceAll('-', '');
    host = await attachHost({
      stateDir,
      // While it drains an older split host with the keeper usable, the host of this version (after the drain) uses the keeper too.
      command: keeperOn ? [...hostCommand(options), '--keeper'] : hostCommand(options),
      port: options.port,
      webInstanceId,
      runtime: 'deno',
      // The built app: tell the host how to start this app again (its tray's Open AIB), and retire a host left by the previous
      // version (after an update) as soon as none of its chats is working.
      launch: isCompiled() ? [Deno.execPath(), ...Deno.args] : null,
      version: APP_VERSION,
      retireOlderHost: true, // drain then hand over: a same-product host running other code (an update, a code change)
      onRetired: isDesktopApp() ? () => void import('./desktop/update_helper.ts').then((m) => m.removeUpdateLeftovers()) : undefined,
      say: (m) => {
        console.log(m);
        log.announce('studio', '%s', m);
      },
    });
  }
  configureArtifactKeys(stateDir); // artifact tool: the same shared secret as the agent host
  // The chats' terminal shells run in the keeper too (keeper 1.2.0+), so they outlive a restart, crash or update of AIB. With the
  // keeper off but one still running for the folder, its shells are taken over and new ones start inside AIB.
  const terminalKeeper = keeperOn || keeperRunning(stateDir)
    ? new KeeperLink({ dataDir: stateDir, ...(studio ? { orphan: orphanCommand() } : {}) })
    : null;
  let closing = false;
  let desktopApp: DesktopApp | null = null; // the window and tray (desktop app only), made once the server listens
  let close = async (_why?: string, _release?: boolean) => {};
  const ctx = makeContext({
    stateDir,
    host,
    updates: null as unknown as UpdateService,
    webInstanceId,
    cliPort: options.port,
    transcripts: await openSource(options.ompSessions, options.claudeProjects),
    claudeProjects: options.claudeProjects,
    ompSessions: options.ompSessions,
    shutdown: () => void close('shutdown requested'),
    agentOptions: options as never,
    terminalKeeper,
    stores: studio
      ? { conversations: studio.conversations, projectPrefs: studio.projectPrefs, readState: studio.readState, settings: studio.settings }
      : undefined,
  });
  // A known project folder inside a repo wins for chats in any worktree; saved worktree chats map back to their project.
  worktrees.known.projects = () => [...ctx.projectPrefs.projects.keys()].filter((k) => k.startsWith('w:')).map((k) => k.slice(2));
  const resolver = new worktrees.ProjectResolver(stateDir);
  const resolve = (cwd: string) => resolver.resolve(cwd);
  if ('setProjectResolver' in ctx.transcripts) ctx.transcripts.setProjectResolver(resolve);
  else ctx.transcripts.projectResolver = resolve;
  // updater.UpdateService as studio.create_server builds it: the Settings toggle, the chats being worked on, and a quit that runs
  // the normal close path after the install route has answered.
  ctx.updates = new UpdateService(stateDir, {
    autoCheck: () => ctx.settings.autoUpdateCheck(),
    busyChats: async () => (await host.busyConnections()).length,
    quit: (release) => void setTimeout(() => void close('installing an update', release), 50),
    chatsKeepRunning: !studio, // the agent host outlives this app: an update never stops a working chat
    // Quit while chats worked (AIB only stays in the tray): "Install when chats finish" waits for the next launch, so an update
    // never opens a window after the person quit.
    holdInstall: () => desktopApp?.background ?? false,
    // One process with the keeper: Install now leaves the chats in the keeper and the new version takes them over.
    keeper: studio?.keeper
      ? async () => {
        const client = await studio!.keeper!.client(false);
        if (!client) return null; // no keeper runs, so no chat runs in one
        return {
          reason: studio!.keeperHandover(),
          protocol: KEEPER_PROTOCOL,
          features: client.features,
          version: client.keeperVersion,
          dataDir: stateDir,
        };
      }
      : null,
  });
  log.registerSecret(ctx.token);
  if (terminalKeeper && !keeperOn) ctx.terminals.keeperProblem = 'the keeper is off';
  await ctx.terminals.adoptKeeper(); // shells an earlier AIB left in the keeper: taken over before the page can ask for them
  const server = new WebServer(ctx);
  const port = await server.listen(options.port);
  const url = `http://127.0.0.1:${port}`;
  await folderLock?.setPort(port);
  if (desktop) saveLastPort(stateDir, port);
  log.announce('studio', 'AIB %s on %s (pid %s, %s, data %s)', APP_VERSION, url, Deno.pid, desktop ? 'desktop app' : 'server', stateDir);
  if (desktop && runtimePort && runtimePort !== port) startRedirect(runtimePort, `${url}/`);
  server.gate.artifactPorts.add(ctx.artifacts.start(port)); // the artifact origin is same-site, never the page
  ctx.updates.start(); // the daily update check and the wait-for-idle install (studio.main: server.updates.start())
  if (studio) {
    await studio.adoptKeeper(); // the take-over started above: chats whose agents still run in the keeper go on where they are
    studio.startAutoReconnect();
  }
  try { // artifact tool: agents re-read this when Studio restarts on another port (json.dumps spacing, like studio.py)
    await Deno.writeTextFile(`${stateDir}${sep}artifact-web.json`, `{"url": ${JSON.stringify(url)}, "pid": ${Deno.pid}}`);
  } catch { /* as Python: not fatal */ }
  if (studio) {
    console.log(`AIB: ${url}\nIn-process mode: keep this process running while agents work. Ctrl+C stops owned ACP connections.`);
  } else {
    console.log(
      `AIB: ${url}\nAgents run in the separate agent host, so this server can be restarted without stopping them (${isCompiled() ? 'AIB' : SOURCE_COMMAND} --stop-host ends the host).`,
    );
  }
  close = async (why = 'quit', release = false) => {
    if (closing) return;
    closing = true;
    log.announce('studio', 'closing (%s)%s', why, release && studio ? '; leaving the chats in the keeper' : '');
    ctx.updates.stop();
    await ctx.artifacts.stop().catch(() => {});
    await server.close(release).catch(() => {}); // release (an update): terminal shells in the keeper keep running
    // split: detach only; in-process: stops every agent; release (an update with the keeper): the chats stay in the keeper.
    if (release && studio) await studio.release().catch(() => {});
    else await host.close().catch(() => {});
    folderLock?.release();
    Deno.exit(0);
  };
  for (const signal of (Deno.build.os === 'windows' ? ['SIGINT', 'SIGBREAK'] : ['SIGINT', 'SIGTERM']) as Deno.Signal[]) {
    try {
      // The desktop app ended by a signal (a kill, a session ending on macOS/Linux) is not "Stop all chats": working chats stay in the
      // keeper, which starts AIB again in the tray (rule V1), as after a crash. A source run or `serve` stops them as before (Ctrl+C).
      Deno.addSignalListener(signal, () => {
        const keep = desktop && !!studio?.keeper && studio.workingList().length > 0;
        void close(`signal ${signal}`, keep);
      });
    } catch { /* not supported here */ }
  }
  if (desktop) {
    const { nativeShell } = await import('./desktop/native.ts');
    const app = desktopApp = new DesktopApp(nativeShell(), {
      url: `${url}/`,
      stateDir,
      trayIcon: trayIconPng(),
      busyCount: async () => (await host.busyConnections()).length,
      // Closing the window or Quit AIB never stops a chat: with something working AIB stays in the tray and quits by itself once
      // nothing works (window.ts decide). Split (an older version's host, being drained): the app quits at once and the host is
      // asked to stop unforced (an idle host goes, a busy one keeps its chats under its own icon); Stop all chats and quit forces it.
      stopHost: studio ? undefined : async (force) => {
        const result = await stopHost(stateDir, force, 5, `the app quitting (pid ${Deno.pid}${force ? ', OK: stop them' : ''})`);
        log.announce('studio', 'quit: agent host %s', result.stopped ? 'stopped' : `kept (${result.message})`);
        return result;
      },
      quit: () => close('the app was quit'),
      onPageLoaded: () => writeStartedMarker(stateDir), // the update helper waits for it
      // The keeper's orphan restart (rule V1) starts AIB with --start-in-tray: no window over the person's work, only the tray.
      startInTray: options.startInTray,
      terminalsBusy: () => ctx.terminals.busyCount(), // AIB does not quit under a command running in a terminal
      mergesRunning, // nor in the middle of a merge
      trayCounts: studio
        ? () => {
          const working = studio!.workingList();
          return Promise.resolve({ working: working.length, needsYou: working.filter((w) => w.state === 'needs_you').length });
        }
        : undefined,
    });
    ctx.desktopNotify = app.notifications; // POST /api/live/desktop/notify: the page's notifications, shown by this process
    await app.start(); // the window navigates now: the server already listens
    await watchSignal(stateDir, () => void app.showWindow());
    void ensureStartMenuShortcut(Deno.execPath());
    return;
  }
  writeStartedMarker(stateDir); // `serve`: up once it listens
  if (options.open) {
    const opener = Deno.build.os === 'windows'
      ? ['cmd', '/c', 'start', '', url]
      : Deno.build.os === 'darwin'
      ? ['open', url]
      : ['xdg-open', url];
    new Deno.Command(opener[0], { args: opener.slice(1), stdout: 'null', stderr: 'null' }).spawn();
  }
}

if (import.meta.main) await main(Deno.args);

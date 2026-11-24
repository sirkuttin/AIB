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
import { retireAtStart } from './web/cleanup_routes.ts';
import { APP_ROOT, APP_VERSION, isCompiled, isDesktopApp, launchDir, selfCommand } from './core/app.ts';
import * as log from './core/log.ts';
import { Options, parseOptions, UsageError } from './core/options.ts';
import { apply as applyStatePaths } from './state/paths.ts';
import { leaveSplitHost, pidAlive, readInfo, SOURCE_COMMAND, stopHost } from './host/host_client.ts';
import { decideKeeper, KeeperLink } from './keeper/link.ts';
import { keeperBinary, keeperRunning, PROTOCOL as KEEPER_PROTOCOL } from './keeper/client.ts';
import { attachHost, HostProxy } from './host/host_proxy.ts';
import type { LiveBackend } from './host/backend.ts';
import { holdKeeper, orphanCommand, Aib } from './host/aib.ts';
import { hostMain, loadMcp, studioOptions } from './host/agent_host.ts';
import { UpdateService } from './desktop/updater.ts';
import { notifyUpdateReady } from './desktop/notify.ts';
import { makeContext, WebServer } from './web/server.ts';
import { openSource } from './transcripts/monitor.ts';
import { ensureHiddenConsole } from './platform/console.ts';
import { installCrashTrail } from './core/crash_trail.ts';
import { processStartTime } from './platform/process_info.ts';
import { configure as configureArtifactKeys } from './artifacts/keys.ts';
import * as worktrees from './worktrees/worktrees.ts';
import { mergesRunning } from './worktrees/merge.ts';
import { wslMergesRunning } from './wsl/merge.ts';
import { startLocalBackups } from './worktrees/local_backup.ts';
import { startWslLocalBackups } from './wsl/local_only.ts';
import { choosePortPair, DesktopApp, lastPortPair, portFree, portGiven, saveLastPort } from './desktop/window.ts';
import { startedMarker } from './desktop/updater.ts';
import { guardDataFolder, nativeNotice, watchSignal } from './desktop/single_instance.ts';
import { presence as folderPresence } from './desktop/folder_presence.ts';
import { ensureStartMenuShortcut } from './desktop/shortcut.ts';
import { trayIconBytes, trayIconPng } from './desktop/tray_icon.ts';
import { startWindowsToasts } from './desktop/toast_act.ts';
import { startLinuxToasts } from './desktop/toast_linux.ts';
import { userNotificationState } from './desktop/tray_win.ts';
import { servePort, startBlank, startRedirect } from './desktop/serve_address.ts';
import { startAttention } from './attention/watcher.ts';
import { INBOX } from './attention/inbox_rules.ts';
import { swarmOf } from './web/aib_routes.ts';
import { takeLaunchKeyFromEnv } from './web/page_access.ts';

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

/**
 * The start's phases with their times (ms since the process started: performance.timeOrigin), so studio.log shows where a slow
 * start went: what ran before the log could be written is logged once it can be.
 */
const startup = {
  marks: [] as [string, number][],
  logged: false,
  mark(phase: string): void {
    const at = Math.round(performance.now());
    if (this.logged) log.announce('studio', 'startup: %s at %s ms', phase, at);
    else this.marks.push([phase, at]);
  },
  flush(): void {
    this.logged = true;
    const started = new Date(performance.timeOrigin).toISOString();
    log.announce('studio', 'startup: process started %s; %s', started, this.marks.map(([p, at]) => `${p} at ${at} ms`).join(', '));
    // The time before any of AIB's code runs (Windows loading AIB.dll, an antivirus scan of a new build, the runtime starting) is
    // not in the marks above (they count from the runtime's start): the OS's creation time of this process shows it.
    const created = osCreatedMs();
    if (created !== null) {
      const before = Math.round(performance.timeOrigin - created);
      log.announce('studio', 'startup: Windows created the process at %s, %s ms before the runtime started%s', new Date(created).toISOString(), before,
        before > 2000 ? ' (slow: Windows was loading AIB before any of its code ran, e.g. an antivirus scan of a new build)' : '');
    }
  },
};

/** This process's creation time from the OS (epoch ms; Windows only), or null. Never throws. */
function osCreatedMs(): number | null {
  if (Deno.build.os !== 'windows') return null;
  try {
    const s = processStartTime(Deno.pid);
    return s === null ? null : s * 1000;
  } catch {
    return null;
  }
}

export async function main(argv: string[]): Promise<void> {
  startup.mark('main');
  // A `deno desktop` runtime sets DENO_SERVE_ADDRESS, which makes Deno.serve ignore the port it is given (spike 2026-11-10). AIB
  // binds its own ports in every mode (the page and the artifact origin on port + 1, the agent host's port), so drop it first. Its
  // port is kept: in window mode it redirects to our page (desktop/serve_address.ts). In a desktop binary the listeners are not
  // Deno.serve (platform/http_serve.ts), and every mode without the app window keeps the runtime's startup window hidden.
  // The page's launch key (web/page_access.ts) a launcher may choose (tests): taken out of the environment before anything starts,
  // so no agent, terminal, keeper or agent host this process starts can read it.
  const launchKey = takeLaunchKeyFromEnv();
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
  startup.mark('update leftovers scheduled');
  let options: Options;
  try {
    options = parseOptions(args);
  } catch (error) {
    if (error instanceof UsageError) usage(error.message);
    throw error;
  }
  const mcpServers = loadMcp(options, usage); // studio.finish_agent_options: an invalid --mcp-config is a usage error
  await applyStatePaths(options as never, usage, APP_ROOT);
  const stateDir = String(options.stateDir);
  startup.mark('data folder ready');
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
  startup.mark('single-instance lock');
  // The desktop app logs at INFO unless a level was asked for (window navigations, the keeper, the redirect: evidence for bugs).
  const levelGiven = args.some((a) => a.startsWith('--log-level')) || !!Deno.env.get(log.ENV_LEVEL);
  log.setup('studio', { level: desktop && !levelGiven ? 'INFO' : options.logLevel, stateDir, filename: 'studio.log' });
  if (!Deno.env.get(log.ENV_LEVEL)) Deno.env.set(log.ENV_LEVEL, String(options.logLevel)); // a host this server starts logs alike
  startup.mark('logging');
  if (!options.stopHost) startup.flush();
  if (options.stopHost) {
    const result = await stopHost(stateDir, options.force, 20, `AIB --stop-host${options.force ? ' --force' : ''} (pid ${Deno.pid})`);
    console.log(result.message);
    for (const item of (result.active ?? []) as Record<string, unknown>[]) console.log(`  ${item.provider} in ${item.cwd}: ${item.state}`);
    Deno.exit(result.stopped || !result.running ? 0 : 2);
  }
  // The crash trail (core/crash_trail.ts): uncaught errors, unhandled rejections, exits and memory into <data>/crash.log; the desktop
  // app's stderr (it has no console) goes there too, so no end of AIB is silent again.
  await installCrashTrail({ stateDir, version: APP_VERSION, captureStderr: desktop && isDesktopApp() });
  startup.mark('crash trail');
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
  if (desktop && isDesktopApp() && Deno.build.os !== 'windows') {
    // From the app menu the PATH is the short system one: ask the user's interactive login shell for the real one, once, for finding
    // tools and for every agent AIB starts (they inherit this process's environment).
    const adapters = await import('./agents/adapters.ts');
    const source = await adapters.initToolPath();
    log.announce('studio', '%s', adapters.toolReport(source || 'bare'));
  }
  if (desktop) {
    // The same port as last time when it is free, so the page's origin (and its localStorage drafts) stays the same across restarts
    // and updates; else the first free pair from 8777, like the Tauri app.
    if (!portGiven(args)) options.port = lastPortPair(stateDir, portFree) ?? choosePortPair(portFree);
  }
  let studio: Aib | null = null;
  let host: LiveBackend;
  let webInstanceId: string;
  // One process with the keeper (owner decisions D3 and "the keeper is always on", docs/agent-host.md "The keeper"): the agents run
  // in the keeper and outlive this process, so the separate agent host has no job left. When the keeper cannot run (program missing,
  // no Go in a source run, it does not start) decideKeeper logs why and AIB falls back to the split agent host (or, --in-process,
  // agents as children of this process); Settings > About shows the reason. AIB_KEEPER=0 (tests, debugging) turns it off.
  // A split host that still runs for the folder (an older version such as beta.3) is stopped when idle, else drained.
  const keeperOn = await decideKeeper(stateDir);
  startup.mark('keeper decided');
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
    studio = new Aib(studioOptions(options, mcpServers), merged ? { port: 'host' } : {});
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
  let close = async (_why?: string, _release?: boolean, _hold?: boolean) => {};
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
    pageKey: launchKey,
  });
  // A known project folder inside a repo wins for chats in any worktree; saved worktree chats map back to their project.
  worktrees.known.projects = () => [...ctx.projectPrefs.projects.keys()].filter((k) => k.startsWith('w:')).map((k) => k.slice(2));
  const resolver = new worktrees.ProjectResolver(stateDir);
  const resolve = (cwd: string) => resolver.resolve(cwd);
  if ('setProjectResolver' in ctx.transcripts) ctx.transcripts.setProjectResolver(resolve);
  else ctx.transcripts.projectResolver = resolve;
  // updater.UpdateService as studio.create_server builds it: the Settings toggle, the chats being worked on, and a quit that runs
  // the normal close path after the install route has answered.
  worktrees.setCommitIdentity(() => ctx.settings.commitIdentity()); // AIB's own commits use the Settings identity
  ctx.updates = new UpdateService(stateDir, {
    autoCheck: () => ctx.settings.autoUpdateCheck(),
    getTestBuilds: () => ctx.settings.getTestBuilds(),
    busyChats: async () => (await host.busyConnections()).length,
    quit: (release) => void setTimeout(() => void close('installing an update', release), 50),
    chatsKeepRunning: !studio, // the agent host outlives this app: an update never stops a working chat
    // AIB only in the tray (the keeper's restart after a crash, or a quit the keeper could not hold): "Install when chats finish"
    // waits for the next launch, so an update never opens a window after the person quit.
    holdInstall: () => desktopApp?.background ?? false,
    // One desktop notification per version once an update is downloaded and verified ("Desktop notifications" on), sent here so it
    // also comes while the window is closed to the tray. A server run has no desktop notifications.
    onReady: (version) => void notifyUpdateReady(ctx.desktopNotify, ctx.viewPrefs.public().prefs, version),
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
  if (host instanceof HostProxy) await host.listening(port); // --port 0: the agent host learns the port the OS gave us
  const url = `http://127.0.0.1:${port}`;
  await folderLock?.setPort(port);
  if (desktop) saveLastPort(stateDir, port);
  log.announce('studio', 'AIB %s on %s (pid %s, %s, data %s)', APP_VERSION, url, Deno.pid, desktop ? 'desktop app' : 'server', stateDir);
  startup.mark('server listening');
  if (desktop && runtimePort && runtimePort !== port) startRedirect(runtimePort, `${url}/`);
  server.gate.artifactPorts.add(ctx.artifacts.start(port)); // the artifact origin is same-site, never the page
  // Phone access (Settings > Remote control), when it is on: the phone port for Tailscale Serve, on its own fixed port (remote/access.ts).
  // In the background: a busy port is retried for ~20 s and then reported in Devices, never swapped for another.
  ctx.phone.options.log = (m) => log.announce('studio', 'phone access: %s', m);
  void ctx.phone.start();
  void ctx.pcsync.start(); // sync between PCs (Settings > Sync): listens again when it was on
  // "Needs you" and "finished", decided here (not by the page), so desktop notifications and phone pushes come with the window
  // closed; the same in-process, with the keeper and with a split agent host (attention/watcher.ts).
  const attention = startAttention(ctx);
  const swarm = swarmOf(ctx); // swarm phase 1: helper reports and lines that waited for a restart (swarm/service.ts)
  swarm.ctx.announce = (news) => attention.announce(news); // a helper that failed to start: notified like a failed chat
  ctx.keepAwake.apply(ctx.settings.keepAwake()); // the saved value (off by default); the request dies with this process
  ctx.updates.start(); // the daily update check and the wait-for-idle install (studio.main: server.updates.start())
  // The daily zip of each project's local-only folders (never committed, so git keeps no copy): the added projects and the
  // projects AIB keeps chat copies of.
  const backups = startLocalBackups({
    stateDir,
    projects: () => [
      ...Object.values(ctx.addedProjects.public().added).map((a) => String((a as { path?: unknown }).path ?? '')),
      ...Object.values(new worktrees.Registry(stateDir).all()).map((r) => String(r.project ?? '')),
    ].filter(Boolean),
  });
  // the same for WSL projects: each running distro's helper zips them into its own data folder (and adds its chat copies' projects)
  const wslBackups = startWslLocalBackups(() =>
    Object.values(ctx.addedProjects.public().added).map((a) => String((a as { path?: unknown }).path ?? '')).filter(Boolean)
  );
  if (studio) {
    // The take-over started above (chats whose agents still run in the keeper go on where they are) runs on in the background: the
    // window opens now, with those chats Reconnecting… until theirs is done (liveState waits for it). The automatic reconnect of
    // the rest starts once the Windows keeper's chats are taken over; a WSL chat's waits for its distro's take-over (studio.ts).
    const s = studio;
    void s.adoptKeeperWindows().then((n) => {
      startup.mark(`take-over done (${n} chat(s) from the keeper)`);
      if (!closing) {
        s.startAutoReconnect();
        s.startScheduleScan(); // scheduled messages of chats nobody opens still go at their time
      }
    });
    void s.adoptKeeper().then(() => {
      startup.mark('WSL ready (take-over of the WSL keepers done)');
      // merged and long-stopped helpers' copies go once every chat the keeper held is taken over (running ones are never touched)
      if (!closing) void retireAtStart(ctx);
    });
  } else {
    void retireAtStart(ctx); // the split agent host took its chats over before it answered
  }
  try { // artifact tool: agents re-read this when Studio restarts on another port (json.dumps spacing, like studio.py)
    await Deno.writeTextFile(`${stateDir}${sep}artifact-web.json`, `{"url": ${JSON.stringify(url)}, "pid": ${Deno.pid}}`);
  } catch { /* as Python: not fatal */ }
  if (studio) {
    console.log(`AIB: ${url}\nIn-process mode: keep this process running while agents work. Ctrl+C stops owned ACP connections.`);
  } else {
    console.log(
      `AIB: ${url}\nAgents run in the separate agent host, so this server can be restarted without stopping them (${
        isCompiled() ? 'AIB' : SOURCE_COMMAND
      } --stop-host ends the host).`,
    );
  }
  close = async (why = 'quit', release = false, hold = false) => {
    if (closing) return;
    closing = true;
    log.announce(
      'studio',
      'closing (%s)%s',
      why,
      release && studio ? (hold ? '; the keeper holds the chats until AIB is started again' : '; leaving the chats in the keeper') : '',
    );
    // hold (Quit AIB with work running): the keeper restarts no AIB in the tray and keeps every chat and terminal shell until the next
    // AIB takes them over. Told through each link before it closes (terminal shells alone may be what works); Studio.release repeats
    // it last.
    // The page's last view-preference saves (a project picked just before the window closed) are on disk before AIB exits: the
    // page sends them with keepalive, so they still arrive after its window is gone, as long as this process waits for them.
    if (desktop) {
      const t0 = Date.now();
      const settled = await ctx.viewPrefs.settle(1500, 250).catch(() => false);
      log.announce('studio', 'closing: view preferences %s after %s ms', settled ? 'saved' : 'still on their way', Date.now() - t0);
    }
    for (const link of hold ? [studio?.keeper, terminalKeeper] : []) await holdKeeper(link);
    ctx.updates.stop();
    backups.stop();
    wslBackups.stop();
    await ctx.artifacts.stop().catch(() => {});
    await attention.stop().catch(() => {});
    await swarm.stopWatching().catch(() => {});
    ctx.keepAwake.release();
    await ctx.phone.close().catch(() => {});
    await server.close(release).catch(() => {}); // release (an update): terminal shells in the keeper keep running
    // split: detach only; in-process: stops every agent; release (an update with the keeper): the chats stay in the keeper.
    if (release && studio) await studio.release({ hold }).catch(() => {});
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
      url: `${url}/`, // never a key in a window URL: it would land in WebView2's history and session-restore files
      // The window is the page that gets the token (web/page_access.ts): every fresh page is handed a one-time launch key through
      // the window's private channel, and trades it for a page session it keeps in memory only.
      pageConnected: (held) => ctx.pageAccess.holds(held),
      pageKeys: { mint: () => ctx.pageAccess.mintKey(), revoke: (key) => ctx.pageAccess.revoke(key) },
      stateDir,
      trayIcon: trayIconPng(),
      busyCount: async () => (await host.busyConnections()).length,
      // Closing the window or Quit AIB never stops a chat: with something working AIB leaves it to the keeper and exits, as Install
      // now does (window.ts decide; canLeave). Split (an older version's host, being drained): the app quits at once and the host is
      // asked to stop unforced (an idle host goes, a busy one keeps its chats under its own icon); Stop all chats and quit forces it.
      stopHost: studio ? undefined : async (force) => {
        const result = await stopHost(stateDir, force, 5, `the app quitting (pid ${Deno.pid}${force ? ', OK: stop them' : ''})`);
        log.announce('studio', 'quit: agent host %s', result.stopped ? 'stopped' : `kept (${result.message})`);
        return result;
      },
      quit: (_stop, leave) => leave ? close('the app was quit with work running', true, true) : close('the app was quit'),
      // Quit AIB with work running exits only when the keeper can hold all of it; else AIB stays in the tray until nothing works.
      canLeave: studio?.keeper
        ? async () => {
          const why = await studio!.quitHandover();
          if (why) return why;
          const outside = ctx.terminals.busyOutsideKeeper();
          if (outside) return `${outside} terminal command(s) run outside the keeper`;
          const shells = await terminalKeeper?.client(false).catch(() => null);
          if (shells && !shells.has('hold')) return `the running keeper (${shells.keeperVersion}) cannot hold terminals`;
          return '';
        }
        : undefined,
      onPageLoaded: () => writeStartedMarker(stateDir), // the update helper waits for it
      // Multi-window restore (G4): a project window whose folder is gone is not restored (network and WSL paths count as present,
      // and nothing waits for a WSL distro, G5). A closed window's presence slot goes at once (B8).
      folderGone: (path) => folderPresence.isGone(path),
      onWindowGone: (w) => ctx.presence.leave(w),
      // The keeper's orphan restart (rule V1) starts AIB with --start-in-tray: no window over the person's work, only the tray.
      startInTray: options.startInTray,
      // Phone access on (Settings > Remote control): closing the window keeps AIB in the tray, so the phone port, the attention watcher,
      // notifications and pushes keep working; no idle quit in the tray; Quit AIB as always (owner's decision 2026-11-12).
      phoneOn: () => ctx.phone.on,
      terminalsBusy: () => ctx.terminals.busyCount(), // a command running in a terminal is work: left to the keeper, never cut off
      mergesRunning: () => mergesRunning() + wslMergesRunning(), // Quit AIB lets a running merge (a WSL chat's too) finish before AIB exits
      trayCounts: studio
        ? () => {
          // needs you: the inbox's one number (inbox-rules.js), the same as the page's badge and the phone's
          // and the blocked chats themselves for the tray menu's chat slots (the attention watcher's last look, with their titles)
          // The chat open in the AIB window is left out (inbox-rules.js isOpen): it is in front of the owner already.
          const open = ctx.presence.openOnPc();
          return Promise.resolve({
            working: studio!.workingList().length,
            // the server-built inbox's count (attention/inbox.ts), as the page and the phone show it; before its first look, the
            // agent host's own reading of the same rules
            needsYou: ctx.inbox.latest() ? ctx.inbox.desktopCount() : studio!.blockedChats(open),
            blocked: attention.blocked().filter((b) => !INBOX.isOpen(b.key, open)),
          });
        }
        : undefined,
    });
    ctx.desktopNotify = app.notifications; // POST /api/live/desktop/notify: the page's notifications, shown by this process
    if (Deno.build.os === 'windows' && Deno.env.get('AGENT_STUDIO_TEST') !== '1') {
      // Inbox v3.1 phase 4: toasts with buttons through `AIB-keeper toast` (desktop/toast.ts); the balloon stays the fallback
      void keeperBinary(stateDir).then((program) =>
        startWindowsToasts(ctx, app.notifications, {
          stateDir,
          program,
          launch: isCompiled() ? Deno.execPath() : '',
          icon: trayIconBytes(32),
          quietState: userNotificationState,
        })
      ).catch(() => {/* balloons, as before */});
    } else if (Deno.build.os === 'linux' && Deno.env.get('AGENT_STUDIO_TEST') !== '1') {
      // the same buttons on Linux, through org.freedesktop.Notifications (desktop/toast_linux.ts); notify-send stays the fallback.
      // A click while AIB is quit starts the AppImage file itself (the running copy's mount is gone by then) or the installed program.
      void keeperBinary(stateDir).then((program) =>
        startLinuxToasts(ctx, app.notifications, {
          stateDir,
          program,
          launch: Deno.env.get('APPIMAGE') || (isCompiled() ? Deno.execPath() : ''),
          icon: trayIconBytes(32),
        })
      ).catch(() => {/* notify-send, as before */});
    }
    ctx.desktopWindows = app.desktopWindows; // K4: POST /api/live/desktop/windows opens, routes, focuses and closes app windows
    await app.start(); // the window navigates now: the server already listens
    startup.mark('window opened');
    await watchSignal(stateDir, () => void app.showWindow());
    void ensureStartMenuShortcut(Deno.execPath());
    return;
  }
  writeStartedMarker(stateDir); // `serve`: up once it listens
  // The link with a one-time launch key (web/page_access.ts): it connects one browser tab, once, within 15 minutes (the tab keeps
  // its page session in memory: a reload needs a new link). Printed only to a console a person sees, never into a redirected log.
  const pageLink = ctx.pageAccess.pageUrl(url);
  let onConsole = false;
  try {
    onConsole = Deno.stdout.isTerminal();
  } catch { /* no stdout */ }
  if (onConsole) console.log(`Open AIB in a browser with this link (it connects one browser tab, once, within 15 minutes): ${pageLink}`);
  if (options.open) {
    const opener = Deno.build.os === 'windows'
      ? ['cmd', '/c', 'start', '', pageLink]
      : Deno.build.os === 'darwin'
      ? ['open', pageLink]
      : ['xdg-open', pageLink];
    new Deno.Command(opener[0], { args: opener.slice(1), stdout: 'null', stderr: 'null' }).spawn();
  }
}

if (import.meta.main) await main(Deno.args);

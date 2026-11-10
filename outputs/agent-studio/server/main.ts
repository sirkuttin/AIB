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
import { APP_ROOT, APP_VERSION, isCompiled, isDesktopApp, selfCommand } from './core/app.ts';
import * as log from './core/log.ts';
import { Options, parseOptions, UsageError } from './core/options.ts';
import { apply as applyStatePaths } from './state/paths.ts';
import './state/migrate.ts'; // registers the data move with paths.ts
import { stopHost } from './host/host_client.ts';
import { attachHost } from './host/host_proxy.ts';
import type { LiveBackend } from './host/backend.ts';
import { Studio } from './host/studio.ts';
import { hostMain, loadMcp, studioOptions } from './host/agent_host.ts';
import { UpdateService } from './desktop/updater.ts';
import { makeContext, WebServer } from './web/server.ts';
import { openSource } from './transcripts/monitor.ts';
import { ensureHiddenConsole } from './platform/console.ts';
import { configure as configureArtifactKeys } from './artifacts/keys.ts';
import * as worktrees from './worktrees/worktrees.ts';
import { choosePortPair, DesktopApp, portFree, portGiven } from './desktop/window.ts';
import { guardDataFolder, nativeNotice, watchSignal } from './desktop/single_instance.ts';
import { ensureStartMenuShortcut } from './desktop/shortcut.ts';
import { trayIconDarkPng, trayIconPng } from './desktop/tray_icon.ts';
import { servePort, startRedirect } from './desktop/serve_address.ts';

const sep = Deno.build.os === 'windows' ? '\\' : '/';

/** Subcommands of a desktop binary that never show a window. */
const NO_WINDOW = new Set(['host', 'mcp-artifact', 'deploy', 'update-helper', 'serve']);

export { selfCommand };

/** remote_studio.host_command: the command line that starts an agent host configured like this web server. */
export function hostCommand(o: Options, compiled = isCompiled()): string[] {
  const command = [
    ...selfCommand(),
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
  if (isDesktopApp() && (NO_WINDOW.has(argv[0]) || argv.includes('--stop-host'))) (await import('./desktop/native.ts')).tameStartupWindow();
  if (argv[0] === 'host') Deno.exit(await hostMain(argv.slice(1)));
  if (argv[0] === 'mcp-artifact') Deno.exit(await (await import('./artifacts/mcp.ts')).main());
  if (argv[0] === 'deploy') Deno.exit(await (await import('./host/deploy.ts')).main(argv.slice(1)));
  if (argv[0] === 'update-helper') Deno.exit(await (await import('./desktop/update_helper.ts')).main(argv.slice(1)));
  ensureHiddenConsole();
  const args = argv[0] === 'serve' ? argv.slice(1) : argv;
  const desktop = isDesktopApp() && argv[0] !== 'serve'; // the window only for a plain `AIB [options]` launch
  // After an update: delete the previous version's *.old-<stamp> files once nothing runs from them (never throws; desktop app only).
  // (`serve` of the built app too: an update keeps the arguments, so a served app updates the same way.)
  if (isDesktopApp() && !argv.includes('--stop-host')) (await import('./desktop/update_helper.ts')).removeUpdateLeftovers();
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
  if (desktop) {
    if (!portGiven(args)) options.port = choosePortPair(portFree); // like the Tauri app: the first free pair from 8777
  }
  let studio: Studio | null = null;
  let host: LiveBackend;
  let webInstanceId: string;
  if (options.inProcess) {
    // Agents run inside this process (studio.py --in-process): restarting it ends every conversation.
    studio = new Studio(studioOptions(options, mcpServers));
    host = studio;
    webInstanceId = studio.instanceId;
  } else {
    webInstanceId = crypto.randomUUID().replaceAll('-', '');
    host = await attachHost({
      stateDir,
      command: hostCommand(options),
      port: options.port,
      webInstanceId,
      runtime: 'deno',
      // The built app: tell the host how to start this app again (its tray's Open AIB), and retire a host left by the previous
      // version (after an update) as soon as none of its chats is working.
      launch: isCompiled() ? [Deno.execPath(), ...Deno.args] : null,
      retireOlderHost: isCompiled(),
      onRetired: isDesktopApp() ? () => void import('./desktop/update_helper.ts').then((m) => m.removeUpdateLeftovers()) : undefined,
      say: (m) => {
        console.log(m);
        log.announce('studio', '%s', m);
      },
    });
  }
  configureArtifactKeys(stateDir); // artifact tool: the same shared secret as the agent host
  let closing = false;
  let close = async (_why?: string) => {};
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
    quit: () => void setTimeout(() => void close('installing an update'), 50),
    chatsKeepRunning: !options.inProcess, // the agent host outlives this app: an update never stops a working chat
  });
  log.registerSecret(ctx.token);
  const server = new WebServer(ctx);
  const port = await server.listen(options.port);
  const url = `http://127.0.0.1:${port}`;
  await folderLock?.setPort(port);
  log.announce('studio', 'AIB %s on %s (pid %s, %s, data %s)', APP_VERSION, url, Deno.pid, desktop ? 'desktop app' : 'server', stateDir);
  if (desktop && runtimePort && runtimePort !== port) startRedirect(runtimePort, `${url}/`);
  server.gate.artifactPorts.add(ctx.artifacts.start(port)); // the artifact origin is same-site, never the page
  ctx.updates.start(); // the daily update check and the wait-for-idle install (studio.main: server.updates.start())
  if (studio) studio.startAutoReconnect();
  try { // artifact tool: agents re-read this when Studio restarts on another port (json.dumps spacing, like studio.py)
    await Deno.writeTextFile(`${stateDir}${sep}artifact-web.json`, `{"url": ${JSON.stringify(url)}, "pid": ${Deno.pid}}`);
  } catch { /* as Python: not fatal */ }
  if (studio) {
    console.log(`Agent Studio: ${url}\nIn-process mode: keep this process running while agents work. Ctrl+C stops owned ACP connections.`);
  } else {
    console.log(
      `Agent Studio: ${url}\nAgents run in the separate agent host, so this server can be restarted without stopping them (deno run -A server/main.ts --stop-host ends the host).`,
    );
  }
  close = async (why = 'quit') => {
    if (closing) return;
    closing = true;
    log.announce('studio', 'closing (%s)', why);
    ctx.updates.stop();
    await ctx.artifacts.stop().catch(() => {});
    await server.close().catch(() => {});
    await host.close().catch(() => {}); // split: detach only; in-process: stops every agent
    folderLock?.release();
    Deno.exit(0);
  };
  for (const signal of (Deno.build.os === 'windows' ? ['SIGINT', 'SIGBREAK'] : ['SIGINT', 'SIGTERM']) as Deno.Signal[]) {
    try {
      Deno.addSignalListener(signal, () => void close(`signal ${signal}`));
    } catch { /* not supported here */ }
  }
  if (desktop) {
    const { nativeShell } = await import('./desktop/native.ts');
    const app = new DesktopApp(nativeShell(), {
      url: `${url}/`,
      stateDir,
      trayIcon: trayIconPng(),
      trayIconDark: trayIconDarkPng(),
      busyCount: async () => (await host.busyConnections()).length,
      // In-process mode has no separate host: closing stops its agents. Split: OK forces the host down; with nothing working it is
      // stopped too (unforced: a chat that just started keeps it), so no invisible process idles on after the app is gone.
      stopHost: options.inProcess ? undefined : async (force) => {
        const result = await stopHost(stateDir, force, 5, `the app quitting (pid ${Deno.pid}${force ? ', OK: stop them' : ''})`);
        log.announce('studio', 'quit: agent host %s', result.stopped ? 'stopped' : `kept (${result.message})`);
        return result;
      },
      quit: () => close('the app was quit'),
    });
    await app.start(); // the window navigates now: the server already listens
    await watchSignal(stateDir, () => void app.showWindow());
    void ensureStartMenuShortcut(Deno.execPath());
    return;
  }
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

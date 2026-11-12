/**
 * Ports in tests: the OS picks every one. A test never names a port number and never guesses a free one and hopes it is still free a
 * moment later (another test, builder or demo Studio may take it in between). Instead:
 *
 * - In this process: listen on port 0 and read the port back (`Deno.serve({ port: 0 })`, `server.listen(0)`, `startRedirect(0, ...)`).
 * - A child process (AIB `serve`, the desktop binary, the agent host, headless Chrome): start it with port 0 and read the port it
 *   bound back from what it reports: `listenedPort()` on its output or log, `ownerPort()` from the data folder's aib-owner.json,
 *   `devToolsPort()` from Chrome's or WebView2's DevToolsActivePort file.
 * - A port number that must belong to this test but that nothing serves (code under test only derives URLs from it): `heldPort()`
 *   keeps a listener open on it for the test's lifetime, so no one else can bind it.
 * - "Nothing listens there" (a connection-refused case): `refusedPort()`. Never hand it to anything that binds it.
 *
 * port_guard_test.ts fails when a test file or helper uses a fixed port. Every wait here has a time limit.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The page port an AIB process reports: "AIB: http://127.0.0.1:N" on stdout or "AIB <version> on http://127.0.0.1:N (pid" in the log. */
export function listenedPort(text: string): number {
  const m = text.match(/AIB: http:\/\/127\.0\.0\.1:(\d+)/) ?? text.match(/AIB \S+ on http:\/\/127\.0\.0\.1:(\d+) \(pid/);
  return m ? Number(m[1]) : 0;
}

/** Wait until `read()` (a log file, captured output) shows the port the process listens on. Throws after `seconds`, or when `exited()`. */
export async function waitListenedPort(read: () => string, what: string, seconds = 60, exited: () => boolean = () => false): Promise<number> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const port = listenedPort(read());
    if (port) return port;
    if (exited()) throw new Error(`${what} exited before it listened:\n${read()}`);
    await sleep(50);
  }
  throw new Error(`${what} did not report its port within ${seconds} s:\n${read()}`);
}

/** The page port in a data folder's aib-owner.json (desktop/single_instance.ts writes it once the server listens), 0 until then. */
export function ownerPortNow(stateDir: string, pid?: number): number {
  try {
    const owner = JSON.parse(Deno.readTextFileSync(`${stateDir}/aib-owner.json`));
    if (pid !== undefined && owner.pid !== pid) return 0;
    return Number(owner.port) || 0;
  } catch {
    return 0;
  }
}

/** Wait for the page port of the AIB that owns `stateDir` (optionally: the one with this pid). */
export async function ownerPort(stateDir: string, seconds = 60, pid?: number): Promise<number> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const port = ownerPortNow(stateDir, pid);
    if (port) return port;
    await sleep(100);
  }
  throw new Error(`no aib-owner.json port in ${stateDir} within ${seconds} s`);
}

/** Find DevToolsActivePort under `root` (a Chrome --user-data-dir, or the temp LOCALAPPDATA a WebView2 app keeps its profile in). */
function findDevToolsFile(root: string, depth = 6): string | null {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(root)];
  } catch {
    return null;
  }
  if (entries.some((e) => e.isFile && e.name === 'DevToolsActivePort')) return `${root}/DevToolsActivePort`;
  if (depth <= 0) return null;
  for (const e of entries) {
    if (!e.isDirectory) continue;
    const found = findDevToolsFile(`${root}/${e.name}`, depth - 1);
    if (found) return found;
  }
  return null;
}

/**
 * The DevTools port of a browser started with --remote-debugging-port=0, read from the DevToolsActivePort file it writes in its profile.
 * `root` is the --user-data-dir, or any folder above it (searched a few levels deep). `notBefore` skips a file left by an earlier run
 * of the same profile (its mtime is older).
 */
export async function devToolsPort(root: string, seconds = 30, notBefore = 0): Promise<number> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const file = findDevToolsFile(root);
    if (file) {
      try {
        const fresh = !notBefore || (Deno.statSync(file).mtime?.getTime() ?? 0) >= notBefore - 2000;
        const port = parseInt(Deno.readTextFileSync(file), 10) || 0;
        if (fresh && port) {
          // The file is written before the endpoint answers on some builds: wait for /json/version too.
          try {
            const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
            await r.body?.cancel();
            if (r.ok) return port;
          } catch { /* not answering yet */ }
        }
      } catch { /* being written */ }
    }
    await sleep(100);
  }
  throw new Error(`no DevToolsActivePort under ${root} within ${seconds} s`);
}

/** A port held open by this process until `close()`: for code that only needs a number that is certainly ours. */
export function heldPort(): { port: number; close(): void; [Symbol.dispose](): void } {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const close = () => {
    try {
      listener.close();
    } catch { /* closed */ }
  };
  return { port, close, [Symbol.dispose]: close };
}

/**
 * An OS-chosen port number for a child whose command line or saved settings must name its port because it comes back on the same one
 * (the keeper restarts AIB with its original command line; an update reopens the window on the port it used last, where WebView2 keeps
 * the page's localStorage). `pair`: port + 1 (the artifact origin) was free too. The number comes from the OS's ephemeral range, so it
 * never meets a fixed port or the live AIB; a test that can read the port back instead (port 0) should.
 */
export function pickPort(pair = false): number {
  for (let i = 0; i < 50; i++) {
    const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    const port = (listener.addr as Deno.NetAddr).port;
    try {
      if (!pair) return port;
      if (port + 1 > 65535) continue;
      try {
        Deno.listen({ hostname: '127.0.0.1', port: port + 1 }).close();
        return port;
      } catch { /* port + 1 is taken: another one */ }
    } finally {
      listener.close();
    }
  }
  throw new Error('no free port pair in 50 tries');
}

/** The DevTools port in a DevToolsActivePort file under `root` right now (0: none yet). A restarted WebView2 writes a new one. */
export function devToolsPortNow(root: string): number {
  const file = findDevToolsFile(root);
  if (!file) return 0;
  try {
    return parseInt(Deno.readTextFileSync(file), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * A port nothing listens on, for "connection refused" cases only. It was free a moment ago; never pass it to something that binds it
 * (that is the guess-and-hope this file exists to avoid).
 */
export function refusedPort(): number {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

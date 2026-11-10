/** Fixtures shared by the agent tests (adapters, installer, signin, shared): temp folders, fake installs, the Python program. */
import { python, WORK } from './_parity.ts';

const WIN = Deno.build.os === 'windows';
export const SEP = WIN ? '\\' : '/';

function nativePath(url: URL): string {
  const path = decodeURIComponent(url.pathname);
  return WIN ? path.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('/', '\\') : path;
}

/** The Python program as an absolute path (the tests use it as "node", as the Python tests do). */
export const PY: string = (() => {
  const out = new Deno.Command(python(), { args: ['-c', 'import sys; print(sys.executable)'], stdout: 'piped' }).outputSync();
  return new TextDecoder().decode(out.stdout).trim();
})();
export const PY_REAL: string = Deno.realPathSync(PY);

export const FAKE_NPM = nativePath(new URL('fake_npm.py', WORK));
export const FAKE_SIGNIN = nativePath(new URL('fake_signin_agent.py', WORK));

export function join(...parts: string[]): string {
  return parts.join(SEP);
}

/** A fresh temp folder (real path), removed by the returned cleanup. Never the real state folder. */
export function tempDir(): { root: string; [Symbol.dispose](): void } {
  Deno.env.set('AGENT_STUDIO_TEST', '1');
  const root = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-agents-' }));
  return {
    root,
    [Symbol.dispose]() {
      for (let i = 0; i < 10; i++) {
        try {
          Deno.removeSync(root, { recursive: true });
          return;
        } catch {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
        }
      }
    },
  };
}

export function touch(path: string, text = '// adapter\n'): string {
  Deno.mkdirSync(path.slice(0, path.lastIndexOf(SEP)), { recursive: true });
  Deno.writeTextFileSync(path, text);
  return path;
}

export function exists(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** A fake npm install: <state>/agents/<agent>/<version>/node_modules/<package>/ with a package.json and the entry files. */
export function makeInstall(
  state: string,
  agent: string,
  version: string,
  pkg: string,
  options: { bin?: unknown; complete?: boolean; files?: string[] } = {},
): [string, string] {
  const folder = join(state, 'agents', agent, version);
  const dir = join(folder, 'node_modules', ...pkg.split('/'));
  Deno.mkdirSync(dir, { recursive: true });
  const manifest: Record<string, unknown> = { name: pkg, version };
  const bin = 'bin' in options ? options.bin : 'dist/index.js';
  if (bin !== null && bin !== undefined) manifest.bin = bin;
  Deno.writeTextFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  for (const name of options.files ?? ['dist/index.js']) touch(join(dir, ...name.split('/')));
  if (options.complete ?? true) Deno.writeTextFileSync(join(folder, '.complete'), 'ok');
  return [folder, dir];
}

export async function waitFor<T>(check: () => T | Promise<T>, seconds = 25): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  return await check();
}

/** A process that is certainly dead: its pid. */
export async function deadPid(): Promise<number> {
  const child = new Deno.Command(PY, { args: ['-c', 'pass'] }).spawn();
  await child.status;
  return child.pid;
}

/** Set environment variables for the duration of a test; returns a restore function. */
export function withEnv(values: Record<string, string>): () => void {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(values)) {
    before[k] = Deno.env.get(k);
    Deno.env.set(k, v);
  }
  return () => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  };
}

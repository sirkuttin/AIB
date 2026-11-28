/**
 * Tool servers of a WSL project, run natively in the distro (toolservers/discover.ts over the distro's own files): the MCP servers
 * Claude Code, Codex, Gemini, Qwen, Copilot and Antigravity name in THEIR config files in the distro's home and in the project folder.
 * `toolservers.discover` is read only. `toolservers.write` writes the per-chat files Gemini's single-tool switches and Qwen's settings
 * need (apply.ts), only in AIB's own data folder in the distro (`<data>/toolservers/`), never in the user's ~/.gemini or ~/.qwen.
 * The Windows side (wsl/toolservers.ts) asks for both; AIB keeps the choice, never the distro's files.
 */
import { discoverServers, diskFiles } from '../../toolservers/discover.ts';
import { mergeQwenSettings } from '../../toolservers/apply.ts';
import * as qwenSub from '../../subagents/qwen.ts';
import * as osp from '../../platform/ospath.ts';
import { isDict } from '../../core/py.ts';
import { BAD_PARAMS, type Handlers, RpcError, str } from './rpc.ts';

type Json = Record<string, unknown>;
const HASH = /^[A-Za-z0-9_-]{1,64}$/;
const SWEEP_AFTER_MS = 7 * 24 * 3600 * 1000;

/** Files of this feature older than a week (a hash no chat uses any more) go, except `keep`. Never throws. */
function sweep(dir: string, keep: string): void {
  try {
    for (const e of Deno.readDirSync(dir)) {
      if (e.name === keep || !/^(gemini|qwen)-/.test(e.name)) continue;
      const path = osp.join(dir, e.name);
      try {
        const st = Deno.lstatSync(path);
        if (st.isSymlink || !st.mtime || Date.now() - st.mtime.getTime() < SWEEP_AFTER_MS) continue;
        Deno.removeSync(path, { recursive: true });
      } catch { /* in use, or gone */ }
    }
  } catch { /* no folder yet */ }
}

export function toolServerMethods(ctx: { env(): Promise<{ env: Record<string, string>; home: string }>; data?: string }): Handlers {
  const methods: Handlers = {
    'toolservers.discover': async (p) => {
      const folder = str(p, 'folder');
      // an absolute path (a Linux one in the distro; a drive path only in the tests, which run this module on Windows)
      if (!(folder.startsWith('/') || /^[A-Za-z]:[\\/]/.test(folder)) || folder.includes('\0')) {
        throw new RpcError('folder must be an absolute Linux path', BAD_PARAMS);
      }
      const login = await ctx.env();
      const home = login.home || login.env.HOME || '/';
      return { servers: discoverServers(diskFiles, { home, folder, env: login.env, sep: '/' }) };
    },
  };
  const data = ctx.data;
  if (!data) return methods; // no data folder: no place of AIB's own to write in
  /**
   * `agent: 'gemini'`: writes `toml` as `<data>/toolservers/gemini-<hash>/aib-toolservers.toml` and answers {path: the folder} (`--admin-policy`).
   * `agent: 'qwen'`: writes `<data>/toolservers/qwen-<hash>.json` = the base settings with `fragment` merged in (mergeQwenSettings) and
   * answers {path: the file} (QWEN_CODE_SYSTEM_SETTINGS_PATH). The base is `base` (a file the chat already has, only when it is in AIB's
   * data folder), else the distro's own Qwen system settings (as Windows reads its own); never written.
   */
  methods['toolservers.write'] = async (p) => {
    const agent = str(p, 'agent');
    const hash = str(p, 'hash');
    if (!HASH.test(hash)) throw new RpcError('hash is not valid', BAD_PARAMS);
    const root = osp.join(data, 'toolservers');
    if (agent === 'gemini') {
      const toml = str(p, 'toml');
      if (toml.length > 200_000 || toml.includes('\0')) throw new RpcError('toml is not valid', BAD_PARAMS);
      const dir = osp.join(root, `gemini-${hash}`);
      Deno.mkdirSync(dir, { recursive: true });
      Deno.writeTextFileSync(osp.join(dir, 'aib-toolservers.toml'), toml);
      sweep(root, `gemini-${hash}`);
      return { path: dir };
    }
    if (agent !== 'qwen') throw new RpcError('agent must be gemini or qwen', BAD_PARAMS);
    if (!isDict(p.fragment)) throw new RpcError('fragment must be an object', BAD_PARAMS);
    let base: Json = {};
    const own = typeof p.base === 'string' ? p.base : '';
    const nd = osp.normpath(data);
    const inside = own && !own.includes('\0') && !own.split(/[\\/]/).includes('..') &&
      osp.normpath(own).startsWith(nd + (nd.includes('\\') ? '\\' : '/'));
    if (inside) {
      try {
        const parsed = JSON.parse(Deno.readTextFileSync(own));
        if (isDict(parsed)) base = parsed as Json;
      } catch { /* unreadable: AIB's fragment alone, as on Windows */ }
    } else {
      const login = await ctx.env();
      const project = typeof p.project === 'string' && p.project.startsWith('/') && !p.project.includes('\0') ? p.project : '/';
      const env: Record<string, string> = { ...Deno.env.toObject(), ...login.env };
      const given = isDict(p.env) ? p.env as Json : {};
      for (const name of ['QWEN_HOME', 'QWEN_CODE_SYSTEM_SETTINGS_PATH']) {
        const v = given[name];
        if (typeof v === 'string' && v.length < 4096 && !v.includes('\0')) env[name] = v;
      }
      const system = qwenSub.readQwenSetup(project, env, 'linux').system;
      if (isDict(system)) base = system as Json;
    }
    const file = osp.join(root, `qwen-${hash}.json`);
    Deno.mkdirSync(root, { recursive: true });
    Deno.writeTextFileSync(file, JSON.stringify(mergeQwenSettings(base, p.fragment as Json), null, 2) + '\n');
    sweep(root, `qwen-${hash}.json`);
    return { path: file };
  };
  return methods;
}

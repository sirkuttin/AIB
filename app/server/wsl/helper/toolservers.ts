/**
 * Tool servers of a WSL project, run natively in the distro (toolservers/discover.ts over the distro's own files): the MCP servers
 * Claude Code, Codex, Gemini, Qwen, Copilot and Antigravity name in THEIR config files in the distro's home and in the project folder.
 * Read only: nothing is written. The Windows side (wsl/toolservers.ts) asks for it; AIB keeps the choice, never the distro's files.
 */
import { discoverServers, diskFiles } from '../../toolservers/discover.ts';
import { BAD_PARAMS, type Handlers, RpcError, str } from './rpc.ts';

export function toolServerMethods(ctx: { env(): Promise<{ env: Record<string, string>; home: string }> }): Handlers {
  return {
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
}

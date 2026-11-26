/**
 * Standalone helpers of the AIB host object: holding the keeper, the subagent-hook notes and constants, keeper instance
 * files, the orphan command, reconnect keys. Moved out of aib.ts (no change).
 */
import { Connection, errorText } from '../acp/connection.ts';
import { isClaudeFamily } from '../agents/claude_family.ts';
import { readClaudeSetup } from '../subagents/claude_config.ts';
import { isDesktopApp, selfCommand } from '../core/app.ts';
import { type OrphanCommand, readKeeperInfo } from '../keeper/client.ts';
import { pidAlive } from './host_client.ts';
import { KeeperLink } from '../keeper/link.ts';
import { isDict, isStr } from '../core/py.ts';
import { join } from '../platform/ospath.ts';
import { log, type Json } from './aib_util.ts';
import { pairKey } from './aib_options.ts';

/**
 * Tell the keeper this AIB leaves on purpose (the person quit with work running): it runs no orphan restart and never stops the
 * channels as orphaned until the next AIB takes them over (keeper 1.3.0 `hold`). Only an already connected keeper; never throws. True when
 * the keeper holds.
 */
export async function holdKeeper(link: KeeperLink | null | undefined): Promise<boolean> {
  if (!link) return false;
  try {
    const client = await link.client(false);
    if (!client?.has('hold')) return false;
    await client.hold();
    return true;
  } catch (error) {
    log.warning('keeper: hold failed: %s', errorText(error));
    return false;
  }
}

/** Subagent worktrees: the reason a chat whose Claude settings turn hooks off gets none (its chat line and Activity say so). */
export const HOOKS_OFF = 'hooks are off';

/** Subagent worktrees: the reason a Windows chat without Git Bash gets no hooks; its subagents are denied instead (MF 7). */
export const NO_GIT_BASH = 'Git Bash not found';
export const SUBAGENTS_OFF_NO_BASH = "Subagents that edit files are off: Git Bash is needed for AIB's subagent rule. Read-only subagents (Explore, Plan) still work.";
/**
 * Subagent calls of one chat AIB prepares at once; more are denied at once (should-fix 3). Above the parallel subagents a turn
 * usually starts, well under the cap of worktrees per chat.
 */
export const MAX_PRE_TOOL_WAITING = 4;
/** The hook events a WSL chat's forwarder may send through the tunnel (the HTTP routes' set). */
export const WSL_HOOK_EVENTS = /^(pre-tool|pre-shell|worktree-create|post-agent|subagent-stop|codex-pre-tool|codex-subagent-start|codex-subagent-stop|gemini-before-tool|qwen-pre-tool|qwen-subagent-start|qwen-subagent-stop|agy-pre-tool|agy-session-start|agy-stop)$/;
/** A WSL chat whose subagent hooks can't be set up: its editing subagents are turned off (never run unisolated in the folder). */
export const WSL_HOOKS_UNAVAILABLE = 'WSL hooks unavailable';
export const WSL_SUBAGENTS_OFF = { permissions: { deny: ['Agent', 'Task', 'Workflow', 'EnterWorktree'] } };
export const WSL_SUBAGENTS_OFF_PROMPT = 'In this chat, subagents are turned off, because AIB could not give them their own worktree in this WSL ' +
  'distro. Do the work yourself.';
export const SUBAGENT_BUSY ='AIB is still preparing worktrees for other subagents of this chat; try this subagent again in a moment.';

/**
 * At each turn start (security review P1, should-fix 7): a chat that was given hooks reads its Claude settings again. When they now
 * turn hooks off (disableAllHooks or allowManagedHooksOnly written mid-chat), Claude Code stops running AIB's hooks: the chat says so
 * and Activity shows "Not isolated"; when they are back on, it says that too. Never throws.
 */
export function recheckSubagentHooks(c: Connection): void {
  const h = c.subagentHooks;
  if (!h || !isClaudeFamily(c.provider) || !(h.settings?.hooks || h.adopted)) return;
  if (h.off && h.off !== HOOKS_OFF) return;
  try {
    const now = readClaudeSetup(c.projectRoot || c.cwd, h.configDir ? { CLAUDE_CONFIG_DIR: h.configDir } : Deno.env.toObject()).hooksOff;
    if (now && h.off !== HOOKS_OFF) {
      h.off = HOOKS_OFF;
      h.detail = now;
      c.recordedEvent('studio_note', {
        message: `Subagents aren't isolated any more: hooks are off in your Claude Code settings (${now}).`,
        sessionId: c.sessionId,
      });
    } else if (!now && h.off === HOOKS_OFF) {
      h.off = '';
      delete h.detail;
      c.recordedEvent('studio_note', { message: 'Hooks are back on: subagents that edit get their own worktree again.', sessionId: c.sessionId });
    }
  } catch (error) {
    log.warning('Could not re-read the Claude settings of %s: %s', c.id, errorText(error));
  }
}

/** A chat's subagent hooks record when it gets none, and why. */
export function offHooks(why: string, detail = ''): NonNullable<Connection['subagentHooks']> {
  return { settings: null, readOnly: [], userWorktreeHook: '', off: why, ...(detail ? { detail } : {}) };
}

/**
 * The hooks record of a chat taken over from the keeper, from its chat note (Connection.hooksNote): hooks on (answered as before,
 * with the read-only list the agent was given) or off with the reason. Null for a note older than the record (#subagentChat).
 */
export function hooksFromNote(raw: unknown): Connection['subagentHooks'] {
  if (!isDict(raw)) return null;
  const text = (v: unknown, n = 300) => (typeof v === 'string' ? v.slice(0, n) : '');
  const readOnly = Array.isArray(raw.readOnly) ? raw.readOnly.filter((n): n is string => typeof n === 'string' && /^[\w.:-]{1,200}$/.test(n)) : [];
  return {
    settings: null,
    readOnly,
    userWorktreeHook: text(raw.userWorktreeHook),
    off: text(raw.off),
    ...(text(raw.detail) ? { detail: text(raw.detail) } : {}),
    ...(text(raw.configDir, 1024) ? { configDir: text(raw.configDir, 1024) } : {}),
    adopted: raw.given === true, // its agent runs AIB's hooks
    ...(text(raw.prompt, 2000) ? { prompt: text(raw.prompt, 2000) } : {}), // Codex: the system prompt line a reopen sends again
    ...(isDict(raw.deny) ? { deny: raw.deny as Json } : {}),
    ...(text(raw.agyDir, 1024) ? { agyDir: text(raw.agyDir, 1024) } : {}), // Antigravity: its --gemini-dir (a taken-over chat's hooks still answer)
    ...(raw.shellTag === true ? { shellTag: true } : {}), // given a hook 2 forwarder: its subagents' shell calls are tagged (a taken-over chat keeps it)
  };
}

/** A `<keeper program> mcp-forward <file>` entry (design 3.7). */
export function isForwardEntry(entry: unknown): boolean {
  const args = isDict(entry) && Array.isArray(entry.args) ? entry.args : [];
  return args[0] === 'mcp-forward';
}

/** The chat id of a chat's keeper channel (`chat-<id>`, connection.ts), or '' for any other channel. */
export function chatIdOfChannel(channel: string): string {
  const m = /^chat-([0-9a-f]{32})$/.exec(channel);
  return m ? m[1] : '';
}

/** The provider an agent command runs, by its program and arguments ('' when it is not one AIB knows). */
export function providerOfCommand(command: string[]): string {
  const text = command.join(' ').toLowerCase().replaceAll('\\', '/');
  if (/claude-agent-acp|claude-code-acp|\/claude(\.exe)?\b/.test(text)) return 'claude';
  if (/codex/.test(text)) return 'codex';
  if (/gemini/.test(text)) return 'gemini';
  return '';
}

export const INSTANCE_FILE = 'studio-instance-keeper.json';

/**
 * The instance id of an AIB whose chats run in the keeper: the id the previous AIB of this data folder used, when the keeper it
 * was connected to still runs (same pid and start time), since every chat it had is rebuilt under the same connection id; a new id
 * otherwise (no keeper, or another one: no old connection id can be valid). Never throws.
 */
export function keeperInstanceId(stateDir: string): string {
  try {
    const saved = JSON.parse(Deno.readTextFileSync(join(stateDir, INSTANCE_FILE)));
    const info = readKeeperInfo(stateDir);
    if (info && pidAlive(info.pid) && isStr(saved.id) && saved.keeperPid === info.pid && saved.keeperStarted === info.started) {
      return saved.id;
    }
  } catch { /* none yet */ }
  return crypto.randomUUID().replaceAll('-', '');
}

/** Remember which keeper this instance id belongs to (on every connection to a keeper). Never throws. */
export function saveKeeperInstance(stateDir: string, id: string): void {
  try {
    const info = readKeeperInfo(stateDir);
    if (!info) return;
    Deno.writeTextFileSync(join(stateDir, INSTANCE_FILE), JSON.stringify({ id, keeperPid: info.pid, keeperStarted: info.started }));
  } catch { /* not fatal: the next start shows "restarted" once */ }
}

/**
 * How the keeper starts AIB again when no AIB is attached (keeper rule V1): this very process's command line. The desktop app adds
 * --start-in-tray, so AIB coming back after a crash shows only its tray icon, never a window over the person's work.
 */
export function orphanCommand(args: string[] = Deno.args, desktop = isDesktopApp()): OrphanCommand {
  const self = selfCommand();
  const windowed = desktop && !['serve', 'host', 'deploy', 'mcp-artifact', 'update-helper'].includes(args[0]);
  const extra = windowed && !args.includes('--start-in-tray') ? ['--start-in-tray'] : [];
  return { command: self[0], args: [...self.slice(1), ...args, ...extra], cwd: Deno.cwd() };
}

/** secrets.token_urlsafe(32). */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/**
 * Tests of whole AIBs (AGENT_STUDIO_TEST=1) may slow the take-over at start down: AIB_TEST_TAKEOVER_DELAY_MS before each chat is
 * rebuilt (a big chat's note and replay), to prove the server and the window do not wait for it. Nothing outside a test.
 */
export function testTakeOverDelay(): Promise<void> {
  const ms = Deno.env.get('AGENT_STUDIO_TEST') === '1' ? Number(Deno.env.get('AIB_TEST_TAKEOVER_DELAY_MS')) : NaN;
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, Math.min(ms, 60_000))) : Promise.resolve();
}

/** True for a pair key's provider/session (exported for tests that look at reconnectPending). */
export function reconnectKey(provider: string, sessionId: string): string {
  return pairKey(provider, sessionId);
}

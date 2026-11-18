/**
 * Open elsewhere for Codex chats, the app-server half (handoff.ts; codex_threads.ts has the per-thread half). The VS Code extension and
 * Codex Desktop start `codex app-server` with no thread id, so AIB cannot tell which chat they want. What it can tell is who started
 * the process: when an app-server appears that is neither AIB's own nor a terminal's, AIB lets go of its idle Codex chats, so any of
 * them can be opened there.
 *
 *   - processTable(): the process list with parents and, for codex/node processes, command lines (Windows: Toolhelp + PEB reads;
 *     Linux: /proc); parsePsTable() reads the same from `ps` (the WSL helper's way: the compiled helper may not read /proc);
 *   - classifyAppServer(): 'own' (below one of AIB's agents), 'vscode' (an editor or its extension host above it within a few parents,
 *     or the OpenAI extension's own folder in its command line, which also covers Remote-WSL), 'desktop' (Codex Desktop), else
 *     'unrelated' (a terminal, a script: the person's own use, never a reason to let go). A shell above it ends the search, so a
 *     `codex app-server` typed in VS Code's terminal is not VS Code's extension.
 *
 * Read-only: only reads processes.
 */
import { WIN } from '../platform/ospath.ts';
import { processList, processStartTime, processStrings } from '../platform/process_info.ts';
import { type CodexProcess, isCodexCli } from './codex_threads.ts';

const APP_SERVER_RE = /(^|\s)app-server(\s|$)/;

/** A Codex CLI process started as `codex app-server`. */
export function isAppServer(proc: { name: string; cmdline: string }): boolean {
  return isCodexCli(proc) && APP_SERVER_RE.test(proc.cmdline);
}

/**
 * Every process with its parent and name. Command lines: codex.exe and node.exe only on Windows (one PEB read each), every process on
 * Linux. App-servers carry a start token.
 */
export function processTable(): CodexProcess[] {
  const out: CodexProcess[] = [];
  if (WIN) {
    for (const entry of processList()) {
      const low = entry.exe.toLowerCase();
      const row: CodexProcess = { pid: entry.pid, ppid: entry.parentPid, name: entry.exe, cmdline: '' };
      if (low === 'codex.exe' || low === 'node.exe') {
        row.cmdline = processStrings(entry.pid)?.commandLine ?? '';
        if (isAppServer(row)) row.start = String(Math.round(processStartTime(entry.pid) ?? 0));
      }
      out.push(row);
    }
    return out;
  }
  if (Deno.build.os !== 'linux') return out;
  const decoder = new TextDecoder();
  for (const entry of Deno.readDirSync('/proc')) {
    if (!/^\d+$/.test(entry.name)) continue;
    try {
      const raw = Deno.readFileSync(`/proc/${entry.name}/cmdline`);
      const cmdline = decoder.decode(raw).split('\0').filter(Boolean).join(' ');
      const stat = Deno.readTextFileSync(`/proc/${entry.name}/stat`);
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const row: CodexProcess = { pid: Number(entry.name), ppid: Number(rest[1]), name: cmdline.split(' ')[0] || '', cmdline };
      if (isAppServer(row)) row.start = rest[19] ?? '0'; // field 22 of /proc/<pid>/stat: start time in clock ticks since boot
      out.push(row);
    } catch { /* gone, or not ours */ }
  }
  return out;
}

/**
 * `ps -eww -o pid=,ppid=,lstart=,args=` as rows. lstart is five words ("Mon Nov 17 21:53:50 2026"): the start token. The name is the
 * program of the command line.
 */
export function parsePsTable(text: string): CodexProcess[] {
  const out: CodexProcess[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
    if (!m) continue;
    const cmdline = m[4].trim();
    const row: CodexProcess = { pid: Number(m[1]), ppid: Number(m[2]), name: cmdline.split(' ')[0] || '', cmdline };
    if (isAppServer(row)) row.start = m[3].replace(/\s+/g, ' ');
    out.push(row);
  }
  return out;
}

/** `roots` and every process below them (by parent pid). */
export function ownClosure(rows: CodexProcess[], roots: Iterable<number>): Set<number> {
  const own = new Set<number>(roots);
  const kids = new Map<number, number[]>();
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid]);
  const todo = [...own];
  while (todo.length) {
    for (const k of kids.get(todo.pop()!) ?? []) {
      if (!own.has(k)) {
        own.add(k);
        todo.push(k);
      }
    }
  }
  return own;
}

export type AppServerKind = 'own' | 'vscode' | 'desktop' | 'unrelated';
export interface AppServer {
  pid: number;
  /** The start token: pid + start name one process. */
  start: string;
  kind: AppServerKind;
  /** "VS Code" / "Codex Desktop" / another editor's name; '' for own and unrelated. */
  app: string;
}

/** How many parents up the check looks: the extension host starts the server itself (a wrapper at most); a terminal's is further up. */
const ANCESTOR_DEPTH = 4;
const SHELL_RE = /^(cmd|powershell|pwsh|conhost|openconsole|windowsterminal|wt|wsl|wslhost|bash|zsh|sh|dash|fish|tmux|screen|sshd|login)$/;
/** VS Code-family editors; their Codex extension runs `codex app-server` below the extension host. */
const EDITOR_NAMES: Record<string, string> = {
  'code': 'VS Code',
  'code - insiders': 'VS Code',
  'code-insiders': 'VS Code',
  'codium': 'VS Code',
  'vscodium': 'VS Code',
  'cursor': 'Cursor',
  'windsurf': 'Windsurf',
};
const DESKTOP_NAMES = new Set(['chatgpt', 'codex desktop', 'codex-desktop']);
/** The OpenAI extension's folder in an editor's extensions folder: it starts its bundled `codex app-server` (Windows and Linux paths). */
const EXTENSION_RE = /[\\/]extensions[\\/]openai\.(chatgpt|codex)[-\w.]*[\\/]/i;
/** A Remote-WSL / SSH editor server (Linux): the extension host is a node process below it. */
const EDITOR_SERVER_RE = /[\\/]\.(vscode|cursor|windsurf)(-server|-remote)[\w.-]*[\\/]|--type=extensionHost/i;
const DESKTOP_PATH_RE = /WindowsApps[\\/]OpenAI\.(Codex|ChatGPT)|[\\/]Codex\.app[\\/]|[\\/]OpenAI\.(Codex|ChatGPT)_/i;

function stem(name: string): string {
  return name.replaceAll('\\', '/').split('/').pop()!.toLowerCase().replace(/\.exe$/, '');
}

/** What an ancestor process is: an editor, Codex Desktop, a terminal or shell (stop looking), or nothing in particular. */
function ancestorKind(p: CodexProcess): { kind: 'vscode' | 'desktop'; app: string } | 'shell' | null {
  const name = stem(p.name);
  if (EDITOR_NAMES[name]) return { kind: 'vscode', app: EDITOR_NAMES[name] };
  if (DESKTOP_NAMES.has(name)) return { kind: 'desktop', app: 'Codex Desktop' };
  // the desktop app's main program is itself called Codex.exe (the CLI's name too): its Electron command line or install folder tells
  if (name === 'codex' && (DESKTOP_PATH_RE.test(p.cmdline) || /--type=|app\.asar/i.test(p.cmdline))) {
    return { kind: 'desktop', app: 'Codex Desktop' };
  }
  if (EDITOR_SERVER_RE.test(p.cmdline)) return { kind: 'vscode', app: 'VS Code' };
  if (SHELL_RE.test(name)) return 'shell';
  return null;
}

/**
 * Who started a `codex app-server` process: 'own' (AIB's agent, or below one), 'vscode' (an editor or its extension host above it, or
 * the extension's own folder in its command line), 'desktop' (Codex Desktop), else 'unrelated' (a terminal, a script, anything else).
 */
export function classifyAppServer(
  proc: CodexProcess,
  byPid: Map<number, CodexProcess>,
  own: Set<number>,
): { kind: AppServerKind; app: string } {
  if (own.has(proc.pid)) return { kind: 'own', app: '' };
  const seen = new Set<number>([proc.pid]);
  let at = proc;
  for (let depth = 0; depth < ANCESTOR_DEPTH; depth++) {
    const parent = byPid.get(at.ppid);
    if (!parent || seen.has(parent.pid)) break;
    if (own.has(parent.pid)) return { kind: 'own', app: '' };
    seen.add(parent.pid);
    const kind = ancestorKind(parent);
    if (kind === 'shell') break;
    if (kind) return kind;
    at = parent;
  }
  if (EXTENSION_RE.test(proc.cmdline)) return { kind: 'vscode', app: 'VS Code' };
  if (DESKTOP_PATH_RE.test(proc.cmdline)) return { kind: 'desktop', app: 'Codex Desktop' };
  return { kind: 'unrelated', app: '' };
}

/** Every `codex app-server` of the table, classified; an npm wrapper (node running codex.js) and the codex.exe it starts count once. */
export function appServers(rows: CodexProcess[], own: Set<number>): AppServer[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const out: AppServer[] = [];
  for (const r of rows) {
    if (!isAppServer(r)) continue;
    const parent = byPid.get(r.ppid);
    if (parent && isAppServer(parent)) continue;
    out.push({ pid: r.pid, start: r.start ?? '', ...classifyAppServer(r, byPid, own) });
  }
  return out;
}

/** The chat line's words for an app-server that made AIB let go. */
export function appServerLine(app: string): string {
  return `${appServerWho(app)} started: AIB let go so you can open this chat there. Open it here to take it back.`;
}

/** "VS Code's Codex", "Codex Desktop": how the chat line names the app. */
export function appServerWho(app: string): string {
  return app === 'Codex Desktop' ? app : `${app || 'Another app'}'s Codex`;
}

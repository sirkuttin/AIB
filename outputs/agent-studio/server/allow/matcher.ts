/**
 * Allow rules: the matcher. Pure and synchronous, with a time limit; anything it can't read, can't finish in time, or that hits the
 * never list asks (fail closed). `match` decides one permission request against the built-in rules and the owner's rules;
 * `ruleFor` drafts the rule the card's "Always allow" would save (or says why it can't: floor and never items are greyed out).
 */
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { isClaudeFamily, isCodexFamily } from '../agents/claude_family.ts';
import {
  batArgProblem,
  downloadAndRun,
  helperTest,
  linuxOf,
  looksDownloadAndRun,
  neverPart,
  type PartContext,
  programName,
  programProblem,
  projectScript,
  safeRead,
  scratchWrite,
  syntaxCheck,
} from './catalogue.ts';
import { checkPath, fromGitBash, type PathOps, WIN_OPS } from './paths.ts';
import type { LinuxView } from './linux.ts';
import { isWslRef, locKey, wslLocOf } from '../platform/location.ts';
import { pinHash } from './pin.ts';
import { parseBash, parsePwsh, type Part, unwrapCodexPowershell } from './shell.ts';

type Json = Record<string, unknown>;
const isDict = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

export type RuleKind = 'command' | 'edit' | 'mcp' | 'fetch';

export interface AllowRule {
  id: string;
  kind: RuleKind;
  scope: 'project' | 'global';
  /** The project folder a project rule belongs to. */
  project?: string;
  /** command: the leading words (npm test, git add). */
  words?: string[];
  /** command, runs project code: project folder -> pin hash (pin.ts). */
  pins?: Record<string, string>;
  /** edit: folder relative to the project ('' = the whole project). */
  folder?: string;
  server?: string;
  tool?: string;
  host?: string;
  label: string;
  added: number;
  from: 'card' | 'settings';
}

export const BUILTIN = {
  safeReads: { id: 'builtin:safe-reads', label: 'Safe reads' },
  syntax: { id: 'builtin:syntax', label: 'Syntax checks' },
  scratch: { id: 'builtin:scratch', label: 'Scratch folder' },
  /** Swarm: a helper chat's routine requests inside its own worktree (always on for helpers; the owner's master switch still applies). */
  helperCopy: { id: 'builtin:helper-copy', label: "In the helper's own copy" },
} as const;

export interface Builtins {
  safeReads: boolean;
  syntax: boolean;
  scratch: boolean;
}

export interface MatchContext {
  provider: string;
  /** Claude's tool name from the earlier tool_call (Bash, PowerShell, Edit, mcp__x__y), or null. */
  toolName: string | null;
  /** The session's current mode id (bypassPermissions, auto, ...), or null. */
  mode: string | null;
  /** The chat's folder (its worktree, or the project folder). */
  cwd: string;
  /** The project folder (project rules and pins are keyed by it). */
  project: string;
  scratch: string | null;
  stateDir: string | null;
  /** Time limit in ms (default 150). */
  limitMs?: number;
  /** What the agent's own settings say (agent_config.ts): its ask rules and a risky env block. */
  facts?: { askPrograms: Set<string>; askTools?: Set<string>; riskyEnv: string } | null;
  /**
   * A WSL chat (allow/linux.ts): its paths are checked with Linux rules over facts from its distro. `cwd` is then the chat's Linux
   * folder and `project` the project's `wsl://` ref (rules and pins are keyed by it).
   */
  linux?: LinuxView | null;
  /**
   * Swarm: this chat is a helper working in its own worktree (`cwd`). Its file edits there, and its test runs (the brief's `testCmd`
   * and the common runners), are answered by the built-in "helper copy" rule; nothing else changes for it.
   */
  helper?: { testCmd: string } | null;
}

const opsOf = (ctx: MatchContext): PathOps => ctx.linux ?? WIN_OPS;
/** A WSL Claude chat whose Claude settings AIB could not read in the distro (audit F9): rules don't answer, the agent's own Always stays. */
const LINUX_NO_FACTS = 'AIB could not read the Claude settings in the distro';

export type Request =
  | { kind: 'shell'; shell: 'bash' | 'pwsh'; command: string; cwd: string; escalation: string }
  | { kind: 'edit'; paths: string[] }
  | { kind: 'mcp'; server: string; tool: string }
  | { kind: 'fetch'; host: string; url: string }
  | { kind: 'special'; what: string }
  | { kind: 'unknown'; reason: string };

/** Options on these cards are the agent's own way of answering (plans, questions, Skills): its "always" stays and AIB never answers. */
const SPECIAL_TOOLS = new Set(['ExitPlanMode', 'AskUserQuestion', 'Skill', 'EnterPlanMode']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function callOf(params: unknown): Json {
  const call = isDict(params) ? params.toolCall : null;
  return isDict(call) ? call : {};
}

/** The tool name Claude Code gave this call (the request's own _meta, or the earlier tool_call's). */
export function claudeToolName(params: unknown, seen: string | null): string | null {
  const call = callOf(params);
  const meta = isDict(call._meta) ? call._meta : {};
  const claude = isDict(meta.claudeCode) ? meta.claudeCode : {};
  return isStr(claude.toolName) ? claude.toolName : seen;
}

/** What a request asks for, by provider (architect review 2.1, 1.1, 4.4). */
export function readRequest(params: unknown, ctx: MatchContext): Request {
  const call = callOf(params);
  const raw = isDict(call.rawInput) ? call.rawInput : {};
  const options = isDict(params) && Array.isArray(params.options) ? params.options : [];
  if (options.some((o) => isDict(o) && isStr(o.optionId) && o.optionId.startsWith('exit-plan'))) return { kind: 'special', what: 'plan' };
  const tool = claudeToolName(params, ctx.toolName);
  if (tool && SPECIAL_TOOLS.has(tool)) return { kind: 'special', what: tool };
  if (call.kind === 'switch_mode') return { kind: 'special', what: 'mode' };
  const locations = (Array.isArray(call.locations) ? call.locations : []).map((l) => (isDict(l) && isStr(l.path) ? l.path : '')).filter(
    Boolean,
  );
  if (isClaudeFamily(ctx.provider) || tool) {
    if (tool === 'Bash' || tool === 'PowerShell') {
      if (!isStr(raw.command)) return { kind: 'unknown', reason: 'no command' };
      if (tool === 'PowerShell' && ctx.linux) return { kind: 'unknown', reason: 'PowerShell in a WSL chat has no rules' };
      return {
        kind: 'shell',
        shell: tool === 'Bash' ? 'bash' : 'pwsh',
        command: raw.command,
        cwd: ctx.cwd,
        escalation: raw.dangerouslyDisableSandbox === true ? 'asks to leave the sandbox' : '',
      };
    }
    if (tool && EDIT_TOOLS.has(tool)) {
      const path = isStr(raw.file_path) ? raw.file_path : isStr(raw.notebook_path) ? raw.notebook_path : '';
      const paths = [...new Set([path, ...locations].filter(Boolean))];
      return paths.length ? { kind: 'edit', paths } : { kind: 'unknown', reason: 'no file path' };
    }
    if (tool === 'WebFetch' && isStr(raw.url)) return fetchOf(raw.url);
    const mcp = tool ? /^mcp__([^_].*?)__(.+)$/.exec(tool) : null;
    if (mcp) return { kind: 'mcp', server: mcp[1], tool: mcp[2] };
    return { kind: 'unknown', reason: tool ? `${tool} requests have no rules yet` : 'unknown tool' };
  }
  const invocation = isDict(raw.invocation) ? raw.invocation : raw;
  if (isStr(invocation.server) && isStr(invocation.tool)) return { kind: 'mcp', server: invocation.server, tool: invocation.tool };
  if (call.kind === 'edit' || call.kind === 'delete' || call.kind === 'move') {
    if (call.kind !== 'edit') return { kind: 'unknown', reason: `${call.kind} requests have no rules yet` };
    const changes = isDict(raw.changes) ? raw.changes : {};
    const moves: string[] = [];
    for (const change of Object.values(changes)) {
      if (!isDict(change)) return { kind: 'unknown', reason: 'unreadable change' };
      const type = String(change.type ?? change.kind ?? '');
      if (type === 'delete' || 'delete' in change) return { kind: 'unknown', reason: 'deletes files' };
      for (const key of ['move_path', 'movePath']) {
        if (change[key] !== undefined && change[key] !== null) {
          if (!isStr(change[key])) return { kind: 'unknown', reason: 'unreadable move target' };
          moves.push(change[key] as string);
        }
      }
    }
    const paths = [...new Set([...locations, ...Object.keys(changes), ...moves])];
    return paths.length ? { kind: 'edit', paths } : { kind: 'unknown', reason: 'no file path' };
  }
  if (call.kind === 'fetch' && isStr(raw.url)) return fetchOf(raw.url);
  if (isCodexFamily(ctx.provider) && call.kind === 'execute') {
    const escalation = raw.additionalPermissions !== undefined && raw.additionalPermissions !== null
      ? 'asks for more permissions'
      : isStr(raw.url) || isDict(raw.network)
      ? 'asks for network access'
      : '';
    const cwd = isStr(raw.cwd) ? raw.cwd : ctx.cwd;
    let command = '';
    if (isStr(raw.command)) command = raw.command;
    else if (Array.isArray(raw.command) && raw.command.every(isStr)) {
      const c = raw.command as string[];
      if (c.length === 3 && /^(bash|sh|zsh)$/.test(programName(c[0])) && /^-l?c$/.test(c[1])) command = c[2];
      else return { kind: 'unknown', reason: 'command list' };
    } else return { kind: 'unknown', reason: 'no command' };
    const inner = unwrapCodexPowershell(command);
    if (inner !== null && ctx.linux) return { kind: 'unknown', reason: 'PowerShell in a WSL chat has no rules' };
    if (inner !== null) return { kind: 'shell', shell: 'pwsh', command: inner, cwd, escalation };
    if (/^\s*"?[^\s"]*(powershell|pwsh|cmd)(\.exe)?"?\s/i.test(command)) return { kind: 'unknown', reason: 'a shell inside a shell' };
    // On Windows Codex runs commands through PowerShell: a string without its wrapper can't be read as bash (review H10).
    if (Deno.build.os === 'windows' && !ctx.linux && !Array.isArray(raw.command)) return { kind: 'unknown', reason: 'Codex command without its shell' };
    return { kind: 'shell', shell: 'bash', command, cwd, escalation };
  }
  return { kind: 'unknown', reason: `AIB can't read ${ctx.provider || 'this agent'}'s requests yet` };
}

function fetchOf(url: string): Request {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { kind: 'unknown', reason: 'not a web address' };
    return { kind: 'fetch', host: u.hostname.toLowerCase(), url };
  } catch {
    return { kind: 'unknown', reason: 'not a web address' };
  }
}

/**
 * A project rule's folder as beta10 saved it in a WSL chat (`<AIB's working folder>\wsl:\ubuntu\home\u\app`, audit F3) as the
 * project's ref; '' for anything else.
 */
function legacyWslRef(p: string): string {
  const m = /[\\/]wsl:[\\/]+([A-Za-z0-9._-]{1,64})((?:[\\/][^\\/]+)*)[\\/]*$/i.exec(p);
  if (!m || isWslRef(p)) return '';
  const ref = `wsl://${m[1].toLowerCase()}${m[2].replaceAll('\\', '/') || '/'}`;
  return wslLocOf(ref) ? ref : '';
}

/** The key a project rule and a pin are saved under: a WSL project's ref (never resolved against AIB's folder), else the full path. */
export function projectKey(p: string): string {
  return isWslRef(p) ? locKey(p) : resolve(p);
}

/** Two project folders are one: WSL refs exactly (Linux paths are case-sensitive), Windows paths case-folded (Studio's sweep). */
export function sameProject(a: string, b: string): boolean {
  if (isWslRef(a) || isWslRef(b)) return isWslRef(a) && isWslRef(b) && locKey(a) === locKey(b);
  return a.toLowerCase() === b.toLowerCase();
}

const sameFolder = (a: string, b: string) =>
  isWslRef(a) || isWslRef(b) ? wslSameFolder(a, b) : winSameFolder(a, b);

const wslSameFolder = (a: string, b: string) => {
  const ka = isWslRef(a) ? locKey(a) : legacyWslRef(a), kb = isWslRef(b) ? locKey(b) : legacyWslRef(b);
  return !!ka && ka === kb;
};

const winSameFolder = (a: string, b: string) =>
  (Deno.build.os === 'windows' ? (x: string) => x.toLowerCase() : (x: string) => x)(resolve(a)).replace(/[\\/]+$/, '') ===
    (Deno.build.os === 'windows' ? (x: string) => x.toLowerCase() : (x: string) => x)(resolve(b)).replace(/[\\/]+$/, '');

/** The rules that apply in this project. */
export function rulesHere(rules: AllowRule[], project: string): AllowRule[] {
  return rules.filter((r) => r.scope === 'global' || (r.project && sameFolder(r.project, project)));
}

const BYPASS = new Set(['bypassPermissions']);
// codex-acp before 2.6 called its workspace-write mode `auto`; 2.6 calls it `workspace-write` (`agent`, Auto review, is not listed)
const CODEX_SANDBOXED = new Set(['auto', 'workspace-write', 'read-only']);

export type MatchResult = { allow: true; ruleId: string; label: string; flagged: boolean } | { allow: false; reason: string };

class TooSlow extends Error {}

/** A Claude ask rule for Edit/Write, WebFetch or this MCP tool (agent_config.ts askTools), or ''. */
function toolAsked(req: Request, ctx: MatchContext): string {
  const tools = ctx.facts?.askTools;
  if (!tools || !tools.size) return '';
  if (req.kind === 'edit' && tools.has('edit')) return 'your Claude settings ask before edits';
  if (req.kind === 'fetch' && tools.has('fetch')) return 'your Claude settings ask before web fetches';
  if (req.kind === 'mcp' && (tools.has('mcp:*') || tools.has(`mcp:${req.server}`) || tools.has(`mcp:${req.server}__${req.tool}`))) {
    return 'your Claude settings ask before this tool';
  }
  return '';
}

/** One request against the rules. */
export function match(params: unknown, ctx: MatchContext, rules: AllowRule[], builtins: Builtins): MatchResult {
  const deadline = Date.now() + (ctx.limitMs ?? 150);
  try {
    return matchInner(params, ctx, rules, builtins, () => {
      if (Date.now() > deadline) throw new TooSlow();
    });
  } catch (error) {
    if (error instanceof TooSlow) return { allow: false, reason: 'took too long to check' };
    return { allow: false, reason: `could not check (${error instanceof Error ? error.name : 'error'})` };
  }
}

function partContext(ctx: MatchContext, cwd: string, shell: 'bash' | 'pwsh'): PartContext {
  return {
    cwd,
    root: ctx.cwd,
    shell,
    scratch: ctx.scratch,
    stateDir: ctx.stateDir,
    ...(ctx.linux ? { ops: ctx.linux } : {}),
    ...(ctx.helper ? { helper: true } : {}),
  };
}

function matchInner(params: unknown, ctx: MatchContext, rules: AllowRule[], builtins: Builtins, tick: () => void): MatchResult {
  if (ctx.facts?.riskyEnv) return { allow: false, reason: `rules are off for this chat: ${ctx.facts.riskyEnv}` };
  if (ctx.linux && isClaudeFamily(ctx.provider) && !ctx.facts) return { allow: false, reason: LINUX_NO_FACTS };
  const ops = opsOf(ctx);
  const req = readRequest(params, ctx);
  const here = rulesHere(rules, ctx.project);
  const flagged = isClaudeFamily(ctx.provider) && BYPASS.has(ctx.mode ?? '');
  if (req.kind === 'special' || req.kind === 'unknown') {
    return { allow: false, reason: req.kind === 'special' ? 'answered by you' : req.reason };
  }
  const askedTool = toolAsked(req, ctx);
  if (askedTool) return { allow: false, reason: askedTool };
  if (req.kind === 'mcp') {
    if (flagged) return { allow: false, reason: 'Claude flagged it in bypass mode' };
    const r = here.find((x) => x.kind === 'mcp' && x.server === req.server && x.tool === req.tool);
    return r ? { allow: true, ruleId: r.id, label: r.label, flagged } : { allow: false, reason: 'no rule' };
  }
  if (req.kind === 'fetch') {
    if (flagged) return { allow: false, reason: 'Claude flagged it in bypass mode' };
    const r = here.find((x) => x.kind === 'fetch' && x.host === req.host);
    return r ? { allow: true, ruleId: r.id, label: r.label, flagged } : { allow: false, reason: 'no rule' };
  }
  if (req.kind === 'edit') {
    if (flagged) return { allow: false, reason: 'Claude flagged it in bypass mode' };
    // a helper's edit inside its own worktree (never .git, hooks, .claude, .codex: checkPath's protected names)
    if (ctx.helper && req.paths.every((p) => checkPath(p, ctx.cwd, ctx.cwd, { write: true }, ops).ok)) {
      return { allow: true, ruleId: BUILTIN.helperCopy.id, label: BUILTIN.helperCopy.label, flagged };
    }
    for (const r of here.filter((x) => x.kind === 'edit')) {
      const folder = ctx.linux ? ctx.linux.folderIn(ctx.cwd, r.folder ?? '') : resolve(ctx.cwd, r.folder ?? '');
      const ok = req.paths.every((p) => {
        const v = checkPath(p, ctx.cwd, ctx.cwd, { write: true }, ops);
        const real = ops.realish(folder, ctx.cwd) ?? (ctx.linux ? null : folder); // a WSL chat: an unknown folder never matches
        return v.ok && real !== null && ops.inside(v.real, real);
      });
      tick();
      if (ok) return { allow: true, ruleId: r.id, label: r.label, flagged };
    }
    return { allow: false, reason: 'no rule' };
  }
  // shell
  if (req.escalation) return { allow: false, reason: req.escalation };
  const cwdOk = checkPath(req.cwd, ctx.cwd, ctx.cwd, {}, ops);
  if (!cwdOk.ok) return { allow: false, reason: 'runs outside the chat folder' };
  const parsed = req.shell === 'bash' ? parseBash(req.command) : parsePwsh(req.command);
  if (!parsed.ok) return { allow: false, reason: parsed.reason };
  if (downloadAndRun(parsed.parts, req.shell)) return { allow: false, reason: 'download-and-run' };
  if (parsed.parts.some((p) => /^(cd|pushd|popd|set-location|sl|chdir)$/i.test(programName(p.words[0])))) {
    return { allow: false, reason: 'changes folder' };
  }
  const pctx = partContext(ctx, cwdOk.real, req.shell);
  const codexSandboxed = isCodexFamily(ctx.provider) && CODEX_SANDBOXED.has(ctx.mode ?? '');
  const used: { id: string; label: string }[] = [];
  for (const part of parsed.parts) {
    tick();
    const hit = matchPart(part, pctx, ctx, here, builtins, { flagged, codexSandboxed }, tick);
    if (!hit) return { allow: false, reason: `"${part.words.join(' ').slice(0, 80)}" has no rule` };
    if (!used.some((u) => u.id === hit.id)) used.push(hit);
  }
  const main = used.find((u) => u.id !== BUILTIN.safeReads.id) ?? used[0];
  return { allow: true, ruleId: main.id, label: used.map((u) => u.label).join(' + '), flagged };
}

function matchPart(
  part: Part,
  pctx: PartContext,
  ctx: MatchContext,
  rules: AllowRule[],
  builtins: Builtins,
  mode: { flagged: boolean; codexSandboxed: boolean },
  tick: () => void,
): { id: string; label: string } | null {
  const asked = ctx.facts?.askPrograms;
  if (asked && (asked.has('*') || asked.has(programName(part.words[0])))) return null; // the agent's own ask rule names it (review 4.2)
  if (ctx.helper && !mode.flagged && !helperTest(part, pctx, ctx.helper.testCmd)) return BUILTIN.helperCopy; // a helper's own test run
  if (builtins.scratch && !mode.codexSandboxed && !scratchWrite(part, pctx)) return BUILTIN.scratch;
  if (builtins.syntax && !mode.codexSandboxed && !syntaxCheck(part, pctx)) return BUILTIN.syntax;
  if (mode.flagged) return null; // bypass: only Scratch and Syntax checks may answer what Claude flagged
  const never = neverPart(part, pctx);
  if (never) return null;
  tick();
  if (builtins.safeReads && !safeRead(part, pctx)) return BUILTIN.safeReads;
  if (mode.codexSandboxed) return null; // Codex asks here to run outside its sandbox: Safe reads only
  for (const r of rules) {
    if (r.kind !== 'command' || !r.words?.length) continue;
    if (commandRuleProblem(r, part, pctx, ctx) === '') return { id: r.id, label: r.label };
    tick();
  }
  return null;
}

const RISKY_FLAG =
  /shell|node-options|prefix|require|import|loader|exec|config|registry|userconfig|globalconfig|cwd|dir|pack|extcmd|template|tool|hook|script|plugin|preload|eval|pre|program|command|cmd|editor|pager|basetemp|use-|^-x$/i;

/** '' when a command rule covers this part. */
export function commandRuleProblem(r: AllowRule, part: Part, pctx: PartContext, ctx: MatchContext): string {
  const words = r.words ?? [];
  if (part.words.length < words.length) return 'shorter';
  if (programName(part.words[0]) !== programName(words[0])) return 'other program';
  for (let i = 1; i < words.length; i++) if (part.words[i] !== words[i]) return 'other subcommand';
  if (part.globs.slice(0, words.length).some(Boolean)) return 'glob';
  if (words.length < 2) return 'a one-word rule covers too much';
  const name = programName(words[0]);
  if (CODE_ARGS.has(name)) return `${name} runs its arguments as code`;
  const program = programProblem(part.words[0], pctx) || batArgProblem(part.words[0], part.words.slice(1), !!linuxOf(pctx));
  if (program) return program;
  const lx = linuxOf(pctx);
  const script = projectScript(words);
  if (!script && (PACKAGE_MANAGERS.has(name) || name === 'git' || name === 'deno')) return 'only project scripts';
  if (script) {
    const key = projectKey(ctx.project);
    const pin = Object.entries(r.pins ?? {}).find(([k]) => sameFolder(k, key))?.[1];
    if (!pin || pin !== (lx ? lx.pin(words, pctx.cwd) : pinHash(words, pctx.cwd))) return 'the script changed since the rule was made';
  }
  let afterDashDash = false;
  for (let i = words.length; i < part.words.length; i++) {
    const a = part.words[i];
    if (a === '--') {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && a.startsWith('-')) {
      // the flag's name and any value joined to it (--x=v, -X:v, -Xv): risky names ask, a value that looks like a path is checked
      const m = /^(--?[A-Za-z][\w-]*)(?:[=:](.*))?$/s.exec(a);
      if (!m) return `flag ${a}`;
      if (RISKY_FLAG.test(m[1])) return `flag ${m[1]}`;
      const value = m[2] ?? (/^-[A-Za-z]./.test(a) && !a.startsWith('--') ? a.slice(2) : '');
      // a value that could name a folder or file is path-checked, `.` and `..` included (re-review R2)
      if (value && (/[\\/:~]/.test(value) || /^\.{1,2}$/.test(value) || /(^|[\\/])\.\.([\\/]|$)/.test(value))) {
        const v = checkPath(value, pctx.cwd, pctx.root, {}, pctx.ops);
        if (!v.ok) return `${a}: ${v.reason}`;
      }
      // a rule that isn't a known project script: a joined value (--x=v, -X:v) may only be a number or an existing path, never a
      // command name (re-review R1: rg --pre=calc, sort --compress-program=calc)
      if (m[2] !== undefined && !script && !/^\d+$/.test(m[2]) && !existingPath(m[2], pctx.cwd, lx)) return `flag ${a}`;
      if ((MESSAGE_FLAGS[words.join(' ')] ?? []).includes(m[1]) && m[2] === undefined && i + 1 < part.words.length) i++; // its text
      continue;
    }
    if (!looksLikePath(a, pctx.cwd, lx)) return `"${a}" is not a file in the project`;
    const v = checkPath(a, pctx.cwd, pctx.root, { glob: part.globs[i] }, pctx.ops);
    if (!v.ok) return v.reason;
  }
  return '';
}

/** Programs that run their arguments as code: never an owner rule (review H3). */
const CODE_ARGS = new Set([
  'sed',
  'awk',
  'gawk',
  'find',
  'make',
  'xargs',
  'docker',
  'podman',
  'gh',
  'kubectl',
  'helm',
  'ssh',
  'vim',
  'vi',
  'nvim',
  'emacs',
  'less',
  'more',
  'man',
  'tar',
  'zip',
  'unzip',
  'rsync',
  'git-lfs',
  'npx',
  'perl',
  'ruby',
  'node',
  'python',
  'python3',
  'deno',
  'bun',
  'tsx',
  'ts-node',
  'cmake',
  'ninja',
  'mvn',
  'gradle',
  'cargo',
  'go',
  'dotnet',
  'msbuild',
  'invoke-command',
  'foreach-object',
  'where-object',
  'start-job',
  'new-object',
  'add-type',
  'invoke-item',
  'set-alias',
  'new-alias',
]);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** Flags whose next word is free text, per rule (git commit -m "message"). */
const MESSAGE_FLAGS: Record<string, string[]> = { 'git commit': ['-m', '--message'] };

function existingPath(word: string, cwd: string, lx: LinuxView | null = null): boolean {
  if (!word) return false;
  if (lx) return lx.stat(word, cwd)?.exists === true;
  try {
    Deno.statSync(resolve(cwd, fromGitBash(word)));
    return true;
  } catch {
    return false;
  }
}

/** A word counts as a path only when it exists, or its folder exists and it looks like a file name (review H3). */
function looksLikePath(word: string, cwd: string, lx: LinuxView | null = null): boolean {
  if (lx) {
    const st = lx.stat(word, cwd);
    if (st?.exists) return true;
    if (!st || !/^[^\s]*\.[A-Za-z0-9]{1,8}$/.test(word.replace(/\/+$/, ''))) return false;
    const abs = lx.abs(word, cwd).replace(/\/+$/, '');
    const parent = abs.slice(0, abs.lastIndexOf('/')) || '/';
    return lx.stat(parent, cwd)?.isDir === true;
  }
  const full = resolve(cwd, fromGitBash(word));
  try {
    Deno.statSync(full);
    return true;
  } catch { /* not there */ }
  if (!/^[^\s]*\.[A-Za-z0-9]{1,8}$/.test(word.replace(/[\\/]+$/, ''))) return false;
  try {
    return Deno.statSync(resolve(full, '..')).isDirectory;
  } catch {
    return false;
  }
}

// ---- drafting the rule an "Always allow" saves --------------------------------------------------------------------------------

export interface Draft {
  /** The card shows AIB's Always choice (false only on plan, question and Skill cards: the agent's own options stay). */
  offer: boolean;
  /** Hide the agent's own allow_always option (decision 2a: shell, edit, MCP and fetch cards). */
  hideAgentAlways: boolean;
  available: boolean;
  /** Why not (greyed out), owner-facing. */
  reason: string;
  floor: boolean;
  rules: Omit<AllowRule, 'id' | 'added' | 'from'>[];
  preview: string;
}

const projectName = (p: string) => {
  const wsl = isWslRef(p) ? wslLocOf(p) : null;
  if (wsl) return wsl.linuxPath.split('/').filter(Boolean).pop() || p;
  return basename(resolve(p)) || p;
};

/** What "Always allow" would save for this request in this scope. */
export function ruleFor(params: unknown, ctx: MatchContext, scope: 'project' | 'global', builtins: Builtins): Draft {
  const no = (reason: string, floor = false, hide = true): Draft => ({
    offer: true,
    hideAgentAlways: hide,
    available: false,
    reason,
    floor,
    rules: [],
    preview: '',
  });
  let req: Request;
  try {
    req = readRequest(params, ctx);
  } catch {
    return no("AIB can't read this request.", true, false);
  }
  const where = scope === 'project' ? `in ${projectName(ctx.project)}` : 'everywhere';
  const base = { scope, ...(scope === 'project' ? { project: projectKey(ctx.project) } : {}) } as const;
  if (req.kind === 'special') return { ...no(''), offer: false, hideAgentAlways: false };
  // a WSL chat whose distro facts AIB could not read: AIB can't match, so the agent's own Always stays (audit F1, F9)
  if (ctx.linux && isClaudeFamily(ctx.provider) && !ctx.facts) return no(`Not available: ${LINUX_NO_FACTS}.`, false, false);
  const ops = opsOf(ctx);
  if (ctx.facts?.riskyEnv) return no(`Not available: allow rules are off for this chat because ${ctx.facts.riskyEnv}.`);
  const askedTool = toolAsked(req, ctx);
  if (askedTool) return no(`Not available: ${askedTool}.`);
  if (req.kind === 'unknown') {
    // Decision 2a hides the agent's own always on command, file-edit, MCP and fetch cards, even when AIB can't read them yet.
    const call = callOf(params);
    const tool = claudeToolName(params, ctx.toolName) ?? '';
    const hide = ['execute', 'edit', 'delete', 'move', 'fetch'].includes(String(call.kind)) ||
      /^(Bash|PowerShell|WebFetch|Edit|Write|MultiEdit|NotebookEdit|mcp__)/.test(tool);
    return no(`Not available: ${req.reason}.`, false, hide);
  }
  const flagged = isClaudeFamily(ctx.provider) && BYPASS.has(ctx.mode ?? '');
  if (flagged) return no('Not available: Claude flagged this request in bypass mode; your rules never answer those.');
  if (req.kind === 'mcp') {
    const label = `${req.server} · ${req.tool}`;
    return {
      offer: true,
      hideAgentAlways: true,
      available: true,
      reason: '',
      floor: false,
      rules: [{ ...base, kind: 'mcp', server: req.server, tool: req.tool, label }],
      preview: `Rule: MCP server ${req.server}, tool ${req.tool}, any input, ${where}.`,
    };
  }
  if (req.kind === 'fetch') {
    return {
      offer: true,
      hideAgentAlways: true,
      available: true,
      reason: '',
      floor: false,
      rules: [{ ...base, kind: 'fetch', host: req.host, label: `Web fetch · ${req.host}` }],
      preview: `Rule: web fetches from ${req.host}, ${where}.`,
    };
  }
  if (req.kind === 'edit') {
    const rels: string[] = [];
    for (const p of req.paths) {
      const v = checkPath(p, ctx.cwd, ctx.cwd, { write: true }, ops);
      if (!v.ok) return no(`Not available: AIB never auto-allows ${v.outside ? 'files outside the project' : v.reason}.`, false);
      const root = ops.realish(ctx.cwd, ctx.cwd) ?? ctx.cwd;
      rels.push(ctx.linux ? ctx.linux.relative(root, v.real) : relative(root, v.real));
    }
    const dirs = rels.map((r) => r.split(/[\\/]/).slice(0, -1));
    let common = dirs[0] ?? [];
    for (const d of dirs) {
      let n = 0;
      while (n < common.length && d[n] === common[n]) n++;
      common = common.slice(0, n);
    }
    const folder = common.join('/');
    const label = folder ? `Edits in ${folder}/` : 'Edits anywhere in the project';
    return {
      offer: true,
      hideAgentAlways: true,
      available: true,
      reason: '',
      floor: false,
      rules: [{ ...base, kind: 'edit', folder, label }],
      preview: `Rule: edits to files in ${folder ? folder + '/' : 'the project'} ${where} (never .git, .claude or hooks).`,
    };
  }
  if (req.escalation) return no(`Not available: AIB never auto-allows requests that ${req.escalation}.`, true);
  if (isCodexFamily(ctx.provider) && CODEX_SANDBOXED.has(ctx.mode ?? '')) {
    return no('Not available: in this mode Codex asks only to run outside its sandbox; AIB allows only Safe reads for it.');
  }
  const parsed = req.shell === 'bash' ? parseBash(req.command) : parsePwsh(req.command);
  if (!parsed.ok) {
    if (looksDownloadAndRun(req.command)) {
      return no('Not available: AIB never auto-allows running code downloaded from the internet.', true);
    }
    return no(`Not available: AIB can't read this command safely (${parsed.reason}).`, true);
  }
  if (downloadAndRun(parsed.parts, req.shell)) {
    return no('Not available: AIB never auto-allows running code downloaded from the internet.', true);
  }
  const cwdOk = checkPath(req.cwd, ctx.cwd, ctx.cwd, {}, ops);
  if (!cwdOk.ok) return no('Not available: the command runs outside the chat folder.', true);
  const pctx = partContext(ctx, cwdOk.real, req.shell);
  const rules: Draft['rules'] = [];
  const previews: string[] = [];
  for (const part of parsed.parts) {
    const asked = ctx.facts?.askPrograms;
    if (asked && (asked.has('*') || asked.has(programName(part.words[0])))) {
      return no(
        `Not available: your Claude settings say to always ask before ${asked.has('*') ? 'shell commands' : programName(part.words[0])}.`,
      );
    }
    if (builtins.scratch && !scratchWrite(part, pctx)) continue;
    if (builtins.syntax && !syntaxCheck(part, pctx)) continue;
    const never = neverPart(part, pctx);
    if (never) return no(`Not available: AIB never auto-allows ${never.reason}.`, never.floor);
    if (builtins.safeReads && !safeRead(part, pctx)) continue;
    if (/^(cd|pushd|popd|set-location|sl|chdir)$/i.test(programName(part.words[0]))) {
      return no('Not available: the command changes folder.');
    }
    const program = programName(part.words[0]);
    if (CODE_ARGS.has(program)) return no(`Not available: ${program} can run its arguments as code.`);
    const script = projectScript(part.words);
    const second = part.words[1];
    if (!script && PACKAGE_MANAGERS.has(program)) {
      return no(`Not available: only ${program} test and ${program} run <script> can become rules.`);
    }
    if (!script && (program === 'git' || program === 'deno')) return no(`Not available: this ${program} command can't become a rule.`);
    // Never a one-word rule (review H1): the second word must be a plain subcommand, not a flag or a path.
    if (!script && !(second && /^[a-z][a-z0-9-]*$/.test(second))) {
      return no('Not available: a rule needs a subcommand, and this command has none (it would allow every use of the program).');
    }
    const words = script ?? [program, second];
    if (rules.some((r) => JSON.stringify(r.words) === JSON.stringify(words))) continue;
    const pin = script ? (ctx.linux ? ctx.linux.pin(words, pctx.cwd) : pinHash(words, pctx.cwd)) : null;
    if (script && pin === null) return no('Not available: AIB could not read the project script in the distro.', false, false);
    const label = `${words.join(' ')}${script ? '' : ' + paths, flags'}`;
    rules.push({
      ...base,
      kind: 'command',
      words,
      label,
      ...(script ? { pins: { [projectKey(ctx.project)]: pin! } } : {}),
    });
    previews.push(
      script
        ? `${
          words.join(' ')
        } + file paths and flags inside the project (runs project code; asks again if the script, its pre/post scripts, .npmrc, .yarnrc.yml, the deno.json task or git hooks change)`
        : `${words.join(' ')} + file paths and flags inside the project`,
    );
    if (rules.length > 3) return no('Not available: too many different commands in one request.');
  }
  if (!rules.length) return no('Already covered by the built-in rules.', false);
  return {
    offer: true,
    hideAgentAlways: true,
    available: true,
    reason: '',
    floor: false,
    rules,
    preview: `Rule: ${previews.join('; ')}, ${where}.`,
  };
}

/** True when the path is absolute (tests). */
export const absolute = isAbsolute;

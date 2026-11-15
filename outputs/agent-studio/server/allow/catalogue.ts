/**
 * Allow rules: what each program may do. Built-in rules use per-program flag allowlists (Codex is_safe_command style: an unknown
 * flag asks, architect review 2.2). The never list (rules never cover these) and the floor (always the owner, never a rule and
 * later never the main agent) are read from AIB's own parse, never from the agent's words.
 */
import { checkPath, fromGitBash, inside, looksSecret, pathFormProblem, realish } from './paths.ts';
import type { Part } from './shell.ts';

export interface PartContext {
  cwd: string;
  /** The chat's folder (worktree or project folder): reads and project rules stay inside it. */
  root: string;
  shell: 'bash' | 'pwsh';
  /** This chat's scratch folder (outside the worktree), or null. */
  scratch: string | null;
  /** AIB's state folder: never touched by a rule. */
  stateDir: string | null;
}

/** The program a word names: base name, lower case, without .exe/.cmd/.bat/.ps1. */
export function programName(word: string): string {
  const base = word.replaceAll('\\', '/').split('/').pop() ?? '';
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '');
}

// ---- program resolution ------------------------------------------------------------------------------------------------------

const resolved = new Map<string, string | null>();

/** The full path AIB's PATH gives a program (cached), or null when it isn't on PATH. */
export function resolveProgram(name: string): string | null {
  if (resolved.has(name)) return resolved.get(name)!;
  let found: string | null = null;
  // Network folders on PATH are skipped: a stat there can block well past the matcher's time limit (review H12). A program found
  // only there counts as not found. Path arguments are checked by form first (UNC asks before any stat); a slow mapped drive letter
  // can still block one stat; the time limit is checked between steps, so such a request may take longer, then asks.
  const dirs = (Deno.env.get('PATH') ?? '').split(Deno.build.os === 'windows' ? ';' : ':')
    .filter((d) => d && !d.startsWith('\\\\') && !d.startsWith('//'));
  const exts = Deno.build.os === 'windows' ? ['.exe', '.cmd', '.bat', '.com', ''] : [''];
  outer: for (const dir of dirs) {
    for (const ext of exts) {
      const full = `${dir.replace(/[\\/]+$/, '')}${Deno.build.os === 'windows' ? '\\' : '/'}${name}${ext}`;
      try {
        if (Deno.statSync(full).isFile) {
          found = full;
          break outer;
        }
      } catch { /* not here */ }
    }
  }
  resolved.set(name, found);
  return found;
}

/** Why the program word itself can't be trusted ('' when fine): a path, inside the worktree, or the Store python stub. */
export function programProblem(word: string, ctx: PartContext): string {
  if (/[\\/]/.test(word) || word.startsWith('.')) return 'program given by path';
  if (ctx.shell === 'pwsh' && /^[A-Za-z]+-[A-Za-z]+$/.test(word)) return ''; // a cmdlet name
  const full = resolveProgram(word);
  if (!full) return '';
  const real = realish(full, ctx.cwd);
  if (!real || inside(real, ctx.root)) return 'program inside the project';
  if (/\\windowsapps\\/i.test(real) && /^python/i.test(word)) return 'the Windows Store python stub';
  return '';
}

/** .cmd/.bat shims: cmd.exe re-parses the arguments (BatBadBut). */
export function batArgProblem(word: string, args: string[]): string {
  const full = resolveProgram(word);
  if (!full || !/\.(cmd|bat)$/i.test(full)) return '';
  return args.some((a) => /[&|<>^%!"]/.test(a)) ? 'special characters passed to a .cmd program' : '';
}

// ---- flag allowlists ---------------------------------------------------------------------------------------------------------

interface Spec {
  /** Flags without a value (exact; short ones may combine when listed in `letters`). */
  flags?: string[];
  /** Short flag letters that combine (-alh). */
  letters?: string;
  /** Flags that take a value (next word, or --flag=value). */
  valued?: string[];
  /** A flag form matched by pattern (-20 for head). */
  pattern?: RegExp;
  /** What the other words are. */
  args: 'paths' | 'any' | 'none' | 'pattern+paths';
  maxPaths?: number;
}

const SAFE: Record<string, Spec> = {
  ls: { letters: 'alhRrtS1dFAGip', flags: ['--color', '--color=auto', '--color=never', '--all', '--human-readable'], args: 'paths' },
  dir: { letters: 'alhRrtS1dFA', args: 'paths' },
  pwd: { args: 'none' },
  cat: { letters: 'nAbsvET', args: 'paths' },
  head: { valued: ['-n', '-c'], pattern: /^-\d+$/, args: 'paths' },
  tail: { valued: ['-n', '-c'], pattern: /^-\d+$/, args: 'paths' },
  wc: { letters: 'lwcm', args: 'paths' },
  stat: { valued: ['-c'], args: 'paths' },
  file: { letters: 'bi', args: 'paths' },
  du: { letters: 'shac', valued: ['-d', '--max-depth'], args: 'paths' },
  which: { letters: 'a', args: 'any' },
  where: { args: 'any' },
  echo: { letters: 'neE', args: 'any' },
  printf: { args: 'any' },
  grep: {
    letters: 'rniIlLcvwxEFohHsqZ',
    valued: ['-A', '-B', '-C', '-m', '-e', '--include', '--exclude', '--exclude-dir', '--color'],
    flags: ['--color', '--line-number', '--recursive', '--ignore-case', '--files-with-matches', '--count', '--fixed-strings', '-P'],
    args: 'pattern+paths',
  },
  rg: {
    letters: 'niIlcwFSuHoUvx',
    valued: ['-g', '--glob', '-t', '--type', '-T', '--type-not', '-A', '-B', '-C', '-m', '-e', '--max-depth', '--color'],
    flags: [
      '--hidden',
      '--no-ignore',
      '--files',
      '--json',
      '--line-number',
      '--no-heading',
      '--heading',
      '--count',
      '--fixed-strings',
      '--smart-case',
      '--ignore-case',
      '--files-with-matches',
    ],
    args: 'pattern+paths',
  },
  sort: { letters: 'nrufhVb', valued: ['-k', '-t'], args: 'paths' },
  uniq: { letters: 'cdui', args: 'paths', maxPaths: 1 },
  cut: { valued: ['-d', '-f', '-c'], args: 'paths' },
  diff: { letters: 'urqNwbBi', flags: ['--stat', '--brief'], valued: ['-U'], args: 'paths', maxPaths: 2 },
  cmp: { letters: 's', args: 'paths', maxPaths: 2 },
  jq: { letters: 'rcSesj', valued: ['--arg', '--argjson', '--indent'], args: 'pattern+paths' },
};

const GIT_SAFE: Record<string, Spec> = {
  status: {
    letters: 'sbu',
    flags: [
      '--short',
      '--branch',
      '--porcelain',
      '--porcelain=v1',
      '--porcelain=v2',
      '--untracked-files=no',
      '--untracked-files=all',
      '--ignored',
    ],
    args: 'paths',
  },
  diff: {
    letters: 'wRb',
    flags: [
      '--stat',
      '--name-only',
      '--name-status',
      '--cached',
      '--staged',
      '--numstat',
      '--shortstat',
      '--no-color',
      '--color',
      '--word-diff',
      '--check',
      '--summary',
      '--',
    ],
    pattern: /^-U\d+$|^--unified=\d+$|^--stat=\d+$/,
    args: 'any',
  },
  log: {
    letters: 'p',
    flags: [
      '--oneline',
      '--stat',
      '--graph',
      '--decorate',
      '--all',
      '--name-only',
      '--name-status',
      '--no-merges',
      '--first-parent',
      '--reverse',
      '--no-color',
      '--',
    ],
    valued: ['-n', '--format', '--pretty', '--author', '--since', '--until', '--grep', '--max-count', '--date'],
    pattern: /^-\d+$/,
    args: 'any',
  },
  show: {
    flags: ['--stat', '--name-only', '--name-status', '--oneline', '--no-color', '--'],
    valued: ['--format', '--pretty'],
    args: 'any',
  },
  blame: { valued: ['-L'], letters: 'w', args: 'any' },
  'ls-files': { letters: 'modcs', flags: ['--others', '--exclude-standard', '--cached', '--modified', '--deleted', '--'], args: 'paths' },
  'rev-parse': {
    flags: [
      '--show-toplevel',
      '--abbrev-ref',
      '--git-dir',
      '--short',
      '--verify',
      '--is-inside-work-tree',
      '--show-prefix',
      '--git-common-dir',
    ],
    args: 'any',
  },
  remote: { flags: ['-v'], args: 'none' },
  branch: {
    letters: 'arv',
    flags: ['--list', '--show-current', '-vv', '--all', '--remotes', '--merged', '--no-merged', '--contains'],
    args: 'none',
  },
  grep: {
    letters: 'niIlLcvwEFhH',
    valued: ['-e', '-A', '-B', '-C', '-m'],
    flags: ['--cached', '--line-number', '--untracked', '--'],
    args: 'pattern+paths',
  },
};

const PWSH_ALIASES: Record<string, string> = {
  ls: 'get-childitem',
  dir: 'get-childitem',
  gci: 'get-childitem',
  cat: 'get-content',
  gc: 'get-content',
  type: 'get-content',
  gi: 'get-item',
  sls: 'select-string',
  select: 'select-object',
  measure: 'measure-object',
  sort: 'sort-object',
  pwd: 'get-location',
  gl: 'get-location',
  rvpa: 'resolve-path',
};

interface PwshSpec {
  switches: string[];
  valued: string[];
  /** Which valued parameters hold a path. */
  pathParams: string[];
  positional: 'paths' | 'pattern+paths' | 'names' | 'none';
}

const PWSH_SAFE: Record<string, PwshSpec> = {
  'get-childitem': {
    switches: ['recurse', 'name', 'file', 'directory', 'force'],
    valued: ['path', 'literalpath', 'filter', 'depth', 'include', 'exclude'],
    pathParams: ['path', 'literalpath'],
    positional: 'paths',
  },
  'get-content': {
    switches: ['raw'],
    valued: ['path', 'literalpath', 'totalcount', 'tail', 'head', 'first', 'encoding'],
    pathParams: ['path', 'literalpath'],
    positional: 'paths',
  },
  'get-item': { switches: ['force'], valued: ['path', 'literalpath'], pathParams: ['path', 'literalpath'], positional: 'paths' },
  'test-path': { switches: [], valued: ['path', 'literalpath', 'pathtype'], pathParams: ['path', 'literalpath'], positional: 'paths' },
  'resolve-path': { switches: ['relative'], valued: ['path', 'literalpath'], pathParams: ['path', 'literalpath'], positional: 'paths' },
  'select-string': {
    switches: ['simplematch', 'casesensitive', 'list', 'notmatch', 'allmatches', 'quiet'],
    valued: ['pattern', 'path', 'literalpath', 'context', 'include', 'exclude', 'encoding'],
    pathParams: ['path', 'literalpath'],
    positional: 'pattern+paths',
  },
  'select-object': {
    switches: ['unique'],
    valued: ['first', 'last', 'skip', 'property', 'expandproperty', 'index'],
    pathParams: [],
    positional: 'names',
  },
  'measure-object': {
    switches: ['line', 'word', 'character', 'sum', 'average', 'maximum', 'minimum'],
    valued: ['property'],
    pathParams: [],
    positional: 'names',
  },
  'sort-object': { switches: ['descending', 'unique'], valued: ['property'], pathParams: [], positional: 'names' },
  'get-location': { switches: [], valued: [], pathParams: [], positional: 'none' },
};

/** The words of a part checked against a spec: '' when every flag is allowed and every path is inside the chat's folder. */
function checkSpec(spec: Spec, args: string[], globs: boolean[], ctx: PartContext): string {
  let positional: { word: string; glob: boolean }[] = [];
  let sawPattern = false;
  let afterDashDash = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!afterDashDash && a === '--' && spec.args !== 'any') {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && a.startsWith('-') && a !== '-') {
      if (spec.flags?.includes(a)) continue;
      if (spec.pattern?.test(a)) continue;
      const eq = a.indexOf('=');
      if (eq > 0 && spec.valued?.includes(a.slice(0, eq))) {
        if (a.slice(0, eq) === '-e') sawPattern = true;
        continue;
      }
      if (spec.valued?.includes(a)) {
        if (i + 1 >= args.length) return `${a} needs a value`;
        if (a === '-e') sawPattern = true;
        i++;
        continue;
      }
      // -n5 style for valued short flags
      const short = a.slice(0, 2);
      if (/^-[A-Za-z]$/.test(short) && spec.valued?.includes(short) && a.length > 2) continue;
      if (/^-[A-Za-z]+$/.test(a) && spec.letters && [...a.slice(1)].every((ch) => spec.letters!.includes(ch))) continue;
      return `flag ${a} is not on the list`;
    }
    positional.push({ word: a, glob: globs[i] ?? false });
  }
  if (spec.args === 'none' && positional.length) return 'unexpected argument';
  if (spec.args === 'any') {
    for (const p of positional) {
      if (p.word.startsWith('\\\\') || p.word.startsWith('//')) return 'network path';
      if (p.glob) return 'glob';
    }
    return '';
  }
  if (spec.args === 'pattern+paths' && !sawPattern) positional = positional.slice(1);
  if (spec.maxPaths !== undefined && positional.length > spec.maxPaths) return 'too many files (one may be written)';
  for (const p of positional) {
    const v = checkPath(p.word, ctx.cwd, ctx.root, { glob: p.glob });
    if (!v.ok) return `${p.word}: ${v.reason}`;
  }
  return '';
}

/** Safe reads: '' when this part is one, else why not. */
export function safeRead(part: Part, ctx: PartContext): string {
  const [first, ...args] = part.words;
  if (part.globs[0]) return 'glob in the program name';
  const name = programName(first);
  // PowerShell: its cmdlets and aliases, plus a few real programs whose names PowerShell doesn't alias (git, rg, jq).
  if (ctx.shell === 'pwsh' && !['git', 'rg', 'jq'].includes(name)) return safePwsh(part, ctx);
  const prob = programProblem(first, ctx);
  if (prob) return prob;
  if (name === 'git') {
    const sub = args[0];
    if (!sub || sub.startsWith('-')) return 'git options before the subcommand';
    const spec = GIT_SAFE[sub];
    if (!spec) return `git ${sub} is not a safe read`;
    if (sub === 'remote' && args[1] !== '-v') return 'git remote changes remotes';
    return checkSpec(spec, args.slice(1), part.globs.slice(2), ctx);
  }
  if (name === 'find') return safeFind(args, part.globs.slice(1), ctx);
  if (name === 'sed') {
    if (args[0] !== '-n' || !/^\d+(,\d+)?p$/.test(args[1] ?? '')) return "sed only as sed -n 'N,Mp'";
    return checkSpec({ args: 'paths' }, args.slice(2), part.globs.slice(3), ctx);
  }
  const spec = SAFE[name];
  if (!spec) return `${name} is not a safe read`;
  if (name === 'jq' && args.some((a) => /env|\$__|input_filename|import|include|getpath|\$ENV|halt|debug|stderr|input/i.test(a))) {
    return 'jq filter that reads the environment or other files';
  }
  const bat = batArgProblem(first, args);
  if (bat) return bat;
  return checkSpec(spec, args, part.globs.slice(1), ctx);
}

const FIND_TESTS = new Set(['-name', '-iname', '-path', '-ipath', '-type', '-maxdepth', '-mindepth', '-newer', '-size']);
const FIND_BARE = new Set(['-print', '-not', '!', '-o', '-a', '-empty', '-or', '-and']);

function safeFind(args: string[], globs: boolean[], ctx: PartContext): string {
  let i = 0;
  for (; i < args.length && !args[i].startsWith('-') && args[i] !== '!'; i++) {
    const v = checkPath(args[i], ctx.cwd, ctx.root, { glob: globs[i] });
    if (!v.ok) return `${args[i]}: ${v.reason}`;
  }
  for (; i < args.length; i++) {
    const a = args[i];
    if (FIND_BARE.has(a)) continue;
    if (FIND_TESTS.has(a)) {
      if (i + 1 >= args.length) return `${a} needs a value`;
      if (a === '-newer') {
        const v = checkPath(args[i + 1], ctx.cwd, ctx.root);
        if (!v.ok) return v.reason;
      }
      i++;
      continue;
    }
    return `find ${a} is not on the list`;
  }
  return '';
}

function safePwsh(part: Part, ctx: PartContext): string {
  const [first, ...args] = part.words;
  const name = PWSH_ALIASES[first.toLowerCase()] ?? first.toLowerCase();
  const spec = PWSH_SAFE[name];
  if (!spec) return `${first} is not a safe read`;
  const positional: { word: string; glob: boolean }[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      const p = a.slice(1).toLowerCase().replace(/:$/, '');
      if (spec.switches.includes(p)) continue;
      if (spec.valued.includes(p)) {
        if (i + 1 >= args.length) return `${a} needs a value`;
        const value = args[++i];
        if (spec.pathParams.includes(p)) {
          const v = checkPath(value, ctx.cwd, ctx.root, { glob: part.globs[i + 1] });
          if (!v.ok) return `${value}: ${v.reason}`;
        } else if (/[\\/]/.test(value) && pathFormProblem(value)) return `${value}: ${pathFormProblem(value)}`;
        continue;
      }
      return `parameter ${a} is not on the list`;
    }
    positional.push({ word: a, glob: part.globs[i + 1] ?? false });
  }
  if (spec.positional === 'none' && positional.length) return 'unexpected argument';
  if (spec.positional === 'names') {
    return positional.every((p) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(p.word)) ? '' : 'only property names';
  }
  const paths = spec.positional === 'pattern+paths' && !args.some((a) => /^-pattern$/i.test(a)) ? positional.slice(1) : positional;
  for (const p of paths) {
    const v = checkPath(p.word, ctx.cwd, ctx.root, { glob: p.glob });
    if (!v.ok) return `${p.word}: ${v.reason}`;
  }
  return '';
}

/** Syntax checks: node --check <file>, tsc --noEmit [-p <path>] (tsc from outside the project), python -I -m py_compile <file>. */
export function syntaxCheck(part: Part, ctx: PartContext): string {
  const [first, ...args] = part.words;
  if (part.globs.some(Boolean)) return 'glob';
  const name = programName(first);
  const prob = programProblem(first, ctx) || batArgProblem(first, args);
  if (prob) return prob;
  const file = (p: string | undefined) => {
    if (!p) return 'no file';
    const v = checkPath(p, ctx.cwd, ctx.root);
    return v.ok ? '' : `${p}: ${v.reason}`;
  };
  if (name === 'node') return args.length === 2 && (args[0] === '--check' || args[0] === '-c') ? file(args[1]) : 'only node --check <file>';
  if (name === 'tsc') {
    if (!resolveProgram('tsc')) return 'tsc is not installed outside the project';
    if (args.length === 1 && args[0] === '--noEmit') return '';
    if (args.length === 3 && args[0] === '--noEmit' && args[1] === '-p') return file(args[2]);
    return 'only tsc --noEmit [-p <path>]';
  }
  if (name === 'python' || name === 'python3' || name === 'py') {
    if (!resolveProgram(name)) return 'python is not on PATH';
    if (args.length === 4 && args[0] === '-I' && args[1] === '-m' && args[2] === 'py_compile') return file(args[3]);
    return 'only python -I -m py_compile <file>';
  }
  return 'not a syntax check';
}

/** The scratch folder rule: Git Bash rm/mkdir/touch whose every target is under the literal scratch path. */
export function scratchWrite(part: Part, ctx: PartContext): string {
  if (!ctx.scratch) return 'no scratch folder';
  if (ctx.shell !== 'bash') return 'only Git Bash rm in scratch (never PowerShell Remove-Item)';
  const [first, ...args] = part.words;
  const name = programName(first);
  if (!['rm', 'mkdir', 'touch'].includes(name)) return 'not a scratch write';
  if (programProblem(first, ctx)) return programProblem(first, ctx);
  const allowed = name === 'rm' ? /^-[rRf]+$|^--recursive$|^--force$/ : name === 'mkdir' ? /^-p$/ : /^$/;
  const targets = args.filter((a) => !(a.startsWith('-') && allowed.test(a)));
  if (!targets.length || targets.some((a) => a.startsWith('-'))) return 'unexpected flag';
  if (part.globs.some(Boolean)) return 'glob';
  const root = realish(ctx.scratch, ctx.scratch);
  if (!root) return 'no scratch folder';
  const recursive = name === 'rm' && args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive');
  for (const t of targets) {
    const p = fromGitBash(t);
    if (!/^[A-Za-z]:[\\/]|^\//.test(p)) return 'scratch paths must be absolute';
    if (pathFormProblem(t)) return pathFormProblem(t);
    const real = realish(p, ctx.cwd);
    if (!real || !inside(real, root) || real.toLowerCase().replace(/[\\/]+$/, '') === root.toLowerCase().replace(/[\\/]+$/, '')) {
      return `${t} is not inside the scratch folder`;
    }
    if (recursive && hasLinks(real)) return `${t} holds a link or junction`;
  }
  return '';
}

/** A walk of the tree for symlinks and junctions (time and size limited: too big counts as a link). */
export function hasLinks(path: string, budget = { n: 5000 }): boolean {
  let info: Deno.FileInfo;
  try {
    info = Deno.lstatSync(path);
  } catch {
    return false;
  }
  if (info.isSymlink) return true;
  if (!info.isDirectory) return false;
  try {
    for (const entry of Deno.readDirSync(path)) {
      if (--budget.n < 0) return true;
      if (entry.isSymlink) return true;
      if (entry.isDirectory && hasLinks(`${path}${Deno.build.os === 'windows' ? '\\' : '/'}${entry.name}`, budget)) return true;
    }
  } catch {
    return true;
  }
  return false;
}

// ---- never list and floor ----------------------------------------------------------------------------------------------------

export interface Never {
  floor: boolean;
  reason: string;
}

const DELETES = new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'remove-item', 'ri', 'unlink', 'shred', 'move-item', 'mv']);
const INSTALLERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'cargo', 'go', 'gem', 'composer', 'uv']);
const INSTALL_SUBS = new Set(['install', 'i', 'add', 'ci', 'uninstall', 'remove', 'rm', 'un', 'update', 'up', 'upgrade', 'link']);
const SYSTEM = new Set([
  'reg',
  'regedit',
  'netsh',
  'sc',
  'schtasks',
  'sudo',
  'runas',
  'setx',
  'bcdedit',
  'diskpart',
  'format',
  'icacls',
  'takeown',
  'shutdown',
  'winget',
  'choco',
  'scoop',
  'apt',
  'apt-get',
  'brew',
  'msiexec',
  'set-executionpolicy',
  'new-service',
  'set-service',
  'new-netfirewallrule',
  'set-netfirewallrule',
  'set-itemproperty',
  'new-itemproperty',
  'restart-computer',
  'stop-computer',
  'register-scheduledtask',
  'new-scheduledtask',
  'start-process',
  'chmod',
  'chown',
  'mount',
  'systemctl',
  'launchctl',
  'defaults',
]);
const INTERPRETERS = new Set([
  'node',
  'python',
  'python3',
  'py',
  'bash',
  'sh',
  'zsh',
  'pwsh',
  'powershell',
  'cmd',
  'deno',
  'perl',
  'ruby',
  'php',
  'lua',
  'invoke-expression',
  'iex',
  'invoke-command',
  'icm',
  'wscript',
  'cscript',
  'mshta',
  'rundll32',
  'env',
  'xargs',
  'eval',
  'exec',
  'source',
  'time',
  'nohup',
  'nice',
  'timeout',
  'watch',
  'start',
  'call',
]);
const FETCH_RUN = new Set(['npx', 'bunx', 'uvx', 'pipx', 'dlx']);
const NETWORK = new Set([
  'curl',
  'wget',
  'invoke-webrequest',
  'iwr',
  'invoke-restmethod',
  'irm',
  'ssh',
  'scp',
  'sftp',
  'ftp',
  'nc',
  'ncat',
  'telnet',
  'rsync',
  'start-bitstransfer',
  'certutil',
  'bitsadmin',
]);
/** git flags that run a program or rewrite config, matched as prefixes. */
const GIT_DANGER = /^(--upload-pack|--receive-pack|--exec|--extcmd|--config-env|--template|--tool|-x$|-c$|-c.+=|--config)/;
/** git subcommands that run programs, hooks or fetched code (review H1). */
const GIT_RUNS = new Set([
  'difftool',
  'mergetool',
  'submodule',
  'bisect',
  'filter-repo',
  'filter-branch',
  'fetch',
  'pull',
  'clone',
  'ls-remote',
  'archive',
  'daemon',
  'instaweb',
  'send-email',
  'request-pull',
  'remote-ext',
  'credential',
  'config',
  'hook',
  'am',
  'apply',
  'web--browse',
  'help',
  'p4',
  'svn',
  'cvsimport',
  'fast-import',
  'bundle',
]);
/** Package-manager subcommands that fetch or publish code. */
const PM_RUNS = new Set([
  'exec',
  'x',
  'dlx',
  'publish',
  'unpublish',
  'create',
  'init',
  'login',
  'adduser',
  'token',
  'owner',
  'access',
  'deprecate',
]);
const KILLS = new Set(['kill', 'taskkill', 'stop-process', 'spps', 'pkill', 'killall', 'tskill']);
const PROTECTED_PATH = /(^|[\\/])(\.claude|\.codex|\.gemini|\.cursor)([\\/]|$)|agentstudio|allow-rules|\.git[\\/](config|hooks)/i;

/** A part that rules never cover ('floor' ones always reach the owner). Null when rules may cover it. */
export function neverPart(part: Part, ctx: PartContext): Never | null {
  const [first, ...args] = part.words;
  const name = programName(first);
  const floor = (reason: string): Never => ({ floor: true, reason });
  const never = (reason: string): Never => ({ floor: false, reason });
  for (const a of part.words) {
    if (PROTECTED_PATH.test(a)) return floor("AIB's data folder or an agent's config");
    if (ctx.stateDir && /[\\/]/.test(a)) {
      const real = realish(a, ctx.cwd);
      if (real && inside(real, ctx.stateDir) && !inside(real, ctx.root) && !(ctx.scratch && inside(real, ctx.scratch))) {
        return floor("AIB's data folder");
      }
    }
  }
  if (SYSTEM.has(name)) return floor('system, registry, firewall and admin commands');
  if (name === 'git') {
    // Dangerous flags anywhere, as prefixes (--upload-pack=calc, --exec=..., -x on rebase): floor (review H2).
    if (args.some((a) => GIT_DANGER.test(a))) return floor('git options that run programs');
    if (args[0] !== undefined && args[0].startsWith('-')) return never('git options before the subcommand');
    const sub = args[0] ?? '';
    if (GIT_RUNS.has(sub)) return never(`git ${sub} (can run programs or fetch code)`);
    if (sub === 'push') {
      const rest = args.slice(args.indexOf('push') + 1);
      if (rest.some((a) => /^(-f|--force.*|--mirror|--delete|-d|--tags|--all|--prune)$/.test(a) || a.startsWith('+'))) {
        return floor('force-push, --mirror, --delete or --tags');
      }
      if (rest.some((a) => /(^|:|\/)(main|master|HEAD)$/.test(a) && a !== 'origin') || rest.some((a) => /^(refs\/tags\/|v\d)/.test(a))) {
        return floor('push to the default branch or a tag');
      }
      const refs = rest.filter((a) => !a.startsWith('-'));
      if (refs.length < 2) return floor('push without a named branch (may push the default branch)');
      return never('git push');
    }
    if (sub === 'clean') return never('deletes (git clean)');
    if (sub === 'branch' && args.some((a) => /^-[dD]$|^--delete$/.test(a))) return never('deletes a branch');
    if (sub === 'worktree' && args.includes('remove')) return floor("deletes a worktree in AIB's data folder");
    if (
      ['reset', 'rebase', 'checkout', 'restore', 'stash', 'filter-branch', 'update-ref', 'reflog', 'gc', 'prune'].includes(sub) &&
      (sub !== 'reset' || args.includes('--hard'))
    ) return never(`history or work rewrite (git ${sub})`);
    if (sub === 'config' || args.some((a) => a === '-c' || a.startsWith('--exec') || a === '--upload-pack')) return floor('git config');
  }
  if (DELETES.has(name)) {
    const targets = args.filter((a) => !a.startsWith('-'));
    for (const t of targets) {
      const real = pathFormProblem(t) ? null : realish(t, ctx.cwd);
      if (!real) return floor('deleting where AIB cannot resolve the path');
      if (!inside(real, ctx.root) && !(ctx.scratch && inside(real, ctx.scratch))) {
        return floor('deleting outside the project and its scratch folder');
      }
    }
    return never('deletes outside the scratch folder');
  }
  if (INSTALLERS.has(name) && args.some((a) => INSTALL_SUBS.has(a))) {
    if (args.some((a) => /^(-g|--global|--user|--system|--location=global)$/.test(a)) || name === 'go' || name === 'cargo') {
      return floor('system-wide installs');
    }
    return never('installs');
  }
  if (KILLS.has(name)) {
    if (args.some((a) => /^(\/im|-im|-name|-n)$/i.test(a)) || name === 'pkill' || name === 'killall') {
      return floor('killing processes by name');
    }
    return never('killing processes');
  }
  if (NETWORK.has(name)) return never('network');
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name) && args.some((a) => PM_RUNS.has(a))) return never(`${name} exec, dlx or publish`);
  if (FETCH_RUN.has(name) || (name === 'pipx' && args[0] === 'run')) {
    return never('fetch-and-run (npx, dlx, uvx)');
  }
  if (INTERPRETERS.has(name)) return never('inline code or interpreters');
  for (const a of args) {
    if (pathFormProblem(a) === '' && looksSecret(a)) {
      const real = realish(a, ctx.cwd);
      if (!real || !inside(real, ctx.root)) return floor('reading secret files outside the project');
    }
  }
  return null;
}

/** Download-and-run across a pipe: curl/wget/iwr/irm feeding a shell or interpreter. */
export function downloadAndRun(parts: Part[], shell: 'bash' | 'pwsh'): boolean {
  const names = parts.map((p) => (shell === 'pwsh' ? p.words[0].toLowerCase() : programName(p.words[0])));
  const fetchAt = names.findIndex((n) => NETWORK.has(n));
  return fetchAt >= 0 && names.slice(fetchAt + 1).some((n) => INTERPRETERS.has(n));
}

/** A raw command string with an obvious download-and-run even when it can't be parsed. */
export function looksDownloadAndRun(command: string): boolean {
  return /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]*\|\s*(sh|bash|zsh|iex|invoke-expression|python3?|node|pwsh|powershell)\b/i
    .test(command);
}

// ---- project scripts ("runs project code", decision 1a) ----------------------------------------------------------------------

/** The words a project-code rule names (npm test, npm run lint, deno task test, git commit), or null. */
export function projectScript(words: string[]): string[] | null {
  const name = programName(words[0]);
  const sub = words[1];
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
    // bun test runs Bun's own test runner, not the package.json script: never a pinned rule (review H4)
    if ((sub === 'test' || sub === 't' || sub === 'start') && name !== 'bun') return [name, sub];
    if ((sub === 'run' || sub === 'run-script') && words[2] && !words[2].startsWith('-')) return [name, sub, words[2]];
    return null;
  }
  if (name === 'deno' && sub === 'task' && words[2] && !words[2].startsWith('-')) return [name, sub, words[2]];
  if (name === 'git' && sub === 'commit') return [name, sub];
  return null;
}

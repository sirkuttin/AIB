// aib-guard.ts: the lead workflow's Claude Code hooks (proposed: .claude/hooks/aib-guard.ts). One file, two events:
//   deno run ... aib-guard.ts pre    PreToolUse(Bash|PowerShell): deny a few known-bad commands, with the fix in the reason
//   deno run ... aib-guard.ts stop   SubagentStop: a builder may not finish while its own background shells run, with uncommitted
//                                    work, or with commits but no .test-logs log for HEAD
// Fails open: any error, unreadable input or unknown shape -> exit 0, no output (the call or the stop goes ahead).
// Escape hatch for stop: the builder's final message contains "[stop-anyway: <why>]". Loop guard: at most 3 blocks per agent and
// reason, counted in <tmp>/aib-guard/<agent_id>.json (Claude's own cap of 8 resets on every tool call, so it is not enough alone).

const OWNER_PORTS = /(--port[= ]|\bport=|\bPORT=|localhost:|127\.0\.0\.1:|\[::1\]:)\s*(8767|8768|8777|8778)\b/i;
const MAX_BLOCKS = 3;

type Json = Record<string, unknown>;
const out = (o: unknown) => console.log(JSON.stringify(o));
const deny = (reason: string) =>
  out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `aib-guard: ${reason}` } });

/** The command without AIB's own cookie prefix (hook 2), so rules see what the agent wrote. */
function bare(cmd: string): string {
  return cmd.replace(/^(export AIB_PROC='[^']*'; (export PATH="\$PATH:\/aibproc\/[^"]*"; )?|\$env:AIB_PROC='[^']*'; )/, '');
}

const RULES: [RegExp, string][] = [
  [/\btaskkill(\.exe)?\b[^|;&\n]*\s\/im\b/i,
    'never kill by image name (it kills every session\'s copy). Kill only PIDs you started: taskkill /PID <pid> /T /F.'],
  [/\b(stop-process|spps)\b[^|;\n]*\s-(name|processname)\b/i, 'never kill by name. Use Stop-Process -Id <pid> for a PID you started.'],
  [/\bget-process\b(?![^|]*\s-id\b)[^|]*\|\s*(stop-process|spps|kill)\b/i, 'never kill by name. Use Stop-Process -Id <pid> for a PID you started.'],
  [/(^|[\s;&|(])(pkill|killall)\s/i, 'never kill by name. Use kill <pid> for a PID you started.'],
  [/\bwmic\b[^\n]*\bprocess\b[^\n]*\bname\s*=/i, 'never kill by name. Kill only PIDs you started.'],
  [/\btimeout(\.exe)?\s+(-[a-z-]+(\s+\S+)?\s+)*\d+[smhd]?\s+[^\n]*\b(deno\s+(task\s+)?\S*test|python\S*\s+-m\s+(unittest|pytest)|pytest|go\s+test|npm\s+(run\s+)?test|playwright)/i,
    'never cut a test run short with `timeout` (it orphans keepers and servers). Run it in the background with the tool\'s own timeout (7200000 for suites) and wait for it.'],
  [OWNER_PORTS, 'ports 8767/8768/8777/8778 are the owner\'s. Let the test pick a free port (port 0).'],
  [/\bnode(\.exe)?\s+(-e|--eval|-p|--print)\b/i,
    '`node -e` trips Claude Code\'s bypass-immune safety prompt, which reaches the owner. Write a script in your own folder and run it, or use node --check / deno check.'],
];

function boundedWait(cmd: string): boolean {
  return /\btimeout\s+\d|\bdeadline\b|\bSECONDS\b|\$\(seq\b|\{1\.\.\d+\}|-(lt|le)\s+\d|\bfor\s*\(\(|Stopwatch|AddMinutes|AddSeconds|Get-Date/i.test(cmd);
}

async function pre(input: Json): Promise<void> {
  const ti = (input.tool_input ?? {}) as Json;
  const cmd = typeof ti.command === 'string' ? bare(ti.command) : '';
  if (!cmd) return;
  // Text inside quotes or a heredoc (a commit message, an echo) is data, not a command: only the port rule reads it.
  const code = cmd.replace(/<<-?\s*'?(\w+)'?[\s\S]*?\n\1\b/g, '').replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''");
  for (const [re, why] of RULES) if ((re === OWNER_PORTS ? cmd : code).match(re)) return deny(why);
  const loop = /\b(while|until)\b[\s\S]*\b(do|sleep|start-sleep)\b/i.test(cmd);
  if (ti.run_in_background === true && loop && !boundedWait(cmd)) {
    return deny('a background wait loop needs a time limit (`timeout 900 bash -c "until ...; do sleep 5; done"` or a counter); one ran 3.5 h after its test died.');
  }
}

async function git(cwd: string, ...args: string[]): Promise<string | null> {
  const r = await new Deno.Command('git', { args: ['-C', cwd, ...args], stdout: 'piped', stderr: 'null' }).output();
  return r.success ? new TextDecoder().decode(r.stdout) : null;
}

/** The subagent's cwd: the input's, else the last "cwd" in its own transcript (isolation: worktree runs it in the worktree). */
function agentCwd(input: Json, transcript: string): string {
  const all = [...transcript.matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)];
  const last = all.length ? JSON.parse(`"${all[all.length - 1][1]}"`) as string : '';
  return last || (typeof input.cwd === 'string' ? input.cwd : '');
}

function budget(agent: string, reason: string): boolean {
  const dir = `${Deno.env.get('TEMP') ?? Deno.env.get('TMPDIR') ?? '/tmp'}/aib-guard`;
  const file = `${dir}/${agent.replace(/[^\w-]/g, '_')}.json`;
  let seen: Record<string, number> = {};
  try { seen = JSON.parse(Deno.readTextFileSync(file)); } catch { /* first block */ }
  const n = (seen[reason] ?? 0) + 1;
  if (n > MAX_BLOCKS) return false;
  seen[reason] = n;
  Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(file, JSON.stringify(seen));
  return true;
}

async function stop(input: Json): Promise<void> {
  const agent = String(input.agent_id ?? '');
  const type = String(input.agent_type ?? '');
  if (!agent || !type || /^(Explore|Plan|claude-code-guide|statusline-setup|web-fetch)$/.test(type)) return;
  if (/\[stop-anyway:[^\]]+\]/i.test(String(input.last_assistant_message ?? ''))) return;
  let transcript = '';
  try { transcript = Deno.readTextFileSync(String(input.agent_transcript_path ?? '')); } catch { /* none: skip that check */ }
  const block = (key: string, reason: string) => {
    if (budget(agent, key)) out({ decision: 'block', reason: `aib-guard: ${reason} If you truly must stop now, end your message with [stop-anyway: <why>].` });
  };
  // 1. its own background shells still running (background_tasks is the PARENT's list: keep the ones its transcript names)
  const tasks = Array.isArray(input.background_tasks) ? input.background_tasks as Json[] : [];
  const mine = tasks.filter((t) => t.status === 'running' && (t.type === 'shell' || t.type === 'monitor') &&
    ((typeof t.id === 'string' && transcript.includes(t.id)) ||
      (typeof t.command === 'string' && t.command.length > 12 && transcript.includes(JSON.stringify(bare(t.command)).slice(1, -1)))));
  if (mine.length) {
    const list = mine.slice(0, 5).map((t) => `${t.id}: ${String(t.command ?? t.description ?? '').slice(0, 120)}`).join('; ');
    return block('running', `your background work is still running (${list}). AIB lands and cleans up your worktree as soon as you finish, which kills it mid-run. Wait for it with a bounded wait and read its result, or kill its PIDs if it hangs, then finish.`);
  }
  // 2 and 3: only for a subagent in a worktree of its own (a sub-* folder) that changed something
  const cwd = agentCwd(input, transcript);
  if (!/[\\/]sub-[\w-]+[\\/]?$/.test(cwd)) return;
  const status = await git(cwd, 'status', '--porcelain', '--untracked-files=all');
  if (status === null) return;
  if (status.trim()) {
    return block('dirty', `you have uncommitted changes in ${cwd}. Commit them or remove scratch files, then finish.`);
  }
  const head = (await git(cwd, 'rev-parse', 'HEAD'))?.trim() ?? '';
  const own = Number((await git(cwd, 'rev-list', '--count', 'main..HEAD'))?.trim() ?? '0');
  if (!head || !own) return; // no commits of its own: a research or read-only run
  let logged = false;
  try {
    for (const e of Deno.readDirSync(`${cwd}/.test-logs`)) {
      if (e.isFile && e.name.endsWith('.log') && Deno.readTextFileSync(`${cwd}/.test-logs/${e.name}`).slice(0, 400).includes(head.slice(0, 8))) logged = true;
    }
  } catch { /* no folder */ }
  if (!logged) {
    return block('tests', `no .test-logs/*.log names your HEAD ${head.slice(0, 8)}. Run your targeted tests, save the output there with the commit hash on the first line, then finish.`);
  }
}

try {
  const input = JSON.parse(await new Response(Deno.stdin.readable).text()) as Json;
  if (Deno.args[0] === 'pre') await pre(input);
  else if (Deno.args[0] === 'stop') await stop(input);
} catch { /* fail open */ }

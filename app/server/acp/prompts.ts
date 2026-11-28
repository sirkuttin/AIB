/**
 * The fixed prompt texts AIB gives agents (artifact, WSL artifact, worktree, shared folder, local-only files).
 * Moved out of connection.ts (no change).
 */
import { DOCS_RULE } from '../docs/tool_defs.ts';

/**
 * An agent connects to MCP servers in the background: a first prompt sent as the chat opens can find no studio_artifact tools yet.
 * Codex lists them directly (acp/codex_mcp.ts: omit_tools_from), so it needs no recipe to find them.
 */
export const TOOLS_LOADING = 'The studio_artifact tools can take a few seconds to appear at the start of a chat: if you do not see them yet, ' +
  'wait a few seconds and look again (more than once) before telling the user they are missing.';

/**
 * How the agent writes a command for the user to run. AIB puts a "Run in terminal" button on a fenced shell block in a reply
 * (run-terminal-ui.js: the language tag decides) that pastes the command into the chat's terminal and never presses Enter.
 */
export const COMMANDS_RULE =
  'When you give the user a shell command to run, put it in its own fenced code block tagged bash (powershell on Windows), ' +
  'one command per block, with no explanation or comments inside the block; AIB then shows a Run in terminal button that ' +
  "pastes it into the chat's terminal without running it. Write the explanation outside the block. You cannot type a password, so " +
  'never run a command that needs sudo yourself: give it to the user in such a block, and carry on once they say it is done.';

/**
 * Which kind of helper to start (owner 2026-11-28): a main agent used its own built-in subagents for "design lead, tech lead" and
 * the user never saw them. In the prompt of every chat with AIB's tools and in the `helper` tool's description.
 */
export const HELPER_RULE = 'If you have the `helper` tool and the user asks for helpers, leads, team members or agents they can see or talk to, ' +
  'start them with `helper` (action start) and `chat: true`: they appear under this chat in the user\'s chat list. ' +
  'Use your own built-in subagents only for internal side jobs the user did not ask to see.';

export const ARTIFACT_PROMPT =
  'You are running inside AIB, which shows artifacts beside the chat; when the user says "artifact" they ' +
  'mean this viewer and its studio_artifact tool (the doc tool is mcp__studio_artifact__doc where MCP tool names are prefixed). ' + DOCS_RULE + ' ' + HELPER_RULE + ' When you make something else the user ' +
  'should look at rather than source code (an HTML page, one-off report, chart, diagram, SVG or image), ' +
  "save its file under the project's outputs/ folder (for example outputs/report.html), never in the project root " +
  'or among source files, then publish it with the `publish` tool (pass a file path or the content) and mention it in your reply ' +
  'as the Markdown link the tool returns. When you change it, call `publish` again with its `id` so it gets a new ' +
  'version, and do not tell the user to open the file by hand. Only publish to claude.ai (or any other web ' +
  'artifact or sharing service) when the user explicitly asks for a claude.ai page or a shareable link. ' + TOOLS_LOADING + ' ' + COMMANDS_RULE;

/**
 * The same for a chat in a WSL project (design section 11). publish takes the content or a Linux `path` inside the project (AIB
 * reads the file through the distro's helper, as a snapshot: wsl/artifact_read.ts). A chat in its own copy also
 * gets the merge tools (WORKTREE_PROMPT says so; the merge runs in the distro).
 */
export const WSL_ARTIFACT_PROMPT =
  'You are running inside AIB, which shows artifacts beside the chat; when the user says "artifact" they ' +
  'mean this viewer and its studio_artifact tool. ' + HELPER_RULE + ' This project is in WSL. When you make something the user should look at rather ' +
  'than source code (an HTML page, one-off report, chart, diagram, SVG, image or PDF), publish it with the `publish` ' +
  'tool, by its content or by its Linux `path` (relative to the chat folder, or absolute inside the chat or project folder; any ' +
  'kind up to 25 MB, PNG and other images included), and mention it in your reply as the Markdown link the tool returns. AIB copies ' +
  'a file when you publish it: after changing the file, call `publish` with its `id` and the same path (or the new content) to publish the new ' +
  'version. ' + TOOLS_LOADING + ' ' + COMMANDS_RULE.replace(' (powershell on Windows)', '');

/** How long codex-acp waits for AIB's tool server before the first turn (architect review S5: 10 s, the forwarder retries 15 s itself). */
export const CODEX_MCP_STARTUP_WAIT_MS = 10_000;

export const WORKTREE_PROMPT =
  'In this chat you work in your own copy of the project, on the git branch {branch} (it started from {base}). ' +
  'Helpers you start work in their own copies: when one finishes, merge its branch into yours with `git merge <branch>`. ' +
  "When your work is done and tested (for example before a release), merge it into the project's main branch yourself with the " +
  "merge_into_project tool (action merge); you don't need to ask first. If main has moved, the tool brings main into your copy: resolve any " +
  'conflicts there, commit, and call it again.';

/**
 * Local-only files (AIB's block of .git/info/exclude; host/aib.ts fills Connection.localOnly). Every chat whose project keeps
 * aib-shared/ local only is told SHARED_FOLDER_PROMPT (owner 2026-11-17); a chat in its own copy reaches the main folder's
 * aib-shared/ through the copy's `aib-shared` link (worktrees/shared_link.ts). A chat in its own copy is also told where the main
 * folder's other local-only paths are ({paths}).
 */
export const SHARED_FOLDER_PROMPT = 'aib-shared/ in the project folder is shared by every agent and chat, never committed.';
export const LOCAL_ONLY_WORKTREE_PROMPT = 'Local-only files (git never commits them) are kept in the main project folder, not in this ' +
  'copy: {paths}. Read and write them there by their full path. Never create those paths in this copy: ' +
  'files there are not shared with other chats.';
/**
 * A WSL chat in its own copy (wsl/local_only.ts): the main folder's other git-ignored folders and files, granted like the local-only
 * folders. Windows chats never get it (Connection.localOnly.ignored is only set for WSL chats).
 */
export const IGNORED_SHARED_WORKTREE = 'These folders and files git ignores are in the main project folder too, not in this copy: ' +
  '{paths}. Read and edit them there by their full path: they are shared with the main folder, so an edit there is live at once ' +
  "and is not part of this copy or its branch.";

/**
 * Build plan 1.1 (4): two chats work in the same project folder. The agents get this line once, on their next prompt (the new chat's
 * first, the working chat's next); the person sees sharedFolderNote in the new chat.
 */
export const SHARED_FOLDER_CONTEXT = 'Another agent works in this folder at the same time. Do not run git stash, git reset --hard, ' +
  'git checkout -- / git switch, git clean or git rebase here. Commit only files you changed yourself (git add <paths>, never git add -A).';
/** The grey line in a new folder chat that starts while another folder chat (titled `title`) is working there. */
export function sharedFolderNote(title: string): string {
  return `Another chat (“${title}”) is working in this same folder. Its edits show up here as it makes them.`;
}

/**
 * Test helper for work/test_refile_e2e.py: runs AIB's re-file core (server/worktrees/refile.ts) once, on the folders given, and prints
 * its result as one JSON line. Only temp folders a test made are passed; under AGENT_STUDIO_TEST=1 the owner's ~/.claude is refused.
 *
 *   deno run -A work/refile_cli.ts claude <stateDir> <projectsRoot> <sessionId> <fromFolder> <toFolder>
 *   deno run -A work/refile_cli.ts clean  <projectsRoot> <worktreesRoot>
 */
import * as refile from '../outputs/agent-studio/server/worktrees/refile.ts';

const [op, ...a] = Deno.args;
if (op === 'claude') {
  const root = refile.claudeProjectsRoot({ CLAUDE_CONFIG_DIR: a[1].replace(/[\\/]projects$/, '') }, null);
  if (!root) {
    console.log(JSON.stringify({ error: 'refused: not a temp folder' }));
    Deno.exit(1);
  }
  console.log(JSON.stringify(refile.refileClaude({ stateDir: a[0], projectsRoot: root, sessionId: a[2], from: a[3], to: a[4] })));
} else if (op === 'clean') {
  const [removed, kept] = refile.cleanEmptyCopyFolders(a[0], a[1]);
  console.log(JSON.stringify({ removed, kept }));
} else {
  console.log(JSON.stringify({ error: 'usage: refile_cli.ts claude|clean ...' }));
  Deno.exit(2);
}

/**
 * Test helper for work/test_refile_e2e.py: runs the folder-chats migration's re-file core (work/migrate/refile_core.ts) and its Codex
 * opener (folder_chats_migrate.ts codexLoad) once, on the folders given, and prints the result as one JSON line. Only temp folders
 * a test made are passed; anything outside the system temp folder is refused.
 *
 *   deno run -A work/refile_cli.ts claude <stateDir> <projectsRoot> <sessionId> <fromFolder> <toFolder>
 *   deno run -A work/refile_cli.ts clean  <projectsRoot> <worktreesRoot>
 *   deno run -A work/refile_cli.ts codex-script <codexHome> <node> <adapter> <sessionId> <projectFolder>
 *
 * codex-script is the migration script's Codex step with the real adapter: session/load {sessionId, cwd: project}, no prompt.
 */
import * as refile from './migrate/refile_core.ts';
import { codexLoad } from './migrate/folder_chats_migrate.ts';

const TEMP = Deno.realPathSync(Deno.env.get('TEMP') || Deno.env.get('TMPDIR') || '/tmp').toLowerCase();
function temp(path: string): string {
  const real = Deno.realPathSync(path);
  if (!real.toLowerCase().startsWith(TEMP)) {
    console.log(JSON.stringify({ error: `refused: not a temp folder: ${path}` }));
    Deno.exit(1);
  }
  return real;
}

const [op, ...a] = Deno.args;
if (op === 'claude') {
  const root = temp(a[1]);
  console.log(JSON.stringify(refile.refileClaude({ stateDir: a[0], projectsRoot: root, sessionId: a[2], from: a[3], to: a[4] })));
} else if (op === 'clean') {
  const [removed, kept] = refile.cleanEmptyCopyFolders(temp(a[0]), a[1]);
  console.log(JSON.stringify({ removed, kept }));
} else if (op === 'codex-script') {
  await codexLoad([a[1], a[2]], temp(a[0]), a[3], a[4]);
  console.log(JSON.stringify({ ok: true }));
  Deno.exit(0);
} else {
  console.log(JSON.stringify({ error: 'usage: refile_cli.ts claude|clean|codex-script ...' }));
  Deno.exit(2);
}

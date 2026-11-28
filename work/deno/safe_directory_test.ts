/**
 * Git on a folder AIB made under its worktrees folder gets `-c safe.directory=<that worktree>` (2026-11-27: "detected dubious
 * ownership ... owned by BUILTIN/Administrators" failed the swarm poll 510 times). Nothing else gets it.
 */
import { assertEquals } from './_assert.ts';
import { Registry, safeDirectoryArgs } from '../../app/server/worktrees/worktrees.ts';

Deno.test('safe.directory: only worktrees under AIB\'s own worktrees folder, as the worktree folder itself', () => {
  const state = Deno.makeTempDirSync({ prefix: 'aib-safedir-' });
  try {
    const reg = new Registry(state);
    const sep = Deno.build.os === 'windows' ? '\\' : '/';
    const wt = `${reg.root}${sep}abc123${sep}sub-1`;
    const want = ['-c', `safe.directory=${wt.replaceAll('\\', '/')}`];
    assertEquals(safeDirectoryArgs(wt), want);
    assertEquals(safeDirectoryArgs(`${wt}${sep}src${sep}deep`), want, 'a folder inside the worktree names the worktree');
    assertEquals(safeDirectoryArgs(`${reg.root}${sep}abc123`), [], 'the project folder level is not a worktree');
    assertEquals(safeDirectoryArgs(reg.root), []);
    assertEquals(safeDirectoryArgs(`${reg.root}${sep}abc123${sep}..${sep}..${sep}other`), [], 'no way out through ..');
    assertEquals(safeDirectoryArgs(`${reg.root}-x${sep}abc123${sep}sub-1`), [], 'a sibling with the same prefix');
    assertEquals(safeDirectoryArgs(state), []);
    assertEquals(safeDirectoryArgs(Deno.cwd()), []);
  } finally {
    Deno.removeSync(state, { recursive: true });
  }
});

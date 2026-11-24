/**
 * Where a Deno test puts the project folders of a REAL agent: outside the user's home folder (the twin of work/_isolation.py
 * agent_mkdtemp). Claude Code walks the parent folders of its working folder for CLAUDE.md, so a project under the user's temp
 * folder would load the owner's ~/.claude/CLAUDE.md. C:/aib-test-tmp on Windows, /tmp elsewhere (AIB_TEST_AGENT_TMP overrides).
 */
export function agentTempRoot(): string {
  const root = Deno.env.get('AIB_TEST_AGENT_TMP') || (Deno.build.os === 'windows' ? 'C:\\aib-test-tmp' : '/tmp');
  Deno.mkdirSync(root, { recursive: true });
  return root;
}

/** A new folder under agentTempRoot(); the caller removes it. */
export function agentTempDirSync(prefix = 'aib-'): string {
  return Deno.makeTempDirSync({ dir: agentTempRoot(), prefix });
}

/** True when `path` is the user's home folder or inside it (HOME / USERPROFILE, resolved). */
export function insideHome(path: string): boolean {
  const win = Deno.build.os === 'windows';
  const sep = win ? '\\' : '/';
  const real = (p: string) => {
    try {
      return Deno.realPathSync(p);
    } catch {
      return p;
    }
  };
  const norm = (p: string) => (win ? real(p).replaceAll('/', '\\').toLowerCase() : real(p));
  const homes = new Set<string>();
  for (const name of ['USERPROFILE', 'HOME']) if (Deno.env.get(name)) homes.add(norm(Deno.env.get(name)!));
  const target = norm(path);
  for (const home of homes) {
    let trimmed = home;
    while (trimmed.length > 1 && (trimmed.endsWith('/') || trimmed.endsWith('\\'))) trimmed = trimmed.slice(0, -1);
    if (target === home || target.startsWith(trimmed + sep)) return true;
  }
  return false;
}

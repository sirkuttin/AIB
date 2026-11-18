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

/**
 * A fake shell for the Linux setup terminal (AIB_REMOTE_SETUP_SHELL='["deno","run","-A","_fake_setup_shell.ts","<log>","<code>"]'):
 * writes the command line AIB handed it to <log>, prints it, and exits with <code>. Never runs the command.
 */
const [log, code, command] = Deno.args;
Deno.writeTextFileSync(log, command ?? "");
console.log(`fake sudo: would run ${command}`);
Deno.exit(Number(code) || 0);

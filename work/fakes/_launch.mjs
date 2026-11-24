// What the work/*-fixture/agent.mjs launchers share: start fake_acp.mjs with a fixed flag list. Studio starts a Claude launcher as
// `<node> <launcher> ...`; a strict launcher (the ones that used argparse with no arguments) rejects extra arguments and answers -h.
import { run } from './fake_acp.mjs';

export function launchFake(flags, { strict = true, doc = 'Fake ACP agent. No model calls.' } = {}) {
  const extra = process.argv.slice(2);
  if (strict) {
    if (extra.includes('-h') || extra.includes('--help')) {
      process.stdout.write(`usage: agent.mjs [-h]\n\n${doc}\n`);
      process.exit(0);
    }
    if (extra.length) {
      process.stderr.write(`usage: agent.mjs [-h]\nagent.mjs: error: unrecognized arguments: ${extra.join(' ')}\n`);
      process.exit(2);
    }
  }
  run(flags);
}

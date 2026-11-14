/**
 * A fake `tailscale` CLI for end-to-end tests (AIB_TAILSCALE_CLI='["deno","run","-A","_fake_tailscale.ts","<answers.json>"]'): prints
 * the `status --json` and `serve status --json` answers from the JSON file the test writes ({status, serve}), and logs every call
 * to <answers.json>.calls so the test can check AIB only reads. Exit 1 for anything else.
 */
const [file, ...args] = Deno.args;
Deno.writeTextFileSync(`${file}.calls`, JSON.stringify(args) + '\n', { append: true });
const answers = JSON.parse(Deno.readTextFileSync(file));
if (args[0] === 'status' && args[1] === '--json') console.log(JSON.stringify(answers.status));
else if (args[0] === 'serve' && args[1] === 'status' && args[2] === '--json') console.log(JSON.stringify(answers.serve ?? {}));
else Deno.exit(1);

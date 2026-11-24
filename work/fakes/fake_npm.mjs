// A fake npm-cli.js for the installer tests (run as `node fake_npm.mjs <npm arguments>`; the test passes node as "node"). Never touches the network.
//
// FAKE_NPM_MODE: ok (default), slow (writes files for FAKE_NPM_DELAY seconds first), hang (starts a grandchild, then waits for ever), fail (npm-style error).
// FAKE_NPM_LOG: a file every run appends its arguments to. FAKE_NPM_CHILD: where hang mode writes its grandchild's pid.
import fs from 'node:fs';
import path from 'node:path';
import { popen, pyDumps, sleepSync, sleeper } from './_py.mjs';

const args = process.argv.slice(2);
const env = process.env;
const log = env.FAKE_NPM_LOG;
if (log) fs.appendFileSync(log, pyDumps({ args, cwd: process.cwd(), pid: process.pid, cache: env.npm_config_cache ?? null }) + '\n', 'utf8');
const prefix = args.includes('--prefix') ? args[args.indexOf('--prefix') + 1] : process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(prefix, 'package.json'), 'utf8'));
const [pkg, version] = Object.entries(manifest.dependencies)[0];
const mode = env.FAKE_NPM_MODE ?? 'ok';
const folder = path.join(prefix, 'node_modules', ...pkg.split('/'));

function writePackage(binValue = 'dist/index.js') {
  fs.mkdirSync(path.join(folder, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'package.json'), pyDumps({ name: pkg, version: env.FAKE_NPM_VERSION ?? version, bin: { adapter: binValue } }), 'utf8');
  fs.writeFileSync(path.join(folder, 'dist', 'index.js'), '// fake adapter\n', 'utf8');
}

if (mode === 'fail') {
  process.stderr.write('npm error code ENOTFOUND\n');
  process.stderr.write('npm error network request to https://registry.npmjs.org failed\n');
  process.exit(1);
}
if (mode === 'hang' || mode === 'slow') {
  fs.mkdirSync(path.join(folder, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'dist', 'partial.bin'), Buffer.alloc(200000, 'x')); // a half-made install
}
if (mode === 'hang') {
  const child = popen(process.execPath, ['-e', sleeper(300)], { stdio: ['inherit', 'inherit', 'inherit'] });
  if (env.FAKE_NPM_CHILD) fs.writeFileSync(env.FAKE_NPM_CHILD, String(child.pid), 'utf8');
  sleepSync(300000);
}
if (mode === 'slow') sleepSync(Number.parseFloat(env.FAKE_NPM_DELAY ?? '2') * 1000);
writePackage();

// Launcher of the steer e2e tests' fake agents (work/deno/_steer_lab.ts): work/fakes/fake_acp.mjs with the flags the lab wrote.
// The lab's folder (env AIB_STEER_LAB) holds <who>.json = {"flags": [...], "log": "<path>"}.
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../fakes/fake_acp.mjs';

export function launch(who) {
  const config = JSON.parse(fs.readFileSync(path.join(process.env.AIB_STEER_LAB, who + '.json'), 'utf8'));
  if (config.log) process.env.FAKE_ACP_LOG = config.log;
  run(config.flags);
}

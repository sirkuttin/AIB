/**
 * A second process that writes many entries into one state store under the shared file lock, for state_store_parity_test.ts:
 *
 *   deno run -A _state_writer.ts <kind> <state dir> <tag> <count> <pause seconds>
 *
 * kind: conversations | projects | read | settings. Entry i is named `<tag>-<i>`; the answer is the count on stdout.
 */
import {
  ConversationState,
  ProjectPrefs,
  ReadState,
  SettingsStore,
} from '../../outputs/agent-studio/server/state/store.ts';

Deno.env.set('AGENT_STUDIO_TEST', '1');
const [kind, dir, tag, countText, pauseText] = Deno.args;
const count = Number(countText);
const pause = Number(pauseText) * 1000;
const store = kind === 'conversations'
  ? new ConversationState(dir)
  : kind === 'projects'
  ? new ProjectPrefs(dir)
  : kind === 'read'
  ? new ReadState(dir)
  : new SettingsStore(dir);

for (let i = 0; i < count; i++) {
  await new Promise((r) => setTimeout(r, pause));
  if (store instanceof ConversationState) await store.apply('pin', 'omp', `${tag}-${i}`);
  else if (store instanceof ProjectPrefs) await store.update({ set: { [`${tag}-${i}`]: { name: 'n' } } });
  else if (store instanceof ReadState) await store.update({ set: { [`omp:${tag}-${i}`]: { seenAt: i + 1 } } });
  else await store.update({ defaults: { projects: { [`${tag}-${i}`]: { model: 'm' } } } });
}
console.log(count);

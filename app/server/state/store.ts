/**
 * state_store.py, ported: the stores that keep Studio's small JSON files in the state folder. Python and Deno processes share
 * these files during the transition, so names, JSON layout, versions, locking, reload-on-change, quarantine and pruning are
 * Python's exactly.
 *
 *   recovery.ts       StateStore (studio-<name>.json: owned conversations and prompt receipts) and Recovery
 *   conversations.ts  ConversationState (studio-conversations.json: pin / hold / archive / delete / your-turn marks)
 *   projects.ts       ProjectPrefs (studio-projects.json: rail names, colours, flags, order)
 *   read_state.ts     ReadState (studio-read-state.json: what the user has seen in each chat)
 *   settings.ts       SettingsStore (studio-settings.json)
 *   base.ts           JsonFileStore (lock -> reload -> modify -> save), FileLock, VERSION
 *   json.ts           read_json_file, json.loads / json.dump equivalents, file stamps, quarantine
 */
export { FileLock, JsonFileStore, LOCK_TIMEOUT_MS, LockTimeout, OSError, VERSION } from './base.ts';
export { READ_ATTEMPTS, readJsonFile, timing } from './json.ts';
export {
  type Conversation,
  MAX_CONVERSATIONS,
  MAX_RECEIPTS_PER_SESSION,
  MAX_SESSIONS_WITH_RECEIPTS,
  type Receipt,
  RECEIPT_STATES,
  type RecoverableConnection,
  Recovery,
  StateStore,
} from './recovery.ts';
export { ConversationState, type Marks } from './conversations.ts';
export { type ProjectPref, ProjectPrefs } from './projects.ts';
export { type ReadPosition, ReadState } from './read_state.ts';
export { type Choice, EDITOR_IDS, type Settings, SettingsStore } from './settings.ts';
export { BUILTIN_IDS as PROVIDERS } from '../agents/agent_registry.ts';

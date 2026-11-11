/**
 * Studio settings (state_store.SettingsStore): the agent list (built-in switches + user-added ACP agents), New chat defaults,
 * editor, appearance, launchers and server options.
 *
 * One small validated JSON file in the state folder, shared by the web server and the agent host (either may be Python or Deno
 * during the transition; each re-reads it when the file changes, so a new agent is launchable without restarting anything).
 * Writes are atomic. `revision` changes on every save, in this process or another, so other windows know to refresh. Agent
 * environment values are stored as plain text: ACP adapters need them. The file is the user's own and lives in the state folder.
 * Beta agents' API keys are not: on disk each is sealed (secrets.ts: DPAPI on Windows, the Keychain on macOS, the Secret Service
 * or an owner-only file on Linux); in memory they are plain. A plain key in the file (an older AIB) is sealed as soon as it is read.
 *
 *   {"version":1,
 *    "agents":   {"builtin": {"omp": true, "claude": true, "codex": true}, "custom": [{id,name,command,args,env,enabled}]},
 *    "defaults": {"agent": "", "byAgent": {id: {model, mode}}, "projects": {projectKey: {agent, model, mode}}, "migrated": false},
 *    "server":   {"autoReconnect": true, "worktreePerChat": true, "autoUpdateCheck": true},
 *    "editors":  {"default": "" | "code" | "cursor" | "windsurf" | "devin"},
 *    "appearance": {"defaultView": "full" | "chat"},
 *    "launchers": {"claude": "", "codex": ""}}
 *
 * public() never contains an environment value: custom agents show env as [{name, set: true}].
 */
import { clip, isDict, isStr, pyCompare, pyLen, pyStrip, ValueError } from '../core/py.ts';
import {
  BETA_IDS,
  BETA_NAMES,
  BUILTIN_IDS,
  BUILTIN_NAMES,
  cleanAgent,
  type CustomAgent,
  hiddenEnv,
  isBeta,
  isBuiltin,
  isCustom,
  isProvider,
  MAX_AGENTS,
  MAX_COMMAND,
  MAX_ENV_VALUE,
} from '../agents/agent_registry.ts';
import { betaAgent } from '../agents/beta_catalog.ts';
import { expandUser, isAbsolute, isFile, pathStr } from '../platform/pypath.ts';
import { deepCopy, errorText, inDir, isOSError, JsonFileStore, sameJson, VERSION } from './base.ts';
import { entriesOf, now, put, quarantine, readJsonFile, saveJson } from './json.ts';
import { ProjectPrefs } from './projects.ts';
import { DEFAULT_ORDER } from '../desktop/editors.ts';
import { isSealed, type KeyStore, keyStoreFor } from './secrets.ts';

/** editors.DEFAULT_ORDER: the ids of editors.EDITOR_SPECS. */
export const EDITOR_IDS: readonly string[] = DEFAULT_ORDER;

export interface Choice {
  model: string;
  mode: string;
  agent?: string;
}

export interface Settings {
  /** beta / betaKeys: the Beta agents (beta_catalog.ts) turned on, and the API keys typed for them. Present only when not empty (a
   * fresh store matches the Python one), hidden from public(). */
  agents: { builtin: Record<string, boolean>; custom: CustomAgent[]; beta?: Record<string, boolean>; betaKeys?: Record<string, string> };
  defaults: { agent: string; byAgent: Record<string, Choice>; projects: Record<string, Choice>; migrated: boolean };
  server: { autoReconnect: boolean; worktreePerChat: boolean; autoUpdateCheck: boolean };
  editors: { default: string };
  appearance: { defaultView: string };
  launchers: Record<string, string>;
}

type Dict = Record<string, unknown>;

function section(value: unknown, name: string): Dict {
  if (value === null || value === undefined) return {};
  if (!isDict(value)) throw new ValueError(`Invalid ${name} settings`);
  return value;
}

function unknownKeys(value: Dict, allowed: readonly string[]): boolean {
  return Object.keys(value).some((key) => !allowed.includes(key));
}

export class SettingsStore extends JsonFileStore {
  static FILE = 'studio-settings.json';
  static MAX_PROJECTS = 300;
  static MAX_VALUE = 200;
  static DEFAULT_VIEWS: readonly string[] = ['full', 'chat'];

  data: Settings = SettingsStore.blank();
  /** Where API keys are kept at rest (null for a store with no folder: nothing is written). */
  readonly keys: KeyStore | null;
  /** Plain keys were read from the file: they are sealed by the next save (started right after the load). */
  #plainOnDisk = false;
  #migrating: Promise<void> | null = null;

  constructor(stateDir: string | null = null) {
    super();
    this.path = stateDir ? inDir(stateDir, (this.constructor as typeof SettingsStore).FILE) : null;
    this.keys = stateDir ? keyStoreFor(stateDir) : null;
    this.reload();
  }

  /** Settings > Beta agents: where a saved key is kept, in plain words. */
  keyStorage(): { kind: string; note: string } {
    return this.keys ? { kind: this.keys.kind, note: this.keys.note } : { kind: 'memory', note: 'Kept in memory only' };
  }

  /** The stored betaKeys of a raw file turned into plain keys (sealed forms opened; one that cannot be opened is dropped). */
  #openKeys(raw: Dict): void {
    const agents = isDict(raw.agents) ? raw.agents : null;
    if (!agents || !isDict(agents.betaKeys)) return;
    const open: Dict = {};
    for (const [agentId, stored] of Object.entries(agents.betaKeys)) {
      if (!isStr(stored) || !stored) continue;
      if (!isSealed(stored)) this.#plainOnDisk = true;
      const plain = this.keys ? this.keys.open(agentId, stored) : (isSealed(stored) ? null : stored);
      if (plain) open[agentId] = plain;
    }
    agents.betaKeys = open;
  }

  /** Seals the plain keys an older AIB left in the file: the outside store first (async), then one save. */
  #migrateKeys(): void {
    if (!this.#plainOnDisk || this.#migrating || !this.keys || this.path === null) return;
    const keys = { ...(this.data.agents.betaKeys ?? {}) };
    this.#migrating = (async () => {
      try {
        for (const [agentId, plain] of Object.entries(keys)) await this.keys!.prepare(agentId, plain);
        await this.locked(() => {
          this.sync();
          if (!this.#plainOnDisk) return;
          this.#save();
        });
      } catch (error) {
        this.warning = `AIB could not encrypt the saved API keys: ${errorText(error)}`;
      } finally {
        this.#migrating = null;
      }
    })();
  }

  /** Resolves when keys found in plain text at load have been sealed (tests; the server never waits for it). */
  keysSealed(): Promise<void> {
    return this.#migrating ?? Promise.resolve();
  }

  static blank(): Settings {
    return {
      agents: { builtin: { omp: true, claude: true, codex: true }, custom: [] },
      defaults: { agent: '', byAgent: {}, projects: {}, migrated: false },
      // worktreePerChat: on by default; hidden, never shown by public(). The keeper has no setting (it is always on): an old saved
      // `server.keeper` is dropped on read.
      server: { autoReconnect: true, worktreePerChat: true, autoUpdateCheck: true },
      editors: { default: '' },
      appearance: { defaultView: 'full' },
      launchers: { claude: '', codex: '' },
    };
  }

  // ---- cleaning (used for the file and for patches) ----
  static value(value: unknown): string {
    if (!isStr(value)) return '';
    let out = '';
    for (const ch of value) {
      const code = ch.codePointAt(0)!;
      if (code >= 32 && code !== 127) out += ch;
    }
    return clip(pyStrip(out), this.MAX_VALUE);
  }

  static choice(item: unknown, withAgent: boolean): Choice | null {
    const source = isDict(item) ? item : {};
    const out: Choice = { model: this.value(source.model), mode: this.value(source.mode) };
    if (withAgent) {
      const agent = source.agent;
      out.agent = agent === '' || isProvider(agent) ? agent as string : '';
    }
    return out.model || out.mode || out.agent ? out : null;
  }

  static cleanDoc(raw: unknown): Settings {
    const doc = this.blank();
    if (!isDict(raw)) return doc;
    const agents = isDict(raw.agents) ? raw.agents : {};
    const builtin = isDict(agents.builtin) ? agents.builtin : {};
    for (const agentId of BUILTIN_IDS) {
      if (typeof builtin[agentId] === 'boolean') doc.agents.builtin[agentId] = builtin[agentId] as boolean;
    }
    const beta = isDict(agents.beta) ? agents.beta : {};
    for (const agentId of BETA_IDS) if (beta[agentId] === true) (doc.agents.beta ??= {})[agentId] = true; // off unless turned on
    const keys = isDict(agents.betaKeys) ? agents.betaKeys : {};
    for (const agentId of BETA_IDS) {
      const key = this.betaKeyValue(keys[agentId]);
      if (key && betaAgent(agentId)?.signin.keyEnv) (doc.agents.betaKeys ??= {})[agentId] = key;
    }
    const taken = new Set<string>();
    for (const item of (Array.isArray(agents.custom) ? agents.custom : []).slice(0, MAX_AGENTS)) {
      let cleaned: CustomAgent;
      try {
        if (!isDict(item) || (isStr(item.id) && taken.has(item.id)) || !isCustom(item.id)) continue;
        cleaned = cleanAgent(item, taken, { id: item.id, enabled: true }, false);
      } catch (error) {
        if (error instanceof ValueError) continue;
        throw error;
      }
      taken.add(cleaned.id);
      doc.agents.custom.push(cleaned);
    }
    const defaults = isDict(raw.defaults) ? raw.defaults : {};
    const agent = defaults.agent;
    doc.defaults.agent = agent === '' || isProvider(agent) ? agent as string : '';
    doc.defaults.migrated = defaults.migrated === true;
    for (const [key, item] of entriesOf(isDict(defaults.byAgent) ? defaults.byAgent : {})) {
      const choice = this.choice(item, false);
      if (isProvider(key) && choice) put(doc.defaults.byAgent, key, choice);
    }
    for (const [key, item] of entriesOf(isDict(defaults.projects) ? defaults.projects : {}).slice(0, this.MAX_PROJECTS)) {
      const choice = this.choice(item, true);
      if (ProjectPrefs.key(key) && choice) put(doc.defaults.projects, key, choice);
    }
    const server = isDict(raw.server) ? raw.server : {};
    if (typeof server.autoReconnect === 'boolean') doc.server.autoReconnect = server.autoReconnect;
    if (typeof server.worktreePerChat === 'boolean') doc.server.worktreePerChat = server.worktreePerChat;
    if (typeof server.autoUpdateCheck === 'boolean') doc.server.autoUpdateCheck = server.autoUpdateCheck;
    const editor = isDict(raw.editors) ? raw.editors : {};
    doc.editors.default = isStr(editor.default) && EDITOR_IDS.includes(editor.default) ? editor.default : '';
    const appearance = isDict(raw.appearance) ? raw.appearance : {};
    if (isStr(appearance.defaultView) && this.DEFAULT_VIEWS.includes(appearance.defaultView)) {
      doc.appearance.defaultView = appearance.defaultView;
    }
    const launchers = isDict(raw.launchers) ? raw.launchers : {};
    for (const key of Object.keys(doc.launchers)) {
      doc.launchers[key] = this.launcherPath(Object.prototype.hasOwnProperty.call(launchers, key) ? launchers[key] : undefined);
    }
    return doc;
  }

  /** An API key as stored: one line of text, at most MAX_ENV_VALUE characters, else ''. */
  static betaKeyValue(value: unknown): string {
    if (!isStr(value)) return '';
    const text = pyStrip(value);
    for (const ch of text) if (ch.codePointAt(0)! < 32 || ch.codePointAt(0) === 127) return '';
    return pyLen(text) <= MAX_ENV_VALUE ? text : '';
  }

  static launcherPath(value: unknown): string {
    if (!isStr(value)) return '';
    const text = pyStrip(value);
    const length = pyLen(text);
    let control = false;
    for (const ch of text) if (ch.codePointAt(0)! < 32) control = true;
    return length > 0 && length <= MAX_COMMAND && !control ? text : '';
  }

  #cls(): typeof SettingsStore {
    return this.constructor as typeof SettingsStore;
  }

  // ---- file ----
  protected reload(): void {
    if (this.path === null) {
      this.data = SettingsStore.blank();
      return;
    }
    this.counter++;
    this.seen = this.stamp();
    const [status, raw] = readJsonFile(this.path);
    if (status === 'busy') {
      this.unreadableNow('Saved settings could not be read just now; changes are paused.');
      return;
    }
    this.unreadable = false;
    this.data = SettingsStore.blank();
    if (status === 'missing') {
      this.warning = '';
      return;
    }
    if (status === 'corrupt') {
      this.warning = 'Saved settings were unreadable and were ignored (the file was kept as .corrupt).';
      quarantine(this.path);
      this.seen = this.stamp();
      return;
    }
    if (!isDict(raw) || raw.version !== VERSION) {
      this.warning = 'Saved settings have an unknown format and were ignored.';
      return;
    }
    this.warning = '';
    this.#plainOnDisk = false;
    this.#openKeys(raw);
    this.data = this.#cls().cleanDoc(raw);
    this.#migrateKeys();
  }

  #save(): void {
    if (this.path === null) return;
    this.requireReadable();
    const doc = deepCopy(this.data);
    const plain = doc.agents.betaKeys;
    if (plain && this.keys) {
      const sealed = this.keys.sealAll(plain); // never the plain keys: each one sealed, or kept outside the file
      if (Object.keys(sealed).length) doc.agents.betaKeys = sealed;
      else delete doc.agents.betaKeys;
    } else if (this.keys) this.keys.sealAll({}); // the last key went: its outside copy goes too
    saveJson(this.path, { ...doc, version: VERSION, savedAt: now() }, '.studio-settings-');
    this.#plainOnDisk = false;
    this.seen = this.stamp();
  }

  // ---- reading ----
  snapshot(): Settings {
    this.sync();
    return deepCopy(this.data);
  }

  public(): { revision: string; settings: unknown; warning: string } {
    this.sync();
    const shown = deepCopy(this.data) as unknown as Dict & Settings;
    delete (shown.server as Partial<Settings['server']>).worktreePerChat; // hidden flag: the page sees nothing new
    for (const agent of shown.agents.custom as unknown as Dict[]) agent.env = hiddenEnv(agent.env); // names only
    // Beta agents: the agent list (/api/live/settings agents rows) says which are on and which have a key; never the key itself.
    delete (shown.agents as Partial<Settings['agents']>).beta;
    delete (shown.agents as Partial<Settings['agents']>).betaKeys;
    return { revision: `${this.nonce}.${this.counter}`, settings: shown, warning: this.warning };
  }

  customAgents(): CustomAgent[] {
    return this.snapshot().agents.custom;
  }

  customAgent(agentId: string): CustomAgent | null {
    return this.customAgents().find((a) => a.id === agentId) ?? null;
  }

  /** A Beta agent is off until the person turns it on. */
  betaEnabled(agentId: string): boolean {
    return this.snapshot().agents.beta?.[agentId] === true;
  }

  /** The API key typed for a Beta agent ('' when none). Never sent to the page. */
  betaKey(agentId: string): string {
    const keys = this.snapshot().agents.betaKeys ?? {};
    return Object.prototype.hasOwnProperty.call(keys, agentId) ? keys[agentId] : '';
  }

  builtinEnabled(agentId: string): boolean {
    const builtin = this.snapshot().agents.builtin;
    return Object.prototype.hasOwnProperty.call(builtin, agentId) ? builtin[agentId] : true;
  }

  /** The launcher script saved in Settings for 'claude' or 'codex' ('' when none). */
  launcher(agentId: string): string {
    const launchers = this.snapshot().launchers;
    return Object.prototype.hasOwnProperty.call(launchers, agentId) ? launchers[agentId] : '';
  }

  autoReconnect(): boolean {
    return this.snapshot().server.autoReconnect;
  }

  /** Settings > About > Automatically check for updates (on by default: the owner chose automatic updates). */
  autoUpdateCheck(): boolean {
    return this.snapshot().server.autoUpdateCheck;
  }

  /** Hidden flag (on by default): a new chat in a git project gets its own git worktree. No page control sets it. */
  worktreePerChat(): boolean {
    return this.snapshot().server.worktreePerChat;
  }

  // ---- writing ----
  /**
   * Apply a patch: {agents: {builtin: {omp: bool}, enabled: {id: bool}, upsert: {id?, name, command, args, env, enabled},
   * remove: id}, defaults: {agent, migrated, byAgent: {id: {model, mode} | null}, projects: {key: {agent, model, mode} | null}},
   * server: {...}, editors: {default}, appearance: {defaultView}, launchers: {claude, codex}}. Nothing is saved unless the whole
   * patch is valid. Resolves true when something changed.
   */
  async update(body: unknown): Promise<boolean> {
    if (!isDict(body) || !Object.keys(body).length) throw new ValueError('Invalid request');
    // A new API key goes into the Keychain / keyring first (that needs an async child); the save below then writes its marker.
    const typed = isDict(body.agents) && isDict(body.agents.betaKey) ? body.agents.betaKey : {};
    if (this.keys) {
      for (const [agentId, key] of Object.entries(typed)) {
        const cleaned = isStr(key) ? this.#cls().betaKeyValue(key) : '';
        if (cleaned && betaAgent(agentId)?.signin.keyEnv) await this.keys.prepare(agentId, cleaned);
      }
    }
    return this.#update(body);
  }

  #update(body: Dict): Promise<boolean> {
    const known = ['agents', 'defaults', 'server', 'editors', 'appearance', 'launchers'];
    const unknown = Object.keys(body).filter((key) => !known.includes(key));
    if (unknown.length) {
      return Promise.reject(new ValueError('Unknown settings section: ' + unknown.map((k) => clip(k, 30)).sort(pyCompare).join(', ')));
    }
    return this.locked(() => {
      this.sync();
      let work = deepCopy(this.data);
      this.#applyAgents(work, body.agents);
      this.#applyDefaults(work, body.defaults);
      this.#applyServer(work, body.server);
      this.#applyEditors(work, body.editors);
      this.#applyAppearance(work, body.appearance);
      this.#applyLaunchers(work, body.launchers);
      work = this.#cls().cleanDoc(work); // one last pass: what is kept is exactly what a reload would give
      if (sameJson(work, this.data)) return false;
      const before = this.data;
      this.data = work;
      try {
        this.#save();
      } catch (error) {
        if (!isOSError(error)) throw error;
        this.data = before;
        this.warning = `AIB could not save settings: ${errorText(error)}`;
        throw new ValueError(this.warning);
      }
      this.warning = '';
      this.counter++;
      return true;
    });
  }

  #applyAgents(work: Settings, value: unknown): void {
    const patch = section(value, 'agents');
    if (unknownKeys(patch, ['builtin', 'enabled', 'upsert', 'remove', 'betaKey'])) throw new ValueError('Unknown agents setting');
    for (const [agentId, enabled] of Object.entries(section(patch.enabled, 'agents'))) { // on/off only: nothing else is touched
      if (typeof enabled !== 'boolean') throw new ValueError('Agents can only be turned on or off');
      if (isBuiltin(agentId)) {
        work.agents.builtin[agentId] = enabled;
        continue;
      }
      if (isBeta(agentId)) {
        if (enabled) (work.agents.beta ??= {})[agentId] = true;
        else if (work.agents.beta) delete work.agents.beta[agentId];
        continue;
      }
      const target = work.agents.custom.find((a) => a.id === agentId);
      if (!target) throw new ValueError('That agent is not in the list');
      target.enabled = enabled;
    }
    for (const [agentId, enabled] of Object.entries(section(patch.builtin, 'agents'))) {
      if (!isBuiltin(agentId) || typeof enabled !== 'boolean') throw new ValueError('Built-in agents can only be turned on or off');
      work.agents.builtin[agentId] = enabled;
    }
    for (const [agentId, key] of Object.entries(section(patch.betaKey, 'agents'))) { // {id: 'key'} sets it, {id: '' | null} clears it
      const agent = betaAgent(agentId);
      if (!agent || !agent.signin.keyEnv) throw new ValueError('That agent does not take an API key');
      if (key === null || key === '') {
        if (work.agents.betaKeys) delete work.agents.betaKeys[agentId];
        continue;
      }
      const cleaned = this.#cls().betaKeyValue(key);
      if (!cleaned) throw new ValueError('The API key must be one line of text');
      (work.agents.betaKeys ??= {})[agentId] = cleaned;
    }
    const custom = work.agents.custom;
    if ('remove' in patch) {
      const target = patch.remove;
      if (isBuiltin(target) || isBeta(target)) throw new ValueError('Built-in agents cannot be removed; turn them off instead');
      if (!custom.some((a) => sameJson(a.id, target))) throw new ValueError('That agent is not in the list');
      work.agents.custom = custom.filter((a) => !sameJson(a.id, target));
      for (const choice of Object.values(work.defaults.projects)) {
        if (choice.agent === target) choice.agent = '';
      }
      if (isStr(target)) delete work.defaults.byAgent[target];
      if (work.defaults.agent === target) work.defaults.agent = '';
    }
    if ('upsert' in patch) {
      const list = work.agents.custom;
      const raw = patch.upsert;
      if (!isDict(raw)) throw new ValueError('Invalid agent');
      let existing: CustomAgent | null = null;
      if (raw.id !== null && raw.id !== undefined) {
        existing = list.find((a) => sameJson(a.id, raw.id)) ?? null;
        if (existing === null) throw new ValueError('That agent is not in the list');
      } else if (list.length >= MAX_AGENTS) {
        throw new ValueError(`At most ${MAX_AGENTS} added agents`);
      }
      const taken = list.map((a) => a.id);
      const cleaned = cleanAgent(raw, taken, existing as unknown as Dict | null, true);
      const names = new Set([
        ...list.filter((a) => a !== existing).map((a) => a.name.toLowerCase()),
        ...Object.values(BUILTIN_NAMES).map((n) => n.toLowerCase()),
        ...Object.values(BETA_NAMES).map((n) => n.toLowerCase()),
      ]);
      if (names.has(cleaned.name.toLowerCase())) throw new ValueError('Another agent already has that name');
      if (existing === null) list.push(cleaned);
      else list[list.indexOf(existing)] = cleaned;
    }
  }

  #applyDefaults(work: Settings, value: unknown): void {
    const patch = section(value, 'defaults');
    if (unknownKeys(patch, ['agent', 'byAgent', 'projects', 'migrated'])) throw new ValueError('Unknown defaults setting');
    const target = work.defaults;
    if ('agent' in patch) {
      if (!isStr(patch.agent) || (patch.agent !== '' && !isProvider(patch.agent))) throw new ValueError('Choose an agent');
      target.agent = patch.agent;
    }
    if ('migrated' in patch) {
      if (typeof patch.migrated !== 'boolean') throw new ValueError('Invalid migrated flag');
      target.migrated = patch.migrated;
    }
    for (const [key, choice] of entriesOf(section(patch.byAgent, 'defaults'))) {
      if (!isProvider(key) || !(choice === null || isDict(choice))) throw new ValueError('Invalid agent default');
      this.#mergeChoice(target.byAgent, key, choice, false);
    }
    const projects = section(patch.projects, 'defaults');
    if (Object.keys(projects).length > 50) throw new ValueError('Too many project defaults at once');
    for (const [key, choice] of entriesOf(projects)) {
      if (ProjectPrefs.key(key) === null || !(choice === null || isDict(choice))) throw new ValueError('Invalid project default');
      this.#mergeChoice(target.projects, key, choice, true);
    }
    if (Object.keys(target.projects).length > this.#cls().MAX_PROJECTS) throw new ValueError('Too many projects with saved defaults');
  }

  #mergeChoice(store: Record<string, Choice>, key: string, value: Dict | null, withAgent: boolean): void {
    const has = Object.prototype.hasOwnProperty.call(store, key);
    if (value === null) {
      if (has) delete store[key];
      return;
    }
    const current: Dict = { ...(has ? store[key] : {}) };
    for (const field of withAgent ? ['model', 'mode', 'agent'] : ['model', 'mode']) {
      if (field in value) {
        if (!isStr(value[field])) throw new ValueError(`Invalid ${field}`);
        if (field === 'agent' && value[field] !== '' && !isProvider(value[field])) throw new ValueError('Choose an agent');
        current[field] = value[field];
      }
    }
    const cleaned = this.#cls().choice(current, withAgent);
    if (cleaned) put(store, key, cleaned);
    else if (has) delete store[key];
  }

  #applyEditors(work: Settings, value: unknown): void {
    const patch = section(value, 'editors');
    if (unknownKeys(patch, ['default'])) throw new ValueError('Unknown editors setting');
    if ('default' in patch) {
      if (patch.default !== '' && !(isStr(patch.default) && EDITOR_IDS.includes(patch.default))) {
        throw new ValueError('Choose VS Code, Cursor, Windsurf or Devin');
      }
      work.editors.default = patch.default as string;
    }
  }

  #applyAppearance(work: Settings, value: unknown): void {
    const patch = section(value, 'appearance');
    if (unknownKeys(patch, ['defaultView'])) throw new ValueError('Unknown appearance setting');
    if ('defaultView' in patch) {
      // "prompts" is for finding something: a switch-to view, never a default
      if (!(isStr(patch.defaultView) && this.#cls().DEFAULT_VIEWS.includes(patch.defaultView))) {
        throw new ValueError('Choose Full or Chat as the default chat view');
      }
      work.appearance.defaultView = patch.defaultView;
    }
  }

  #applyLaunchers(work: Settings, value: unknown): void {
    const patch = section(value, 'launchers');
    if (unknownKeys(patch, Object.keys(work.launchers))) throw new ValueError('Unknown launcher');
    for (const [key, item] of Object.entries(patch)) {
      if (item === null || item === '') {
        work.launchers[key] = '';
        continue;
      }
      const text = this.#cls().launcherPath(item);
      const path = text ? expandUser(text) : null;
      if (path === null || !isAbsolute(path) || !isFile(path)) {
        throw new ValueError('The launcher must be the full path of an existing script file');
      }
      work.launchers[key] = pathStr(path);
    }
  }

  #applyServer(work: Settings, value: unknown): void {
    const patch = section(value, 'server');
    if (unknownKeys(patch, ['autoReconnect', 'worktreePerChat', 'autoUpdateCheck'])) throw new ValueError('Unknown server setting');
    if ('worktreePerChat' in patch) {
      if (typeof patch.worktreePerChat !== 'boolean') throw new ValueError('worktreePerChat must be true or false');
      work.server.worktreePerChat = patch.worktreePerChat;
    }
    if ('autoUpdateCheck' in patch) {
      if (typeof patch.autoUpdateCheck !== 'boolean') throw new ValueError('autoUpdateCheck must be true or false');
      work.server.autoUpdateCheck = patch.autoUpdateCheck;
    }
    if ('autoReconnect' in patch) {
      if (typeof patch.autoReconnect !== 'boolean') throw new ValueError('autoReconnect must be true or false');
      work.server.autoReconnect = patch.autoReconnect;
    }
  }
}

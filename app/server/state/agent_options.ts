/**
 * The model, mode and effort lists each agent reported, remembered in the state folder so the New chat page can offer them before
 * a session exists (Deno only, no Python counterpart). Written by the Studio whenever a session reports its settings (a new chat, a
 * reopened one, a settings change, a quiet probe); read through POST /api/live/agent-options.
 *
 * Kept per agent and per (agent, project folder): a folder's own entry wins (project settings can change what an agent offers),
 * else the agent's latest entry from any folder. `current` is the value a NEW session starts with (the agent's default there): it is
 * taken only from a session/new reply, before any pick is applied, so the page can say what "Default" means.
 *
 *   agent-options.json: {"version": 1, "agents": {id: Entry}, "folders": {"<id>|<folder key>": Entry}}
 *   Entry: {"updatedAt": seconds, "model"?: List, "mode"?: List, "effort"?: List}
 *   List:  {"kind": "config" | "mode", "configId"?: str, "current"?: str, "choices": [{"value", "name", "description"?, "group"?}]}
 */
import { writeJsonAtomic } from '../core/fs.ts';
import { getLogger } from '../core/log.ts';

const log = getLogger('agent-options');

type Json = Record<string, unknown>;
export interface Choice {
  value: string;
  name: string;
  description?: string;
  group?: string;
}
export interface OptionList {
  kind: 'config' | 'mode';
  configId?: string;
  current?: string;
  choices: Choice[];
}
export interface Entry {
  updatedAt: number;
  model?: OptionList;
  mode?: OptionList;
  effort?: OptionList;
}
export type Kind = 'model' | 'mode' | 'effort';
export const KINDS: readonly Kind[] = ['model', 'mode', 'effort'];

export const FILE = 'agent-options.json';
export const MAX_CHOICES = 200;
export const MAX_FOLDERS = 300;
const MAX_TEXT = 300;

const isDict = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, n = 120) => (typeof v === 'string' ? [...v].slice(0, n).join('') : '');

/** "C:\\Repos\\App\\", "c:/repos/app" -> one key; POSIX paths keep their case (agent-choice.js projectKey). '' for no folder. */
export function folderKey(cwd: unknown): string {
  const raw = typeof cwd === 'string' ? cwd.trim() : '';
  if (!raw) return '';
  const p = raw.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return /^[a-zA-Z]:/.test(p) || raw.includes('\\') ? 'w:' + p.toLowerCase() : 'p:' + p;
}

const isSelect = (o: unknown): o is Json =>
  isDict(o) && typeof o.id === 'string' && (o.type === 'select' || (o.type === undefined && Array.isArray(o.options)));

function choicesOf(option: Json): Choice[] {
  const out: Choice[] = [];
  const add = (o: unknown, group: string) => {
    if (!isDict(o) || typeof o.value !== 'string' || !o.value || out.length >= MAX_CHOICES) return;
    const c: Choice = { value: text(o.value, MAX_TEXT), name: text(o.name, 80) || text(o.value, 80) };
    const d = text(o.description, 200);
    if (d) c.description = d;
    if (group) c.group = group;
    out.push(c);
  };
  for (const item of Array.isArray(option.options) ? option.options : []) {
    if (isDict(item) && Array.isArray(item.options)) {
      const group = text(item.name, 60) || text(item.group, 60);
      for (const o of item.options) add(o, group);
    } else add(item, '');
  }
  return out;
}

/** The select option of this kind among the advertised config options, or null (composer-chips.js uses the same tests). */
export function findOption(settings: unknown, kind: Kind): Json | null {
  const list = isDict(settings) && Array.isArray(settings.configOptions) ? settings.configOptions : [];
  const test = (o: Json) =>
    kind === 'model'
      ? o.category === 'model' || o.id === 'model'
      : kind === 'mode'
      ? o.category === 'mode' || o.id === 'mode'
      : o.category === 'thought_level' || /^(effort|reasoning|thought|thinking)/i.test(String(o.id));
  for (const o of list) if (isSelect(o) && test(o) && choicesOf(o).length) return o;
  return null;
}

/** The session modes (availableModes) when the agent advertises them. */
function sessionModes(settings: unknown): Json[] {
  const modes = isDict(settings) && isDict(settings.modes) ? settings.modes : null;
  return modes && Array.isArray(modes.availableModes)
    ? modes.availableModes.filter((m) => isDict(m) && typeof m.id === 'string' && m.id)
    : [];
}

/** The model / mode / effort lists in a session's settings (session/new reply plus later updates). Pure. */
export function extract(settings: unknown): Omit<Entry, 'updatedAt'> {
  const out: Omit<Entry, 'updatedAt'> = {};
  for (const kind of ['model', 'effort'] as const) {
    const o = findOption(settings, kind);
    if (o) out[kind] = { kind: 'config', configId: String(o.id), current: text(o.currentValue, MAX_TEXT), choices: choicesOf(o) };
  }
  const modes = sessionModes(settings);
  if (modes.length) {
    const current = isDict(settings) && isDict(settings.modes) ? text(settings.modes.currentModeId, MAX_TEXT) : '';
    out.mode = {
      kind: 'mode',
      current,
      choices: modes.slice(0, MAX_CHOICES).map((m) => {
        const c: Choice = { value: text(m.id, MAX_TEXT), name: text(m.name, 80) || text(m.id, 80) };
        const d = text(m.description, 200);
        if (d) c.description = d;
        return c;
      }),
    };
  } else {
    const o = findOption(settings, 'mode');
    if (o) out.mode = { kind: 'config', configId: String(o.id), current: text(o.currentValue, MAX_TEXT), choices: choicesOf(o) };
  }
  for (const kind of KINDS) if (out[kind] && !out[kind]!.current) delete out[kind]!.current;
  return out;
}

export class AgentOptionsCache {
  readonly path: string | null;
  agents: Record<string, Entry> = {};
  folders: Record<string, Entry> = {};
  /** Tests replace this (seconds). */
  clock: () => number = () => Date.now() / 1000;

  constructor(stateDir: string | null) {
    this.path = stateDir ? `${stateDir}${stateDir.includes('\\') ? '\\' : '/'}${FILE}` : null;
    this.#load();
  }

  #load(): void {
    if (!this.path) return;
    try {
      const raw = JSON.parse(Deno.readTextFileSync(this.path));
      if (isDict(raw) && isDict(raw.agents)) this.agents = raw.agents as Record<string, Entry>;
      if (isDict(raw) && isDict(raw.folders)) this.folders = raw.folders as Record<string, Entry>;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) log.warning(`Remembered model lists could not be read: ${error}`);
    }
  }

  #save(): void {
    if (!this.path) return;
    try {
      writeJsonAtomic(this.path, { version: 1, agents: this.agents, folders: this.folders });
    } catch (error) {
      log.warning(`Remembered model lists could not be saved: ${error}`);
    }
  }

  /**
   * Remember what a session of this agent reports. fresh=true: the settings are a session/new reply before any pick was applied,
   * so their current values are the agent's defaults. Otherwise the current values already remembered are kept. true = written.
   */
  record(agent: string, cwd: unknown, settings: unknown, fresh = false): boolean {
    if (!agent) return false;
    const found = extract(settings);
    if (!KINDS.some((k) => found[k])) return false;
    let changed = false;
    const merge = (before: Entry | undefined): Entry => {
      const next: Entry = { ...(before ?? {}), updatedAt: before?.updatedAt ?? 0 };
      for (const kind of KINDS) {
        const list = found[kind];
        if (!list) continue;
        const keep = before?.[kind]?.current;
        const merged: OptionList = { ...list };
        if (!fresh) {
          if (keep) merged.current = keep;
          else delete merged.current;
        }
        next[kind] = merged;
      }
      const { updatedAt: _a, ...a } = before ?? { updatedAt: 0 };
      const { updatedAt: _b, ...b } = next;
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        next.updatedAt = this.clock();
        changed = true;
      }
      return next;
    };
    this.agents[agent] = merge(this.agents[agent]);
    const key = folderKey(cwd);
    if (key) {
      const fk = `${agent}|${key}`;
      const entry = merge(this.folders[fk]);
      delete this.folders[fk]; // newest last, so the oldest go first below
      this.folders[fk] = entry;
      const keys = Object.keys(this.folders);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_FOLDERS))) delete this.folders[k];
    }
    if (changed) this.#save();
    return changed;
  }

  /** What a new chat of this agent in this folder can offer: the folder's own entry, else the agent's. null when never seen. */
  lookup(agent: string, cwd: unknown): (Entry & { source: 'folder' | 'agent' }) | null {
    const key = folderKey(cwd);
    const mine = key ? this.folders[`${agent}|${key}`] : undefined;
    if (isDict(mine)) return { ...mine, source: 'folder' };
    const any = this.agents[agent];
    return isDict(any) ? { ...any, source: 'agent' } : null;
  }
}

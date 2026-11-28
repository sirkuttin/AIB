/**
 * Per-project tool servers (owner 2026-11-27): which MCP servers, and which single tools of them, a project's chats load.
 *
 * AIB's own state, <state>/tool-servers.json, never the user's agent config files (those are only READ, discover.ts):
 *   { v: 1,
 *     projects:   { <projectKey>: Choice },        a project with no entry loads everything (what it did before this feature)
 *     newProjects: Choice,                          what a project added from now on starts with (a seeded copy, seedProject)
 *     seen:       { <server>: { tools: [names], at } },   tool names a chat of any project saw this server offer
 *     memory:     { <server>: { procs, mb, at } } }       measured from real runs (toolservers/measure.ts)
 *   Choice = { servers: { <server>: boolean }, offLocal?: true, tools: { <server>: [tool names that are OFF] } }
 * A server with no explicit switch follows the rule: `offLocal` turns servers that run on this PC (stdio) off and leaves remote ones
 * (http/sse, claude.ai connectors) on. AIB's own tools are never in a Choice: always on, locked.
 */
import { readJsonFile, saveJson } from '../state/json.ts';
import { pathOf } from '../state/paths.ts';
import { isDict } from '../core/py.ts';
import { createHash } from 'node:crypto';

export const FILE = 'tool-servers.json';
/** Owner decision 2026-11-27: a new project starts with servers that run on this PC off and remote ones on. */
export const NEW_PROJECT_CHOICE: Choice = { servers: {}, offLocal: true, tools: {} };

export interface Choice {
  servers: Record<string, boolean>;
  offLocal?: boolean;
  tools: Record<string, string[]>;
}
export interface ServerRef {
  id: string;
  kind: 'local' | 'remote';
}
export interface Seen {
  tools: string[];
  at: number;
}
export interface Memory {
  procs: number;
  mb: number;
  at: number;
}
interface Doc {
  v: 1;
  projects: Record<string, Choice>;
  newProjects?: Choice;
  seen: Record<string, Seen>;
  memory: Record<string, Memory>;
}

const MAX_PROJECTS = 500;
const MAX_NAME = 200;
const MAX_TOOLS = 2000;
const bad = (name: string) => name === '__proto__' || name === 'constructor' || name === 'prototype';

const names = (v: unknown): string[] =>
  Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= MAX_NAME && !bad(x)))].slice(
      0,
      MAX_TOOLS,
    )
    : [];

export function cleanChoice(raw: unknown): Choice {
  const out: Choice = { servers: {}, tools: {} };
  if (!isDict(raw)) return out;
  if (isDict(raw.servers)) {
    for (const [k, v] of Object.entries(raw.servers)) {
      if (typeof v === 'boolean' && k && k.length <= MAX_NAME && !bad(k)) out.servers[k] = v;
    }
  }
  if (raw.offLocal === true) out.offLocal = true;
  if (isDict(raw.tools)) {
    for (const [k, v] of Object.entries(raw.tools)) {
      const list = names(v);
      if (list.length && k.length <= MAX_NAME && !bad(k)) out.tools[k] = list.sort();
    }
  }
  return out;
}

/** Is the server on in this choice? No choice (a project nobody set): on. */
export function serverOn(choice: Choice | null, server: ServerRef): boolean {
  if (!choice) return true;
  if (Object.hasOwn(choice.servers, server.id)) return choice.servers[server.id];
  return !(choice.offLocal && server.kind === 'local');
}

export function toolsOff(choice: Choice | null, serverId: string): string[] {
  return choice && Object.hasOwn(choice.tools, serverId) ? choice.tools[serverId] : [];
}

/** The servers that are off and the tools that are off in the ones that are on, for these discovered servers. */
export interface Effective {
  off: string[];
  tools: Record<string, string[]>;
}
export function effective(choice: Choice | null, servers: ServerRef[]): Effective {
  const off: string[] = [];
  const tools: Record<string, string[]> = {};
  for (const s of servers) {
    if (!serverOn(choice, s)) off.push(s.id);
    else if (toolsOff(choice, s.id).length) tools[s.id] = [...toolsOff(choice, s.id)];
  }
  return { off: off.sort(), tools };
}

/** A short stable hash of what a chat loads: the staleness test of a running chat against its project's list (host/aib.ts staleWhy). */
export function effectiveHash(e: Effective): string {
  const text = JSON.stringify([e.off, Object.keys(e.tools).sort().map((k) => [k, e.tools[k]])]);
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** What changed between two effective lists, for the chat line: "rea off", "rea on", "rea: 2 tools off". Empty: nothing. */
export function describeChange(before: Effective | null, now: Effective): string {
  const was = before ?? { off: [], tools: {} };
  const off = now.off.filter((s) => !was.off.includes(s));
  const on = was.off.filter((s) => !now.off.includes(s));
  const parts: string[] = [];
  const join = (list: string[]) => list.join(', ');
  if (off.length) parts.push(`${join(off)} off`);
  if (on.length) parts.push(`${join(on)} on`);
  for (const k of Object.keys(now.tools).sort()) {
    const a = now.tools[k], b = was.tools[k] ?? [];
    if (a.join('\n') !== b.join('\n')) parts.push(`${k}: ${a.length} tool${a.length === 1 ? '' : 's'} off`);
  }
  for (const k of Object.keys(was.tools).sort()) {
    if (!(k in now.tools) && !now.off.includes(k) && !off.includes(k)) parts.push(`${k}: all tools on`);
  }
  return parts.join('; ');
}

export class ToolServersStore {
  readonly #path: string;
  #doc: Doc | null = null;
  #sig = '';

  constructor(stateDir: string) {
    this.#path = pathOf(stateDir, FILE);
  }

  #stat(): string {
    try {
      const info = Deno.statSync(this.#path);
      return `${info.size}:${info.mtime?.getTime() ?? 0}`;
    } catch {
      return '';
    }
  }

  #load(): Doc {
    if (this.#doc && this.#stat() === this.#sig) return this.#doc;
    const doc: Doc = { v: 1, projects: {}, seen: {}, memory: {} };
    try {
      const [status, raw] = readJsonFile(this.#path);
      if (status === 'ok' && isDict(raw)) {
        if (isDict(raw.projects)) {
          for (const [k, v] of Object.entries(raw.projects).slice(0, MAX_PROJECTS)) if (!bad(k)) doc.projects[k] = cleanChoice(v);
        }
        if (isDict(raw.newProjects)) doc.newProjects = cleanChoice(raw.newProjects);
        if (isDict(raw.seen)) {
          for (const [k, v] of Object.entries(raw.seen)) {
            if (isDict(v) && !bad(k)) doc.seen[k] = { tools: names(v.tools), at: typeof v.at === 'number' ? v.at : 0 };
          }
        }
        if (isDict(raw.memory)) {
          for (const [k, v] of Object.entries(raw.memory)) {
            if (isDict(v) && typeof v.mb === 'number' && typeof v.procs === 'number' && !bad(k)) {
              doc.memory[k] = { mb: v.mb, procs: v.procs, at: Number(v.at) || 0 };
            }
          }
        }
      }
    } catch { /* unreadable: start clean */ }
    this.#sig = this.#stat();
    return (this.#doc = doc);
  }

  #save(doc: Doc): void {
    saveJson(this.#path, doc, '.tool-servers-');
    this.#doc = doc;
    this.#sig = this.#stat();
  }

  /** The project's saved choice, or null (nobody set it: everything loads). */
  choice(key: string): Choice | null {
    const doc = this.#load();
    return Object.hasOwn(doc.projects, key) ? structuredClone(doc.projects[key]) : null;
  }

  /** What a project added from now on starts with. */
  newProjects(): Choice {
    return structuredClone(this.#load().newProjects ?? NEW_PROJECT_CHOICE);
  }

  has(key: string): boolean {
    return Object.hasOwn(this.#load().projects, key);
  }

  /** A project that is new gets a copy of the New projects list as its own, once. Returns true when it was seeded. */
  seedProject(key: string): boolean {
    const doc = this.#load();
    if (!key || Object.hasOwn(doc.projects, key)) return false;
    doc.projects[key] = this.newProjects();
    this.#save(doc);
    return true;
  }

  /** Change one choice: `key` is a project key or '_new' (New projects). The patch names one thing. Returns the new choice. */
  update(
    key: string,
    patch: { server: string; on?: boolean; tool?: string; toolOn?: boolean; allTools?: { on: boolean; names: string[] } },
  ): Choice {
    if (!key || key.length > 512 || bad(key) || !patch.server || patch.server.length > MAX_NAME || bad(patch.server)) {
      throw new Error('Invalid tool server change');
    }
    const doc = this.#load();
    const current = key === '_new'
      ? doc.newProjects ?? structuredClone(NEW_PROJECT_CHOICE)
      : Object.hasOwn(doc.projects, key)
      ? doc.projects[key]
      : { servers: {}, tools: {} };
    const next = cleanChoice(current);
    if (typeof patch.on === 'boolean') next.servers[patch.server] = patch.on;
    if (patch.tool !== undefined && typeof patch.toolOn === 'boolean') {
      if (!patch.tool || patch.tool.length > MAX_NAME || bad(patch.tool)) throw new Error('Invalid tool name');
      const set = new Set(next.tools[patch.server] ?? []);
      if (patch.toolOn) set.delete(patch.tool);
      else set.add(patch.tool);
      if (set.size) next.tools[patch.server] = [...set].sort();
      else delete next.tools[patch.server];
    }
    if (patch.allTools) {
      const listed = names(patch.allTools.names);
      if (patch.allTools.on) delete next.tools[patch.server];
      else next.tools[patch.server] = listed.sort();
      if (!next.tools[patch.server]?.length) delete next.tools[patch.server];
    }
    if (key === '_new') doc.newProjects = next;
    else {
      if (!Object.hasOwn(doc.projects, key) && Object.keys(doc.projects).length >= MAX_PROJECTS) {
        throw new Error('Too many projects with tool server choices');
      }
      doc.projects[key] = next;
    }
    this.#save(doc);
    return structuredClone(next);
  }

  /** A chat saw these tool names from a server: kept for the tool list ("from this server's last start"). */
  sawTools(server: string, tools: string[], at = Date.now()): void {
    if (!server || server.length > MAX_NAME || bad(server)) return;
    const doc = this.#load();
    const had = doc.seen[server]?.tools ?? [];
    const union = names([...had, ...tools]);
    if (union.length === had.length) return;
    doc.seen[server] = { tools: union.sort(), at };
    this.#save(doc);
  }

  seen(server: string): Seen | null {
    const s = this.#load().seen[server];
    return s ? { tools: [...s.tools], at: s.at } : null;
  }

  /** A measurement from a real run: the processes of this server under one chat and their working set. Keeps the largest of the recent ones. */
  measured(server: string, procs: number, mb: number, at = Date.now()): void {
    if (!server || server.length > MAX_NAME || bad(server) || !(mb >= 0) || !(procs >= 0)) return;
    const doc = this.#load();
    const was = doc.memory[server];
    if (was && was.procs === procs && Math.abs(was.mb - mb) < 2) return;
    doc.memory[server] = { procs, mb: Math.round(mb), at };
    this.#save(doc);
  }

  memory(server: string): Memory | null {
    const m = this.#load().memory[server];
    return m ? { ...m } : null;
  }
}

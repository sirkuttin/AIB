/**
 * Allow rules: storage in AIB's state folder (allow-rules.json) with a tamper check (architect review 5.1). Worktrees live inside
 * the state folder, so an agent in bypass mode could edit the file directly. AIB keeps the hash of the version it last wrote (in
 * memory, and in allow-rules.sig for the next start). When the file differs, at load or while running, every rule switches off
 * and the page shows a banner until the owner reviews the rules (Settings) and switches them back on. Only the host changes the
 * file, and only through the page-session routes (no MCP tool, no phone route).
 *
 * The decision log (allow-decisions/<chat>.jsonl) records each auto-answer before it is written to the agent, so a keeper replay
 * reads it and never runs the matcher again (review 6.1).
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeJsonAtomic } from '../core/fs.ts';
import type { AllowRule, Builtins } from './matcher.ts';

export interface RulesFile {
  version: 1;
  enabled: boolean;
  builtins: Builtins;
  rules: AllowRule[];
}

const EMPTY: RulesFile = { version: 1, enabled: true, builtins: { safeReads: true, syntax: true, scratch: true }, rules: [] };

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export class AllowStore {
  readonly path: string;
  readonly sigPath: string;
  #data: RulesFile = structuredClone(EMPTY);
  #hash = '';
  #mtime = 0;
  /** The file changed outside AIB: rules are off until reviewed. */
  tampered = false;
  /** Rule ids removed by Undo or Delete, kept for one Restore. */
  #removed = new Map<string, AllowRule>();

  constructor(readonly stateDir: string) {
    this.path = join(stateDir, 'allow-rules.json');
    this.sigPath = join(stateDir, 'allow-rules.sig');
    this.#load();
  }

  #load(): void {
    let text = '';
    try {
      text = Deno.readTextFileSync(this.path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      this.#data = structuredClone(EMPTY);
      this.#hash = '';
      return;
    }
    let sig = '';
    try {
      sig = Deno.readTextFileSync(this.sigPath).trim();
    } catch { /* none */ }
    this.#hash = hash(text);
    this.#mtime = this.#statMtime();
    this.#data = parse(text);
    if (sig !== this.#hash) this.tampered = true;
  }

  #statMtime(): number {
    try {
      return Deno.statSync(this.path).mtime?.getTime() ?? 0;
    } catch {
      return -1;
    }
  }

  /** Re-check the file (cheap: stat, then hash when the time changed). */
  check(): void {
    const mtime = this.#statMtime();
    if (mtime === this.#mtime) return;
    this.#mtime = mtime;
    let text = '';
    try {
      text = Deno.readTextFileSync(this.path);
    } catch {
      if (this.#hash) this.tampered = true; // deleted outside AIB
      return;
    }
    if (hash(text) !== this.#hash) {
      this.tampered = true;
      this.#data = parse(text);
      this.#hash = hash(text);
    }
  }

  #save(): void {
    const text = JSON.stringify(this.#data, null, 1);
    writeJsonAtomic(this.path, null, { text, prefix: '.allow-rules-' });
    this.#hash = hash(text);
    writeJsonAtomic(this.sigPath, null, { text: this.#hash, prefix: '.allow-sig-' });
    this.#mtime = this.#statMtime();
  }

  /** Rules in force now (none while off or tampered). */
  active(): { rules: AllowRule[]; builtins: Builtins } | null {
    this.check();
    if (this.tampered || !this.#data.enabled) return null;
    return { rules: this.#data.rules, builtins: this.#data.builtins };
  }

  public(): Record<string, unknown> {
    this.check();
    return {
      enabled: this.#data.enabled,
      tampered: this.tampered,
      builtins: { ...this.#data.builtins },
      rules: this.#data.rules.map((r) => ({ ...r })),
    };
  }

  add(rule: Omit<AllowRule, 'id' | 'added'>): AllowRule {
    this.check();
    // The same rule again (a new project pin for a global project-code rule) updates the old one.
    const same = this.#data.rules.find((r) =>
      r.kind === rule.kind && r.scope === rule.scope && (r.project ?? '') === (rule.project ?? '') &&
      JSON.stringify(r.words ?? null) === JSON.stringify(rule.words ?? null) && (r.folder ?? null) === (rule.folder ?? null) &&
      (r.server ?? null) === (rule.server ?? null) && (r.tool ?? null) === (rule.tool ?? null) && (r.host ?? null) === (rule.host ?? null)
    );
    if (same) {
      if (rule.pins) same.pins = { ...same.pins, ...rule.pins };
      this.#save();
      return same;
    }
    const full = { ...rule, id: `r_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`, added: Date.now() } as AllowRule;
    this.#data.rules.push(full);
    this.#save();
    return full;
  }

  remove(id: string): boolean {
    this.check();
    const i = this.#data.rules.findIndex((r) => r.id === id);
    if (i < 0) return false;
    this.#removed.set(id, this.#data.rules[i]);
    this.#data.rules.splice(i, 1);
    this.#save();
    return true;
  }

  restore(id: string): boolean {
    const rule = this.#removed.get(id);
    if (!rule || this.#data.rules.some((r) => r.id === id)) return false;
    this.#removed.delete(id);
    this.#data.rules.push(rule);
    this.#save();
    return true;
  }

  setEnabled(on: boolean): void {
    this.check();
    this.#data.enabled = on;
    this.#save();
  }

  setBuiltin(name: keyof Builtins, on: boolean): void {
    if (!(name in this.#data.builtins)) throw new Error('Unknown built-in rule');
    this.#data.builtins[name] = on;
    this.#save();
  }

  /** The owner reviewed the rules after a change outside AIB: keep what is in the file now, signed as AIB's, and switch on. */
  review(): void {
    let text = '';
    try {
      text = Deno.readTextFileSync(this.path);
    } catch { /* gone: start empty */ }
    this.#data = text ? parse(text) : structuredClone(EMPTY);
    this.tampered = false;
    this.#data.enabled = true;
    this.#save();
  }
}

function parse(text: string): RulesFile {
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object') return structuredClone(EMPTY);
    const b = v.builtins && typeof v.builtins === 'object' ? v.builtins : {};
    return {
      version: 1,
      enabled: v.enabled !== false,
      builtins: { safeReads: b.safeReads !== false, syntax: b.syntax !== false, scratch: b.scratch !== false },
      rules: Array.isArray(v.rules) ? v.rules.filter((r: unknown) => r && typeof r === 'object' && typeof (r as AllowRule).id === 'string') : [],
    };
  } catch {
    return structuredClone(EMPTY);
  }
}

// ---- decision log ----------------------------------------------------------------------------------------------------------

export interface Decision {
  /** JSON rpc id + its use count (#requestsSeen), as the keeper's once-key counts it. */
  key: string;
  optionId: string;
  ruleId: string;
  label: string;
  flagged: boolean;
  time: number;
  /** Answered by the sweep after a rule was saved: the card had already been shown. */
  swept?: boolean;
}

export class DecisionLog {
  #cache = new Map<string, Map<string, Decision>>();
  constructor(readonly dir: string) {}

  #file(chat: string): string {
    return join(this.dir, `${chat.replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`);
  }

  /** Written (and flushed) before the answer goes to the agent. */
  record(chat: string, d: Decision): void {
    Deno.mkdirSync(this.dir, { recursive: true });
    const f = Deno.openSync(this.#file(chat), { append: true, create: true });
    try {
      f.writeSync(new TextEncoder().encode(JSON.stringify(d) + '\n'));
      f.syncSync();
    } finally {
      f.close();
    }
    this.#all(chat).set(d.key, d);
  }

  find(chat: string, key: string): Decision | null {
    return this.#all(chat).get(key) ?? null;
  }

  #all(chat: string): Map<string, Decision> {
    let m = this.#cache.get(chat);
    if (m) return m;
    m = new Map();
    try {
      for (const line of Deno.readTextFileSync(this.#file(chat)).split('\n')) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line) as Decision;
          if (typeof d.key === 'string') m.set(d.key, d);
        } catch { /* a torn last line */ }
      }
    } catch { /* none yet */ }
    this.#cache.set(chat, m);
    return m;
  }

  forget(chat: string): void {
    this.#cache.delete(chat);
  }
}

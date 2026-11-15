/**
 * Allow rules: what a Connection asks of them. One per host (Studio), shared by every chat: the rule store, the decision log and
 * the matcher. Connection.ts calls `decide` for a live request, `log.find` on a keeper replay (never the matcher), and `drafts`
 * for the card's "Always allow" choice.
 */
import { join } from 'node:path';
import { type Draft, match, type MatchContext, type MatchResult, ruleFor } from './matcher.ts';
import { AllowStore, DecisionLog } from './store.ts';

export class AllowGate {
  readonly store: AllowStore;
  readonly log: DecisionLog;
  constructor(readonly stateDir: string) {
    this.store = new AllowStore(stateDir);
    this.log = new DecisionLog(join(stateDir, 'allow-decisions'));
  }

  /** The chat's own scratch folder, outside its worktree (created on first use). */
  scratchFor(chat: string): string {
    const dir = join(this.stateDir, 'scratch', chat.replace(/[^A-Za-z0-9_-]/g, '_'));
    try {
      Deno.mkdirSync(dir, { recursive: true });
    } catch { /* the matcher then finds no scratch folder */ }
    return dir;
  }

  decide(params: unknown, ctx: MatchContext): MatchResult {
    const active = this.store.active();
    if (!active) return { allow: false, reason: this.store.tampered ? 'rules changed outside AIB' : 'rules are off' };
    return match(params, ctx, active.rules, active.builtins);
  }

  /** The card's Always choice, for both scopes. */
  drafts(params: unknown, ctx: MatchContext): { project: Draft; global: Draft; off: string } {
    const pub = this.store.public();
    const builtins = pub.builtins as { safeReads: boolean; syntax: boolean; scratch: boolean };
    const off = pub.tampered ? 'Allow rules are off: the rules file was changed outside AIB. Review them in Settings.' : pub.enabled ? '' : 'Allow rules are switched off in Settings.';
    return { project: ruleFor(params, ctx, 'project', builtins), global: ruleFor(params, ctx, 'global', builtins), off };
  }
}

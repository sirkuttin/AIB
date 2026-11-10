/** Errors and sign-in descriptions from the agent's JSON-RPC replies (rpc_errors.py). */
import { clip, dictOr, isDict, isStr, listOr, pyJsonDumps, pyLen } from '../core/py.ts';

/** A JSON-RPC error response from the agent, keeping its code and data. */
export class RpcError extends Error {
  readonly code: unknown;
  readonly data: unknown;
  constructor(error: unknown) {
    const err = isDict(error) ? error : { message: String(error) };
    super(String(err.message || (isDict(error) ? pyDictRepr(err) : err.message)));
    this.code = err.code ?? null;
    this.data = err.data ?? null;
  }
}

/** str(dict) is only used when an error has no message; good enough to be readable (exact Python repr is not part of any contract). */
function pyDictRepr(value: Record<string, unknown>): string {
  return '{' + Object.entries(value).map(([k, v]) => `'${k}': ${typeof v === 'string' ? `'${v}'` : JSON.stringify(v)}`).join(', ') + '}';
}

export class PromptStateUnknown extends Error {}

const AUTH_WORDS = /auth|log.?in|sign.?in|credential/i;

/** ACP reports missing authentication as code -32000 (auth_required). */
export function isAuthRequired(error: unknown): boolean {
  if (!(error instanceof RpcError)) return false;
  const text = `${error.message} ${error.data !== null && error.data !== undefined ? pyJsonDumps(error.data) : ''}`;
  return (error.code === -32000 && AUTH_WORDS.test(text)) || text.includes('auth_required');
}

export interface AuthMethod {
  id: string;
  name: string;
  description: string;
  kind: 'agent' | 'terminal' | 'env_var' | 'other';
  instructions: string;
}

const text = (value: unknown, limit = 500) => (isStr(value) ? clip(value, limit) : '');

/**
 * Normalize initialize.authMethods. kind 'agent' = the client can call authenticate;
 * anything else is shown as instructions and never executed by Studio.
 */
export function describeAuthMethods(methods: unknown, provider = ''): AuthMethod[] {
  const out: AuthMethod[] = [];
  for (const item of Array.isArray(methods) ? methods.slice(0, 20) : []) {
    if (!isDict(item) || !isStr(item.id) || !item.id || pyLen(item.id) > 256) continue;
    const meta = dictOr(item._meta);
    const term = isDict(meta['terminal-auth']) ? meta['terminal-auth'] : null;
    let kind: AuthMethod['kind'] = 'agent';
    let instructions = '';
    const mtype = item.type;
    if (term !== null || mtype === 'terminal') {
      kind = 'terminal';
      const src = term ?? item;
      const args = listOr(src.args);
      const parts = [...(isStr(src.command) ? [src.command] : []), ...args.filter(isStr)];
      const command = text(parts.slice(0, 20).join(' '), 300);
      if (command) instructions = `Run \`${command}\` in a terminal, complete the sign-in, then choose Retry.`;
      else if (provider === 'claude') instructions = 'Run `claude /login` in a terminal, complete the sign-in, then choose Retry.';
      else instructions = "Complete this sign-in in the agent's own command-line tool, then choose Retry.";
    } else if (mtype === 'env_var') {
      kind = 'env_var';
      const names = listOr(item.vars).filter(isDict).map((v) => v.name).filter(isStr);
      instructions = names.length
        ? 'Set ' + names.slice(0, 10).map((n) => `\`${text(n, 80)}\``).join(', ') +
          ' in the environment that starts the agent, restart Studio, then retry. Studio never asks for secrets.'
        : 'Configure the credentials this agent documents, restart Studio, then retry.';
    } else if (isStr(mtype) && mtype !== 'agent') {
      kind = 'other';
      instructions = "This sign-in type is not supported inside Studio. Complete it with the agent's own tools, then choose Retry.";
    }
    out.push({ id: item.id, name: text(item.name) || item.id, description: text(item.description, 1000), kind, instructions });
  }
  return out;
}

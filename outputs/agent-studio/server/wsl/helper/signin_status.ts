/**
 * `agents.signinStatus` (docs/wsl/linking-design.md section 12): is each agent signed in inside the distro, from its credential files'
 * presence, size and JSON shape only. No agent is started and no secret leaves this module: a token's value is never read into the
 * answer, logged or put in a note (JSON parse errors are not passed on either, since they can quote the file). The only text taken
 * from a file is Claude Code's `oauthAccount.emailAddress` in its `.claude.json` (a display name, not a secret).
 *
 * - Claude Code: `<CLAUDE_CONFIG_DIR or ~/.claude>/.credentials.json` holding a `claudeAiOauth` object = signed in; missing = signed
 *   out. An API key or Bedrock / Vertex switch in the login environment counts as signed in (only the variable's presence is read).
 *   The account is `oauthAccount.emailAddress` of `<CLAUDE_CONFIG_DIR>/.claude.json`, else `~/.claude.json`.
 * - Codex: `<CODEX_HOME or ~/.codex>/auth.json` with a `tokens` object (ChatGPT sign-in) or a non-empty `OPENAI_API_KEY` = signed
 *   in; missing or both empty = signed out. When config.toml keeps the credentials in the system keyring the file says nothing:
 *   'unknown'.
 * - OMP and anything else: 'unknown' (AIB does not know where they keep a sign-in).
 * A file that cannot be read, is too big or is not the expected JSON is 'unknown'.
 */
import { isDict } from '../../core/py.ts';

export const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const ENV_SIGNIN: Record<string, string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_OAUTH_TOKEN'],
};

export type SigninState = 'signed_in' | 'signed_out' | 'unknown';
export interface SigninRow {
  id: string;
  state: SigninState;
  account?: string;
  note?: string;
}

/** A small JSON file as an object: {missing} when not there, {bad} when unreadable / too big / not an object. */
function readSmallJson(path: string): { data?: Record<string, unknown>; missing?: boolean; bad?: boolean } {
  let info: Deno.FileInfo;
  try {
    info = Deno.statSync(path);
  } catch (error) {
    return error instanceof Deno.errors.NotFound ? { missing: true } : { bad: true };
  }
  if (!info.isFile || info.size > MAX_CREDENTIAL_BYTES) return { bad: true };
  if (info.size === 0) return { bad: true };
  try {
    const data = JSON.parse(Deno.readTextFileSync(path));
    return isDict(data) ? { data } : { bad: true };
  } catch {
    return { bad: true };
  }
}

const join = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, '')}/${name}`;

/** A plain e-mail-like display name, or ''. */
export function displayAccount(value: unknown): string {
  if (typeof value !== 'string') return '';
  const v = value.trim();
  return v.length <= 200 && /^[^\s@]+@[^\s@]+$/.test(v) ? v : '';
}

function claudeStatus(env: Record<string, string>, home: string): SigninRow {
  const dir = env.CLAUDE_CONFIG_DIR || (home ? join(home, '.claude') : '');
  if (!dir) return { id: 'claude', state: 'unknown', note: 'The distro user has no home folder.' };
  const account = () => {
    for (const file of [join(dir, '.claude.json'), ...(env.CLAUDE_CONFIG_DIR || !home ? [] : [join(home, '.claude.json')])]) {
      const { data } = readSmallJson(file);
      if (!data) continue;
      const oauth = data.oauthAccount;
      const email = isDict(oauth) ? displayAccount(oauth.emailAddress) : '';
      if (email) return email;
    }
    return '';
  };
  const creds = readSmallJson(join(dir, '.credentials.json'));
  if (creds.data && isDict(creds.data.claudeAiOauth)) {
    const email = account();
    return { id: 'claude', state: 'signed_in', ...(email ? { account: email } : {}) };
  }
  const viaEnv = ENV_SIGNIN.claude.find((k) => (env[k] ?? '') !== '');
  if (viaEnv) return { id: 'claude', state: 'signed_in', note: `Uses ${viaEnv} from the login environment.` };
  if (creds.missing) return { id: 'claude', state: 'signed_out' };
  return { id: 'claude', state: 'unknown', note: "Claude Code's credentials file is not in a form AIB knows." };
}

function codexStatus(env: Record<string, string>, home: string): SigninRow {
  const dir = env.CODEX_HOME || (home ? join(home, '.codex') : '');
  if (!dir) return { id: 'codex', state: 'unknown', note: 'The distro user has no home folder.' };
  const auth = readSmallJson(join(dir, 'auth.json'));
  if (auth.data) {
    const key = auth.data.OPENAI_API_KEY;
    if (isDict(auth.data.tokens) || (typeof key === 'string' && key !== '')) return { id: 'codex', state: 'signed_in' };
    return { id: 'codex', state: 'signed_out' };
  }
  if (auth.missing) {
    let config = '';
    try {
      const path = join(dir, 'config.toml');
      if (Deno.statSync(path).size <= MAX_CREDENTIAL_BYTES) config = Deno.readTextFileSync(path);
    } catch { /* none */ }
    if (/^\s*cli_auth_credentials_store\s*=\s*["'](keyring|auto)["']/m.test(config)) {
      return { id: 'codex', state: 'unknown', note: 'Codex keeps its sign-in in the system keyring here, which AIB does not read.' };
    }
    return { id: 'codex', state: 'signed_out' };
  }
  return { id: 'codex', state: 'unknown', note: "Codex's auth.json is not in a form AIB knows." };
}

export function signinStatus(ids: string[], env: Record<string, string>, home: string): SigninRow[] {
  return ids.map((id) => {
    try {
      if (id === 'claude') return claudeStatus(env, home);
      if (id === 'codex') return codexStatus(env, home);
    } catch {
      return { id, state: 'unknown' as const };
    }
    return {
      id,
      state: 'unknown' as const,
      note: id === 'omp' ? 'AIB cannot tell whether OMP is signed in.' : 'AIB cannot check this agent.',
    };
  });
}

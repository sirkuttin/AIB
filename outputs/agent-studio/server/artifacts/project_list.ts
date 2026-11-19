/**
 * The project's artifacts (GET /api/live/project/artifacts; right panel, Artifacts tab): every artifact of every chat of one project,
 * newest first, pinned on top. An artifact's `project` field is not reliable on its own (nothing on disk is migrated), so the
 * project is computed here, each time the list is read:
 *  - `manifest.project` when set; a worktree's path (a subagent's or helper's copy) maps to the main project folder;
 *  - null (old artifacts, WSL artifacts) falls back to the folder of the chat that made it (conversationId), mapped the same way.
 * A WSL project is its `wsl://<distro>/<path>` ref. Each item gets `chat` (the lasting chat id) and `project` (the folder it was
 * attributed to) next to the usual summary fields.
 */
import { type ArtifactStore, isDeleted, isDocHistory } from './artifacts.ts';
import { wslLocOf } from '../platform/location.ts';

type Json = Record<string, unknown>;

/** How a path or WSL ref is compared: no trailing slash, '/' separators, case folded on Windows (WSL: the distro only). */
export function projectKey(path: unknown): string {
  if (typeof path !== 'string' || !path.trim()) return '';
  const wsl = wslLocOf(path);
  if (wsl) return `wsl://${wsl.distro}${wsl.linuxPath.replace(/\/+$/, '')}`;
  const text = path.trim().replaceAll('\\', '/').replace(/\/+$/, '');
  return Deno.build.os === 'windows' ? text.toLowerCase() : text;
}

export interface ProjectDeps {
  /** A folder (a worktree's included) to its main project folder; the folder itself when it is not a worktree. */
  mainOf(path: string): string;
  /** The folder a chat (lasting id) runs in, or null when unknown. May be slow: called once per chat with an untagged artifact. */
  chatFolder(chat: string): Promise<string | null>;
}

/** At most this many untagged chats are looked up per read (each is a transcript or helper lookup). */
const MAX_LOOKUPS = 80;

export async function projectArtifacts(
  store: ArtifactStore,
  folder: string,
  deps: ProjectDeps,
  options: { deleted?: boolean } = {},
): Promise<{ project: string; artifacts: Json[] }> {
  const target = projectKey(deps.mainOf(folder));
  const chatProject = new Map<string, string>();
  const all = store.all().filter((m) => !isDocHistory(m) && (options.deleted || !isDeleted(m)));
  const attributed = new Map<string, string>(); // artifact id -> its project key
  const tagged = (m: Json): string => {
    const raw = typeof m.project === 'string' ? m.project : '';
    return raw ? projectKey(deps.mainOf(raw)) : '';
  };
  let lookups = 0;
  for (const m of all) {
    let key = tagged(m);
    const chat = typeof m.conversationId === 'string' ? m.conversationId : '';
    if (!key && chat) {
      if (!chatProject.has(chat) && lookups < MAX_LOOKUPS) {
        lookups++;
        let found = '';
        try {
          const where = await deps.chatFolder(chat);
          found = where ? projectKey(deps.mainOf(where)) : '';
        } catch { /* an unknown chat: its artifacts are left out of every project */ }
        chatProject.set(chat, found);
      }
      key = chatProject.get(chat) ?? '';
    }
    attributed.set(String(m.id), key);
  }
  const mine = all.filter((m) => target && attributed.get(String(m.id)) === target);
  mine.sort((a, b) => (Number(!a.pinned) - Number(!b.pinned)) || (Number(b.updatedAt) - Number(a.updatedAt)));
  return {
    project: target,
    artifacts: mine.map((m) => ({ ...store.summary(m), chat: m.conversationId ?? null, project: attributed.get(String(m.id)) })),
  };
}

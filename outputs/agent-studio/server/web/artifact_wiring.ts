/**
 * The web server's artifacts (studio.create_server's artifact block): the store under <state-dir>/artifacts, the separate artifact
 * origin (Studio port + 1), the Service behind /api/live/artifacts* and the Watcher that turns files a chat's agent wrote into its
 * artifacts. A chat's artifacts are keyed by its lasting id ("provider:sessionId"), not the live connection id.
 *
 * Python asks the agent host for the connection list synchronously inside chat_of/connection_of; the Service and Watcher here are
 * synchronous too, so they read a cached list (and the agents' write lists) that is refreshed before each artifact request and on
 * the watcher's tick. A chat's project folder (cwdFor) is looked up asynchronously before the request and read from a small cache.
 */
import { ArtifactStore, Service, type WatchedConversation, Watcher } from '../artifacts/artifacts.ts';
import { OriginServer } from '../artifacts/origin.ts';
import { HostUnavailable } from '../host/host_client.ts';
import type { LiveBackend } from '../host/backend.ts';
import { artifactFolder, type ChatStudio } from '../worktrees/chat_folders.ts';

type Json = Record<string, unknown>;
const sep = Deno.build.os === 'windows' ? '\\' : '/';

export class Artifacts {
  readonly store: ArtifactStore;
  readonly service: Service;
  readonly watcher: Watcher;
  origin: OriginServer | null = null;
  #connections: Json[] = [];
  #writes: Record<string, unknown> = {};
  #cwd = new Map<string, string | null>();
  #refreshing: Promise<void> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(stateDir: string, readonly host: LiveBackend, tokenGetter: () => string, readonly chatStudio: () => ChatStudio) {
    this.store = new ArtifactStore(stateDir + sep + 'artifacts');
    this.service = new Service(this.store, tokenGetter, (ident) => this.#cwd.get(ident) ?? null, {
      emit: (chat, data) => this.emitToChat(chat, data),
      chatOf: (ident) => this.chatOf(ident),
      rootFor: (ident) => this.projectRootOf(ident),
    });
    this.watcher = new Watcher(this.service, () => this.conversations());
  }

  /** Open the artifact origin next to the web server's port and start the watcher. Returns the origin's port. */
  start(studioPort: number): number {
    this.origin = OriginServer.start(this.store.root, studioPort);
    this.store.origin = this.origin.url;
    this.#timer = setInterval(() => void this.refresh(true).catch(() => {}), 2000);
    Deno.unrefTimer(this.#timer);
    this.watcher.start();
    return this.origin.port;
  }

  async stop(): Promise<void> {
    this.watcher.stop();
    if (this.#timer !== null) clearInterval(this.#timer);
    await this.origin?.stop().catch(() => {});
  }

  /** Re-read the open connections (and, with writes, what each one's agent wrote) from the agent host. One refresh at a time. */
  refresh(writes = false): Promise<void> {
    this.#refreshing ??= (async () => {
      try {
        const listed = (await this.host.liveList()).connections;
        this.#connections = (Array.isArray(listed) ? listed : []).filter((c): c is Json => !!c && typeof c === 'object' && !c.closed);
        if (writes) {
          const written = await this.host.liveWrites();
          this.#writes = written && typeof written === 'object' && !Array.isArray(written) ? written as Record<string, unknown> : {};
        }
      } finally {
        this.#refreshing = null;
      }
    })();
    return this.#refreshing;
  }

  openConnections(): Json[] {
    return this.#connections;
  }

  chatOf(ident: string): string {
    for (const c of this.#connections) {
      if (c.id === ident && c.provider && c.sessionId) return `${c.provider}:${c.sessionId}`;
    }
    return ident;
  }

  connectionOf(ident: string): string | null {
    for (const c of this.#connections) {
      if (c.id === ident || (c.provider && c.sessionId && `${c.provider}:${c.sessionId}` === ident)) return (c.id as string) ?? null;
    }
    return null;
  }

  emitToChat(chat: string, data: Json): boolean {
    const target = this.connectionOf(chat);
    if (!target) return false;
    void this.host.emitArtifact(target, { ...data, conversationId: target }).catch(() => false);
    return true;
  }

  /** The chat's projectRoot (what its artifacts are tagged with): a live connection's, else null, which means its cwd. */
  projectRootOf(ident: string): string | null {
    const target = this.connectionOf(ident);
    for (const c of this.#connections) {
      if (target && c.id === target) return (c.projectRoot as string) || null;
    }
    return null;
  }

  /** 'writes': the files each chat's own agent wrote. Chats with several connections (a reconnect) merge their lists. */
  conversations(): WatchedConversation[] {
    const merged = new Map<string, WatchedConversation & { writes: string[] }>();
    for (const c of this.#connections) {
      const chat = this.chatOf(c.id as string);
      let entry = merged.get(chat);
      if (!entry) {
        entry = { id: chat, cwd: c.cwd as string, projectRoot: ((c.projectRoot || c.cwd) as string) ?? null, writes: [] };
        merged.set(chat, entry);
      }
      const written = this.#writes[c.id as string];
      for (const path of Array.isArray(written) ? written : []) {
        if (typeof path === 'string' && !entry.writes.includes(path)) entry.writes.push(path);
      }
    }
    return [...merged.values()];
  }

  /**
   * Before a request: refresh the connection list, and for a POST naming a chat look up that chat's project folder (Python's
   * cwd_for: artifact_folder(studio, connection_of(ident) or ident), called with the lasting chat id). `strict`: a host failure
   * fails the request (503), as it does in Python for the routes that list connections; otherwise the cached list is kept.
   */
  async prepare(strict: boolean, conversationId: unknown): Promise<void> {
    try {
      await this.refresh();
    } catch (error) {
      if (strict && error instanceof HostUnavailable) throw error;
    }
    if (typeof conversationId === 'string' && conversationId && conversationId.length <= 600) {
      const chat = this.service.chat(conversationId);
      this.#cwd.set(chat, await artifactFolder(this.chatStudio(), this.connectionOf(chat) || chat));
      if (this.#cwd.size > 200) this.#cwd.delete(this.#cwd.keys().next().value!);
    }
  }
}

/**
 * A short memory for the answers of polled routes (docs list, files list, project changes, WSL status). The page polls these from
 * every window and for every chat, and each answer walks folders or runs git: many askers within a moment get ONE answer.
 *   - one run per key at a time (a second asker waits for the first run's answer, never starts its own);
 *   - the answer is kept for `ttlMs` after it was made, so a burst of polls costs one run;
 *   - a failure is never kept;
 *   - clearMemos() drops every answer (any write the page or an agent makes through AIB calls it: the next read is fresh).
 * The oldest keys go past `max`.
 */
const all = new Set<Memo<unknown>>();

export class Memo<T> {
  readonly #runs = new Map<string, { at: number; done: boolean; promise: Promise<T> }>();

  constructor(readonly ttlMs: number, readonly max = 200) {
    all.add(this as Memo<unknown>);
  }

  get(key: string, run: () => Promise<T>): Promise<T> {
    const hit = this.#runs.get(key);
    if (hit && (!hit.done || Date.now() - hit.at < this.ttlMs)) return hit.promise;
    const entry = { at: Date.now(), done: false, promise: null as unknown as Promise<T> };
    entry.promise = run().then(
      (value) => {
        entry.at = Date.now();
        entry.done = true;
        return value;
      },
      (error) => {
        if (this.#runs.get(key) === entry) this.#runs.delete(key);
        throw error;
      },
    );
    this.#runs.delete(key);
    this.#runs.set(key, entry);
    while (this.#runs.size > this.max) this.#runs.delete(this.#runs.keys().next().value as string);
    return entry.promise;
  }

  clear(): void {
    this.#runs.clear();
  }
}

/** Forget every kept answer of every Memo. */
export function clearMemos(): void {
  for (const memo of all) memo.clear();
}

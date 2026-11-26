/**
 * threading.Event and the text-mode line splitter the Connection reads agent pipes with. Moved out of connection.ts (no change).
 */

// ---- threading.Event -------------------------------------------------------------------------------------------------------

export class ThreadEvent {
  #set = false;
  #waiters = new Set<() => void>();

  isSet(): boolean {
    return this.#set;
  }

  set(): void {
    if (this.#set) return;
    this.#set = true;
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const wake of waiters) wake();
  }

  clear(): void {
    this.#set = false;
  }

  /** True once set; false when `timeoutMs` passed first (no timeout: waits for ever). */
  wait(timeoutMs?: number): Promise<boolean> {
    if (this.#set) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wake = () => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(true);
      };
      this.#waiters.add(wake);
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.#waiters.delete(wake);
          resolve(this.#set);
        }, Math.max(0, timeoutMs));
      }
    });
  }
}

// ---- text lines the way a text-mode pipe gives them -------------------------------------------------------------------

/**
 * Bytes in, lines out, as `for line in process.stdout` does with text=True, encoding='utf-8', errors='replace': invalid UTF-8
 * becomes U+FFFD, a BOM is kept, and universal newlines apply (\r\n and a lone \r end a line too). Lines come without their
 * line end (every caller strips it). Long lines are joined once, not grown chunk by chunk.
 */
export class PyTextLines {
  #decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  #parts: string[] = [];
  #pendingCR = false;

  /** No part of a line is waiting for its end (a keeper snapshot is only taken then). */
  get idle(): boolean {
    return !this.#parts.length && !this.#pendingCR;
  }

  /** Lines completed by this chunk. `final` flushes: an incomplete UTF-8 sequence becomes U+FFFD and the last line is returned. */
  feed(chunk: Uint8Array | null, final = false): string[] {
    let text = chunk ? this.#decoder.decode(chunk, { stream: !final }) : this.#decoder.decode();
    if (this.#pendingCR) {
      text = '\r' + text;
      this.#pendingCR = false;
    }
    if (!final && text.endsWith('\r')) {
      text = text.slice(0, -1);
      this.#pendingCR = true;
    }
    if (text.includes('\r')) text = text.replace(/\r\n?/g, '\n');
    const lines: string[] = [];
    let start = 0;
    for (
      let index = text.indexOf('\n');
      index >= 0;
      index = text.indexOf('\n', start)
    ) {
      this.#parts.push(text.slice(start, index));
      lines.push(
        this.#parts.length === 1 ? this.#parts[0] : this.#parts.join(''),
      );
      this.#parts = [];
      start = index + 1;
    }
    if (start < text.length) this.#parts.push(start ? text.slice(start) : text);
    if (final && this.#parts.length) {
      lines.push(this.#parts.join(''));
      this.#parts = [];
    }
    return lines;
  }
}

/**
 * The open WebSockets of paired computers (terminal and docs), keyed by device (design v2 section 9, review MF6; phase 1c).
 *
 *   - Remove (one device or all) closes that device's sockets at once (closeDevice); a 1 s tick closes any socket whose device is
 *     gone or lost the switch the socket needs, so nothing outlives a change on the PC by more than about a second.
 *   - Every incoming message is checked against the device first (allowed()): a message from a removed device, or a terminal message
 *     after the Terminal switch went off, closes the socket instead of reaching the shell or the doc.
 *   - A protocol ping every 25 s keeps an idle socket open through Tailscale Serve.
 * The registry wraps the link the route hands to the terminal session or the doc (wrap()): the session sees an ordinary WsLink.
 */
import type { WsLink } from "../platform/websocket.ts";

export type SocketKind = "terminal" | "docs" | "files";

/** The close code a socket gets when its device was removed or lost the switch (the page shows "This device was removed"). */
export const CLOSE_REMOVED = 4401;
export const TICK_MS = 1000;
export const PING_MS = 25_000;

interface Entry {
  device: string;
  kind: SocketKind;
  link: WsLink;
  onClosed: (() => void) | null;
}

export interface SocketOptions {
  /** May this device still use a socket of this kind? (paired, a computer, the switch on) */
  allowed: (device: string, kind: SocketKind) => boolean;
  tickMs?: number;
  pingMs?: number;
}

export class DeviceSockets {
  readonly #entries = new Set<Entry>();
  #tick: number | null = null;
  #lastPing = 0;
  readonly tickMs: number;
  readonly pingMs: number;

  constructor(readonly options: SocketOptions) {
    this.tickMs = options.tickMs ?? TICK_MS;
    this.pingMs = options.pingMs ?? PING_MS;
  }

  /**
   * The link to hand to the session in place of `link`: its messages are checked against the device first, and it leaves the
   * registry when it closes. `onClosed` runs once when the socket ends, however it ends (the Device activity line).
   */
  wrap(
    device: string,
    kind: SocketKind,
    link: WsLink,
    onClosed: (() => void) | null = null,
  ): WsLink {
    const entry: Entry = { device, kind, link, onClosed };
    this.#entries.add(entry);
    let onmessage: ((data: string | Uint8Array) => void) | null = null;
    let onclose: (() => void) | null = null;
    const ended = () => {
      if (!this.#entries.delete(entry)) return;
      this.#stopWhenEmpty();
      try {
        entry.onClosed?.();
      } catch { /* the log never stops a socket */ }
    };
    link.onmessage = (data) => {
      if (!this.options.allowed(device, kind)) {
        this.#close(entry, "device removed");
        return;
      }
      onmessage?.(data);
    };
    link.onclose = () => {
      ended();
      onclose?.();
    };
    this.#startTick();
    return {
      get onmessage() {
        return onmessage;
      },
      set onmessage(fn) {
        onmessage = fn;
      },
      get onclose() {
        return onclose;
      },
      set onclose(fn) {
        onclose = fn;
      },
      get isOpen() {
        return link.isOpen;
      },
      send: (data) => link.send(data),
      ping: () => link.ping?.(),
      close: (code, reason) => {
        link.close(code, reason);
        ended(); // a link closed before its handshake finished may never call onclose
      },
    };
  }

  /** How many sockets this device has open (all devices: no argument). */
  count(device?: string, kind?: SocketKind): number {
    let n = 0;
    for (const e of this.#entries) {
      if (
        (device === undefined || e.device === device) &&
        (kind === undefined || e.kind === kind)
      ) n++;
    }
    return n;
  }

  /** Close every socket of this device now (Remove on the PC). Returns how many were open. */
  closeDevice(device: string, reason = "device removed"): number {
    let n = 0;
    for (const e of [...this.#entries]) {
      if (e.device !== device) continue;
      this.#close(e, reason);
      n++;
    }
    return n;
  }

  /** Close every socket whose device may no longer hold it (a switch went off, the device is gone). */
  recheck(): number {
    let n = 0;
    for (const e of [...this.#entries]) {
      if (this.options.allowed(e.device, e.kind)) continue;
      this.#close(e, "device removed");
      n++;
    }
    return n;
  }

  /** Close everything (Remove all, Phone access off, AIB closing). */
  closeAll(reason = "remote access stopped"): number {
    const n = this.#entries.size;
    for (const e of [...this.#entries]) this.#close(e, reason);
    this.#stopWhenEmpty();
    return n;
  }

  #close(entry: Entry, reason: string): void {
    try {
      entry.link.close(CLOSE_REMOVED, reason);
    } catch { /* gone */ }
    if (this.#entries.delete(entry)) {
      this.#stopWhenEmpty();
      try {
        entry.onClosed?.();
      } catch { /* the log never stops a socket */ }
    }
  }

  #startTick(): void {
    if (this.#tick !== null) return;
    this.#lastPing = Date.now();
    const tick = setInterval(
      () => this.#onTick(),
      this.tickMs,
    ) as unknown as number;
    this.#tick = tick;
    Deno.unrefTimer(tick); // a tick must never keep AIB (or a test) alive on its own
  }

  #onTick(): void {
    this.recheck();
    if (Date.now() - this.#lastPing >= this.pingMs) {
      this.#lastPing = Date.now();
      for (const e of this.#entries) {
        try {
          e.link.ping?.();
        } catch { /* gone: its close comes next */ }
      }
    }
  }

  #stopWhenEmpty(): void {
    if (this.#entries.size || this.#tick === null) return;
    clearInterval(this.#tick);
    this.#tick = null;
  }
}

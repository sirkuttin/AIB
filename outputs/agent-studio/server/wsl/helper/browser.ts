/**
 * URLs from the distro to the Windows browser (design 3, 6). Agents and their sign-ins run with BROWSER=<ver>/aib-open, a small sh
 * script that writes the URL as one line into the helper's open.fifo (a named pipe, 0600, in a 0700 folder; AIB_OPEN_FIFO says
 * where), and the helper sends AIB the notification `browser.open {url}`. AIB decides whether to open it (it asks the person unless
 * a sign-in for that distro started moments ago). Here: http and https only, at most 2048 bytes, at most 3 per minute.
 *
 * A FIFO and not a unix socket: a compiled Deno program may use a unix socket only at a path fixed at compile time, and the helper
 * has no network permission at all. The script opens the FIFO read-write, which never blocks, so a link written while no helper
 * runs is lost instead of hanging the agent.
 */

export const MAX_URL_BYTES = 2048;
export const RATE_MAX = 3;
export const RATE_WINDOW_MS = 60_000;
export const FIFO_NAME = 'open.fifo';

/** The URL to pass on, or the reason it is refused. Parsed only to check it; the text that was sent is what goes on. */
export function checkUrl(raw: string): { url: string } | { refused: string } {
  const url = raw.trim();
  if (!url) return { refused: 'no URL' };
  if (new TextEncoder().encode(url).length > MAX_URL_BYTES) return { refused: `longer than ${MAX_URL_BYTES} bytes` };
  if ([...url].some((c) => c.codePointAt(0)! < 0x20 || c.codePointAt(0) === 0x7f)) return { refused: 'control characters' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { refused: 'not a URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { refused: `${parsed.protocol} links are not opened` };
  if (!/^https?:\/\//i.test(url)) return { refused: 'not a URL' };
  return { url };
}

/** At most `max` takes per `windowMs`. */
export class RateLimit {
  #times: number[] = [];
  constructor(readonly max = RATE_MAX, readonly windowMs = RATE_WINDOW_MS, readonly now: () => number = Date.now) {}
  take(): boolean {
    const t = this.now();
    this.#times = this.#times.filter((x) => t - x < this.windowMs);
    if (this.#times.length >= this.max) return false;
    this.#times.push(t);
    return true;
  }
}

/** Splits FIFO bytes into lines; a line longer than the URL cap is dropped whole. */
export class LineSplitter {
  #buf = '';
  #skip = false;
  #dec = new TextDecoder();
  push(bytes: Uint8Array): string[] {
    this.#buf += this.#dec.decode(bytes, { stream: true });
    const out: string[] = [];
    for (let nl = this.#buf.indexOf('\n'); nl >= 0; nl = this.#buf.indexOf('\n')) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      if (this.#skip) this.#skip = false;
      else out.push(line);
    }
    if (this.#buf.length > MAX_URL_BYTES + 2) [this.#buf, this.#skip] = ['', true];
    return out;
  }
}

/** One line from the FIFO: the URL for AIB, or why not (logged to the helper's stderr, which the keeper journals). */
export function takeLine(line: string, limit: RateLimit): { url: string } | { refused: string } {
  const checked = checkUrl(line);
  if ('refused' in checked) return checked;
  return limit.take() ? checked : { refused: 'more than 3 links a minute' };
}

/**
 * Serves open.fifo inside `dir` (made 0700 first; the FIFO is created 0600 by mkfifo). The helper holds it open read-write, so it
 * never sees end-of-file between writers.
 */
export async function serveOpenFifo(
  dir: string,
  onUrl: (url: string) => void,
  onRefused: (reason: string) => void = () => {},
  limit = new RateLimit(),
): Promise<{ path: string; close(): void }> {
  Deno.mkdirSync(dir, { recursive: true, mode: 0o700 });
  Deno.chmodSync(dir, 0o700);
  const path = `${dir}/${FIFO_NAME}`;
  let st: Deno.FileInfo | null = null;
  try {
    st = Deno.lstatSync(path);
  } catch { /* none yet */ }
  if (st && !st.isFifo) Deno.removeSync(path);
  if (!st || !st.isFifo) {
    const made = await new Deno.Command('mkfifo', { args: ['-m', '600', path], stdin: 'null', stdout: 'null', stderr: 'piped' }).output();
    if (!made.success) throw new Error(`mkfifo failed: ${new TextDecoder().decode(made.stderr).trim()}`);
  }
  Deno.chmodSync(path, 0o600);
  const file = await Deno.open(path, { read: true, write: true });
  const lines = new LineSplitter();
  let closed = false;
  (async () => {
    const buf = new Uint8Array(8192);
    while (!closed) {
      const n = await file.read(buf);
      if (n === null) break;
      for (const line of lines.push(buf.subarray(0, n))) {
        const r = takeLine(line, limit);
        if ('url' in r) onUrl(r.url);
        else onRefused(r.refused);
      }
    }
  })().catch(() => {});
  return {
    path,
    close() {
      closed = true;
      try {
        file.close();
      } catch { /* closed */ }
    },
  };
}

/** The aib-open script: BROWSER points at it. It refuses what it can tell is not a web link and never blocks. */
export function shimScript(): string {
  return `#!/bin/sh
# aib-open (AIB): hands a link to AIB, which opens it on Windows. BROWSER points here in programs AIB starts in WSL.
f="\${AIB_OPEN_FIFO:-}"
if [ -z "$f" ] || [ ! -p "$f" ]; then echo "aib-open: AIB is not running in this distro" >&2; exit 1; fi
case "$1" in
  *'
'*) echo "aib-open: refused: control characters" >&2; exit 1 ;;
  http://*|https://*) ;;
  *) echo "aib-open: refused: only http and https links are opened" >&2; exit 1 ;;
esac
if [ \${#1} -gt ${MAX_URL_BYTES} ]; then echo "aib-open: refused: longer than ${MAX_URL_BYTES} bytes" >&2; exit 1; fi
exec 3<>"$f" && printf '%s\\n' "$1" >&3
`;
}

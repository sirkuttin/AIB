// Small helpers that make a JavaScript fake agent behave like the Python one it replaces (json.dumps spacing, partition, events, child
// processes). Node built-ins only. A fake that is copied alone (the WSL tests copy fake_acp.mjs into a distro) inlines what it needs
// instead of importing this file; everything else in work/fakes imports it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

/** json.dumps(value[, sort_keys]) as Python writes it: ", " and ": " separators, every non-ASCII character as \uXXXX, undefined as null. */
export function pyDumps(value, sortKeys = false, ascii = true) {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'string') {
    const text = JSON.stringify(value);
    return ascii ? text.replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) : text;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NaN';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return '[' + value.map((v) => pyDumps(v, sortKeys, ascii)).join(', ') + ']';
  let keys = Object.keys(value);
  if (sortKeys) keys = keys.sort();
  return '{' + keys.map((k) => pyDumps(k, false, ascii) + ': ' + pyDumps(value[k], sortKeys, ascii)).join(', ') + '}';
}

/** str.partition */
export function partition(text, sep) {
  const i = text.indexOf(sep);
  return i < 0 ? [text, '', ''] : [text.slice(0, i), sep, text.slice(i + sep.length)];
}

/** str.split(sep, maxsplit) */
export function splitMax(text, sep, max) {
  const out = [];
  let rest = text;
  while (out.length < max) {
    const i = rest.indexOf(sep);
    if (i < 0) break;
    out.push(rest.slice(0, i));
    rest = rest.slice(i + sep.length);
  }
  out.push(rest);
  return out;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const exists = (path) => fs.existsSync(path);
/** len() of a str: code points, not UTF-16 units. */
export const pyLen = (text) => Array.from(text).length;

/** Blocking sleep (a short pause inside synchronous code). */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** threading.Event */
export class Ev {
  #set = false;
  #waiters = [];
  set() {
    this.#set = true;
    for (const w of this.#waiters.splice(0)) w();
  }
  isSet() {
    return this.#set;
  }
  /** Resolves true when set, false after timeoutMs. */
  wait(timeoutMs) {
    if (this.#set) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.#set), timeoutMs);
      this.#waiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

/** A thread: runs fn without blocking the caller; a failure prints a traceback-like line and does not stop the agent. */
export function thread(fn) {
  Promise.resolve().then(fn).catch((error) => {
    process.stderr.write(`Exception in thread: ${error && error.stack || error}\n`);
  });
}

/** A child process with Popen's poll/wait/kill/pid/returncode. */
export function popen(command, args, options = {}) {
  const proc = spawn(command, args, { windowsHide: true, ...options });
  const handle = {
    proc,
    pid: proc.pid,
    returncode: null,
    exited: false,
    poll() {
      return handle.exited ? handle.returncode : null;
    },
    kill() {
      try {
        proc.kill();
      } catch { /* gone */ }
    },
    wait() {
      return handle.exited ? Promise.resolve(handle.returncode) : new Promise((resolve) => proc.once('exit', () => resolve(handle.returncode)));
    },
  };
  proc.on('error', () => {
    handle.exited = true;
    handle.returncode = -1;
  });
  proc.on('exit', (code, signal) => {
    handle.exited = true;
    handle.returncode = code ?? (signal ? -1 : 0);
  });
  return handle;
}

/** The program text that waits for a file to exist (what the Python fakes ran with `python -c`); the file is process.argv[1]. */
export const WAIT_FOR_FILE = "const fs=require('fs');while(!fs.existsSync(process.argv[1]))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);";
/** A program that just sleeps (time.sleep(n) as a child). */
export const sleeper = (seconds) => `setTimeout(()=>{},${Math.round(seconds * 1000)})`;

/** Flush what was written to stdout, then exit (a pipe may still hold output when process.exit runs). */
export function exitAfterFlush(code) {
  process.stdout.write('', () => process.exit(code));
}

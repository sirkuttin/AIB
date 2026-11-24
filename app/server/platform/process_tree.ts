/**
 * Kill an agent process together with everything it started (process_tree.py).
 * Windows: the agent joins a Job Object right after it starts; terminating the job reaches every descendant, also after the adapter
 * has exited (taskkill /T cannot, because the parent link is gone by then). If no job could be made, taskkill /T is the fallback.
 * The job is KILL_ON_JOB_CLOSE, so the agents also end when this process dies (a crashed agent host leaves no orphan agent).
 * POSIX: the agent leads its own process group (spawnAgent passes detached: true there), so a signal to -pid reaches all of them.
 *
 * Windows agents must NOT be spawned detached: a detached child has no console, so every console program it starts would open a
 * visible window (spike, rewrite spec §2). They inherit the server's hidden console instead (console.ts).
 */
import { kernel32, PROCESS_SET_QUOTA, PROCESS_TERMINATE } from './win32.ts';

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

export interface Killable {
  readonly pid: number;
  kill(signal?: Deno.Signal): void;
}

/** Options for Deno.Command that make ProcessTree work on this OS. */
export function treeSpawnOptions(): Pick<Deno.CommandOptions, 'detached'> {
  return Deno.build.os === 'windows' ? {} : { detached: true };
}

export class ProcessTree {
  readonly pid: number;
  #job: Deno.PointerValue = null;

  constructor(readonly process: Killable) {
    this.pid = process.pid;
    if (Deno.build.os === 'windows') this.#job = ProcessTree.#makeJob(process.pid);
  }

  get hasJob(): boolean {
    return this.#job !== null;
  }

  static #makeJob(pid: number): Deno.PointerValue {
    try {
      const k = kernel32();
      const job = k.CreateJobObjectW(null, null);
      if (job === null) return null;
      // KILL_ON_JOB_CLOSE: the job handle is ours alone, so when this process ends (a crashed agent host too) the agent and all it
      // started end with it instead of running on unseen and holding worktree files open. Best effort: without it, kill() still works.
      const info = new Uint8Array(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (64-bit); LimitFlags at offset 16
      new DataView(info.buffer).setUint32(16, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
      k.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, info, info.byteLength);
      const handle = k.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
      if (handle === null) {
        k.CloseHandle(job);
        return null;
      }
      const ok = k.AssignProcessToJobObject(job, handle);
      k.CloseHandle(handle);
      if (!ok) {
        k.CloseHandle(job);
        return null;
      }
      return job;
    } catch {
      return null;
    }
  }

  /** Hard-kill the whole tree. Safe to call repeatedly and after the adapter exited. */
  kill(): void {
    if (Deno.build.os === 'windows') {
      const job = this.#job;
      this.#job = null;
      if (job !== null) {
        try {
          kernel32().TerminateJobObject(job, 1);
          kernel32().CloseHandle(job);
        } catch { /* fall through to the direct kill */ }
      } else {
        try {
          new Deno.Command('taskkill', { args: ['/PID', String(this.pid), '/T', '/F'], stdout: 'null', stderr: 'null' }).outputSync();
        } catch { /* already gone */ }
      }
    } else {
      try {
        Deno.kill(-this.pid, 'SIGKILL');
      } catch { /* already gone */ }
    }
    try {
      this.process.kill('SIGKILL');
    } catch { /* already gone */ }
  }
}

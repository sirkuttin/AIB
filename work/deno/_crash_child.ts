/**
 * crash_trail_test.ts's child: installs the crash trail in the folder given, then ends the way asked: throw (an uncaught exception),
 * reject (an unhandled rejection: it must keep running, then exits 0), exit (Deno.exit(3)), oom (V8 runs out of heap), done.
 */
import { installCrashTrail } from '../../app/server/core/crash_trail.ts';

const [dir, how] = Deno.args;
if (how === 'desktop-reject') {
  // Like ext:deno_desktop/error_reporting, registered by the runtime before any of our code: skips prevented events, else
  // takes over and exits (the desktop app exits after its error dialog).
  globalThis.addEventListener('unhandledrejection', (ev) => {
    if (ev.defaultPrevented) return;
    ev.preventDefault();
    setTimeout(() => Deno.exit(1), 10);
  });
}
const trail = await installCrashTrail({ stateDir: dir, version: 'test', captureStderr: true, heartbeatMs: 50 });
trail.beat();
if (how === 'throw') {
  setTimeout(() => {
    throw new Error('boom from the child');
  }, 20);
} else if (how === 'reject') {
  Promise.reject(new Error('orphan rejection'));
  setTimeout(() => {
    trail.line('still running after the rejection');
    Deno.exit(0);
  }, 100);
} else if (how === 'desktop-reject') {
  // The WslHost.call shape: a promise a timer rejects while something else is awaited first.
  const answer = new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timer orphan')), 20));
  await new Promise((r) => setTimeout(r, 60));
  setTimeout(() => {
    trail.line('still running after the timer rejection');
    Deno.exit(0);
  }, 100);
  void answer;
} else if (how === 'exit') {
  setTimeout(() => Deno.exit(3), 20);
} else if (how === 'oom') {
  const keep: string[][] = [];
  const grow = () => {
    for (let i = 0; i < 2000; i++) keep.push(new Array(1000).fill('x'.repeat(5) + i));
    setTimeout(grow, 0);
  };
  setTimeout(grow, 120);
}

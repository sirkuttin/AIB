/**
 * crash_trail_test.ts's child: installs the crash trail in the folder given, then ends the way asked: throw (an uncaught exception),
 * reject (an unhandled rejection: it must keep running, then exits 0), exit (Deno.exit(3)), oom (V8 runs out of heap), done.
 */
import { installCrashTrail } from '../../app/server/core/crash_trail.ts';

const [dir, how] = Deno.args;
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

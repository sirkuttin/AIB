/**
 * Runs one shard of a test file: tools/test.ts starts a long file as N processes (`deno test --preload=_shard_preload.ts`, with
 * AIB_TEST_SHARD=k/N), and each registers only every N-th of the file's tests, counted in the order the file declares them (k is
 * 1-based). Together the N processes run every test exactly once; the file itself is unchanged. Only for files whose tests do not
 * depend on each other (each makes its own fixture): SHARDS in tools/test.ts lists them.
 * Deno records where Deno.test was called, so a failing test in a shard is reported at this file's line, not the test file's; the test
 * name and the runner's "file [k/N]" line say which one it is.
 */
const spec = Deno.env.get('AIB_TEST_SHARD');
if (spec) {
  const [k, n] = spec.split('/').map(Number);
  if (!(n >= 1 && k >= 1 && k <= n)) throw new Error(`AIB_TEST_SHARD must be k/N with 1 <= k <= N, not ${spec}`);
  let index = 0;
  const mine = () => index++ % n === k - 1;
  const original = Deno.test;
  // deno-lint-ignore no-explicit-any
  const wrap = (register: (...args: any[]) => void) =>
    // deno-lint-ignore no-explicit-any
    function (this: unknown, ...args: any[]) {
      if (mine()) register.apply(Deno, args);
    };
  const sharded = wrap(original) as typeof Deno.test;
  sharded.ignore = wrap(original.ignore) as typeof Deno.test.ignore;
  sharded.only = wrap(original.only) as typeof Deno.test.only;
  Object.defineProperty(Deno, 'test', { value: sharded, writable: true, configurable: true });
}

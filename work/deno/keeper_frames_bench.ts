/**
 * Measurement (not a test): how long FrameReader takes to read a long chat's keeper replay in 64 KB reads, the way
 * KeeperClient.#readLoop reads. The sizes are the 11 history records of a real 6,181-event chat (44.6 MB).
 * Run: deno run -A work/deno/keeper_frames_bench.ts      (before the fix: ~380 ms; after: ~30 ms)
 */
import { encodeFrame, FrameReader } from '../../outputs/agent-studio/server/keeper/client.ts';

const sizes = Deno.args.length ? Deno.args.map(Number) : [
  4193266, 4180358, 3607877, 4193174, 4017482, 4050855, 4022490, 4178057, 4121620, 4104611, 3887178,
];
const frames = sizes.map((n, i) => encodeFrame({ ev: 'record', seq: i }, new Uint8Array(n).fill(65)));
const data = new Uint8Array(frames.reduce((s, f) => s + f.length, 0));
frames.reduce((at, f) => (data.set(f, at), at + f.length), 0);
const buffer = new Uint8Array(65536);
const started = performance.now();
const reader = new FrameReader();
let count = 0;
for (let i = 0; i < data.length; i += buffer.length) {
  const n = Math.min(buffer.length, data.length - i);
  buffer.set(data.subarray(i, i + n));
  count += reader.push(buffer.subarray(0, n)).length;
}
console.log(`${count} frames, ${(data.length / 1e6).toFixed(1)} MB in 64 KB reads: ${(performance.now() - started).toFixed(0)} ms`);

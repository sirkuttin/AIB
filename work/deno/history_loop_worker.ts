/// <reference lib="deno.worker" />
/** history_loop_bench.ts's store Worker: one Worker owns every chat's database; the main loop only posts to it. */
import { Stores } from './history_loop_bench.ts';

let stores: Stores | null = null;
self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.op === 'open') stores = new Stores(m.dir);
  else if (m.op === 'write') stores!.write(m.chat, m.rows);
  else if (m.op === 'recent') self.postMessage({ id: m.id, bytes: stores!.recent(m.chat, m.n) });
  else if (m.op === 'close') {
    stores?.close();
    self.postMessage({ id: m.id, closed: true });
  }
};

/// <reference lib="deno.worker" />
/** Phase 0A probe: the same node:sqlite checks inside a Worker (the planned store Worker). */
import { probeDb } from './sqlite_probe.ts';

self.onmessage = (e: MessageEvent<string>) => {
  try {
    self.postMessage(probeDb(e.data));
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};

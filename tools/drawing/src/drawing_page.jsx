// The drawing page: Excalidraw bound to the field-level Y.Map through server/docs/drawing/binding.ts, synced with AIB's
// server over one WebSocket (byte 0 = Yjs update, byte 1 = awareness update). Bundled by tools/drawing/build.mjs into
// outputs/agent-studio/vendor/excalidraw/drawing.js. Query: ?drawing=<id>&ws=<ws url>[&selftest=1]
import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { CaptureUpdateAction, Excalidraw, restoreElements } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import * as Y from 'yjs';
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { Binding, presence } from '../../../outputs/agent-studio/server/docs/drawing/binding.ts';
import { USER } from '../../../outputs/agent-studio/server/docs/drawing/model.ts';

const params = new URLSearchParams(location.search);
const drawingId = params.get('drawing') || 'd1';
const wsUrl = params.get('ws') || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const selftest = params.get('selftest') === '1';

// With ?selftest=1 the page reports errors and progress to the demo server's /api/log (a headless browser has no console to read).
const log = (...a) => selftest && fetch('/api/log', { method: 'POST', body: a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') }).catch(() => {});
if (selftest) {
  addEventListener('error', (e) => log('error', String(e.message), e.filename, e.lineno));
  addEventListener('unhandledrejection', (e) => log('rejection', String(e.reason?.stack ?? e.reason)));
}

const doc = new Y.Doc();
const awareness = new Awareness(doc);
const binding = new Binding(doc, drawingId, USER);

const canvas = document.createElement('canvas').getContext('2d');
const measure = (text, fontSize, fontFamily) => {
  const family = fontFamily === 5 ? 'Excalifont' : fontFamily === 1 ? 'Virgil' : 'Helvetica';
  canvas.font = `${fontSize}px ${family}, Xiaolai, Segoe UI Emoji`;
  const lines = String(text).split('\n');
  return { w: Math.max(...lines.map((l) => canvas.measureText(l).width)), h: lines.length * fontSize * 1.25 };
};

const ws = new WebSocket(wsUrl);
ws.binaryType = 'arraybuffer';
const send = (kind, bytes) => {
  if (ws.readyState !== WebSocket.OPEN) return;
  const out = new Uint8Array(bytes.length + 1);
  out[0] = kind;
  out.set(bytes, 1);
  ws.send(out);
};
ws.onopen = () => {
  send(0, Y.encodeStateAsUpdate(doc));
  if (awareness.getLocalState()) send(1, encodeAwarenessUpdate(awareness, [doc.clientID]));
};
// The first Yjs message from the server is the whole doc: Excalidraw starts from it (initialData), not from an empty scene.
let firstSync;
const synced = new Promise((r) => (firstSync = r));
setTimeout(() => firstSync(), 3000);
ws.onmessage = (ev) => {
  const data = new Uint8Array(ev.data);
  if (data[0] === 0) Y.applyUpdate(doc, data.subarray(1), 'remote'), firstSync();
  else if (data[0] === 1) applyAwarenessUpdate(awareness, data.subarray(1), 'remote');
};
doc.on('update', (update, origin) => {
  if (origin !== 'remote') send(0, update);
});
awareness.on('update', ({ added, updated, removed }, origin) => {
  if (origin !== 'remote') send(1, encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]));
});
window.addEventListener('beforeunload', () => awareness.setLocalState(null));

let api = null;
let ready = false; // Excalidraw has applied initialData; before that an updateScene would be overwritten by it
// Y -> Excalidraw: rebuild the scene from the stored fields (labels expanded, boundElements derived) without touching the
// user's undo history. Runs on every transaction that did not come from this page's own binding.
const sceneNow = () => {
  const elements = restoreElements(binding.scene(measure), null, { repairBindings: true });
  binding.remember(elements);
  return elements;
};
function render() {
  if (!api || !ready) return;
  api.updateScene({ elements: sceneNow(), captureUpdate: CaptureUpdateAction.NEVER });
}
doc.on('afterTransaction', (tx) => {
  if (tx.origin !== USER || !tx.local) render();
});

function App() {
  const lastPresence = useRef('');
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Excalidraw
        initialData={synced.then(() => ({ elements: sceneNow(), appState: { viewBackgroundColor: '#ffffff' } }))}
        excalidrawAPI={(a) => (api = a)}
        onChange={(elements, appState) => {
          if (!ready) {
            if (appState.isLoading || !api) return;
            ready = true;
            render(); // anything that arrived while Excalidraw was loading
            log('ready', api.getSceneElements().length);
            if (selftest) runSelftest();
            return;
          }
          const wrote = binding.push(elements);
          if (wrote.length) log('pushed', wrote);
          const p = presence(drawingId, appState, elements);
          const key = JSON.stringify(p);
          if (key !== lastPresence.current) {
            lastPresence.current = key;
            awareness.setLocalState(p);
          }
        }}
      />
    </div>
  );
}

// Headless check used by the tests: once the agent's box b1 is on screen, move it by +100 x the way a drag would end
// (a new element version through updateScene), select it, then write what the page sees into the title.
function runSelftest() {
  const t0 = Date.now();
  const tick = () => {
    const a = api;
    const b1 = a?.getSceneElements().find((e) => e.id === 'b1');
    log('tick', a?.getSceneElements().length);
    if (!b1) return Date.now() - t0 < 8000 ? setTimeout(tick, 100) : (document.title = 'selftest: no b1');
    const elements = a.getSceneElements().map((e) => (e.id === 'b1' || e.containerId === 'b1' ? { ...e, x: e.x + 100, version: e.version + 1, versionNonce: e.versionNonce + 1 } : e));
    a.updateScene({ elements, appState: { selectedElementIds: { b1: true } }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    log('after update', a.getSceneElementsIncludingDeleted().map((e) => [e.id, Math.round(e.x), e.version, e.isDeleted]));
    setTimeout(() => {
      const label = a.getSceneElements().find((e) => e.containerId === 'b1');
      log('scene', a.getSceneElements().map((e) => [e.id, Math.round(e.x), e.version]));
      document.title = `selftest: ok b1.x=${Math.round(a.getSceneElements().find((e) => e.id === 'b1').x)} label=${label?.text}`;
    }, 500);
  };
  tick();
}

createRoot(document.getElementById('root')).render(<App />);

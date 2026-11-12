// Mermaid -> Excalidraw element skeletons with no browser: @excalidraw/mermaid-to-excalidraw lays flowcharts out with pele
// (DOM-free) and only needs DOMParser and document.createElement('textarea') for entity decoding; linkedom supplies both,
// installed on globalThis for the duration of one call and put back afterwards.
import { parseHTML } from 'linkedom';
import { parseMermaidToExcalidraw } from '@excalidraw/mermaid-to-excalidraw';

let queue = Promise.resolve();

export function mermaidToSkeleton(definition) {
  const run = async () => {
    const before = { DOMParser: globalThis.DOMParser, document: globalThis.document };
    const { window } = parseHTML('<!doctype html><html><body></body></html>');
    globalThis.DOMParser = window.DOMParser;
    globalThis.document = window.document;
    try {
      return await parseMermaidToExcalidraw(definition);
    } finally {
      if (before.DOMParser === undefined) delete globalThis.DOMParser;
      else globalThis.DOMParser = before.DOMParser;
      if (before.document === undefined) delete globalThis.document;
      else globalThis.document = before.document;
    }
  };
  const result = queue.then(run, run);
  queue = result.then(() => {}, () => {});
  return result;
}

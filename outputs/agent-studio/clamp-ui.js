// Long blocks inside the chat history (tool output, code, file previews) never get their own scrollbar, so the wheel
// always scrolls the conversation. A block taller than LINES lines is shown clamped with a "Show all N lines" toggle and
// expands to its full height. Chat rows are rebuilt on every update, so expanded blocks are remembered by position and
// opening text and re-applied after each rebuild.
(function () {
  'use strict';
  const LINES = 12;
  const BOXES = ['messages', 'submessages'];
  const BLOCKS = 'pre, .client-terminal-output';

  function lineCount(text) {
    if (!text) return 0;
    const trimmed = text.replace(/\n+$/, '');
    return trimmed ? trimmed.split('\n').length : 0;
  }
  function blockKey(index, text) {
    return index + ':' + String(text || '').slice(0, 80);
  }

  const expanded = new Map(); // box id -> Set of block keys the user expanded

  function setLabel(button, open, lines) {
    button.textContent = open ? 'Show less' : lines > LINES ? 'Show all ' + lines + ' lines' : 'Show all';
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  /* `recheck`: also measure blocks that were hidden last time (inside a closed step), after a toggle or click may have shown them.
     Blocks are measured in one pass: every new block is clamped first, then all are read, then labelled, so a redraw costs one
     layout, not one per block. A hidden block is not measured again on every mutation (that forced a layout on each streaming
     update), only on the next toggle, click or when the list itself becomes visible. */
  function apply(box, recheck) {
    if (!box) return;
    if (box.getClientRects && box.getClientRects().length === 0) return; // the list is hidden: measured when it shows
    const keep = expanded.get(box.id) || new Set();
    expanded.set(box.id, keep);
    const blocks = box.querySelectorAll(BLOCKS);
    const fresh = [];
    for (let i = 0; i < blocks.length; i++) {
      const pre = blocks[i],
        state = pre.dataset.clamp;
      if (state && !(recheck && state === 'later')) continue;
      if (pre.closest('.clamp-skip')) {
        pre.dataset.clamp = 'skip';
        continue;
      }
      fresh.push(i);
    }
    if (!fresh.length) return;
    for (const i of fresh) blocks[i].classList.add('clamp-block', 'clamp-on');
    const seen = fresh.map((i) => {
      const pre = blocks[i];
      if (pre.getClientRects().length === 0) return 'later'; // inside a closed <details>: measure when it opens
      return pre.scrollHeight <= pre.clientHeight + 4 ? 'fits' : 'long';
    });
    fresh.forEach((i, n) => {
      const pre = blocks[i];
      pre.dataset.clamp = seen[n];
      if (seen[n] === 'later') {
        pre.classList.remove('clamp-block', 'clamp-on');
        return;
      }
      if (seen[n] === 'fits') {
        pre.classList.remove('clamp-on');
        return;
      }
      const key = blockKey(i, pre.textContent);
      const lines = lineCount(pre.textContent);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'clamp-toggle';
      const open = keep.has(key);
      if (open) pre.classList.remove('clamp-on');
      setLabel(button, open, lines);
      button.addEventListener('click', () => {
        const nowOpen = pre.classList.toggle('clamp-on') === false;
        if (nowOpen) keep.add(key);
        else keep.delete(key);
        setLabel(button, nowOpen, lines);
      });
      pre.after(button);
    });
  }

  function watch(id) {
    const box = document.getElementById(id);
    if (!box) return;
    let queued = false;
    const run = () => {
      queued = false;
      apply(box, true);
    };
    const later = () => {
      if (!queued) {
        queued = true;
        setTimeout(run, 30);
      }
    };
    // Clamp rebuilt rows in the observer itself: it runs before the next paint, so a long block is never drawn at full height
    // for a frame (a timer here made the whole history flash open and jump on every update). The toggle buttons it adds are
    // its own mutations: dropped, so they do not run it again.
    const observer = new MutationObserver(() => {
      apply(box);
      observer.takeRecords?.();
    });
    observer.observe(box, { childList: true, subtree: true });
    box.addEventListener('toggle', later, true);
    box.addEventListener('click', later, true);
    if (typeof ResizeObserver === 'function') {
      let shown = false;
      new ResizeObserver(() => {
        const now = box.clientHeight > 0;
        if (now && !shown) run();
        shown = now;
      }).observe(box);
    }
    apply(box);
  }

  function start() {
    BOXES.forEach(watch);
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
  if (typeof module !== 'undefined') module.exports = { lineCount, blockKey, LINES, watch };
  if (typeof window !== 'undefined') window.ClampUI = { apply, lineCount, LINES };
})();

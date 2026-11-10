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

  function apply(box) {
    if (!box) return;
    const keep = expanded.get(box.id) || new Set();
    expanded.set(box.id, keep);
    const blocks = box.querySelectorAll(BLOCKS);
    for (let i = 0; i < blocks.length; i++) {
      const pre = blocks[i];
      if (pre.dataset.clamp) continue;
      if (pre.closest('.clamp-skip')) {
        pre.dataset.clamp = 'skip';
        continue;
      }
      if (pre.getClientRects().length === 0) continue; // inside a closed <details>: measure when it opens
      const key = blockKey(i, pre.textContent);
      const lines = lineCount(pre.textContent);
      pre.classList.add('clamp-block', 'clamp-on');
      if (pre.scrollHeight <= pre.clientHeight + 4) {
        pre.classList.remove('clamp-on');
        pre.dataset.clamp = 'fits';
        continue;
      }
      pre.dataset.clamp = 'long';
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
    }
  }

  function watch(id) {
    const box = document.getElementById(id);
    if (!box) return;
    let queued = false;
    const run = () => {
      queued = false;
      apply(box);
    };
    new MutationObserver(() => {
      if (!queued) {
        queued = true;
        setTimeout(run, 30);
      }
    }).observe(box, { childList: true, subtree: true });
    box.addEventListener(
      'toggle',
      () => {
        if (!queued) {
          queued = true;
          setTimeout(run, 30);
        }
      },
      true,
    );
    apply(box);
  }

  function start() {
    BOXES.forEach(watch);
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
  if (typeof module !== 'undefined') module.exports = { lineCount, blockKey, LINES };
  if (typeof window !== 'undefined') window.ClampUI = { apply, lineCount, LINES };
})();

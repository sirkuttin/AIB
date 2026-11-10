'use strict';
/* Activity column chrome: hide/show (remembered), the in-flow strip below 1100 px, chips, and drill-in helpers. */
(function (root) {
  const KEY = 'studio-activity-hidden',
    NARROW = 1100;
  const isNarrow = (width) => Number(width) < NARROW;
  function readHidden(store) {
    try {
      return (store || localStorage).getItem(KEY) === '1';
    } catch (e) {
      return false;
    }
  }
  function writeHidden(value, store) {
    try {
      (store || localStorage).setItem(KEY, value ? '1' : '0');
    } catch (e) {}
  }
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  /* Strip chips: "N working" (dot pulses when any), "N failed" (red when any), "N running" (processes). All three show once there is
   anything to report; with no subagents and no processes the strip says "No activity". */
  function chips(c) {
    const sub = Math.max(0, Number(c && c.subagents) || 0),
      failed = Math.max(0, Number(c && c.failed) || 0),
      proc = Math.max(0, Number(c && c.processes) || 0),
      working = Math.max(0, Number(c && c.working) || 0);
    if (!sub && !failed && !proc && !working) return [];
    return [
      { cls: 'ac-sub' + (working ? ' working' : ''), dot: true, text: working + ' working' },
      { cls: 'ac-failed' + (failed ? ' has' : ''), text: failed + ' failed' },
      { cls: 'ac-proc' + (proc ? ' has' : ''), text: proc + ' running' },
    ];
  }
  function renderStrip(box, counts) {
    if (!box) return;
    const list = chips(counts),
      doc = box.ownerDocument;
    const frag = doc.createDocumentFragment();
    if (!list.length) {
      const n = doc.createElement('span');
      n.className = 'ac-chip ac-none';
      n.textContent = 'No activity';
      frag.append(n);
    }
    for (const c of list) {
      const n = doc.createElement('span');
      n.className = 'ac-chip ' + c.cls;
      if (c.dot) {
        const d = doc.createElement('i');
        d.className = 'ac-dot';
        n.append(d);
      }
      n.append(c.text);
      frag.append(n);
    }
    box.replaceChildren(frag);
  }
  /* Compact elapsed text for a process row: "42s", "3m 05s", "1h 02m". */
  function shortDuration(seconds) {
    const n = Math.floor(Number(seconds));
    if (!(n >= 0)) return '';
    if (n < 60) return n + 's';
    if (n < 3600) return Math.floor(n / 60) + 'm ' + String(n % 60).padStart(2, '0') + 's';
    return Math.floor(n / 3600) + 'h ' + String(Math.floor((n % 3600) / 60)).padStart(2, '0') + 'm';
  }
  const processHeading = (n) => n + ' running';
  /* Process row text: the agent's own description when it gave one, else the command's first line. The hover keeps the full command. */
  const oneLine = (v) =>
    String(v == null ? '' : v)
      .replace(/\s+/g, ' ')
      .trim();
  const unclip = (t) => String(t || '').replace(/\s*\[Display shortened[^\]]*\]\s*$/, '');
  function processTitle(task) {
    task = task || {};
    return (
      oneLine(task.description) ||
      oneLine(unclip(task.title)) ||
      oneLine(unclip(task.command)).slice(0, 120) ||
      'Command'
    );
  }
  function processHover(task, extra) {
    task = task || {};
    const title = processTitle(task),
      command = String(task.command || '').trim(),
      lines = [title];
    if (command && oneLine(command) !== title)
      lines.push('$ ' + command.slice(0, 600) + (command.length > 600 ? '…' : ''));
    return lines
      .concat(extra || [])
      .filter(Boolean)
      .join('\n');
  }
  /* "unknown" means the transcript went quiet with no completion saved: say so instead of claiming it ended or still runs. */
  const processStatusText = (status) => (status === 'unknown' ? 'Status unknown' : status);
  let live = null;
  function init(doc) {
    doc = doc || document;
    const pane = doc.getElementById('subagentsPane');
    if (!pane) return;
    const body = doc.body,
      hide = doc.getElementById('activityHide'),
      reveal = doc.getElementById('activityReveal'),
      strip = doc.getElementById('activityStrip');
    const mq = typeof matchMedia === 'function' ? matchMedia('(max-width:' + (NARROW - 1) + 'px)') : null;
    const narrow = () => (mq ? mq.matches : isNarrow(root.innerWidth));
    /* Narrow: the pane lives inside the chat, between the messages and the composer; wide: it is the third grid column. */
    function place() {
      const main = doc.querySelector('main'),
        chat = doc.getElementById('chat');
      if (!narrow() || !main) {
        if (pane.parentNode !== body) body.append(pane);
        return;
      }
      const msgs = doc.getElementById('messages'),
        form = doc.getElementById('promptForm');
      if (chat && !chat.hidden && msgs && msgs.parentNode === chat) {
        if (pane.previousElementSibling !== msgs) msgs.after(pane);
      } else if (chat && !chat.hidden && form && form.parentNode === chat) {
        if (pane.nextElementSibling !== form) chat.insertBefore(pane, form);
      } else if (pane.parentNode !== main || pane.previousElementSibling !== chat) main.append(pane);
    }
    function apply() {
      body.classList.toggle('activity-off', readHidden() && !narrow());
      place();
      const open = pane.classList.contains('open');
      if (narrow()) {
        if (strip) strip.setAttribute('aria-expanded', open ? 'true' : 'false');
      } else {
        pane.classList.remove('open');
        if (strip) strip.removeAttribute('aria-expanded');
      }
    }
    const toggle = () => {
      if (!narrow()) return;
      pane.classList.toggle('open');
      apply();
    };
    if (strip) strip.addEventListener('click', toggle);
    if (hide)
      hide.addEventListener('click', () => {
        writeHidden(true);
        apply();
        reveal?.focus();
      });
    if (reveal)
      reveal.addEventListener('click', () => {
        writeHidden(false);
        apply();
        hide?.focus();
      });
    doc.addEventListener('keydown', (e) => {
      if (
        e.key === 'Escape' &&
        pane.classList.contains('open') &&
        !body.classList.contains('subchat-open') &&
        !e.defaultPrevented
      ) {
        pane.classList.remove('open');
        apply();
        strip?.focus();
      }
    });
    if (mq && mq.addEventListener) mq.addEventListener('change', apply);
    const chat = doc.getElementById('chat');
    if (chat && typeof MutationObserver === 'function')
      new MutationObserver(place).observe(chat, { attributes: true, attributeFilter: ['hidden'] });
    /* The column sits below the tab strip and shares the chat title row: copy their live heights into --tabs-h / --hd-h. */
    const tabs = doc.getElementById('chatTabs'),
      hd = doc.querySelector('main>header');
    function sync() {
      const set = (n, el) => {
        const h = el && (el.getBoundingClientRect ? Math.round(el.getBoundingClientRect().height) : el.offsetHeight);
        if (h > 0) doc.documentElement.style.setProperty(n, h + 'px');
      };
      set('--tabs-h', tabs);
      set('--hd-h', hd);
    }
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(sync);
      if (tabs) ro.observe(tabs);
      if (hd) ro.observe(hd);
    }
    sync();
    /* A zoom change does not resize the zoomed box in its own units, so the observer stays quiet: re-measure when the interface size changes. */
    if (root.AgentTextSize && typeof root.AgentTextSize.onChange === 'function')
      root.AgentTextSize.onChange(() => {
        sync();
        root.setTimeout(sync, 60);
      });
    live = {
      apply,
      narrow,
      open: () => {
        pane.classList.add('open');
        apply();
      },
    };
    apply();
  }
  /* chat.js calls this when the inspector opens: make sure the column is visible and (narrow) expanded. */
  /* Hide or show the column (wide screens). resize-ui.js uses this for drag-to-collapse and Ctrl+Alt+B. */
  function setHidden(value) {
    writeHidden(!!value);
    if (live) live.apply();
  }
  function isHidden() {
    return readHidden() && !(live && live.narrow());
  }
  function drill(on) {
    if (!live || !on) return;
    writeHidden(false);
    live.open();
  }
  const api = {
    isNarrow,
    readHidden,
    writeHidden,
    setHidden,
    isHidden,
    init,
    drill,
    chips,
    renderStrip,
    shortDuration,
    processHeading,
    processTitle,
    processHover,
    processStatusText,
    NARROW,
  };
  root.ActivityUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => init());
})(typeof window !== 'undefined' ? window : globalThis);

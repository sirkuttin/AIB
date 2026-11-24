// The composer while the agent works: Enter = Send now (steer), Alt+Enter = Send after this turn, Shift+Enter = new line,
// and a small "Send ▾" menu with the third choice, Interrupt and send. When the agent is idle none of this shows.
// Pure rules (what a key does, which route a send takes, the words) are exported for the node tests; the menu is drawn into the page.
// ALL the words of this feature live in COPY below, so they can be adjusted in one place.
(function (root) {
  'use strict';

  const COPY = {
    // Grey line under "Send now", per agent. claude / codex are the agent ids; anything else uses nowHintOther.
    nowHint: {
      claude: 'Claude Code answers right away. A command or subagent it is running keeps going in the background.',
      codex:
        "Codex answers right away. A command it is running keeps going in the background, and Codex isn't told when it ends.",
    },
    nowHintOther: (agent) => agent + ' reads it during this turn.',
    cantSteerMenu: (agent) =>
      agent + ' can’t read messages during a turn. Use "Send after this turn" or "Interrupt and send".',
    cantSteerKey: (agent) => agent + ' can’t read messages mid-turn · Enter sends when it ends',
    // The Send button's tooltip while the agent works (owner, 2026-11-12: no key hint row under the box, so the composer keeps its
    // height): steerable, a slash command typed, or the agent cannot steer (cantSteerKey).
    keyHintSteer: 'Enter sends now · Alt+Enter after this turn · Shift+Enter for a new line',
    keyHintCommand: 'Commands run after this turn',
    now: 'Send now',
    after: 'Send after this turn',
    interrupt: 'Interrupt and send',
    afterHint: (agent) => 'Waits above the box until ' + agent + ' finishes, then sends.',
    interruptHint:
      'Stops the current reply and its running step, then sends. Work already in the background keeps running.',
    moreLabel: 'More ways to send',
    placeholderSteer: (agent) => 'Message ' + agent + '… Enter sends now',
    placeholderQueue: (agent) => 'Message ' + agent + '… Enter sends when this turn ends',
    noteSteer:
      'Enter sends now · Alt+Enter after this turn · Shift+Enter for a new line · Interrupt stops the current turn; background work may continue.',
    noteQueue:
      'Enter to queue it for when this turn ends · Shift+Enter for a new line · Interrupt stops the current turn; background work may continue.',
    tag: 'Sent while working',
    bgRunning: 'Still running in the background',
    bgStopping: 'Stopping…',
    bgDone: 'Finished in the background',
    bgStopped: 'Stopped by you',
    bgStop: 'Stop',
    held: 'Waits for your answer above · then goes in at once',
    // A held row names the card it waits for (owner, 2026-11-17: the plain note was not noticed). what = heldWhat(...).
    heldOn: (what) => 'Held until you answer ' + what + ' above · then it goes in at once',
    heldWhat: (card, who, title) =>
      (who ? who + '’s ' : 'the ') + (card === 'question' ? 'question' : 'approval') + (title ? ' “' + title + '”' : ''),
    heldWhy: {},
    heldWhyOther: 'The agent reads it once the card is answered.',
    heldHead: 'Held until you answer the card above',
    // Claude Code's own cycle (it started a turn itself, e.g. a background task ended): Send now joins it, nothing stops.
    ownCycleHint: (agent) =>
      agent + ' started this turn itself (a background task ended). Your message joins it now; nothing running stops.',
    // Another agent's own cycle (not expected): why a message waits in the queue box.
    ownCycleQueue: (agent) => agent + ' started this turn itself and can’t read messages until it ends',
    sendingHead: 'Sending',
    fallbackNote: 'Couldn’t send now: sends when this turn ends',
    // Send later (owner, 2026-11-23): the message waits for a time, then goes out like any Send (behind a running turn, never cancelling it).
    later: 'Send later…',
    laterHint: 'Pick a time. AIB sends it then, even if the window is closed.',
    laterNeedsText: 'Type a message first.',
    laterTitle: 'Send later',
    laterBack: '‹ Back',
    laterCustom: 'Pick a date and time',
    laterSchedule: 'Schedule',
    laterPast: 'That time has already passed.',
    laterNone: 'Pick a date and time.',
    scheduledFor: (when) => 'Scheduled for ' + when,
    scheduledHead: (n) => n + ' scheduled',
    scheduleEdit: 'Edit text and time',
    scheduleSendNow: 'Send now - nothing running stops',
    scheduleCancel: 'Cancel - the message is not sent',
    scheduleSave: 'Save',
    scheduleKeep: 'Cancel edit',
  };

  // ---- Send later: the quick picks and the words for a time --------------------------------------------------------------
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const clock = (d) => {
    const h = d.getHours();
    return (h % 12 || 12) + ':' + pad(d.getMinutes()) + ' ' + (h < 12 ? 'AM' : 'PM');
  };
  const dayKey = (d) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // A time in words, local: "3:30 PM" today, "tomorrow 9:00 AM", else "Mon, Nov 30, 9:00 AM".
  function whenWords(at, now) {
    const d = new Date(at),
      n = new Date(now == null ? Date.now() : now);
    if (dayKey(d) === dayKey(n)) return clock(d);
    const next = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1);
    if (dayKey(d) === dayKey(next)) return 'tomorrow ' + clock(d);
    return DAYS[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + clock(d);
  }
  // The quick picks: in 30 min, in 1 hour, in 3 hours, tomorrow 9:00. at = epoch ms.
  function laterPicks(now) {
    const t = now == null ? Date.now() : now,
      n = new Date(t);
    return [
      { id: 'm30', label: 'In 30 minutes', at: t + 30 * 60000 },
      { id: 'h1', label: 'In 1 hour', at: t + 60 * 60000 },
      { id: 'h3', label: 'In 3 hours', at: t + 3 * 60 * 60000 },
      { id: 'tomorrow', label: 'Tomorrow 9:00', at: new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, 9, 0).getTime() },
    ];
  }
  // The value of the date+time field ("2026-11-24T09:00", local time) as epoch ms, or an error line.
  function customAt(value, now) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value || ''));
    if (!m) return { error: COPY.laterNone };
    const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
    if (!Number.isFinite(at)) return { error: COPY.laterNone };
    if (at < (now == null ? Date.now() : now)) return { error: COPY.laterPast };
    return { at };
  }
  // The value a date+time field starts with: an hour from now, rounded up to the next 5 minutes.
  function localValue(ms) {
    const d = new Date(Math.ceil(ms / 300000) * 300000);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  const LATER_ITEM = (ctx) => {
    const empty = ctx.hasContent === false;
    return {
      id: 'later',
      label: COPY.later,
      key: '',
      hint: empty ? COPY.laterNeedsText : COPY.laterHint,
      disabled: empty,
    };
  };

  // Slash commands (the names the agent lists, plus /doc) are never steered: they always go after this turn.
  function isSlashCommand(text, commands) {
    const m = /^\s*\/([^\s/]+)/.exec(String(text || ''));
    if (!m) return false;
    const name = m[1].toLowerCase();
    if (name === 'doc') return true;
    return (Array.isArray(commands) ? commands : []).some(
      (c) =>
        c &&
        String(c.name || '')
          .replace(/^\/+/, '')
          .toLowerCase() === name,
    );
  }

  // ctx: {busy, autonomous, hasQueue, steerable, agentId, agent, text, commands}. What the composer shows.
  // autonomous: the agent runs a cycle of its own (Claude Code after a background command ended), no turn of the user's. Claude Code
  // takes a message in there (steerable; owner, 2026-11-17: queueing surprised him), so the composer is the working one, with its
  // own hint; an agent whose cycle is not steerable keeps the plain Send of before (Enter waits for the cycle to end, T27).
  function view(ctx) {
    const agent = ctx.agent || 'the agent',
      working = !!ctx.busy,
      slash = working && isSlashCommand(ctx.text, ctx.commands),
      steer = working && !!ctx.steerable,
      steerNow = steer && !slash;
    // The menu is always there: while idle it holds only "Send later…"; while working it adds the ways to send into a running turn.
    const later = LATER_ITEM(ctx);
    const out = { working, steerable: steer, slash, more: true, keyHint: '', placeholder: '', note: '', items: [later] };
    if (!working) return out;
    if (ctx.autonomous && !steer) {
      out.placeholder = COPY.placeholderQueue(agent);
      out.note = COPY.noteQueue;
      return out;
    }
    // keyHint: the Send button's tooltip while working (there is no hint row under the box)
    if (slash) out.keyHint = COPY.keyHintCommand;
    else if (steer) out.keyHint = COPY.keyHintSteer;
    else out.keyHint = COPY.cantSteerKey(agent);
    out.placeholder = steerNow ? COPY.placeholderSteer(agent) : COPY.placeholderQueue(agent);
    out.note = steerNow ? COPY.noteSteer : COPY.noteQueue;
    const nowHint = !steer
      ? COPY.cantSteerMenu(agent)
      : ctx.autonomous
        ? COPY.ownCycleHint(agent)
        : COPY.nowHint[ctx.agentId] || COPY.nowHintOther(agent);
    out.items = [
      {
        id: 'now',
        label: COPY.now,
        key: steerNow ? 'Enter' : '',
        hint: slash ? COPY.keyHintCommand : nowHint,
        disabled: !steerNow,
      },
      { id: 'after', label: COPY.after, key: steerNow ? 'Alt+Enter' : 'Enter', hint: COPY.afterHint(agent), disabled: false },
      { id: 'interrupt', label: COPY.interrupt, key: '', hint: COPY.interruptHint, disabled: false },
      later,
    ];
    return out;
  }

  // intent: 'default' (Enter / Send button) | 'now' | 'after' | 'interrupt'.
  // Returns 'prompt' | 'queue' | 'steer' | 'interrupt'.
  function route(ctx, intent) {
    if (!ctx.busy) return ctx.hasQueue ? 'queue' : 'prompt'; // idle: exactly as before
    if (intent === 'interrupt') return 'interrupt';
    if (intent === 'after') return 'queue';
    if (isSlashCommand(ctx.text, ctx.commands)) return 'queue';
    return ctx.steerable ? 'steer' : 'queue';
  }

  // What Enter in the message box means. Returns an intent or '' (leave the key alone). Shift+Enter is a new line.
  function keyIntent(e, ctx) {
    if (!e || e.key !== 'Enter' || e.isComposing || e.shiftKey || e.ctrlKey || e.metaKey) return '';
    if (e.altKey) return ctx && ctx.busy ? 'after' : '';
    return 'default';
  }

  // ---- the menu -------------------------------------------------------------------------------------------
  // init({send, doc, root, onPick(id), onSchedule(epochMs)}) puts a ▾ next to the Send button, inside one wrapper; its menu floats at the page's top level.
  function init(opts) {
    const doc = opts.doc,
      send = opts.send,
      parent = send.parentNode;
    const wrap = doc.createElement('div');
    wrap.className = 'send-split';
    const more = doc.createElement('button');
    more.type = 'button';
    more.className = 'primary send-more';
    more.textContent = '▾';
    more.hidden = true;
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-label', COPY.moreLabel);
    more.title = COPY.moreLabel;
    const menu = doc.createElement('div');
    menu.className = 'send-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    if (parent && typeof parent.insertBefore === 'function') parent.insertBefore(wrap, send);
    wrap.append(send, more);
    // The menu floats at the page's top level (position: fixed, placed by place()): the composer clips what sticks out of it
    // (#promptForm has overflow: hidden), so a menu inside it showed only its last ~19 px (QA beta.9).
    const top = doc.body && typeof doc.body.append === 'function' ? doc.body : wrap;
    top.append(menu);
    const self = { wrap, more, menu, send, open: false, index: 0, items: [], buttons: [], mode: 'list', input: null };
    const view = doc.defaultView || (typeof window !== 'undefined' ? window : null);
    // Above the Send split, its right edge on the split's right edge; below it when there is more room there; kept inside the
    // window (8 px from its edges), scrolling inside when even the larger side is too short.
    function place() {
      if (!self.open || typeof wrap.getBoundingClientRect !== 'function') return;
      const GAP = 6,
        EDGE = 8,
        r = wrap.getBoundingClientRect(),
        vw = (view && view.innerWidth) || 0,
        vh = (view && view.innerHeight) || 0;
      if (!vw || !vh) return;
      const above = Math.max(0, r.top - GAP - EDGE),
        below = Math.max(0, vh - r.bottom - GAP - EDGE);
      menu.style.maxHeight = '';
      const width = menu.offsetWidth || 0,
        height = menu.offsetHeight || 0,
        up = height <= above || above >= below,
        room = up ? above : below,
        h = Math.min(height, room);
      if (height > room) menu.style.maxHeight = room + 'px';
      menu.style.left = Math.round(Math.max(EDGE, Math.min(r.right - width, vw - width - EDGE))) + 'px';
      menu.style.top = Math.round(up ? r.top - GAP - h : r.bottom + GAP) + 'px';
      menu.classList.toggle('below', !up);
    }
    if (view && typeof view.addEventListener === 'function') {
      view.addEventListener('resize', place);
      view.addEventListener('scroll', place, true); // a scrolled pane moves the split: the menu follows it
    }

    const enabled = () => self.items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
    function focusIndex(i) {
      self.index = i;
      self.buttons.forEach((b, n) => {
        b.setAttribute('tabindex', n === i ? '0' : '-1');
        b.classList.toggle('active', n === i);
      });
      if (self.buttons[i] && self.buttons[i].focus) self.buttons[i].focus();
    }
    function build() {
      self.buttons = [];
      const nodes = self.items.map((it, i) => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = 'send-item';
        b.setAttribute('role', 'menuitem');
        b.setAttribute('tabindex', '-1');
        if (it.disabled) {
          b.disabled = true;
          b.setAttribute('aria-disabled', 'true');
        }
        const line = doc.createElement('span');
        line.className = 'send-item-line';
        const label = doc.createElement('b');
        label.textContent = it.label;
        line.append(label);
        if (it.key) {
          const k = doc.createElement('kbd');
          k.textContent = it.key;
          line.append(k);
        }
        const hint = doc.createElement('span');
        hint.className = 'send-item-hint';
        hint.textContent = it.hint;
        b.append(line, hint);
        b.addEventListener('click', () => {
          if (it.disabled) return;
          if (it.id === 'later') return api.showLater();
          api.close(false);
          opts.onPick(it.id);
        });
        b.addEventListener('mouseenter', () => !it.disabled && focusIndex(i));
        self.buttons.push(b);
        return b;
      });
      menu.replaceChildren(...nodes);
    }
    // The "Send later…" panel, in place of the list: quick picks, a date+time field (local time), Schedule, and a way back.
    // Buttons (picks, Schedule, Back) are reached with the arrows; the field with Tab (arrows belong to the field).
    function buildLater() {
      const now = Date.now(),
        mk = (tag, cls, text) => {
          const n = doc.createElement(tag);
          if (cls) n.className = cls;
          if (text != null) n.textContent = text;
          return n;
        },
        btn = (label, hint, onClick) => {
          const b = mk('button', 'send-item');
          b.type = 'button';
          b.setAttribute('role', 'menuitem');
          b.setAttribute('tabindex', '-1');
          const line = mk('span', 'send-item-line');
          line.append(mk('b', '', label));
          if (hint) line.append(mk('kbd', '', hint));
          b.append(line);
          b.addEventListener('click', onClick);
          return b;
        };
      const back = btn(COPY.laterBack, '', () => api.showList());
      back.classList.add('send-later-back');
      const picks = laterPicks(now).map((p) =>
        btn(p.label, whenWords(p.at, now), () => api.schedule(p.at)),
      );
      const label = mk('label', 'send-later-custom');
      label.append(mk('span', 'send-item-hint', COPY.laterCustom));
      const input = mk('input', 'send-later-input');
      input.type = 'datetime-local';
      input.value = localValue(now + 60 * 60000);
      input.setAttribute('aria-label', COPY.laterCustom);
      input.min = localValue(now - 300000);
      label.append(input);
      const error = mk('span', 'send-later-error');
      error.setAttribute('role', 'alert');
      error.hidden = true;
      const go = btn(COPY.laterSchedule, '', () => {
        const r = customAt(input.value, Date.now());
        if (r.error) {
          error.textContent = r.error;
          error.hidden = false;
          input.focus && input.focus();
          return;
        }
        api.schedule(r.at);
      });
      go.classList.add('send-later-go');
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          go.click();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          api.close(true);
        } else e.stopPropagation(); // Tab, arrows, digits: the field's own keys, not the menu's
      });
      self.input = input;
      self.buttons = [...picks, go, back];
      menu.replaceChildren(
        mk('span', 'send-later-title', COPY.laterTitle),
        ...picks,
        label,
        error,
        go,
        back,
      );
    }
    const api = {
      state: self,
      // Later mode: the list is replaced by the picks. schedule(at) hands the time to the page (opts.onSchedule) and closes.
      showLater() {
        if (!self.open) return;
        self.mode = 'later';
        buildLater();
        place();
        focusIndex(0);
      },
      showList() {
        self.mode = 'list';
        self.input = null;
        build();
        place();
        const ok = enabled();
        focusIndex(ok.length ? ok[ok.length - 1] : 0);
      },
      schedule(at) {
        api.close(false);
        if (opts.onSchedule) opts.onSchedule(at);
      },
      update(v) {
        self.items = v.items;
        more.hidden = !v.more;
        if (!v.more && self.open) api.close(false);
        // keep an open menu in step with the words (the agent may stop working while it is open); the Send later panel stays as it is
        else if (self.open && self.mode === 'later') return;
        else if (self.open) {
          const at = self.index;
          build();
          place();
          focusIndex(at);
        }
      },
      openMenu() {
        if (more.hidden || self.open) return;
        self.open = true;
        self.mode = 'list';
        build();
        menu.hidden = false;
        place();
        more.setAttribute('aria-expanded', 'true');
        const ok = enabled();
        focusIndex(ok.length ? ok[0] : 0);
      },
      close(refocus) {
        if (!self.open) return;
        self.open = false;
        self.mode = 'list';
        self.input = null;
        menu.hidden = true;
        more.setAttribute('aria-expanded', 'false');
        // back where you were typing (the message box), not onto Send: it may be disabled with an empty box (focus then fell to the
        // page); the Send button only when there is no such place
        if (refocus === false) return;
        const FR = view && view.AgentFocusReturn;
        if (!(FR && FR.back()) && send.focus) send.focus();
      },
      // Keys on the Send button, the ▾ and inside the menu. Returns true when it handled the key.
      onKey(e) {
        if (!self.open) {
          if (e.key === 'ArrowDown' && !more.hidden && !e.altKey && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            api.openMenu();
            return true;
          }
          return false;
        }
        const ok = self.mode === 'later' ? self.buttons.map((_, i) => i) : enabled(),
          at = Math.max(0, ok.indexOf(self.index));
        if (e.key === 'Escape') {
          e.preventDefault();
          api.close(true);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (ok.length) focusIndex(ok[(at + (e.key === 'ArrowDown' ? 1 : ok.length - 1)) % ok.length]);
        } else if (e.key === 'Home' || e.key === 'End') {
          e.preventDefault();
          if (ok.length) focusIndex(e.key === 'Home' ? ok[0] : ok[ok.length - 1]);
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (self.mode === 'later') {
            const b = self.buttons[self.index];
            if (b) b.click();
            return true;
          }
          const it = self.items[self.index];
          if (it && !it.disabled) {
            if (it.id === 'later') api.showLater();
            else {
              api.close(false);
              opts.onPick(it.id);
            }
          }
        } else if (e.key === 'Tab') {
          if (self.mode === 'later') return false; // Tab walks through the panel: picks, the date field, Schedule, Back
          api.close(false);
        } else return false;
        return true;
      },
    };
    more.addEventListener('click', () => (self.open ? api.close(true) : api.openMenu()));
    for (const node of [send, more, menu]) node.addEventListener('keydown', (e) => api.onKey(e));
    if (opts.root && opts.root.addEventListener)
      opts.root.addEventListener('mousedown', (e) => {
        if (self.open && !(wrap.contains && wrap.contains(e.target)) && !(menu.contains && menu.contains(e.target))) api.close(false);
      });
    return api;
  }

  // ---- background pill on a tool row ---------------------------------------------------------------------------
  // bg: tool.background = {state: 'running'|'done'|'stopped', stoppable}. onStop(): called when Stop is clicked.
  function backgroundOf(raw) {
    const bg = raw && (raw.background || (raw.tool && raw.tool.background));
    return bg && typeof bg === 'object' && bg.state ? bg : null;
  }
  function backgroundPill(doc, bg, onStop) {
    const pill = doc.createElement('div');
    pill.className = 'bg-pill bg-' + bg.state;
    const label = doc.createElement('span');
    label.className = 'bg-label';
    label.textContent = bg.state === 'running' ? COPY.bgRunning : bg.state === 'stopped' ? COPY.bgStopped : COPY.bgDone;
    pill.append(label);
    if (bg.state === 'running' && bg.stoppable) {
      const stop = doc.createElement('button');
      stop.type = 'button';
      stop.className = 'bg-stop';
      stop.textContent = COPY.bgStop;
      stop.addEventListener('click', async () => {
        stop.disabled = true;
        stop.textContent = COPY.bgStopping;
        try {
          await onStop();
        } catch {
          stop.disabled = false;
          stop.textContent = COPY.bgStop;
        }
      });
      pill.append(stop);
    }
    return pill;
  }

  const api = { COPY, isSlashCommand, view, route, keyIntent, init, backgroundOf, backgroundPill, whenWords, laterPicks, customAt, localValue };
  root.AgentSendMenu = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

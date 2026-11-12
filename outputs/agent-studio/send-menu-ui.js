// The composer while the agent works: Enter = Send now (steer), Alt+Enter = Send after this turn, Shift+Enter = new line,
// and a small "Send ▾" menu with the third choice, Interrupt and send. When the agent is idle none of this shows.
// Pure rules (what a key does, which route a send takes, the words) are exported for the node tests; the menu is drawn into the page.
// ALL the words of this feature live in COPY below, so they can be adjusted in one place.
(function (root) {
  'use strict';

  const COPY = {
    // Grey line under "Send now", per agent. claude / codex / omp are the agent ids; anything else uses nowHintOther.
    nowHint: {
      claude: 'Claude Code answers right away. A command or helper it is running keeps going in the background.',
      codex:
        "Codex answers right away. A command it is running keeps going in the background, and Codex isn't told when it ends.",
      omp: 'OMP answers right away. A command it is running moves to the background, and OMP stops it after 2 minutes in total.',
    },
    nowHintOther: (agent) => agent + ' reads it during this turn.',
    cantSteerMenu: (agent) =>
      agent + ' can’t read messages during a turn. Use "Send after this turn" or "Interrupt and send".',
    cantSteerKey: (agent) => agent + ' can’t read messages mid-turn · Enter sends when it ends',
    keyHintSteer: 'Enter send now · Alt+Enter after this turn',
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
    heldHead: 'Held until you answer the card above',
    sendingHead: 'Sending',
    fallbackNote: 'Couldn’t send now: sends when this turn ends',
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

  // ctx: {busy, hasQueue, steerable, agentId, agent, text, commands}. What the composer shows.
  function view(ctx) {
    const agent = ctx.agent || 'the agent',
      working = !!ctx.busy,
      slash = working && isSlashCommand(ctx.text, ctx.commands),
      steer = working && !!ctx.steerable,
      steerNow = steer && !slash;
    const out = { working, steerable: steer, slash, more: working, keyHint: '', placeholder: '', note: '', items: [] };
    if (!working) return out;
    if (slash) out.keyHint = COPY.keyHintCommand;
    else if (steer) out.keyHint = COPY.keyHintSteer;
    else out.keyHint = COPY.cantSteerKey(agent);
    out.placeholder = steerNow ? COPY.placeholderSteer(agent) : COPY.placeholderQueue(agent);
    out.note = steerNow ? COPY.noteSteer : COPY.noteQueue;
    const nowHint = steer ? COPY.nowHint[ctx.agentId] || COPY.nowHintOther(agent) : COPY.cantSteerMenu(agent);
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
  // init({send, doc, root, onPick(id)}) puts a ▾ and its menu next to the Send button, inside one wrapper.
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
    wrap.append(send, more, menu);
    const self = { wrap, more, menu, send, open: false, index: 0, items: [], buttons: [] };

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
          api.close(false);
          opts.onPick(it.id);
        });
        b.addEventListener('mouseenter', () => !it.disabled && focusIndex(i));
        self.buttons.push(b);
        return b;
      });
      menu.replaceChildren(...nodes);
    }
    const api = {
      state: self,
      update(v) {
        self.items = v.items;
        more.hidden = !v.more;
        if (!v.more && self.open) api.close(false);
        // keep an open menu in step with the words (the agent may stop working while it is open)
        else if (self.open) {
          const at = self.index;
          build();
          focusIndex(at);
        }
      },
      openMenu() {
        if (more.hidden || self.open) return;
        self.open = true;
        build();
        menu.hidden = false;
        more.setAttribute('aria-expanded', 'true');
        const ok = enabled();
        focusIndex(ok.length ? ok[0] : 0);
      },
      close(refocus) {
        if (!self.open) return;
        self.open = false;
        menu.hidden = true;
        more.setAttribute('aria-expanded', 'false');
        if (refocus !== false && send.focus) send.focus();
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
        const ok = enabled(),
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
          const it = self.items[self.index];
          if (it && !it.disabled) {
            api.close(false);
            opts.onPick(it.id);
          }
        } else if (e.key === 'Tab') {
          api.close(false);
        } else return false;
        return true;
      },
    };
    more.addEventListener('click', () => (self.open ? api.close(true) : api.openMenu()));
    for (const node of [send, more, menu]) node.addEventListener('keydown', (e) => api.onKey(e));
    if (opts.root && opts.root.addEventListener)
      opts.root.addEventListener('mousedown', (e) => {
        if (self.open && !(wrap.contains && wrap.contains(e.target))) api.close(false);
      });
    return api;
  }

  // ---- the key hint under the message box ------------------------------------------------------------------
  // host: the composer form. The hint is a row of its own (chat.css), shown only while the agent works.
  function keyHintNode(doc, host) {
    let node = doc.getElementById ? doc.getElementById('sendKeyHint') : null;
    if (node) return node;
    node = doc.createElement('p');
    node.id = 'sendKeyHint';
    node.className = 'send-key-hint';
    node.hidden = true;
    if (host && host.append) host.append(node);
    return node;
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

  const api = { COPY, isSlashCommand, view, route, keyIntent, init, keyHintNode, backgroundOf, backgroundPill };
  root.AgentSendMenu = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

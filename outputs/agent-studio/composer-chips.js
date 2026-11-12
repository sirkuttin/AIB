(function (root) {
  'use strict';
  // Compact setting chips under the message box: agent (read-only in a chat), model, mode, effort, branch, context % (with
  // the session-details tooltip: context, cost, session id, notices), usage limits (percent used per window, with resets).
  // No Project chip: a chat keeps its agent; only the New
  // chat page (opts.onAgent) lets the Agent chip pick one.
  // A chip with choices opens a menu that lists them directly (one row each, the current one checked, one click picks and
  // closes; arrow keys, Enter, Escape and type-ahead). Choices come from the same advertised settings as the settings panel
  // (config-ui.js flatChoices), and the host validates them. While a turn runs a pick is queued by the agent host ("pending
  // change") and applied when the turn ends; the chip shows it with a cancel. The Model chip shows the model the
  // replies really come from (read from the agent's transcript by the server) when that is known, with a warning when
  // the agent advertises a different one. Agent text uses textContent only.
  const el = (doc, tag, text, cls) => {
    const n = doc.createElement(tag);
    if (text != null) n.textContent = String(text);
    if (cls) n.className = cls;
    return n;
  };

  // The project's display name when one was set on the rail (the workspace module owns it), else "".
  function projectLabel(cwd) {
    const w = typeof window !== 'undefined' ? window.AgentWorkspaceUI : null;
    try {
      return w && w.customNameFor ? w.customNameFor(cwd) : '';
    } catch (e) {
      return '';
    }
  }
  function lastSegment(path) {
    const parts = String(path || '')
      .split(/[\\/]+/)
      .filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(path || '');
  }

  function selectOption(settings, test) {
    for (const o of settings && Array.isArray(settings.configOptions) ? settings.configOptions : []) {
      if (
        o &&
        typeof o === 'object' &&
        typeof o.id === 'string' &&
        test(o) &&
        (o.type === 'select' || (o.type === undefined && Array.isArray(o.options)))
      ) {
        const choices = root.AgentConfigUI ? root.AgentConfigUI.flatChoices(o) : [];
        if (choices.length) return o;
      }
    }
    return null;
  }

  // ---- model names -------------------------------------------------------------------------
  // "claude-opus-5-5", "claude-sonnet-4-5-20250929", "claude-3-5-sonnet-20241022", "Sonnet 5.5", "opus[1m]" -> family + version.
  function parseModel(id) {
    if (typeof id !== 'string') return null;
    const s = id
      .trim()
      .toLowerCase()
      .replace(/\[[^\]]*\]$/, '')
      .replace(/-\d{8}$/, '')
      .replace(/-v\d+(:\d+)?$/, '');
    let m = s.match(/claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku|fable)(?![a-z])/);
    if (m) return { family: m[3], version: m[2] ? m[1] + '.' + m[2] : m[1] };
    m = s.match(/(?:^|[^a-z])(opus|sonnet|haiku|fable)(?:[-\s]+(\d+)(?:[-.](\d+))?)?(?![a-z])/);
    if (m) return { family: m[1], version: m[2] ? (m[3] ? m[2] + '.' + m[3] : m[2]) : '' };
    return null;
  }

  function friendlyModel(id) {
    const p = parseModel(id);
    if (!p) return String(id == null ? '' : id).slice(0, 60);
    return p.family.charAt(0).toUpperCase() + p.family.slice(1) + (p.version ? ' ' + p.version : '');
  }

  function advertisedTexts(option) {
    const cur = (root.AgentConfigUI ? root.AgentConfigUI.flatChoices(option) : []).find(
      (c) => c.value === option.currentValue,
    );
    return {
      names: [option.currentValue, cur && cur.name].filter((x) => typeof x === 'string' && x),
      description: cur && typeof cur.description === 'string' ? cur.description : '',
    };
  }

  // true = the same model (or we cannot tell: never warn without evidence); false = positively different.
  function sameModel(inUse, option) {
    const adv = advertisedTexts(option),
      u = parseModel(inUse.model);
    const parsed = adv.names.map(parseModel).filter(Boolean);
    if (!parsed.length && adv.description) {
      const d = parseModel(adv.description);
      if (d) parsed.push(d);
    }
    if (u && parsed.length) {
      const a = parsed.find((x) => x.version) || parsed[0];
      return a.family === u.family && (!a.version || !u.version || a.version === u.version);
    }
    if (adv.names.some((n) => /^default\b|recommended/i.test(n))) return true; // "Default" stands for whatever the account runs by default: no evidence either way
    const forms = [inUse.model, inUse.provider ? inUse.provider + '/' + inUse.model : '']
      .filter(Boolean)
      .map((x) => x.toLowerCase());
    return adv.names.some((n) =>
      forms.some((f) => {
        const x = n.toLowerCase();
        return x === f || x.includes(f) || f.includes(x);
      }),
    );
  }

  function choiceName(option, value) {
    const hit = (root.AgentConfigUI ? root.AgentConfigUI.flatChoices(option) : []).find((c) => c.value === value);
    if (hit) return hit.name || hit.value;
    if (value === true) return 'On';
    if (value === false) return 'Off';
    return String(value);
  }

  function valueName(option) {
    return choiceName(option, option.currentValue);
  }

  // ---- the Limits chip ---------------------------------------------------------------------------------------------
  // The account's subscription limits (server/state/usage_limits.ts snapshot): percent used per window, labels from the data
  // ("5h 42% · wk 18%", "wk 26%"). Hover: each window's reset time (local and "in 2h 10m"), the plan when known, how fresh the
  // numbers are. Same tones as Ctx: high at 85% or more; blocked (red) when a window is rejected / at 100% or the cap is reached.
  // A window whose reset time has passed is dropped (its numbers are old); no window left and not blocked: no chip.
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad2 = (n) => String(n).padStart(2, '0');
  // Local time of a reset: "14:20" today, "Sun 03:00" within the week, "Nov 20 03:00" later.
  function localWhen(ms, nowMs) {
    const d = new Date(ms),
      now = new Date(nowMs);
    const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return hm;
    if (ms - nowMs < 6 * 86400000) return DAYS[d.getDay()] + ' ' + hm;
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + ' ' + hm;
  }
  // "in 2h 10m", "in 3d 4h", "in 12m", "in under a minute".
  function untilText(ms, nowMs) {
    const mins = Math.floor((ms - nowMs) / 60000);
    if (mins < 1) return 'in under a minute';
    const d = Math.floor(mins / 1440),
      h = Math.floor((mins % 1440) / 60),
      m = mins % 60;
    if (d) return 'in ' + d + 'd' + (h ? ' ' + h + 'h' : '');
    if (h) return 'in ' + h + 'h' + (m ? ' ' + m + 'm' : '');
    return 'in ' + m + 'm';
  }
  function agoText(seconds, nowMs) {
    const mins = Math.floor((nowMs - seconds * 1000) / 60000);
    if (mins < 1) return 'updated just now';
    if (mins < 60) return 'updated ' + mins + ' min ago';
    const h = Math.floor(mins / 60);
    if (h < 24) return 'updated ' + h + ' h ago';
    const d = Math.floor(h / 24);
    return 'updated ' + d + (d === 1 ? ' day' : ' days') + ' ago';
  }
  const pctText = (n) => Math.round(n) + '%';
  const resetText = (at, nowMs) =>
    at ? 'resets ' + localWhen(at * 1000, nowMs) + ' (' + untilText(at * 1000, nowMs) + ')' : '';

  // {value, tone, details} for the chip, or null when there is nothing to show. Pure (nowMs is passed in).
  function describeLimits(limits, nowMs) {
    if (!limits || typeof limits !== 'object' || !Array.isArray(limits.windows)) return null;
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const live = (at) => !at || at * 1000 > now;
    const windows = limits.windows.filter(
      (w) => w && typeof w === 'object' && typeof w.label === 'string' && live(Number(w.resetsAt) || 0),
    );
    const capped = !!(limits.blocked && live(Number(limits.blocked.resetsAt) || 0));
    const numbered = windows.filter((w) => typeof w.usedPercent === 'number');
    const isBlocked = (w) => w.status === 'rejected' || (typeof w.usedPercent === 'number' && w.usedPercent >= 100);
    const byLength = (a, b) => (Number(a.minutes) || 0) - (Number(b.minutes) || 0);
    // The chip: the all-models windows, shortest first; model-scoped ones only when there is nothing else (all are in the hover).
    let shown = numbered.filter((w) => !w.scope).sort(byLength);
    if (!shown.length) shown = numbered.slice().sort((a, b) => b.usedPercent - a.usedPercent);
    shown = shown.slice(0, 3);
    const rejected = windows.filter((w) => !w.scope && w.status === 'rejected' && typeof w.usedPercent !== 'number');
    if (!shown.length && !capped && !rejected.length) return null;
    const blocked = capped || rejected.length > 0 || shown.some(isBlocked);
    const high = shown.some((w) => Math.round(w.usedPercent) >= 85); // as shown, like Ctx
    const value = shown.length
      ? shown.map((w) => w.label + ' ' + pctText(w.usedPercent)).join(' \u00B7 ')
      : 'limit reached';
    const details = [];
    if (capped) {
      const at = Number(limits.blocked.resetsAt) || 0;
      details.push('Limit reached' + (at ? ' \u00B7 ' + resetText(at, now) : ''));
    }
    for (const w of windows) {
      const at = Number(w.resetsAt) || 0;
      const used =
        typeof w.usedPercent === 'number'
          ? pctText(w.usedPercent) + ' used' + (isBlocked(w) ? ' \u00B7 limit reached' : '')
          : w.status === 'rejected'
            ? 'limit reached'
            : 'no number yet';
      details.push(String(w.name || w.label) + ': ' + used + (at ? ' \u00B7 ' + resetText(at, now) : ''));
    }
    if (typeof limits.plan === 'string' && limits.plan) details.push('Plan: ' + limits.plan);
    for (const n of Array.isArray(limits.notes) ? limits.notes : []) if (typeof n === 'string' && n) details.push(n);
    if (Number(limits.updatedAt) > 0) {
      const ago = agoText(Number(limits.updatedAt), now);
      details.push(ago.charAt(0).toUpperCase() + ago.slice(1));
    }
    return { value, tone: blocked ? 'blocked' : high ? 'high' : '', details };
  }

  // Which chips exist and what they say. Pure, so it can be tested without a DOM.
  function describe(model) {
    const settings = model.settings || null,
      chips = [];
    const pending = Array.isArray(model.pending) ? model.pending : [];
    const pendingOf = (key) => pending.find((p) => p && p.key === key) || null;
    const modes = settings && settings.modes;
    const withPending = (chip, key, nameOf) => {
      const p = pendingOf(key);
      if (p) chip.pending = { key, value: p.value, name: nameOf(p.value) };
      return chip;
    };
    let modeChip = null,
      modelChip = null;
    if (modes && Array.isArray(modes.availableModes) && modes.availableModes.length) {
      const current = modes.availableModes.find((m) => m && m.id === modes.currentModeId);
      const modeName = (id) => {
        const hit = modes.availableModes.find((m) => m && m.id === id);
        return hit ? hit.name || hit.id : String(id);
      };
      modeChip = withPending(
        {
          id: 'mode',
          label: 'Mode',
          value: current ? current.name || current.id : String(modes.currentModeId),
          hint: current && current.description,
          subset: { modes },
        },
        'mode',
        modeName,
      );
    } else {
      const option = selectOption(settings, (o) => o.category === 'mode' || o.id === 'mode');
      if (option)
        modeChip = withPending(
          {
            id: 'mode',
            label: 'Mode',
            value: valueName(option),
            hint: option.description,
            subset: { configOptions: [option] },
          },
          'config:' + option.id,
          (v) => choiceName(option, v),
        );
    }
    const advertised = selectOption(settings, (o) => o.category === 'model' || o.id === 'model');
    const inUse =
      model.inUse &&
      typeof model.inUse === 'object' &&
      typeof model.inUse.model === 'string' &&
      model.inUse.model.trim()
        ? model.inUse
        : null;
    if (advertised || inUse) {
      const advertisedName = advertised ? valueName(advertised) : '';
      const usedName = inUse ? friendlyModel(inUse.model) : '';
      const differs = !!(advertised && inUse && !sameModel(inUse, advertised));
      const chip = {
        id: 'model',
        label: 'Model',
        value: inUse ? usedName : advertisedName,
        hint: advertised && advertised.description,
      };
      if (differs)
        chip.warn = 'The agent reports ' + advertisedName + ', but its replies are coming from ' + usedName + '.';
      if (advertised)
        chip.subset = {
          configOptions: [
            differs
              ? Object.assign({}, advertised, { currentValue: inUse.model, unlistedLabel: usedName })
              : advertised,
          ],
        };
      if (!advertised) chip.title = 'Model: ' + usedName + '\nThis agent does not advertise a model setting.';
      if (inUse && !differs && inUse.model !== usedName)
        chip.title = (chip.title ? chip.title + '\n' : '') + 'Model id: ' + inUse.model;
      modelChip = advertised ? withPending(chip, 'config:' + advertised.id, (v) => choiceName(advertised, v)) : chip;
    }
    const effortOption = selectOption(
      settings,
      (o) => o.category === 'thought_level' || /^(effort|reasoning|thought|thinking)/i.test(o.id),
    );
    const effortChip = !effortOption
      ? null
      : withPending(
          {
            id: 'effort',
            label: 'Effort',
            value: valueName(effortOption),
            hint: effortOption.description,
            subset: { configOptions: [effortOption] },
          },
          'config:' + effortOption.id,
          (v) => choiceName(effortOption, v),
        );
    for (const c of [modelChip, modeChip, effortChip]) if (c) chips.push(c);
    // Read-only stand-ins the caller adds (the New chat page while it asks the agent for its lists): {id, label, value, title}.
    for (const x of Array.isArray(model.extraChips) ? model.extraChips : [])
      if (x && typeof x.id === 'string' && !chips.some((c) => c.id === x.id))
        chips.push({
          id: x.id,
          label: String(x.label || ''),
          value: String(x.value || ''),
          title: String(x.title || ''),
        });
    // No Project chip: the project dropdown above the chat list already names it (owner decision).
    const branch = typeof model.branch === 'string' ? model.branch.trim() : '';
    if (branch && model.cwd) chips.push({ id: 'branch', label: 'Branch', value: branch, title: 'Branch: ' + branch });
    const u = model.usage && typeof model.usage === 'object' ? model.usage : null;
    const details = Array.isArray(model.details) ? model.details.filter((x) => typeof x === 'string' && x) : [];
    if (u && Number(u.size) > 0 && u.used != null && Number.isFinite(Number(u.used))) {
      const pct = Math.max(0, Math.round((Number(u.used) / Number(u.size)) * 100));
      chips.push({ id: 'ctx', label: 'Ctx', value: pct + '%', tone: pct >= 85 ? 'high' : '', title: '', details });
    } else if (details.length) {
      chips.push({ id: 'ctx', label: 'Ctx', value: '\u2013', tone: '', title: '', details });
    }
    // After Ctx: the account's usage limits; no chip for agents with no official source (the server sends none).
    const lim = describeLimits(model.limits, model.now);
    if (lim)
      chips.push({ id: 'limits', label: 'Limits', value: lim.value, tone: lim.tone, title: '', details: lim.details });
    // The Agent chip comes first and is read-only: a conversation keeps its agent (Continue with another agent is in the chat's right-click menu).
    if (model.agent)
      chips.unshift({
        id: 'agent',
        kind: 'static',
        label: 'Agent',
        agentId: model.agentId || '',
        letter: String(model.agent).charAt(0).toUpperCase(),
        value: model.agent + (model.account ? ' \u00B7 ' + model.account : ''),
        title: model.account ? model.agent + ' account ' + model.account : model.agent,
        agents: Array.isArray(model.agents) ? model.agents : null,
      });
    const hasPanel = !!(
      settings &&
      ((modes && Array.isArray(modes.availableModes) && modes.availableModes.length) ||
        (Array.isArray(settings.configOptions) && settings.configOptions.length))
    );
    return { chips, hasPanel };
  }

  const view = { open: null, signature: '', panelOpen: false, seen: new Set() };

  // ---- the choice menu ---------------------------------------------------------------------------------------------
  // One menu at a time, on <body> (position: fixed), so it is never clipped by the composer and can be kept on screen.
  // spec: {label, items: [{value, name, description?, group?, disabled?, tag?}], current, disabled, notes: [string],
  //        extra: Node, onPick(value)}. Looks like the row ⋯ menu (.organize-menu).
  const menu = { node: null, trigger: null, off: null, typed: '', typedAt: 0 };

  function closeMenu(focusBack) {
    const node = menu.node,
      trigger = menu.trigger;
    if (!node) return;
    menu.node = null;
    menu.trigger = null;
    if (menu.off) menu.off();
    menu.off = null;
    node.remove();
    view.open = null;
    if (trigger && trigger.setAttribute) trigger.setAttribute('aria-expanded', 'false');
    if (focusBack && trigger && trigger.focus && trigger.isConnected !== false) trigger.focus();
  }
  const closePop = () => closeMenu(false);

  // Where the menu goes: above the chip when there is room (the chips sit at the bottom of the window), else below; always
  // inside the window with an 8 px margin, the list scrolling when it is taller than the room. Pure, so it can be tested.
  function place(rect, size, viewport) {
    const m = 8,
      vw = viewport.width,
      vh = viewport.height;
    const above = rect.top - m - 4,
      below = vh - rect.bottom - m - 4;
    const up = size.height <= above || above >= below;
    const room = Math.max(80, up ? above : below);
    const height = Math.min(size.height, room);
    const width = Math.min(size.width, vw - 2 * m);
    const top = up ? Math.max(m, rect.top - 4 - height) : Math.min(vh - m - height, rect.bottom + 4);
    const left = Math.max(m, Math.min(vw - m - width, rect.left));
    return { top: Math.round(top), left: Math.round(left), maxHeight: Math.floor(room), up };
  }

  function openMenu(doc, trigger, spec) {
    closeMenu(false);
    menu.typed = '';
    const win = doc.defaultView || root;
    const node = el(doc, 'div', null, 'organize-menu chip-menu');
    node.setAttribute('role', 'menu');
    node.setAttribute('aria-label', spec.label);
    if (trigger.id) node.setAttribute('aria-labelledby', trigger.id);
    const head = el(doc, 'div', spec.label, 'chip-menu-head');
    head.setAttribute('role', 'presentation');
    const list = el(doc, 'div', null, 'chip-menu-list');
    list.setAttribute('role', 'presentation');
    const buttons = [];
    let group = null;
    for (const item of spec.items) {
      if (item.group && item.group !== group) {
        const g = el(doc, 'div', item.group, 'chip-menu-group');
        g.setAttribute('role', 'presentation');
        list.appendChild(g);
      }
      group = item.group || null;
      const checked = item.value === spec.current;
      const b = el(doc, 'button', null, 'chip-menu-item' + (checked ? ' checked' : ''));
      b.type = 'button';
      b.tabIndex = -1;
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(checked));
      const off = !!(spec.disabled || item.disabled);
      if (off) b.setAttribute('aria-disabled', 'true');
      if (!b.dataset) b.dataset = {};
      b.dataset.value = item.value;
      const mark = el(doc, 'span', checked ? '\u2713' : '', 'chip-menu-check');
      mark.setAttribute('aria-hidden', 'true');
      const body = el(doc, 'span', null, 'chip-menu-text');
      const name = el(doc, 'span', item.name, 'chip-menu-name');
      if (item.tag) name.appendChild(el(doc, 'span', item.tag, 'chip-menu-tag'));
      body.appendChild(name);
      if (item.description) body.appendChild(el(doc, 'span', item.description, 'chip-menu-desc'));
      b.append(mark, body);
      b.addEventListener('click', () => {
        if (off) return;
        closeMenu(true);
        spec.onPick(item.value);
      });
      list.appendChild(b);
      buttons.push(b);
    }
    node.append(head, list);
    for (const text of spec.notes || [])
      if (text) node.appendChild(el(doc, 'span', text, 'chip-menu-note config-note'));
    if (spec.extra) node.appendChild(spec.extra);
    const usable = buttons.filter((b) => b.getAttribute('aria-disabled') !== 'true');
    const focusAt = (b) => {
      if (!b) return;
      b.focus();
      if (b.scrollIntoView) b.scrollIntoView({ block: 'nearest' });
    };
    node.addEventListener('keydown', (event) => {
      const pool = usable.length ? usable : buttons;
      const at = pool.indexOf(doc.activeElement);
      const go = (i) => {
        event.preventDefault();
        if (pool.length) focusAt(pool[(i + pool.length) % pool.length]);
      };
      if (event.key === 'ArrowDown') go(at + 1);
      else if (event.key === 'ArrowUp') go(at < 0 ? -1 : at - 1);
      else if (event.key === 'Home') go(0);
      else if (event.key === 'End') go(-1);
      else if (event.key === 'Escape') {
        event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        closeMenu(true);
      } else if (event.key === 'Tab') closeMenu(false);
      else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const b = doc.activeElement;
        if (buttons.includes(b)) b.click();
      } else if (event.key && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        // Type-ahead: the next row whose name starts with what was typed in the last second.
        const t = Date.now();
        menu.typed = (t - menu.typedAt < 1000 ? menu.typed : '') + event.key.toLowerCase();
        menu.typedAt = t;
        const nameOf = (b) => (b.querySelector('.chip-menu-name') || b).textContent.trim().toLowerCase();
        // The same letter again moves on to the next match; several letters match a prefix from the row in focus.
        const q = /^(.)\1+$/.test(menu.typed) ? menu.typed[0] : menu.typed;
        const start = q.length > 1 ? Math.max(0, at) : at + 1;
        for (let k = 0; k < pool.length; k++) {
          const b = pool[(start + k) % pool.length];
          if (nameOf(b).startsWith(q)) {
            event.preventDefault();
            focusAt(b);
            break;
          }
        }
      }
    });
    doc.body.appendChild(node);
    menu.node = node;
    menu.trigger = trigger;
    view.open = node;
    trigger.setAttribute('aria-expanded', 'true');
    const rect = trigger.getBoundingClientRect
      ? trigger.getBoundingClientRect()
      : { top: 600, bottom: 626, left: 0, right: 0 };
    const where = place(
      rect,
      { width: node.offsetWidth || 240, height: node.offsetHeight || 200 },
      { width: win.innerWidth || 1200, height: win.innerHeight || 800 },
    );
    node.style.maxHeight = where.maxHeight + 'px';
    node.style.left = where.left + 'px';
    node.style.top = where.top + 'px';
    node.classList.toggle('chip-menu-up', where.up);
    if (root.AgentTextSize && root.AgentTextSize.fitPopup) root.AgentTextSize.fitPopup(node);
    // A pointer press outside closes it (the chip itself toggles it on click); so does resizing the window.
    const outside = (e) => {
      if (!node.contains(e.target) && !(trigger.contains && trigger.contains(e.target))) closeMenu(false);
    };
    const resized = () => closeMenu(false);
    doc.addEventListener('mousedown', outside, true);
    if (win.addEventListener) win.addEventListener('resize', resized);
    menu.off = () => {
      doc.removeEventListener('mousedown', outside, true);
      if (win.removeEventListener) win.removeEventListener('resize', resized);
    };
    focusAt(buttons.find((b) => b.getAttribute('aria-checked') === 'true') || usable[0] || buttons[0]);
    return node;
  }

  // The rows a chip's menu lists, from its subset of the settings: session modes, or one select config option (groups flattened
  // with their names; the model in use when the agent does not list it comes first, marked and not pickable).
  function menuItems(subset) {
    const modes = subset.modes;
    if (modes && Array.isArray(modes.availableModes) && modes.availableModes.length) {
      return {
        kind: 'mode',
        current: modes.currentModeId,
        items: modes.availableModes
          .filter((m) => m && typeof m.id === 'string')
          .map((m) => ({ value: m.id, name: m.name || m.id, description: m.description || '' })),
      };
    }
    const option = subset.configOptions[0],
      items = [];
    for (const item of Array.isArray(option.options) ? option.options : []) {
      if (item && Array.isArray(item.options)) {
        const group = String(item.name || item.group || '');
        for (const o of item.options)
          if (o && typeof o.value === 'string')
            items.push({ value: o.value, name: o.name || o.value, description: o.description || '', group });
      } else if (item && typeof item.value === 'string')
        items.push({ value: item.value, name: item.name || item.value, description: item.description || '' });
    }
    if (!items.some((i) => i.value === option.currentValue))
      items.unshift({
        value: String(option.currentValue),
        name: option.unlistedLabel || String(option.currentValue),
        tag: option.unlistedLabel ? 'in use' : '',
        disabled: !!option.unlistedLabel,
      });
    return { kind: 'config', option, current: option.currentValue, items };
  }

  // Queued changes the agent refused: say so once, in words ("it stays on ...": the chip already shows the real value).
  function failureText(model, f) {
    const settings = model.settings || {};
    let label = 'Setting',
      shown = String(f.value),
      current = '';
    if (f.kind === 'mode') {
      const modes = settings.modes || {},
        list = Array.isArray(modes.availableModes) ? modes.availableModes : [];
      const name = (id) => {
        const hit = list.find((m) => m && m.id === id);
        return hit ? hit.name || hit.id : String(id);
      };
      label = 'Mode';
      shown = name(f.value);
      current = name(modes.currentModeId);
    } else {
      const option = (Array.isArray(settings.configOptions) ? settings.configOptions : []).find(
        (o) => o && o.id === f.configId,
      );
      if (option) {
        label = option.name || option.id;
        shown = choiceName(option, f.value);
        current = choiceName(option, option.currentValue);
      }
    }
    return (
      label +
      ' was not changed to ' +
      shown +
      ' after the turn: ' +
      String(f.message || 'the agent refused') +
      (current ? ' It stays ' + current + '.' : '')
    );
  }

  function announceFailures(model, o) {
    const list = Array.isArray(model.failures) ? model.failures : [];
    for (const f of list) {
      if (!f || typeof f.seq !== 'number') continue;
      const id = String(model.id || '') + ':' + f.seq;
      if (view.seen.has(id)) continue;
      view.seen.add(id);
      if (view.seen.size > 200) view.seen.delete(view.seen.values().next().value);
      if (typeof f.time === 'number' && Date.now() / 1000 - f.time > 180) continue; // old news after a page reload
      if (o.onError) o.onError(new Error(failureText(model, f)));
    }
  }

  // The Agent chip: read-only name with the agent's letter icon.
  function agentChip(doc, chip) {
    const wrap = el(doc, 'span', null, 'chip-wrap chip-wrap-agent');
    const span = el(doc, 'span', null, 'chip chip-agent chip-static');
    span.title = chip.title + '\nThe agent cannot change inside a conversation.';
    span.append(
      el(doc, 'span', 'Agent', 'chip-k'),
      el(doc, 'span', chip.letter, 'chip-icon'),
      el(doc, 'span', chip.value, 'chip-v'),
    );
    wrap.append(span);
    return wrap;
  }

  // The Agent chip on the New chat page: the same menu, listing the agents a new chat can use.
  function agentPicker(doc, chip, o) {
    const wrap = el(doc, 'span', null, 'chip-wrap chip-wrap-agent');
    const button = el(doc, 'button', null, 'chip chip-agent');
    button.type = 'button';
    button.id = 'chip-agent';
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.title = 'Agent for this new chat: ' + chip.value;
    button.append(
      el(doc, 'span', 'Agent', 'chip-k'),
      el(doc, 'span', chip.letter, 'chip-icon'),
      el(doc, 'span', chip.value, 'chip-v'),
      el(doc, 'span', '\u25BE', 'chip-caret'),
    );
    if (o.disabled) button.classList.add('chip-locked');
    button.addEventListener('click', () => {
      if (menu.node && menu.trigger === button) return closeMenu(true);
      openMenu(doc, button, {
        label: 'Agent',
        // Beta agents come last, under a "Beta" group label (AgentChoice.menuItems gives them a.group).
        items: chip.agents.map((a) => ({
          value: a.id,
          name: a.name,
          group: a.group || '',
          disabled: !!a.disabled,
          tag: a.reason || '',
        })),
        extra: setupLink(doc, chip, o),
        current: chip.agentId,
        disabled: !!o.disabled,
        notes: [],
        onPick: (id) => {
          if (id !== chip.agentId) o.onAgent(id);
        },
      });
    });
    wrap.append(button);
    return wrap;
  }

  // "Set up in Settings ›" at the end of the agent menu when some agents are listed greyed.
  function setupLink(doc, chip, o) {
    if (!o.onSetup || !chip.agents.some((a) => a.disabled)) return null;
    const link = el(doc, 'button', 'Set up in Settings ›', 'chip-insert chip-setup');
    link.type = 'button';
    link.addEventListener('click', () => {
      closeMenu(false);
      o.onSetup();
    });
    return link;
  }

  // The Ctx chip's hover / focus tooltip: one line per detail. Pure CSS shows it (see header.css .chip-tip).
  function fillTip(doc, tip, lines) {
    tip.replaceChildren(...lines.map((line) => el(doc, 'span', line, 'chip-tip-line')));
  }

  // opts: {settingsPanel, disabled, busy, onMode, onConfig, onCancelPending, onInsertText, onError, afterChange}
  function render(box, model, opts) {
    const doc = box.ownerDocument,
      o = opts || {};
    announceFailures(model, o);
    const d = describe(model);
    const commands = Array.isArray(model.commands) ? model.commands : [];
    const hasModelCommand = commands.some((c) => c && c.name === 'model');
    const isStatic = (c) => c.id === 'ctx' || c.id === 'branch' || c.id === 'limits';
    const staticSig = JSON.stringify(d.chips.filter(isStatic).map((c) => [c.id, c.value, c.title, c.tone, c.details]));
    const signature = JSON.stringify([
      d.chips.map((c) =>
        isStatic(c) ? [c.id] : [c.id, c.kind, c.agentId, c.value, c.title, c.warn, c.pending && c.pending.value],
      ),
      d.hasPanel,
      !!o.disabled,
      !!o.busy,
      hasModelCommand,
      view.panelOpen,
    ]);
    if (o.settingsPanel) o.settingsPanel.hidden = !(d.hasPanel && view.panelOpen);
    if (signature === view.signature && box.children.length) {
      // Only the read-only chips (context %, branch) changed: update their text in place so an open menu stays open.
      if (staticSig !== view.staticSig) {
        view.staticSig = staticSig;
        for (const c of d.chips.filter(isStatic)) {
          const chipEl = box.querySelector && box.querySelector('.chip-' + c.id),
            v = chipEl && chipEl.querySelector && chipEl.querySelector('.chip-v');
          if (v) v.textContent = c.value;
          if (chipEl) {
            chipEl.title = c.title || '';
            chipEl.classList.toggle('chip-tone-high', c.tone === 'high');
            chipEl.classList.toggle('chip-tone-blocked', c.tone === 'blocked');
            if (c.id === 'limits') chipEl.setAttribute('aria-label', 'Usage limits ' + c.value + '. Details');
          }
          const tip = c.details && box.querySelector && box.querySelector('.chip-' + c.id + ' + .chip-tip');
          if (tip) fillTip(doc, tip, c.details);
        }
      }
      return;
    }
    view.signature = signature;
    view.staticSig = staticSig;
    // A chip that had the focus (a pick just closed its menu and the chips are rebuilt for the new value) keeps it.
    const active = doc.activeElement,
      inMenu = !!(menu.node && active && menu.node.contains(active));
    const refocus =
      active && ((box.contains && box.contains(active)) || inMenu)
        ? inMenu && menu.trigger
          ? menu.trigger.id
          : active.id
        : '';
    closePop();
    box.replaceChildren();
    box.hidden = !d.chips.length && !d.hasPanel;
    const after = () => {
      view.signature = '';
      return o.afterChange && o.afterChange();
    };
    for (const chip of d.chips) {
      if (chip.kind && o.onAgent && chip.agents && chip.agents.length) {
        box.append(agentPicker(doc, chip, o));
        continue;
      }
      if (chip.kind) {
        box.append(agentChip(doc, chip));
        continue;
      }
      const wrap = el(doc, 'span', null, 'chip-wrap');
      const interactive = !!chip.subset && !!root.AgentConfigUI;
      const button = el(
        doc,
        interactive ? 'button' : 'span',
        null,
        'chip chip-' +
          chip.id +
          (interactive ? '' : ' chip-static') +
          (chip.pending ? ' chip-pending' : '') +
          (chip.warn ? ' chip-mismatch' : '') +
          (chip.tone === 'high' ? ' chip-tone-high' : '') +
          (chip.tone === 'blocked' ? ' chip-tone-blocked' : ''),
      );
      if (interactive) {
        button.type = 'button';
        button.id = 'chip-' + chip.id;
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
      }
      button.append(el(doc, 'span', chip.label, 'chip-k'));
      if (chip.warn) {
        const warn = el(doc, 'span', '⚠', 'chip-warn');
        warn.title = chip.warn;
        warn.setAttribute('role', 'img');
        warn.setAttribute('aria-label', chip.warn);
        button.append(warn);
      }
      button.append(el(doc, 'span', chip.pending ? chip.pending.name + ' → after this turn' : chip.value, 'chip-v'));
      if (interactive) button.append(el(doc, 'span', '▾', 'chip-caret'));
      const action = o.busy
        ? 'Change ' + chip.label.toLowerCase() + ' (applied when this turn ends)'
        : 'Change ' + chip.label.toLowerCase();
      let base =
        chip.title || (interactive ? (o.disabled ? chip.label + ': changes between turns' : action) : chip.label);
      if (chip.pending)
        base = chip.label + ': currently ' + chip.value + '; changes to ' + chip.pending.name + ' when this turn ends.';
      button.title = base + (chip.warn ? '\n' + chip.warn : '') + (chip.hint ? '\n' + chip.hint : '');
      if (o.disabled && interactive) button.classList.add('chip-locked');
      wrap.append(button);
      if ((chip.id === 'ctx' || chip.id === 'limits') && chip.details) {
        button.tabIndex = 0;
        button.title = '';
        button.setAttribute(
          'aria-label',
          chip.id === 'ctx'
            ? 'Context ' + chip.value + '. Session details'
            : 'Usage limits ' + chip.value + '. Details',
        );
        const tip = el(doc, 'span', null, 'chip-tip');
        tip.setAttribute('role', 'tooltip');
        fillTip(doc, tip, chip.details);
        wrap.append(tip);
        /* Open the tooltip toward the side with room: from the chip's left edge when it fits, else from its right edge
           (a chip near a narrow window's right edge), else whichever side has more room. */
        const place = () => {
          const win = doc.defaultView;
          if (!win || typeof wrap.getBoundingClientRect !== 'function') return;
          const shown = tip.style.display;
          tip.style.visibility = 'hidden';
          tip.style.display = 'flex';
          const w = tip.offsetWidth || 0;
          tip.style.display = shown;
          tip.style.visibility = '';
          const r = wrap.getBoundingClientRect(),
            roomRight = win.innerWidth - r.left,
            roomLeft = r.right;
          tip.dataset.side = w <= roomRight - 8 ? 'left' : w <= roomLeft - 8 ? 'right' : roomRight >= roomLeft ? 'left' : 'right';
        };
        wrap.addEventListener('mouseenter', place);
        wrap.addEventListener('focusin', place);
      }
      if (chip.pending && o.onCancelPending) {
        const cancel = el(doc, 'button', '×', 'chip-cancel');
        cancel.type = 'button';
        cancel.title = 'Cancel the queued ' + chip.label.toLowerCase() + ' change';
        cancel.setAttribute('aria-label', cancel.title);
        cancel.addEventListener('click', () =>
          Promise.resolve()
            .then(() => o.onCancelPending(chip.pending.key))
            .then(after)
            .catch((e) => o.onError && o.onError(e)),
        );
        wrap.append(cancel);
      }
      if (interactive)
        button.addEventListener('click', () => {
          if (menu.node && menu.trigger === button) return closeMenu(true);
          const rows = menuItems(chip.subset);
          const shown = chip.pending ? chip.pending.value : rows.current;
          for (const r of rows.items) if (chip.pending && r.value === chip.pending.value) r.tag = 'after this turn';
          const notes = [];
          if (o.disabled) notes.push('Settings change between turns.');
          else if (o.busy) notes.push('The agent is working: what you pick is queued and applied when this turn ends.');
          let extra = null;
          if (chip.id === 'model' && rows.items.filter((r) => !r.disabled).length <= 1) {
            notes.push('This agent offers no other models for this conversation.');
            if (hasModelCommand && o.onInsertText) {
              extra = el(doc, 'span', null, 'config-note chip-menu-note');
              extra.append(
                'You can still ask Claude Code for another one: send ',
                el(doc, 'code', '/model opus'),
                ' (or sonnet, haiku, or a full model id). AIB then shows the model the agent reports. ',
              );
              const insert = el(doc, 'button', 'Start a /model message', 'chip-insert');
              insert.type = 'button';
              insert.addEventListener('click', () => {
                closeMenu(false);
                o.onInsertText('/model ');
              });
              extra.append(insert);
            }
          }
          openMenu(doc, button, {
            label: chip.label,
            items: rows.items,
            current: shown,
            disabled: !!o.disabled,
            notes,
            extra,
            // Exactly what the old drop-down did: nothing for the value already shown, else onMode / onConfig, then refresh.
            onPick: (value) => {
              if (value === shown) return;
              Promise.resolve()
                .then(() => (rows.kind === 'mode' ? o.onMode(value) : o.onConfig(rows.option.id, value, 'select')))
                .then(after)
                .catch((e) => o.onError && o.onError(e));
            },
          });
        });
      box.append(wrap);
    }
    if (d.hasPanel && o.settingsPanel) {
      const more = el(doc, 'button', view.panelOpen ? '⚙ Hide' : '⚙', 'chip chip-more');
      more.type = 'button';
      more.setAttribute('aria-expanded', String(view.panelOpen));
      more.title = view.panelOpen ? 'Hide the settings panel' : 'All settings: show every setting the agent advertises';
      more.setAttribute('aria-label', 'All settings');
      more.addEventListener('click', () => {
        view.panelOpen = !view.panelOpen;
        view.signature = '';
        o.settingsPanel.hidden = !view.panelOpen;
        render(box, model, opts);
      });
      box.append(more);
    }
    if (refocus && doc.getElementById) {
      const again = doc.getElementById(refocus);
      if (again && box.contains(again) && again.focus) again.focus();
    }
  }

  const api = {
    lastSegment,
    parseModel,
    friendlyModel,
    sameModel,
    describe,
    describeLimits,
    render,
    menuItems,
    place,
    openMenu,
    closeMenu,
  };
  root.AgentComposerChips = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

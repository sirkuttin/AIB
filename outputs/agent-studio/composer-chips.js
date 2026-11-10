(function (root) {
  'use strict';
  // Compact setting chips under the message box: agent (read-only), model, mode, effort, branch, context % (with the
  // session-details tooltip: context, cost, session id, notices). No Project chip, no agent switcher: a chat keeps its agent.
  // Choices come from the same advertised settings as the settings panel and are rendered by config-ui.js
  // (AgentConfigUI.render), so validation is shared. While a turn runs a pick is queued by the agent host ("pending
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
      });
    const hasPanel = !!(
      settings &&
      ((modes && Array.isArray(modes.availableModes) && modes.availableModes.length) ||
        (Array.isArray(settings.configOptions) && settings.configOptions.length))
    );
    return { chips, hasPanel };
  }

  const view = { open: null, signature: '', panelOpen: false, wired: false, seen: new Set() };

  function closePop() {
    if (view.open) {
      view.open.remove();
      view.open = null;
    }
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
    const isStatic = (c) => c.id === 'ctx' || c.id === 'branch';
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
          }
          const tip = c.details && box.querySelector && box.querySelector('.chip-ctx + .chip-tip');
          if (tip) fillTip(doc, tip, c.details);
        }
      }
      return;
    }
    view.signature = signature;
    view.staticSig = staticSig;
    closePop();
    box.replaceChildren();
    box.hidden = !d.chips.length && !d.hasPanel;
    if (!view.wired) {
      view.wired = true;
      doc.addEventListener('click', (e) => {
        if (view.open && !view.open.contains(e.target) && !(e.target.closest && e.target.closest('.chip-wrap')))
          closePop();
      });
      doc.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && view.open) closePop();
      });
    }
    const after = () => {
      view.signature = '';
      return o.afterChange && o.afterChange();
    };
    for (const chip of d.chips) {
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
          (chip.tone === 'high' ? ' chip-tone-high' : ''),
      );
      if (interactive) {
        button.type = 'button';
        button.setAttribute('aria-haspopup', 'true');
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
      if (chip.id === 'ctx' && chip.details) {
        button.tabIndex = 0;
        button.title = '';
        button.setAttribute('aria-label', 'Context ' + chip.value + '. Session details');
        const tip = el(doc, 'span', null, 'chip-tip');
        tip.setAttribute('role', 'tooltip');
        fillTip(doc, tip, chip.details);
        wrap.append(tip);
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
          const wasOpen = view.open && view.open.parentNode === wrap;
          closePop();
          if (wasOpen) return;
          const pop = el(doc, 'div', null, 'chip-pop');
          pop.setAttribute('role', 'dialog');
          pop.setAttribute('aria-label', chip.label);
          const ropts = {
            disabled: !!o.disabled,
            queueing: !!o.busy,
            onMode: o.onMode,
            onConfig: o.onConfig,
            onCancelPending: o.onCancelPending,
            onError: o.onError,
            afterChange: () => {
              closePop();
              return after();
            },
          };
          if (chip.pending) ropts.pending = { [chip.pending.key]: chip.pending.value };
          if (chip.id === 'model') {
            const option = chip.subset.configOptions[0];
            if (root.AgentConfigUI.flatChoices(option).length <= 1) {
              ropts.note = 'This agent offers no other models for this conversation.';
              if (hasModelCommand && o.onInsertText) {
                const extra = el(doc, 'span', null, 'config-note');
                extra.append(
                  'You can still ask Claude Code for another one: send ',
                  el(doc, 'code', '/model opus'),
                  ' (or sonnet, haiku, or a full model id). AIB then shows the model the agent reports. ',
                );
                const insert = el(doc, 'button', 'Start a /model message', 'chip-insert');
                insert.type = 'button';
                insert.addEventListener('click', () => {
                  closePop();
                  o.onInsertText('/model ');
                });
                extra.append(insert);
                ropts.extra = extra;
              }
            }
          }
          root.AgentConfigUI.render(pop, chip.subset, ropts);
          wrap.append(pop);
          view.open = pop;
          const select = pop.querySelector('select');
          if (select && select.focus) select.focus();
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
  }

  const api = { lastSegment, parseModel, friendlyModel, sameModel, describe, render };
  root.AgentComposerChips = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

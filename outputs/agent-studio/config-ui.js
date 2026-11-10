(function (root) {
  'use strict';
  // Settings panel controls for every ACP v1 config option type. Agent text is set with
  // textContent/value only. Unknown types are displayed read-only, never hidden.
  const el = (doc, tag, text, cls) => {
    const n = doc.createElement(tag);
    if (text != null) n.textContent = String(text);
    if (cls) n.className = cls;
    return n;
  };

  function orderOptions(options) {
    // Spec: show model_config options near the model selector; otherwise keep array order.
    const list = (Array.isArray(options) ? options : []).filter(
      (o) => o && typeof o === 'object' && typeof o.id === 'string',
    );
    const extras = list.filter((o) => o.category === 'model_config');
    if (!extras.length) return list;
    const rest = list.filter((o) => o.category !== 'model_config');
    let at = -1;
    rest.forEach((o, i) => {
      if (o.category === 'model') at = i;
    });
    if (at < 0) return list;
    rest.splice(at + 1, 0, ...extras);
    return rest;
  }

  function isGrouped(option) {
    return Array.isArray(option.options) && option.options.some((o) => o && Array.isArray(o.options));
  }

  function flatChoices(option) {
    const out = [];
    for (const item of Array.isArray(option.options) ? option.options : []) {
      if (item && Array.isArray(item.options)) {
        for (const o of item.options) if (o && typeof o.value === 'string') out.push(o);
      } else if (item && typeof item.value === 'string') out.push(item);
    }
    return out;
  }

  function choiceNode(doc, o) {
    const n = el(doc, 'option', o.name || o.value);
    n.value = o.value;
    if (o.description) n.title = String(o.description);
    return n;
  }

  // A change picked during a turn is queued by the host; show it as chosen, marked, with a way to cancel it.
  function queuedMark(doc, key, o) {
    const mark = el(doc, 'span', null, 'config-queued');
    mark.append(el(doc, 'span', 'after this turn'));
    if (o.onCancelPending) {
      const cancel = el(doc, 'button', '×', 'config-queued-cancel');
      cancel.type = 'button';
      cancel.title = 'Cancel this queued change';
      cancel.setAttribute('aria-label', 'Cancel this queued change');
      cancel.addEventListener('click', () =>
        Promise.resolve()
          .then(() => o.onCancelPending(key))
          .then(() => o.afterChange && o.afterChange())
          .catch((e) => o.onError && o.onError(e)),
      );
      mark.append(cancel);
    }
    return mark;
  }

  function selectControl(doc, option, disabled, onChange, queued) {
    const label = el(doc, 'label', option.name || option.id),
      select = doc.createElement('select');
    if (option.description) label.title = String(option.description);
    const choices = flatChoices(option);
    if (isGrouped(option)) {
      for (const item of option.options) {
        if (item && Array.isArray(item.options)) {
          const group = el(doc, 'optgroup');
          group.label = String(item.name || item.group || '');
          for (const o of item.options) if (o && typeof o.value === 'string') group.appendChild(choiceNode(doc, o));
          select.appendChild(group);
        }
      }
    } else for (const o of choices) select.appendChild(choiceNode(doc, o));
    if (!choices.some((o) => o.value === option.currentValue)) {
      const unknown = el(
        doc,
        'option',
        option.unlistedLabel ? option.unlistedLabel + ' (in use)' : String(option.currentValue),
      );
      unknown.value = String(option.currentValue);
      if (option.unlistedLabel) unknown.disabled = true;
      select.insertBefore(unknown, select.firstChild);
    }
    const shown = queued && queued.has ? queued.value : option.currentValue;
    if (queued && queued.has && !choices.some((o) => o.value === shown) && shown !== option.currentValue) {
      const extra = el(doc, 'option', String(shown));
      extra.value = String(shown);
      select.appendChild(extra);
    }
    select.value = String(shown);
    select.disabled = disabled;
    select.addEventListener('change', () => onChange(option.id, select.value, 'select'));
    label.appendChild(select);
    if (queued && queued.has) label.appendChild(queued.mark);
    return label;
  }

  function booleanControl(doc, option, disabled, onChange, queued) {
    const label = el(doc, 'label', null, 'config-toggle'),
      box = doc.createElement('input');
    box.type = 'checkbox';
    box.checked = (queued && queued.has ? queued.value : option.currentValue) === true;
    box.disabled = disabled;
    if (option.description) label.title = String(option.description);
    box.addEventListener('change', () => onChange(option.id, box.checked, 'boolean'));
    label.appendChild(box);
    label.appendChild(el(doc, 'span', option.name || option.id));
    if (queued && queued.has) label.appendChild(queued.mark);
    return label;
  }

  function readOnlyControl(doc, option) {
    let value = option.currentValue;
    value = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
    const label = el(doc, 'label', option.name || option.id, 'config-readonly');
    label.title =
      'Setting type “' + String(option.type).slice(0, 40) + '” is not supported by AIB, so it is read-only.';
    label.appendChild(el(doc, 'span', String(value).slice(0, 200) + ' (read-only)'));
    return label;
  }

  function render(box, settings, opts) {
    const doc = box.ownerDocument || root.document,
      o = opts || {};
    const changing = (id, value, type) => {
      Promise.resolve()
        .then(() => o.onConfig(id, value, type))
        .then(() => o.afterChange && o.afterChange())
        .catch((e) => o.onError && o.onError(e));
    };
    box.replaceChildren();
    const pending = o.pending && typeof o.pending === 'object' ? o.pending : {};
    const queuedFor = (key) =>
      Object.prototype.hasOwnProperty.call(pending, key)
        ? { has: true, value: pending[key], mark: queuedMark(doc, key, o) }
        : { has: false };
    const modes = settings && settings.modes;
    const hasModes = !!(modes && Array.isArray(modes.availableModes) && modes.availableModes.length);
    if (hasModes) {
      const label = el(doc, 'label', 'Mode'),
        select = doc.createElement('select');
      for (const m of modes.availableModes) {
        const n = el(doc, 'option', m.name || m.id);
        n.value = m.id;
        if (m.description) n.title = String(m.description);
        select.appendChild(n);
      }
      const queuedMode = queuedFor('mode');
      select.value = queuedMode.has ? queuedMode.value : modes.currentModeId;
      select.disabled = !!o.disabled;
      select.addEventListener('change', () => {
        Promise.resolve()
          .then(() => o.onMode(select.value))
          .then(() => o.afterChange && o.afterChange())
          .catch((e) => o.onError && o.onError(e));
      });
      label.appendChild(select);
      if (queuedMode.has) label.appendChild(queuedMode.mark);
      box.appendChild(label);
    }
    for (const option of orderOptions(settings && settings.configOptions)) {
      if (option.id === 'mode' && hasModes) continue;
      let control;
      if (option.type === 'select' || (option.type === undefined && Array.isArray(option.options))) {
        if (!flatChoices(option).length) continue;
        control = selectControl(doc, option, !!o.disabled, changing, queuedFor('config:' + option.id));
      } else if (option.type === 'boolean')
        control = booleanControl(doc, option, !!o.disabled, changing, queuedFor('config:' + option.id));
      else control = readOnlyControl(doc, option);
      box.appendChild(control);
    }
    if (o.disabled && box.children.length && !box.querySelector('.config-note'))
      box.appendChild(el(doc, 'span', 'Settings change between turns.', 'config-note'));
    else if (o.queueing && box.children.length && !box.querySelector('.config-note'))
      box.appendChild(
        el(
          doc,
          'span',
          'The agent is working: what you pick is queued and applied when this turn ends.',
          'config-note',
        ),
      );
    if (o.note && box.children.length) box.appendChild(el(doc, 'span', o.note, 'config-note'));
    if (o.extra && box.children.length) box.appendChild(o.extra);
  }

  const api = { orderOptions, isGrouped, flatChoices, render };
  root.AgentConfigUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

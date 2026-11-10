(function (root) {
  'use strict';
  const cards = new WeakMap(),
    authCards = new WeakMap();
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = String(txt);
    return n;
  };
  function optionsFor(schema) {
    if (Array.isArray(schema.oneOf))
      return schema.oneOf.map((x) => ({
        value: x && x.const,
        label: x && (x.title || String(x.const)),
        description: x && x.description,
      }));
    if (Array.isArray(schema.enum)) return schema.enum.map((x) => ({ value: x, label: String(x) }));
    return null;
  }
  function makeField(key, s, isRequired) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('Field schema is invalid.');
    const wrap = el('label', 'elicitation-field');
    const title = el('span', 'elicitation-label', (s.title || key) + (isRequired ? ' (required)' : ''));
    wrap.appendChild(title);
    if (s.description) {
      const d = el('span', 'elicitation-description', s.description);
      wrap.appendChild(d);
    }
    let input, kind;
    if (s.type === 'string' && optionsFor(s)) {
      input = el('select');
      kind = 'select';
      input.appendChild(el('option', '', 'Choose an option…'));
      input.options[0].value = '';
      const choices = optionsFor(s);
      choices.forEach((o) => {
        if (!o || o.value === undefined) throw new Error('An option is missing its value.');
        const opt = el('option', '', o.label);
        opt.value = String(o.value);
        opt.__elicitationValue = o.value;
        input.appendChild(opt);
      });
      addChoiceDescriptions(wrap, choices);
    } else if (s.type === 'array' && s.items && (Array.isArray(s.items.enum) || Array.isArray(s.items.anyOf))) {
      input = el('select');
      input.multiple = true;
      kind = 'multi';
      const choices = Array.isArray(s.items.anyOf)
        ? s.items.anyOf.map((x) => ({
            value: x && x.const,
            label: x && (x.title || String(x.const)),
            description: x && x.description,
          }))
        : s.items.enum.map((x) => ({ value: x, label: String(x) }));
      choices.forEach((o) => {
        if (!o || o.value === undefined) throw new Error('An option is missing its value.');
        const opt = el('option', '', o.label);
        opt.value = String(o.value);
        opt.__elicitationValue = o.value;
        input.appendChild(opt);
      });
      addChoiceDescriptions(wrap, choices);
    } else if (s.type === 'boolean') {
      input = el('input');
      input.type = 'checkbox';
      kind = 'boolean';
    } else if (s.type === 'string' || s.type === 'number' || s.type === 'integer') {
      input = el('input');
      input.type = s.type === 'string' ? 'text' : 'number';
      if (s.type !== 'string') {
        input.step = s.type === 'integer' ? '1' : 'any';
        if (typeof s.minimum === 'number') input.min = String(s.minimum);
        if (typeof s.maximum === 'number') input.max = String(s.maximum);
      }
      kind = s.type;
    } else throw new Error('Unsupported field type for “' + key + '”.');
    input.name = key;
    if (kind !== 'boolean') {
      if (own(s, 'default') && valid(s, s.default)) setValue(input, kind, s.default);
    } else if (typeof s.default === 'boolean') input.checked = s.default;
    if (s.type === 'string') {
      if (typeof s.minLength === 'number') input.minLength = s.minLength;
      if (typeof s.maxLength === 'number') input.maxLength = s.maxLength;
    }
    wrap.appendChild(input);
    const field = {
      key,
      schema: s,
      input,
      kind,
      wrap,
      hasDefault: kind === 'boolean' && typeof s.default === 'boolean',
      touched: false,
    };
    if (kind === 'boolean')
      input.addEventListener('change', () => {
        field.touched = true;
      });
    return field;
  }
  function addChoiceDescriptions(parent, choices) {
    const described = choices.filter((o) => typeof o.description === 'string' && o.description.length);
    if (!described.length) return;
    const list = el('div', 'elicitation-choice-descriptions');
    described.forEach((o) =>
      list.appendChild(el('p', 'elicitation-choice-description', o.label + ': ' + o.description)),
    );
    parent.appendChild(list);
  }
  function valid(s, v) {
    if (s.type === 'boolean') return typeof v === 'boolean';
    if (s.type === 'number' || s.type === 'integer')
      return (
        typeof v === 'number' &&
        Number.isFinite(v) &&
        (s.type !== 'integer' || Number.isInteger(v)) &&
        (s.minimum == null || v >= s.minimum) &&
        (s.maximum == null || v <= s.maximum)
      );
    if (s.type === 'string')
      return (
        typeof v === 'string' &&
        (!s.enum || s.enum.includes(v)) &&
        (!s.oneOf || s.oneOf.some((x) => x.const === v)) &&
        (s.minLength == null || v.length >= s.minLength) &&
        (s.maxLength == null || v.length <= s.maxLength)
      );
    if (s.type === 'array')
      return (
        Array.isArray(v) &&
        (s.minItems == null || v.length >= s.minItems) &&
        (s.maxItems == null || v.length <= s.maxItems)
      );
    return false;
  }
  function setValue(input, kind, v) {
    if (kind === 'boolean') input.checked = v;
    else if (kind === 'select') {
      Array.from(input.options).forEach((o) => {
        if (o.__elicitationValue === v) input.value = o.value;
      });
    } else if (kind === 'multi')
      Array.from(input.options).forEach((o) => {
        o.selected = Array.isArray(v) && v.some((x) => x === o.__elicitationValue);
      });
    else input.value = String(v);
  }
  function read(field, required) {
    const { input, kind, schema: s } = field;
    if (kind === 'boolean') return !required && !field.touched && !field.hasDefault ? undefined : input.checked;
    if (kind === 'multi') {
      const v = Array.from(input.options)
        .filter((x) => x.selected)
        .map((x) => x.__elicitationValue);
      return v.length ? v : undefined;
    }
    if (kind === 'select') {
      if (input.selectedIndex <= 0) return undefined;
      return input.options[input.selectedIndex].__elicitationValue;
    }
    if (input.value === '') return undefined;
    if (kind === 'number' || kind === 'integer') {
      const n = Number(input.value);
      if (!Number.isFinite(n) || (kind === 'integer' && !Number.isInteger(n)))
        throw new Error((s.title || field.key) + ' must be a valid ' + kind + '.');
      if (!valid(s, n)) throw new Error((s.title || field.key) + ' is outside the allowed range.');
      return n;
    }
    if (!valid(s, input.value)) throw new Error((s.title || field.key) + ' does not meet its allowed length or value.');
    return input.value;
  }
  // Only plain http(s) destinations without embedded credentials are ever offered as links.
  function safeUrl(raw) {
    if (typeof raw !== 'string' || !raw || raw.length > 2048 || /[\u0000-\u0020\u007f]/.test(raw)) return null;
    let u;
    try {
      u = new URL(raw);
    } catch (e) {
      return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password || !u.hostname) return null;
    return u;
  }
  // Which conversation is asking? Requests carry a sessionId; subagent sessions are named by the caller.
  function routeInfo(sessionId, route, ctx) {
    ctx = ctx || {};
    const provider = ctx.providerName || 'Agent';
    if (sessionId && ctx.mainSessionId && sessionId !== ctx.mainSessionId) {
      const named = ctx.sessionNames && ctx.sessionNames[sessionId];
      if (named || route === 'subagent')
        return { kind: 'subagent', name: named || 'Subagent ' + String(sessionId).slice(0, 8), sessionId };
      return { kind: 'unknown', name: 'Unrecognized session ' + String(sessionId).slice(0, 8), sessionId };
    }
    return { kind: sessionId ? 'main' : 'setup', name: provider, sessionId: sessionId || null };
  }
  function routeNote(info) {
    if (info.kind === 'subagent') return 'Subagent: ' + info.name;
    if (info.kind === 'unknown')
      return (
        'This request comes from a session Studio does not recognize (' + info.name + '). Answer only if you expect it.'
      );
    return '';
  }
  function urlLine(u) {
    const line = el('p', 'elicitation-url');
    line.appendChild(el('span', 'elicitation-url-scheme', u.protocol + '//'));
    line.appendChild(el('strong', 'elicitation-url-host', u.host));
    line.appendChild(el('span', 'elicitation-url-rest', u.pathname + u.search + u.hash));
    return line;
  }
  function renderAuth(container, auth, context) {
    context = context || {};
    let slot = authCards.get(container);
    if (!auth || !Array.isArray(auth.methods)) {
      if (slot) {
        slot.card.remove();
        authCards.delete(container);
      }
      return;
    }
    const sig = JSON.stringify(auth);
    if (slot && slot.signature === sig) {
      slot.context = context;
      return;
    }
    if (slot) slot.card.remove();
    const card = el('section', 'elicitation-card auth-card');
    const provider = context.providerName || 'The agent';
    card.appendChild(el('h3', 'elicitation-heading', provider + ' needs you to sign in'));
    if (auth.message) card.appendChild(el('p', 'elicitation-message', auth.message));
    if (auth.error) card.appendChild(el('p', 'elicitation-issue', auth.error));
    const err = el('p', 'elicitation-error');
    err.hidden = true;
    const buttons = [];
    slot = { card, signature: sig, context };
    const send = async (action, methodId) => {
      buttons.forEach((b) => (b.disabled = true));
      err.hidden = true;
      try {
        if (typeof slot.context.onAuth !== 'function') throw new Error('The sign-in handler is unavailable.');
        await slot.context.onAuth(action, methodId);
      } catch (e) {
        buttons.forEach((b) => (b.disabled = !!auth.working));
        err.textContent = e && e.message ? e.message : 'The sign-in step could not be sent.';
        err.hidden = false;
      }
    };
    const external = auth.methods.filter((m) => m && m.kind !== 'agent');
    if (!auth.methods.length)
      card.appendChild(
        el(
          'p',
          'elicitation-description',
          "This agent requires sign-in but did not offer a method Studio can complete. Sign in with the agent's own tool, then choose Retry.",
        ),
      );
    auth.methods.forEach((m) => {
      if (!m || typeof m.id !== 'string') return;
      const box = el('div', 'auth-method');
      box.appendChild(el('strong', 'auth-method-name', m.name || m.id));
      if (m.description) box.appendChild(el('p', 'elicitation-description', m.description));
      if (m.kind === 'agent') {
        const go = el('button', '', auth.working ? 'Signing in…' : 'Sign in with ' + (m.name || m.id));
        go.type = 'button';
        go.disabled = !!auth.working;
        go.addEventListener('click', () => send('authenticate', m.id));
        buttons.push(go);
        box.appendChild(go);
      } else
        box.appendChild(
          el('p', 'auth-instructions', m.instructions || 'Complete this sign-in outside Studio, then choose Retry.'),
        );
      card.appendChild(box);
    });
    card.appendChild(err);
    const actions = el('div', 'elicitation-actions');
    if (external.length || !auth.methods.length) {
      const retry = el('button', '', 'Retry after signing in');
      retry.type = 'button';
      retry.disabled = !!auth.working;
      retry.addEventListener('click', () => send('retry'));
      buttons.push(retry);
      actions.appendChild(retry);
    }
    const cancel = el('button', '', 'Cancel');
    cancel.type = 'button';
    cancel.disabled = !!auth.working;
    cancel.addEventListener('click', () => send('cancel'));
    buttons.push(cancel);
    actions.appendChild(cancel);
    card.appendChild(actions);
    container.appendChild(card);
    authCards.set(container, slot);
  }
  function render(container, requests, context) {
    if (!container || (!container.ownerDocument && !container.appendChild))
      throw new Error('A DOM container is required.');
    context = context || {};
    requests = Array.isArray(requests) ? requests : [];
    let existing = cards.get(container);
    if (!existing) {
      existing = new Map();
      cards.set(container, existing);
    }
    const live = new Set();
    requests.forEach((req) => {
      if (!req || req.key == null) return;
      const key = String(req.key),
        p = req.params || {},
        sig = JSON.stringify(p);
      live.add(key);
      let state = existing.get(key);
      if (state && state.signature === sig) {
        state.onRespond = context.onRespond;
        return;
      }
      if (state) {
        state.card.remove();
        existing.delete(key);
      }
      const card = el('section', 'elicitation-card');
      card.dataset.elicitationKey = key;
      const sid = p.sessionId,
        info = routeInfo(sid, req.route, context),
        isUrl = p.mode === 'url';
      card.dataset.route = info.kind;
      card.appendChild(el('h3', 'elicitation-heading', info.name + ' asks'));
      const note = routeNote(info);
      if (note) card.appendChild(el('p', 'elicitation-subagent', note));
      if (info.kind === 'subagent' && typeof context.onShowAgent === 'function') {
        const show = el('button', 'elicitation-show', 'Show this subagent');
        show.type = 'button';
        show.addEventListener('click', () => context.onShowAgent(sid));
        card.appendChild(show);
      }
      if (p.mode !== 'form' && !isUrl) {
        card.appendChild(el('p', 'elicitation-issue', 'This request uses an unsupported elicitation mode.'));
      }
      if (p.message) card.appendChild(el('p', 'elicitation-message', p.message));
      const fieldsBox = el('div', 'elicitation-fields'),
        fields = [],
        required = new Set();
      let issue = p.mode !== 'form' && !isUrl ? 'Only form and link requests are supported.' : '';
      const schema = p.requestedSchema,
        target = isUrl ? safeUrl(p.url) : null;
      let openLink = null;
      if (isUrl) {
        if (!target) issue = "This request's link is not a plain http(s) address, so Studio will not open it.";
        else {
          card.appendChild(
            el(
              'p',
              'elicitation-description',
              'The agent wants you to visit this address. Studio does not open it automatically.',
            ),
          );
          card.appendChild(urlLine(target));
          openLink = el('a', 'elicitation-open', 'Open this link in a new tab');
          openLink.href = target.href;
          openLink.target = '_blank';
          openLink.rel = 'noopener noreferrer';
          card.appendChild(openLink);
          card.appendChild(
            el(
              'p',
              'elicitation-description',
              'Only continue if you trust the site shown above. When you have finished there, confirm below.',
            ),
          );
        }
      }
      if (!issue && !isUrl) {
        if (
          !schema ||
          schema.type !== 'object' ||
          !schema.properties ||
          typeof schema.properties !== 'object' ||
          Array.isArray(schema.properties)
        )
          issue = 'This request has an invalid form schema.';
        else {
          try {
            if (schema.required != null && !Array.isArray(schema.required))
              throw new Error('The required field list is invalid.');
            (schema.required || []).forEach((k) => required.add(k));
            Object.keys(schema.properties).forEach((k) => {
              const f = makeField(k, schema.properties[k], required.has(k));
              fields.push(f);
              fieldsBox.appendChild(f.wrap);
            });
            required.forEach((k) => {
              if (!own(schema.properties, k)) throw new Error('A required field is missing from the schema.');
            });
          } catch (e) {
            issue = e.message;
          }
        }
      }
      card.appendChild(fieldsBox);
      const error = el('p', 'elicitation-error');
      error.hidden = true;
      card.appendChild(error);
      if (issue) card.appendChild(el('p', 'elicitation-issue', issue));
      const actions = el('div', 'elicitation-actions');
      const submit = el('button', '', isUrl ? "I've completed this" : 'Submit');
      submit.type = 'button';
      submit.disabled = !!issue || isUrl;
      const decline = el('button', '', 'Decline'),
        cancel = el('button', '', 'Cancel');
      decline.type = cancel.type = 'button';
      actions.append(submit, decline, cancel);
      card.appendChild(actions);
      container.appendChild(card);
      state = {
        card,
        signature: sig,
        fields,
        required,
        error,
        buttons: [submit, decline, cancel],
        issue,
        isUrl,
        opened: false,
        onRespond: context.onRespond,
      };
      if (openLink)
        openLink.addEventListener('click', () => {
          state.opened = true;
          if (!state.busy && !state.issue) submit.disabled = false;
        });
      existing.set(key, state);
      const act = async (action) => {
        if (state.busy) return;
        let content = {};
        try {
          if (action === 'accept') {
            for (const f of fields) {
              const v = read(f, required.has(f.key));
              if (required.has(f.key) && v === undefined) throw new Error((f.schema.title || f.key) + ' is required.');
              if (v !== undefined) content[f.key] = v;
            }
          }
          state.busy = true;
          state.buttons.forEach((b) => (b.disabled = true));
          error.hidden = true;
          if (typeof state.onRespond !== 'function')
            throw new Error('The response handler is unavailable. Please try again.');
          await state.onRespond(key, action, content);
          card.remove();
          existing.delete(key);
        } catch (e) {
          state.busy = false;
          state.buttons.forEach((b, i) => (b.disabled = i === 0 && (!!state.issue || (state.isUrl && !state.opened))));
          error.textContent = e && e.message ? e.message : 'The response could not be sent. Please try again.';
          error.hidden = false;
        }
      };
      submit.addEventListener('click', () => act('accept'));
      decline.addEventListener('click', () => act('decline'));
      cancel.addEventListener('click', () => act('cancel'));
    });
    for (const [key, state] of existing)
      if (!live.has(key)) {
        state.card.remove();
        existing.delete(key);
      }
  }
  root.AgentElicitationUI = { render, renderAuth, routeInfo, routeNote, safeUrl };
})(window);

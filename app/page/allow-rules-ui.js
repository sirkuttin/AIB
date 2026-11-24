/* Allow rules on the page (server/allow): the "Always allow" choice on every approval card, the "Rule added · Undo" note, and
   Settings > Allow rules. The rule itself is always drafted by the server from the waiting request (snapshot permissions[].allow);
   the page only picks the scope. */
(function (root) {
  'use strict';
  const doc = () => root.document || globalThis.document;
  const el = (tag, content, cls) => {
    const n = doc().createElement(tag);
    if (content != null && content !== '') n.textContent = String(content);
    if (cls) n.className = cls;
    return n;
  };
  const KIND_WORDS = { command: 'commands like this', edit: 'edits like this', mcp: 'this tool', fetch: 'fetches from this site' };

  /* The choice for one card, or null (plan, question and Skill cards keep the agent's own options and get none). */
  function choice(allow) {
    if (!allow || !allow.project || allow.project.offer === false) return null;
    const box = el('div', null, 'allow-always');
    const label = el('label', null, 'allow-always-label');
    const tick = el('input');
    tick.type = 'checkbox';
    const kind = (allow.project.rules && allow.project.rules[0] && allow.project.rules[0].kind) || 'command';
    const words = el('span', 'Always allow ' + (KIND_WORDS[kind] || 'requests like this'));
    label.append(tick, words);
    const scope = el('select', null, 'allow-scope');
    scope.setAttribute('aria-label', 'Where the rule applies');
    for (const [value, text] of [
      ['project', 'in this project'],
      ['global', 'everywhere'],
    ]) {
      const o = el('option', text);
      o.value = value;
      scope.append(o);
    }
    scope.value = 'project';
    const preview = el('p', '', 'allow-preview');
    const draw = () => {
      const d = allow[scope.value] || allow.project;
      const off = allow.off || '';
      const ok = !off && d.available;
      tick.disabled = !ok;
      if (!ok) tick.checked = false;
      box.classList.toggle('unavailable', !ok);
      preview.textContent = off || (d.available ? d.preview : d.reason);
    };
    scope.onchange = draw;
    box.append(label, scope, preview);
    draw();
    return { element: box, ticked: () => tick.checked && !tick.disabled, scope: () => (scope.value === 'global' ? 'global' : 'project') };
  }

  /* Answer + save in one call. Returns what the note shows: {rules, alsoAllowed} or {elsewhere, save()}. */
  async function answer(post, scope) {
    try {
      return await post({ scope });
    } catch (error) {
      if (error && error.code === 'answered_elsewhere') return { elsewhere: true, save: () => post({ scope, saveOnly: true }) };
      throw error;
    }
  }

  /* "Rule added: npm test in shop-web. Also allowed 2 waiting requests. Undo" (or "answered elsewhere: Save the rule anyway?"). */
  function toast(saved, remove) {
    const box = el('div', null, 'allow-toast');
    box.setAttribute('role', 'status');
    if (saved.elsewhere) {
      box.append(el('span', 'This request was already answered elsewhere. Save the rule anyway? '));
      const save = el('button', 'Save rule');
      save.type = 'button';
      save.onclick = async () => {
        save.disabled = true;
        try {
          const done = await saved.save();
          box.replaceWith(toast(done, remove));
        } catch (error) {
          box.textContent = 'The rule was not saved: ' + (error && error.message ? error.message : error);
        }
      };
      box.append(save);
      return box;
    }
    const rules = saved.rules || [];
    let text = 'Rule added: ' + rules.map((r) => r.label).join(', ') + (rules[0] && rules[0].scope === 'global' ? ' (everywhere).' : '.');
    if (saved.alsoAllowed) text += ' Also allowed ' + saved.alsoAllowed + ' waiting request' + (saved.alsoAllowed === 1 ? '' : 's') + '.';
    box.append(el('span', text + ' '));
    const undo = el('button', 'Undo');
    undo.type = 'button';
    undo.onclick = async () => {
      undo.disabled = true;
      try {
        for (const r of rules) await remove(r.id);
        box.textContent = 'Rule removed. Requests like this ask again.';
      } catch (error) {
        undo.disabled = false;
        box.append(el('span', ' Could not undo: ' + (error && error.message ? error.message : error)));
      }
    };
    box.append(undo);
    return box;
  }

  const BUILTIN_TEXT = [
    ['safeReads', 'Safe reads', 'Read-only commands with known-safe flags (ls, cat, grep, rg, git status/diff/log, Get-ChildItem…), on files inside the chat folder.'],
    ['syntax', 'Syntax checks', 'node --check <file>, tsc --noEmit (installed outside the project), python -I -m py_compile <file>.'],
    ['scratch', 'Scratch folder', "Git Bash rm, mkdir and touch on the chat's own scratch folder (outside the project), by its full path."],
  ];

  /* Settings > Allow rules: the switch, the tamper banner, built-in rules and the owner's rules with Delete (and Undo). */
  function renderSettings(box, host) {
    const slot = el('div', null, 'allow-settings');
    box.append(slot);
    const draw = (data, message) => {
      slot.replaceChildren();
      if (message) slot.append(el('p', message, 'st-note'));
      if (data.tampered) {
        const banner = el('div', null, 'allow-banner');
        banner.setAttribute('role', 'alert');
        banner.append(el('span', 'Allow rules are off. The rules file was changed outside AIB. Review the rules below, then switch them back on. '));
        const review = el('button', 'Rules reviewed: switch on');
        review.type = 'button';
        review.onclick = () => call('allow/review', {});
        banner.append(review);
        slot.append(banner);
      }
      const master = el('label', null, 'allow-master');
      const on = el('input');
      on.type = 'checkbox';
      on.checked = !!data.enabled && !data.tampered;
      on.disabled = !!data.tampered;
      on.onchange = () => call('allow/enable', { on: on.checked });
      master.append(on, el('span', ' Allow rules on · switch off and every request asks again. Your rules are kept.'));
      slot.append(master);
      slot.append(el('h4', 'Built in (all projects)', 'st-group'));
      for (const [name, title, text] of BUILTIN_TEXT) {
        const row = el('label', null, 'allow-rule builtin');
        const t = el('input');
        t.type = 'checkbox';
        t.checked = data.builtins ? data.builtins[name] !== false : true;
        t.onchange = () => call('allow/builtin', { name, on: t.checked });
        row.append(t, el('b', ' ' + title + ' '), el('span', text));
        slot.append(row);
      }
      slot.append(el('h4', 'Your rules', 'st-group'));
      const rules = data.rules || [];
      if (!rules.length) slot.append(el('p', 'None yet. Tick "Always allow" on an approval card to add one.', 'st-note'));
      for (const r of rules) {
        const row = el('div', null, 'allow-rule');
        row.dataset.rule = r.id;
        const where = r.scope === 'global' ? 'everywhere' : 'in ' + String(r.project || '').split(/[\\/]/).filter(Boolean).pop();
        row.append(el('b', r.label), el('span', ' · ' + where + (r.pins ? ' · runs project code (pinned)' : '') + ' '));
        const del = el('button', 'Delete');
        del.type = 'button';
        del.onclick = () =>
          call('allow/remove', { ruleId: r.id }, 'Rule deleted.', () => {
            const undo = el('button', 'Undo');
            undo.type = 'button';
            undo.onclick = () => call('allow/restore', { ruleId: r.id });
            return undo;
          });
        row.append(del);
        slot.append(row);
      }
      slot.append(
        el(
          'p',
          "Your rules never cover deletes outside the scratch folder, installs, git push, killing processes, inline code, network, or anything outside the project. An agent's own mode may still run things without asking (Claude in bypass mode, Codex in auto mode inside its folder): AIB can only answer what reaches it.",
          'st-note',
        ),
      );
    };
    const call = (path, body, message, extra) =>
      host
        .post(path, body)
        .then((data) => {
          draw(data, message);
          if (extra) slot.firstChild && slot.firstChild.append && slot.firstChild.append(' ', extra());
        })
        .catch((error) => draw({ rules: [] }, 'Allow rules could not be changed: ' + (error && error.message ? error.message : error)));
    host
      .post('allow/rules', {})
      .then((data) => draw(data))
      .catch((error) => slot.append(el('p', 'Allow rules could not be loaded: ' + (error && error.message ? error.message : error), 'st-note bad')));
  }

  /* The desktop banner while the rules file was changed outside AIB (every rule is off until the owner reviews them). */
  let bannerEl = null;
  function banner(tampered) {
    const d = doc();
    if (!d) return;
    let bar = bannerEl;
    if (!tampered) {
      if (bar) bar.hidden = true;
      return;
    }
    if (!bar) {
      const main = d.querySelector ? d.querySelector('main') : null;
      if (!main || !main.prepend) return;
      bar = el('div', null, 'allow-banner');
      bar.id = 'allowRulesBanner';
      bar.setAttribute('role', 'alert');
      bar.append(el('span', 'Allow rules are off. The rules file was changed outside AIB. Review the rules, then switch them back on. '));
      const review = el('button', 'Review');
      review.type = 'button';
      review.onclick = () => root.AgentSettingsUI && root.AgentSettingsUI.open && root.AgentSettingsUI.open('allow');
      bar.append(review);
      main.prepend(bar);
      bannerEl = bar;
    }
    bar.hidden = false;
  }

  root.AllowRulesUI = { choice, answer, toast, renderSettings, banner };
  if (typeof module === 'object' && module.exports) module.exports = root.AllowRulesUI;
})(typeof window !== 'undefined' ? window : globalThis);

(function (root) {
  'use strict';
  // Slash-command completion for the composer. Command data comes from the agent and is
  // untrusted: it is only ever written with textContent / value, never as HTML.
  const MAX_ITEMS = 12;

  function slashToken(value) {
    // Completion applies only while the whole message is a single "/word" with no whitespace yet.
    const m = /^\/(\S*)$/.exec(String(value));
    return m ? m[1] : null;
  }

  function match(commands, value) {
    const token = slashToken(value);
    if (token === null || !Array.isArray(commands)) return [];
    const needle = token.toLowerCase();
    const prefix = [],
      inner = [];
    for (const c of commands) {
      if (!c || typeof c.name !== 'string') continue;
      const name = c.name.toLowerCase();
      if (name.startsWith(needle)) prefix.push(c);
      else if (needle && name.includes(needle)) inner.push(c);
    }
    return prefix.concat(inner).slice(0, MAX_ITEMS);
  }

  function hintFor(commands, value) {
    // "/plan " with nothing after it: show the command's input hint.
    const m = /^\/(\S+)\s+$/.exec(String(value));
    if (!m || !Array.isArray(commands)) return '';
    const c = commands.find((x) => x && x.name === m[1]);
    return c && typeof c.hint === 'string' ? c.hint : '';
  }

  function plainKey(e) {
    return !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !e.isComposing;
  }

  function createController(opts) {
    const textarea = opts.textarea,
      popup = opts.popup,
      hintBox = opts.hintBox || null,
      doc = opts.document || root.document;
    let commands = [],
      items = [],
      index = 0,
      dismissed = null,
      signature = '';
    const isOpen = () => items.length > 0;

    function render() {
      const sig = JSON.stringify([items.map((i) => i.name), index]);
      if (sig === signature) return;
      signature = sig;
      popup.replaceChildren();
      popup.hidden = !items.length;
      if (textarea.setAttribute) {
        textarea.setAttribute('aria-expanded', String(isOpen()));
        if (isOpen()) textarea.setAttribute('aria-activedescendant', 'slash-option-' + index);
        else if (textarea.removeAttribute) textarea.removeAttribute('aria-activedescendant');
      }
      items.forEach((c, i) => {
        const row = doc.createElement('div');
        row.id = 'slash-option-' + i;
        row.className = 'slash-option' + (i === index ? ' selected' : '');
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(i === index));
        const name = doc.createElement('strong');
        name.textContent = '/' + c.name;
        row.appendChild(name);
        if (c.hint) {
          const h = doc.createElement('em');
          h.textContent = ' ' + c.hint;
          row.appendChild(h);
        }
        if (c.description) {
          const d = doc.createElement('span');
          d.textContent = c.description;
          row.appendChild(d);
        }
        row.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          accept(i);
        });
        popup.appendChild(row);
      });
    }

    function refresh() {
      const value = textarea.value;
      items = dismissed === value ? [] : match(commands, value);
      if (index >= items.length) index = 0;
      render();
      if (hintBox) {
        const hint = hintFor(commands, value);
        hintBox.textContent = hint;
        hintBox.hidden = !hint;
      }
    }

    function accept(i) {
      const c = items[i === undefined ? index : i];
      if (!c) return false;
      textarea.value = '/' + c.name + ' ';
      dismissed = null;
      items = [];
      index = 0;
      signature = '';
      render();
      if (hintBox) {
        hintBox.textContent = c.hint || '';
        hintBox.hidden = !c.hint;
      }
      if (typeof textarea.focus === 'function') textarea.focus();
      if (opts.onChange) opts.onChange();
      return true;
    }

    function handleKey(e) {
      if (!isOpen() || e.isComposing) return false;
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && plainKey(e)) {
        e.preventDefault();
        index = (index + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        render();
        return true;
      }
      if (e.key === 'Tab' && plainKey(e)) {
        e.preventDefault();
        return accept();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        dismissed = textarea.value;
        refresh();
        return true;
      }
      if (e.key === 'Enter' && plainKey(e)) {
        // A fully typed command name sends as usual; otherwise Enter picks the highlighted command.
        if ('/' + items[index].name === textarea.value) return false;
        e.preventDefault();
        return accept();
      }
      return false;
    }

    return {
      setCommands(list) {
        commands = Array.isArray(list) ? list : [];
        refresh();
      },
      refresh,
      handleKey,
      accept,
      isOpen,
      state: () => ({ items: items.map((i) => i.name), index, open: isOpen() }),
    };
  }

  const api = { slashToken, match, hintFor, createController };
  root.AgentSlashCommands = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

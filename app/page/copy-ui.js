/* Copy support: per-message and per-code-block copy buttons with three formats
   (Markdown source, rich HTML for Teams/Outlook, plain text) and selection-friendly click guards.
   The rich HTML is generated from the DOM that markdown.js built itself (textContent only), through a
   whitelist serializer that escapes every text and attribute, so agent-supplied HTML never reaches the clipboard. */
(function (root) {
  'use strict';
  const FORMATS = [
    ['markdown', 'Copy as Markdown'],
    ['teams', 'Copy for Teams / Outlook'],
    ['plain', 'Copy as plain text'],
  ];
  const STORE_KEY = 'agentStudio.copyFormat';
  /* Code blocks remember their own format, plain code by default (no ``` fences): pasting code into a terminal or editor
     is the common case. The whole-message format above is a separate setting. */
  const CODE_KEY = 'agentStudio.copyFormat.code';
  const keyOf = (scope) => (scope === 'code' ? CODE_KEY : STORE_KEY);
  const defaultOf = (scope) => (scope === 'code' ? 'plain' : 'markdown');
  const doc = () => root.document || globalThis.document;
  const esc = (value) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const safeHref = (value) => {
    try {
      const url = new URL(String(value));
      return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  };
  function lastFormat(scope) {
    try {
      const v = root.localStorage.getItem(keyOf(scope));
      if (FORMATS.some((f) => f[0] === v)) return v;
    } catch {}
    return defaultOf(scope);
  }
  function rememberFormat(format, scope) {
    try {
      root.localStorage.setItem(keyOf(scope), format);
    } catch {}
  }
  const label = (format) => (FORMATS.find((f) => f[0] === format) || FORMATS[0])[1];

  /* ---- Markdown helpers ---- */
  function fence(text, lang) {
    const runs = String(text).match(/`+/g) || [],
      n = Math.max(3, ...runs.map((r) => r.length + 1)),
      f = '`'.repeat(n);
    return f + (lang || '') + '\n' + String(text).replace(/\n$/, '') + '\n' + f;
  }

  /* ---- Whitelist DOM -> inline-styled HTML (Teams/Outlook) ---- */
  const FONT = "font-family:Consolas,'Courier New',monospace;font-size:90%;";
  const STYLE = {
    code: FONT + 'background:#f3f4f6;padding:1px 4px;border-radius:3px;',
    pre:
      FONT +
      'background:#f3f4f6;border:1px solid #d9dce1;border-radius:4px;padding:8px 10px;margin:6px 0;white-space:pre-wrap;',
    p: 'margin:0 0 8px 0;',
    h: 'margin:12px 0 6px 0;font-weight:600;',
    list: 'margin:4px 0 8px 0;padding-left:24px;',
    blockquote: 'margin:6px 0;padding-left:10px;border-left:3px solid #c5c9d0;color:#555555;',
    table: 'border-collapse:collapse;margin:6px 0;',
    th: 'border:1px solid #c5c9d0;padding:4px 8px;background:#f3f4f6;text-align:left;',
    td: 'border:1px solid #c5c9d0;padding:4px 8px;',
    hr: 'border:0;border-top:1px solid #c5c9d0;margin:10px 0;',
  };
  const kids = (node) => node.childNodes || node.children || [];
  const tagOf = (node) => String(node.tagName || '').toLowerCase();
  const hasClass = (node, name) => (' ' + (node.className || '') + ' ').includes(' ' + name + ' ');
  const isText = (node) => node.nodeType === 3;
  function textOf(node) {
    return node.textContent == null ? '' : String(node.textContent);
  }
  function toHtml(node, ctx) {
    ctx = ctx || {};
    if (isText(node)) return esc(node.data ?? textOf(node));
    if (hasClass(node, 'copy-ctl') || hasClass(node, 'code-lang') || tagOf(node) === 'small') return '';
    const tag = tagOf(node),
      list = kids(node);
    const inner = () =>
      list.length
        ? Array.from(list)
            .map((k) => toHtml(k, ctx))
            .join('')
        : esc(textOf(node));
    switch (tag) {
      case 'pre':
        return '<pre style="' + STYLE.pre + '"><code style="' + FONT + '">' + esc(textOf(node)) + '</code></pre>';
      case 'code':
        return '<code style="' + STYLE.code + '">' + esc(textOf(node)) + '</code>';
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return '<' + tag + ' style="' + STYLE.h + '">' + inner() + '</' + tag + '>';
      case 'p':
        return '<p style="' + STYLE.p + '">' + inner() + '</p>';
      case 'strong':
      case 'b':
        return '<strong>' + inner() + '</strong>';
      case 'em':
      case 'i':
        return '<em>' + inner() + '</em>';
      case 'br':
        return '<br>';
      case 'hr':
        return '<hr style="' + STYLE.hr + '">';
      case 'a': {
        const href = safeHref(node.href || (node.getAttribute && node.getAttribute('href')));
        return href ? '<a href="' + esc(href) + '">' + inner() + '</a>' : inner();
      }
      case 'ul':
        return '<ul style="' + STYLE.list + '">' + inner() + '</ul>';
      case 'ol': {
        const start = Number.isInteger(node.start) && node.start !== 1 ? ' start="' + node.start + '"' : '';
        return '<ol' + start + ' style="' + STYLE.list + '">' + inner() + '</ol>';
      }
      case 'li':
        return '<li>' + inner() + '</li>';
      case 'blockquote':
        return '<blockquote style="' + STYLE.blockquote + '">' + inner() + '</blockquote>';
      case 'table':
        return '<table style="' + STYLE.table + '">' + inner() + '</table>';
      case 'thead':
      case 'tbody':
      case 'tr':
        return '<' + tag + '>' + inner() + '</' + tag + '>';
      case 'th':
        return '<th style="' + STYLE.th + '">' + inner() + '</th>';
      case 'td':
        return '<td style="' + STYLE.td + '">' + inner() + '</td>';
      default:
        return inner();
    }
  }

  /* ---- DOM -> readable plain text ---- */
  function toPlain(node) {
    const out = plainBlock(node)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n');
    return out.replace(/^\n+|\s+$/g, '');
  }
  function plainBlock(node) {
    if (isText(node)) return node.data ?? textOf(node);
    if (hasClass(node, 'copy-ctl') || hasClass(node, 'code-lang') || tagOf(node) === 'small') return '';
    const tag = tagOf(node),
      list = Array.from(kids(node));
    const inner = () => (list.length ? list.map(plainBlock).join('') : textOf(node));
    switch (tag) {
      case 'pre':
        return textOf(node).replace(/\n$/, '') + '\n\n';
      case 'br':
        return '\n';
      case 'hr':
        return '---\n\n';
      case 'p':
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return inner() + '\n\n';
      case 'a': {
        const text = inner(),
          href = safeHref(node.href || (node.getAttribute && node.getAttribute('href')));
        return href &&
          href !== text &&
          href.replace(/\/$/, '') !== text.replace(/\/$/, '') &&
          !href.startsWith('mailto:')
          ? text + ' (' + href + ')'
          : text;
      }
      case 'ul':
      case 'ol': {
        const ordered = tag === 'ol',
          start = Number.isInteger(node.start) ? node.start : 1;
        return (
          list
            .filter((k) => tagOf(k) === 'li')
            .map((li, i) => {
              const lines = plainBlock(li)
                  .replace(/\n{2,}/g, '\n')
                  .replace(/\s+$/, '')
                  .split('\n'),
                mark = ordered ? start + i + '. ' : '- ';
              return (
                mark +
                lines[0] +
                lines
                  .slice(1)
                  .map((l) => '\n' + ' '.repeat(mark.length) + l)
                  .join('')
              );
            })
            .join('\n') + '\n\n'
        );
      }
      case 'li': {
        let out = '';
        for (const k of list) {
          const block = ['ul', 'ol', 'p', 'pre', 'blockquote', 'table', 'div'].includes(tagOf(k)),
            piece = plainBlock(k);
          out += (block && out && !out.endsWith('\n') ? '\n' : '') + piece;
        }
        return list.length ? out : textOf(node);
      }
      case 'blockquote':
        return (
          plainBlock2(inner())
            .split('\n')
            .map((l) => '> ' + l)
            .join('\n') + '\n\n'
        );
      case 'table': {
        const rows = [];
        const walk = (n) => {
          for (const k of kids(n)) {
            if (tagOf(k) === 'tr') rows.push(Array.from(kids(k)).map((c) => plainBlock(c).replace(/\s+/g, ' ').trim()));
            else walk(k);
          }
        };
        walk(node);
        return rows.map((r) => r.join(' | ')).join('\n') + '\n\n';
      }
      case 'div':
        return list.length ? list.map(plainBlock).join('') : textOf(node);
      default:
        return inner();
    }
  }
  const plainBlock2 = (text) =>
    String(text)
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s+$/, '');

  /* ---- Payloads: three lazy formats for one piece of content ---- */
  function fromMarkdown(source) {
    source = String(source ?? '');
    let dom = null;
    const render = () => {
      if (!dom) {
        dom = doc().createElement('div');
        if (root.AgentMarkdown) root.AgentMarkdown.render(dom, source);
        else dom.textContent = source;
      }
      return dom;
    };
    return {
      markdown: () => source,
      html: () => toHtml(render()),
      plain: () => (root.AgentMarkdown ? toPlain(render()) : source),
    };
  }
  function fromPlain(text) {
    text = String(text ?? '');
    return {
      markdown: () => text,
      plain: () => text,
      html: () => '<p style="' + STYLE.p + '">' + esc(text).replace(/\r?\n/g, '<br>') + '</p>',
    };
  }
  function fromCode(code, lang) {
    code = String(code ?? '');
    return {
      markdown: () => fence(code, lang),
      plain: () => code,
      html: () => '<pre style="' + STYLE.pre + '"><code style="' + FONT + '">' + esc(code) + '</code></pre>',
    };
  }
  /* A message that is only links or files (resource rows): their names and addresses, one per line. */
  function attachmentText(row) {
    return (row.attachments || [])
      .map((a) => {
        if (!a || typeof a !== 'object') return '';
        const res = a.resource && typeof a.resource === 'object' ? a.resource : {},
          name = a.title || a.name || '',
          where = a.uri || res.uri || '';
        return [name, where].filter(Boolean).join(' ');
      })
      .filter(Boolean)
      .join('\n');
  }
  function fromRow(row) {
    if (!row) return null;
    const TV = root.ToolViews;
    if (row.role === 'tool') {
      if (row.raw && TV) return fromMarkdown(TV.rawMarkdown(row.raw));
      if (row.call && TV) return fromMarkdown(TV.callMarkdown(row.call));
      return row.value ? fromMarkdown(fence(row.value, 'json')) : null;
    }
    if (!row.value) {
      const links = attachmentText(row);
      return links ? fromPlain(links) : null;
    }
    if (row.role === 'assistant' && root.AgentMarkdown) return fromMarkdown(row.value);
    return fromPlain(row.value);
  }

  /* ---- Clipboard ---- */
  function textFor(format, payload) {
    return format === 'markdown' ? payload.markdown() : payload.plain();
  }
  /* Resolves to 'ok' or throws. Teams writes text/html + text/plain through ClipboardItem. */
  async function write(format, payload) {
    const nav = root.navigator || globalThis.navigator,
      text = textFor(format === 'teams' ? 'plain' : format, payload);
    if (format === 'teams' && root.ClipboardItem && nav && nav.clipboard && nav.clipboard.write) {
      const BlobCtor = root.Blob || Blob;
      await nav.clipboard.write([
        new root.ClipboardItem({
          'text/html': new BlobCtor([payload.html()], { type: 'text/html' }),
          'text/plain': new BlobCtor([text], { type: 'text/plain' }),
        }),
      ]);
      return 'ok';
    }
    if (nav && nav.clipboard && nav.clipboard.writeText) {
      await nav.clipboard.writeText(text);
      return 'ok';
    }
    throw new Error('Clipboard unavailable');
  }

  /* ---- UI ---- */
  const el = (tag, cls, text) => {
    const n = doc().createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  let openMenu = null,
    openManual = null;
  function closeMenu() {
    if (openMenu) {
      openMenu.node.remove();
      openMenu.arrow.setAttribute('aria-expanded', 'false');
      openMenu = null;
    }
  }
  function closeManual() {
    if (openManual) {
      openManual.remove();
      openManual = null;
    }
  }
  function flash(button, message) {
    if (button.copyTimer) clearTimeout(button.copyTimer);
    if (button.copyOriginal === undefined) button.copyOriginal = button.textContent;
    button.textContent = message;
    button.classList.add('copied');
    button.copyTimer = setTimeout(() => {
      button.textContent = button.copyOriginal;
      button.copyOriginal = undefined;
      button.classList.remove('copied');
    }, 1500);
  }
  /* Last resort: put the text in a selected box so Ctrl+C works. */
  function manualCopy(anchor, text) {
    closeManual();
    const box = el('div', 'copy-manual'),
      area = el('textarea', 'copy-manual-text'),
      note = el('div', 'copy-manual-note', 'Clipboard blocked. Press Ctrl+C to copy.');
    area.value = text;
    area.readOnly = true;
    area.rows = 6;
    box.append(note, area);
    const rect = anchor.getBoundingClientRect();
    box.style.position = 'fixed';
    box.style.top = Math.min(rect.bottom + 4, root.innerHeight - 170) + 'px';
    box.style.left = Math.max(8, Math.min(rect.left, root.innerWidth - 330)) + 'px';
    doc().body.append(box);
    openManual = box;
    area.focus();
    area.select();
    area.addEventListener('copy', () => setTimeout(closeManual, 50));
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeManual();
    });
  }
  async function perform(format, payload, anchor, status) {
    try {
      await write(format, payload);
      flash(status, 'Copied');
    } catch (error) {
      try {
        const area = el('textarea');
        area.value = textFor(format === 'teams' ? 'plain' : format, payload);
        area.style.position = 'fixed';
        area.style.opacity = '0';
        doc().body.append(area);
        area.select();
        const ok = doc().execCommand && doc().execCommand('copy');
        area.remove();
        if (ok) {
          flash(status, 'Copied');
          return;
        }
      } catch {}
      manualCopy(anchor, textFor(format === 'teams' ? 'plain' : format, payload));
    }
  }
  function showMenu(arrow, anchor, getPayload, status, scope) {
    if (openMenu && openMenu.arrow === arrow) {
      closeMenu();
      return;
    }
    closeMenu();
    const menu = el('div', 'copy-menu');
    menu.setAttribute('role', 'menu');
    const current = lastFormat(scope);
    for (const [format, text] of FORMATS) {
      const item = el('button', 'copy-menu-item', (format === current ? '✓ ' : '    ') + text);
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        rememberFormat(format, scope);
        closeMenu();
        syncTitles();
        perform(format, getPayload(), anchor, status);
      });
      menu.append(item);
    }
    const rect = arrow.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = rect.bottom + 4 + 'px';
    menu.style.right = Math.max(8, root.innerWidth - rect.right) + 'px';
    doc().body.append(menu);
    arrow.setAttribute('aria-expanded', 'true');
    openMenu = { node: menu, arrow };
    const first = menu.querySelector('button');
    if (first) first.focus();
    menu.addEventListener('keydown', (event) => {
      const items = [...menu.querySelectorAll('button')],
        i = items.indexOf(doc().activeElement);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        items[(i + 1) % items.length].focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        items[(i + items.length - 1) % items.length].focus();
      } else if (event.key === 'Escape') {
        closeMenu();
        arrow.focus();
      }
    });
  }
  /* The buttons are found in the page when the format changes: a list of them kept here held every chat row ever drawn (the
     rows are rebuilt on each update), with all their nodes and listeners, until the next format change. */
  function syncTitles() {
    for (const main of doc().querySelectorAll('button.copy-main')) main.title = label(lastFormat(main.copyScope));
  }
  /* Builds a split button. getPayload is called lazily at click time. */
  function makeControl(getPayload, extraClass) {
    const wrap = el('span', 'copy-ctl' + (extraClass ? ' ' + extraClass : '')),
      main = el('button', 'copy-main', 'Copy'),
      arrow = el('button', 'copy-more', '▾'),
      scope = extraClass === 'copy-code' ? 'code' : 'message';
    main.copyScope = scope;
    main.type = 'button';
    arrow.type = 'button';
    arrow.setAttribute('aria-haspopup', 'menu');
    arrow.setAttribute('aria-expanded', 'false');
    arrow.title = 'Choose copy format';
    arrow.setAttribute('aria-label', 'Choose copy format');
    main.title = label(lastFormat(scope));
    main.addEventListener('click', (event) => {
      event.stopPropagation();
      event.preventDefault();
      closeMenu();
      perform(lastFormat(scope), getPayload(), wrap, main);
    });
    arrow.addEventListener('click', (event) => {
      event.stopPropagation();
      event.preventDefault();
      showMenu(arrow, wrap, getPayload, main, scope);
    });
    wrap.append(main, arrow);
    return wrap;
  }
  function decorateCode(scope) {
    for (const pre of scope.querySelectorAll('pre')) {
      if (pre.copyDone) continue;
      pre.copyDone = true;
      const parent = pre.parentElement;
      if (!parent || hasClass(parent, 'bubble') || parent.closest('.copy-ctl') || hasClass(parent, 'copy-manual'))
        continue;
      let host = parent;
      if (!(hasClass(parent, 'markdown-code') || hasClass(parent, 'code-block'))) {
        host = el('div', 'code-wrap');
        parent.insertBefore(host, pre);
        host.append(pre);
      }
      const small = host.querySelector('small'),
        lang = host.copyLang !== undefined ? host.copyLang : small ? small.textContent : '';
      host.classList.add('has-copy');
      const ctl = makeControl(() => fromCode(pre.textContent, lang), 'copy-code');
      host.append(ctl);
      if (root.RunInTerminalUI) root.RunInTerminalUI.decorate(host, pre, lang, ctl);
    }
    for (const diff of scope.querySelectorAll('.tool-diff')) {
      if (diff.copyDone || typeof diff.copyCode !== 'string' || !diff.copyCode) continue;
      diff.copyDone = true;
      diff.classList.add('has-copy');
      diff.append(makeControl(() => fromCode(diff.copyCode, diff.copyLang), 'copy-code'));
    }
  }
  /* Called from chat.js bubble(): message-level button in the header, plus code-block buttons. */
  function decorate(article, row) {
    if (!article || article.copyDecorated) return article;
    article.copyDecorated = true;
    const head = article.querySelector('.bubble-head');
    if (head && row && fromRowCheck(row)) {
      const ctl = makeControl(() => fromRow(row), 'copy-message');
      head.append(ctl);
    }
    decorateCode(article);
    return article;
  }
  const fromRowCheck = (row) =>
    row.role === 'tool' ? Boolean(row.raw || row.call || row.value) : Boolean(row.value || attachmentText(row));

  /* Keeps a drag-selection from also toggling <summary> or opening the picture viewer. */
  let pointerDown = null;
  function installGuards() {
    const d = doc();
    if (!d || !d.addEventListener) return;
    d.addEventListener(
      'mousedown',
      (event) => {
        pointerDown = { x: event.clientX, y: event.clientY };
        if (openMenu && !event.target.closest('.copy-menu, .copy-ctl')) closeMenu();
        if (openManual && !event.target.closest('.copy-manual')) closeManual();
      },
      true,
    );
    d.addEventListener(
      'click',
      (event) => {
        if (!pointerDown) return;
        const moved = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 4,
          selection = root.getSelection && root.getSelection();
        if (!moved || !selection || selection.isCollapsed || !String(selection).length) return;
        const target = event.target;
        if (target.closest && target.closest('summary, img, .message-image') && !target.closest('.copy-ctl')) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      true,
    );
    d.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeMenu();
        closeManual();
      }
    });
    root.addEventListener('resize', closeMenu);
  }
  /* True while re-rendering a message list would destroy what the user is doing (open menu or a selection inside it). */
  function holdRender(box) {
    if (openMenu || openManual) return true;
    const selection = root.getSelection && root.getSelection();
    if (!selection || selection.isCollapsed || !selection.anchorNode || !box) return false;
    return box.contains(selection.anchorNode) && String(selection).length > 0;
  }
  if (root.document && root.document.addEventListener) installGuards();
  root.CopyUI = {
    decorate,
    decorateCode,
    makeControl,
    holdRender,
    toHtml,
    toPlain,
    fromMarkdown,
    fromPlain,
    fromCode,
    fromRow,
    write,
    perform,
    fence,
    esc,
    lastFormat,
    rememberFormat,
    FORMATS,
  };
})(typeof window !== 'undefined' ? window : globalThis);

'use strict';
/* The doc page's editing chrome (doc.html, on top of doc-ui.js): the fixed toolbar (style, B I S code link, colour ▾, highlight ▾,
   align ▾, lists, tasks, + Insert ▾, and the "Claude Code is writing <section>" chips), the selection toolbar with its colour
   popover, the "/" menu, the + and ⋮⋮ handles left of each block and the block menu. Highlights leave out teal and blue. Everything is built with DOM calls and placed through the CSSOM: the page's CSP allows no inline style. */
(function () {
  const D = window.AIBDoc;
  const { el, btn, icon, $ } = D;
  const TEXT_COLORS = ['grey', 'red', 'orange', 'green', 'blue', 'purple'];
  const HIGHLIGHTS = ['yellow', 'green', 'pink', 'purple', 'grey'];
  const COLOR_NAME = {
    grey: 'Grey',
    red: 'Red',
    orange: 'Orange',
    green: 'Green',
    blue: 'Blue',
    purple: 'Purple',
    yellow: 'Yellow',
    pink: 'Pink',
  };
  const ed = () => (D.editor && !D.editor.destroyed ? D.editor : null);
  const tt = () => (ed() ? ed().editor : null);
  let lastColor = 'red',
    lastHighlight = 'yellow';

  // ---------------------------------------------------------------------------------------------------------------------------
  // Blocks: one list for "/", the + handle and Insert ▾

  const newId = () => 'c' + Math.random().toString(36).slice(2, 10);
  const para = (text) => (text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' });
  const cell = (type, text) => ({ type, content: [para(text)] });
  const row = (type, cells) => ({
    type: 'tableRow',
    content: cells.map((t, i) => cell(i === 0 && type === 'tableCell' ? 'tableCell' : type, t)),
  });
  function chartJSON() {
    return {
      type: 'chart',
      attrs: { chart: newId(), chartType: 'bar', title: 'Chart', caption: '' },
      content: [
        {
          type: 'table',
          content: [
            row('tableHeader', ['Label', 'Series 1', 'Series 2']),
            row('tableCell', ['A', '3', '4']),
            row('tableCell', ['B', '5', '3']),
            row('tableCell', ['C', '4', '6']),
          ],
        },
      ],
    };
  }
  const column = () => ({ type: 'column', content: [para()] });
  const BLOCKS = [
    { group: 'Text', id: 'text', label: 'Text', icon: 'T', keys: 'text paragraph', set: (c) => c.setParagraph() },
    {
      group: 'Text',
      id: 'h1',
      label: 'Heading 1',
      icon: 'H1',
      hint: '#',
      keys: 'heading h1 title',
      set: (c) => c.setHeading({ level: 1 }),
    },
    {
      group: 'Text',
      id: 'h2',
      label: 'Heading 2',
      icon: 'H2',
      hint: '##',
      keys: 'heading h2',
      set: (c) => c.setHeading({ level: 2 }),
    },
    {
      group: 'Text',
      id: 'h3',
      label: 'Heading 3',
      icon: 'H3',
      hint: '###',
      keys: 'heading h3',
      set: (c) => c.setHeading({ level: 3 }),
    },
    {
      group: 'Text',
      id: 'ul',
      label: 'Bulleted list',
      icon: 'ul',
      hint: '-',
      keys: 'bullet list ul',
      set: (c) => c.setParagraph().toggleBulletList(),
    },
    {
      group: 'Text',
      id: 'ol',
      label: 'Numbered list',
      icon: 'ol',
      hint: '1.',
      keys: 'numbered ordered list ol',
      set: (c) => c.setParagraph().toggleOrderedList(),
    },
    {
      group: 'Text',
      id: 'task',
      label: 'Task list',
      icon: 'task',
      hint: '[ ]',
      keys: 'task todo check list',
      set: (c) => c.setParagraph().toggleTaskList(),
    },
    {
      group: 'Layout',
      id: 'callout',
      label: 'Callout',
      small: 'Info, warning or success box with an icon',
      icon: 'callout',
      iconCls: 'info',
      keys: 'callout info note box',
      json: () => ({ type: 'callout', attrs: { variant: 'info' }, content: [para()] }),
    },
    {
      group: 'Layout',
      id: 'warning',
      label: 'Warning callout',
      icon: 'warning',
      iconCls: 'warn',
      keys: 'callout warning',
      json: () => ({ type: 'callout', attrs: { variant: 'warning' }, content: [para()] }),
    },
    {
      group: 'Layout',
      id: 'success',
      label: 'Success callout',
      icon: 'success',
      iconCls: 'ok',
      keys: 'callout success done',
      json: () => ({ type: 'callout', attrs: { variant: 'success' }, content: [para()] }),
    },
    {
      group: 'Layout',
      id: 'columns',
      label: 'Columns',
      small: '2 side by side',
      icon: 'columns',
      keys: 'columns two layout',
      top: true,
      json: () => ({ type: 'columns', content: [column(), column()] }),
    },
    {
      group: 'Layout',
      id: 'columns3',
      label: '3 columns',
      icon: 'columns3',
      keys: 'columns three layout',
      top: true,
      json: () => ({ type: 'columns', content: [column(), column(), column()] }),
    },
    {
      group: 'Layout',
      id: 'toggle',
      label: 'Toggle',
      small: 'A heading that opens and closes',
      icon: 'toggle',
      keys: 'toggle collapse details',
      json: () => ({ type: 'toggle', content: [para('Toggle'), para()] }),
      open: true,
    },
    {
      group: 'Layout',
      id: 'quote',
      label: 'Quote',
      icon: 'quote',
      keys: 'quote blockquote',
      set: (c) => c.setParagraph().toggleBlockquote(),
    },
    {
      group: 'Layout',
      id: 'divider',
      label: 'Divider',
      icon: 'divider',
      hint: '---',
      keys: 'divider rule hr line',
      json: () => ({ type: 'horizontalRule' }),
    },
    {
      group: 'Data and media',
      id: 'table',
      label: 'Table',
      icon: 'table',
      keys: 'table grid',
      json: () => ({
        type: 'table',
        content: [row('tableHeader', ['', '', '']), row('tableCell', ['', '', '']), row('tableCell', ['', '', ''])],
      }),
    },
    {
      group: 'Data and media',
      id: 'chart',
      label: 'Chart',
      small: 'Bar or line, from a small table',
      icon: 'chart',
      keys: 'chart graph bar line',
      json: chartJSON,
    },
    {
      group: 'Data and media',
      id: 'code',
      label: 'Code',
      icon: 'codeblock',
      hint: '```',
      keys: 'code block',
      set: (c) => c.setParagraph().setCodeBlock(),
    },
  ];

  function blockItems(filterText, target) {
    const q = String(filterText || '')
      .trim()
      .toLowerCase();
    const hits = BLOCKS.filter((b) => !q || b.label.toLowerCase().includes(q) || b.keys.includes(q));
    const out = [];
    let group = '';
    for (const b of hits) {
      if (b.group !== group) {
        group = b.group;
        out.push({ head: group });
      }
      out.push({
        label: b.label,
        small: b.small,
        icon: b.icon,
        iconCls: b.iconCls,
        hint: b.hint,
        kbd: true,
        data: { block: b.id },
        run: () => insertBlock(b, target),
      });
    }
    return out;
  }
  D.blockItems = blockItems;

  /**
   * Put block `b` at `target`: {replace: pos} turns the empty paragraph at pos into it, {after: pos} adds it after the top-level
   * block at pos, {slash: {from, to}} removes the typed "/query" first.
   */
  function insertBlock(b, target) {
    const e = tt(),
      p = ed();
    if (!e || !p) return;
    const view = e.view;
    let t = target || { here: true };
    if (t.slash) {
      view.dispatch(view.state.tr.delete(t.slash.from, t.slash.to));
      t = { here: true };
    }
    const sel = view.state.selection;
    if (t.here) {
      const $f = sel.$from;
      const emptyPara = $f.parent.type.name === 'paragraph' && $f.parent.content.size === 0;
      if (emptyPara) t = { replace: $f.before() };
      else t = { after: p.topBlockAt(sel.from).pos };
    }
    if (b.set && t.replace !== undefined) {
      const chain = e
        .chain()
        .focus()
        .setTextSelection(t.replace + 1);
      b.set(chain).run();
      return;
    }
    if (b.set) {
      // a text block after the block: an empty paragraph there, then turn it
      const top = p.topBlockAt(t.after);
      const at = top.pos + top.node.nodeSize;
      e.chain().insertContentAt(at, para()).run();
      const c = e
        .chain()
        .focus()
        .setTextSelection(at + 1);
      b.set(c).run();
      return;
    }
    const json = b.json();
    let from, to;
    if (t.replace !== undefined) {
      const node = view.state.doc.nodeAt(t.replace);
      from = t.replace;
      to = t.replace + node.nodeSize;
      // columns sit only at the top of a page; elsewhere they go after the top-level block
      if (b.top && view.state.doc.resolve(from).depth > 0) {
        const top = p.topBlockAt(from);
        from = to = top.pos + top.node.nodeSize;
      }
    } else {
      const top = p.topBlockAt(t.after);
      from = to = top.pos + top.node.nodeSize;
    }
    e.chain().insertContentAt({ from, to }, json, { updateSelection: false }).run();
    const S = window.AIBDocEditor.selections;
    const state = view.state;
    const sel2 = S.TextSelection.near(state.doc.resolve(Math.min(from + 1, state.doc.content.size)));
    view.dispatch(state.tr.setSelection(sel2).scrollIntoView());
    view.focus();
    if (b.open) {
      const id = p.blockIdAt(from);
      if (id) D.setToggle(id, true);
      // repaint the new toggle open
      requestAnimationFrame(() => {
        const dom = view.nodeDOM(from);
        if (dom && dom.classList) {
          dom.classList.add('open');
          const car = dom.querySelector('.tg-car');
          if (car) car.setAttribute('aria-expanded', 'true');
        }
      });
    }
    D.pin();
  }
  D.insertBlock = insertBlock;

  // ---------------------------------------------------------------------------------------------------------------------------
  // The fixed toolbar

  const bar = $('toolbar');
  const tools = {};
  function tool(name, content, title, run, cls) {
    const b = btn('tb' + (cls ? ' ' + cls : ''), null, null, title);
    if (typeof content === 'string') b.textContent = content;
    else b.append(content);
    b.dataset.tool = name;
    b.setAttribute('aria-label', title);
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => run(b, e));
    tools[name] = b;
    return b;
  }
  const strong = (tag, text) => el(tag, '', text);
  const sep = (cls) => el('span', 'tsep' + (cls ? ' ' + cls : ''));
  const caret = () => el('span', 'caret-s', '▾');
  function build() {
    const style = tool('style', '', 'Text style', (b) => styleMenu(b), 'sel');
    style.append(el('span', 'style-name', 'Paragraph'), el('span', 'caret-s', '▾'));
    bar.append(style, sep());
    bar.append(
      tool('bold', strong('b', 'B'), 'Bold (Ctrl+B)', () => run((c) => c.toggleBold())),
      tool('italic', strong('i', 'I'), 'Italic (Ctrl+I)', () => run((c) => c.toggleItalic())),
      tool('underline', strong('u', 'U'), 'Underline (Ctrl+U)', () => run((c) => c.toggleUnderline()), 'tb-fold'),
      tool('strike', strong('s', 'S'), 'Strikethrough (Ctrl+Shift+S)', () => run((c) => c.toggleStrike()), 'tb-fold'),
      tool('code', icon('code'), 'Code (Ctrl+E)', () => run((c) => c.toggleCode()), 'tb-fold'),
      tool('link', icon('link'), 'Link (Ctrl+K)', (b) => linkForm(b)),
      sep('tb-fold'),
    );
    const a = el('span', 'aglyph', 'A');
    a.append(el('i', 'tc-swatch'));
    const color = tool('color', a, 'Text colour', (b) => colorPop(b, 'color'), 'tb-wide tb-fold');
    color.append(caret());
    const h = el('span', 'hglyph', 'H');
    const hl = tool('highlight', h, 'Highlight', (b) => colorPop(b, 'highlight'), 'tb-wide tb-fold');
    hl.append(caret());
    const al = tool('align', icon('align-left'), 'Align', (b) => alignMenu(b), 'tb-wide tb-fold');
    al.append(caret());
    bar.append(color, hl, al, sep('tb-wide tb-fold'));
    bar.append(
      tool('ul', icon('ul'), 'Bulleted list', () => run((c) => c.toggleBulletList()), 'tb-fold'),
      tool('ol', icon('ol'), 'Numbered list', () => run((c) => c.toggleOrderedList()), 'tb-fold'),
      tool('task', icon('task'), 'Task list', () => run((c) => c.toggleTaskList()), 'tb-fold'),
      sep('tb-fold'),
    );
    const ins = tool('insert', '+ Insert', 'Insert a block', (b) =>
      D.menu(b, [], { items: (q) => blockItems(q, { here: true }), filter: 'Filter blocks…' }),
    );
    ins.append(caret());
    // Beside the chat the bar has no room for everything: the tools marked tb-fold hide and "⋯" lists them (docs.css .narrow)
    const more = tool('more', '⋯', 'More formatting', (b) => moreMenu(b), 'tb-more');
    bar.append(ins, more, el('span', 'sp'));
    const chips = el('span', 'chips');
    chips.id = 'writingChips';
    bar.append(chips);
  }
  /** The folded tools as one menu: the ones that act at once run; colour, highlight and align open their own menu here. */
  function moreMenu(anchor) {
    const e = tt();
    const act = (label, icn, on, fn) => ({ label, icon: icn, on, run: () => run(fn) });
    D.menu(anchor, [
      act('Underline', 'U', e && e.isActive('underline'), (c) => c.toggleUnderline()),
      act('Strikethrough', 'S', e && e.isActive('strike'), (c) => c.toggleStrike()),
      act('Code', 'code', e && e.isActive('code'), (c) => c.toggleCode()),
      { sep: true },
      { label: 'Text colour', icon: 'A', run: () => colorPop(anchor, 'color') },
      { label: 'Highlight', icon: 'H', run: () => colorPop(anchor, 'highlight') },
      { label: 'Align', icon: 'align-left', run: () => alignMenu(anchor) },
      { sep: true },
      act('Bulleted list', 'ul', e && e.isActive('bulletList'), (c) => c.toggleBulletList()),
      act('Numbered list', 'ol', e && e.isActive('orderedList'), (c) => c.toggleOrderedList()),
      act('Task list', 'task', e && e.isActive('taskList'), (c) => c.toggleTaskList()),
    ]);
  }
  function run(fn) {
    const e = tt();
    if (!e) return;
    fn(e.chain().focus()).run();
    D.pin();
  }

  const STYLES = [
    { label: 'Paragraph', test: (e) => e.isActive('paragraph'), run: (c) => c.setParagraph() },
    {
      label: 'Heading 1',
      test: (e) => e.isActive('heading', { level: 1 }),
      run: (c) => c.setHeading({ level: 1 }),
      hint: 'Ctrl+Shift+1',
    },
    {
      label: 'Heading 2',
      test: (e) => e.isActive('heading', { level: 2 }),
      run: (c) => c.setHeading({ level: 2 }),
      hint: 'Ctrl+Shift+2',
    },
    {
      label: 'Heading 3',
      test: (e) => e.isActive('heading', { level: 3 }),
      run: (c) => c.setHeading({ level: 3 }),
      hint: 'Ctrl+Shift+3',
    },
    { label: 'Quote', test: (e) => e.isActive('blockquote'), run: (c) => c.toggleBlockquote() },
    { label: 'Code block', test: (e) => e.isActive('codeBlock'), run: (c) => c.toggleCodeBlock() },
  ];
  function styleMenu(anchor) {
    const e = tt();
    D.menu(
      anchor,
      STYLES.map((s) => ({ label: s.label, hint: s.hint, on: e && s.test(e), run: () => run(s.run) })),
    );
  }
  function alignMenu(anchor) {
    D.menu(anchor, [
      { label: 'Left', icon: 'align-left', hint: 'Ctrl+Shift+L', run: () => setAlign(null) },
      { label: 'Centre', icon: 'align-center', hint: 'Ctrl+Shift+E', run: () => setAlign('center') },
      { label: 'Right', icon: 'align-right', hint: 'Ctrl+Shift+R', run: () => setAlign('right') },
    ]);
  }
  function setAlign(a) {
    run((c) =>
      c
        .updateAttributes('paragraph', { align: a })
        .updateAttributes('heading', { align: a })
        .updateAttributes('tableCell', { align: a })
        .updateAttributes('tableHeader', { align: a }),
    );
  }
  D.setAlign = setAlign;

  function setColor(kind, value) {
    if (kind === 'color') {
      if (value) lastColor = value;
      run((c) => (value ? c.setMark('textColor', { color: value }) : c.unsetMark('textColor')));
    } else {
      if (value) lastHighlight = value;
      run((c) => (value ? c.setMark('highlight', { color: value }) : c.unsetMark('highlight')));
    }
    paintTools();
  }
  D.setColor = setColor;

  /** The colour popover: text colour and highlight swatches (no teal or blue highlight). */
  function colorPop(anchor, focusKind) {
    D.closeMenu();
    const e = tt();
    const pop = el('div', 'cpop menu');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Colour');
    const cur = e ? e.getAttributes('textColor').color : null;
    const curH = e ? e.getAttributes('highlight').color : null;
    pop.append(el('div', 'lab', 'Text colour'));
    const sws = el('div', 'sws');
    const none = btn('sw2', 'A', () => (D.closeMenu(), setColor('color', null)), 'Default colour');
    none.setAttribute('aria-pressed', String(!cur));
    sws.append(none);
    for (const c of TEXT_COLORS) {
      const b = btn('sw2 tc-' + c, 'A', () => (D.closeMenu(), setColor('color', c)), COLOR_NAME[c]);
      b.dataset.color = c;
      b.setAttribute('aria-pressed', String(cur === c));
      sws.append(b);
    }
    pop.append(sws, el('div', 'lab', 'Highlight'));
    const hs = el('div', 'sws');
    const off = btn('sw2', '⊘', () => (D.closeMenu(), setColor('highlight', null)), 'No highlight');
    off.setAttribute('aria-pressed', String(!curH));
    hs.append(off);
    for (const c of HIGHLIGHTS) {
      const b = btn('sw2 hl-' + c, '', () => (D.closeMenu(), setColor('highlight', c)), COLOR_NAME[c] + ' highlight');
      b.dataset.highlight = c;
      b.setAttribute('aria-pressed', String(curH === c));
      hs.append(b);
    }
    pop.append(hs);
    for (const b of pop.querySelectorAll('button')) b.addEventListener('mousedown', (ev) => ev.preventDefault());
    D.menu(anchor, [], { cls: 'cpop-host', focus: false });
    const open = D.menuOpen();
    open.node.replaceWith(pop);
    open.node = pop;
    D.place(pop, anchor.getBoundingClientRect(), 'below');
    const first = pop.querySelector(focusKind === 'highlight' ? '[data-highlight]' : '[data-color]');
    if (first) first.focus();
  }
  D.colorPop = colorPop;

  function linkForm(anchor) {
    const e = tt();
    if (!e) return;
    D.closeMenu();
    const box = el('form', 'linkform menu');
    const input = el('input');
    input.type = 'url';
    input.placeholder = 'Paste a link';
    input.value = e.getAttributes('link').href || '';
    const ok = btn('btn sm pri', 'Link');
    ok.type = 'submit';
    const rm = btn('btn sm', 'Remove', () => (D.closeMenu(), run((c) => c.extendMarkRange('link').unsetLink())));
    box.append(input, ok, rm);
    box.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const href = input.value.trim();
      D.closeMenu();
      if (!href) return run((c) => c.extendMarkRange('link').unsetLink());
      run((c) => c.extendMarkRange('link').setLink({ href }));
    });
    D.menu(anchor, [], { focus: false });
    const open = D.menuOpen();
    open.node.replaceWith(box);
    open.node = box;
    D.place(box, anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor, 'below');
    input.focus();
  }

  function paintTools() {
    const e = tt();
    if (!e) return;
    const on = (name, active) => tools[name] && tools[name].setAttribute('aria-pressed', String(!!active));
    on('bold', e.isActive('bold'));
    on('italic', e.isActive('italic'));
    on('underline', e.isActive('underline'));
    on('strike', e.isActive('strike'));
    on('code', e.isActive('code'));
    on('link', e.isActive('link'));
    on('ul', e.isActive('bulletList'));
    on('ol', e.isActive('orderedList'));
    on('task', e.isActive('taskList'));
    const s = STYLES.find((x) => x.test(e));
    const name = tools.style.querySelector('.style-name');
    if (name) name.textContent = s ? s.label : 'Paragraph';
    const sw = tools.color.querySelector('.tc-swatch');
    if (sw) sw.className = 'tc-swatch swatch-' + (e.getAttributes('textColor').color || lastColor);
    const hg = tools.highlight.querySelector('.hglyph');
    if (hg) hg.className = 'hglyph hl-' + (e.getAttributes('highlight').color || lastHighlight);
    const a = e.getAttributes('paragraph').align || e.getAttributes('heading').align || null;
    const ai = tools.align.querySelector('.aib-ico');
    if (ai) ai.replaceWith(icon(a === 'center' ? 'align-center' : a === 'right' ? 'align-right' : 'align-left'));
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // "Claude Code is writing <section>" / "... is writing on Risks · Go there"

  /** The section an agent is in: the heading before its block on this page, else its intent, else the block's words. */
  function sectionOf(a) {
    const p = ed();
    if (!p || !a.block) return a.intent || '';
    const at = p.findBlock(a.block);
    if (!at) return a.intent || '';
    const doc = p.view.state.doc;
    let heading = '';
    doc.forEach((node, pos) => {
      if (pos <= at.pos && node.type.name === 'heading') heading = node.textContent;
    });
    if (at.node.type.name === 'heading') heading = at.node.textContent;
    const words = heading || a.intent || at.node.textContent;
    return words.length > 48 ? words.slice(0, 47) + '…' : words;
  }
  function renderChips() {
    const host = $('writingChips');
    if (!host) return;
    host.replaceChildren();
    for (const a of D.agents || []) {
      const chip = el('span', `writing agent-${a.slot}`);
      chip.dataset.agent = a.chat;
      chip.append(el('span', 'spin'));
      if (a.page === D.page) {
        const section = sectionOf(a);
        chip.append(document.createTextNode(`${a.name} is writing${section ? ' ' : ''}`));
        if (section) chip.append(el('b', '', section));
      } else {
        const page = D.pages.find((p) => p.id === a.page);
        chip.append(
          document.createTextNode(`${a.name} is writing on `),
          el('b', '', page ? page.title : 'another page'),
          document.createTextNode(' · '),
        );
        chip.append(btn('linkish go-there', 'Go there', () => D.showPage(a.page, { block: a.block })));
      }
      host.append(chip);
    }
  }
  D.on('state', renderChips);
  D.on('page', renderChips);

  // ---------------------------------------------------------------------------------------------------------------------------
  // The selection toolbar

  let bubble = null;
  function hideBubble() {
    if (bubble) bubble.remove();
    bubble = null;
  }
  function showBubble() {
    const p = ed(),
      e = tt();
    if (!p || !e || !e.isEditable) return hideBubble();
    const { from, to, empty } = e.state.selection;
    const isText = e.state.selection instanceof window.AIBDocEditor.selections.TextSelection;
    if (empty || !isText || !e.view.hasFocus() || D.menuOpen()) return hideBubble();
    if (!bubble) {
      bubble = el('div', 'bubtb');
      bubble.setAttribute('role', 'toolbar');
      bubble.setAttribute('aria-label', 'Selection');
      const mk = (name, content, title, fn) => {
        const b = btn('tb', null, null, title);
        b.dataset.tool = name;
        b.setAttribute('aria-label', title);
        if (typeof content === 'string') b.textContent = content;
        else b.append(content);
        b.addEventListener('mousedown', (ev) => ev.preventDefault());
        b.addEventListener('click', () => fn(b));
        return b;
      };
      const a = el('span', 'aglyph', 'A');
      a.append(el('i', 'tc-swatch swatch-' + lastColor));
      bubble.append(
        mk('bold', strong('b', 'B'), 'Bold', () => run((c) => c.toggleBold())),
        mk('italic', strong('i', 'I'), 'Italic', () => run((c) => c.toggleItalic())),
        mk('underline', strong('u', 'U'), 'Underline', () => run((c) => c.toggleUnderline())),
        mk('strike', strong('s', 'S'), 'Strikethrough', () => run((c) => c.toggleStrike())),
        mk('code', icon('code'), 'Code', () => run((c) => c.toggleCode())),
        mk('link', icon('link'), 'Link', (b) => linkForm(b)),
        sep(),
        mk('color', a, 'Colour', (b) => colorPop(b, 'color')),
        mk('align', icon('align-left'), 'Align', (b) => alignMenu(b)),
        sep(),
        mk('comment', icon('comment'), 'Comment (Ctrl+Alt+M)', () => D.emit('comment-key')),
      );
      $('docLayer').append(bubble);
    }
    const a = e.view.coordsAtPos(from),
      b = e.view.coordsAtPos(to);
    const rect = {
      left: Math.min(a.left, b.left),
      right: Math.max(a.right, b.right),
      top: Math.min(a.top, b.top),
      bottom: Math.max(a.bottom, b.bottom),
    };
    D.place(bubble, rect, 'above');
  }
  D.on('selection', () => requestAnimationFrame(showBubble));
  D.on('blur', () =>
    setTimeout(() => {
      const e = tt();
      if (!e || !e.view.hasFocus()) hideBubble();
    }, 120),
  );
  D.on('page', hideBubble);
  $('pageCol').addEventListener('scroll', () => bubble && showBubble());

  // ---------------------------------------------------------------------------------------------------------------------------
  // The "/" menu: "/" then letters at the start of an empty line filter the block list; Enter inserts

  let slash = null;
  function checkSlash() {
    const e = tt();
    if (!e) return;
    const { $from, empty } = e.state.selection;
    const text = $from.parent.isTextblock ? $from.parent.textBetween(0, $from.parentOffset, '\n', '￼') : '';
    const whole = $from.parent.textContent;
    const m = empty && $from.parent.type.name === 'paragraph' && /^\/([\w ]{0,24})$/.exec(text);
    if (m && whole === text) {
      const range = { from: $from.start(), to: $from.start() + $from.parentOffset };
      const coords = e.view.coordsAtPos($from.pos);
      if (!slash || !D.menuOpen()) {
        slash = { range };
        D.menu({ left: coords.left, right: coords.right, top: coords.top, bottom: coords.bottom }, [], {
          items: (q) => blockItems(q, { slash: slash ? slash.range : range }),
          text: m[1],
          focus: false,
          cls: 'slash-menu',
          empty: 'No block matches',
          onClose: () => (slash = null),
        });
        const open = D.menuOpen();
        const first = open && open.list.querySelector('.mi');
        if (first) first.classList.add('on');
      } else {
        slash.range = range;
        D.menuOpen().fill(m[1]);
        const first = D.menuOpen().list.querySelector('.mi');
        if (first) first.classList.add('on');
      }
    } else if (slash) {
      D.closeMenu();
      slash = null;
    }
  }
  D.on('tx', (tr) => {
    if (tr.docChanged || tr.selectionSet)
      requestAnimationFrame(() => {
        checkSlash();
        paintTools();
      });
  });
  D.on('selection', paintTools);
  // the slash menu's keys, before the editor sees them
  document.addEventListener(
    'keydown',
    (e) => {
      if (!slash || !D.menuOpen()) return;
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'].includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        D.menuKey(e.key === 'Tab' ? 'Enter' : e.key);
        if (e.key === 'Escape') slash = null;
      }
    },
    true,
  );

  // ---------------------------------------------------------------------------------------------------------------------------
  // + and ⋮⋮ handles left of the block under the pointer, and the block menu

  const handles = $('blockHandles');
  let handleAt = null;
  function topBlockFromPoint(x, y) {
    const p = ed();
    if (!p) return null;
    const view = p.view;
    const box = view.dom.getBoundingClientRect();
    const hit = view.posAtCoords({ left: Math.max(box.left + 4, Math.min(x, box.right - 4)), top: y });
    if (!hit) return null;
    const top = p.topBlockAt(hit.inside >= 0 ? hit.inside : hit.pos);
    const dom = view.nodeDOM(top.pos);
    return dom && dom.getBoundingClientRect ? { ...top, dom } : null;
  }
  function showHandles(at) {
    const col = $('pageCol');
    handleAt = at;
    if (!at) return void (handles.hidden = true);
    const r = at.dom.getBoundingClientRect(),
      c = col.getBoundingClientRect();
    handles.hidden = false;
    handles.style.top = Math.round(r.top - c.top + col.scrollTop + 2) + 'px';
    handles.style.left = Math.round(r.left - c.left - 52) + 'px';
  }
  D.blockAt = (x, y) => topBlockFromPoint(x, y);
  D.showHandles = showHandles;
  $('pageCol').addEventListener('mousemove', (e) => {
    if (handles.contains(e.target) || !ed() || !tt().isEditable) return;
    const at = topBlockFromPoint(e.clientX, e.clientY);
    if (!at) return;
    if (!handleAt || at.pos !== handleAt.pos) showHandles(at);
  });
  $('pageCol').addEventListener('mouseleave', () => {
    if (!D.menuOpen()) handles.hidden = true;
  });
  handles.querySelector('.bh-plus').addEventListener('click', (e) => {
    if (!handleAt) return;
    const node = handleAt.node;
    const target =
      node.type.name === 'paragraph' && node.content.size === 0 ? { replace: handleAt.pos } : { after: handleAt.pos };
    D.menu(e.currentTarget, [], { items: (q) => blockItems(q, target), filter: 'Filter blocks…', side: 'right' });
  });
  handles.querySelector('.bh-drag').addEventListener('click', (e) => {
    if (handleAt) blockMenu(e.currentTarget, handleAt.pos);
  });
  // drag ⋮⋮ to move the block (ProseMirror's own drop moves it: one transaction, the user's)
  handles.querySelector('.bh-drag').addEventListener('dragstart', (e) => {
    const p = ed();
    if (!p || !handleAt) return;
    const view = p.view;
    const S = window.AIBDocEditor.selections;
    const sel = S.NodeSelection.create(view.state.doc, handleAt.pos);
    view.dispatch(view.state.tr.setSelection(sel));
    const slice = sel.content();
    view.dragging = { slice, move: true, node: sel };
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.clearData();
    e.dataTransfer.setData('text/plain', slice.content.textBetween(0, slice.content.size, '\n\n'));
    if (handleAt.dom instanceof Element) e.dataTransfer.setDragImage(handleAt.dom, 0, 0);
  });

  function blockMenu(anchor, pos) {
    const p = ed(),
      e = tt();
    if (!p || !e) return;
    const view = e.view;
    const node = view.state.doc.nodeAt(pos);
    if (!node) return;
    const type = node.type.name;
    const textual = node.isTextblock;
    const items = [];
    const selectInside = () => {
      const S = window.AIBDocEditor.selections;
      if (node.isTextblock)
        view.dispatch(
          view.state.tr.setSelection(S.TextSelection.create(view.state.doc, pos + 1, pos + node.nodeSize - 1)),
        );
      else view.dispatch(view.state.tr.setSelection(S.TextSelection.near(view.state.doc.resolve(pos + 1))));
    };
    items.push({ label: 'Turn into', hint: '▸', keep: true, run: (b) => turnMenu(b, pos) });
    if (type === 'callout') {
      items.push({ head: 'Callout type' });
      for (const [v, label, ic, cls] of [
        ['info', 'Info', 'info', 'info'],
        ['warning', 'Warning', 'warning', 'warn'],
        ['success', 'Success', 'success', 'ok'],
      ]) {
        items.push({
          label,
          icon: ic,
          iconCls: cls,
          on: node.attrs.variant === v,
          run: () => view.dispatch(view.state.tr.setNodeMarkup(pos, null, { ...node.attrs, variant: v })),
        });
      }
      items.push({ sep: true });
    }
    if (textual || type === 'callout' || type === 'blockquote' || /List$/.test(type)) {
      items.push({
        label: 'Colour',
        hint: '▸',
        keep: true,
        run: (b) => {
          selectInside();
          D.closeMenu();
          colorPop(b, 'color');
        },
      });
    }
    if (type === 'paragraph' || type === 'heading') {
      items.push({
        label: 'Align',
        hint: '▸',
        keep: true,
        run: (b) => {
          selectInside();
          D.closeMenu();
          alignMenu(b);
        },
      });
    }
    if (type === 'table') {
      items.push({ sep: true }, { head: 'Table' });
      const cellCmd = (fn) => () => {
        if (!(view.state.selection instanceof window.AIBDocEditor.selections.CellSelection)) {
          const S = window.AIBDocEditor.selections;
          view.dispatch(view.state.tr.setSelection(S.TextSelection.near(view.state.doc.resolve(pos + 3))));
        }
        run(fn);
      };
      items.push(
        { label: 'Add row below', run: cellCmd((c) => c.addRowAfter()) },
        { label: 'Add column right', run: cellCmd((c) => c.addColumnAfter()) },
        { label: 'Delete row', run: cellCmd((c) => c.deleteRow()) },
        { label: 'Delete column', run: cellCmd((c) => c.deleteColumn()) },
        { label: 'Merge cells', icon: 'merge', disabled: !e.can().mergeCells(), run: () => run((c) => c.mergeCells()) },
        { label: 'Split cell', disabled: !e.can().splitCell(), run: () => run((c) => c.splitCell()) },
        { label: 'Header row', run: cellCmd((c) => c.toggleHeaderRow()) },
        { label: 'Header column', run: cellCmd((c) => c.toggleHeaderColumn()) },
        { label: 'Make chart from this table', icon: 'chart', run: () => chartFromTable(pos) },
      );
    }
    if (type === 'chart') {
      items.push({ sep: true }, { label: 'Rename chart…', run: () => renameChart(pos) });
    }
    items.push({ sep: true });
    items.push(
      {
        label: 'Duplicate',
        hint: 'Ctrl+D',
        run: () => {
          const n = view.state.doc.nodeAt(pos);
          view.dispatch(
            view.state.tr.insert(
              pos + n.nodeSize,
              n.type.create(
                n.attrs,
                n.content,
                n.marks.filter((m) => m.type.name !== 'agentEdit'),
              ),
            ),
          );
        },
      },
      {
        label: 'Comment',
        hint: 'Ctrl+Alt+M',
        disabled: !textual,
        run: () => {
          selectInside();
          D.emit('comment-key');
        },
      },
      { label: 'Copy link to block', run: () => D.copyText(D.linkTo({ page: D.page, block: p.blockIdAt(pos) })) },
      { sep: true },
      {
        label: 'Delete',
        hint: 'Del',
        danger: true,
        run: () => {
          const n = view.state.doc.nodeAt(pos);
          const tr = view.state.tr;
          if (view.state.doc.childCount === 1)
            tr.replaceWith(pos, pos + n.nodeSize, view.state.schema.nodes.paragraph.create());
          else tr.delete(pos, pos + n.nodeSize);
          view.dispatch(tr);
        },
      },
    );
    D.menu(anchor, items, { side: 'right', cls: 'block-menu' });
  }
  D.blockMenu = blockMenu;

  function turnMenu(anchor, pos) {
    const e = tt();
    if (!e) return;
    const S = window.AIBDocEditor.selections;
    const view = e.view;
    const into = BLOCKS.filter((b) => b.set || ['callout', 'warning', 'success'].includes(b.id));
    D.menu(
      anchor,
      into.map((b) => ({
        label: b.label,
        icon: b.icon,
        iconCls: b.iconCls,
        run: () => {
          view.dispatch(view.state.tr.setSelection(S.TextSelection.near(view.state.doc.resolve(pos + 1))));
          if (b.set) return run(b.set);
          const n = view.state.doc.nodeAt(pos);
          // wrap the block in a callout (a callout holds text, lists and code)
          const json = b.json();
          json.content = [n.toJSON()];
          try {
            e.chain()
              .insertContentAt({ from: pos, to: pos + n.nodeSize }, json)
              .run();
          } catch (error) {
            D.fail(error);
          }
        },
      })),
      { side: 'right' },
    );
  }

  async function chartFromTable(pos) {
    const p = ed();
    const id = p && p.blockIdAt(pos);
    if (!id) return;
    try {
      await D.post('/api/live/docs/edit', {
        page: D.page,
        ops: [{ op: 'chart_from_table', target: { kind: 'blocks', ids: [id] }, attrs: { title: 'Chart' } }],
      });
      D.toast('Chart made from the table. It keeps its own copy of the numbers.');
    } catch (error) {
      D.fail(error);
    }
  }
  D.chartFromTable = chartFromTable;

  function renameChart(pos) {
    const e = tt();
    const node = e && e.view.state.doc.nodeAt(pos);
    if (!node) return;
    D.closeMenu();
    const box = el('form', 'linkform menu');
    const input = el('input');
    input.value = node.attrs.title || '';
    input.placeholder = 'Chart title';
    const ok = btn('btn sm pri', 'Save');
    ok.type = 'submit';
    box.append(input, ok);
    box.addEventListener('submit', (ev) => {
      ev.preventDefault();
      D.closeMenu();
      const cur = e.view.state.doc.nodeAt(pos);
      e.view.dispatch(
        e.view.state.tr.setNodeMarkup(pos, null, { ...cur.attrs, title: input.value.trim().slice(0, 200) }),
      );
    });
    D.menu(handles, [], { focus: false });
    const open = D.menuOpen();
    open.node.replaceWith(box);
    open.node = box;
    D.place(box, handles.getBoundingClientRect(), 'right');
    input.focus();
  }

  // Ctrl+D duplicates the block; Tab in a table is TipTap's own
  document.addEventListener('keydown', (e) => {
    const p = ed();
    if (!p || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'd' || e.shiftKey || !p.view.hasFocus()) return;
    e.preventDefault();
    const top = p.topBlockAt(p.view.state.selection.from);
    const n = top.node;
    p.view.dispatch(p.view.state.tr.insert(top.pos + n.nodeSize, n.type.create(n.attrs, n.content, n.marks)));
  });

  D.on('page', () => {
    handles.hidden = true;
    handleAt = null;
    paintTools();
  });
  D.on('boot', build);
})();

/* Deliberately small Markdown subset for agent messages. Raw HTML stays text;
   images never fetch remote resources. No claim of full CommonMark support. */
(function (root) {
  'use strict';
  const make = (tag, value) => {
    const node = document.createElement(tag);
    if (value !== undefined) node.textContent = value;
    return node;
  };
  const safeURL = (value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  };
  /* studio-artifact://<id> links (artifacts-ui.js opens them in the viewer on click). */
  const artifactId = (value) => {
    const m = /^studio-artifact:\/\/([0-9a-f]{8,64})\/?$/i.exec(String(value));
    return m ? m[1].toLowerCase() : null;
  };
  function inline(parent, value, depth = 0) {
    if (depth > 5) {
      parent.append(make('span', value));
      return;
    }
    const pattern =
      /\\([\\`*_[\]{}()#+.!>|-])|(`+)([^`\n]+?)\2|(!?\[([^\]\n]+)\]\(([^\s)]+)\))|\*\*(?=\S)(.+?)\*\*(?!\*)|(?<![A-Za-z0-9_])__(?=\S)(.+?)__(?![A-Za-z0-9_])|\*(?=[^\s*])([^*\n]+?)\*(?!\*)|(?<![A-Za-z0-9_])_(?=[^\s_])([^_\n]+?)_(?![A-Za-z0-9_])/g;
    let cursor = 0,
      match;
    while ((match = pattern.exec(value))) {
      if (match.index > cursor) parent.append(make('span', value.slice(cursor, match.index)));
      if (match[1]) parent.append(make('span', match[1]));
      else if (match[2]) parent.append(make('code', match[3]));
      else if (match[4]) {
        const art = match[4].startsWith('!') ? null : artifactId(match[6]);
        if (art) {
          const link = make('a');
          link.href = '#';
          link.className = 'artifact-link';
          link.dataset.artifactId = art;
          link.title = 'Open in the Artifacts viewer';
          link.append(make('span', '⧉ '));
          inline(link, match[5], depth + 1);
          parent.append(link);
        } else {
          const url = match[4].startsWith('!') ? null : safeURL(match[6]);
          if (url) {
            const link = make('a');
            link.href = url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            inline(link, match[5], depth + 1);
            parent.append(link);
          } else parent.append(make('span', match[0]));
        }
      } else {
        const strong = match[7] || match[8],
          node = make(strong ? 'strong' : 'em');
        inline(node, strong || match[9] || match[10], depth + 1);
        parent.append(node);
      }
      cursor = pattern.lastIndex;
    }
    if (cursor < value.length) parent.append(make('span', value.slice(cursor)));
  }
  const cells = (line) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split(/(?<!\\)\|/)
      .map((value) => value.trim().replace(/\\\|/g, '|'));
  const tableRule = (line) => {
    const values = cells(line);
    return values.length > 0 && values.every((value) => /^:?-{3,}:?$/.test(value));
  };
  const fence = (line) => line.match(/^\s{0,3}(`{3,}|~{3,})([^\n]*)$/);
  const listItem = (line) => {
    const m = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.+)$/);
    return m ? { marker: m[2], text: m[3], indent: m[1].replace(/	/g, '    ').length } : null;
  };
  function blocks(parent, lines, level = 0) {
    let i = 0;
    if (level > 8) {
      parent.append(make('p', lines.join('\n')));
      return;
    }
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      const start = fence(line);
      if (start) {
        const body = [],
          marker = start[1][0],
          length = start[1].length,
          language = start[2].trim();
        i++;
        while (i < lines.length) {
          const end = fence(lines[i]);
          if (end && end[1][0] === marker && end[1].length >= length && !end[2].trim()) {
            i++;
            break;
          }
          body.push(lines[i++]);
        }
        const box = make('div');
        box.className = 'markdown-code';
        if (language) box.append(make('small', language.slice(0, 80)));
        const pre = make('pre'),
          code = make('code', body.join('\n'));
        if (root.ToolViews && root.ToolViews.highlight && language)
          root.ToolViews.highlight(code, body.join('\n'), language.split(/\s/)[0].toLowerCase());
        pre.append(code);
        box.append(pre);
        parent.append(box);
        continue;
      }
      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*$/);
      if (heading) {
        const node = make('h' + Math.min(6, heading[1].length + 2));
        inline(node, heading[2]);
        parent.append(node);
        i++;
        continue;
      }
      if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        parent.append(make('hr'));
        i++;
        continue;
      }
      if (i + 1 < lines.length && line.includes('|') && tableRule(lines[i + 1])) {
        const table = make('table'),
          head = make('thead'),
          headRow = make('tr'),
          columns = cells(line);
        columns.forEach((value) => {
          const cell = make('th');
          inline(cell, value);
          headRow.append(cell);
        });
        head.append(headRow);
        table.append(head);
        i += 2;
        const body = make('tbody');
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          const row = make('tr'),
            values = cells(lines[i++]);
          columns.forEach((_, index) => {
            const cell = make('td');
            inline(cell, values[index] || '');
            row.append(cell);
          });
          body.append(row);
        }
        table.append(body);
        const wrapper = make('div');
        wrapper.className = 'markdown-table';
        wrapper.append(table);
        parent.append(wrapper);
        continue;
      }
      if (/^\s{0,3}>/.test(line)) {
        const quoted = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s{0,3}> ?/, ''));
        const quote = make('blockquote');
        blocks(quote, quoted, level + 1);
        parent.append(quote);
        continue;
      }
      const item = listItem(line);
      if (item && item.indent < 4) {
        const base = item.indent,
          ordered = /^\d/.test(item.marker),
          list = make(ordered ? 'ol' : 'ul');
        if (ordered) list.start = parseInt(item.marker, 10);
        let last = null;
        while (i < lines.length) {
          const next = listItem(lines[i]);
          if (next && next.indent > base && last) {
            const sub = [];
            while (i < lines.length && lines[i].trim()) {
              const deeper = listItem(lines[i]);
              if (deeper ? deeper.indent <= base : !/^\s/.test(lines[i])) break;
              sub.push(lines[i++].slice(Math.min(base + 1, lines[i - 1].search(/\S/))));
            }
            blocks(last, sub, level + 1);
            continue;
          }
          if (!next || next.indent !== base || /^\d/.test(next.marker) !== ordered) break;
          last = make('li');
          inline(last, next.text);
          list.append(last);
          i++;
        }
        parent.append(list);
        continue;
      }
      const paragraph = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !fence(lines[i]) &&
        !/^\s{0,3}(?:#{1,6}\s|>)/.test(lines[i]) &&
        !listItem(lines[i]) &&
        !(i + 1 < lines.length && lines[i].includes('|') && tableRule(lines[i + 1]))
      ) {
        paragraph.push(lines[i++]);
      }
      const node = make('p');
      paragraph.forEach((value, index) => {
        if (index) node.append(make('br'));
        inline(node, value);
      });
      parent.append(node);
    }
  }
  function render(container, value) {
    container.replaceChildren();
    blocks(
      container,
      String(value ?? '')
        .replace(/\r\n?/g, '\n')
        .split('\n'),
    );
    if (root.AgentArtifactsUI && typeof root.AgentArtifactsUI.linkify === 'function') {
      try {
        root.AgentArtifactsUI.linkify(container);
      } catch (e) {}
    }
  }
  root.AgentMarkdown = { render };
})(window);

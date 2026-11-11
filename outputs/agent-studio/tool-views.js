/* Purpose-built views for ACP tool calls, diffs and non-text content blocks.
   Everything from the agent is inserted with textContent; never as HTML. */
(function (root) {
  'use strict';
  const make = (tag, value, cls) => {
    const node = document.createElement(tag);
    if (value !== undefined && value !== null) node.textContent = String(value);
    if (cls) node.className = cls;
    return node;
  };
  const KINDS = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'];
  const STATUSES = ['pending', 'in_progress', 'completed', 'failed'];
  const MAX_DIFF_CELLS = 4000000,
    CONTEXT = 3,
    MAX_BASE64 = 7 * 1024 * 1024;
  const httpURL = (value) => {
    try {
      const url = new URL(String(value));
      return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  };
  const filePath = (value) => {
    const text = String(value ?? '');
    if (!/^file:/i.test(text)) return text;
    try {
      const url = new URL(text);
      let p = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      return (url.host && url.host !== 'localhost' ? '//' + url.host : '') + p;
    } catch {
      return text;
    }
  };
  const size = (bytes) => {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    return bytes < 1024
      ? bytes + ' B'
      : bytes < 1048576
        ? (bytes / 1024).toFixed(1) + ' KB'
        : (bytes / 1048576).toFixed(1) + ' MB';
  };
  const b64 = (value) =>
    typeof value === 'string' && value.length <= MAX_BASE64 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
  const b64Bytes = (value) =>
    Math.floor((value.length * 3) / 4) - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);

  /* Line diff via LCS; falls back to prefix/suffix trimming for very large inputs. */
  function lineDiff(oldText, newText) {
    const a = oldText == null || oldText === '' ? [] : String(oldText).split('\n'),
      b = newText == null || newText === '' ? [] : String(newText).split('\n');
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length,
      endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
      endA--;
      endB--;
    }
    const out = [];
    for (let i = 0; i < start; i++) out.push({ type: 'ctx', text: a[i] });
    const x = a.slice(start, endA),
      y = b.slice(start, endB);
    if (x.length * y.length > MAX_DIFF_CELLS) {
      x.forEach((t) => out.push({ type: 'del', text: t }));
      y.forEach((t) => out.push({ type: 'add', text: t }));
    } else {
      const n = x.length,
        m = y.length,
        w = m + 1,
        table = new Uint32Array((n + 1) * w);
      for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
          table[i * w + j] =
            x[i] === y[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
      let i = 0,
        j = 0;
      while (i < n && j < m) {
        if (x[i] === y[j]) {
          out.push({ type: 'ctx', text: x[i] });
          i++;
          j++;
        } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) out.push({ type: 'del', text: x[i++] });
        else out.push({ type: 'add', text: y[j++] });
      }
      while (i < n) out.push({ type: 'del', text: x[i++] });
      while (j < m) out.push({ type: 'add', text: y[j++] });
    }
    for (let i = endA; i < a.length; i++) out.push({ type: 'ctx', text: a[i] });
    return out;
  }

  function diffView(item) {
    const path = filePath(item.path),
      lines = lineDiff(item.oldText, item.newText);
    const added = lines.filter((l) => l.type === 'add').length,
      removed = lines.filter((l) => l.type === 'del').length;
    const box = make('details', '', 'tool-diff');
    box.open = true;
    box.copyCode = item.newText == null ? '' : String(item.newText);
    box.copyLang = langFromPath(path);
    const summary = make('summary', '');
    summary.append(
      make('span', path || '(unknown file)', 'diff-path'),
      make('span', item.oldText == null ? 'new file' : '', 'diff-new'),
      make('span', '+' + added, 'diff-added'),
      make('span', '-' + removed, 'diff-removed'),
    );
    box.append(summary);
    const body = make('div', '', 'diff-body');
    const show = new Array(lines.length).fill(false);
    lines.forEach((l, i) => {
      if (l.type !== 'ctx')
        for (let k = Math.max(0, i - CONTEXT); k <= Math.min(lines.length - 1, i + CONTEXT); k++) show[k] = true;
    });
    if (!lines.some((l) => l.type !== 'ctx')) body.append(make('div', 'No line changes.', 'diff-skip'));
    let skipped = 0;
    const flush = () => {
      if (skipped) {
        body.append(make('div', '… ' + skipped + ' unchanged line' + (skipped === 1 ? '' : 's'), 'diff-skip'));
        skipped = 0;
      }
    };
    lines.forEach((l, i) => {
      if (!show[i]) {
        skipped++;
        return;
      }
      flush();
      const row = make('div', '', 'diff-line diff-' + l.type);
      row.append(
        make('span', l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ', 'diff-sign'),
        make('span', l.text, 'diff-text'),
      );
      body.append(row);
    });
    flush();
    box.append(body);
    return box;
  }

  /* Non-text content blocks (message chunks and tool content). */
  function contentBlock(block) {
    const box = make('div', '', 'content-block');
    if (!block || typeof block !== 'object') {
      box.append(make('pre', String(block ?? '')));
      return box;
    }
    const type = block.type;
    if (type === 'text') {
      box.append(make('pre', block.text || ''));
      return box;
    }
    if (type === 'image') {
      if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(block.mimeType) && b64(block.data)) {
        const img = make('img');
        img.className = 'message-image';
        img.alt = 'Image';
        img.loading = 'lazy';
        img.src = 'data:' + block.mimeType + ';base64,' + block.data;
        if (root.ImageViewer && root.ImageViewer.makeViewable) root.ImageViewer.makeViewable(img, 'Tool image');
        box.append(img);
      } else
        box.append(make('span', 'Image not shown (' + (block.mimeType || 'unknown type') + ')', 'content-summary'));
      return box;
    }
    if (type === 'audio') {
      const okMime = /^audio\/(wav|x-wav|mpeg|mp3|ogg|webm|aac|flac|mp4)$/.test(block.mimeType || '');
      if (okMime && b64(block.data)) {
        const audio = make('audio');
        audio.controls = true;
        audio.preload = 'none';
        audio.src = 'data:' + block.mimeType + ';base64,' + block.data;
        box.append(audio, make('span', ' ' + block.mimeType + ' · ' + size(b64Bytes(block.data)), 'content-summary'));
      } else
        box.append(
          make(
            'span',
            'Audio ' +
              (block.mimeType || '') +
              (typeof block.data === 'string' ? ' · ' + size(b64Bytes(block.data)) : '') +
              ' (not played)',
            'content-summary',
          ),
        );
      return box;
    }
    if (type === 'resource_link') {
      box.classList.add('resource-link');
      const label = block.title || block.name || block.uri || 'resource',
        web = httpURL(block.uri);
      let head;
      if (web) {
        head = make('a', label);
        head.href = web;
        head.target = '_blank';
        head.rel = 'noopener noreferrer';
      } else head = make('strong', label);
      box.append(make('span', 'Link', 'content-tag'), head);
      const meta = [block.mimeType, block.size != null ? size(Number(block.size)) : ''].filter(Boolean).join(' · ');
      if (meta) box.append(make('span', meta, 'content-summary'));
      if (block.uri) box.append(make('code', web ? web : filePath(block.uri), 'content-uri'));
      if (block.description) box.append(make('p', block.description, 'content-summary'));
      return box;
    }
    if (type === 'resource') {
      const res = block.resource || {},
        uri = res.uri ? filePath(res.uri) : '(embedded resource)';
      box.classList.add('resource-embedded');
      if (typeof res.text === 'string') {
        const d = make('details', '', '');
        d.append(
          make('summary', uri + (res.mimeType ? ' · ' + res.mimeType : '') + ' · ' + size(res.text.length) + ' text'),
          make('pre', res.text.slice(0, 200000)),
        );
        box.append(d);
      } else if (typeof res.blob === 'string') {
        box.append(
          make('span', 'Embedded binary', 'content-tag'),
          make('code', uri, 'content-uri'),
          make(
            'span',
            [res.mimeType || 'unknown type', b64(res.blob) ? size(b64Bytes(res.blob)) : 'large'].join(' · ') +
              ' (not rendered)',
            'content-summary',
          ),
        );
      } else box.append(make('code', uri, 'content-uri'));
      return box;
    }
    box.append(make('span', 'Unsupported content: ' + String(type || 'unknown'), 'content-summary'));
    return box;
  }

  function locationsView(locations) {
    const list = make('ul', '', 'tool-locations');
    let count = 0;
    for (const loc of locations) {
      if (!loc || typeof loc !== 'object') continue;
      list.append(make('li', filePath(loc.path) + (loc.line != null ? ':' + loc.line : '')));
      count++;
    }
    return count ? list : null;
  }

  /* ---- Readable tool details: analysis of the call, light highlighting, code blocks, key/value lists. ---- */
  const LANG_BY_EXT = {
    py: 'python',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    jsonc: 'json',
    md: 'markdown',
    html: 'html',
    htm: 'html',
    css: 'css',
    sh: 'bash',
    bash: 'bash',
    ps1: 'powershell',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'toml',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cs: 'csharp',
    rb: 'ruby',
    sql: 'sql',
    xml: 'xml',
    diff: 'diff',
    patch: 'diff',
  };
  const langFromPath = (p) => {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(p || ''));
    return m ? LANG_BY_EXT[m[1].toLowerCase()] || '' : '';
  };
  const ALIAS = {
    js: 'javascript',
    ts: 'javascript',
    typescript: 'javascript',
    jsx: 'javascript',
    tsx: 'javascript',
    node: 'javascript',
    py: 'python',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    ps1: 'powershell',
    pwsh: 'powershell',
    jsonc: 'json',
    cs: 'csharp',
    yml: 'yaml',
    patch: 'diff',
  };
  const KEYWORDS = {
    python:
      'def class return if elif else for while in not and or is import from as with try except finally raise lambda None True False pass break continue yield async await global nonlocal assert del',
    javascript:
      'function const let var return if else for while do switch case break continue new this class extends import export from default async await try catch finally throw typeof instanceof in of null undefined true false void',
    bash: 'if then else elif fi for while do done case esac function in echo cd export return exit set local source',
    powershell:
      'if else elseif foreach for while function param return switch try catch finally throw in $true $false $null',
    json: 'true false null',
    sql: 'select from where and or not insert into update delete create table values join left right inner on group by order limit as null',
    c: 'if else for while return struct int char void const static',
    go: 'func package import return if else for range var const type struct nil true false',
    rust: 'fn let mut pub use struct impl enum match if else for while return true false',
  };
  const KEYSETS = {};
  for (const k of Object.keys(KEYWORDS)) KEYSETS[k] = new Set(KEYWORDS[k].split(' '));
  const HASH = ['python', 'bash', 'powershell', 'yaml', 'toml', 'ruby'],
    SLASH = ['javascript', 'c', 'cpp', 'csharp', 'java', 'rust', 'go', 'css'];
  const REGEX_CACHE = {};
  function tokenRegex(lang) {
    if (REGEX_CACHE[lang]) return REGEX_CACHE[lang];
    const parts = [];
    if (HASH.includes(lang)) parts.push('(#[^\\n]*)');
    else if (SLASH.includes(lang)) parts.push('(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)');
    else if (lang === 'sql') parts.push('(--[^\\n]*)');
    else parts.push('(?!)()');
    let str = '"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'';
    if (lang === 'python') str = '"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|' + str;
    if (lang === 'javascript') str += '|`(?:\\\\.|[^`\\\\])*`';
    parts.push('(' + str + ')', '(\\b\\d+(?:\\.\\d+)?\\b)', '([A-Za-z_$][\\w$-]*)');
    return (REGEX_CACHE[lang] = new RegExp(parts.join('|'), 'g'));
  }
  /* Returns [{text,cls}] whose texts concatenate to exactly the input. */
  function tokenize(code, lang) {
    code = String(code ?? '');
    lang = String(lang || '').toLowerCase();
    lang = ALIAS[lang] || lang;
    if (!lang || code.length > 30000) return [{ text: code, cls: '' }];
    const out = [];
    if (lang === 'diff') {
      const lines = code.split('\n');
      lines.forEach((line, i) => {
        const cls = line.startsWith('@@')
          ? 'tok-h'
          : line.startsWith('+') && !line.startsWith('+++')
            ? 'tok-add'
            : line.startsWith('-') && !line.startsWith('---')
              ? 'tok-del'
              : '';
        out.push({ text: line + (i < lines.length - 1 ? '\n' : ''), cls });
      });
      return out;
    }
    if (!(lang in KEYWORDS) && !HASH.includes(lang) && !SLASH.includes(lang)) return [{ text: code, cls: '' }];
    const keys = KEYSETS[lang] || new Set(),
      fold = lang === 'powershell' || lang === 'sql',
      re = new RegExp(tokenRegex(lang).source, 'g');
    let cursor = 0,
      m;
    while ((m = re.exec(code))) {
      if (m[0] === '') break;
      if (m.index > cursor) out.push({ text: code.slice(cursor, m.index), cls: '' });
      let cls = '';
      if (m[1]) cls = 'tok-c';
      else if (m[2]) {
        cls = 'tok-s';
        if (lang === 'json' && /^\s*:/.test(code.slice(re.lastIndex, re.lastIndex + 40))) cls = 'tok-key';
      } else if (m[3]) cls = 'tok-n';
      else if (m[4] && keys.has(fold ? m[4].toLowerCase() : m[4])) cls = 'tok-k';
      out.push({ text: m[0], cls });
      cursor = re.lastIndex;
    }
    if (cursor < code.length) out.push({ text: code.slice(cursor), cls: '' });
    return out;
  }
  function highlight(codeEl, code, lang) {
    const toks = tokenize(code, lang);
    codeEl.textContent = '';
    if (toks.length === 1 && !toks[0].cls) {
      codeEl.textContent = String(code ?? '');
      return codeEl;
    }
    for (const t of toks) codeEl.append(t.cls ? make('span', t.text, t.cls) : make('span', t.text));
    return codeEl;
  }
  /* A code block: optional label, monospace <pre><code>. Expando fields feed the copy button. */
  function codeBlock(text, lang, label) {
    text = String(text ?? '');
    const box = make('div', '', 'code-block'),
      pre = make('pre'),
      code = make('code');
    const shown = label || lang;
    if (shown) box.append(make('small', shown, 'code-lang'));
    pre.append(code);
    box.append(pre);
    highlight(code, text, lang);
    box.copyCode = text;
    box.copyLang = lang || '';
    return box;
  }
  const prettyJSON = (v) => {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  };
  function jsonBlock(value) {
    return codeBlock(prettyJSON(value), 'json');
  }
  const isScalar = (v) =>
    v === null ||
    ['number', 'boolean'].includes(typeof v) ||
    (typeof v === 'string' && v.length <= 60 && !v.includes('\n'));
  function chipsView(obj) {
    const row = make('div', '', 'tool-chips');
    for (const [k, v] of Object.entries(obj))
      if (isScalar(v)) {
        const chip = make('span', '', 'tool-chip');
        chip.append(make('span', k, 'chip-key'), make('span', v === null ? 'null' : String(v), 'chip-val'));
        row.append(chip);
      }
    return row.children.length ? row : null;
  }
  /* Pretty key/value list; long strings become code blocks, objects pretty-printed JSON. */
  function kvView(obj) {
    const list = make('div', '', 'tool-kv');
    for (const [k, v] of Object.entries(obj)) {
      const row = make('div', '', 'kv-row');
      row.append(make('div', k, 'kv-key'));
      const val = make('div', '', 'kv-val');
      if (typeof v === 'string') {
        if (v.includes('\n') || v.length > 100) val.append(codeBlock(v, ''));
        else val.append(make('span', v, 'kv-str'));
      } else if (v && typeof v === 'object') val.append(jsonBlock(v));
      else val.append(make('span', v === null ? 'null' : String(v), 'kv-lit'));
      row.append(val);
      list.append(row);
    }
    return list.children.length ? list : null;
  }
  const SHELLS = {
    bash: 'bash',
    powershell: 'powershell',
    pwsh: 'powershell',
    shell: 'shell',
    exec_command: 'shell',
    run_terminal_cmd: 'shell',
    run_terminal_command: 'shell',
    execute: 'shell',
    monitor: 'bash',
  };
  const pathOf = (i) => {
    for (const k of ['file_path', 'path', 'filePath', 'notebook_path', 'filename'])
      if (typeof i[k] === 'string') return [k, i[k]];
    return [null, ''];
  };
  const without = (obj, keys) => {
    const out = {};
    for (const [k, v] of Object.entries(obj))
      if (!keys.includes(k) && !(k === 'i' && typeof v === 'number')) out[k] = v;
    return out;
  };
  const asObject = (v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (typeof v === 'string') {
      try {
        const p = JSON.parse(v);
        if (p && typeof p === 'object' && !Array.isArray(p)) return p;
      } catch {}
    }
    return null;
  };
  /* Classify a call from its tool name and input object. */
  function analyze(name, input) {
    input = asObject(input) || {};
    const n = String(name || '').toLowerCase(),
      [pathKey, path] = pathOf(input);
    if (SHELLS[n] && typeof input.command === 'string')
      return {
        type: 'shell',
        name,
        shell: SHELLS[n],
        command: input.command,
        description: typeof input.description === 'string' ? input.description : '',
        rest: without(input, ['command', 'description']),
      };
    if (n === 'eval' && typeof input.code === 'string')
      return {
        type: 'code',
        name,
        lang: String(input.language || '').toLowerCase(),
        code: input.code,
        title: input.title || '',
        rest: without(input, ['code', 'language', 'title']),
      };
    if (n === 'read' || n === 'view' || n === 'notebookread')
      return { type: 'read', name, path, rest: without(input, [pathKey]) };
    if (n === 'write' && typeof input.content === 'string')
      return { type: 'write', name, path, content: input.content, rest: without(input, [pathKey, 'content']) };
    if (n === 'multiedit' || (n === 'edit' && Array.isArray(input.edits))) {
      const edits = (input.edits || [])
        .filter((e) => e && typeof e === 'object')
        .map((e) => ({ oldText: e.old_string ?? e.oldText ?? '', newText: e.new_string ?? e.newText ?? '' }));
      return { type: 'edit', name, path, edits, rest: without(input, [pathKey, 'edits']) };
    }
    if (n === 'edit' && ('old_string' in input || 'new_string' in input || 'oldText' in input))
      return {
        type: 'edit',
        name,
        path,
        edits: [{ oldText: input.old_string ?? input.oldText ?? '', newText: input.new_string ?? input.newText ?? '' }],
        rest: without(input, [pathKey, 'old_string', 'new_string', 'oldText', 'newText']),
      };
    if (n === 'edit' && typeof input.input === 'string')
      return { type: 'patch', name, path, patch: input.input, rest: without(input, [pathKey, 'input']) };
    if ((n === 'glob' || n === 'grep' || n === 'find' || n === 'search') && typeof input.pattern === 'string')
      return { type: 'search', name, pattern: input.pattern, path, rest: without(input, ['pattern', pathKey]) };
    return { type: 'generic', name, input, rest: without(input, []) };
  }
  const nameForKind = { execute: 'bash', read: 'read', edit: 'edit', search: 'grep' };
  const lineCount = (t) => String(t).split('\n').length;
  function pathView(path) {
    const row = make('div', '', 'tool-path');
    row.append(make('code', filePath(path), 'tool-path-text'));
    return row;
  }
  function resultView(text, isError) {
    text = String(text ?? '');
    if (!text) return null;
    let lang = '';
    const t = text.trim();
    if (/^[{[]/.test(t)) {
      try {
        text = JSON.stringify(JSON.parse(t), null, 2);
        lang = 'json';
      } catch {}
    }
    const lines = lineCount(text),
      box = make('details', '', 'tool-result' + (isError ? ' tool-result-error' : ''));
    box.open = lines <= 15;
    box.append(
      make('summary', (isError ? 'Error output' : 'Output') + ' · ' + lines + ' line' + (lines === 1 ? '' : 's')),
      codeBlock(text, lang),
    );
    return box;
  }
  /* The readable body of a call (everything under the header). */
  function body(a, opts) {
    opts = opts || {};
    const box = make('div', '', 'tool-body');
    const chips = (obj) => {
      const c = chipsView(obj);
      if (c) box.append(c);
    };
    const leftover = (obj) => {
      const big = {};
      for (const [k, v] of Object.entries(obj)) if (!isScalar(v)) big[k] = v;
      const kv = kvView(big);
      if (kv) box.append(kv);
    };
    if (a.type === 'shell') {
      if (a.description) box.append(make('div', a.description, 'tool-caption'));
      const cmd = codeBlock(a.command, a.shell === 'shell' ? 'bash' : a.shell, a.shell);
      box.append(cmd);
      chips(a.rest);
      leftover(a.rest);
    } else if (a.type === 'code') {
      if (a.title) box.append(make('div', a.title, 'tool-caption'));
      box.append(codeBlock(a.code, a.lang, a.lang || 'code'));
      chips(a.rest);
      leftover(a.rest);
    } else if (a.type === 'read') {
      if (a.path) box.append(pathView(a.path));
      chips(a.rest);
      leftover(a.rest);
    } else if (a.type === 'write') {
      if (a.path) box.append(pathView(a.path));
      if (!opts.skipDiff) box.append(codeBlock(a.content, langFromPath(a.path), langFromPath(a.path) || 'content'));
      chips(a.rest);
      leftover(a.rest);
    } else if (a.type === 'edit') {
      if (a.path) box.append(pathView(a.path));
      if (!opts.skipDiff)
        for (const e of a.edits) box.append(diffView({ path: a.path, oldText: e.oldText, newText: e.newText }));
      chips(a.rest);
      leftover(a.rest);
    } else if (a.type === 'patch') {
      if (a.path) box.append(pathView(a.path));
      box.append(codeBlock(a.patch, 'diff', 'patch'));
      chips(a.rest);
      leftover(a.rest);
    } else if (a.type === 'search') {
      const row = make('div', '', 'tool-pattern');
      row.append(make('span', 'pattern', 'kv-key'), make('code', a.pattern, 'inline-code'));
      if (a.path) row.append(make('span', 'in', 'kv-key'), make('code', filePath(a.path), 'inline-code'));
      box.append(row);
      chips(a.rest);
      leftover(a.rest);
    } else {
      const kv = kvView(a.input || {});
      if (kv) box.append(kv);
      else box.append(make('span', 'No arguments.', 'content-summary'));
    }
    return box;
  }
  function rawDetails(value) {
    const d = make('details', '', 'tool-raw');
    d.append(make('summary', 'Raw JSON'), make('pre', (prettyJSON(value) || '').slice(0, 40000)));
    return d;
  }
  /* Saved-history tool row: call={name,input,intent,result:{text,isError}}. */
  function renderCall(call) {
    call = call || {};
    const result = call.result;
    const a = analyze(call.name, call.input),
      box = make('div', '', 'tool-view tool-call tool-type-' + a.type);
    const head = make('div', '', 'tool-head');
    head.append(
      make('span', a.type === 'shell' ? 'execute' : a.type === 'generic' ? 'tool' : a.type, 'tool-kind'),
      make('strong', call.name || 'Tool', 'tool-title'),
    );
    if (result)
      head.append(
        make(
          'span',
          result.isError ? 'failed' : 'completed',
          'tool-status status-' + (result.isError ? 'failed' : 'completed'),
        ),
      );
    box.append(head);
    if (call.input && typeof call.input === 'object') {
      if (call.intent && !a.description) box.append(make('div', call.intent, 'tool-caption'));
      box.append(body(a, {}));
    } else if (typeof call.input === 'string') box.append(codeBlock(call.input, ''));
    if (result) {
      const r = resultView(result.text, result.isError);
      if (r) box.append(r);
    }
    const shots = toolImages({ call });
    if (shots.length) box.append(imageStrip(shots));
    box.append(rawDetails({ name: call.name, input: call.input, result: result || undefined }));
    return box;
  }
  /* Parses saved tool rows' JSON and attaches each result row to its call by id. */
  function pairSaved(rows) {
    const byId = new Map(),
      seen = new Map(),
      out = [];
    for (const row of rows) {
      if (row.role === 'tool') {
        let input = row.value;
        const text = String(row.value || '').replace(/\n\n\[Display shortened[^\]]*\]\s*$/, '');
        try {
          input = JSON.parse(text);
        } catch {}
        const copy = { ...row, call: { name: row.label, input, intent: row.intent || '' } };
        if (row.callId) {
          const n = (seen.get(row.callId) || 0) + 1;
          seen.set(row.callId, n);
          if (n > 1) copy.uid = row.callId + '#' + n; // the id was used before: its own row, opened on its own
          byId.set(row.callId, copy);
        }
        out.push(copy);
        continue;
      }
      if (
        (row.role === 'result' || row.role === 'error') &&
        row.callId &&
        byId.has(row.callId) &&
        !byId.get(row.callId).call.result
      ) {
        byId.get(row.callId).call.result = { text: row.value, isError: row.role === 'error' };
        const shots = (row.attachments || []).filter((a) => a && a.type === 'transcript-image');
        if (shots.length) byId.get(row.callId).call.result.images = shots;
        continue;
      }
      out.push(row);
    }
    return out;
  }
  const fence = (text, lang) => {
    const runs = String(text).match(/`+/g) || [],
      n = Math.max(3, ...runs.map((r) => r.length + 1)),
      f = '`'.repeat(n);
    return f + (lang || '') + '\n' + String(text).replace(/\n$/, '') + '\n' + f;
  };
  const kvLine = (obj) =>
    Object.entries(obj || {})
      .filter(([, v]) => isScalar(v))
      .map(([k, v]) => k + ': ' + v)
      .join(' · ');
  const changed = (o, n) =>
    lineDiff(o, n)
      .filter((l) => l.type !== 'ctx')
      .map((l) => (l.type === 'add' ? '+' : '-') + l.text)
      .join('\n');
  /* Markdown source for a call (used by the copy menu). */
  function callMarkdown(call, extra) {
    call = call || {};
    const result = call.result,
      a = analyze(call.name, call.input),
      out = [];
    out.push(
      '**' +
        (call.title || call.name || 'Tool') +
        '**' +
        (a.type === 'shell' && a.description ? ' — ' + a.description : ''),
    );
    if (a.type === 'shell') out.push(fence(a.command, a.shell === 'shell' ? 'bash' : a.shell));
    else if (a.type === 'code') out.push(fence(a.code, a.lang));
    else if (a.type === 'read') out.push('`' + a.path + '`');
    else if (a.type === 'write') {
      out.push('`' + a.path + '`');
      out.push(fence(a.content, langFromPath(a.path)));
    } else if (a.type === 'edit') {
      out.push('`' + a.path + '`');
      for (const e of a.edits) out.push(fence(changed(e.oldText, e.newText), 'diff'));
    } else if (a.type === 'patch') {
      out.push('`' + a.path + '`');
      out.push(fence(a.patch, 'diff'));
    } else if (a.type === 'search') out.push('`' + a.pattern + '`' + (a.path ? ' in `' + a.path + '`' : ''));
    else if (call.input && typeof call.input === 'object' && Object.keys(call.input).length)
      out.push(fence(prettyJSON(call.input), 'json'));
    else if (typeof call.input === 'string') out.push(fence(call.input, ''));
    const line = kvLine(a.rest);
    if (line) out.push(line);
    if (extra) out.push(extra);
    if (result && result.text)
      out.push((result.isError ? 'Error output:' : 'Output:') + '\n\n' + fence(result.text, ''));
    return out.join('\n\n');
  }
  const toolNameOf = (raw) =>
    (raw && raw._meta && raw._meta.claudeCode && raw._meta.claudeCode.toolName) ||
    (raw && raw.toolName) ||
    nameForKind[raw && raw.kind] ||
    '';
  const contentText = (raw) =>
    Array.isArray(raw && raw.content)
      ? raw.content
          .filter((i) => i && i.type === 'content' && i.content && i.content.type === 'text')
          .map((i) => i.content.text)
          .join('\n')
      : '';
  const outputText = (raw) => {
    const o = raw && raw.rawOutput;
    if (o == null) return '';
    if (typeof o === 'string') return o;
    const t = o.stdout ?? o.output ?? o.text;
    if (typeof t === 'string') return t + (o.stderr ? '\n' + o.stderr : '');
    return prettyJSON(o);
  };
  function rawMarkdown(raw) {
    raw = raw || {};
    const input = asObject(raw.rawInput);
    if (input)
      return callMarkdown({
        name: toolNameOf(raw),
        input,
        title: raw.title,
        result: { text: outputText(raw) || contentText(raw), isError: raw.status === 'failed' },
      });
    const parts = [
      '**' +
        (raw.title || raw.toolCallId || 'Tool call') +
        '**' +
        (raw.status ? ' — ' + String(raw.status).replace('_', ' ') : ''),
    ];
    if (Array.isArray(raw.content))
      for (const item of raw.content)
        if (item && item.type === 'diff')
          parts.push('`' + filePath(item.path) + '`\n\n' + fence(changed(item.oldText, item.newText), 'diff'));
    const text = contentText(raw);
    if (text) parts.push(fence(text, ''));
    return parts.join('\n\n');
  }

  /* ---- Compact one-line tool rows, status markers and step groups ---- */
  const baseName = (p) =>
    String(p || '')
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || String(p || '');
  const oneLine = (t) =>
    String(t ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  /* The most informative part of a shell command: skip cd/variable/set/export prefixes and comments. */
  function commandSummary(command) {
    let lines = String(command || '')
      .split('\n')
      .filter((l) => l.trim() && !/^\s*#/.test(l));
    const here = lines.findIndex((l) => /<<-?\s*['"]?\w+/.test(l));
    if (here >= 0) lines = lines.slice(0, here + 1);
    const prefix = /^\s*(?:cd|pushd|set|export|setlocal|Set-Location|Set-Variable|\$[\w:.]+\s*=|[A-Za-z_]\w*=)/i;
    const segments = [];
    for (const line of lines) for (const seg of line.split(/\s*(?:&&|;)\s*/)) if (seg.trim()) segments.push(seg.trim());
    const useful = segments.filter((s) => !prefix.test(s));
    return oneLine((useful.length ? useful : segments).join(' ; ') || command);
  }
  const prettyName = (n) =>
    String(n || 'Tool')
      .replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '')
      .replace(/_/g, ' ');
  const firstText = (obj) => {
    for (const k of [
      'description',
      'summary',
      'title',
      'query',
      'url',
      'pattern',
      'prompt',
      'message',
      'reason',
      'text',
    ])
      if (typeof obj[k] === 'string' && obj[k].trim()) return oneLine(obj[k]);
    for (const v of Object.values(obj)) if (typeof v === 'string' && v.trim()) return oneLine(v);
    return '';
  };
  /* {label, text, status} for a tool row. status: running|ok|failed|pending|'' */
  function resultFailed(text) {
    return /^\s*(?:exit code:?|exited with(?: code)?|returncode:?)\s*[1-9]\d*/i.test(String(text || ''));
  }
  function summarize(row) {
    let a = null,
      status = '',
      name = '',
      inp = null;
    if (row.raw) {
      const raw = row.raw,
        input = asObject(raw.rawInput);
      name = toolNameOf(raw);
      inp = input;
      a = analyze(name, input || {});
      if (!input) a = { type: 'title', name, title: raw.title || raw.toolCallId || 'Tool call', kind: raw.kind };
      status =
        { pending: 'pending', in_progress: 'running', completed: 'ok', failed: 'failed' }[raw.status] ||
        (raw.status ? '' : 'pending');
    } else if (row.call) {
      const c = row.call;
      name = c.name;
      inp = asObject(c.input);
      a = analyze(name, c.input);
      if (c.result) status = c.result.isError || resultFailed(c.result.text) ? 'failed' : 'ok';
      else status = c.running ? 'running' : 'pending'; // no result yet: running only when the chat says another app is on it (chat.js markRunningCall)
    }
    if (!a) return { label: 'tool', text: oneLine(row.label || 'Tool'), status };
    const t = a.type;
    let label = 'tool',
      text = '';
    if (t === 'shell') {
      label = 'run';
      const ran = 'Ran ' + commandSummary(a.command);
      /* Agents such as Claude Code write a plain-words description of each command (Bash/PowerShell "description"); show that, keep the command as the hover hint. */
      const d = inp && typeof inp.description === 'string' ? oneLine(inp.description) : '';
      if (d) return { label, text: d, status, hint: ran };
      text = ran;
    } else if (t === 'code') {
      label = 'run';
      text = 'Ran ' + (a.lang || 'code') + ': ' + oneLine(a.code);
    } else if (t === 'read') {
      label = 'read';
      text = 'Read ' + baseName(a.path);
    } else if (t === 'write') {
      label = 'write';
      text = 'Wrote ' + baseName(a.path);
    } else if (t === 'edit' || t === 'patch') {
      label = 'edit';
      text = 'Edited ' + baseName(a.path);
    } else if (t === 'search') {
      label = 'search';
      text = "Searched '" + a.pattern + "'" + (a.path ? ' in ' + baseName(a.path) : '');
    } else if (t === 'title') {
      label =
        a.kind === 'execute'
          ? 'run'
          : a.kind === 'read'
            ? 'read'
            : a.kind === 'edit'
              ? 'edit'
              : a.kind === 'search'
                ? 'search'
                : 'tool';
      text = oneLine(a.title);
    } else {
      const n = String(name || '').toLowerCase(),
        input = a.input || {};
      if (['agent', 'task', 'subagent'].includes(n)) {
        label = 'task';
        text = (n === 'agent' ? 'Agent' : 'Task') + ': ' + (firstText(input) || 'launched');
      } else {
        text = prettyName(name) + (firstText(input) ? ': ' + firstText(input) : '');
      }
    }
    return { label, text, status };
  }
  /* The file a tool row is about, for the "open" button: {path, line|null} or null. Locations (ACP) win; otherwise the call's own
    path argument for read / write / edit calls. A line comes only from a location or a Read offset. */
  const FILE_TYPES = new Set(['read', 'write', 'edit', 'patch']);
  const posInt = (v) => (Number.isInteger(v) && v > 0 ? v : null);
  function fileTarget(row) {
    let path = '',
      lineNo = null;
    const fromCall = (name, input) => {
      const a = analyze(name, input || {});
      if (FILE_TYPES.has(a.type) && a.path) {
        path = filePath(a.path);
        if (a.type === 'read') lineNo = posInt(asObject(input) && asObject(input).offset);
      }
    };
    if (row && row.raw) {
      const raw = row.raw,
        loc = Array.isArray(raw.locations)
          ? raw.locations.find((l) => l && typeof l.path === 'string' && l.path)
          : null;
      if (loc) {
        path = filePath(loc.path);
        lineNo = posInt(loc.line);
      } else {
        const input = asObject(raw.rawInput);
        if (input) fromCall(toolNameOf(raw), input);
        if (!path && Array.isArray(raw.content)) {
          const d = raw.content.find((i) => i && i.type === 'diff' && typeof i.path === 'string' && i.path);
          if (d) path = filePath(d.path);
        }
      }
    } else if (row && row.call) fromCall(row.call.name, row.call.input);
    return path ? { path, line: lineNo } : null;
  }
  /* Open rows and groups, per chat: setScope(chat) is called when a chat opens, so an open group never carries into another
     chat that happens to use the same call ids. row.uid tells apart calls that reuse an id (a later turn's "call-1"). */
  const OPEN = new Set();
  let scope = '';
  const EXPANDED = {
    has: (key) => OPEN.has(scope + '\u0000' + key),
    add: (key) => OPEN.add(scope + '\u0000' + key),
    delete: (key) => OPEN.delete(scope + '\u0000' + key),
  };
  function setScope(next) {
    scope = String(next || '');
  }
  const rowKey = (row) =>
    row.uid || row.callId || (row.raw && row.raw.toolCallId) || String(row.label || '') + '|' + String(row.time || '');
  function statusMark(status) {
    const mark = make('span', '', 'tool-mark mark-' + (status || 'none'));
    const text = { running: 'running', ok: 'completed', failed: 'failed', pending: 'pending' }[status];
    if (text) {
      mark.append(
        make('span', { running: '', ok: '✓', failed: '✗', pending: '•' }[status], 'mark-glyph'),
        make('span', text, 'sr-only'),
      );
    }
    return mark;
  }
  /* Pictures a tool returned: saved chats give Studio image addresses (call.result.images); live ACP tool content gives image blocks. */
  const SAVED_IMAGE = /^\/api\/transcript\/image\?/;
  const liveImageOk = (im) =>
    typeof root.safeImageBlock === 'function'
      ? root.safeImageBlock(im)
      : !!im &&
        im.type === 'image' &&
        ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(im.mimeType) &&
        typeof im.data === 'string' &&
        im.data.length <= 7 * 1024 * 1024 &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(im.data);
  function toolImages(row) {
    const out = [],
      saved = row && row.call && row.call.result && row.call.result.images;
    if (Array.isArray(saved))
      for (const im of saved) if (im && typeof im.url === 'string' && SAVED_IMAGE.test(im.url)) out.push(im.url);
    const live = row && row.raw && row.raw.content;
    if (Array.isArray(live))
      for (const item of live)
        if (
          item &&
          item.type === 'content' &&
          item.content &&
          item.content.type === 'image' &&
          liveImageOk(item.content)
        )
          out.push('data:' + item.content.mimeType + ';base64,' + item.content.data);
    return out;
  }
  function thumb(src, n, cls) {
    const img = make('img');
    img.className = cls;
    img.alt = 'Tool image ' + n;
    img.loading = 'lazy';
    img.src = src;
    if (root.ImageViewer && root.ImageViewer.makeViewable) root.ImageViewer.makeViewable(img, 'Tool image ' + n);
    /* Opening the picture must never toggle the row it sits on. */
    img.addEventListener('click', (ev) => ev.stopPropagation());
    img.addEventListener('keydown', (ev) => ev.stopPropagation());
    return img;
  }
  function imageStrip(sources) {
    const strip = make('div', '', 'tool-images');
    sources.forEach((src, i) => strip.append(thumb(src, i + 1, 'message-image tool-image')));
    return strip;
  }
  /* One collapsed line; the readable detail is built lazily by buildDetail() when expanded. */
  function line(row, buildDetail) {
    const s = summarize(row),
      key = rowKey(row),
      box = make('div', '', 'tool-line');
    const btn = make('button', '', 'tool-toggle');
    btn.type = 'button';
    const label = make('span', s.label, 'tool-line-kind'),
      text = make('span', s.text, 'tool-line-text');
    btn.title = s.hint || s.text;
    btn.append(statusMark(s.status), label, text);
    const panel = make('div', '', 'tool-detail');
    const sync = () => {
      const open = EXPANDED.has(key);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      panel.hidden = !open;
      box.className = 'tool-line' + (open ? ' open' : '') + (s.status === 'failed' ? ' failed' : '');
      if (open && !panel.children.length) panel.append(buildDetail());
    };
    btn.addEventListener('click', () => {
      if (EXPANDED.has(key)) EXPANDED.delete(key);
      else EXPANDED.add(key);
      sync();
    });
    box.append(btn);
    sync();
    box.toolKey = key;
    box.summary = s;
    const pics = toolImages(row);
    if (pics.length) {
      const thumbs = make('div', '', 'tool-thumbs');
      pics.slice(0, 3).forEach((src, i) => thumbs.append(thumb(src, i + 1, 'tool-thumb')));
      if (pics.length > 3) thumbs.append(make('span', '+' + (pics.length - 3), 'tool-thumbs-more'));
      box.append(thumbs);
    }
    const E = root.AgentEditors,
      target = E ? fileTarget(row) : null;
    if (target) {
      /* A sibling of the toggle, so clicking it never expands the row. Hidden until an editor that can open files is known. */
      const open = make('button', 'open ↗', 'tool-open');
      open.type = 'button';
      open.dataset.line = target.line || '';
      const tip = E.fileTip ? E.fileTip(target.line) : 'Open in editor';
      open.title = tip;
      open.setAttribute('aria-label', tip);
      open.hidden = !(E.canOpenFile && E.canOpenFile());
      open.addEventListener('click', (ev) => {
        ev.stopPropagation();
        E.openFile(target.path, target.line);
      });
      box.append(open);
    }
    box.append(panel); // last: Tab reaches "open ↗" (and thumbnails) before the opened detail
    return box;
  }
  const isToolRow = (r) => r && r.role === 'tool' && (r.raw || r.call);
  /* Turns rows into DOM nodes; runs of more than 3 consecutive tool rows become one "N steps" group. */
  function groupRows(rows, renderRow) {
    const out = [];
    let i = 0;
    while (i < rows.length) {
      if (!isToolRow(rows[i])) {
        out.push(renderRow(rows[i]));
        i++;
        continue;
      }
      let j = i;
      while (j < rows.length && isToolRow(rows[j])) j++;
      const run = rows.slice(i, j);
      if (run.length > 3) {
        const key = 'group:' + rowKey(run[0]),
          box = make('div', '', 'tool-group'),
          btn = make('button', '', 'tool-toggle tool-group-toggle');
        btn.type = 'button';
        const failed = run.some((r) => summarize(r).status === 'failed'),
          running = run.some((r) => summarize(r).status === 'running');
        btn.append(
          statusMark(failed ? 'failed' : running ? 'running' : ''),
          make('span', 'steps', 'tool-line-kind'),
          make('span', run.length + ' steps', ' tool-line-text'),
        );
        btn.title = run.length + ' tool calls';
        const body = make('div', '', 'tool-group-body');
        const sync = () => {
          const open = EXPANDED.has(key);
          btn.setAttribute('aria-expanded', open ? 'true' : 'false');
          body.hidden = !open;
          box.className = 'tool-group' + (open ? ' open' : '');
          if (open && !body.children.length) for (const r of run) body.append(renderRow(r));
        };
        btn.addEventListener('click', () => {
          if (EXPANDED.has(key)) EXPANDED.delete(key);
          else EXPANDED.add(key);
          sync();
        });
        box.append(btn, body);
        sync();
        out.push(box);
      } else for (const r of run) out.push(renderRow(r));
      i = j;
    }
    return out;
  }
  function render(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    const kind = KINDS.includes(raw.kind) ? raw.kind : 'other',
      status = STATUSES.includes(raw.status) ? raw.status : raw.status ? 'other' : 'pending';
    const box = make('div', '', 'tool-view tool-kind-' + kind);
    const head = make('div', '', 'tool-head');
    head.append(
      make('span', kind, 'tool-kind'),
      make('strong', raw.title || raw.toolCallId || 'Tool call', 'tool-title'),
      make('span', String(raw.status || 'pending').replace('_', ' '), 'tool-status status-' + status),
    );
    box.append(head);
    if (Array.isArray(raw.locations) && raw.locations.length) {
      const l = locationsView(raw.locations);
      if (l) box.append(l);
    }
    const hasDiff = Array.isArray(raw.content) && raw.content.some((i) => i && i.type === 'diff'),
      input = asObject(raw.rawInput);
    if (input && Object.keys(input).length) box.append(body(analyze(toolNameOf(raw), input), { skipDiff: hasDiff }));
    if (Array.isArray(raw.content))
      for (const item of raw.content) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'diff') box.append(diffView(item));
        else if (item.type === 'terminal')
          box.append(make('div', 'Terminal ' + String(item.terminalId || ''), 'tool-terminal'));
        else if (item.type === 'content') box.append(contentBlock(item.content));
      }
    if (input && !(Array.isArray(raw.content) && raw.content.some((i) => i && i.type === 'content'))) {
      const r = resultView(outputText(raw), raw.status === 'failed');
      if (r) box.append(r);
    }
    const rawBox = make('details', '', 'tool-raw');
    rawBox.append(make('summary', 'Raw JSON'), make('pre', JSON.stringify(raw, null, 2).slice(0, 40000)));
    box.append(rawBox);
    return box;
  }
  root.ToolViews = {
    fileTarget,
    line,
    groupRows,
    setScope,
    summarize,
    commandSummary,
    render,
    renderCall,
    pairSaved,
    callMarkdown,
    rawMarkdown,
    analyze,
    codeBlock,
    kvView,
    highlight,
    tokenize,
    diffView,
    lineDiff,
    contentBlock,
    filePath,
    langFromPath,
    fence,
  };
})(typeof window !== 'undefined' ? window : globalThis);

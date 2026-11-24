/* Composer attachments beyond pictures: classification and limits (mirroring studio.py), capability checks against the
   agent's promptCapabilities, drag-and-drop, retry fingerprints, wire blocks, and file cards. Names and file text come
   from untrusted files and are only ever inserted with textContent. */
(function (root) {
  'use strict';
  const MiB = 1048576;
  const LIMITS = {
    images: 4,
    imageBytes: 5 * MiB,
    imageTotal: 15 * MiB,
    files: 8,
    textBytes: 2 * MiB,
    binaryBytes: 10 * MiB,
    total: 20 * MiB,
    nameChars: 200,
  };
  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  const TEXT_MIME_EXACT = new Set([
    'application/json',
    'application/xml',
    'application/javascript',
    'application/x-javascript',
    'application/ecmascript',
    'application/typescript',
    'application/x-typescript',
    'application/yaml',
    'application/x-yaml',
    'application/toml',
    'application/sql',
    'application/x-sql',
    'application/x-sh',
    'application/x-httpd-php',
    'application/xhtml+xml',
    'application/x-ndjson',
    'application/csv',
    'application/x-python',
    'application/x-python-code',
    'application/x-ruby',
  ]);
  const NEUTRAL = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
  const BINARY_ONLY = new Set([
    'application/pdf',
    'application/zip',
    'application/gzip',
    'application/x-tar',
    'application/x-7z-compressed',
    'application/x-rar-compressed',
    'application/vnd.rar',
  ]);
  const TEXT_EXT = {
    txt: 'text/plain',
    text: 'text/plain',
    log: 'text/plain',
    md: 'text/markdown',
    markdown: 'text/markdown',
    json: 'application/json',
    jsonl: 'application/x-ndjson',
    ndjson: 'application/x-ndjson',
    csv: 'text/csv',
    tsv: 'text/tab-separated-values',
    py: 'text/x-python',
    js: 'text/javascript',
    mjs: 'text/javascript',
    cjs: 'text/javascript',
    ts: 'text/typescript',
    tsx: 'text/typescript',
    jsx: 'text/javascript',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    toml: 'application/toml',
    xml: 'application/xml',
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    sql: 'application/sql',
    sh: 'application/x-sh',
    ini: 'text/plain',
    cfg: 'text/plain',
    conf: 'text/plain',
    env: 'text/plain',
    rs: 'text/x-rust',
    go: 'text/x-go',
    java: 'text/x-java',
    c: 'text/x-c',
    h: 'text/x-c',
    cpp: 'text/x-c++',
    hpp: 'text/x-c++',
    cs: 'text/x-csharp',
    rb: 'text/x-ruby',
    php: 'text/x-php',
    swift: 'text/x-swift',
    kt: 'text/x-kotlin',
    ps1: 'text/plain',
    bat: 'text/plain',
    svg: 'image/svg+xml',
    diff: 'text/x-diff',
    patch: 'text/x-diff',
    tex: 'text/x-tex',
    rst: 'text/x-rst',
  };
  const BINARY_EXT = {
    pdf: 'application/pdf',
    zip: 'application/zip',
    gz: 'application/gzip',
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
  };
  const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
  let features = {};
  const make = (tag, value, cls) => {
    const node = document.createElement(tag);
    if (value !== undefined && value !== null) node.textContent = String(value);
    if (cls) node.className = cls;
    return node;
  };
  const formatSize = (n) =>
    !Number.isFinite(n) || n < 0
      ? ''
      : n < 1024
        ? n + ' B'
        : n < MiB
          ? (n / 1024).toFixed(1) + ' KB'
          : (n / MiB).toFixed(1) + ' MB';
  const extension = (name) => {
    const base = String(name).replace(/^\.+/, '');
    const i = base.lastIndexOf('.');
    return i < 0 ? '' : base.slice(i + 1).toLowerCase();
  };
  const isTextMime = (m) =>
    m.startsWith('text/') || TEXT_MIME_EXACT.has(m) || m.endsWith('+json') || m.endsWith('+xml');
  function normalMime(value) {
    const mime = String(value || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    return !mime || MIME.test(mime) ? mime : null;
  }
  const ODD_RANGES = [
    [0, 31],
    [127, 159],
    [173, 173],
    [0x200b, 0x200f],
    [0x2028, 0x202e],
    [0x2060, 0x206f],
    [0xfeff, 0xfeff],
    [0xd800, 0xdfff],
    [0xe000, 0xf8ff],
  ];
  const isOddChar = (ch) => {
    const code = ch.codePointAt(0);
    return ODD_RANGES.some(([a, b]) => code >= a && code <= b);
  };
  /* Returns '' when the name is acceptable as a display label, otherwise the reason. */
  function nameProblem(name) {
    if (typeof name !== 'string' || !name.trim()) return 'file has no name';
    if (name.length > LIMITS.nameChars) return 'name is longer than ' + LIMITS.nameChars + ' characters';
    if (name !== name.trim() || /^\.+$/.test(name) || name.endsWith('.'))
      return 'name has leading/trailing space or dots';
    if ([...name].some(isOddChar)) return 'name contains control, invisible or direction-changing characters';
    if (/[\/\\:<>"|?*]/.test(name)) return 'name must not contain path separators or any of : < > " | ? *';
    return '';
  }
  function decodeText(bytes) {
    if (bytes.includes(0)) return null;
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      return null;
    }
  }
  /* Same rules as classify_file in studio.py: kind is 'image' | 'text' | 'audio' | 'binary'. */
  function classify(name, declared, bytes) {
    const mime = normalMime(declared);
    if (mime === null) return { error: 'not a valid file type' };
    if (IMAGE_TYPES.has(mime)) return { kind: 'image', mime };
    const ext = extension(name),
      major = mime.split('/')[0];
    const couldBeText =
      mime === 'image/svg+xml' ||
      (!BINARY_ONLY.has(mime) &&
        !['image', 'audio', 'video', 'font'].includes(major) &&
        (isTextMime(mime) || (NEUTRAL.has(mime) && !(ext in BINARY_EXT)) || ext in TEXT_EXT));
    if (couldBeText && decodeText(bytes) !== null)
      return {
        kind: 'text',
        mime: isTextMime(mime) || mime === 'image/svg+xml' ? mime : TEXT_EXT[ext] || 'text/plain',
      };
    const finalMime = !mime || NEUTRAL.has(mime) ? BINARY_EXT[ext] || 'application/octet-stream' : mime;
    return { kind: finalMime.startsWith('audio/') ? 'audio' : 'binary', mime: finalMime };
  }
  /* Why the agent cannot take this kind of file, or ''. Text can always go inline; binary needs embedded context. */
  function capabilityProblem(kind, mime, name, caps) {
    const c = caps || {};
    if (kind === 'image')
      return c.image === true ? '' : name + ': this agent does not support image input (promptCapabilities.image).';
    if (kind === 'text') return '';
    if (kind === 'audio')
      return c.audio === true || c.embeddedContext === true
        ? ''
        : name +
            ': this agent supports neither audio input (promptCapabilities.audio) nor embedded context (promptCapabilities.embeddedContext), so it cannot take audio files.';
    return c.embeddedContext === true
      ? ''
      : name +
          ': this agent does not support embedded context (promptCapabilities.embeddedContext), so it cannot take ' +
          (mime || 'binary') +
          ' files. Text files can still be attached.';
  }
  function sizeProblem(kind, size, name) {
    if (!Number.isFinite(size) || size < 1) return name + ': file is empty';
    if (kind === 'text' && size > LIMITS.textBytes) return name + ': text file is larger than 2 MiB';
    if (kind !== 'text' && size > LIMITS.binaryBytes) return name + ': file is larger than 10 MiB';
    return '';
  }
  /* Count and total limits against what is already in the composer. */
  function limitProblem(existing, kind, size, name) {
    const files = existing.filter((item) => item.kind === 'file').length;
    if (kind !== 'image' && files >= LIMITS.files) return name + ': maximum ' + LIMITS.files + ' files';
    if (existing.reduce((sum, item) => sum + item.file.size, 0) + size > LIMITS.total)
      return name + ': total attachments would exceed 20 MiB';
    return '';
  }
  const readBytes = async (file) => new Uint8Array(await file.arrayBuffer());
  /* host: {store: Map, caps(), key(), features, addImage(files,key), refresh(key), note(text)} */
  async function addFiles(files, key, host) {
    if (!key || !host) return;
    const rejected = [],
      feature = features.fileAttachments === true;
    const prepared = [];
    for (const file of files) {
      const name = file.name || '';
      const bad = nameProblem(name);
      if (bad) {
        rejected.push((name || 'file') + ': ' + bad);
        continue;
      }
      if (file.size > LIMITS.binaryBytes) {
        rejected.push(name + ': file is larger than 10 MiB');
        continue;
      }
      const mime = normalMime(file.type);
      if (IMAGE_TYPES.has(mime)) {
        prepared.push({ file, kind: 'image', mime });
        continue;
      }
      if (!feature) {
        rejected.push(name + ': this AIB server does not support file attachments');
        continue;
      }
      if (!Number.isFinite(file.size) || file.size < 1) {
        rejected.push(name + ': file is empty');
        continue;
      }
      let result;
      try {
        result = classify(name, file.type, await readBytes(file));
      } catch {
        rejected.push(name + ': the browser could not read this file');
        continue;
      }
      if (result.error) {
        rejected.push(name + ': ' + result.error);
        continue;
      }
      prepared.push({ file, ...result });
    }
    const caps = host.caps() || {};
    for (const entry of prepared) {
      const { file, kind, mime } = entry,
        name = file.name;
      const problem =
        capabilityProblem(kind, mime, name, caps) ||
        sizeProblem(kind, file.size, name) ||
        limitProblem(host.store.get(key) || [], kind, file.size, name);
      if (problem) {
        rejected.push(problem);
        continue;
      }
      if (kind === 'image') {
        host.addImage([file], key);
        continue;
      }
      const items = (host.store.get(key) || []).slice();
      items.push({
        id: 'file-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2),
        kind: 'file',
        fileKind: kind,
        mime,
        file,
        name,
      });
      host.store.set(key, items);
    }
    host.refresh(key);
    if (rejected.length) host.note(rejected.join(' · '));
  }
  /* Retry IDs: a hash over every attachment's kind, name, type, size and bytes, so a changed set can never reuse an ID. */
  async function fingerprint(items) {
    if (!items.length) return '';
    if (!globalThis.crypto?.subtle)
      throw Error('Secure retry IDs are unavailable in this browser. Remove the attachments to send text only.');
    const encoder = new TextEncoder(),
      parts = [];
    for (const item of items) {
      const data = new Uint8Array(await item.file.arrayBuffer()),
        isFile = item.kind === 'file';
      const head = encoder.encode(
        JSON.stringify([
          isFile ? 'file' : 'image',
          isFile ? item.name : '',
          isFile ? item.mime : item.file.type,
          data.length,
        ]),
      );
      const length = new Uint8Array(4);
      new DataView(length.buffer).setUint32(0, head.length);
      parts.push(length, head, data);
    }
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('');
  }
  function base64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }
  function blocks(items) {
    return Promise.all(
      items.map(async (item) => {
        const data = base64(new Uint8Array(await item.file.arrayBuffer()));
        return item.kind === 'file'
          ? { type: 'file', name: item.name, mimeType: item.mime, data }
          : { type: 'image', mimeType: item.file.type, data };
      }),
    );
  }
  function note({ imageFeature, snapshot, hasItems }) {
    if (!imageFeature) return 'This AIB server does not support attachments.';
    const caps = snapshot?.promptCapabilities || {},
      sends = [];
    sends.push(
      caps.embeddedContext ? 'Text files are sent as embedded context' : 'Text files are sent inline as quoted text',
    );
    sends.push(
      caps.embeddedContext
        ? 'PDFs and other binary files are sent as embedded resources'
        : 'This agent cannot take PDFs or other binary files',
    );
    if (caps.audio) sends.push('audio is sent as audio');
    sends.push(caps.image ? 'pictures are sent as images' : 'this agent does not support pictures');
    return (
      'Attachments stay in this tab until sent or removed. Up to 8 files and 4 pictures, 20 MiB total (text 2 MiB, binary 10 MiB, pictures 5 MiB each). ' +
      sends.join('; ') +
      '. Drop, paste or use ＋ Attach.'
    );
  }
  /* The square tile shown in the composer for a non-image file. */
  function fileBadge(item) {
    const tile = make('div', '', 'file-badge');
    const ext = extension(item.name);
    tile.append(
      make('strong', (ext || item.fileKind || 'file').slice(0, 5).toUpperCase(), 'file-badge-ext'),
      make('small', formatSize(item.file.size), 'file-badge-size'),
    );
    tile.title = item.name + ' · ' + item.mime + ' · ' + formatSize(item.file.size);
    return tile;
  }
  /* A file card inside a sent message. summary comes from the server's user event. */
  function messageCard(summary) {
    const box = make('div', '', 'file-card');
    const label = ['embedded', 'inline', 'audio'].includes(summary.mode)
      ? { embedded: 'sent as embedded context', inline: 'sent inline as text', audio: 'sent as audio' }[summary.mode]
      : '';
    const head = make('div', '', 'file-card-head');
    head.append(
      make('strong', summary.name, 'file-card-name'),
      make('span', [summary.mimeType, formatSize(summary.size), label].filter(Boolean).join(' · '), 'file-card-meta'),
    );
    box.append(head);
    if (typeof summary.preview === 'string' && summary.preview) {
      const details = make('details', '', 'file-card-body'),
        pre = make('pre', summary.preview);
      details.append(
        make(
          'summary',
          'Show content' + (summary.truncated ? ' (first ' + summary.preview.length + ' characters)' : ''),
        ),
        pre,
      );
      box.append(details);
    }
    return box;
  }
  function eventFiles(data) {
    return Array.isArray(data?.files)
      ? data.files
          .filter((f) => f && typeof f.name === 'string')
          .slice(0, LIMITS.files)
          .map((f) => ({ ...f, type: 'studio_file' }))
      : [];
  }
  function wireDrop(target, host) {
    if (!target || !target.addEventListener) return;
    const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');
    let depth = 0;
    const clear = () => {
      depth = 0;
      target.classList.remove('drop-target');
    };
    target.addEventListener('dragenter', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth++;
      target.classList.add('drop-target');
    });
    target.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });
    target.addEventListener('dragleave', (event) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) target.classList.remove('drop-target');
    });
    target.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      clear();
      const key = host.key(),
        files = [...(event.dataTransfer.files || [])];
      if (!key || !host.available()) {
        host.note('Open and connect to a conversation before attaching files.');
        return;
      }
      if (files.length) addFiles(files, key, host);
    });
  }
  root.AttachmentsUI = {
    LIMITS,
    setFeatures: (value) => {
      features = value || {};
    },
    nameProblem,
    classify,
    capabilityProblem,
    sizeProblem,
    limitProblem,
    addFiles,
    fingerprint,
    blocks,
    note,
    fileBadge,
    messageCard,
    eventFiles,
    wireDrop,
    formatSize,
  };
})(window);

'use strict';
/* Artifacts (UI half): the third tab of the right column ("Activity | Changes N | Artifacts N"), a one-row viewer (picker, version chip,
   open-in-browser, a menu), stream cards for studio_artifact tool calls, the Preview button on file-write rows and the
   studio-artifact:// / source-path links in replies. Data comes from the Studio artifact routes (server/artifacts/). Pages run in a sandboxed iframe on the separate artifact origin and are view-only.
   The pure helpers at the top have node tests (work/test_artifacts_ui.js); the page part below mounts from changes-ui.js. */
(function (root) {
  const SANDBOX = 'allow-scripts allow-forms allow-popups allow-downloads';
  const FOOTER = 'Sandboxed · no access to Studio · CDN scripts only';
  const num = (v) => Math.max(0, Number(v) || 0);
  const MINUS = '−';

  /* ---- kinds ---------------------------------------------------------------------------------------------------------- */
  const KINDS = {
    html: { badge: 'html', name: 'HTML page' },
    svg: { badge: 'svg', name: 'SVG image' },
    md: { badge: 'md', name: 'Markdown document' },
    image: { badge: 'img', name: 'Image' },
    pdf: { badge: 'pdf', name: 'PDF' },
    csv: { badge: 'csv', name: 'CSV table' },
    json: { badge: 'json', name: 'JSON' },
    text: { badge: 'txt', name: 'Text file' },
  };
  const kindInfo = (k) => KINDS[k] || { badge: String(k || 'file').slice(0, 4), name: 'File' };
  const EXT_KIND = {
    html: 'html',
    htm: 'html',
    svg: 'svg',
    md: 'md',
    markdown: 'md',
    png: 'image',
    jpg: 'image',
    jpeg: 'image',
    gif: 'image',
    webp: 'image',
    pdf: 'pdf',
    csv: 'csv',
    json: 'json',
    txt: 'text',
    log: 'text',
  };
  function kindOfPath(path) {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(path || ''));
    return m ? EXT_KIND[m[1].toLowerCase()] || null : null;
  }
  const isPreviewable = (path) => !!kindOfPath(path);
  /* Kinds whose text the source route can return (images and PDFs are binary). */
  const SOURCE_KINDS = ['html', 'svg', 'md', 'csv', 'json', 'text'];
  const hasSource = (kind) => SOURCE_KINDS.includes(kind);
  /* How a kind is shown: a sandboxed page, a plain PDF frame, a picture, or escaped text. */
  function viewMode(kind) {
    if (kind === 'html' || kind === 'svg' || kind === 'md') return 'page';
    if (kind === 'pdf') return 'pdf';
    if (kind === 'image') return 'image';
    return 'text';
  }
  /* The attributes of the frame that shows a kind. A page gets the sandbox (never the same-origin allowance); a PDF is shown by the
   browser's own viewer on the artifact origin, unsandboxed. */
  function frameSpec(kind) {
    const mode = viewMode(kind);
    if (mode === 'page') return { tag: 'iframe', sandbox: SANDBOX };
    if (mode === 'pdf') return { tag: 'iframe', sandbox: null };
    if (mode === 'image') return { tag: 'img', sandbox: null };
    return { tag: 'pre', sandbox: null };
  }
  /* Markdown is rendered by a small page the artifact origin serves for ?view=1. */
  function viewUrl(kind, url) {
    url = String(url || '');
    if (kind !== 'md' || !url) return url;
    const i = url.indexOf('#'),
      base = i < 0 ? url : url.slice(0, i),
      hash = i < 0 ? '' : url.slice(i);
    return base + (base.includes('?') ? '&' : '?') + 'view=1' + hash;
  }
  /* Keep the scroll position across a reload: the artifact origin restores "#studio-scroll=x,y". */
  function withScroll(url, scroll) {
    url = String(url || '');
    if (!url || !scroll) return url;
    const x = Math.round(num(scroll.x)),
      y = Math.round(num(scroll.y));
    if (!x && !y) return url;
    return url.replace(/#.*$/, '') + '#studio-scroll=' + x + ',' + y;
  }
  const downloadUrl = (url) => {
    url = String(url || '').replace(/#.*$/, '');
    return url + (url.includes('?') ? '&' : '?') + 'download=1';
  };
  /* Stand-in for a version url when the item route is not loaded yet: swap the /v<n>/ segment. */
  const versionUrlFrom = (url, n) => String(url || '').replace(/\/v\d+\//, '/v' + n + '/');

  /* ---- lists, times, picker -------------------------------------------------------------------------------------------- */
  /* Pinned first, then newest update first. */
  function orderArtifacts(list) {
    return (Array.isArray(list) ? list : [])
      .filter((a) => a && a.id)
      .slice()
      .sort(
        (a, b) =>
          (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
          num(b.updatedAt) - num(a.updatedAt) ||
          String(a.id).localeCompare(String(b.id)),
      );
  }
  /* updatedAt is in seconds. */
  function relTime(at, nowMs) {
    const t = Number(at);
    if (!(t > 0)) return '';
    const secs = Math.max(0, (nowMs == null ? Date.now() : nowMs) / 1000 - t);
    if (secs < 45) return 'just now';
    const mins = Math.round(secs / 60);
    if (mins < 60) return mins + ' min ago';
    const hours = Math.round(secs / 3600);
    if (hours < 24) return hours + ' h ago';
    const days = Math.round(secs / 86400);
    return days === 1 ? 'yesterday' : days + ' d ago';
  }
  /* Picker rows in two groups ("Pinned", "This chat"); an empty group is left out. */
  function pickerGroups(list, selectedId, nowMs) {
    const row = (a) => ({
      id: a.id,
      badge: kindInfo(a.kind).badge,
      title: a.title || 'Untitled',
      meta: 'v' + (num(a.version) || 1) + (relTime(a.updatedAt, nowMs) ? ' · ' + relTime(a.updatedAt, nowMs) : ''),
      pinned: !!a.pinned,
      on: a.id === selectedId,
    });
    const ordered = orderArtifacts(list),
      pinned = ordered.filter((a) => a.pinned).map(row),
      rest = ordered.filter((a) => !a.pinned).map(row);
    const groups = [];
    if (pinned.length) groups.push({ key: 'pinned', label: 'Pinned', items: pinned });
    if (rest.length) groups.push({ key: 'chat', label: 'This chat', items: rest });
    return groups;
  }
  /* One artifact: plain text, no caret. Several: a dropdown. */
  const pickerIsPlain = (list) => (Array.isArray(list) ? list.length : 0) <= 1;
  /* The version shown: the user's pick, or the latest when following. */
  const shownVersion = (latest, picked) =>
    picked != null && picked >= 1 && picked <= num(latest) ? Math.floor(picked) : Math.max(1, num(latest) || 1);
  /* The chip next to the picker: "v2 ▾", or plain "v1" when there is nothing to choose. */
  const countOf = (v) => (Array.isArray(v) ? v.length : num(v));
  function chipState(o) {
    const latest = Math.max(1, num(o && o.latest) || 1),
      count = Math.max(1, countOf(o && o.count) || latest);
    const shown = shownVersion(latest, o && o.picked),
      plain = count <= 1 && latest <= 1;
    return {
      shown,
      latest,
      plain,
      old: shown < latest,
      following: shown === latest,
      text: 'v' + shown + (plain ? '' : ' ▾'),
    };
  }
  /* "v3 is available · Switch" appears only while an older version is picked. */
  function availability(o) {
    const latest = num(o && o.latest),
      picked = o && o.picked;
    if (picked == null || !(latest > picked)) return null;
    return { text: 'v' + latest + ' is available', action: 'Switch', target: latest };
  }
  const BY = { tool: 'agent', watch: 'file change', preview: 'preview' };
  function versionRows(versions, latest, shown, nowMs) {
    return (Array.isArray(versions) ? versions : [])
      .slice()
      .sort((a, b) => num(b.n) - num(a.n))
      .map((v) => ({
        n: num(v.n),
        latest: num(v.n) === latest,
        on: num(v.n) === shown,
        label: 'v' + num(v.n),
        meta:
          [relTime(v.at, nowMs), BY[v.by] || ''].filter(Boolean).join(' · ') + (num(v.n) === latest ? ' · latest' : ''),
        note: String(v.note || ''),
      }));
  }
  /* The more menu. Only items that apply to this artifact and version are present. */
  function menuItems(o) {
    o = o || {};
    const kind = o.kind,
      shown = num(o.shown) || 1,
      latest = num(o.latest) || shown,
      mode = o.mode || 'page',
      out = [];
    if (hasSource(kind) && viewMode(kind) === 'page')
      out.push({ id: 'source', label: mode === 'source' ? 'View page' : 'View source' });
    if (shown >= 2 && hasSource(kind))
      out.push({ id: 'compare', label: mode === 'compare' ? 'Close comparison' : 'Compare with v' + (shown - 1) });
    if (shown < latest) out.push({ id: 'restore', label: 'Restore this version' });
    out.push({ sep: true });
    out.push({ id: 'pin', label: o.pinned ? 'Unpin' : 'Pin', kb: o.pinned ? '★' : '☆' });
    if (o.sourcePath && o.canEditor) out.push({ id: 'editor', label: 'Open source file in editor' });
    if (o.sourcePath) out.push({ id: 'copy', label: 'Copy path' });
    out.push({ id: 'download', label: 'Download' });
    return out.filter((it, i, a) => !(it.sep && (i === 0 || a[i - 1].sep || i === a.length - 1)));
  }

  /* ---- paths and links ------------------------------------------------------------------------------------------------ */
  /* A path a tool row names may be relative to the project folder. */
  function absolutize(path, project) {
    const p = String(path || '');
    if (!p || /^([A-Za-z]:[\\/]|[\\/]|~)/.test(p) || !project) return p;
    const root = String(project).replace(/[\\/]+$/, ''),
      sep = root.includes('\\') ? '\\' : '/';
    return root + sep + p.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep);
  }
  const norm = (p) =>
    String(p || '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();
  const sameFile = (a, b) => !!a && !!b && norm(a) === norm(b);
  /* The part of a path below the project folder, or null when it is not inside. */
  function relPath(path, project) {
    const p = String(path || ''),
      r = norm(project);
    if (!p || !r) return null;
    const n = norm(p);
    return n.startsWith(r + '/') ? p.slice(String(project).replace(/[\\/]+$/, '').length + 1) : null;
  }
  const isOutputsPath = (path, project) => {
    const rel = relPath(path, project);
    return rel !== null && /^outputs[\\/]/i.test(rel);
  };
  const flip = (p) => (p.includes('\\') ? p.replace(/\\/g, '/') : p.replace(/\//g, '\\'));
  /* Every spelling of an artifact's source file that a reply may use, longest first. */
  function pathVariants(artifact, project) {
    const src = artifact && artifact.sourcePath;
    if (!src) return [];
    const rel = relPath(src, project),
      list = [src, flip(src)];
    if (rel) {
      list.push(rel, flip(rel));
    }
    return [...new Set(list.filter((v) => v && v.length >= 4))].sort((a, b) => b.length - a.length);
  }
  const PATH_CHAR = /[A-Za-z0-9_\-\\/:.]/;
  /* Split plain text into [{t:'text',v}] and [{t:'link',v,id}] where it names an artifact's source file. */
  function linkSegments(text, artifacts, project) {
    text = String(text == null ? '' : text);
    const variants = [];
    for (const a of Array.isArray(artifacts) ? artifacts : [])
      for (const v of pathVariants(a, project)) variants.push({ v, lower: v.toLowerCase(), id: a.id });
    if (!variants.length || !text) return [{ t: 'text', v: text }];
    variants.sort((a, b) => b.v.length - a.v.length);
    const lower = text.toLowerCase(),
      out = [];
    let pos = 0;
    while (pos < text.length) {
      let best = null;
      for (const c of variants) {
        let at = lower.indexOf(c.lower, pos);
        while (at >= 0) {
          const before = at > 0 ? text[at - 1] : '',
            end = at + c.v.length,
            after = end < text.length ? text[end] : '',
            after2 = end + 1 < text.length ? text[end + 1] : '';
          const okBefore = !before || !PATH_CHAR.test(before);
          const okAfter =
            !after || (!/[A-Za-z0-9_\-\\/:]/.test(after) && !(after === '.' && /[A-Za-z0-9_]/.test(after2)));
          if (okBefore && okAfter) {
            if (!best || at < best.at || (at === best.at && c.v.length > best.len))
              best = { at, len: c.v.length, id: c.id };
            break;
          }
          at = lower.indexOf(c.lower, at + 1);
        }
      }
      if (!best) {
        out.push({ t: 'text', v: text.slice(pos) });
        break;
      }
      if (best.at > pos) out.push({ t: 'text', v: text.slice(pos, best.at) });
      out.push({ t: 'link', v: text.slice(best.at, best.at + best.len), id: best.id });
      pos = best.at + best.len;
    }
    return out.length ? out : [{ t: 'text', v: text }];
  }
  const hasLink = (segs) => segs.some((s) => s.t === 'link');
  /* studio-artifact://<id> -> id, else null. */
  function artifactIdFromLink(href) {
    const m = /^studio-artifact:\/\/([0-9a-f]{8,64})\/?$/i.exec(String(href || ''));
    return m ? m[1].toLowerCase() : null;
  }
  /* Text of a markdown artifact link: the agent's words, or the title when the words are empty or just the id. */
  const linkLabel = (text, id, artifact) => {
    const t = String(text || '').trim();
    return '⧉ ' + ((!t || t === id) && artifact ? artifact.title : t || 'Artifact');
  };

  /* ---- tool rows ------------------------------------------------------------------------------------------------------ */
  const asObj = (v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (typeof v === 'string') {
      try {
        const p = JSON.parse(v);
        if (p && typeof p === 'object' && !Array.isArray(p)) return p;
      } catch (e) {}
    }
    return null;
  };
  function toolNames(row) {
    const names = [];
    if (row && row.raw) {
      const r = row.raw,
        m = r._meta && r._meta.claudeCode;
      names.push(m && m.toolName, r.toolName, r.name, r.title);
    } else if (row && row.call) names.push(row.call.name, row.call.title);
    return names.filter((n) => typeof n === 'string' && n);
  }
  const isArtifactTool = (name) => /studio_artifact/i.test(String(name || ''));
  function inputOf(row) {
    if (row && row.raw) return asObj(row.raw.rawInput) || {};
    if (row && row.call) return asObj(row.call.input) || {};
    return {};
  }
  /* Every piece of text a finished call may carry its answer in. */
  function resultTexts(row) {
    const out = [];
    const take = (v) => {
      if (v == null) return;
      if (typeof v === 'string') {
        out.push(v);
        return;
      }
      if (Array.isArray(v)) {
        v.forEach(take);
        return;
      }
      if (typeof v === 'object') {
        if (typeof v.text === 'string') out.push(v.text);
        if (v.content !== undefined) take(v.content);
        if (v.structuredContent !== undefined) out.push(JSON.stringify(v.structuredContent));
        if (v.id && (v.link || v.version || v.url)) out.push(JSON.stringify(v));
      }
    };
    if (row && row.raw) {
      take(row.raw.rawOutput);
      take(row.raw.content);
    } else if (row && row.call && row.call.result)
      take(row.call.result.text !== undefined ? row.call.result.text : row.call.result);
    return out;
  }
  /* {id, version, link, url, title} from a result text (plain JSON, or JSON somewhere inside). */
  function parseResult(text) {
    const s = String(text || '');
    const tries = [s];
    const a = s.indexOf('{'),
      b = s.lastIndexOf('}');
    if (a >= 0 && b > a) tries.push(s.slice(a, b + 1));
    for (const t of tries) {
      try {
        const o = JSON.parse(t);
        if (o && typeof o === 'object') {
          if (o.id) return o;
          if (Array.isArray(o.content)) {
            for (const c of o.content) {
              const r = c && typeof c.text === 'string' ? parseResult(c.text) : null;
              if (r) return r;
            }
          }
        }
      } catch (e) {}
    }
    return null;
  }
  /* A studio_artifact tool row -> {op:'publish'|'update'|'list', input, result|null, status}; null for any other row. */
  function artifactCall(row) {
    const names = toolNames(row),
      hit = names.find(isArtifactTool);
    if (!hit) return null;
    let op = '';
    for (const n of names) {
      const m = /(publish|update|list)\s*$/i.exec(n) || /studio_artifact\W+(publish|update|list)/i.exec(n);
      if (m) {
        op = m[1].toLowerCase();
        break;
      }
    }
    if (!op) {
      const all = names.join(' ').toLowerCase();
      op = /publish/.test(all) ? 'publish' : /update/.test(all) ? 'update' : /list/.test(all) ? 'list' : '';
    }
    if (!op) return null;
    let result = null;
    for (const t of resultTexts(row)) {
      result = parseResult(t);
      if (result) break;
    }
    const raw = row && row.raw,
      status = raw
        ? raw.status || ''
        : row.call && row.call.result
          ? row.call.result.isError
            ? 'failed'
            : 'completed'
          : '';
    return { op, input: inputOf(row), result, status };
  }
  /* The card for a publish or update call, resolved against the known artifacts (live data wins over the call's own words). */
  function cardModel(call, artifacts, nowMs) {
    if (!call || (call.op !== 'publish' && call.op !== 'update')) return null;
    const input = call.input || {},
      res = call.result || {};
    const id = String(res.id || input.id || ''),
      art = id ? (artifacts || []).find((a) => a.id === id) : null;
    const kind = (art && art.kind) || res.kind || input.kind || kindOfPath(input.path || input.filename) || 'html';
    const version = num(res.version) || (art ? num(art.version) : 0) || (call.op === 'update' ? 2 : 1);
    const fresh = art && num(art.version) === version ? art.updatedAt : null;
    const info = kindInfo(kind),
      failed = call.status === 'failed';
    const parts = [info.name, 'v' + version];
    if (fresh && relTime(fresh, nowMs)) parts.push('updated ' + relTime(fresh, nowMs));
    return {
      id,
      kind,
      badge: info.badge,
      title: (art && art.title) || res.title || input.title || (failed ? 'Publish failed' : 'Artifact'),
      version,
      sub: failed ? 'The publish did not finish' : id ? parts.join(' · ') : 'Publishing…',
      diffFrom: id && version >= 2 ? version - 1 : null,
      canOpen: !!id && !failed,
    };
  }
  /* The version a write made: the first version saved at or after the write (the watcher saves it a moment later), else the
     newest one before it. Without a time (a replayed row), the n-th write card of the same file is version n. Never above latest. */
  function writtenVersion(versions, at, ordinal, latest) {
    latest = Math.max(1, num(latest) || 1);
    const t = Number(at),
      vs = (Array.isArray(versions) ? versions : [])
        .filter((v) => num(v.n) && Number(v.at) > 0)
        .sort((a, b) => num(a.n) - num(b.n));
    if (t > 0 && vs.length) {
      const after = vs.find((v) => Number(v.at) >= t - 2);
      if (after) return Math.min(latest, num(after.n));
      return Math.min(latest, num(vs[vs.length - 1].n));
    }
    if (num(ordinal)) return Math.min(latest, num(ordinal));
    return latest;
  }
  /* A file written by a tool row inside the project's outputs/ folder: the artifact the watcher made for it (if it exists yet).
     `version` is the version that write made (an old card keeps showing it), else the latest. */
  function outputsCardModel(path, artifacts, nowMs, version) {
    const art = (artifacts || []).find((a) => sameFile(a.sourcePath, path));
    if (!art) return null;
    const info = kindInfo(art.kind),
      latest = num(art.version) || 1,
      v = version >= 1 && version < latest ? Math.floor(version) : latest,
      t = v === latest ? relTime(art.updatedAt, nowMs) : '';
    return {
      id: art.id,
      kind: art.kind,
      badge: info.badge,
      title: art.title,
      version: v,
      latest,
      sub: [info.name, 'v' + v, t ? 'updated ' + t : v < latest ? 'now v' + latest : ''].filter(Boolean).join(' · '),
      diffFrom: v >= 2 ? v - 1 : null,
      canOpen: true,
    };
  }
  /* The file a Write / Edit row wrote (not Read), or null. Needs tool-views.js. */
  function writeTarget(row, TV) {
    TV = TV || root.ToolViews;
    if (!TV || !row) return null;
    try {
      const s = TV.summarize(row);
      if (s.label !== 'write' && s.label !== 'edit') return null;
      if (s.status === 'failed') return null;
      const t = TV.fileTarget(row);
      return t && t.path ? t.path : null;
    } catch (e) {
      return null;
    }
  }
  /* Does a live event suggest the artifact list changed? A pushed artifact event, the end of a turn, a finished studio_artifact call or a finished edit. */
  function artifactEvent(e) {
    if (!e || typeof e !== 'object') return null;
    if (e.type === 'artifact' || e.kind === 'artifact') {
      const s = e.artifact || (e.data && e.data.artifact);
      if (s && s.id) return { conversationId: e.conversationId || (e.data && e.data.conversationId) || '', summary: s };
    }
    return null;
  }
  function eventHintsArtifact(e) {
    if (!e || typeof e !== 'object') return false;
    if (artifactEvent(e)) return true;
    if (e.kind === 'turn_end') return true;
    const u = e.data && e.data.update;
    if (!u || (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update')) return false;
    if (u.status && u.status !== 'completed') return false;
    if (u.kind === 'edit') return true;
    try {
      return /studio_artifact/i.test(JSON.stringify([u.title, u.toolName, u._meta, u.rawInput]).slice(0, 3000));
    } catch (x) {
      return false;
    }
  }

  /* Left edge of a popover anchored at `left`: moved left as far as needed to stay inside a view `width` wide (4 px margins). */
  const placeLeft = (left, popWidth, width) => Math.max(4, Math.min(num(left), num(width) - num(popWidth) - 4));

  /* ---- unified diff -> hunks ------------------------------------------------------------------------------------------- */
  /* [{name, hunks:[{header, lines:[' ctx','+add','-del','\\ note']}]}] */
  function parseUnifiedDiff(text) {
    const files = [];
    let file = null,
      hunk = null;
    const start = (name) => {
      file = { name: name || '', hunks: [] };
      files.push(file);
      hunk = null;
    };
    const rows = String(text || '')
      .replace(/\r\n?/g, '\n')
      .split('\n');
    if (rows.length && rows[rows.length - 1] === '') rows.pop();
    for (let i = 0; i < rows.length; i++) {
      const line = rows[i];
      if (line.startsWith('diff ')) {
        start('');
        continue;
      }
      /* "--- a/x" + "+++ b/x" + "@@" is a file header, even in the middle of a hunk. */
      if (line.startsWith('--- ') && /^\+\+\+ /.test(rows[i + 1] || '') && (rows[i + 2] || '').startsWith('@@')) {
        if (!file || file.hunks.length) start('');
        file.name = rows[i + 1].slice(4).replace(/^b\//, '').replace(/\t.*$/, '');
        hunk = null;
        i++;
        continue;
      }
      if (line.startsWith('@@')) {
        if (!file) start('');
        hunk = { header: line, lines: [] };
        file.hunks.push(hunk);
        continue;
      }
      if (!hunk) continue;
      const c = line.charAt(0);
      if (c === ' ' || c === '+' || c === '-' || c === '\\') hunk.lines.push(line);
      else if (line === '') hunk.lines.push(' ');
    }
    return files.filter((f) => f.hunks.length);
  }
  const diffStats = (files) => {
    let add = 0,
      del = 0;
    for (const f of files)
      for (const h of f.hunks)
        for (const l of h.lines) {
          if (l[0] === '+') add++;
          else if (l[0] === '-') del++;
        }
    return { added: add, removed: del };
  };

  const pure = {
    SANDBOX,
    FOOTER,
    KINDS,
    kindInfo,
    kindOfPath,
    isPreviewable,
    hasSource,
    viewMode,
    frameSpec,
    viewUrl,
    withScroll,
    downloadUrl,
    versionUrlFrom,
    orderArtifacts,
    relTime,
    pickerGroups,
    pickerIsPlain,
    shownVersion,
    chipState,
    availability,
    versionRows,
    menuItems,
    absolutize,
    norm,
    sameFile,
    relPath,
    isOutputsPath,
    pathVariants,
    linkSegments,
    fileSegments,
    hasLink,
    artifactIdFromLink,
    linkLabel,
    artifactCall,
    parseResult,
    cardModel,
    outputsCardModel,
    writtenVersion,
    placeLeft,
    writeTarget,
    artifactEvent,
    eventHintsArtifact,
    parseUnifiedDiff,
    diffStats,
  };

  /* ---- page part ------------------------------------------------------------------------------------------------------- */
  let win = root,
    doc = typeof document !== 'undefined' ? document : null;
  const S = {
    chat: { id: '', busy: false, cwd: '' },
    list: [],
    extras: {},
    items: {},
    selId: '',
    picked: null,
    userPicked: false,
    mode: 'page',
    cmp: null,
    visible: false,
    dirty: true,
    origin: '',
    token: '',
    mounted: false,
    listSeq: 0,
    loading: false,
    failUntil: 0,
    listTimer: 0,
    scroll: null,
    scrollFor: '',
    renderSeq: 0,
    stageKey: '',
    reloadPending: false,
    fresh: '',
  };
  let ui = null;
  const el = (tag, cls, txt) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };
  const q = (o) =>
    Object.entries(o)
      .map(([k, v]) => k + '=' + encodeURIComponent(v))
      .join('&');
  const ordered = () => orderArtifacts(S.list);
  const known = (id) => S.list.find((a) => a.id === id) || S.extras[id] || null;
  const current = () => known(S.selId);
  const editors = () => {
    const e = win.AgentEditors;
    return e && typeof e.openFile === 'function' && (typeof e.canOpenFile !== 'function' || e.canOpenFile()) ? e : null;
  };

  async function getToken(force) {
    if (S.token && !force) return S.token;
    const r = await win.fetch('/api/live/bootstrap');
    if (!r.ok) throw new Error('Studio is not reachable');
    const b = await r.json();
    S.token = b.token || '';
    if (b.artifactOrigin) S.origin = b.artifactOrigin;
    return S.token;
  }
  async function api(path, body, retry) {
    const t = await getToken(!!retry),
      init = { headers: { 'X-Studio-Token': t } };
    if (body !== undefined) {
      init.method = 'POST';
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const r = await win.fetch(path, init);
    if (r.status === 403 && !retry) return api(path, body, true);
    let data = {};
    try {
      data = await r.json();
    } catch (e) {}
    if (!r.ok) {
      const e = new Error(data.error || 'Request failed (' + r.status + ')');
      e.status = r.status;
      throw e;
    }
    return data;
  }

  /* -- list and live updates -- */
  /* The viewer shows the first artifact (pinned first, then newest) when it shows nothing yet. While you can see it, it never jumps
     on its own (QA m2): a new artifact is announced in a quiet "New: <title> · Open" bar instead. Out of sight and untouched, it
     still follows the newest one. */
  const following = () => !S.visible && !S.userPicked && S.mode === 'page';
  function setList(next) {
    const before = new Set(S.list.map((a) => a.id));
    S.list = orderArtifacts(next);
    const first = (S.list[0] && S.list[0].id) || '';
    const added = before.size ? S.list.filter((a) => !before.has(a.id)) : [];
    if (!known(S.selId) || (following() && S.selId !== first && !S.extras[S.selId])) {
      if (S.selId !== first) {
        S.selId = first;
        S.picked = null;
        S.mode = 'page';
        S.cmp = null;
        S.dirty = true;
      }
    } else if (added.length) {
      const newest = added.slice().sort((a, b) => num(b.updatedAt) - num(a.updatedAt))[0];
      if (newest.id !== S.selId) S.fresh = newest.id;
    }
    if (S.fresh && (S.fresh === S.selId || !known(S.fresh))) S.fresh = '';
    paintCount();
    relinkAll();
    refreshCards();
    paintAll();
    if (S.dirty) paintStage('auto');
  }
  function upsert(summary) {
    if (!summary || !summary.id) return;
    const inList = S.list.findIndex((a) => a.id === summary.id),
      old = inList < 0 ? S.extras[summary.id] : S.list[inList];
    const next = Object.assign({}, old, summary);
    const versionChanged = !!old && num(old.version) !== num(next.version);
    if (versionChanged) delete S.items[summary.id];
    if (versionChanged) holdCompare(summary.id);
    if (inList < 0 && S.extras[summary.id]) {
      S.extras[summary.id] = next;
      paintAll();
      refreshCards();
      if (summary.id === S.selId && versionChanged && S.picked == null) paintStage('update');
      return;
    }
    const list = S.list.slice();
    if (inList < 0) list.push(next);
    else list[inList] = next;
    setList(list);
    if (summary.id === S.selId && versionChanged && S.picked == null) paintStage('update');
  }
  /* A comparison that was open stays on its two versions when a newer one arrives: "vN is available · Switch" offers the new one. */
  function holdCompare(id) {
    if (id !== S.selId || S.mode !== 'compare' || !S.cmp || S.picked != null) return;
    S.picked = num(S.cmp.to) || null;
  }
  async function loadList() {
    if (!S.mounted || !S.chat.id || S.loading || Date.now() < S.failUntil) return;
    const mine = ++S.listSeq,
      id = S.chat.id;
    S.loading = true;
    try {
      const d = await api('/api/live/artifacts?' + q({ conversationId: id }));
      if (mine !== S.listSeq || id !== S.chat.id) return;
      const prior = S.list.map((a) => a.id + ':' + a.version + ':' + (a.pinned ? 1 : 0) + ':' + a.title).join('|');
      const next = Array.isArray(d.artifacts) ? d.artifacts : [];
      const sel = current();
      const cur = sel && next.find((a) => a.id === sel.id);
      if (next.map((a) => a.id + ':' + a.version + ':' + (a.pinned ? 1 : 0) + ':' + a.title).join('|') !== prior) {
        const versionChanged = !!cur && num(cur.version) !== num(sel.version);
        if (versionChanged) delete S.items[cur.id];
        if (versionChanged) holdCompare(cur.id);
        setList(next);
        if (versionChanged && S.picked == null) paintStage('update');
      }
      schedule();
    } catch (e) {
      if (mine !== S.listSeq || id !== S.chat.id) return;
      S.failUntil = Date.now() + (e.status === 404 ? 60000 : 15000);
    } finally {
      if (mine === S.listSeq) S.loading = false;
    }
  }
  let hintTimer = 0;
  function scheduleList() {
    if (!S.mounted || hintTimer) return;
    hintTimer = win.setTimeout(() => {
      hintTimer = 0;
      loadList();
    }, 800);
  }
  /* chat.js feeds every batch of new live events here. */
  function onEvents(evs, convId) {
    if (!S.mounted || !Array.isArray(evs) || !evs.length) return;
    let hint = false;
    for (const e of evs) {
      const a = artifactEvent(e);
      if (a) {
        if (!a.conversationId || a.conversationId === S.chat.id || a.conversationId === convId) upsert(a.summary);
        continue;
      }
      if (eventHintsArtifact(e)) hint = true;
    }
    if (hint) scheduleList();
  }
  /* The page may not be able to push: poll every 3 s, but only while a chat that has artifacts is on screen. */
  const POLL_MS = 3000;
  function schedule() {
    const want = S.mounted && !!S.chat.id && S.list.length > 0;
    if (want && !S.listTimer)
      S.listTimer = win.setInterval(() => {
        if (doc.hidden) return;
        if (S.list.length) loadList();
        else schedule();
      }, POLL_MS);
    else if (!want && S.listTimer) {
      win.clearInterval(S.listTimer);
      S.listTimer = 0;
    }
  }
  function sync(ctx) {
    if (!S.mounted) return;
    const id = (ctx && ctx.id) || '',
      busy = !!(ctx && ctx.busy),
      changed = id !== S.chat.id,
      ended = S.chat.busy && !busy;
    S.chat = { id, busy, cwd: (ctx && ctx.cwd) || '' };
    if (changed) {
      S.listSeq++;
      S.loading = false;
      S.list = [];
      S.extras = {};
      S.items = {};
      S.selId = '';
      S.picked = null;
      S.userPicked = false;
      S.mode = 'page';
      S.cmp = null;
      S.failUntil = 0;
      S.dirty = true;
      S.stageKey = '';
      S.fresh = '';
      closePop();
      paintCount();
      paintAll();
      refreshCards();
      if (id) loadList();
    } else if (ended && id) loadList();
    schedule();
  }
  function setVisible(v) {
    v = !!v;
    const was = S.visible;
    S.visible = v;
    if (v && !was) {
      if (S.dirty) paintStage('show');
    }
    if (!v && was) closePop();
  }
  function shown() {
    if (S.chat.id) loadList();
    S.dirty = true;
    paintAll();
  }

  /* -- selecting and opening -- */
  async function loadItem(id) {
    const sum = known(id);
    if (!sum) return null;
    const have = S.items[id];
    if (have && num(have.version) === num(sum.version) && Array.isArray(have.versions)) return have;
    try {
      const it = await api('/api/live/artifacts/item?' + q({ id }));
      S.items[id] = it;
      return it;
    } catch (e) {
      return have || null;
    }
  }
  /* Open an artifact in the viewer and make sure the column shows it. opts: {version, compare:{from,to}} */
  async function open(id, opts) {
    opts = opts || {};
    id = String(id || '');
    if (!id || !S.mounted) return false;
    if (!known(id)) {
      try {
        const it = await api('/api/live/artifacts/item?' + q({ id })),
          vs = Array.isArray(it.versions) ? it.versions : [];
        S.extras[id] = {
          id,
          title: it.title,
          kind: it.kind,
          version: vs.length ? Math.max(...vs.map((v) => num(v.n))) : 1,
          versions: vs.length || 1,
          updatedAt: it.updatedAt,
          pinned: !!it.pinned,
          sourcePath: it.sourcePath || null,
          conversationId: it.conversationId,
          url: it.url,
        };
        S.items[id] = it;
      } catch (e) {
        note('That artifact could not be found.');
        return false;
      }
    }
    S.selId = id;
    S.userPicked = true;
    if (S.fresh === id) S.fresh = '';
    S.mode = 'page';
    S.cmp = null;
    const latest = num(known(id).version) || 1;
    S.picked = opts.version && opts.version < latest ? opts.version : null;
    if (opts.compare) {
      S.mode = 'compare';
      S.cmp = { from: num(opts.compare.from), to: num(opts.compare.to) };
      if (S.cmp.to < latest && S.picked == null) S.picked = S.cmp.to;
    }
    S.dirty = true;
    S.stageKey = '';
    if (ui) ui.reveal();
    paintAll();
    paintStage('open');
    return true;
  }
  function selectArtifact(id) {
    if (S.fresh === id) S.fresh = '';
    if (id === S.selId) return;
    S.selId = id;
    S.userPicked = true;
    S.picked = null;
    S.mode = 'page';
    S.cmp = null;
    S.scroll = null;
    S.dirty = true;
    S.stageKey = '';
    paintAll();
    paintStage('open');
  }
  function selectVersion(n) {
    const latest = num((current() || {}).version) || 1;
    S.picked = n >= latest ? null : n;
    S.cmp = null;
    if (S.mode === 'compare' && shownVersion(latest, S.picked) < 2) S.mode = 'page';
    S.dirty = true;
    paintAll();
    paintStage('open');
  }

  /* -- note line -- */
  let noteTimer = 0;
  function note(msg) {
    if (!ui) return;
    ui.note.textContent = msg || '';
    ui.note.hidden = !msg;
    if (noteTimer) win.clearTimeout(noteTimer);
    if (msg)
      noteTimer = win.setTimeout(() => {
        ui.note.hidden = true;
      }, 5000);
  }

  /* -- painting: tab badge, toolbar, banner -- */
  function paintCount() {
    if (!ui) return;
    const n = S.list.length;
    ui.badge.textContent = n > 99 ? '99+' : String(n);
    ui.badge.hidden = !n;
    ui.tab.setAttribute('aria-label', 'Artifacts' + (n ? ', ' + n + (n === 1 ? ' artifact' : ' artifacts') : ''));
  }
  function paintBar() {
    if (!ui) return;
    const a = current(),
      none = !a;
    ui.bar.hidden = none;
    ui.foot.hidden = none || S.mode !== 'page' || viewMode(a.kind) !== 'page'; // the sandbox line is about the page view (QA c6)
    ui.stage.hidden = none; // the empty text starts at the top, no blank band above it (QA c3)
    ui.empty.hidden = !none;
    if (none) {
      ui.avail.hidden = true;
      ui.fresh.hidden = true;
      return;
    }
    const plain = pickerIsPlain(S.list.length ? S.list : [a]);
    ui.pick.replaceChildren(
      el('span', 'ar-k', kindInfo(a.kind).badge),
      el('span', 'ar-pick-title', a.title || 'Untitled'),
    );
    if (!plain) ui.pick.append(el('span', 'ar-caret', '▾'));
    ui.pick.disabled = plain;
    ui.pick.classList.toggle('plain', plain);
    ui.pick.title = a.title || '';
    ui.pick.setAttribute('aria-haspopup', plain ? 'false' : 'menu');
    const c = chipState({ latest: a.version, count: a.versions, picked: S.picked });
    ui.ver.textContent = c.text;
    ui.ver.disabled = c.plain;
    ui.ver.classList.toggle('plain', c.plain);
    ui.ver.classList.toggle('old', c.old);
    ui.ver.title = c.old ? 'Viewing an older version' : c.plain ? 'Version 1' : 'Choose a version';
    ui.ver.setAttribute('aria-haspopup', c.plain ? 'false' : 'menu');
    const av = availability({ latest: a.version, picked: S.picked });
    ui.avail.hidden = !av;
    if (av) {
      ui.availText.textContent = av.text + ' · ';
      ui.switchBtn.textContent = av.action;
    }
    const fresh = S.fresh ? known(S.fresh) : null;
    ui.fresh.hidden = !fresh;
    if (fresh) ui.freshText.textContent = 'New: ' + (fresh.title || 'Untitled') + ' · ';
    ui.more.setAttribute('aria-label', 'More');
  }
  function paintAll() {
    paintCount();
    paintBar();
  }

  /* -- stage -- */
  function setStage(node) {
    if (!ui) return;
    ui.stage.replaceChildren(node);
    ui.frame = null;
  }
  function frameUrlFor(a, n) {
    const item = S.items[a.id],
      latest = num(a.version) || 1;
    if (n >= latest) {
      return (item && item.url) || a.url || '';
    }
    const v = item && Array.isArray(item.versions) ? item.versions.find((x) => num(x.n) === n) : null;
    return (v && v.url) || versionUrlFrom((item && item.url) || a.url, n);
  }
  /* A new page loads in a hidden second frame and replaces the first when it has loaded: no white flash. */
  function swapFrame(url, kind, keepScroll) {
    const spec = frameSpec(kind),
      f = doc.createElement('iframe');
    f.className = 'ar-frame loading';
    f.title = 'Artifact preview';
    f.setAttribute('referrerpolicy', 'no-referrer');
    if (spec.sandbox) f.setAttribute('sandbox', spec.sandbox);
    const target = viewUrl(kind, withScroll(url, keepScroll ? S.scroll : null));
    const old = ui.frame && ui.frame.parentNode === ui.stage ? ui.frame : null,
      seq = S.renderSeq;
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (!ok || seq !== S.renderSeq) {
        f.remove();
        return;
      }
      f.classList.remove('loading');
      for (const n of [...ui.stage.children]) if (n !== f) n.remove();
      ui.frame = f;
    };
    if (!old) {
      ui.stage.replaceChildren();
      f.classList.remove('loading');
      ui.frame = f;
      done = true;
    } else {
      f.addEventListener('load', () => finish(true));
      f.addEventListener('error', () => finish(false));
      win.setTimeout(() => finish(seq === S.renderSeq), 12000);
    }
    ui.stage.append(f);
    f.src = target;
  }
  function stageMessage(text) {
    const p = el('p', 'ar-msg', text);
    setStage(p);
  }
  function sourceView(text, truncated, kind) {
    let body = String(text || '');
    if (kind === 'json' && !truncated) {
      try {
        body = JSON.stringify(JSON.parse(body), null, 2);
      } catch (e) {}
    }
    const wrap = el('div', 'ar-textwrap');
    if (truncated) wrap.append(el('p', 'ar-msg', 'Showing the first part of a long file.'));
    const pre = el('pre', 'ar-pre');
    pre.textContent = body;
    wrap.append(pre);
    return wrap;
  }
  function diffView(files, from, to) {
    const wrap = el('div', 'ar-diff');
    const st = diffStats(files),
      head = el('div', 'ar-diff-head');
    head.append(
      el('span', '', files.length ? 'v' + from + ' → v' + to + ' ' : 'v' + from + ' and v' + to + ' are the same'),
      files.length ? el('span', 'cg-add', '+' + st.added) : '',
      files.length ? doc.createTextNode(' ') : '',
      files.length ? el('span', 'cg-del', MINUS + st.removed) : '',
    );
    if (!files.length) head.firstChild.textContent = 'No differences between v' + from + ' and v' + to;
    wrap.append(head);
    const CG = root.ChangesUI || (typeof require === 'function' ? require('./changes-ui.js') : null);
    const scroll = el('div', 'cg-lines');
    for (const f of files)
      for (const h of f.hunks) {
        const hh = el('div', 'cg-hunk'),
          ph = CG && CG.parseHunkHeader(h.header);
        hh.append(
          el(
            'span',
            'cg-hunk-h',
            ph
              ? '@@ -' +
                  ph.oldStart +
                  ',' +
                  ph.oldLines +
                  ' +' +
                  ph.newStart +
                  ',' +
                  ph.newLines +
                  ' @@' +
                  (ph.section ? ' ' + ph.section : '')
              : h.header,
          ),
        );
        scroll.append(hh);
        for (const r of CG ? CG.hunkRows(h) : []) {
          const row = el('div', 'cg-row cg-' + r.type);
          row.append(
            el('span', 'cg-no', r.old == null ? '' : String(r.old)),
            el('span', 'cg-no', r.new == null ? '' : String(r.new)),
            el('span', 'cg-sign', r.type === 'add' ? '+' : r.type === 'del' ? MINUS : r.type === 'note' ? '' : ' '),
            el('span', 'cg-text', r.text),
          );
          scroll.append(row);
        }
      }
    if (files.length) wrap.append(scroll);
    return wrap;
  }
  async function paintStage(reason) {
    if (!ui) return;
    const a = current();
    if (!a) {
      S.dirty = false;
      S.stageKey = '';
      ui.stage.replaceChildren();
      ui.frame = null;
      return;
    }
    if (!S.visible) {
      S.dirty = true;
      if (reason === 'update') S.reloadPending = true;
      return;
    }
    const seq = ++S.renderSeq,
      latest = num(a.version) || 1,
      ver = shownVersion(latest, S.picked),
      kind = a.kind;
    let mode = S.mode === 'source' && !hasSource(kind) ? 'page' : S.mode;
    if (mode === 'compare' && ver < 2 && !(S.cmp && S.cmp.to >= 2)) mode = 'page';
    S.dirty = false;
    if (!S.items[a.id])
      loadItem(a.id).then(() => {
        if (seq === S.renderSeq) paintBar();
      });
    const key = [a.id, ver, mode, S.cmp && S.cmp.from].join(':');
    const reload = reason === 'update' || reason === 'refresh' || S.reloadPending;
    S.reloadPending = false;
    if (key === S.stageKey && !reload) return;
    const sameArtifact = S.scrollFor === a.id && S.stageKey.split(':')[0] === a.id;
    S.stageKey = key;
    if (!sameArtifact) S.scroll = null;
    S.scrollFor = a.id;
    const url = frameUrlFor(a, ver);
    if (!url) {
      stageMessage('This artifact has no page to show yet.');
      return;
    }
    try {
      if (mode === 'compare') {
        const to = S.cmp && S.cmp.to ? S.cmp.to : ver,
          from = S.cmp && S.cmp.from ? S.cmp.from : Math.max(1, to - 1);
        setStage(el('p', 'ar-msg', 'Reading the changes…'));
        const d = await api('/api/live/artifacts/diff?' + q({ id: a.id, from, to }));
        if (seq !== S.renderSeq) return;
        setStage(diffView(parseUnifiedDiff(d.diff), from, to));
        return;
      }
      if (mode === 'source' || viewMode(kind) === 'text') {
        if (ui.frame || !ui.stage.firstChild) setStage(el('p', 'ar-msg', 'Reading the file…'));
        const d = await api('/api/live/artifacts/source?' + q({ id: a.id, version: ver }));
        if (seq !== S.renderSeq) return;
        setStage(sourceView(d.text, d.truncated, kind));
        return;
      }
      if (viewMode(kind) === 'image') {
        const img = el('img', 'ar-img');
        img.alt = a.title || 'Artifact image';
        img.src = url;
        setStage(img);
        return;
      }
      if (viewMode(kind) === 'pdf') {
        const f = doc.createElement('iframe');
        f.className = 'ar-frame';
        f.title = a.title || 'PDF';
        f.setAttribute('referrerpolicy', 'no-referrer');
        f.src = url;
        setStage(f);
        ui.frame = f;
        return;
      }
      swapFrame(url, kind, reload && sameArtifact);
    } catch (e) {
      if (seq !== S.renderSeq) return;
      S.stageKey = '';
      stageMessage('Could not show this artifact: ' + e.message);
    }
  }

  /* -- popovers: picker, versions, menu -- */
  function closePop() {
    if (!ui || !ui.pop) return;
    ui.pop.hidden = true;
    ui.pop.replaceChildren();
    for (const b of [ui.pick, ui.ver, ui.more]) b.setAttribute('aria-expanded', 'false');
    ui.popFor = '';
  }
  function placePop(anchor, right) {
    const v = ui.view;
    ui.pop.hidden = false;
    const vr = v.getBoundingClientRect(),
      ar = anchor.getBoundingClientRect(),
      k = vr.width && v.offsetWidth ? vr.width / v.offsetWidth : 1;
    const top = (ar.bottom - vr.top) / k + 4;
    ui.pop.style.top = top + 'px';
    if (right) {
      ui.pop.style.left = 'auto';
      ui.pop.style.right = Math.max(4, (vr.right - ar.right) / k) + 'px';
    } else {
      ui.pop.style.right = 'auto';
      // QA m1: a menu wider than the room right of its button moves left, so it never runs off the column's edge
      ui.pop.style.left = placeLeft((ar.left - vr.left) / k, ui.pop.offsetWidth, v.offsetWidth) + 'px';
    }
    ui.pop.style.maxHeight = Math.max(120, v.offsetHeight - top - 8) + 'px';
  }
  function popItem(cls) {
    const b = el('button', 'ar-it ' + (cls || ''));
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    return b;
  }
  async function openPicker() {
    if (ui.popFor === 'pick') {
      closePop();
      return;
    }
    closePop();
    const a = current();
    if (!a || pickerIsPlain(S.list)) return;
    ui.popFor = 'pick';
    ui.pick.setAttribute('aria-expanded', 'true');
    const groups = pickerGroups(S.list, a.id);
    const frag = doc.createDocumentFragment();
    for (const g of groups) {
      frag.append(el('div', 'ar-gh', g.label));
      for (const it of g.items) {
        const row = popItem(it.on ? 'on' : '');
        row.dataset.id = it.id;
        const star = el('span', 'ar-star' + (it.pinned ? ' on' : ''), it.pinned ? '★' : '☆');
        star.setAttribute('role', 'button');
        star.setAttribute('aria-label', it.pinned ? 'Unpin ' + it.title : 'Pin ' + it.title);
        star.title = it.pinned ? 'Unpin' : 'Pin';
        star.addEventListener('click', (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          togglePin(it.id);
        });
        row.append(
          el('span', 'ar-k', it.badge),
          el('span', 'ar-it-title', it.title),
          el('span', 'ar-it-meta', it.meta),
          star,
        );
        row.addEventListener('click', () => {
          closePop();
          selectArtifact(it.id);
        });
        frag.append(row);
      }
    }
    ui.pop.replaceChildren(frag);
    ui.pop.setAttribute('aria-label', 'Artifacts in this chat');
    placePop(ui.pick, false);
    focusFirst();
  }
  async function openVersions() {
    if (ui.popFor === 'ver') {
      closePop();
      return;
    }
    closePop();
    const a = current();
    if (!a) return;
    const c = chipState({ latest: a.version, count: a.versions, picked: S.picked });
    if (c.plain) return;
    ui.popFor = 'ver';
    ui.ver.setAttribute('aria-expanded', 'true');
    ui.pop.replaceChildren(el('div', 'ar-gh', 'Versions'), el('p', 'ar-msg', 'Loading…'));
    placePop(ui.ver, false);
    const item = await loadItem(a.id);
    if (ui.popFor !== 'ver') return;
    const rows = versionRows(
      (item && item.versions) || Array.from({ length: num(a.version) || 1 }, (_, i) => ({ n: i + 1 })),
      num(a.version) || 1,
      c.shown,
    );
    const frag = doc.createDocumentFragment();
    frag.append(el('div', 'ar-gh', 'Versions'));
    for (const r of rows) {
      const b = popItem(r.on ? 'on' : '');
      b.dataset.n = String(r.n);
      b.append(el('span', 'ar-it-title', r.label), el('span', 'ar-it-meta', r.meta));
      if (r.note) b.title = r.note;
      b.addEventListener('click', () => {
        closePop();
        selectVersion(r.n);
      });
      frag.append(b);
    }
    ui.pop.replaceChildren(frag);
    ui.pop.setAttribute('aria-label', 'Versions');
    placePop(ui.ver, false); // again: the rows made it wider than the Loading line
    focusFirst();
  }
  function openMenu() {
    if (ui.popFor === 'menu') {
      closePop();
      return;
    }
    closePop();
    const a = current();
    if (!a) return;
    const ed = editors();
    const items = menuItems({
      kind: a.kind,
      shown: shownVersion(num(a.version) || 1, S.picked),
      latest: num(a.version) || 1,
      mode: S.mode,
      pinned: !!a.pinned,
      sourcePath: a.sourcePath,
      canEditor: !!ed,
    });
    ui.popFor = 'menu';
    ui.more.setAttribute('aria-expanded', 'true');
    const frag = doc.createDocumentFragment();
    for (const it of items) {
      if (it.sep) {
        frag.append(el('div', 'ar-sep'));
        continue;
      }
      const b = popItem();
      b.dataset.id = it.id;
      b.append(el('span', 'ar-it-title', it.label));
      if (it.kb) b.append(el('span', 'ar-kb', it.kb));
      b.addEventListener('click', () => {
        closePop();
        runMenu(it.id);
      });
      frag.append(b);
    }
    ui.pop.replaceChildren(frag);
    ui.pop.setAttribute('aria-label', 'More');
    placePop(ui.more, true);
    focusFirst();
  }
  function focusFirst() {
    const b = ui.pop.querySelector('.ar-it.on') || ui.pop.querySelector('.ar-it');
    if (b) b.focus({ preventScroll: true });
  }
  async function togglePin(id) {
    const a = known(id);
    if (!a) return;
    try {
      const s = await api('/api/live/artifacts/pin', { id, pinned: !a.pinned });
      S.userPicked = true;
      upsert(s && s.id ? s : Object.assign({}, a, { pinned: !a.pinned }));
      if (ui && ui.popFor === 'pick') {
        ui.popFor = '';
        openPicker();
      }
    } catch (e) {
      note('Could not change the pin: ' + e.message);
    }
  }
  async function runMenu(id) {
    const a = current();
    if (!a) return;
    const ver = shownVersion(num(a.version) || 1, S.picked);
    if (id === 'source') {
      S.mode = S.mode === 'source' ? 'page' : 'source';
      S.cmp = null;
      S.dirty = true;
      paintBar();
      paintStage('open');
    } else if (id === 'compare') {
      if (S.mode === 'compare') {
        S.mode = 'page';
        S.cmp = null;
      } else {
        S.mode = 'compare';
        S.cmp = { from: Math.max(1, ver - 1), to: ver };
      }
      S.dirty = true;
      paintBar();
      paintStage('open');
    } else if (id === 'restore') {
      try {
        const s = await api('/api/live/artifacts/restore', { id: a.id, version: ver });
        delete S.items[a.id];
        S.picked = null;
        S.mode = 'page';
        S.cmp = null;
        S.stageKey = '';
        upsert(s && s.id ? s : a);
        S.dirty = true;
        paintAll();
        paintStage('open');
        note('Restored v' + ver + ' as a new version.');
      } catch (e) {
        note('Could not restore: ' + e.message);
      }
    } else if (id === 'pin') togglePin(a.id);
    else if (id === 'editor') {
      const ed = editors();
      if (ed && a.sourcePath) {
        try {
          ed.openFile(a.sourcePath, 0, S.chat.cwd);
        } catch (e) {}
      }
    } else if (id === 'copy') {
      copyText(a.sourcePath);
    } else if (id === 'download') {
      download(frameUrlFor(a, ver));
    }
  }
  async function copyText(text) {
    try {
      await win.navigator.clipboard.writeText(String(text || ''));
      note('Path copied.');
    } catch (e) {
      try {
        const t = doc.createElement('textarea');
        t.value = String(text || '');
        t.setAttribute('readonly', '');
        doc.body.append(t);
        t.select();
        doc.execCommand('copy');
        t.remove();
        note('Path copied.');
      } catch (x) {
        note('Could not copy the path.');
      }
    }
  }
  function download(url) {
    if (!url) return;
    const a = doc.createElement('a');
    a.href = downloadUrl(url);
    a.rel = 'noopener';
    a.target = '_blank';
    a.hidden = true;
    doc.body.append(a);
    a.click();
    a.remove();
  }
  function openInBrowser() {
    const a = current();
    if (!a) return;
    const url = viewUrl(a.kind, frameUrlFor(a, shownVersion(num(a.version) || 1, S.picked)));
    if (url) win.open(url, '_blank', 'noopener');
  }

  /* -- cards in the chat stream -- */
  const cardSig = (m) => (m ? [m.id, m.title, m.version, m.sub, m.canOpen].join('|') : '');
  /* QA m3: an old card shows the version its turn wrote, not the newest. Needs the version times (one item read per artifact). */
  const itemAsked = new Set();
  function cardVersion(card) {
    const art = S.list.find((a) => sameFile(a.sourcePath, card.dataset.src));
    if (!art) return 0;
    const latest = num(art.version) || 1;
    if (latest <= 1) return 1;
    const item = S.items[art.id],
      at = Number(card.dataset.time) || 0;
    if (at > 0 && !(item && Array.isArray(item.versions))) {
      if (!itemAsked.has(art.id + ':' + latest)) {
        itemAsked.add(art.id + ':' + latest);
        loadItem(art.id).then(() => refreshCards());
      }
      return latest;
    }
    const same = [...doc.querySelectorAll('.art-card')].filter(
      (c) => c.dataset.src && sameFile(c.dataset.src, art.sourcePath),
    );
    return writtenVersion(item && item.versions, at, same.indexOf(card) + 1, latest);
  }
  function paintCard(card) {
    const d = card.dataset;
    let m = null;
    if (d.src) m = outputsCardModel(d.src, S.list, undefined, cardVersion(card));
    else if (d.op)
      m = cardModel(
        {
          op: d.op,
          input: { id: d.id || '', title: d.title || '', kind: d.kind || '' },
          result: d.rid ? { id: d.rid, version: Number(d.ver) || undefined } : null,
          status: d.status,
        },
        S.list,
      );
    if (!m) {
      card.hidden = true;
      card.replaceChildren();
      card.dataset.sig = '';
      return;
    }
    const sig = cardSig(m) + (S.selId === m.id ? '*' : '');
    if (card.dataset.sig === sig && !card.hidden) return;
    card.hidden = false;
    card.dataset.sig = sig;
    card.dataset.artId = m.id;
    card.replaceChildren();
    const ic = el('span', 'art-card-ic', m.badge),
      body = el('div', 'art-card-body');
    body.append(el('div', 'art-card-title', m.title), el('div', 'art-card-sub', m.sub));
    const acts = el('div', 'art-card-actions');
    const openBtn = el('button', 'art-btn', 'Open');
    openBtn.type = 'button';
    openBtn.disabled = !m.canOpen;
    openBtn.setAttribute('aria-label', 'Open ' + m.title + ' in the Artifacts viewer');
    openBtn.addEventListener('click', () =>
      open(m.id, m.latest && m.version < m.latest ? { version: m.version } : undefined),
    );
    acts.append(openBtn);
    if (m.diffFrom) {
      const df = el('button', 'art-btn', 'Diff from v' + m.diffFrom);
      df.type = 'button';
      df.title = 'Open the viewer and compare v' + m.diffFrom + ' with v' + m.version;
      df.addEventListener('click', () =>
        open(m.id, { version: m.version, compare: { from: m.diffFrom, to: m.version } }),
      );
      acts.append(df);
    }
    card.append(ic, body, acts);
  }
  function makeCard(data) {
    const card = el('div', 'art-card');
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', 'Artifact');
    const d = card.dataset;
    if (data.src) {
      d.src = data.src;
      if (data.time) d.time = String(data.time);
    } else {
      d.op = data.op;
      d.id = data.id || '';
      d.title = data.title || '';
      d.kind = data.kind || '';
      d.rid = data.rid || '';
      d.ver = data.ver || '';
      d.status = data.status || '';
    }
    paintCard(card);
    return card;
  }
  function refreshCards() {
    if (!doc) return;
    for (const c of doc.querySelectorAll('.art-card')) paintCard(c);
  }
  /* Preview button on a file-write row. */
  function previewButton(path) {
    const b = el('button', 'art-preview', 'Preview');
    b.type = 'button';
    b.title = 'Show this file in the Artifacts viewer';
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (b.disabled) return;
      b.disabled = true;
      b.textContent = 'Opening…';
      try {
        const s = await api('/api/live/artifacts/preview', { conversationId: S.chat.id, path });
        if (s && s.id) {
          upsert(s);
          await open(s.id);
        }
        b.textContent = 'Preview';
      } catch (e) {
        b.textContent = 'Preview failed';
        b.title = e.message;
        win.setTimeout(() => {
          b.textContent = 'Preview';
          b.title = 'Show this file in the Artifacts viewer';
        }, 4000);
      } finally {
        b.disabled = false;
      }
    });
    return b;
  }
  /* chat.js passes every tool row through here. Returns the row itself, or a wrapper that also holds a card. */
  function decorateToolRow(box, row) {
    if (!doc || !box) return box;
    try {
      const call = artifactCall(row);
      if (call) {
        if (call.op !== 'publish' && call.op !== 'update') return box;
        const res = call.result || {},
          inp = call.input || {};
        const wrap = el('div', 'art-tool');
        wrap.append(
          box,
          makeCard({
            op: call.op,
            id: String(res.id || inp.id || ''),
            title: String(inp.title || res.title || ''),
            kind: String(inp.kind || res.kind || ''),
            rid: String(res.id || ''),
            ver: res.version ? String(res.version) : '',
            status: call.status,
          }),
        );
        return wrap;
      }
      const written = writeTarget(row);
      if (written && isPreviewable(written)) {
        const path = absolutize(written, S.chat.cwd);
        if (S.chat.cwd && isOutputsPath(path, S.chat.cwd)) {
          const wrap = el('div', 'art-tool');
          wrap.append(box, makeCard({ src: path, time: Number(row && row.time) || 0 }));
          return wrap;
        }
        if (!S.chat.cwd || relPath(path, S.chat.cwd) !== null) box.append(previewButton(path));
      }
    } catch (e) {}
    return box;
  }

  /* -- links in replies -- */
  function linkNode(text, id, cls) {
    const a = el('a', 'artifact-link ' + (cls || ''));
    a.href = '#';
    a.dataset.artifactId = id;
    a.title = 'Open in the Artifacts viewer';
    a.append(el('span', '', '⧉ '), doc.createTextNode(text));
    return a;
  }
  /* Turn plain-text source paths in rendered Markdown into artifact links (markdown.js calls this after every render). */
  /* A viewable file a reply names (C:\proj\report.html, ./out/chart.svg, notes.md …) that is not an artifact yet. Matches inside the
   chat's project folder only, never inside a URL. Returns [{t:'text',v}|{t:'file',v,path}]. */
  const FILE_RE =
    /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w.\-]+[\\/])*[\w\-][\w.\-]*\.(?:html?|svg|md|markdown|png|jpe?g|gif|webp|pdf)(?![\w\-])/gi;
  /* A Markdown link to a file ([report.md](docs/report.md) or [x](C:\proj\a.html:12)) stays as text after rendering, since only
   web links become links: show it as one file link with its label. */
  const MD_FILE_LINK = /\[([^\]\n]{1,300})\]\(<?([^()\s<>]+?)>?(?::\d+(?::\d+)?)?\)/g;
  function fileSegments(text, project) {
    text = String(text == null ? '' : text);
    if (!project || !text) return [{ t: 'text', v: text }];
    const out = [];
    let pos = 0,
      m;
    MD_FILE_LINK.lastIndex = 0;
    while ((m = MD_FILE_LINK.exec(text))) {
      FILE_RE.lastIndex = 0;
      const f = FILE_RE.exec(m[2]);
      if (!f || f.index !== 0 || f[0].length !== m[2].length) continue;
      const path = absolutize(m[2], project);
      if (relPath(path, project) === null) continue;
      if (m.index > pos) out.push(...plainFileSegments(text.slice(pos, m.index), project));
      out.push({ t: 'file', v: m[1], path });
      pos = m.index + m[0].length;
    }
    if (!out.length) return plainFileSegments(text, project);
    if (pos < text.length) out.push(...plainFileSegments(text.slice(pos), project));
    return out;
  }
  function plainFileSegments(text, project) {
    const out = [];
    let pos = 0,
      m;
    FILE_RE.lastIndex = 0;
    while ((m = FILE_RE.exec(text))) {
      const v = m[0],
        at = m.index,
        before = text.slice(Math.max(0, at - 200), at);
      if (/[a-z][a-z0-9+.\-]*:\/\/\S*$/i.test(before) || /[\w@]$/.test(before)) continue; // part of a URL or a longer word
      const path = absolutize(v, project);
      if (relPath(path, project) === null) continue;
      if (at > pos) out.push({ t: 'text', v: text.slice(pos, at) });
      out.push({ t: 'file', v, path });
      pos = at + v.length;
    }
    if (pos < text.length) out.push({ t: 'text', v: text.slice(pos) });
    return out.length ? out : [{ t: 'text', v: text }];
  }
  function fileLink(label, path, wrap) {
    const a = el('a', 'artifact-link file');
    a.href = '#';
    a.dataset.previewPath = path;
    a.title = 'Open in the Artifacts viewer';
    a.append(el('span', '', '⧉ '));
    if (wrap) a.append(wrap);
    else a.append(doc.createTextNode(label));
    return a;
  }
  function textNodes(container) {
    const walker = doc.createTreeWalker(container, 4 /* NodeFilter.SHOW_TEXT */),
      nodes = [];
    let n;
    while ((n = walker.nextNode())) {
      if (!n.nodeValue || n.nodeValue.length < 4) continue;
      const p = n.parentElement;
      if (!p || p.closest('a,pre,button')) continue;
      nodes.push(n);
    }
    return nodes;
  }
  /* Second pass: viewable files that are not artifacts yet become links that preview them on click. */
  function linkFiles(container) {
    const project = S.chat && S.chat.cwd;
    if (!project) return;
    for (const t of textNodes(container)) {
      const segs = fileSegments(t.nodeValue, project);
      if (!segs.some((x) => x.t === 'file')) continue;
      const p = t.parentElement;
      if (p && p.tagName === 'CODE' && segs.length === 1) {
        const a = fileLink(segs[0].v, segs[0].path, null);
        a.lastChild.remove();
        p.replaceWith(a);
        a.append(p);
        continue;
      } // swap first, then move the code inside
      const frag = doc.createDocumentFragment();
      for (const x of segs) frag.append(x.t === 'file' ? fileLink(x.v, x.path) : doc.createTextNode(x.v));
      t.replaceWith(frag);
    }
  }
  async function openFile(link) {
    const path = link.dataset.previewPath;
    if (!path || link.dataset.busy) return;
    link.dataset.busy = '1';
    const was = link.title;
    link.title = 'Opening…';
    try {
      const s = await api('/api/live/artifacts/preview', { conversationId: S.chat.id, path });
      if (s && s.id) {
        upsert(s);
        link.dataset.artifactId = s.id;
        delete link.dataset.previewPath;
        await open(s.id);
      }
      link.title = was;
    } catch (e) {
      link.title = 'Could not open: ' + e.message;
      link.classList.add('failed');
    } finally {
      delete link.dataset.busy;
    }
  }
  function linkify(container) {
    if (!doc || !container) return;
    const withPath = S.list.filter((a) => a.sourcePath);
    if (withPath.length) linkArtifacts(container, withPath);
    linkFiles(container);
  }
  function linkArtifacts(container, withPath) {
    const project = S.chat.cwd;
    const walker = doc.createTreeWalker(container, 4 /* NodeFilter.SHOW_TEXT */);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) {
      if (!n.nodeValue || n.nodeValue.length < 4) continue;
      const p = n.parentElement;
      if (!p || p.closest('a,pre,button')) continue;
      nodes.push(n);
    }
    for (const t of nodes) {
      const segs = linkSegments(t.nodeValue, withPath, project);
      if (!hasLink(segs)) continue;
      const p = t.parentElement;
      if (p && p.tagName === 'CODE' && segs.length === 1) {
        // `outputs/report.html` on its own: wrap the code in the link
        const a = el('a', 'artifact-link path');
        a.href = '#';
        a.dataset.artifactId = segs[0].id;
        a.title = 'Open in the Artifacts viewer';
        p.replaceWith(a);
        a.append(el('span', '', '⧉ '), p);
        continue;
      }
      const frag = doc.createDocumentFragment();
      for (const s of segs) frag.append(s.t === 'link' ? linkNode(s.v, s.id, 'path') : doc.createTextNode(s.v));
      t.replaceWith(frag);
    }
  }
  let linkSig = '';
  function relinkAll() {
    if (!doc) return;
    const sig = S.list.map((a) => a.id + '|' + (a.sourcePath || '')).join(';') + '#' + S.chat.cwd;
    if (sig === linkSig) return;
    linkSig = sig;
    for (const m of doc.querySelectorAll('#messages .markdown')) linkify(m);
  }

  /* -- mounting (called by changes-ui.js, which owns the tab row) -- */
  function mount(o) {
    if (S.mounted || !o || !o.view) return;
    win = o.win || root;
    doc = win.document;
    const view = o.view;
    const bar = el('div', 'ar-bar');
    const pick = el('button', 'ar-pick');
    pick.type = 'button';
    pick.setAttribute('aria-expanded', 'false');
    const ver = el('button', 'ar-ver');
    ver.type = 'button';
    ver.setAttribute('aria-expanded', 'false');
    const spacer = el('span', 'ar-spacer');
    const ext = el('button', 'ar-ico', '↗');
    ext.type = 'button';
    ext.title = 'Open in your browser';
    ext.setAttribute('aria-label', 'Open in your browser');
    const more = el('button', 'ar-ico', '⋯');
    more.type = 'button';
    more.title = 'More';
    more.setAttribute('aria-label', 'More');
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    bar.append(pick, ver, spacer, ext, more);
    const avail = el('div', 'ar-avail');
    avail.hidden = true;
    avail.setAttribute('role', 'status');
    const availText = el('span', '', '');
    const switchBtn = el('button', 'ar-switch', 'Switch');
    switchBtn.type = 'button';
    avail.append(availText, switchBtn);
    const fresh = el('div', 'ar-fresh');
    fresh.hidden = true;
    fresh.setAttribute('role', 'status');
    const freshText = el('span', 'ar-fresh-t', '');
    const freshOpen = el('button', 'ar-switch ar-fresh-open', 'Open');
    freshOpen.type = 'button';
    fresh.append(freshText, freshOpen);
    const noteEl = el('p', 'ar-note');
    noteEl.hidden = true;
    noteEl.setAttribute('role', 'status');
    const stage = el('div', 'ar-stage');
    const empty = el('div', 'ar-empty');
    empty.append(
      el('p', 'ar-empty-t', 'No artifacts in this chat yet'),
      el('p', '', 'When the agent publishes a page, diagram or report, or saves a file in outputs/, it shows up here.'),
    );
    const foot = el('div', 'ar-foot', FOOTER);
    const pop = el('div', 'ar-pop');
    pop.hidden = true;
    pop.setAttribute('role', 'menu');
    view.append(bar, avail, fresh, noteEl, stage, empty, foot, pop);
    ui = {
      view,
      bar,
      pick,
      ver,
      more,
      ext,
      avail,
      availText,
      switchBtn,
      fresh,
      freshText,
      note: noteEl,
      stage,
      empty,
      foot,
      pop,
      badge: o.badge,
      tab: o.tab,
      reveal: o.reveal || (() => {}),
      frame: null,
      popFor: '',
    };
    S.mounted = true;
    pick.addEventListener('click', openPicker);
    ver.addEventListener('click', openVersions);
    more.addEventListener('click', openMenu);
    ext.addEventListener('click', openInBrowser);
    switchBtn.addEventListener('click', () => {
      S.picked = null;
      if (S.mode === 'compare') {
        S.mode = 'page';
        S.cmp = null;
      }
      S.dirty = true;
      S.stageKey = '';
      paintAll();
      paintStage('open');
      ver.focus({ preventScroll: true }); // QA m10: the Switch button goes away; the version chip takes the focus
    });
    freshOpen.addEventListener('click', () => {
      const id = S.fresh;
      S.fresh = '';
      if (id) selectArtifact(id);
      paintAll();
      pick.focus({ preventScroll: true });
    });
    // Escape and outside clicks close the popover; arrows move through its items.
    doc.addEventListener(
      'keydown',
      (e) => {
        if (ui.pop.hidden) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          const f = ui.popFor === 'menu' ? more : ui.popFor === 'ver' ? ver : pick;
          closePop();
          f.focus({ preventScroll: true });
          return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const items = [...ui.pop.querySelectorAll('.ar-it')];
          if (!items.length) return;
          const at = items.indexOf(doc.activeElement),
            next = e.key === 'ArrowDown' ? (at + 1) % items.length : at <= 0 ? items.length - 1 : at - 1;
          e.preventDefault();
          items[next].focus({ preventScroll: true });
        }
      },
      true,
    );
    doc.addEventListener('click', (e) => {
      const link = e.target && e.target.closest ? e.target.closest('a.artifact-link') : null;
      if (link && link.dataset.artifactId) {
        e.preventDefault();
        open(link.dataset.artifactId);
        return;
      }
      if (link && link.dataset.previewPath) {
        e.preventDefault();
        openFile(link);
        return;
      }
      if (!ui.pop.hidden && !ui.pop.contains(e.target) && !bar.contains(e.target)) closePop();
    });
    // The page reports its scroll position so a reload can put it back. A sandboxed page has an opaque origin, so the sender is
    // identified by its window, not by event.origin.
    win.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || d.type !== 'studio-artifact-scroll' || !ui.frame || e.source !== ui.frame.contentWindow) return;
      const x = Number(d.x),
        y = Number(d.y);
      if (Number.isFinite(x) && Number.isFinite(y)) S.scroll = { x, y };
    });
    win.setInterval(() => refreshCards(), 30000);
    paintCount();
    paintAll();
  }

  const api2 = Object.assign({}, pure, {
    mount,
    sync,
    setVisible,
    shown,
    onEvents,
    decorateToolRow,
    linkify,
    open,
    upsert,
    state: () => ({ chat: S.chat, list: S.list, selId: S.selId, picked: S.picked, mode: S.mode, fresh: S.fresh }),
    _S: S,
  });
  root.ArtifactsUI = api2;
  root.AgentArtifactsUI = api2;
  if (typeof module === 'object' && module.exports) module.exports = api2;
})(typeof window !== 'undefined' ? window : globalThis);

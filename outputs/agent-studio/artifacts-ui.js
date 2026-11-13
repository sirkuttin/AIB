'use strict';
/* Artifacts (UI half): the third tab of the right column ("Activity | Changes N | Artifacts N"), a one-row viewer (picker, version chip,
   open-in-browser, a menu), stream cards for studio_artifact tool calls, the Preview button on file-write rows and the
   studio-artifact:// / source-path links in replies. Data comes from the Studio artifact routes (server/artifacts/). Pages run in a sandboxed iframe on the separate artifact origin and are view-only.
   The pure helpers at the top have node tests (work/test_artifacts_ui.js); the page part below mounts from changes-ui.js. */
(function (root) {
  const SANDBOX = 'allow-scripts allow-forms allow-popups allow-downloads';
  const FOOTER = 'Sandboxed · no access to AIB · CDN scripts only';
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
  /* A local doc's history (no chat, no source file): the doc's History panel shows it, the picker never does (the server leaves
     them out of the list already; this keeps an old answer from showing one). */
  const isDocHistory = (a) => !!a && !a.conversationId && !a.sourcePath;
  /* The doc rows: {doc: true, name, title, badge 'doc', meta "4 pages"}. `chatKey`: the chat's lasting id(s) a doc links to. */
  const docRow = (d) => ({
    doc: true,
    id: 'doc:' + d.name,
    name: d.name,
    badge: 'doc',
    title: d.title || d.name,
    meta: Math.max(1, num(d.pages)) + (Math.max(1, num(d.pages)) === 1 ? ' page' : ' pages'),
    pinned: false,
    on: false,
  });
  /* Picker rows in groups: "Pinned" and "This chat" list artifacts; below a divider, "Docs this chat wrote" lists the docs linked to
     this chat (and a doc this chat opened here). A doc opens in this viewer, in the full doc editor. The project's other docs are
     not listed: Files and Ctrl+K have every doc, and open them as tabs. An empty group is left out. */
  const DOCS_NOTE = 'Open here to edit; you and agents both can';
  const linkedDocs = (docs, chatKeys) => {
    const keys = (Array.isArray(chatKeys) ? chatKeys : [chatKeys]).filter(Boolean);
    return (Array.isArray(docs) ? docs : []).filter((d) => d && d.name && d.chat && keys.includes(d.chat));
  };
  /* ---- archive and Recently deleted (owner decisions 2026-11-12) ------------------------------------------------------
     An archived artifact (archivedAt) is out of the picker's main groups but whole; a deleted one (deletedAt) waits in Recently
     deleted until purgeAt (30 days), and its source file waits in the artifact's bin (deletedFile says which file went, or why it was
     kept). Both stay in the panel's list; everything that counts or picks artifacts uses only the live ones. Times are in seconds. */
  const isDeleted = (a) => !!a && Number(a.deletedAt) > 0;
  const isArchived = (a) => !!a && Number(a.archivedAt) > 0 && !isDeleted(a);
  const isLive = (a) => !!a && !!a.id && !isDocHistory(a) && !isArchived(a) && !isDeleted(a);
  const liveOf = (list) => (Array.isArray(list) ? list : []).filter(isLive);
  /* 'live' | 'archived' | 'deleted' | 'gone' (no such artifact any more). */
  const artState = (a) => (!a ? 'gone' : isDeleted(a) ? 'deleted' : isArchived(a) ? 'archived' : 'live');
  /* The word a chat-message link or a tool card adds after the title: "· archived", "· deleted" (a purged one reads deleted too). */
  const stateWord = (state) => (state === 'archived' ? 'archived' : state === 'deleted' || state === 'gone' ? 'deleted' : '');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /* "12 Dec" (with the year when it is not this year's). */
  function dayText(at, nowMs) {
    const t = Number(at);
    if (!(t > 0)) return '';
    const d = new Date(t * 1000),
      now = new Date(nowMs == null ? Date.now() : nowMs);
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + (d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : '');
  }
  /* "12 Nov, 14:02" */
  function whenText(at, nowMs) {
    const t = Number(at);
    if (!(t > 0)) return '';
    const d = new Date(t * 1000),
      two = (n) => (n < 10 ? '0' : '') + n;
    return dayText(t, nowMs) + ', ' + two(d.getHours()) + ':' + two(d.getMinutes());
  }
  /* Why a file stayed, in AIB's words per code (the server's own text when the code is new to the page). */
  const KEPT_WHY = {
    folder_unknown: "AIB can't find this chat's folder",
    link: 'it is a link, not a file',
    not_file: 'it is not a regular file',
    outside: "it is outside this chat's folder",
    git: 'it is inside .git',
    docs: 'it belongs to an AIB doc',
    shared: 'another artifact uses it',
    folder_gone: "this chat's folder is gone",
    copy_gone: 'the saved copy of the file is gone',
  };
  const keptWhy = (code, reason) => String(KEPT_WHY[code] || reason || 'AIB left it in place').replace(/\.$/, '');
  /* What happened to a deleted artifact's source file, from its deletedFile {path, kept?, code?}. */
  function fileSentence(df) {
    if (!df || !df.path || df.code === 'no_file') return '';
    if (!df.kept) return df.path + ' went too; Restore puts it back.';
    if (df.code === 'gone') return df.path + ' was already gone from disk.';
    return 'Kept ' + df.path + ': ' + keptWhy(df.code, df.kept) + '.';
  }
  /* A Recently deleted row's line: "Deleted 12 Nov, 14:02. Removed for good on 12 Dec. outputs/report.html went too; …" */
  function deletedLine(a, nowMs) {
    if (!isDeleted(a)) return '';
    const purge = Number(a.purgeAt) > 0 ? Number(a.purgeAt) : Number(a.deletedAt) + 30 * 86400;
    return ['Deleted ' + whenText(a.deletedAt, nowMs) + '.', 'Removed for good on ' + dayText(purge, nowMs) + '.', fileSentence(a.deletedFile)]
      .filter(Boolean)
      .join(' ');
  }
  /* The viewer on a deleted artifact (opened from a link or the group): a message, not the page. */
  function deletedStage(a, nowMs) {
    if (!isDeleted(a)) return '';
    const purge = Number(a.purgeAt) > 0 ? Number(a.purgeAt) : Number(a.deletedAt) + 30 * 86400;
    return '"' + (a.title || 'Untitled') + '" is in Recently deleted until ' + dayText(purge, nowMs) + '.';
  }
  /* The strip over an archived artifact in the viewer. */
  const archivedStrip = (a, nowMs) =>
    isArchived(a) ? 'Archived ' + (relTime(a.archivedAt, nowMs) || 'just now') + ". Hidden from this chat's list." : '';
  const quoted = (title) => '"' + (title || 'Untitled') + '"';
  /* The note line after Archive / Unarchive (archiving a pinned artifact unpins it, decision 6a). */
  const archiveNote = (title, archived, unpinned) =>
    archived ? (unpinned ? 'Unpinned and archived ' : 'Archived ') + quoted(title) + '.' : 'Unarchived ' + quoted(title) + '.';
  /* The note line after Delete: which file went with it, or why it stayed. `file` is the delete route's {path, action, code, reason}. */
  function deleteNote(title, file) {
    const head = 'Deleted ' + quoted(title) + '.';
    let mid = '';
    if (file && file.path) {
      if (file.action === 'moved') mid = ' ' + file.path + ' went too.';
      else if (file.code === 'gone') mid = ' ' + file.path + ' was already gone from disk.';
      else if (file.code !== 'no_file') mid = ' Kept ' + file.path + ': ' + keptWhy(file.code, file.reason) + '.';
    }
    return head + mid + ' In Recently deleted for 30 days.';
  }
  /* The note line after Restore. `file` is the undelete route's {path, action, as, code, reason}. */
  function restoreNote(title, file) {
    const head = 'Restored ' + quoted(title);
    if (!file || !file.path) return head + '.';
    if (file.action === 'restored') return head + '. ' + file.path + ' is back.';
    if (file.action === 'restored_as')
      return head + '. A new file sits at ' + file.path + ', so the old one is back as ' + (file.as || 'a copy') + '.';
    if (file.action === 'kept' && /^(folder_gone|outside|copy_gone)$/.test(String(file.code || '')))
      return head + ' without its file: ' + (file.code === 'outside' ? "its old place is outside this chat's folder" : keptWhy(file.code, file.reason)) + '.';
    return head + '.';
  }
  /* A row's ⋯ menu (and right-click): the same words and order as a chat's menu. Docs and deleted rows have none. */
  const BECAME_HINT = 'The doc stays. Delete removes its artifact versions and the Undo back to an artifact.';
  function rowMenuItems(a) {
    if (!a || !a.id || isDeleted(a) || isDocHistory(a)) return [];
    const out = [{ id: 'open', label: 'Open' }];
    if (!isArchived(a)) out.push({ id: 'pin', label: a.pinned ? 'Unpin' : 'Pin', kb: a.pinned ? '★' : '☆' });
    out.push({ sep: true });
    out.push(isArchived(a) ? { id: 'unarchive', label: 'Unarchive' } : { id: 'archive', label: 'Archive' });
    out.push({ id: 'delete', label: 'Delete', danger: true });
    if (a.becameDoc) out.push({ hint: BECAME_HINT });
    return out;
  }
  /* The empty viewer when nothing live is left: "Nothing showing. Archived 18 · Recently deleted 4" (null when there is neither). */
  function hiddenCounts(list) {
    const l = (Array.isArray(list) ? list : []).filter((a) => a && a.id && !isDocHistory(a));
    const archived = l.filter(isArchived).length,
      deleted = l.filter(isDeleted).length;
    return archived || deleted ? { archived, deleted } : null;
  }

  /* `foot` {archived: open?, deleted: open?}: the two groups at the picker's foot ("Archived N", "Recently deleted N"), closed until
     opened; they show only while they hold something (or are open: "Nothing archived."). */
  function pickerGroups(list, selectedId, nowMs, docs, chatKeys, freshId, foot) {
    const row = (a) => ({
      id: a.id,
      badge: kindInfo(a.kind).badge,
      title: a.title || 'Untitled',
      meta: a.becameDoc
        ? 'now a doc'
        : 'v' + (num(a.version) || 1) + (relTime(a.updatedAt, nowMs) ? ' · ' + relTime(a.updatedAt, nowMs) : ''),
      pinned: !!a.pinned,
      on: a.id === selectedId,
      fresh: !!freshId && a.id === freshId,
    });
    const all = orderArtifacts((Array.isArray(list) ? list : []).filter((a) => !isDocHistory(a))),
      ordered = all.filter(isLive),
      pinned = ordered.filter((a) => a.pinned).map(row),
      rest = ordered.filter((a) => !a.pinned).map(row);
    const mine = linkedDocs(docs, chatKeys)
      .map(docRow)
      .map((r) => Object.assign(r, { on: r.id === selectedId, fresh: !!freshId && r.id === freshId }));
    const groups = [];
    if (pinned.length) groups.push({ key: 'pinned', label: 'Pinned', items: pinned });
    if (rest.length) groups.push({ key: 'chat', label: 'This chat', items: rest });
    if (mine.length)
      groups.push({ key: 'docs', label: 'Docs this chat wrote', note: DOCS_NOTE, divider: !!(pinned.length || rest.length), items: mine });
    foot = foot || {};
    const archived = all.filter(isArchived).sort((a, b) => num(b.archivedAt) - num(a.archivedAt)),
      deleted = all.filter(isDeleted).sort((a, b) => num(b.deletedAt) - num(a.deletedAt));
    const before = groups.length > 0;
    const footGroup = (key, label, items, empty, mapRow) => {
      if (!items.length && !foot[key]) return;
      groups.push({
        key,
        label,
        foot: true,
        count: items.length,
        open: !!foot[key],
        empty: items.length ? '' : empty,
        divider: before && !groups.some((g) => g.foot),
        items: foot[key] ? items.map(mapRow) : [],
      });
    };
    footGroup('archived', 'Archived', archived, 'Nothing archived.', (a) =>
      Object.assign(row(a), { archived: true, meta: 'Archived ' + (relTime(a.archivedAt, nowMs) || 'just now') }),
    );
    footGroup('deleted', 'Recently deleted', deleted, 'Nothing deleted recently.', (a) =>
      Object.assign(row(a), { deleted: true, line: deletedLine(a, nowMs) }),
    );
    return groups;
  }
  /* One live artifact, no doc this chat wrote and nothing archived or deleted: plain text, no caret. Otherwise a dropdown. */
  const pickerIsPlain = (list, docs, chatKeys) =>
    liveOf(list).length <= 1 && !linkedDocs(docs, chatKeys).length && !hiddenCounts(list);
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
    // A deleted artifact shows no page: its menu only brings it back.
    if (o.deleted) return [{ id: 'undelete', label: 'Restore' }];
    if (hasSource(kind) && viewMode(kind) === 'page')
      out.push({ id: 'source', label: mode === 'source' ? 'View page' : 'View source' });
    if (shown >= 2 && hasSource(kind))
      out.push({ id: 'compare', label: mode === 'compare' ? 'Close comparison' : 'Compare with v' + (shown - 1) });
    if (shown < latest) out.push({ id: 'restore', label: 'Restore this version' });
    out.push({ sep: true });
    if (!o.archived) out.push({ id: 'pin', label: o.pinned ? 'Unpin' : 'Pin', kb: o.pinned ? '★' : '☆' }); // as chats: no Pin when archived
    if (o.sourcePath && o.canEditor) out.push({ id: 'editor', label: 'Open source file in editor' });
    if (o.sourcePath) out.push({ id: 'copy', label: 'Copy path' });
    if (o.sourceCopy) out.push({ id: 'copycopy', label: 'Copy path of the saved file' }); // its chat's folder is gone; AIB kept the file
    out.push({ id: 'download', label: 'Download' });
    // the last group, in the chat menu's order: Archive (Unarchive) then Delete in red
    out.push({ sep: true });
    out.push(o.archived ? { id: 'unarchive', label: 'Unarchive' } : { id: 'archive', label: 'Archive' });
    out.push({ id: 'delete', label: 'Delete', danger: true });
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
      builtFrom: art && art.fromDoc ? docPageName(art.fromDoc) : '',
      state: art ? stateWord(artState(art)) : '', // "· archived" / "· deleted" after the title (decision 8a)
    };
  }
  /* "Built from <doc › page>" for an artifact (its fromDoc), and the banner the viewer shows: `state` is GET /api/live/docs/built's
     answer (null while it loads). Returns {from, stale, line, rebuild} where `rebuild` is the message "Rebuild from the doc" sends. */
  const EDIT_TIP = "Edit opens this as a doc here. You and agents can both change it. It's saved in aib-docs/ and " +
    'nothing is committed until you commit.';
  /* The title bar's word button: Markdown artifacts get Edit (it becomes a doc), every other kind Request a change; none once it
     became a doc. */
  const barAction = (a) => (!a ? '' : a.becameDoc || isDeleted(a) ? '' : a.kind === 'md' ? 'edit' : 'request');
  /* Edit's cursor: the block nearest the viewer's scroll position, from how far down the page the viewer is. */
  function blockAt(ids, fraction) {
    const list = Array.isArray(ids) ? ids : [];
    if (!list.length) return '';
    const f = Math.min(1, Math.max(0, Number(fraction) || 0));
    return list[Math.min(list.length - 1, Math.round(f * (list.length - 1)))];
  }
  const docPageName = (f) => (f ? String(f.title || f.doc || 'doc') + ' \u203a ' + String(f.pageTitle || 'page') : '');
  function builtBanner(a, state) {
    const f = a && a.fromDoc;
    if (!f || !f.doc) return null;
    const st = state || null;
    const named = st && !st.gone ? Object.assign({}, f, { title: st.title || f.title, pageTitle: st.pageTitle || f.pageTitle }) : f;
    const from = docPageName(named);
    if (st && st.gone) return { from, stale: false, gone: st.gone, line: '', rebuild: '' };
    if (st && st.changed) {
      const n = Math.max(1, num(st.edits));
      return {
        from,
        stale: true,
        line: from + ' changed after this was built (' + n + (n === 1 ? ' edit' : ' edits') + ').',
        rebuild: 'Rebuild ' + (a.title || 'this artifact') + ' from ' + from + '.',
      };
    }
    return { from, stale: false, line: '', rebuild: '' };
  }
  /* The card's second line: what it is and where it lives ("Artifact · HTML page · v2 · kept with this chat, view only"); a card
     still publishing or failed says only that. `fromDoc` (a "built from" link) names the doc page it shows. */
  function cardLine(m) {
    if (!m) return '';
    if (!m.canOpen) return m.sub;
    return ['Artifact', m.sub, m.builtFrom ? 'built from ' + m.builtFrom : 'kept with this chat, view only'].join(' · ');
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
  /* The artifact of a file: a live or archived one before a deleted one (a rewrite after a Delete is a new artifact). */
  const bySource = (artifacts, path) => {
    const hits = (artifacts || []).filter((a) => a && sameFile(a.sourcePath, path));
    return hits.find((a) => !isDeleted(a)) || hits[0] || null;
  };
  function outputsCardModel(path, artifacts, nowMs, version) {
    const art = bySource(artifacts, path);
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
      state: stateWord(artState(art)),
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
    isDocHistory,
    isDeleted,
    isArchived,
    isLive,
    liveOf,
    artState,
    stateWord,
    dayText,
    whenText,
    fileSentence,
    keptWhy,
    deletedLine,
    deletedStage,
    archivedStrip,
    archiveNote,
    deleteNote,
    restoreNote,
    rowMenuItems,
    hiddenCounts,
    bySource,
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
    cardLine,
    builtBanner,
    docPageName,
    barAction,
    blockAt,
    EDIT_TIP,
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
    doc: null, // the doc shown in the viewer: {name, title, page, block, thread}
    docExtras: [], // docs this chat opened or made that the doc list does not link to it (yet)
    foot: { archived: false, deleted: false }, // the picker's foot groups you opened
    confirmPurge: '', // the Recently deleted row showing "Delete for good? … Delete for good · Keep"
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
  const pickable = (a) => !isArchived(a) && !isDeleted(a);
  const known = (id) => S.list.find((a) => a.id === id) || S.extras[id] || null;
  const current = () => known(S.selId);
  const editors = () => {
    const e = win.AgentEditors;
    return e && typeof e.openFile === 'function' && (typeof e.canOpenFile !== 'function' || e.canOpenFile()) ? e : null;
  };

  async function getToken(force) {
    if (S.token && !force) return S.token;
    const r = await win.fetch('/api/live/bootstrap');
    if (!r.ok) throw new Error('AIB is not reachable');
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
    const first = (S.list.find(pickable) || {}).id || ''; // the viewer's own pick is never an archived or deleted artifact
    const added = before.size ? S.list.filter((a) => !before.has(a.id)) : [];
    // the viewer's own pick (not yours) leaves an artifact archived or deleted elsewhere; yours shows its strip or Restore message
    const ownPickHidden = !S.userPicked && !S.extras[S.selId] && !!known(S.selId) && !pickable(known(S.selId));
    if (!known(S.selId) || ownPickHidden || (following() && S.selId !== first && !S.extras[S.selId])) {
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
    if (S.fresh && !isDocId(S.fresh) && (S.fresh === S.selId || !known(S.fresh))) S.fresh = '';
    paintCount();
    relinkAll();
    refreshCards();
    paintAll();
    if (S.dirty) paintStage('auto');
  }
  /* The summary is the truth for these: a field it leaves out is unset (a replayed Archive then Unarchive ends live, break 5). */
  const FLAGS = ['archivedAt', 'deletedAt', 'purgeAt', 'deletedFile', 'sourceMissing', 'sourceCopy', 'becameDoc'];
  function upsert(summary) {
    if (!summary || !summary.id) return;
    if (summary.purged) return dropPurged(summary.id);
    const inList = S.list.findIndex((a) => a.id === summary.id),
      old = inList < 0 ? S.extras[summary.id] : S.list[inList];
    const next = Object.assign({}, old, summary);
    for (const k of FLAGS) if (!(k in summary)) delete next[k];
    setLinkState(summary.id, artState(next));
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
  /* "Delete now" or the 30-day purge removed it for good: out of the list, its links read deleted. */
  function dropPurged(id) {
    setLinkState(id, 'gone');
    delete S.extras[id];
    delete S.items[id];
    if (S.confirmPurge === id) S.confirmPurge = '';
    if (S.list.some((a) => a.id === id)) setList(S.list.filter((a) => a.id !== id));
    else paintAll();
    repaintPicker();
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
      // deleted=1: Recently deleted too (the picker's foot group); only this panel asks for them
      const d = await api('/api/live/artifacts?' + q({ conversationId: id, deleted: 1 }));
      if (mine !== S.listSeq || id !== S.chat.id) return;
      const sig = (a) => [a.id, a.version, a.pinned ? 1 : 0, a.title, a.archivedAt || 0, a.deletedAt || 0].join(':');
      const prior = S.list.map(sig).join('|');
      const next = Array.isArray(d.artifacts) ? d.artifacts : [];
      for (const a of next) setLinkState(a.id, artState(a));
      const sel = current();
      const cur = sel && next.find((a) => a.id === sel.id);
      if (next.map(sig).join('|') !== prior) {
        const versionChanged = !!cur && num(cur.version) !== num(sel.version);
        if (versionChanged) delete S.items[cur.id];
        if (versionChanged) holdCompare(cur.id);
        setList(next);
        if (versionChanged && S.picked == null) paintStage('update');
        repaintPicker();
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
      S.doc = null;
      S.docExtras = [];
      S.foot = { archived: false, deleted: false };
      S.confirmPurge = '';
      dropDoc();
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
    syncViewing();
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
        // the fields summary() gives, the archive and Recently deleted ones too (break 8)
        const ex = {
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
          fromDoc: it.fromDoc || null,
        };
        for (const k of FLAGS) if (it[k] != null) ex[k] = it[k];
        S.extras[id] = ex;
        S.items[id] = it;
        setLinkState(id, artState(ex));
      } catch (e) {
        if (e.status === 404) setLinkState(id, 'gone');
        note(e.status === 404 ? 'That artifact is no longer in AIB.' : 'That artifact could not be opened: ' + e.message);
        return false;
      }
    }
    S.selId = id;
    S.userPicked = true;
    S.doc = null;
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
    const wasDoc = !!S.doc;
    S.doc = null;
    if (id === S.selId && !wasDoc) return;
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
  /* One message; with `undo` (a function) it carries an Undo button, stays 10 s instead of 5, and never hides while the pointer is on
     it (the time left starts again when the pointer leaves, at least 1.5 s). */
  let noteTimer = 0,
    noteLeft = 0,
    noteFrom = 0,
    noteHover = false;
  const NOTE_MS = 5000,
    UNDO_MS = 10000;
  function noteArm(ms) {
    if (noteTimer) win.clearTimeout(noteTimer);
    noteTimer = 0;
    noteLeft = ms;
    noteFrom = Date.now();
    if (noteHover) return;
    noteTimer = win.setTimeout(() => {
      noteTimer = 0;
      ui.note.hidden = true;
      ui.noteUndo.hidden = true;
      ui.noteUndo.onclick = null;
    }, ms);
  }
  function note(msg, undo) {
    if (!ui) return;
    ui.noteText.textContent = msg || '';
    ui.note.hidden = !msg;
    ui.noteUndo.hidden = !(msg && typeof undo === 'function');
    ui.noteUndo.disabled = false;
    ui.noteUndo.onclick = ui.noteUndo.hidden
      ? null
      : () => {
          ui.noteUndo.disabled = true;
          ui.noteUndo.onclick = null;
          undo();
        };
    if (noteTimer) win.clearTimeout(noteTimer);
    noteTimer = 0;
    if (msg) noteArm(ui.noteUndo.hidden ? NOTE_MS : UNDO_MS);
  }
  function noteHold(on) {
    noteHover = on;
    if (ui.note.hidden) return;
    if (on) {
      if (noteTimer) win.clearTimeout(noteTimer);
      noteTimer = 0;
      noteLeft = Math.max(0, noteLeft - (Date.now() - noteFrom));
    } else noteArm(Math.max(1500, noteLeft));
  }

  /* -- local docs: doc-links.js keeps the project's doc list. A doc from this chat (its card, a link, /doc, the picker's "Docs this
     chat wrote", Open doc) opens here, in the full doc editor (doc.html in a frame; files-ui.js answers the frame's messages). A
     doc an agent makes while you watch is announced, not opened: the tab's count goes up and its row is marked new. -- */
  const DL = () => win && win.AgentDocLinks;
  const FUI = () => win && win.AgentFilesUI;
  const isDocId = (id) => String(id || '').indexOf('doc:') === 0;
  let docsAsked = '',
    docsHooked = false;
  function projectDocs() {
    const D = DL();
    if (!D || !S.chat.id) return S.docExtras.slice();
    if (!docsHooked && D.onList) {
      docsHooked = true;
      D.onList(() => paintAll());
    }
    const now = D.cached(S.chat.id, 'main');
    if (!now && docsAsked !== S.chat.id) {
      docsAsked = S.chat.id;
      D.listFor(S.chat.id, 'main').then(() => paintAll());
    }
    return (now || []).concat(S.docExtras);
  }
  function chatKeys() {
    const FU = FUI(),
      c = FU && FU.currentChat ? FU.currentChat() : null;
    return [S.chat.id, c && c.key, c && c.id].filter(Boolean);
  }
  /* This chat's docs for the picker and the count: the docs linked to it, plus the ones it opened or made here; one row a doc. */
  function myDocs() {
    const out = [];
    for (const d of linkedDocs(projectDocs(), chatKeys())) if (!out.some((o) => o.name === d.name)) out.push(d);
    return out;
  }
  function rememberDoc(d) {
    if (myDocs().some((o) => o.name === d.name)) return;
    const all = (DL() && DL().cached(S.chat.id, 'main')) || [];
    const hit = all.find((o) => o.name === d.name);
    S.docExtras = S.docExtras
      .filter((o) => o.name !== d.name)
      .concat([Object.assign({}, hit || { name: d.name, title: d.title || d.name, pages: 1 }, { chat: S.chat.id })]);
  }
  const docTitle = (name) => {
    const hit = myDocs().find((d) => d.name === name);
    return (hit && (hit.title || hit.name)) || (S.doc && S.doc.name === name ? S.doc.title : '') || name;
  };
  /* Open a doc in the viewer. opts: {chat: the chat it came from (another chat's doc is not shown here: false), background: an
     agent made it (mark it new, never switch to it, never take the focus)}. Returns whether it is shown or announced here. */
  function openDoc(d, opts) {
    opts = opts || {};
    if (!S.mounted || !ui || !d || !d.name || !S.chat.id) return false;
    if (opts.chat && opts.chat !== S.chat.id) return false;
    rememberDoc(d);
    if (opts.background) {
      if (!(S.doc && S.doc.name === d.name)) S.fresh = 'doc:' + d.name;
      paintAll();
      return true;
    }
    const same = !!(S.doc && S.doc.name === d.name && ui.docFrame && ui.docFrame.parentNode === ui.stage);
    S.doc = { name: d.name, title: d.title || docTitle(d.name), page: d.page || '', block: d.block || '', thread: d.thread || '' };
    S.userPicked = true;
    if (S.fresh === 'doc:' + d.name) S.fresh = '';
    if (same) {
      if (d.page || d.block || d.thread)
        try {
          ui.docFrame.contentWindow.postMessage({ type: 'aib-doc:goto', page: d.page || '', block: d.block || '', thread: d.thread || '' }, win.location.origin);
        } catch (e) {
          /* still loading */
        }
    } else {
      S.dirty = true;
      S.stageKey = '';
    }
    ui.reveal();
    paintAll();
    paintStage('open');
    return true;
  }
  function openDocRow(it) {
    openDoc({ name: it.name, title: it.title });
  }
  function docButton(it) {
    const row = popItem('ar-doc' + (it.on ? ' on' : '') + (it.fresh ? ' ar-new' : ''));
    row.dataset.doc = it.name;
    row.append(el('span', 'ar-k', it.badge), el('span', 'ar-it-title', it.title), el('span', 'ar-it-meta', it.meta));
    if (it.fresh) row.append(newDot());
    row.title = 'Open ' + it.title + ' here';
    row.setAttribute('aria-label', it.title + ', ' + it.meta + (it.fresh ? ', new' : ''));
    row.addEventListener('click', () => {
      closePop();
      openDocRow(it);
    });
    return row;
  }
  /* The mark on a row that came while you were not looking (the "New: …" line names it too). */
  function newDot() {
    const d = el('span', 'ar-newdot');
    d.setAttribute('aria-hidden', 'true');
    d.title = 'New';
    return d;
  }
  /* The doc frame: kept while the viewer shows that doc, dropped (and its messages forgotten) when anything else is shown. */
  let docRec = null;
  function dropDoc() {
    if (docRec) docRec.detach();
    docRec = null;
    if (ui && ui.docFrame) {
      if (ui.docFrame.parentNode) ui.docFrame.remove();
      ui.docFrame = null;
    }
  }
  function paintDocStage() {
    if (!S.visible) {
      S.dirty = true;
      return;
    }
    S.dirty = false;
    const key = 'doc:' + S.doc.name;
    if (S.stageKey === key && ui.docFrame && ui.docFrame.parentNode === ui.stage) return;
    S.renderSeq++;
    S.stageKey = key;
    const D = DL(),
      d = S.doc;
    const f = el('iframe', 'ar-frame ar-docframe');
    f.title = 'Doc: ' + (d.title || d.name);
    f.src = D && D.docUrl ? D.docUrl({ chat: S.chat.id, name: d.name, page: d.page, block: d.block, thread: d.thread, where: 'artifacts' }) : 'about:blank';
    dropDoc();
    ui.docFrame = f;
    setStage(f);
    ui.docFrame = f;
    const FU = FUI();
    if (FU && FU.attachDocFrame)
      docRec = FU.attachDocFrame(f, { id: S.chat.id, root: 'main', label: 'Folder', branch: '', chatKey: '', title: '' }, d, {
        open: (o) => openDoc(o),
        title: (t) => {
          if (!S.doc || S.doc.name !== d.name) return;
          if (t.title) S.doc.title = t.title;
          if (t.page) S.doc.page = t.page;
          f.title = 'Doc: ' + S.doc.title;
          paintBar();
        },
        closed: () => {
          if (!S.doc || S.doc.name !== d.name) return;
          S.doc = null;
          S.docExtras = S.docExtras.filter((o) => o.name !== d.name);
          dropDoc();
          if (D && D.forget) D.forget();
          S.stageKey = '';
          S.dirty = true;
          paintAll();
          paintStage('open');
        },
      });
  }
  function paintDocBar() {
    const d = S.doc;
    ui.bar.hidden = false;
    ui.stage.hidden = false;
    ui.empty.hidden = true;
    ui.foot.hidden = true;
    for (const n of [ui.avail, ui.built, ui.stale, ui.became, ui.ver, ui.ext, ui.more, ui.edit, ui.request]) n.hidden = true;
    const others = liveOf(S.list).length + myDocs().filter((o) => o.name !== d.name).length;
    const plain = others === 0 && !hiddenCounts(S.list);
    ui.pick.replaceChildren(el('span', 'ar-k', 'doc'), el('span', 'ar-pick-title', d.title || d.name));
    if (!plain) ui.pick.append(el('span', 'ar-caret', '▾'));
    ui.pick.disabled = plain;
    ui.pick.classList.toggle('plain', plain);
    ui.pick.title = (d.title || d.name) + ' (doc)';
    ui.pick.setAttribute('aria-haspopup', plain ? 'false' : 'menu');
    paintFresh();
  }
  function freshInfo() {
    if (!S.fresh) return null;
    if (isDocId(S.fresh)) return { title: docTitle(S.fresh.slice(4)) };
    return known(S.fresh);
  }
  function paintFresh() {
    const fresh = freshInfo();
    ui.fresh.hidden = !fresh;
    if (fresh) ui.freshText.textContent = 'New: ' + (fresh.title || 'Untitled') + ' · ';
  }
  /* A group's head: a divider before "Docs this chat wrote", its label and its note line. */
  function groupHead(g) {
    const out = [];
    if (g.divider) out.push(el('div', 'ar-sep'));
    out.push(el('div', 'ar-gh', g.label));
    if (g.note) out.push(el('div', 'ar-gnote', g.note));
    return out;
  }
  /* No artifacts yet: the docs this chat wrote still show, under the empty text. */
  function paintEmptyDocs() {
    if (!ui) return;
    let box = ui.empty.querySelector('.ar-docs-empty');
    const groups = pickerGroups([], '', undefined, myDocs(), chatKeys(), S.fresh);
    if (!groups.length) {
      if (box) box.remove();
      return;
    }
    if (!box) {
      box = el('div', 'ar-docs-empty');
      ui.empty.append(box);
    }
    box.replaceChildren();
    for (const g of groups) {
      box.append(...groupHead(g));
      for (const it of g.items) box.append(docButton(it));
    }
  }

  /* -- painting: tab badge, toolbar, banner -- */
  function paintCount() {
    if (!ui) return;
    const a = liveOf(S.list).length, // archived and deleted ones are not counted
      dn = myDocs().length,
      n = a + dn;
    ui.badge.textContent = n > 99 ? '99+' : String(n);
    ui.badge.hidden = !n;
    const parts = [];
    if (a) parts.push(a + (a === 1 ? ' artifact' : ' artifacts'));
    if (dn) parts.push(dn + (dn === 1 ? ' doc' : ' docs'));
    ui.tab.setAttribute('aria-label', 'Artifacts' + (parts.length ? ', ' + parts.join(' and ') : '') + (S.fresh ? ', something new' : ''));
  }
  /* body.ar-viewing: a doc or artifact is showing in the visible Artifacts tab (resize-ui.js widens the column to 600 px). */
  function syncViewing() {
    const b = win && win.document && win.document.body;
    if (b) b.classList.toggle('ar-viewing', !!(ui && S.visible && !ui.stage.hidden));
  }
  function paintBar() {
    if (!ui) return;
    paintBar2();
    syncViewing();
  }
  function paintBar2() {
    if (S.doc) return paintDocBar();
    const a = current(),
      none = !a,
      gone = isDeleted(a); // in Recently deleted: no versions, no page to open
    ui.ver.hidden = gone;
    ui.ext.hidden = gone;
    ui.more.hidden = false;
    ui.bar.hidden = none;
    ui.foot.hidden = none || gone || S.mode !== 'page' || viewMode(a.kind) !== 'page'; // the sandbox line is about the page view (QA c6)
    ui.stage.hidden = none; // the empty text starts at the top, no blank band above it (QA c3)
    ui.empty.hidden = !none;
    paintArchivedStrip(a);
    if (none) {
      ui.avail.hidden = true;
      ui.fresh.hidden = true;
      paintEmptyHidden();
      paintEmptyDocs();
      return;
    }
    const plain = pickerIsPlain(S.list.length ? S.list : [a], myDocs(), chatKeys());
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
    paintFresh();
    ui.more.setAttribute('aria-label', 'More');
    paintBuilt(a);
    paintBecame(a);
  }
  /* "Archived 2 d ago. Hidden from this chat's list. · Unarchive" over an archived artifact; the page shows as usual. */
  function paintArchivedStrip(a) {
    if (!ui) return;
    const on = !S.doc && isArchived(a);
    ui.archived.hidden = !on;
    if (on) ui.archivedText.textContent = archivedStrip(a) + ' · ';
  }
  /* Nothing live left: "Nothing showing." and "Archived 18 · Recently deleted 4", each opening the picker on its group (break 7). */
  function paintEmptyHidden() {
    const c = hiddenCounts(S.list);
    ui.emptyTitle.textContent = c ? 'Nothing showing.' : 'No artifacts in this chat yet';
    ui.emptyHint.hidden = !!c;
    ui.emptyHidden.hidden = !c;
    const sig = c ? c.archived + ':' + c.deleted : '';
    if (!c || ui.emptyHidden.dataset.sig === sig) return; // drawn again only when the counts change (the open picker hangs from it)
    ui.emptyHidden.dataset.sig = sig;
    const parts = [];
    const link = (group, label, n) => {
      const b = el('button', 'ar-switch ar-hidden-open', label + ' ' + n);
      b.type = 'button';
      b.dataset.group = group;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openPicker(null, { anchor: b, group });
      });
      return b;
    };
    if (c.archived) parts.push(link('archived', 'Archived', c.archived));
    if (c.deleted) {
      if (parts.length) parts.push(doc.createTextNode(' · '));
      parts.push(link('deleted', 'Recently deleted', c.deleted));
    }
    ui.emptyHidden.replaceChildren(...parts);
  }
  /* -- Edit: a Markdown artifact becomes a doc; the viewer then shows the doc's text as it is now -- */
  const becameStates = new Map(); // artifact id -> {at, state, loading}
  const BECAME_MS = 2000;
  function becameState(a) {
    const rec = becameStates.get(a.id);
    if (!(rec && (rec.loading || Date.now() - rec.at < BECAME_MS)) && S.chat.id) {
      const next = { at: Date.now(), state: rec ? rec.state : null, loading: true };
      becameStates.set(a.id, next);
      api('/api/live/docs/became?' + q({ id: S.chat.id, artifact: a.id })).then(
        (r) => {
          const before = JSON.stringify(next.state);
          next.state = (r && r.became) || null;
          next.loading = false;
          next.at = Date.now();
          const cur = current();
          if (cur && cur.id === a.id) {
            paintBecame(cur);
            if (JSON.stringify(next.state) !== before && livePreview(cur)) paintLive(cur);
          }
        },
        () => {
          next.loading = false;
          next.at = Date.now();
        },
      );
    }
    return rec ? rec.state : null;
  }
  function paintBecame(a) {
    if (!ui) return;
    const act = barAction(a);
    ui.edit.hidden = act !== 'edit' || !S.chat.id;
    ui.request.hidden = act !== 'request';
    const name = a && a.becameDoc;
    ui.became.hidden = !name;
    if (!name) return;
    const st = becameState(a);
    ui.becameText.replaceChildren(doc.createTextNode('Now a doc: '), el('b', '', (st && st.title) || name), doc.createTextNode(' \u00b7 '));
    const undo = !!(st && st.undo);
    ui.undoBtn.hidden = !undo;
    ui.becameSep.hidden = !undo;
  }
  /* The latest version of a became-doc artifact shows the doc's text now (read-only), refreshed while the column shows it; an older
     version (v1..vN) is the frozen file as before. */
  const livePreview = (a) => !!(a && a.becameDoc && S.picked == null && S.mode === 'page');
  let liveTimer = 0;
  function paintLive(a) {
    const st = becameState(a);
    const box = el('div', 'ar-live markdown');
    box.setAttribute('aria-label', 'The doc as it is now (read-only)');
    if (st && st.gone) box.append(el('p', 'ar-msg', 'The doc "' + st.name + '" is gone. The versions above still show what it was.'));
    else if (!st) box.append(el('p', 'ar-msg', 'Reading the doc\u2026'));
    else {
      const M = win.AgentMarkdown;
      if (M && M.render) M.render(box, st.markdown || '');
      else box.append(el('pre', 'ar-src', st.markdown || ''));
    }
    const nv = num(a.version) || 1;
    box.append(el('p', 'ar-live-note', nv > 1 ? 'Versions 1\u2013' + nv + ' stay here as read-only history' : 'Version 1 stays here as read-only history'));
    setStage(box);
    if (liveTimer) win.clearTimeout(liveTimer);
    liveTimer = win.setTimeout(() => {
      liveTimer = 0;
      const cur = current();
      if (S.visible && cur && cur.id === a.id && livePreview(cur)) becameState(cur);
    }, BECAME_MS);
    if (liveTimer && liveTimer.unref) liveTimer.unref();
  }
  async function editAsDoc() {
    const a = current();
    if (!a || barAction(a) !== 'edit' || !S.chat.id) return;
    // how far down the viewer is reading (the frame's own scroll is another origin's: the stage's position stands in)
    const st = ui.stage,
      frac = st && st.scrollHeight > st.clientHeight ? st.scrollTop / (st.scrollHeight - st.clientHeight) : S.scroll && S.scroll.f ? S.scroll.f : 0;
    ui.edit.disabled = true;
    try {
      const r = await api('/api/live/docs/from-artifact', { id: S.chat.id, artifact: a.id });
      upsert(Object.assign({}, a, { becameDoc: r.name }));
      const D = DL();
      if (D && D.openDoc) D.openDoc({ name: r.name, title: r.title, block: blockAt(r.blocks, frac), chat: { id: S.chat.id }, from: 'chat' });
      S.stageKey = '';
      paintAll();
      paintStage('refresh');
    } catch (e) {
      note('Could not make the doc: ' + e.message);
    } finally {
      ui.edit.disabled = false;
    }
  }
  function openBecameDoc() {
    const a = current(),
      D = DL();
    if (!a || !a.becameDoc || !D || !D.openDoc) return;
    D.openDoc({ name: a.becameDoc, chat: { id: S.chat.id }, from: 'chat' });
  }
  async function undoEdit() {
    const a = current();
    if (!a || !a.becameDoc) return;
    try {
      await api('/api/live/docs/from-artifact/undo', { id: S.chat.id, artifact: a.id });
      const next = Object.assign({}, a);
      delete next.becameDoc;
      const i = S.list.findIndex((x) => x.id === a.id);
      if (i >= 0) {
        const list = S.list.slice();
        list[i] = next;
        setList(list);
      } else S.extras[a.id] = next;
      becameStates.delete(a.id);
      if (DL() && DL().forget) DL().forget();
      S.stageKey = '';
      paintAll();
      paintStage('refresh');
      note('Undone: the doc is gone and this is an artifact again.');
    } catch (e) {
      note(e.message);
      becameStates.delete(a.id);
      paintBecame(a);
    }
  }
  /* Request a change: the artifact goes into the message box as a link chip, the box gets the focus for the words. */
  function requestChange() {
    const a = current();
    const box = doc.getElementById('prompt');
    if (!a || !box) return;
    const link = '[' + String(a.title || 'Artifact').replace(/[\[\]]/g, '') + '](studio-artifact://' + a.id + ') ';
    if (!String(box.value || '').includes('studio-artifact://' + a.id)) box.value = link + String(box.value || '');
    try {
      box.dispatchEvent(new win.Event('input', { bubbles: true }));
    } catch (e) {
      /* no Event here */
    }
    if (box.focus) box.focus();
    if (box.setSelectionRange) box.setSelectionRange(box.value.length, box.value.length);
  }
  /* -- "Built from <doc › page>": the banner, the stale line and "Rebuild from the doc" -- */
  const builtStates = new Map(); // artifact id -> {at, version, state, loading}
  const BUILT_TTL = 5000;
  function builtState(a) {
    const rec = builtStates.get(a.id);
    const fresh = rec && rec.version === num(a.version) && Date.now() - rec.at < BUILT_TTL;
    if (!fresh && !(rec && rec.loading) && S.chat.id) {
      const next = { at: Date.now(), version: num(a.version), state: rec ? rec.state : null, loading: true };
      builtStates.set(a.id, next);
      api('/api/live/docs/built?' + q({ id: S.chat.id, artifact: a.id })).then(
        (r) => {
          next.state = (r && r.built) || null;
          next.loading = false;
          next.at = Date.now();
          if (current() && current().id === a.id) paintBuilt(current());
        },
        () => {
          next.loading = false;
        },
      );
    }
    return rec ? rec.state : null;
  }
  function paintBuilt(a) {
    if (!ui) return;
    const b = a ? builtBanner(a, a.fromDoc ? builtState(a) : null) : null;
    ui.built.hidden = !b;
    ui.stale.hidden = !(b && b.stale);
    if (!b) return;
    ui.builtText.replaceChildren(doc.createTextNode('Built from '), el('b', '', b.from), doc.createTextNode(b.gone ? (b.gone === 'page' ? ' (that page was deleted)' : ' (that doc is gone)') : ' · '));
    ui.built.querySelector('.ar-built-open').hidden = !!b.gone;
    if (b.stale) ui.staleText.textContent = b.line + ' ';
  }
  function openBuiltDoc() {
    const a = current(),
      f = a && a.fromDoc,
      D = DL();
    if (!f || !D || !D.openDoc) return;
    D.openDoc({ name: f.doc, title: f.title, page: f.page, chat: { id: S.chat.id }, from: 'chat' });
  }
  /* "Rebuild from the doc": a normal message to this chat, as if typed ("Rebuild Checkout v2 timeline from Release plan › Rollout."). */
  function rebuild() {
    const a = current();
    if (!a) return;
    const b = builtBanner(a, builtState(a));
    if (!b || !b.rebuild) return;
    const box = doc.getElementById('prompt'),
      form = doc.getElementById('promptForm');
    if (!box || !form) return;
    if (String(box.value || '').trim()) {
      note('Send or clear your draft first: Rebuild from the doc sends a message to this chat.');
      return;
    }
    box.value = b.rebuild;
    try {
      box.dispatchEvent(new win.Event('input', { bubbles: true })); // the composer sizes itself and keeps its draft state
    } catch (e) {
      /* no Event here */
    }
    if (form.requestSubmit) form.requestSubmit();
    else form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    const rec = builtStates.get(a.id);
    if (rec) rec.at = 0; // asked again on the next paint (the agent's update moves the rev)
  }
  function paintAll() {
    paintCount();
    paintBar();
  }

  /* -- stage -- */
  function setStage(node) {
    if (!ui) return;
    if (!(ui.docFrame && node === ui.docFrame)) dropDoc();
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
    dropDoc();
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
  /* The viewer on a deleted artifact: '"Report" is in Recently deleted until 12 Dec. outputs/report.html went too; … Restore' */
  function deletedView(a) {
    const box = el('div', 'ar-deleted');
    const p = el('p', 'ar-msg', deletedStage(a) + (fileSentence(a.deletedFile) ? ' ' + fileSentence(a.deletedFile) : '') + ' ');
    const b = el('button', 'ar-switch ar-restore', 'Restore');
    b.type = 'button';
    b.addEventListener('click', () => doUndelete(a.id));
    p.append(b);
    box.append(p);
    return box;
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
    if (S.doc) return paintDocStage();
    const a = current();
    if (!a) {
      S.dirty = false;
      S.stageKey = '';
      dropDoc();
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
    if (isDeleted(a)) {
      setStage(deletedView(a)); // a message and Restore, not the page
      return;
    }
    if (livePreview(a) && ver === latest) {
      paintLive(a);
      return;
    }
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
    closeRowMenu();
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
  /* opts: {anchor: the element it hangs from (the empty state's "Archived 18"), group: open that foot group, keep: draw it again in
     place (after an action), keeping its scroll and the focused control}. */
  async function openPicker(ev, opts) {
    opts = opts || {};
    if (ui.popFor === 'pick' && !opts.keep && !opts.group) {
      closePop();
      return;
    }
    const was = opts.keep ? { top: ui.pop.scrollTop, key: focusKey() } : null;
    closePop();
    const a = current(),
      docs = myDocs(),
      hidden = hiddenCounts(S.list);
    if (!a && !S.doc && !hidden) return;
    const emptyLink = () =>
      ui.emptyHidden.hidden ? null : ui.emptyHidden.querySelector('[data-group="' + ((opts.anchor && opts.anchor.dataset.group) || '') + '"]') || ui.emptyHidden.querySelector('.ar-hidden-open');
    const anchor = opts.anchor && opts.anchor.isConnected !== false ? opts.anchor : !ui.bar.hidden ? ui.pick : emptyLink();
    if (!anchor) return;
    if (anchor === ui.pick && (S.doc ? ui.pick.disabled : pickerIsPlain(S.list, docs, chatKeys()))) return;
    // A foot group that was emptied while open (the last archived artifact left it) says "Nothing archived." only until the picker
    // closes: opened again, it is gone, like any group with nothing in it.
    if (!opts.keep) {
      const l = Array.isArray(S.list) ? S.list : [];
      if (!l.some(isArchived)) S.foot.archived = false;
      if (!l.some(isDeleted)) S.foot.deleted = false;
    }
    if (opts.group) S.foot[opts.group] = true;
    ui.popFor = 'pick';
    ui.popAnchor = anchor;
    if (anchor === ui.pick) ui.pick.setAttribute('aria-expanded', 'true');
    const sel = S.doc ? 'doc:' + S.doc.name : a ? a.id : '';
    const groups = pickerGroups(S.list, sel, undefined, docs, chatKeys(), S.fresh, S.foot);
    const frag = doc.createDocumentFragment();
    for (const g of groups) {
      if (g.foot) {
        if (g.divider) frag.append(el('div', 'ar-sep'));
        frag.append(footHead(g));
        if (g.open && g.empty) frag.append(el('div', 'ar-gnote ar-foot-empty', g.empty));
      } else frag.append(...groupHead(g));
      for (const it of g.items) {
        if (it.doc) frag.append(docButton(it));
        else if (it.deleted) frag.append(deletedRow(it));
        else frag.append(artifactRow(it));
      }
    }
    ui.pop.replaceChildren(frag);
    ui.pop.setAttribute('aria-label', 'Artifacts and docs in this chat');
    placePop(anchor, false);
    if (was) ui.pop.scrollTop = was.top;
    const back = was && was.key ? ui.pop.querySelector('[data-key="' + was.key + '"]') : null;
    const target = opts.group ? ui.pop.querySelector('[data-key="foot:' + opts.group + '"]') : null;
    if (back || target) (back || target).focus({ preventScroll: !!back });
    else focusFirst();
  }
  /* Draw the open picker again after its list changed (an action, an event, the poll). */
  function repaintPicker() {
    if (ui && ui.popFor === 'pick') openPicker(null, { keep: true, anchor: ui.popAnchor });
  }
  const focusKey = () => {
    const f = doc.activeElement;
    return f && ui.pop.contains(f) && f.getAttribute ? f.getAttribute('data-key') || '' : '';
  };
  /* "▸ Archived 18": a closed group at the foot; a click opens or closes it. */
  function footHead(g) {
    const b = el('button', 'ar-it ar-foothead' + (g.open ? ' open' : ''));
    b.type = 'button';
    b.setAttribute('data-key', 'foot:' + g.key);
    b.setAttribute('aria-expanded', g.open ? 'true' : 'false');
    b.append(el('span', 'ar-foot-caret', g.open ? '▾' : '▸'), el('span', 'ar-it-title', g.label), el('span', 'ar-foot-n', String(g.count)));
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      S.foot[g.key] = !S.foot[g.key];
      repaintPicker();
    });
    return b;
  }
  /* A live or archived artifact's row: badge, title, meta, ⋯ (shown on hover and focus) and, live only, the pin star. Right-click
     (or the keyboard's menu key) opens the same menu as ⋯. */
  function artifactRow(it) {
    const row = popItem((it.on ? 'on' : '') + (it.fresh ? ' ar-new' : '') + (it.archived ? ' ar-archived-row' : ''));
    row.dataset.id = it.id;
    row.setAttribute('data-key', 'row:' + it.id);
    const dots = el('span', 'ar-dots', '⋯');
    dots.setAttribute('role', 'button');
    dots.setAttribute('aria-label', 'More for ' + it.title);
    dots.setAttribute('aria-haspopup', 'menu');
    dots.title = 'More';
    dots.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      openRowMenu(it.id, dots, row);
    });
    row.append(el('span', 'ar-k', it.badge), el('span', 'ar-it-title', it.title), el('span', 'ar-it-meta', it.meta), dots);
    if (!it.archived) {
      const star = el('span', 'ar-star' + (it.pinned ? ' on' : ''), it.pinned ? '★' : '☆');
      star.setAttribute('role', 'button');
      star.setAttribute('aria-label', it.pinned ? 'Unpin ' + it.title : 'Pin ' + it.title);
      star.title = it.pinned ? 'Unpin' : 'Pin';
      star.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        togglePin(it.id);
      });
      row.append(star);
    }
    if (it.fresh) row.insertBefore(newDot(), dots);
    row.addEventListener('click', () => {
      closePop();
      selectArtifact(it.id);
    });
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openRowMenu(it.id, row, row, ev);
    });
    return row;
  }
  /* A Recently deleted row: title, "Deleted 12 Nov, 14:02. Removed for good on 12 Dec. <the file>", Restore and Delete now. Delete now
     turns into "Delete for good? This can't be undone. Delete for good · Keep" in the row itself (no pop-up). */
  function deletedRow(it) {
    const box = el('div', 'ar-del');
    box.dataset.id = it.id;
    const head = el('div', 'ar-del-head');
    head.append(el('span', 'ar-k', it.badge), el('span', 'ar-it-title', it.title));
    box.append(head, el('div', 'ar-del-line', it.line));
    const btn = (cls, label, key, fn) => {
      const b = el('button', 'ar-nav ' + cls, label);
      b.type = 'button';
      b.setAttribute('data-key', key + ':' + it.id);
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        fn();
      });
      return b;
    };
    if (S.confirmPurge === it.id) {
      const c = el('div', 'ar-confirm');
      c.setAttribute('role', 'group');
      c.append(
        el('span', 'ar-confirm-t', "Delete for good? This can't be undone."),
        btn('ar-btn-danger', 'Delete for good', 'forgood', () => doPurge(it.id)),
        btn('ar-btn-plain', 'Keep', 'keep', () => {
          S.confirmPurge = '';
          repaintPicker();
        }),
      );
      box.append(c);
    } else {
      const acts = el('div', 'ar-del-acts');
      acts.append(
        btn('ar-btn-plain', 'Restore', 'restore', () => doUndelete(it.id)),
        btn('ar-btn-plain ar-btn-dng', 'Delete now', 'purge', () => {
          S.confirmPurge = it.id;
          repaintPicker();
          const k = ui.pop.querySelector('[data-key="keep:' + it.id + '"]');
          if (k) k.focus({ preventScroll: true });
        }),
      );
      box.append(acts);
    }
    return box;
  }
  /* -- a row's ⋯ menu (and right-click) -- */
  function closeRowMenu() {
    if (!ui || !ui.rowPop || ui.rowPop.hidden) return;
    ui.rowPop.hidden = true;
    ui.rowPop.replaceChildren();
    ui.rowFor = null;
  }
  function openRowMenu(id, anchor, row, ev) {
    const a = known(id);
    closeRowMenu();
    const items = rowMenuItems(a);
    if (!items.length) return;
    ui.rowFor = { id, row };
    const frag = doc.createDocumentFragment();
    for (const it of items) {
      if (it.sep) frag.append(el('div', 'ar-sep'));
      else if (it.hint) frag.append(el('p', 'ar-rowhint', it.hint));
      else {
        const b = popItem(it.danger ? 'ar-danger' : '');
        b.dataset.id = it.id;
        b.append(el('span', 'ar-it-title', it.label));
        if (it.kb) b.append(el('span', 'ar-kb', it.kb));
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          closeRowMenu();
          runRow(id, it.id);
        });
        frag.append(b);
      }
    }
    ui.rowPop.replaceChildren(frag);
    ui.rowPop.setAttribute('aria-label', 'More for ' + (a.title || 'Untitled'));
    ui.rowPop.hidden = false;
    const v = ui.view,
      vr = v.getBoundingClientRect(),
      k = vr.width && v.offsetWidth ? vr.width / v.offsetWidth : 1,
      ar = anchor.getBoundingClientRect();
    const x = ev && ev.clientX != null ? ev.clientX : ar.right - ui.rowPop.offsetWidth * k,
      y = ev && ev.clientY != null ? ev.clientY : ar.bottom + 2;
    const top = Math.max(4, Math.min((y - vr.top) / k, v.offsetHeight - ui.rowPop.offsetHeight - 4));
    ui.rowPop.style.top = top + 'px';
    ui.rowPop.style.left = placeLeft((x - vr.left) / k, ui.rowPop.offsetWidth, v.offsetWidth) + 'px';
    const first = ui.rowPop.querySelector('.ar-it');
    if (first) first.focus({ preventScroll: true });
  }
  function runRow(id, act) {
    if (act === 'open') {
      closePop();
      selectArtifact(id);
    } else if (act === 'pin') togglePin(id);
    else if (act === 'archive' || act === 'unarchive') doArchive(id, act === 'archive');
    else if (act === 'delete') doDelete(id);
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
      archived: isArchived(a),
      deleted: isDeleted(a),
      sourceCopy: a.sourceMissing && a.sourceCopy ? a.sourceCopy : '',
    });
    ui.popFor = 'menu';
    ui.more.setAttribute('aria-expanded', 'true');
    const frag = doc.createDocumentFragment();
    for (const it of items) {
      if (it.sep) {
        frag.append(el('div', 'ar-sep'));
        continue;
      }
      const b = popItem(it.danger ? 'ar-danger' : '');
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
  async function togglePin(id, pinned) {
    const a = known(id);
    if (!a) return;
    const want = pinned === undefined ? !a.pinned : !!pinned;
    try {
      const s = await api('/api/live/artifacts/pin', { id, pinned: want });
      S.userPicked = true;
      upsert(s && s.id ? s : Object.assign({}, a, { pinned: want }));
      repaintPicker();
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
    } else if (id === 'copycopy') copyText(a.sourceCopy);
    else if (id === 'archive' || id === 'unarchive') doArchive(a.id, id === 'archive');
    else if (id === 'delete') doDelete(a.id);
    else if (id === 'undelete') doUndelete(a.id);
  }
  /* -- Archive, Delete, Restore, Delete now: one click, no dialog; Undo in the note line (only Delete now asks, inline) -- */
  /* The viewer leaves an artifact you archived or deleted for the next live one ("Nothing showing" when none is left). */
  /* An action's answer is newer than a list read already on its way: that read is dropped (the next poll reads again). */
  function staleList() {
    S.listSeq++;
    S.loading = false;
  }
  function moveOff(id) {
    if (S.doc || S.selId !== id) return;
    const next = S.list.find((x) => x.id !== id && pickable(x));
    S.selId = next ? next.id : '';
    S.picked = null;
    S.mode = 'page';
    S.cmp = null;
    S.dirty = true;
    S.stageKey = '';
    paintAll();
    paintStage('open');
  }
  function reselect(id) {
    if (known(id) && S.selId !== id && !S.doc) selectArtifact(id);
  }
  async function doArchive(id, archived, quiet) {
    const a = known(id);
    if (!a) return false;
    try {
      const r = await api('/api/live/artifacts/archive', { conversationId: S.chat.id || a.conversationId, ids: [id], archived });
      const s = ((r && r.artifacts) || []).find((x) => x && x.id === id);
      const unpinned = ((r && r.unpinned) || []).includes(id);
      staleList();
      if (s) upsert(s);
      if (archived) moveOff(id);
      repaintPicker();
      if (!quiet)
        note(archiveNote(a.title, archived, unpinned), async () => {
          if (!(await doArchive(id, !archived, true))) return;
          if (unpinned) await togglePin(id, true);
          if (archived) reselect(id);
          note(archived ? 'Unarchived ' + quoted(a.title) + (unpinned ? ' and pinned again.' : '.') : archiveNote(a.title, true, false));
        });
      return true;
    } catch (e) {
      note(e.message);
      return false;
    }
  }
  async function doDelete(id) {
    const a = known(id);
    if (!a) return;
    try {
      const r = await api('/api/live/artifacts/delete', { id });
      staleList();
      if (r && r.artifact) upsert(r.artifact);
      moveOff(id);
      repaintPicker();
      note(deleteNote(a.title, r && r.file), () => doUndelete(id, true));
    } catch (e) {
      note(e.message); // "Close report.pdf in the other program, then try again." and the like: nothing was changed
    }
  }
  async function doUndelete(id, back) {
    const a = known(id);
    if (!a) return;
    try {
      const r = await api('/api/live/artifacts/undelete', { id });
      staleList();
      delete S.items[id];
      if (r && r.artifact) upsert(r.artifact);
      if (S.selId === id) {
        S.stageKey = '';
        S.dirty = true;
        paintAll();
        paintStage('refresh');
      } else if (back) reselect(id);
      repaintPicker();
      note(restoreNote(a.title, r && r.file));
    } catch (e) {
      note(e.message);
    }
  }
  async function doPurge(id) {
    const a = known(id);
    if (!a) return;
    try {
      await api('/api/live/artifacts/purge', { id });
      staleList();
      S.confirmPurge = '';
      dropPurged(id);
      note(quoted(a.title) + ' is deleted for good.');
    } catch (e) {
      S.confirmPurge = '';
      repaintPicker();
      note(e.message);
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
  const cardSig = (m) => (m ? [m.id, m.title, m.version, m.sub, m.canOpen, m.builtFrom || '', m.state || ''].join('|') : '');
  /* QA m3: an old card shows the version its turn wrote, not the newest. Needs the version times (one item read per artifact). */
  const itemAsked = new Set();
  function cardVersion(card) {
    const art = bySource(S.list, card.dataset.src);
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
    if (card.classList && card.classList.contains('doc-card')) return; // doc-links.js paints doc cards; this one has no data-src or data-op
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
    const ic = el('span', 'art-card-ic art-card-win'),
      body = el('div', 'art-card-body');
    ic.setAttribute('aria-hidden', 'true');
    ic.append(cardIcon(m.badge));
    const title = el('div', 'art-card-title', m.title);
    if (m.state) title.append(el('span', 'artifact-state', ' · ' + m.state)); // decision 8a: the card stays and says so
    body.append(title, el('div', 'art-card-sub', cardLine(m)));
    const acts = el('div', 'art-card-actions');
    const openBtn = el('button', 'art-btn', 'View');
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
  /* The window icon (doc-icons.js), or the kind badge when the page lacks it. */
  function cardIcon(badge) {
    const I = win && win.AIBDocIcons;
    try {
      if (I && I.icon) return I.icon('artifact', 'art-card-svg');
    } catch (e) {
      /* fall back */
    }
    return doc.createTextNode(badge || '');
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
        // Other written files: the row's own "open file" icon (files-ui.js toolFile) opens them in the Files view.
      }
    } catch (e) {}
    return box;
  }

  /* -- links in replies -- */
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
  /* Paths in replies: a path to an existing file in the chat's folder becomes a file link (files-ui.js linkPaths). The artifact
     title links (studio-artifact://, markdown.js) still open the Artifacts viewer. Clicking a path never registers an artifact. */
  function linkify(container) {
    if (!doc || !container) return;
    const FU = win && win.AgentFilesUI;
    if (FU && FU.linkPaths) FU.linkPaths(container);
    decorateLinks(container);
  }
  /* -- link labels: "⧉ Title · archived" / "· deleted" in chat messages (decision 8a). markdown.js stays pure: every render ends in
     linkify() above, which labels the links from what the page knows and asks for the rest in ONE request per draw (break 9). -- */
  const linkStates = new Map(); // artifact id -> 'live' | 'archived' | 'deleted' | 'gone'
  let statesWanted = new Set(),
    statesTimer = 0;
  const statesFlying = new Set();
  function setLinkState(id, st) {
    if (!id || !st) return;
    const was = linkStates.get(id);
    linkStates.set(id, st);
    if (was !== st) paintLinks(id);
  }
  function paintLink(link, st) {
    const w = stateWord(st);
    link.classList.toggle('artifact-link-archived', st === 'archived');
    link.classList.toggle('artifact-link-deleted', st === 'deleted' || st === 'gone');
    let tag = link.querySelector('.artifact-state');
    if (!w) {
      if (tag) tag.remove();
      return;
    }
    if (!tag) {
      tag = el('span', 'artifact-state');
      link.append(tag);
    }
    tag.textContent = ' · ' + w;
  }
  function paintLinks(id) {
    if (!doc || !doc.querySelectorAll) return;
    for (const l of doc.querySelectorAll('a.artifact-link')) if (l.dataset.artifactId === id) paintLink(l, linkStates.get(id));
  }
  function decorateLinks(container) {
    if (!S.mounted || !container.querySelectorAll) return;
    for (const l of container.querySelectorAll('a.artifact-link')) {
      const id = l.dataset.artifactId;
      if (!id) continue;
      const k = known(id),
        st = linkStates.get(id) || (k ? artState(k) : '');
      if (st) paintLink(l, st);
      else if (!statesFlying.has(id)) statesWanted.add(id);
    }
    if (statesWanted.size && !statesTimer) statesTimer = win.setTimeout(askStates, 0);
  }
  async function askStates() {
    statesTimer = 0;
    const ids = [...statesWanted].filter((id) => !linkStates.has(id) && !statesFlying.has(id));
    statesWanted = new Set();
    for (let i = 0; i < ids.length; i += 200) {
      const part = ids.slice(i, i + 200);
      part.forEach((id) => statesFlying.add(id));
      try {
        const r = await api('/api/live/artifacts/states?' + q({ ids: part.join(',') }));
        const st = (r && r.states) || {};
        for (const id of part) setLinkState(id, st[id] || 'gone');
      } catch (e) {
        /* an older AIB without the route: links stay as they are */
      } finally {
        part.forEach((id) => statesFlying.delete(id));
      }
    }
  }
  let linkSig = '';
  function relinkAll() {
    if (!doc) return;
    const sig = S.list.filter((a) => !isDeleted(a)).map((a) => a.id + '|' + (a.sourcePath || '')).join(';') + '#' + S.chat.cwd;
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
    const edit = el('button', 'ar-word ar-edit', '\u270e Edit');
    edit.type = 'button';
    edit.title = EDIT_TIP;
    edit.hidden = true;
    const request = el('button', 'ar-word ar-request', 'Request a change');
    request.type = 'button';
    request.title = 'Puts this artifact in the message box, ready for you to say what to change';
    request.hidden = true;
    bar.append(pick, ver, spacer, edit, request, ext, more);
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
    // "Built from Release plan › Rollout · Open doc", then "… changed after this was built (2 edits). Rebuild from the doc"
    const built = el('div', 'ar-built');
    built.hidden = true;
    built.setAttribute('role', 'status');
    const builtText = el('span', 'ar-built-t', '');
    const builtOpen = el('button', 'ar-switch ar-built-open', 'Open doc');
    builtOpen.type = 'button';
    built.append(builtText, builtOpen);
    const stale = el('div', 'ar-built ar-stale');
    stale.hidden = true;
    stale.setAttribute('role', 'status');
    const staleText = el('span', 'ar-built-t', '');
    const rebuildBtn = el('button', 'ar-switch ar-rebuild', 'Rebuild from the doc');
    rebuildBtn.type = 'button';
    stale.append(staleText, rebuildBtn);
    // after Edit: "Now a doc: Load test summary · Open doc · Undo"
    const became = el('div', 'ar-built ar-became');
    became.hidden = true;
    became.setAttribute('role', 'status');
    const becameText = el('span', 'ar-built-t', '');
    const becameOpen = el('button', 'ar-switch ar-became-open', 'Open doc');
    becameOpen.type = 'button';
    const becameSep = el('span', 'ar-built-t', ' \u00b7 ');
    const undoBtn = el('button', 'ar-switch ar-undo', 'Undo');
    undoBtn.type = 'button';
    // the buttons travel together: when the line is too narrow they go to a second line as a group
    const becameActs = el('span', 'ar-became-acts');
    becameActs.append(becameOpen, becameSep, undoBtn);
    became.append(becameText, becameActs);
    // "Archived 2 d ago. Hidden from this chat's list. · Unarchive"
    const archived = el('div', 'ar-built ar-archived');
    archived.hidden = true;
    archived.setAttribute('role', 'status');
    const archivedText = el('span', 'ar-built-t', '');
    const unarchiveBtn = el('button', 'ar-switch ar-unarchive', 'Unarchive');
    unarchiveBtn.type = 'button';
    archived.append(archivedText, unarchiveBtn);
    // the note line: one message, with Undo after Archive and Delete
    const noteEl = el('div', 'ar-note');
    noteEl.hidden = true;
    noteEl.setAttribute('role', 'status');
    const noteText = el('span', 'ar-note-t', '');
    const noteUndo = el('button', 'ar-switch ar-note-undo', 'Undo');
    noteUndo.type = 'button';
    noteUndo.hidden = true;
    noteEl.append(noteText, noteUndo);
    const stage = el('div', 'ar-stage');
    const empty = el('div', 'ar-empty');
    const emptyTitle = el('p', 'ar-empty-t', 'No artifacts in this chat yet'),
      emptyHint = el('p', '', 'When the agent publishes a page, diagram or report, or saves a file in outputs/, it shows up here.'),
      emptyHidden = el('p', 'ar-empty-hidden');
    emptyHidden.hidden = true;
    empty.append(emptyTitle, emptyHint, emptyHidden);
    const foot = el('div', 'ar-foot', FOOTER);
    const pop = el('div', 'ar-pop');
    pop.hidden = true;
    pop.setAttribute('role', 'menu');
    const rowPop = el('div', 'ar-pop ar-rowmenu');
    rowPop.hidden = true;
    rowPop.setAttribute('role', 'menu');
    view.append(bar, avail, fresh, built, stale, became, archived, noteEl, stage, empty, foot, pop, rowPop);
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
      built,
      builtText,
      edit,
      request,
      became,
      becameText,
      becameSep,
      undoBtn,
      stale,
      staleText,
      note: noteEl,
      noteText,
      noteUndo,
      archived,
      archivedText,
      stage,
      empty,
      emptyTitle,
      emptyHint,
      emptyHidden,
      foot,
      pop,
      rowPop,
      rowFor: null,
      popAnchor: null,
      badge: o.badge,
      tab: o.tab,
      reveal: o.reveal || (() => {}),
      frame: null,
      docFrame: null,
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
    unarchiveBtn.addEventListener('click', () => {
      const a = current();
      if (a) doArchive(a.id, false);
    });
    noteEl.addEventListener('pointerenter', () => noteHold(true));
    noteEl.addEventListener('pointerleave', () => noteHold(false));
    builtOpen.addEventListener('click', () => openBuiltDoc());
    edit.addEventListener('click', () => editAsDoc());
    request.addEventListener('click', () => requestChange());
    becameOpen.addEventListener('click', () => openBecameDoc());
    undoBtn.addEventListener('click', () => undoEdit());
    rebuildBtn.addEventListener('click', () => rebuild());
    freshOpen.addEventListener('click', () => {
      const id = S.fresh;
      S.fresh = '';
      if (isDocId(id)) openDoc({ name: id.slice(4), title: docTitle(id.slice(4)) });
      else if (id) selectArtifact(id);
      paintAll();
      pick.focus({ preventScroll: true });
    });
    // Escape and outside clicks close the popover; arrows move through its items.
    doc.addEventListener(
      'keydown',
      (e) => {
        if (!ui.rowPop.hidden) {
          // the row menu first: Escape back to its row, arrows through its items
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            const r = ui.rowFor && ui.rowFor.row;
            closeRowMenu();
            if (r && r.focus) r.focus({ preventScroll: true });
            return;
          }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const items = [...ui.rowPop.querySelectorAll('.ar-it')];
            const at = items.indexOf(doc.activeElement),
              next = e.key === 'ArrowDown' ? (at + 1) % items.length : at <= 0 ? items.length - 1 : at - 1;
            e.preventDefault();
            if (items[next]) items[next].focus({ preventScroll: true });
          }
          return;
        }
        if (ui.pop.hidden) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          const f = ui.popFor === 'menu' ? more : ui.popFor === 'ver' ? ver : ui.popAnchor && ui.popAnchor !== pick && ui.popAnchor.isConnected ? ui.popAnchor : pick;
          closePop();
          if (f && f.focus) f.focus({ preventScroll: true });
          return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const items = [...ui.pop.querySelectorAll('.ar-it, .ar-nav')];
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
      if (!ui.rowPop.hidden && !ui.rowPop.contains(e.target)) {
        closeRowMenu();
        if (ui.pop.contains(e.target)) return; // a click elsewhere in the picker only closes the row menu
      }
      if (!ui.pop.hidden && !ui.pop.contains(e.target) && !bar.contains(e.target) && !(ui.popAnchor && ui.popAnchor.contains && ui.popAnchor.contains(e.target)))
        closePop();
    });
    // The page reports its scroll position so a reload can put it back. A sandboxed page has an opaque origin, so the sender is
    // identified by its window, not by event.origin.
    win.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || d.type !== 'studio-artifact-scroll' || !ui.frame || e.source !== ui.frame.contentWindow) return;
      const x = Number(d.x),
        y = Number(d.y);
      const f = Number(d.f);
      if (Number.isFinite(x) && Number.isFinite(y)) S.scroll = { x, y, f: Number.isFinite(f) ? f : 0 };
    });
    win.setInterval(() => refreshCards(), 30000);
    paintCount();
    paintAll();
  }

  /* Files view, "Open in Artifacts" on a file no chat has registered: the deliberate action that registers it in a chat (the one
     files-ui picked, whose folder holds the file; else the open chat), by the same route the old Preview used, then shows it here.
     Another chat's artifact is shown by id and kept out of the open chat's list. Throws when it cannot be shown. */
  async function registerFile(path, conversationId) {
    const id = conversationId || S.chat.id;
    if (!id) throw new Error('Open a chat first');
    if (!path) throw new Error('Choose a file');
    const s = await api('/api/live/artifacts/preview', { conversationId: id, path });
    if (!s || !s.id) return null;
    if (id === S.chat.id) upsert(s);
    else if (!S.list.some((a) => a.id === s.id)) S.extras[s.id] = Object.assign({}, S.extras[s.id], s);
    if (!(await open(s.id))) throw new Error('the Artifacts viewer could not show it');
    return s;
  }
  const api2 = Object.assign({}, pure, {
    registerFile,
    mount,
    sync,
    setVisible,
    shown,
    onEvents,
    decorateToolRow,
    linkify,
    open,
    openDoc,
    upsert,
    note,
    state: () => ({ chat: S.chat, list: S.list, selId: S.selId, picked: S.picked, mode: S.mode, fresh: S.fresh, doc: S.doc }),
    _S: S,
  });
  root.ArtifactsUI = api2;
  root.AgentArtifactsUI = api2;
  if (typeof module === 'object' && module.exports) module.exports = api2;
})(typeof window !== 'undefined' ? window : globalThis);

// The file tab's code editor (spike, P0 of private/designs/file-editor): CodeMirror 6 with AIB's language set and a theme made only
// of AIB's CSS variables, so every AIB theme (incl. high contrast) works with no per-theme code.
//
// Exposes window.AIBCodeEditor:
//   create({ parent, root, text, name, readOnly, wrap, live, onChange, onSave, onSaveAll, onOverlapClick })
//     -> { view, text(), setText(t), setWrap(on), setReadOnly(on), indent(), refreshMarks(), focus(), destroy() }
//     live: { ytext, undo | history, overlaps?, doc? } binds the editor to a live file's Y.Text (y-codemirror.next); its overlaps (Y
//     relative positions kept by the server, server/files/live_file.ts) show as a gutter marker plus a soft line tint, never as a
//     block that pushes the code down (owner rule: nothing jarring). `history` ({ undo(), redo() } -> Promise<{ok, at}|null>, a
//     liveClient's step): Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z go to the server's undo history of the file, which outlives the tab, a
//     reload, another window and a restart (owner 2026-11-17); `undo`: a Y.UndoManager in the page (a local live file).
//   liveClient({ url, protocols, onHello, onReopen, onStatus, onSwap }) -> the page side of the file socket (server/web/
//     live_files_routes.ts): y-protocols sync, reconnects, a rebase onto a new lineage that keeps the page's text, and step('undo' |
//     'redo'), which asks the server to undo or redo the person's last edit of the file.
//   compare({ parent, root, disk, live, name, narrow }) -> Compare in the same pane: the disk on the left (read only), your live text
//     on the right with a "take theirs" arrow per chunk (MergeView revertControls); narrow: one column (unifiedMergeView).
//   languageFor(name) -> CodeMirror extension (or [] for plain text)
//   cm: the CodeMirror pieces the page and tests may need (EditorView, EditorState, ...)
//
// Styles: CodeMirror's own styles go in through style-mod. In a Document it adds a <style> tag, which the page's CSP blocks
// (style-src 'self', no 'unsafe-inline'; found by the spike). In a shadow root it uses a constructed stylesheet
// (adoptedStyleSheets), which CSP does not govern. So the page mounts every editor in a shadow root: create({ parent, root })
// with root = that shadow root. AIB's CSS variables inherit into it, so the theme still follows AIB's theme. The spike e2e
// (work/deno/code_editor_spike_e2e_test.ts) proves it in the real AIB window.
import { EditorState, Compartment, StateEffect, StateField, RangeSet, RangeSetBuilder } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightActiveLine,
  gutter,
  GutterMarker,
  Decoration,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands';
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel, gotoLine, selectNextOccurrence } from '@codemirror/search';
import {
  indentOnInput,
  bracketMatching,
  syntaxHighlighting,
  HighlightStyle,
  StreamLanguage,
  indentUnit,
} from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { MergeView, unifiedMergeView, diff } from '@codemirror/merge';
import { tags as t } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { php } from '@codemirror/lang-php';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { csharp } from '@codemirror/legacy-modes/mode/clike';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import * as Y from 'yjs';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

// ---- live file (the docs model, server/docs/live_doc.ts): the open file is a Y.Text; the editor is bound to it with
// y-codemirror.next. The user's typing is the editor's origin (tracked by the undo manager); a change on disk comes in as the FILE
// origin (not tracked: Ctrl+Z never takes an agent's change back), diffed into the text so only the changed ranges move.
const FILE = { kind: 'file', name: 'disk' };
function liveFile(text) {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('file');
  ytext.insert(0, String(text ?? ''));
  const undo = new Y.UndoManager(ytext); // y-codemirror.next adds the editor's origin to its tracked origins
  return {
    ydoc,
    ytext,
    undo,
    // Merge a disk version into the live text as the FILE origin (a 3-way merge: base = the disk text the live text last took in,
    // theirs = `next`, mine = the live text). Their hunks that touch no line the user changed are applied at once, mapped to where
    // they are in the live text; hunks on lines the user changed are left out (the user's text stays) and returned as overlaps.
    // Returns { applied, overlaps } (ranges in base / next coordinates). P1 runs this on the server (LiveFile), same rule.
    applyDisk(base, next) {
      base = String(base);
      next = String(next);
      const mine = diff(base, ytext.toString()), theirs = diff(base, next);
      const lineStart = (p) => base.lastIndexOf('\n', p - 1) + 1;
      const lineEnd = (p) => {
        const e = base.indexOf('\n', p);
        return e < 0 ? base.length : e;
      };
      const touches = (c) => mine.some((m) => lineStart(c.fromA) <= lineEnd(m.toA) && lineStart(m.fromA) <= lineEnd(c.toA));
      const shift = (pos) => {
        let d = 0;
        for (const m of mine) if (m.toA <= pos) d += m.toB - m.fromB - (m.toA - m.fromA);
        return pos + d;
      };
      const applied = [], overlaps = [];
      for (const c of theirs) (touches(c) ? overlaps : applied).push(c);
      ydoc.transact(() => {
        for (let i = applied.length - 1; i >= 0; i--) {
          const c = applied[i], at = shift(c.fromA);
          if (c.toA > c.fromA) ytext.delete(at, c.toA - c.fromA);
          if (c.toB > c.fromB) ytext.insert(at, next.slice(c.fromB, c.toB));
        }
      }, FILE);
      return { applied, overlaps };
    },
  };
}

// ---- the page side of the file socket ----------------------------------------------------------------------------------------
// One per open file per window (files-ui.js shares it between the tab and the beside pane). Edits made while the socket is down wait
// in the Y.Doc and go out in the next sync. A server with another lineage (it restarted and had nothing unsaved of this file) gets a
// fresh Y.Doc; once synced, the text the page had is put back on top as one narrowed edit (nothing typed is dropped), and onSwap
// tells the page to bind its editors to the new text.
const isHi = (c) => c >= 0xd800 && c <= 0xdbff;
const isLo = (c) => c >= 0xdc00 && c <= 0xdfff;
function narrow(old, next) {
  let p = 0;
  const lim = Math.min(old.length, next.length);
  while (p < lim && old.charCodeAt(p) === next.charCodeAt(p)) p++;
  if (p > 0 && (isHi(old.charCodeAt(p - 1)) || isLo(old.charCodeAt(p)) || isLo(next.charCodeAt(p)))) p--;
  let q = 0;
  while (q < lim - p && old.charCodeAt(old.length - 1 - q) === next.charCodeAt(next.length - 1 - q)) q++;
  if (q > 0 && (isLo(old.charCodeAt(old.length - q)) || isHi(next.charCodeAt(next.length - q - 1)))) q--;
  return { from: p, to: old.length - q, insert: next.slice(p, next.length - q) };
}
const toB64 = (u) => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
};
const REBASE = { kind: 'rebase' };
function liveClient(o) {
  let doc = new Y.Doc(), ws = null, closed = false, synced = false, retry = 0, timer = null, lineage = '', localDirty = false;
  let steps = 0;
  const waiting = new Map(); // step id -> resolve (the server's {type: 'undone'} answer)
  let resolveSynced;
  let whenSynced = new Promise((r) => (resolveSynced = r));
  const send = (sock, build) => {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 0);
    build(e);
    if (sock && sock.readyState === 1) sock.send(encoding.toUint8Array(e));
  };
  const onUpdate = (update, origin) => {
    if (ws && origin === ws) return;
    if (origin !== REBASE) localDirty = true;
    if (ws && synced) send(ws, (e) => syncProtocol.writeUpdate(e, update));
  };
  const onMeta = (ev, tr) => {
    // the server's dirty flag answers our edits once the state it checked (meta.checked) covers them
    if (!localDirty || !(ws && tr.origin === ws) || !ev.keysChanged.has('checked')) return;
    const checked = doc.getMap('meta').get('checked');
    if (!(checked instanceof Uint8Array)) return;
    const mine = Y.decodeStateVector(Y.encodeStateVector(doc)).get(doc.clientID) || 0;
    if ((Y.decodeStateVector(checked).get(doc.clientID) || 0) >= mine) {
      localDirty = false;
      if (o.onDirty) o.onDirty();
    }
  };
  const bind = (d) => {
    d.on('update', onUpdate);
    d.getMap('meta').observe(onMeta);
  };
  bind(doc);
  async function connect() {
    if (closed) return;
    clearTimeout(timer);
    const protocols = await o.protocols();
    if (closed) return;
    const sock = new WebSocket(o.url(), protocols);
    sock.binaryType = 'arraybuffer';
    ws = sock;
    let rebase = null;
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      if (typeof ev.data === 'string') {
        let m = null;
        try {
          m = JSON.parse(ev.data);
        } catch (err) {
          return;
        }
        if (m.type === 'hello') {
          if (lineage && m.lineage !== lineage) {
            rebase = doc.getText('file').toString();
            doc.off('update', onUpdate);
            doc = new Y.Doc();
            bind(doc);
          }
          lineage = m.lineage;
          send(sock, (e) => syncProtocol.writeSyncStep1(e, doc));
          if (o.onHello) o.onHello(m);
        } else if (m.type === 'reopen' && o.onReopen) o.onReopen(m);
        else if (m.type === 'undone' && waiting.has(m.id)) {
          const done = waiting.get(m.id);
          waiting.delete(m.id);
          done(m);
        }
        return;
      }
      const d = decoding.createDecoder(new Uint8Array(ev.data));
      if (decoding.readVarUint(d) !== 0) return; // awareness: no cursors in v1
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      const kind = syncProtocol.readSyncMessage(d, e, doc, sock);
      if (encoding.length(e) > 1) sock.send(encoding.toUint8Array(e));
      if (kind === syncProtocol.messageYjsSyncStep2 && !synced) {
        synced = true;
        retry = 0;
        if (rebase !== null) {
          const text = doc.getText('file'), cut = narrow(text.toString(), rebase);
          rebase = null;
          if (cut.to > cut.from || cut.insert) {
            doc.transact(() => {
              if (cut.to > cut.from) text.delete(cut.from, cut.to - cut.from);
              if (cut.insert) text.insert(cut.from, cut.insert);
            }, { kind: 'rebase-user' }); // the page's own text, sent like typing
          }
          if (o.onSwap) o.onSwap(doc);
        }
        resolveSynced();
        if (o.onStatus) o.onStatus('synced');
      }
    };
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      ws = null;
      if (synced) whenSynced = new Promise((r) => (resolveSynced = r));
      synced = false;
      if (o.onStatus) o.onStatus('closed', ev.code);
      if (closed || ev.code === 4404) return; // 4404: not open on the server; the page opens it again (onReopen)
      timer = setTimeout(connect, Math.min(5000, 400 * Math.pow(2, retry++)));
    };
    sock.onerror = () => {};
  }
  return {
    get doc() {
      return doc;
    },
    get text() {
      return doc.getText('file');
    },
    get meta() {
      return doc.getMap('meta');
    },
    get overlaps() {
      return doc.getArray('overlaps');
    },
    get synced() {
      return synced;
    },
    get lineage() {
      return lineage;
    },
    /** Typed here and not yet answered by the server's dirty flag. */
    get localDirty() {
      return localDirty;
    },
    whenSynced: () => whenSynced,
    sv: () => toB64(Y.encodeStateVector(doc)),
    /**
     * Undo or redo the person's last edit of this file on the server (its history outlives this page). The keystrokes typed before
     * went out first on the same socket. Resolves {ok, at} (at: where the change ended, for the caret), or null while offline.
     */
    step(op) {
      if (!ws || !synced || ws.readyState !== 1) return Promise.resolve(null);
      const id = ++steps, sock = ws;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        sock.send(JSON.stringify({ type: op === 'redo' ? 'redo' : 'undo', id }));
        setTimeout(() => {
          if (waiting.delete(id)) resolve(null);
        }, 5000);
      });
    },
    connect,
    /** Connect again now (after the page opened the file again). */
    reconnect() {
      retry = 0;
      if (ws) {
        const old = ws;
        ws = null;
        try {
          old.close(1000, 'reconnect');
        } catch (err) {
          /* gone */
        }
      }
      synced = false;
      return connect();
    },
    close() {
      closed = true;
      clearTimeout(timer);
      if (ws) ws.close(1000, 'closed');
      ws = null;
    },
  };
}

// ---- overlaps: a gutter marker and a soft line tint (never a block that pushes the code down) ----------------------------------
const setOverlaps = StateEffect.define();
const overlapField = StateField.define({
  create: () => ({ gutter: RangeSet.empty, lines: Decoration.none }),
  update(v, tr) {
    let next = tr.docChanged ? { gutter: v.gutter.map(tr.changes), lines: v.lines.map(tr.changes) } : v;
    for (const e of tr.effects) if (e.is(setOverlaps)) next = e.value;
    return next;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.lines),
});
class OverlapMarker extends GutterMarker {
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-aib-overlap';
    s.textContent = '◆';
    s.title = 'Changed on disk where you edited. Your text stays. Click to compare.';
    return s;
  }
}
const overlapMarker = new OverlapMarker();
const overlapLine = Decoration.line({ class: 'cm-aib-overlap-line' });
function overlapRanges(live) {
  const out = [];
  if (!live || !live.overlaps || !live.doc) return out;
  for (const rec of live.overlaps.toArray()) {
    try {
      const a = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(rec.from), live.doc);
      const b = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(rec.to), live.doc);
      if (a && b) out.push({ from: a.index, to: Math.max(a.index, b.index) });
    } catch (err) {
      /* a position from another lineage */
    }
  }
  return out;
}
function overlapValue(state, ranges) {
  const g = new RangeSetBuilder(), l = new RangeSetBuilder();
  const lines = new Set();
  for (const r of ranges) {
    const first = state.doc.lineAt(Math.min(r.from, state.doc.length)).number;
    const last = state.doc.lineAt(Math.min(Math.max(r.from, r.to - 1), state.doc.length)).number;
    for (let n = first; n <= last; n++) lines.add(n);
  }
  for (const n of [...lines].sort((a, b) => a - b)) {
    const at = state.doc.line(n).from;
    g.add(at, at, overlapMarker);
    l.add(at, at, overlapLine);
  }
  return { gutter: g.finish(), lines: l.finish() };
}

// ---- undo: the server's history of the file (live.history), or a Y.UndoManager in the page (live.undo) ---------------------------
// The server keeps the person's history next to the file's Y.Doc (server/files/live_file.ts), so it outlives the tab. Ctrl+Z, Ctrl+Y
// and Ctrl+Shift+Z (and the browser's own historyUndo / historyRedo input) ask it; the caret goes to where the change ended.
function serverUndo(h) {
  const go = (op) => (view) => {
    Promise.resolve(op === 'redo' ? h.redo() : h.undo()).then((r) => {
      if (!r || !r.ok || !(r.at >= 0)) return;
      try {
        const at = Math.min(r.at, view.state.doc.length);
        view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
      } catch (err) {
        /* the editor is gone */
      }
    });
    return true;
  };
  return {
    keys: [
      { key: 'Mod-z', run: go('undo'), preventDefault: true },
      { key: 'Mod-y', mac: 'Mod-Shift-z', run: go('redo'), preventDefault: true },
      { key: 'Mod-Shift-z', run: go('redo'), preventDefault: true },
    ],
    input: EditorView.domEventHandlers({
      beforeinput(e, view) {
        if (e.inputType === 'historyUndo') return go('undo')(view);
        if (e.inputType === 'historyRedo') return go('redo')(view);
        return false;
      },
    }),
  };
}
function liveUndo(live) {
  if (live.history) {
    const s = serverUndo(live.history);
    return { collab: yCollab(live.ytext, null, { undoManager: false }), keys: s.keys, extra: s.input };
  }
  return { collab: yCollab(live.ytext, null, { undoManager: live.undo }), keys: yUndoManagerKeymap, extra: [] };
}

// ---- Compare: in the same pane, at the same width --------------------------------------------------------------------------------
function compare(o) {
  const lang = languageFor(o.name);
  const ro = [EditorState.readOnly.of(true), EditorView.editable.of(false)];
  const u = liveUndo(o.live);
  const mine = [
    lineNumbers(),
    u.collab,
    u.extra,
    keymap.of([...u.keys, ...defaultKeymap]),
    theme,
    syntaxHighlighting(highlight),
    lang,
    o.readOnly ? ro : [],
  ];
  if (o.narrow) {
    const view = new EditorView({
      state: EditorState.create({ doc: o.live.ytext.toString(), extensions: [...mine, unifiedMergeView({ original: o.disk, mergeControls: !o.readOnly })] }),
      parent: o.parent,
      root: o.root,
    });
    return { view, destroy: () => view.destroy() };
  }
  const mv = new MergeView({
    a: { doc: o.disk, extensions: [lineNumbers(), ...ro, theme, syntaxHighlighting(highlight), lang] },
    b: { doc: o.live.ytext.toString(), extensions: mine },
    parent: o.parent,
    root: o.root,
    revertControls: o.readOnly ? undefined : 'a-to-b',
    highlightChanges: true,
    gutter: true,
  });
  return { view: mv.b, merge: mv, destroy: () => mv.destroy() };
}

// ---- theme: AIB's CSS variables only ------------------------------------------------------------------------------------------
const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--code-bg)', color: 'var(--text)', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: "Consolas, 'Cascadia Mono', monospace", lineHeight: '21px' },
  '.cm-content': { caretColor: 'var(--text)', padding: '6px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 30%, transparent)',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--text) 5%, transparent)' },
  '.cm-gutters': { backgroundColor: 'var(--code-bg)', color: 'var(--text-faint)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '38px', padding: '0 14px 0 0' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 16%, transparent)' },
  '.cm-searchMatch': { backgroundColor: 'var(--hl-yellow)', outline: '1px solid var(--warn-line)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--warn) 45%, var(--bg))' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--accent) 25%, transparent)', outline: 'none' },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'var(--bad-fill)' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
  '.cm-panel input, .cm-panel button, .cm-textfield, .cm-button': {
    font: 'inherit',
    color: 'var(--text)',
    backgroundColor: 'var(--bg-field)',
    backgroundImage: 'none',
    border: '1px solid var(--line-field)',
    borderRadius: '6px',
  },
  '.cm-panel label': { color: 'var(--text-2)' },
  '.cm-tooltip': { backgroundColor: 'var(--bg-popover)', color: 'var(--text)', border: '1px solid var(--line-field)' },
  '.cm-aib-overlap-gutter .cm-gutterElement': { width: '14px', color: 'var(--warn)', cursor: 'pointer', textAlign: 'center' },
  '.cm-aib-overlap-line': { backgroundColor: 'color-mix(in srgb, var(--warn) 12%, transparent)' },
  '&.cm-merge-a, &.cm-merge-b': { height: 'auto' },
  '.cm-merge-revert button': {
    color: 'var(--text)',
    backgroundColor: 'var(--bg-field)',
    border: '1px solid var(--line-field)',
    borderRadius: '4px',
    cursor: 'pointer',
  },
});
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.literal], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.propertyName, t.attributeName, t.heading, t.tagName, t.labelName], color: 'var(--syn-key)' },
  { tag: t.heading, fontWeight: 'bold' },
  { tag: t.link, textDecoration: 'underline' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.invalid, color: 'var(--danger-text)' },
]);

// ---- languages ----------------------------------------------------------------------------------------------------------------
const legacy = (mode) => () => StreamLanguage.define(mode);
const BY_EXT = {
  js: () => javascript(), mjs: () => javascript(), cjs: () => javascript(), jsx: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }), mts: () => javascript({ typescript: true }), cts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  py: () => python(), pyw: () => python(),
  json: () => json(), jsonc: () => json(), webmanifest: () => json(),
  css: () => css(), scss: () => css(), less: () => css(),
  html: () => html(), htm: () => html(), vue: () => html(), svelte: () => html(),
  md: () => markdown(), markdown: () => markdown(), mdx: () => markdown(),
  yml: () => yaml(), yaml: () => yaml(),
  rs: () => rust(), go: () => go(), java: () => java(), kt: () => java(),
  c: () => cpp(), h: () => cpp(), cc: () => cpp(), cpp: () => cpp(), cxx: () => cpp(), hpp: () => cpp(), hh: () => cpp(),
  php: () => php(), sql: () => sql(), xml: () => xml(), svg: () => xml(), xaml: () => xml(), csproj: () => xml(), plist: () => xml(),
  cs: legacy(csharp), sh: legacy(shell), bash: legacy(shell), zsh: legacy(shell),
  ps1: legacy(powerShell), psm1: legacy(powerShell), psd1: legacy(powerShell), toml: legacy(toml),
};
const BY_NAME = { dockerfile: legacy(shell), makefile: legacy(shell), '.bashrc': legacy(shell), '.zshrc': legacy(shell), '.env': legacy(shell) };
function languageFor(name) {
  const base = String(name || '').split(/[\\/]/).pop().toLowerCase();
  if (BY_NAME[base]) return BY_NAME[base]();
  const dot = base.lastIndexOf('.');
  const make = dot >= 0 ? BY_EXT[base.slice(dot + 1)] : null;
  return make ? make() : [];
}

// Indentation: tabs if the first indented lines use tabs, else the most common small space step (2 or 4).
function detectIndent(text) {
  let tabs = 0, two = 0, four = 0, seen = 0;
  for (const line of text.split('\n', 2000)) {
    const m = /^([ \t]+)\S/.exec(line);
    if (!m) continue;
    if (m[1][0] === '\t') tabs++;
    else if (m[1].length % 4 === 0) four++;
    else if (m[1].length % 2 === 0) two++;
    if (++seen > 200) break;
  }
  if (tabs > two + four) return '\t';
  return two > four / 2 ? '  ' : '    ';
}

// ---- one editor -----------------------------------------------------------------------------------------------------------------
function create(opts) {
  const o = opts || {};
  const live = o.live ? (o.live === true ? liveFile(o.text) : o.live) : null;
  const text = live ? live.ytext.toString() : String(o.text ?? '');
  const u = live ? liveUndo(live) : null;
  const wrap = new Compartment(), lang = new Compartment(), ro = new Compartment();
  const minified = text.split('\n', 50).some((l) => l.length > 5000);
  let wrapped = o.wrap ?? (/\.(md|markdown|txt)$/i.test(o.name || '') || minified);
  const setWrap = (on) => {
    wrapped = !!on;
    view.dispatch({ effects: wrap.reconfigure(wrapped ? EditorView.lineWrapping : []) });
  };
  const keys = [
    { key: 'Mod-s', preventDefault: true, run: () => (o.onSave ? (o.onSave(view.state.doc.toString()), true) : false) },
    { key: 'Mod-Shift-s', preventDefault: true, run: () => (o.onSaveAll ? (o.onSaveAll(), true) : false) },
    { key: 'Mod-g', preventDefault: true, run: gotoLine }, // CodeMirror's default Mod-g is "find next" (F3 stays)
    { key: 'Mod-h', preventDefault: true, run: openSearchPanel }, // the search panel has the replace field
    { key: 'Mod-d', preventDefault: true, run: selectNextOccurrence },
    { key: 'Mod-/', preventDefault: true, run: toggleComment },
    { key: 'Alt-z', preventDefault: true, run: () => (setWrap(!wrapped), true) },
  ];
  const state = EditorState.create({
    doc: text,
    extensions: [
      live && live.overlaps
        ? [
          overlapField,
          gutter({
            class: 'cm-aib-overlap-gutter',
            markers: (v) => v.state.field(overlapField).gutter,
            initialSpacer: () => overlapMarker,
            domEventHandlers: { mousedown: () => (o.onOverlapClick ? (o.onOverlapClick(), true) : false) },
          }),
        ]
        : [],
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      u ? [u.collab, u.extra] : history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      EditorView.clickAddsSelectionRange.of((e) => e.altKey && !e.shiftKey), // Alt+click adds a cursor (CodeMirror: Ctrl+click)
      indentOnInput(),
      indentUnit.of(detectIndent(text)),
      minified ? [] : syntaxHighlighting(highlight),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection({ eventFilter: (e) => e.altKey && e.shiftKey }),
      crosshairCursor({ key: 'Alt' }),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      keymap.of([...keys, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...(u ? u.keys : historyKeymap), indentWithTab]),
      theme,
      wrap.of(wrapped ? EditorView.lineWrapping : []),
      lang.of(minified ? [] : languageFor(o.name)),
      ro.of(o.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && o.onChange) o.onChange(u);
      }),
      EditorView.contentAttributes.of({ 'aria-label': (o.name || 'File') + (o.readOnly ? ', read only' : '') }),
    ],
  });
  const view = new EditorView({ state, parent: o.parent, root: o.root });
  let marking = 0;
  const refreshMarks = () => {
    if (!live || !live.overlaps) return;
    view.dispatch({ effects: setOverlaps.of(overlapValue(view.state, overlapRanges(live))) });
  };
  const soon = () => {
    if (marking) return;
    marking = setTimeout(() => {
      marking = 0;
      refreshMarks();
    }, 30);
  };
  if (live && live.overlaps) {
    live.overlaps.observe(soon);
    refreshMarks();
  }
  return {
    view,
    live,
    text: () => view.state.doc.toString(),
    setText: (next) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: String(next) } }),
    setWrap,
    setReadOnly: (on) => view.dispatch({ effects: ro.reconfigure(on ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []) }),
    focus: () => view.focus(),
    indent: () => detectIndent(view.state.doc.toString()),
    refreshMarks,
    destroy: () => {
      if (live && live.overlaps) live.overlaps.unobserve(soon);
      clearTimeout(marking);
      view.destroy();
    },
  };
}

window.AIBCodeEditor = {
  version: '6',
  create,
  languageFor,
  detectIndent,
  liveFile,
  liveClient,
  compare,
  narrow,
  FILE,
  cm: { EditorState, EditorView, MergeView, unifiedMergeView, diff, Y },
};

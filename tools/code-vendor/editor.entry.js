// The file tab's code editor (spike, P0 of private/designs/file-editor): CodeMirror 6 with AIB's language set and a theme made only
// of AIB's CSS variables, so every AIB theme (incl. high contrast) works with no per-theme code.
//
// Exposes window.AIBCodeEditor:
//   create({ parent, root, text, name, readOnly, wrap, live, onChange, onSave }) -> { view, text(), setText(t), setWrap(on), focus(), destroy() }
//   languageFor(name) -> CodeMirror extension (or [] for plain text)
//   cm: the CodeMirror pieces the page and tests may need (EditorView, EditorState, ...)
//
// Styles: CodeMirror's own styles go in through style-mod. In a Document it adds a <style> tag, which the page's CSP blocks
// (style-src 'self', no 'unsafe-inline'; found by the spike). In a shadow root it uses a constructed stylesheet
// (adoptedStyleSheets), which CSP does not govern. So the page mounts every editor in a shadow root: create({ parent, root })
// with root = that shadow root. AIB's CSS variables inherit into it, so the theme still follows AIB's theme. The spike e2e
// (work/deno/code_editor_spike_e2e_test.ts) proves it in the real AIB window.
import { EditorState, Compartment } from '@codemirror/state';
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
  const wrap = new Compartment(), lang = new Compartment(), ro = new Compartment();
  const minified = text.split('\n', 50).some((l) => l.length > 5000);
  let wrapped = o.wrap ?? (/\.(md|markdown|txt)$/i.test(o.name || '') || minified);
  const setWrap = (on) => {
    wrapped = !!on;
    view.dispatch({ effects: wrap.reconfigure(wrapped ? EditorView.lineWrapping : []) });
  };
  const keys = [
    { key: 'Mod-s', preventDefault: true, run: () => (o.onSave ? (o.onSave(view.state.doc.toString()), true) : false) },
    { key: 'Mod-g', preventDefault: true, run: gotoLine }, // CodeMirror's default Mod-g is "find next" (F3 stays)
    { key: 'Mod-h', preventDefault: true, run: openSearchPanel }, // the search panel has the replace field
    { key: 'Mod-d', preventDefault: true, run: selectNextOccurrence },
    { key: 'Mod-/', preventDefault: true, run: toggleComment },
    { key: 'Alt-z', preventDefault: true, run: () => (setWrap(!wrapped), true) },
  ];
  const state = EditorState.create({
    doc: text,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      live ? yCollab(live.ytext, null, { undoManager: live.undo }) : history(),
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
      keymap.of([...keys, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...(live ? yUndoManagerKeymap : historyKeymap), indentWithTab]),
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
  return {
    view,
    live,
    text: () => view.state.doc.toString(),
    setText: (next) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: String(next) } }),
    setWrap,
    setReadOnly: (on) => view.dispatch({ effects: ro.reconfigure(on ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []) }),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}

window.AIBCodeEditor = {
  version: '6',
  create,
  languageFor,
  detectIndent,
  liveFile,
  FILE,
  cm: { EditorState, EditorView, MergeView, unifiedMergeView, diff, Y },
};

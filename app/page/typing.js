(function (root) {
  'use strict';
  /* "Is the user typing?" for every document-level key handler (architect review 2026-11-16, must-fix 1).

     The file editor (files-ui.js, CodeMirror) lives in a shadow root (div.sf-code-host): a key event that reaches the document has
     the host as its target, not the editable text inside, so a plain e.target check says "not typing" and a page shortcut (`?`
     opens the shortcut sheet, End jumps the chat, Alt+N starts a chat) would fire while you type code. These helpers look inside:

       AgentTyping.target(e)    the real element the key went to: e.composedPath()[0] (inside a shadow root), else e.target
       AgentTyping.isField(el)  a text field: input, textarea, select, an editable element, or the file editor's host
       AgentTyping.isTyping(e)  the key went to a text field (or into the file editor)
       AgentTyping.skip(e)      isTyping(e) or another handler already took the key (e.defaultPrevented)
       AgentTyping.EDITOR       the editor host's selector ('.sf-code-host')
     Page handlers use skip(e) before acting on a plain key. */
  const EDITOR = '.sf-code-host';
  function target(e) {
    try {
      const path = e && typeof e.composedPath === 'function' ? e.composedPath() : null;
      if (path && path.length && path[0] && path[0].nodeType === 1) return path[0];
    } catch (err) {
      /* no path */
    }
    return (e && e.target) || null;
  }
  function isField(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable) return true;
    return !!(el.closest && el.closest(EDITOR + ', [contenteditable="true"], [contenteditable=""]'));
  }
  function isTyping(e) {
    if (!e) return false;
    return isField(target(e)) || isField(e.target);
  }
  function skip(e) {
    return !!(e && (e.defaultPrevented || isTyping(e)));
  }
  const api = { target, isField, isTyping, skip, EDITOR };
  root.AgentTyping = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

'use strict';
/* Where the keyboard focus goes back to when something that floated over the chat page closes (a menu, a card you answered, a
   dialog, the image viewer, the file picker): the place you were typing in before it opened, normally the message box (#prompt).

   The page keeps one note, `home`: the last text box you were in (a textarea, a text input, an editable area), or the last control
   you reached with the keyboard (Tab), outside any popup. A button that took the focus only because the mouse pressed it (a chip,
   ▾, ✎) is not a place you were: closing what it opened puts you back in the box you were typing in, not on the button.

   api (window.AgentFocusReturn):
     back()        focus `home` (else #prompt) when it can take the focus; preventScroll. true when it did.
     home()        that element, or null.
     lost()        the focus is on the page itself (nothing has it), as after a popup closed under it.
   and one safety net: when the element that had the focus was in a popup (a menu, a dialog, a card) and is gone or hidden now,
   leaving the focus on the page, it goes back() (checked on focus changes and every 250 ms: a removed element fires no event).
   Nothing happens when the focus is anywhere else (you clicked or tabbed somewhere on purpose). */
(function (root) {
  const POPUP =
    '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], dialog, .send-menu, .chip-menu, #approvals, #questions, #authPrompts, #setupQuestions';
  const TEXT = 'textarea, input:not([type]), input[type="text"], input[type="search"], [contenteditable="true"], [contenteditable=""]';
  let home = null, // the place to come back to
    cur = null, // the element in focus (or last in focus)
    curInPopup = false;

  const doc = () => root.document;
  function usable(el) {
    if (!el || el.isConnected === false || el.disabled) return false;
    if (el.closest && el.closest('[hidden], [inert]')) return false;
    return !el.getClientRects || el.getClientRects().length > 0;
  }
  function inPopup(el) {
    return !!(el && el.closest && el.closest(POPUP));
  }
  function keyboardFocused(el) {
    try {
      return !!(el && el.matches && el.matches(':focus-visible'));
    } catch (e) {
      return false;
    }
  }
  function noteFocus(el) {
    if (!el || el === doc().body || el === doc().documentElement) return;
    cur = el;
    curInPopup = inPopup(el);
    if (curInPopup) return;
    if ((el.matches && el.matches(TEXT)) || keyboardFocused(el)) home = el;
  }
  function homeEl() {
    if (usable(home)) return home;
    const p = doc().getElementById('prompt');
    return usable(p) ? p : null;
  }
  function lost() {
    const a = doc().activeElement;
    return !a || a === doc().body || a === doc().documentElement;
  }
  function back() {
    const el = homeEl();
    if (!el || !el.focus) return false;
    el.focus({ preventScroll: true });
    return doc().activeElement === el;
  }
  /* The safety net: the focused element was in a popup and went away (removed, hidden, disabled) with the focus left on the page. */
  function check() {
    if (!cur || !curInPopup || !lost() || usable(cur)) return false;
    cur = null;
    curInPopup = false;
    if (doc().querySelector && doc().querySelector('dialog[open]')) return false; // a dialog is up: it keeps its own focus
    return back();
  }
  /* Leaving the app (Alt+Tab, the taskbar, another window) with the caret in a text box, then coming back: the caret goes back
     into that box at the same place and selection (owner, 2026-11-15: back from another app, the message box had lost the
     caret). Not when you came back by clicking or typing somewhere else: a pointer or key press after the return wins. */
  let away = null,
    returnedAt = 0;
  function onWindowBlur(e) {
    if (e && e.target && e.target !== root && e.target !== doc()) return;
    const a = doc().activeElement;
    away = null;
    if (!a || !a.matches || !a.matches(TEXT) || inPopup(a)) return;
    let sel = null;
    try {
      if (typeof a.selectionStart === 'number') sel = [a.selectionStart, a.selectionEnd, a.selectionDirection || 'none'];
    } catch (err) {}
    away = { el: a, sel };
  }
  function restoreCaret(w) {
    if (!w || !usable(w.el)) return false;
    const a = doc().activeElement;
    if (a !== w.el && !lost()) return false; // the focus is somewhere else on purpose
    if (a !== w.el && w.el.focus) w.el.focus({ preventScroll: true });
    if (doc().activeElement !== w.el) return false;
    if (w.sel)
      try {
        w.el.setSelectionRange(w.sel[0], w.sel[1], w.sel[2]);
      } catch (err) {}
    return true;
  }
  function onWindowFocus(e) {
    if (e && e.target && e.target !== root && e.target !== doc()) return;
    const w = away;
    away = null;
    if (!w) return;
    const at = (returnedAt = Date.now());
    restoreCaret(w);
    // once more after the page's own work on coming back (redraws, polls), unless you pressed something since
    const later = () => {
      if (returnedAt === at) restoreCaret(w);
    };
    (root.setTimeout || setTimeout)(later, 0);
    (root.setTimeout || setTimeout)(later, 150);
  }
  function pressed() {
    returnedAt = 0;
  }
  function init() {
    const d = doc();
    if (!d || !d.addEventListener) return;
    if (root.addEventListener) {
      root.addEventListener('blur', onWindowBlur);
      root.addEventListener('focus', onWindowFocus);
    }
    d.addEventListener('pointerdown', pressed, true);
    d.addEventListener('keydown', pressed, true);
    d.addEventListener('focusin', (e) => noteFocus(e.target), true);
    d.addEventListener('focusout', () => (root.setTimeout || setTimeout)(check, 0), true);
    (root.setInterval || setInterval)(check, 250);
    if (d.activeElement) noteFocus(d.activeElement);
  }
  const api = { back, home: homeEl, lost, check, init, _usable: usable, _windowBlur: onWindowBlur, _windowFocus: onWindowFocus };
  root.AgentFocusReturn = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
  else init();
})(typeof window !== 'undefined' ? window : globalThis);

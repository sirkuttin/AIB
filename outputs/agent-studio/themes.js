'use strict';
/* Colour themes: the list the Settings picker offers, and the switch on <html data-theme>. Loaded as the first script in
   chat.html's <head>, without defer, so the right theme is on <html> before anything is painted (no flash of the default).
   The colours themselves are token blocks in theme.css; docs/THEMES.md lists every token.

   Which theme: the server writes the saved choice onto <html data-theme-pref="..."> (server/web/server.ts, from the data
   folder's view preferences, key aib-theme); without it (a page opened another way) localStorage's aib-theme is used. Saving
   writes localStorage, and view-prefs.js copies that key into the data folder like the text size. "Match system" follows the
   operating system's light/dark setting live.

   Adding a theme: one block in theme.css, one entry in THEMES below (id = the block's data-theme value). */
(function (root) {
  const KEY = 'aib-theme';
  const THEMES = Object.freeze([
    { id: 'teal-dark', label: 'AIB teal (dark)', group: 'AIB', scheme: 'dark' },
    { id: 'teal-light', label: 'AIB teal (light)', group: 'AIB', scheme: 'light' },
    { id: 'classic', label: 'Classic purple (dark)', group: 'AIB', scheme: 'dark' },
  ]);
  const DEFAULT = 'teal-dark';
  /* Not a theme of its own: picks one of these by the operating system's setting. */
  const SYSTEM = Object.freeze({ id: 'system', label: 'Match system', group: 'AIB', dark: 'teal-dark', light: 'teal-light' });
  const GROUPS = Object.freeze(['AIB']);

  const known = (id) => THEMES.some((t) => t.id === id);
  const valid = (id) => id === SYSTEM.id || known(id);
  /** The theme to paint for a saved choice: unknown or missing -> the default; 'system' -> light or dark by the OS. */
  function resolve(pref, prefersLight) {
    if (pref === SYSTEM.id) return prefersLight ? SYSTEM.light : SYSTEM.dark;
    return known(pref) ? pref : DEFAULT;
  }

  const doc = () => root.document;
  let media = null;
  const prefersLight = () => {
    try {
      if (!media && root.matchMedia) media = root.matchMedia('(prefers-color-scheme: light)');
      return !!(media && media.matches);
    } catch (e) {
      return false;
    }
  };
  function storage() {
    try {
      return root.localStorage || null;
    } catch (e) {
      return null;
    }
  }
  /** The saved choice: what the server wrote on <html>, else localStorage, else the default. */
  function saved() {
    const html = doc() && doc().documentElement;
    const fromServer = html && html.getAttribute && html.getAttribute('data-theme-pref');
    if (valid(fromServer)) return fromServer;
    const s = storage();
    let v = null;
    try {
      v = s && s.getItem(KEY);
    } catch (e) {}
    return valid(v) ? v : DEFAULT;
  }
  let current = null;
  /** Paint a saved choice (no saving). Returns the theme id now on <html>. */
  function paint(pref) {
    const html = doc() && doc().documentElement;
    const id = resolve(pref, prefersLight());
    if (html && html.setAttribute) {
      html.setAttribute('data-theme', id);
      html.setAttribute('data-theme-pref', pref);
    }
    current = pref;
    return id;
  }
  /** Pick a theme from Settings: paints it at once and saves it (localStorage; view-prefs.js copies it to the data folder). */
  function choose(pref) {
    if (!valid(pref)) return null;
    const s = storage();
    try {
      if (s) s.setItem(KEY, pref);
    } catch (e) {}
    return paint(pref);
  }
  function boot() {
    paint(saved());
    try {
      if (prefersLight() !== null && media && media.addEventListener)
        media.addEventListener('change', () => {
          if (current === SYSTEM.id) paint(SYSTEM.id);
        });
    } catch (e) {}
  }

  const api = { KEY, THEMES, SYSTEM, GROUPS, DEFAULT, resolve, valid, saved, paint, choose, current: () => current || saved() };
  root.AibThemes = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof document !== 'undefined' && root === (typeof window !== 'undefined' ? window : null)) boot();
})(typeof window !== 'undefined' ? window : globalThis);

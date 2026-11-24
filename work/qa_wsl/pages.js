'use strict';
/* The pages the QA run loads: chat.html with its own stylesheets (file: URLs) and only the scripts a screen needs, then a fixture
   script. Written into the scratch folder; nothing is served. */
const fs = require('node:fs'),
  path = require('node:path');
const { pathToFileURL } = require('node:url');
const APP = path.join(__dirname, '..', '..', 'app', 'page');
const MOCKUP = path.join(__dirname, '..', '..', 'outputs', 'wsl-linking-mockup.html');

const SETTINGS_SCRIPTS = ['wsl-ui.js', 'terminal-ui.js', 'composer-chips.js', 'settings-ui.js', 'wsl-settings-ui.js', 'delete-project-ui.js'];
const OTHER_SCRIPTS = [
  'wsl-ui.js',
  'terminal-ui.js',
  'status-words.js',
  'ownership-ui.js',
  'notify-rules.js',
  'sidebar-ui.js',
  'workspace-state.js',
  'split-tree.js',
  'new-project-ui.js',
  'delete-project-ui.js',
  'workspace-ui.js',
  'doc-icons.js',
  'artifacts-ui.js',
];

function page(scratch, name, scripts, fixture, theme) {
  let html = fs.readFileSync(path.join(APP, 'chat.html'), 'utf8');
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  html = html.replace(/href="\/([\w.-]+\.css)"/g, (_, f) => `href="${pathToFileURL(path.join(APP, f)).href}"`);
  html = html.replace('<html lang="en">', `<html lang="en"${theme ? ` data-theme="${theme}"` : ''}>`);
  const tags = scripts.map((s) => `<script src="${pathToFileURL(path.join(APP, s)).href}"></script>`).join('');
  html = html.replace('</body>', `${tags}<script src="${pathToFileURL(fixture).href}"></script></body>`);
  const file = path.join(scratch, `${name}-${theme || 'default'}.html`);
  fs.writeFileSync(file, html);
  return pathToFileURL(file).href;
}

// The mockup, with the state picked from the hash and the theme set (it embeds its own copy of theme.css / settings.css).
function mockup(scratch, theme) {
  let html = fs.readFileSync(MOCKUP, 'utf8');
  html = html.replace(/<html lang="en" data-theme="[^"]*">/, `<html lang="en" data-theme="${theme}">`);
  const pick = `<script>(function(){var s=decodeURIComponent(location.hash.slice(1))||'good';var b=document.querySelector('#mkStates [data-state="'+s+'"]');if(b)b.click();var bar=document.querySelector('.mk-bar');bar.remove();document.body.style.gridTemplateRows='minmax(0,1fr)';window.__qaDone=true;})();</script>`;
  html = html.replace('</body>', pick + '</body>');
  const file = path.join(scratch, `mockup-${theme}.html`);
  fs.writeFileSync(file, html);
  return pathToFileURL(file).href;
}

module.exports = { APP, MOCKUP, page, mockup, SETTINGS_SCRIPTS, OTHER_SCRIPTS };

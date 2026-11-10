'use strict';
/* Which page files the Deno server serves, for the Node tests: the same rule as studioAsset() in
   outputs/agent-studio/server/web/server.ts. The pattern and the monitor-only names are read from that file, so this cannot drift
   from the server. Not a test file: node --test work/test_*.js does not pick it up. */
const { APP } = require('./_paths');
const fs = require('node:fs'),
  path = require('node:path');

const SOURCE = fs.readFileSync(path.join(APP, 'server', 'web', 'server.ts'), 'utf8');

function read(name, pattern) {
  const match = SOURCE.match(pattern);
  if (!match) throw new Error(`${name} not found in server/web/server.ts`);
  return match[1];
}

const ASSET_NAME = new RegExp(read('ASSET_NAME', /^const ASSET_NAME = \/(.+)\/;$/m));
const MONITOR_ASSETS = new Set(
  [...read('MONITOR_ASSETS', /^const MONITOR_ASSETS = new Set\(\[([^\]]*)\]\);$/m).matchAll(/'([^']+)'/g)].map((m) => m[1]),
);

/** The page file the server answers `requestPath` with, or null when it does not serve it. */
function servedAsset(requestPath) {
  if (requestPath === '/' || requestPath === '/chat.html') return 'chat.html';
  const match = typeof requestPath === 'string' ? requestPath.match(ASSET_NAME) : null;
  if (!match || MONITOR_ASSETS.has(match[1])) return null;
  try {
    return fs.statSync(path.join(APP, match[1])).isFile() ? match[1] : null;
  } catch {
    return null;
  }
}

module.exports = { servedAsset, ASSET_NAME, MONITOR_ASSETS };

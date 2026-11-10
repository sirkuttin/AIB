'use strict';
/* Lint for the page code (outputs/agent-studio/*.js). Run: npm run lint. There is no build step; this only reads the files.
   Rules: ESLint's recommended set, plus no assignment to innerHTML / outerHTML (the page builds its DOM from nodes and textContent).
   Relaxed rules are listed in outputs/agent-studio/docs/FRONTEND.md as later cleanups. */
const js = require('@eslint/js');

const read = names => Object.fromEntries(names.map(name => [name, 'readonly']));

// What every page script may use from the browser (and from Node, when a module is also required by the tests).
const browser = read([
  'window', 'document', 'globalThis', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage', 'console', 'screen',
  'fetch', 'Headers', 'Request', 'Response', 'URL', 'URLSearchParams', 'AbortController', 'FormData', 'Blob', 'File', 'FileReader', 'TextDecoder', 'TextEncoder',
  'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'DOMParser',
  'Node', 'Element', 'HTMLElement', 'Image', 'Audio', 'Notification', 'BroadcastChannel', 'WebSocket', 'EventSource', 'crypto',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask', 'structuredClone',
  'confirm', 'alert', 'prompt', 'getComputedStyle', 'matchMedia', 'btoa', 'atob', 'encodeURIComponent', 'decodeURIComponent', 'performance', 'getSelection',
]);


module.exports = [
  { ignores: ['node_modules/**', '**/*.min.js', 'outputs/agent-studio/docs/**'] },
  {
    files: ['outputs/agent-studio/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: { ...browser, ...read(['module']) } },   // module: the "also usable from node" line at the end of most scripts
    rules: {
      ...js.configs.recommended.rules,
      // Relaxed so today's code passes without behaviour changes. Each one is a later cleanup, listed in docs/FRONTEND.md.
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],   // about 20 leftovers: shown as warnings, not fixed here
      'no-empty': ['error', { allowEmptyCatch: true }],                       // the page uses empty catch blocks on purpose (storage may be blocked)
      'no-useless-escape': 'off',
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
      'no-control-regex': 'off',
      'no-restricted-syntax': ['error',
        { selector: "AssignmentExpression[left.property.name='innerHTML']", message: 'Build nodes (createElement, textContent, append) instead of assigning innerHTML.' },
        { selector: "AssignmentExpression[left.property.name='outerHTML']", message: 'Build nodes (createElement, textContent, append) instead of assigning outerHTML.' },
        { selector: "AssignmentExpression[left.property.value='innerHTML']", message: 'Build nodes instead of assigning innerHTML.' },
        { selector: "AssignmentExpression[left.property.value='outerHTML']", message: 'Build nodes instead of assigning outerHTML.' },
      ],
    },
  },
  // chat.js is the last script: it uses AgentChoice (agent-choice.js) by its bare name, and exports only window.AgentStudioGet, window.AgentChatView and the test hook window.StudioChat.
  { files: ['outputs/agent-studio/chat.js'], languageOptions: { globals: { AgentChoice: 'readonly' } } },
  // These two pull a sibling module with require() when the tests load them in node.
  { files: ['outputs/agent-studio/artifacts-ui.js', 'outputs/agent-studio/attention-ui.js'], languageOptions: { globals: { require: 'readonly' } } },
  { files: ['eslint.config.js'], languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { require: 'readonly', module: 'writable' } }, rules: js.configs.recommended.rules },
];

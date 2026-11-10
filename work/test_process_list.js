'use strict';
const { APP: APP_DIR } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const A = require(path.join(APP_DIR, 'activity-ui.js'));

test('process title prefers the agent description, else the command, on one line', () => {
  assert.equal(A.processTitle({ description: 'Wait for the build', command: 'sleep 99' }), 'Wait for the build');
  assert.equal(A.processTitle({ title: 'cd work;\n ls x', command: 'cd work; ls x' }), 'cd work; ls x');
  assert.equal(A.processTitle({ command: 'echo hi' }), 'echo hi');
  assert.equal(A.processTitle({}), 'Command');
});
test('hover keeps the full command under a different title, and extras follow', () => {
  assert.equal(
    A.processHover({ description: 'Wait', command: 'sleep 99' }, ['Completed']),
    'Wait\n$ sleep 99\nCompleted',
  );
  assert.equal(A.processHover({ command: 'sleep 99' }), 'sleep 99');
});
test('unknown status is labelled honestly', () => {
  assert.equal(A.processStatusText('unknown'), 'Status unknown');
  assert.equal(A.processStatusText('completed'), 'completed');
});

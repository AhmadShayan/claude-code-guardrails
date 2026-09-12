'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runHook, toolCall } = require('./helpers');

test('an ordinary command passes straight through', () => {
  const { status, stderr, decision } = runHook(toolCall('Bash', { command: 'npm test' }));
  assert.equal(status, 0);
  assert.equal(decision, null);
  assert.equal(stderr, '');
});

test('unreadable input exits 1 with a message instead of passing silently', () => {
  const { status, stderr, decision } = runHook('{"tool_name": ');
  assert.equal(status, 1);
  assert.equal(decision, null);
  assert.match(stderr, /could not read the hook input/);
});

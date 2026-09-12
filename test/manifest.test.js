'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const guards = require('../scripts/guards');
const { HOOK_BUDGET_MS } = require('../scripts/lib/runner');

const root = path.join(__dirname, '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const hookEntries = () => Object.values(readJson('hooks/hooks.json').hooks).flat().flatMap((entry) => entry.hooks);

test('plugin, marketplace and package agree on name and version', () => {
  const plugin = readJson('.claude-plugin/plugin.json');
  const marketplace = readJson('.claude-plugin/marketplace.json');
  const pkg = readJson('package.json');
  const entry = marketplace.plugins.find((p) => p.name === plugin.name);
  assert.ok(entry, 'the marketplace lists the plugin');
  assert.equal(entry.source, './');
  assert.equal(plugin.name, pkg.name);
  assert.equal(plugin.version, pkg.version);
});

test('every hook command points at a script that exists', () => {
  const commands = hookEntries().map((hook) => hook.command);
  assert.ok(commands.length > 0);
  for (const command of commands) {
    const match = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/.exec(command);
    assert.ok(match, `${command} is resolved from the plugin root`);
    assert.ok(fs.existsSync(path.join(root, match[1])), `${match[1]} exists`);
  }
});

test('the hook timeout leaves room for the whole git budget', () => {
  for (const hook of hookEntries()) {
    assert.ok(hook.timeout * 1000 >= HOOK_BUDGET_MS + 5000, `a ${hook.timeout}s hook timeout must exceed the ${HOOK_BUDGET_MS / 1000}s git budget by at least 5s`);
  }
});

test('every guard has a unique id, the tools it checks and a check function', () => {
  const ids = new Set();
  for (const guard of guards) {
    assert.match(guard.id, /^[a-z]+(-[a-z]+)*$/);
    assert.ok(!ids.has(guard.id), `${guard.id} is unique`);
    ids.add(guard.id);
    assert.ok(Array.isArray(guard.tools) && guard.tools.length > 0, `${guard.id} names its tools`);
    assert.equal(typeof guard.check, 'function');
  }
});

test('the hook matcher reaches every tool a guard checks', () => {
  const { hooks } = readJson('hooks/hooks.json');
  const matchers = hooks.PreToolUse.map((entry) => new RegExp(`^(?:${entry.matcher})$`));
  for (const guard of guards) {
    for (const tool of guard.tools) {
      assert.ok(matchers.some((re) => re.test(tool)), `${tool} (used by ${guard.id}) reaches the hook`);
    }
  }
});

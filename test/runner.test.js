'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('../scripts/lib/runner');

const guard = (id, tools, check) => ({ id, tools, check });
const call = (toolName, toolInput = {}) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, cwd: '/project' });
const reasonOf = (out) => JSON.parse(out.stdout).hookSpecificOutput.permissionDecisionReason;

test('allows the call when no guard objects', () => {
  const out = decide(call('Bash', { command: 'ls' }), { registry: [guard('quiet', ['Bash'], () => null)] });
  assert.deepEqual(out, { stdout: '', stderr: '', exitCode: 0 });
});

test('denies with the reason of the first guard that objects', () => {
  const out = decide(call('Bash'), {
    registry: [guard('quiet', ['Bash'], () => null), guard('first', ['Bash'], () => 'First reason.'), guard('second', ['Bash'], () => 'Second reason.')],
  });
  const decision = JSON.parse(out.stdout).hookSpecificOutput;
  assert.equal(decision.hookEventName, 'PreToolUse');
  assert.equal(decision.permissionDecision, 'deny');
  assert.equal(decision.permissionDecisionReason, 'Blocked by claude-code-guardrails (first). First reason.');
  assert.equal(out.exitCode, 0);
});

test('only runs guards registered for the tool being called', () => {
  let ran = false;
  const out = decide(call('Read', { file_path: 'x' }), {
    registry: [guard('bash-only', ['Bash'], () => {
      ran = true;
      return 'No.';
    })],
  });
  assert.equal(ran, false);
  assert.equal(out.stdout, '');
});

test('skips guards named in CLAUDE_GUARDRAILS_DISABLE', () => {
  const out = decide(call('Bash'), { env: { CLAUDE_GUARDRAILS_DISABLE: ' other, noisy ' }, registry: [guard('noisy', ['Bash'], () => 'No.')] });
  assert.equal(out.stdout, '');
  assert.equal(out.exitCode, 0);
});

test('reports a crashing guard on stderr instead of silently allowing', () => {
  const out = decide(call('Bash'), {
    registry: [guard('fragile', ['Bash'], () => {
      throw new Error('boom');
    })],
  });
  assert.equal(out.exitCode, 1);
  assert.equal(out.stdout, '');
  assert.match(out.stderr, /fragile: boom/);
});

test('a crash in one guard does not stop another guard from denying', () => {
  const out = decide(call('Bash'), {
    registry: [
      guard('fragile', ['Bash'], () => {
        throw new Error('boom');
      }),
      guard('strict', ['Bash'], () => 'No.'),
    ],
  });
  assert.match(reasonOf(out), /\(strict\)/);
});

test('guards receive the payload and a context that tests can override', () => {
  let seen;
  decide(call('Bash', { command: 'pwd' }), {
    context: { platform: 'test-os', homedir: '/home/test' },
    registry: [guard('probe', ['Bash'], (payload, ctx) => {
      seen = { command: payload.tool_input.command, platform: ctx.platform, homedir: ctx.homedir, git: typeof ctx.git };
      return null;
    })],
  });
  assert.deepEqual(seen, { command: 'pwd', platform: 'test-os', homedir: '/home/test', git: 'function' });
});

test('unreadable or empty input is reported, not treated as safe', () => {
  for (const raw of ['not json', 'null', '']) {
    const out = decide(raw);
    assert.equal(out.exitCode, 1, `input ${JSON.stringify(raw)}`);
    assert.match(out.stderr, /could not read the hook input/);
  }
});

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const RUN = path.join(__dirname, '..', 'scripts', 'run.js');

// Runs the hook the way Claude Code does: a fresh node process with the payload on stdin.
function runHook(payload, env = {}) {
  const childEnv = { ...process.env, ...env };
  if (!('CLAUDE_GUARDRAILS_DISABLE' in env)) delete childEnv.CLAUDE_GUARDRAILS_DISABLE;
  const result = spawnSync(process.execPath, [RUN], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: childEnv,
  });
  const out = result.stdout.trim();
  return {
    status: result.status,
    stderr: result.stderr,
    decision: out ? JSON.parse(out).hookSpecificOutput : null,
  };
}

function toolCall(toolName, toolInput, cwd = process.cwd()) {
  return { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, cwd };
}

module.exports = { runHook, toolCall };

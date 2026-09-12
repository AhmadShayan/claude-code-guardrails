'use strict';

const os = require('os');
const { execFileSync } = require('child_process');
const guards = require('../guards');

const UNREADABLE = 'claude-code-guardrails could not read the hook input, so no guard checked this call.\n';

function readStdin(stream) {
  return new Promise((resolve, reject) => {
    let raw = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      raw += chunk;
    });
    stream.on('end', () => resolve(raw));
    stream.on('error', reject);
  });
}

// Guards read what git prints, so git is asked to answer in English whatever the machine's
// language, and not to take optional locks while it only looks.
function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
}

function disabledIds(env) {
  return new Set(
    String(env.CLAUDE_GUARDRAILS_DISABLE || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

function denial(id, reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Blocked by claude-code-guardrails (${id}). ${reason}`,
    },
  };
}

// Runs every enabled guard that applies to the tool being called, and the first one to
// object decides. A guard that crashes never blocks the call, but the crash is reported on
// stderr with exit code 1. Claude Code then shows a hook error, instead of the guard
// quietly letting everything through.
function decide(raw, { env = {}, registry = guards, context = {} } = {}) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { stdout: '', stderr: UNREADABLE, exitCode: 1 };
  }
  if (!payload || typeof payload !== 'object') return { stdout: '', stderr: UNREADABLE, exitCode: 1 };

  const ctx = { env, platform: process.platform, homedir: os.homedir(), git, ...context };
  const disabled = disabledIds(env);
  const failures = [];

  for (const guard of registry) {
    if (disabled.has(guard.id) || !guard.tools.includes(payload.tool_name)) continue;
    let reason;
    try {
      reason = guard.check(payload, ctx);
    } catch (err) {
      failures.push(`${guard.id}: ${err && err.message ? err.message : String(err)}`);
      continue;
    }
    if (reason) return { stdout: JSON.stringify(denial(guard.id, reason)), stderr: '', exitCode: 0 };
  }

  if (failures.length) {
    return {
      stdout: '',
      stderr: `claude-code-guardrails: a guard failed, so it did not check this call. ${failures.join('; ')}\n`,
      exitCode: 1,
    };
  }
  return { stdout: '', stderr: '', exitCode: 0 };
}

module.exports = { readStdin, decide, denial };

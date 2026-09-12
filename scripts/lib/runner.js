'use strict';

const os = require('os');
const { execFileSync } = require('child_process');
const guards = require('../guards');

const UNREADABLE = 'claude-code-guardrails could not read the hook input, so no guard checked this call.\n';

// hooks/hooks.json gives the hook 30 seconds. All of a call's questions to git share this
// budget, so the hook always answers, with a refusal if it has to, before Claude Code stops
// waiting for it. test/manifest.test.js fails the build if the two numbers drift apart.
const HOOK_BUDGET_MS = 20000;
const GIT_TIMEOUT_MS = 5000;

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

// Guards read what git prints, so git answers in English whatever the machine's language,
// takes no optional locks while it only looks, and never stops to ask for a password. A
// failed call keeps git's stderr on the error, which lets a guard tell "not a repository"
// apart from "could not check". A spent budget fails the same way a timeout does.
function makeGit(deadline) {
  return function git(args, cwd) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw Object.assign(new Error('the hook ran out of time before git answered'), { code: 'ETIMEDOUT' });
    }
    return execFileSync('git', args, {
      cwd,
      env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: Math.min(GIT_TIMEOUT_MS, remaining),
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
  };
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
// quietly letting everything through. That message is printed as it is, so a guard must
// never put anything from tool_input into an error it throws.
function decide(raw, { env = {}, registry = guards, context = {} } = {}) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { stdout: '', stderr: UNREADABLE, exitCode: 1 };
  }
  if (!payload || typeof payload !== 'object') return { stdout: '', stderr: UNREADABLE, exitCode: 1 };

  const ctx = { env, platform: process.platform, homedir: os.homedir(), git: makeGit(Date.now() + HOOK_BUDGET_MS), ...context };
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

module.exports = { readStdin, decide, denial, makeGit, HOOK_BUDGET_MS, GIT_TIMEOUT_MS };

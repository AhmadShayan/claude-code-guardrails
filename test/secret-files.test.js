'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../scripts/guards/secret-files');
const { runHook, toolCall } = require('./helpers');

const reason = (toolName, toolInput) => guard.check({ tool_name: toolName, tool_input: toolInput }, {});

test('secretKind recognises secret files and leaves templates alone', () => {
  const secrets = [
    '.env',
    '.env.local',
    '.env.production.local',
    'config/prod.env',
    '.envrc',
    'C:\\app\\.env',
    '/home/me/.ssh/id_ed25519',
    'certs/server.key',
    'tls.pem',
    'store.p12',
    '/home/me/.aws/credentials',
    '.netrc',
    'serviceAccountKey.json',
    'my-project-service-account.json',
    'my-app-firebase-adminsdk-ab12c-3456789.json',
    'client_secret_123.apps.googleusercontent.com.json',
  ];
  for (const name of secrets) assert.ok(guard.secretKind(name), `${name} is a secret file`);

  const ordinary = ['.env.example', '.env.local.example', '.env.sample', '.env.template', '.env.dist', 'example.env', '.venv', 'environment.ts', 'id_ed25519.pub', 'credentials.md', 'package.json', 'src/env.js', ''];
  for (const name of ordinary) assert.equal(guard.secretKind(name), null, `${name} is not a secret file`);
});

test('blocks reading secret files with the Read tool', () => {
  assert.match(reason('Read', { file_path: 'C:\\Users\\me\\app\\.env.local' }), /^`\.env\.local` is an environment file/);
  assert.match(reason('Read', { file_path: '/home/me/.ssh/id_rsa' }), /is an SSH private key/);
  assert.equal(reason('Read', { file_path: '/home/me/app/.env.example' }), null);
  assert.equal(reason('Read', { file_path: '/home/me/app/src/index.ts' }), null);
  assert.equal(reason('Read', {}), null);
});

test('the advice for an environment file never suggests a command the guard would block', () => {
  const text = reason('Read', { file_path: 'C:\\Users\\me\\my app\\.env' });
  assert.match(text, /grep -q '\^VARIABLE_NAME=' 'C:\/Users\/me\/my app\/\.env' && echo set/);
  assert.equal(reason('Bash', { command: "grep -q '^VARIABLE_NAME=' .env && echo set" }), null);
  assert.equal(reason('Bash', { command: 'set -a; . ./.env; set +a' }), null);
});

test('blocks Grep only when it would print lines from a secret file', () => {
  assert.ok(reason('Grep', { pattern: 'KEY', path: '.env', output_mode: 'content' }));
  assert.ok(reason('Grep', { pattern: 'KEY', glob: '**/.env*', output_mode: 'content' }));
  assert.equal(reason('Grep', { pattern: 'KEY', path: '.env' }), null);
  assert.equal(reason('Grep', { pattern: 'KEY', path: '.env', output_mode: 'count' }), null);
  assert.equal(reason('Grep', { pattern: 'KEY', glob: '*.env.example', output_mode: 'content' }), null);
  assert.equal(reason('Grep', { pattern: 'KEY', path: 'src', output_mode: 'content' }), null);
});

test('blocks shell commands that print a secret file', () => {
  const printing = [
    'cat .env',
    'cat ./config/.env.production',
    'head -n 3 .env.local',
    'bash -c "cat .env"',
    'echo "$(cat .env)"',
    'cat < .env',
    'grep API_KEY .env',
    'grep -A 2 -i stripe .env.local',
    'rg -e SECRET .env',
    "awk -F= '{print $2}' .env",
    'jq . serviceAccountKey.json',
    'base64 ~/.ssh/id_ed25519',
    'type .env',
  ];
  for (const command of printing) assert.ok(reason('Bash', { command }), command);
  assert.ok(reason('PowerShell', { command: 'Get-Content .env | Select-Object -First 5' }));
  assert.ok(reason('PowerShell', { command: 'Select-String -Path .env -Pattern STRIPE' }));
});

test('lets through commands that use a secret file without printing it', () => {
  const quiet = [
    "grep -q '^API_KEY=' .env && echo set",
    'grep -c KEY .env',
    'grep --count KEY .env',
    'grep -l KEY .env .env.local',
    'grep .env .gitignore',
    'grep -e .env .gitignore',
    'jq .env package.json',
    'cat .env.example',
    'cp .env.example .env',
    'echo "API_KEY=abc" >> .env',
    'set -a; . ./.env; set +a',
    'rg -l SECRET .',
    'ls -la .env',
    'git status',
    "echo 'cat .env'",
  ];
  for (const command of quiet) assert.equal(reason('Bash', { command }), null, command);
  assert.equal(reason('PowerShell', { command: 'Select-String -Path .env -Pattern STRIPE -Quiet' }), null);
});

test('reads PowerShell paths with their backslashes intact', () => {
  assert.match(reason('PowerShell', { command: 'Get-Content C:\\Users\\me\\app\\.env.local' }) || '', /`\.env\.local` is an environment file/);
  assert.match(reason('PowerShell', { command: 'type "C:\\Users\\me\\my app\\.env"' }) || '', /`\.env` is an environment file/);
});

test('the hook denies a Read of .env end to end, and the guard can be switched off', () => {
  const call = toolCall('Read', { file_path: '.env' });
  const { status, decision } = runHook(call);
  assert.equal(status, 0);
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /^Blocked by claude-code-guardrails \(secret-files\)\. `\.env` is an environment file/);
  assert.equal(runHook(call, { CLAUDE_GUARDRAILS_DISABLE: 'secret-files' }).decision, null);
});

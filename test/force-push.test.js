'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const guard = require('../scripts/guards/force-push');
const { parseGit } = require('../scripts/lib/git');
const { runHook, toolCall } = require('./helpers');

const CWD = '/home/me/app';

// Stands in for git: answers the two questions the guard asks and fails on anything else.
function fakeGit({ branch = 'main', remoteDefault = null } = {}) {
  const calls = [];
  const git = (args, dir) => {
    const line = args.join(' ');
    calls.push({ line, dir });
    if (line === 'rev-parse --abbrev-ref HEAD') {
      if (branch === null) throw new Error('fatal: not a git repository');
      return `${branch}\n`;
    }
    if (line === 'symbolic-ref --quiet --short refs/remotes/origin/HEAD') {
      if (!remoteDefault) throw new Error('no origin/HEAD');
      return `origin/${remoteDefault}\n`;
    }
    throw new Error(`unexpected git call: ${line}`);
  };
  return { git, calls };
}

const reason = (command, gitOptions, toolName = 'Bash') => guard.check({ tool_name: toolName, tool_input: { command }, cwd: CWD }, { git: fakeGit(gitOptions).git });

test('parseGit reads the subcommand after git options and follows -C', () => {
  const parsed = parseGit(['git', '-C', 'app', '-c', 'core.pager=cat', '--no-pager', 'push', '-f'], '/home/me');
  assert.equal(parsed.subcommand, 'push');
  assert.deepEqual(parsed.args, ['-f']);
  assert.equal(parsed.dir, path.resolve('/home/me', 'app'));
  assert.equal(parseGit(['gitk'], '/x'), null);
  assert.equal(parseGit(['git'], '/x'), null);
  assert.equal(parseGit(['git', '--version'], '/x'), null);
});

test('blocks force-pushing main or master, however it is spelled', () => {
  const blocked = [
    'git push --force origin main',
    'git push -f origin master',
    'git push origin main --force-with-lease',
    'git push origin +main',
    'git push origin +HEAD:master',
    'git push origin feature:main -f',
    'git push origin refs/heads/main --force',
    'git push -fu origin main',
    'bash -c "git push -f origin main"',
    'git add . && git commit -m wip && git push --force origin main',
  ];
  for (const command of blocked) assert.match(reason(command, { branch: 'feature' }), /force-pushes `(main|master)`/, command);
  assert.ok(reason('git push --force origin main', {}, 'PowerShell'));
});

test('checks the current branch when the command does not name one', () => {
  assert.match(reason('git push -f', { branch: 'main' }), /force-pushes `main`/);
  assert.match(reason('git push --force-with-lease origin HEAD', { branch: 'master' }), /force-pushes `master`/);
  assert.equal(reason('git push -f', { branch: 'feature/login' }), null);
});

test('treats the remote default branch like main', () => {
  assert.match(reason('git push -f origin trunk', { remoteDefault: 'trunk' }), /force-pushes `trunk`/);
  assert.equal(reason('git push -f origin trunk', { remoteDefault: 'main' }), null);
});

test('refuses when it cannot tell which branch a force-push writes to', () => {
  assert.match(reason('git push -f', { branch: null }), /could not tell which branch/);
  assert.match(reason('git push -f origin "$(git branch --show-current)"', { branch: 'feature' }), /could not tell which branch/);
});

test('blocks --mirror and deleting main on the remote', () => {
  assert.match(reason('git push --mirror', {}), /--mirror/);
  assert.match(reason('git push origin --delete main', {}), /deletes the `main` branch/);
  assert.match(reason('git push -d origin master', {}), /deletes the `master` branch/);
  assert.match(reason('git push origin :main', {}), /deletes the `main` branch/);
});

test('allows ordinary pushes, feature branch force-pushes and dry runs', () => {
  const allowed = [
    'git push',
    'git push -u origin main',
    'git push origin main',
    'git push --force-with-lease origin feature/login',
    'git push origin +feature/login',
    'git push origin --delete old-feature',
    'git push --force --dry-run origin main',
    'git push -nf origin main',
    'echo "git push --force origin main"',
    'git pull --rebase origin main',
  ];
  for (const command of allowed) assert.equal(reason(command, { branch: 'feature/login' }), null, command);
});

test('asks git about the folder named with -C', () => {
  const { git, calls } = fakeGit({ branch: 'main' });
  const result = guard.check({ tool_name: 'Bash', tool_input: { command: 'git -C packages/web push -f' }, cwd: CWD }, { git });
  assert.match(result, /force-pushes `main`/);
  assert.equal(calls[0].dir, path.resolve(CWD, 'packages/web'));
});

test('the hook denies a force-push to main end to end', () => {
  const { status, decision } = runHook(toolCall('Bash', { command: 'git push --force origin main' }));
  assert.equal(status, 0);
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /^Blocked by claude-code-guardrails \(force-push\)\./);
});

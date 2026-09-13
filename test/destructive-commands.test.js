'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const guard = require('../scripts/guards/destructive-commands');
const { runHook, toolCall } = require('./helpers');

const LINUX = { platform: 'linux', homedir: '/home/me' };
const CWD = '/home/me/app';
const NOT_A_REPO = 'fatal: not a git repository (or any of the parent directories): .git\n';

// An error shaped like the one the runner's git helper throws, with git's stderr attached.
function gitError(stderr, extra = {}) {
  return Object.assign(new Error(`git failed: ${stderr.trim()}`), { status: 128, stderr, ...extra });
}

// Stands in for git with fixed answers, and answers "not a git repository" to anything else.
function fakeGit(answers = {}) {
  return (args) => {
    const line = args.join(' ');
    if (!(line in answers)) throw gitError(NOT_A_REPO);
    if (answers[line] instanceof Error) throw answers[line];
    return answers[line];
  };
}

function reason(command, { cwd = CWD, git = fakeGit(), toolName = 'Bash', ...ctx } = {}) {
  return guard.check({ tool_name: toolName, tool_input: { command }, cwd }, { ...LINUX, git, ...ctx });
}

test('blocks deleting the project, the home folder or the disk', () => {
  const blocked = {
    'rm -rf .': /deletes the folder Claude is working in/,
    'rm -rf ./': /deletes the folder Claude is working in/,
    'rm -rf "$PWD"': /deletes the folder Claude is working in/,
    'rm -rf $(pwd)': /deletes the folder Claude is working in/,
    'rm -rf /home/me/app': /deletes the folder Claude is working in/,
    'rm -rf ~': /deletes the home folder/,
    'rm -rf $HOME/': /deletes the home folder/,
    'rm -rf /': /deletes the root of the disk/,
    'sudo rm -rf --no-preserve-root /': /deletes the root of the disk/,
    'rm -r *': /deletes everything inside the folder Claude is working in/,
    'rm *': /deletes everything inside the folder Claude is working in/,
    'rm -rf ~/*': /deletes everything inside the home folder/,
    'rm -rf /*': /deletes everything inside the root of the disk/,
    'rm -rf .git': /entire history/,
    'rm -rf .git/*': /entire history/,
    'npm run build; rm -rf ../app': /deletes the folder Claude is working in/,
  };
  for (const [command, expected] of Object.entries(blocked)) assert.match(reason(command) || '', expected, command);
  assert.match(reason('rm -rf ..', { cwd: '/home/me/code/app' }) || '', /deletes a folder that contains the one Claude is working in/);
});

test('follows cd within the same command line', () => {
  assert.equal(reason('cd dist && rm -rf *'), null);
  assert.equal(reason('cd /tmp/build && rm -rf .'), null);
  assert.match(reason('cd ~ && rm -rf *') || '', /everything inside the home folder/);
  assert.match(reason('cd .. && rm -rf app') || '', /deletes the folder Claude is working in/);
});

test('allows deleting ordinary folders and paths it cannot see', () => {
  const allowed = [
    'rm -rf node_modules',
    'rm -rf ./dist .next',
    'rm -rf dist/*',
    'rm -f *.log',
    'rm -rf ~/Downloads/old-build',
    'rm -rf /tmp/claude-scratch',
    'rm -rf "$BUILD_DIR"',
    'rm -rf "$HOME/$PROJECT"',
    'rm .',
    'rmdir empty-folder',
    'echo "rm -rf /"',
    'git rm -r --cached .',
  ];
  for (const command of allowed) assert.equal(reason(command), null, command);
});

test('understands Windows paths, PowerShell and cmd', () => {
  const windows = { platform: 'win32', homedir: 'C:\\Users\\me', cwd: 'C:\\Users\\me\\app', toolName: 'PowerShell' };
  assert.match(reason('Remove-Item -Recurse -Force .', windows) || '', /deletes the folder Claude is working in/);
  assert.match(reason('Remove-Item -Path C:\\ -Recurse', windows) || '', /deletes the root of the disk/);
  assert.match(reason('rd /s /q %USERPROFILE%', windows) || '', /deletes the home folder/);
  assert.match(reason('del /s /q *', windows) || '', /deletes everything inside the folder Claude is working in/);
  assert.match(reason('rm -rf /c/Users/me', { ...windows, toolName: 'Bash' }) || '', /deletes the home folder/);
  assert.equal(reason('Remove-Item -Recurse -Force .\\dist', windows), null);
  assert.equal(reason('Remove-Item .\\notes.txt', windows), null);
});

test('blocks git reset --hard only when it would lose something', () => {
  const dirty = fakeGit({ 'status --porcelain --untracked-files=no': ' M src/app.ts\nM  README.md\n' });
  const clean = fakeGit({
    'status --porcelain --untracked-files=no': '',
    'rev-list --count origin/main..HEAD': '2\n',
    'rev-list --count HEAD~1..HEAD': '1\n',
    'rev-list --count v1..HEAD': '0\n',
  });
  assert.match(reason('git reset --hard', { git: dirty }) || '', /uncommitted changes in 2 files/);
  assert.equal(reason('git reset --hard', { git: clean }), null);
  assert.equal(reason('git reset --hard HEAD', { git: clean }), null);
  assert.match(reason('git reset --hard origin/main', { git: clean }) || '', /drops 2 commits from it/);
  assert.match(reason('git reset --hard HEAD~1', { git: clean }) || '', /drops 1 commit from it/);
  assert.equal(reason('git reset --hard v1', { git: clean }), null);
  assert.equal(reason('git reset --soft HEAD~1', { git: dirty }), null);
  assert.equal(reason('git reset --hard'), null, 'outside a repository the reset fails on its own');
});

test('blocks checkout, restore and switch that would discard changes', () => {
  const git = fakeGit({
    'status --porcelain --untracked-files=no -- .': ' M src/app.ts\n',
    'status --porcelain --untracked-files=no -- :/': ' M src/app.ts\n',
    'status --porcelain --untracked-files=no': ' M src/app.ts\n',
  });
  for (const command of ['git checkout -- .', 'git checkout .', 'git restore .', 'git restore --worktree :/', 'git checkout -f main', 'git switch --discard-changes main']) {
    assert.match(reason(command, { git }) || '', /uncommitted changes in 1 file,/, command);
  }
  for (const command of ['git checkout main', 'git checkout -b feature', 'git restore --staged .', 'git restore src/app.ts', 'git checkout -- src/app.ts', 'git switch -c feature']) {
    assert.equal(reason(command, { git }), null, command);
  }
  const cleanTree = fakeGit({ 'status --porcelain --untracked-files=no -- .': '', 'status --porcelain --untracked-files=no': '' });
  for (const command of ['git checkout -- .', 'git restore .', 'git checkout -f main', 'git switch --discard-changes main']) {
    assert.equal(reason(command, { git: cleanTree }), null, `${command} on a clean tree`);
  }
});

test('refuses to discard changes in files it cannot name', () => {
  const dirty = fakeGit({ 'status --porcelain --untracked-files=no': ' M src/app.ts\n' });
  assert.match(reason('git restore $(git diff --name-only)', { git: dirty }) || '', /files the guard cannot name until the shell runs, and 1 file has uncommitted changes/);
  assert.match(reason('git checkout -- "$(cat files.txt)"', { git: dirty }) || '', /cannot name until the shell runs/);
  assert.equal(reason('git checkout $(git branch --show-current)', { git: dirty }), null, 'without --, that word names a branch as often as a path');
  assert.equal(reason('git restore $(git diff --name-only)', { git: fakeGit({ 'status --porcelain --untracked-files=no': '' }) }), null);
});

test('blocks git clean only when there are untracked files to lose', () => {
  const git = fakeGit({ 'clean -n -d': 'Would remove build/\nWould remove notes.md\n', 'clean -n': '', 'clean -n -dx': 'Would remove .env\n' });
  assert.match(reason('git clean -fd', { git }) || '', /2 untracked files and folders, such as `build\/`, `notes\.md`/);
  assert.match(reason('git clean -f -d', { git }) || '', /2 untracked files and folders/);
  assert.match(reason('git clean -fdx', { git }) || '', /1 untracked file or folder, such as `\.env`/);
  assert.equal(reason('git clean -f', { git }), null);
  assert.equal(reason('git clean -n -d', { git }), null);
  assert.equal(reason('git clean -d', { git }), null);
});

test('refuses git clean when part of the command only gets its value once the shell runs', () => {
  const git = fakeGit({ 'clean -n -d': 'Would remove notes.md\n', 'clean -n -d -x': 'Would remove notes.md\nWould remove .env\n' });
  for (const command of ['git clean -fd $(printf .)', 'git clean -fd -e "$(cat keep.txt)"', 'git clean -f $DIR', 'git clean -fd -- "$DIR"', 'git clean $FLAGS']) {
    assert.match(reason(command, { git }) || '', /cannot tell what would be deleted/, command);
  }
  assert.equal(reason('git clean -n $(printf .)', { git }), null, 'a dry run deletes nothing');
  const nothingUntracked = fakeGit({ 'clean -n -d': '', 'clean -n -d -x': '' });
  assert.equal(reason('git clean -fd $DIR', { git: nothingUntracked }), null, 'with nothing untracked or ignored, there is nothing to lose');
});

test('refuses git reset --hard to a commit the shell fills in', () => {
  const clean = fakeGit({ 'status --porcelain --untracked-files=no': '' });
  for (const command of ['git reset --hard $REF', 'git reset --hard "${REF}"', 'git reset --hard $(git rev-parse HEAD~3)']) {
    assert.match(reason(command, { git: clean }) || '', /a commit the guard cannot see until the command runs/, command);
  }
  assert.match(reason('git reset --hard $env:REF', { git: clean, toolName: 'PowerShell' }) || '', /cannot see until the command runs/);
});

test('refuses a git stash action the shell fills in, when there are stashes to lose', () => {
  assert.match(reason('git stash $ACTION', { git: fakeGit({ 'stash list': 'stash@{0}: WIP\n' }) }) || '', /could be git stash clear, which deletes the saved stash/);
  assert.equal(reason('git stash $ACTION', { git: fakeGit({ 'stash list': '' }) }), null);
  assert.equal(reason('git stash push -m "$MESSAGE"', { git: fakeGit({ 'stash list': 'stash@{0}: WIP\n' }) }), null);
  assert.equal(reason('git stash -m "$MESSAGE"', { git: fakeGit({ 'stash list': 'stash@{0}: WIP\n' }) }), null);
});

test('blocks git stash clear when stashes exist, and gh repo delete', () => {
  assert.match(reason('git stash clear', { git: fakeGit({ 'stash list': 'stash@{0}: WIP\nstash@{1}: WIP\n' }) }) || '', /both saved stashes/);
  assert.equal(reason('git stash clear', { git: fakeGit({ 'stash list': '' }) }), null);
  assert.equal(reason('git stash pop'), null);
  assert.match(reason('gh repo delete me/app --yes') || '', /permanently deletes a GitHub repository/);
  assert.equal(reason('gh repo view me/app'), null);
});

test('refuses rather than guesses when git answers with an error', () => {
  const broken = gitError('fatal: index file smaller than expected\n');
  const unchecked = /could not check this repository/;
  assert.match(reason('git reset --hard', { git: fakeGit({ 'status --porcelain --untracked-files=no': broken }) }) || '', unchecked);
  assert.match(reason('git checkout -- .', { git: fakeGit({ 'status --porcelain --untracked-files=no -- .': broken }) }) || '', unchecked);
  assert.match(reason('git clean -fd', { git: fakeGit({ 'clean -n -d': broken }) }) || '', unchecked);
  assert.match(reason('git stash clear', { git: fakeGit({ 'stash list': broken }) }) || '', unchecked);
  assert.match(reason('git reset --hard HEAD~1', { git: fakeGit({ 'status --porcelain --untracked-files=no': '', 'rev-list --count HEAD~1..HEAD': broken }) }) || '', unchecked);
});

test('leaves a revision git does not know for git itself to refuse', () => {
  const git = fakeGit({
    'status --porcelain --untracked-files=no': '',
    'rev-list --count nope..HEAD': gitError("fatal: ambiguous argument 'nope..HEAD': unknown revision or path not in the working tree.\n"),
  });
  assert.equal(reason('git reset --hard nope', { git }), null);
});

test('a repository too slow to check is refused rather than waved through', () => {
  const timeout = Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });
  assert.match(reason('git reset --hard', { git: fakeGit({ 'status --porcelain --untracked-files=no': timeout }) }) || '', /could not check this repository/);
});

test('the hook blocks rm -rf . end to end', () => {
  const { status, decision } = runHook(toolCall('Bash', { command: 'rm -rf .' }, os.tmpdir()));
  assert.equal(status, 0);
  assert.match(decision.permissionDecisionReason, /^Blocked by claude-code-guardrails \(destructive-commands\)\. This deletes the folder Claude is working in/);
});

test('asks a real repository before blocking git commands', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'pipe' });
  const decide = (command) => runHook(toolCall('Bash', { command }, dir)).decision;

  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1);\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  assert.equal(decide('git reset --hard'), null, 'clean tree');
  assert.equal(decide('git clean -fd'), null, 'nothing untracked');

  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(2);\n');
  fs.writeFileSync(path.join(dir, 'notes.md'), 'draft\n');
  assert.match(decide('git reset --hard').permissionDecisionReason, /uncommitted changes in 1 file/);
  assert.match(decide('git checkout -- .').permissionDecisionReason, /uncommitted changes in 1 file/);
  assert.match(decide('git clean -fd').permissionDecisionReason, /1 untracked file or folder, such as `notes\.md`/);
  assert.match(decide('git clean -fd $(printf .)').permissionDecisionReason, /cannot tell what would be deleted/);
  assert.equal(decide('git clean -n'), null);

  git('stash', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'second');
  assert.match(decide('git reset --hard HEAD~1').permissionDecisionReason, /drops 1 commit from it/);
  assert.match(decide('git stash clear').permissionDecisionReason, /deletes the saved stash/);
});

test('outside any repository the git checks stand aside, because git refuses on its own', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const decide = (command) => runHook(toolCall('Bash', { command }, dir), { GIT_CEILING_DIRECTORIES: path.dirname(dir) }).decision;
  assert.equal(decide('git reset --hard'), null);
  assert.equal(decide('git clean -fdx'), null);
  assert.equal(decide('git stash clear'), null);
});

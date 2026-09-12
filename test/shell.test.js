'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SUBSTITUTION, tokenize, commandsOf, commandName } = require('../scripts/lib/shell');

const has = (commands, words) => commands.some((c) => JSON.stringify(c) === JSON.stringify(words));

test('splits on command separators and removes quotes', () => {
  assert.deepEqual(tokenize(`git add . && git commit -m "fix: it's done"; echo 'a  b' | cat || true & wait`), [
    ['git', 'add', '.'],
    ['git', 'commit', '-m', "fix: it's done"],
    ['echo', 'a  b'],
    ['cat'],
    ['true'],
    ['wait'],
  ]);
});

test('keeps redirections as words of their own', () => {
  assert.deepEqual(tokenize('cat < .env > out.txt 2>&1'), [['cat', '<', '.env', '>', 'out.txt', '2', '>&', '1']]);
  assert.deepEqual(tokenize('npm test &> log.txt'), [['npm', 'test', '&>', 'log.txt']]);
});

test('reads backslash escapes and empty quoted words', () => {
  assert.deepEqual(tokenize('echo a\\ b "" "say \\"hi\\""'), [['echo', 'a b', '', 'say "hi"']]);
});

test('finds commands inside $( ), backticks and ( ) subshells', () => {
  const found = commandsOf('echo "value: $(cat .env)" && (cd app && rm -rf dist) && echo `whoami`');
  assert.ok(has(found, ['cat', '.env']));
  assert.ok(has(found, ['echo', `value: ${SUBSTITUTION}`]));
  assert.ok(has(found, ['cd', 'app']));
  assert.ok(has(found, ['rm', '-rf', 'dist']));
  assert.ok(has(found, ['whoami']));
});

test('does not treat $( inside single quotes as a command', () => {
  assert.deepEqual(commandsOf(`echo '$(cat .env)'`), [['echo', '$(cat .env)']]);
});

test('opens up bash -c, sh -c, cmd /c, powershell -Command and eval', () => {
  assert.ok(has(commandsOf('bash -lc "cat .env"'), ['cat', '.env']));
  assert.ok(has(commandsOf("sh -c 'git push --force'"), ['git', 'push', '--force']));
  assert.ok(has(commandsOf('cmd /c type .env'), ['type', '.env']));
  assert.ok(has(commandsOf('powershell -Command "Get-Content .env"'), ['Get-Content', '.env']));
  assert.ok(has(commandsOf('eval "rm -rf /"'), ['rm', '-rf', '/']));
});

test('removes assignments and wrappers such as sudo, env and timeout', () => {
  assert.deepEqual(commandsOf('FOO=1 sudo -E -u root timeout 30s nice -n 10 rm -rf build'), [['rm', '-rf', 'build']]);
  assert.deepEqual(commandsOf('env -i PATH=/bin git status'), [['git', 'status']]);
});

test('commandName normalises paths, case and .exe', () => {
  assert.equal(commandName(['/usr/bin/git', 'status']), 'git');
  assert.equal(commandName(['C:\\Program Files\\Git\\cmd\\GIT.EXE']), 'git');
  assert.equal(commandName([]), '');
});

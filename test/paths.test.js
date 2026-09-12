'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { baseName, comparable, resolveFrom, nativeResolve, contains, isFilesystemRoot } = require('../scripts/lib/paths');

test('baseName reads both slash styles', () => {
  assert.equal(baseName('C:\\app\\.env.local'), '.env.local');
  assert.equal(baseName('/home/me/app/.env'), '.env');
  assert.equal(baseName('.env'), '.env');
});

test('comparable gives Windows, Git Bash and POSIX spellings one form', () => {
  assert.equal(comparable('C:\\Users\\Me\\app\\', 'win32'), '/c/users/me/app');
  assert.equal(comparable('/c/Users/Me/app', 'win32'), '/c/users/me/app');
  assert.equal(comparable('C:\\', 'win32'), '/c');
  assert.equal(comparable('/home/me/app/../app/', 'linux'), '/home/me/app');
  assert.equal(comparable('/c/Users/Me', 'linux'), '/c/Users/Me');
});

test('resolveFrom expands ~, $HOME and $PWD and joins relative paths', () => {
  const linux = { platform: 'linux', homedir: '/home/me' };
  assert.equal(resolveFrom('/home/me/app', '~', linux), '/home/me');
  assert.equal(resolveFrom('/home/me/app', '~/', linux), '/home/me');
  assert.equal(resolveFrom('/home/me/app', '$HOME/projects', linux), '/home/me/projects');
  assert.equal(resolveFrom('/home/me/app', '${PWD}/dist', linux), '/home/me/app/dist');
  assert.equal(resolveFrom('/home/me/app', '..', linux), '/home/me');
  assert.equal(resolveFrom('/home/me/app', 'dist', linux), '/home/me/app/dist');
  assert.equal(resolveFrom('/home/me/app', '/etc', linux), '/etc');
  assert.equal(resolveFrom('/home/me/app', '~backup', linux), '/home/me/app/~backup');

  const windows = { platform: 'win32', homedir: 'C:\\Users\\Me' };
  assert.equal(resolveFrom('C:\\Users\\Me\\app', '.\\dist', windows), '/c/users/me/app/dist');
  assert.equal(resolveFrom('C:\\Users\\Me\\app', '%USERPROFILE%', windows), '/c/users/me');
  assert.equal(resolveFrom('C:\\Users\\Me\\app', '/c/Users/Me', windows), '/c/users/me');
});

test('contains treats a folder as containing itself and its children only', () => {
  assert.equal(contains('/home/me', '/home/me/app'), true);
  assert.equal(contains('/home/me/app', '/home/me/app'), true);
  assert.equal(contains('/home/me/ap', '/home/me/app'), false);
  assert.equal(contains('/home/me/app', '/home/me'), false);
  assert.equal(contains('/', '/anything'), true);
});

test('isFilesystemRoot knows / everywhere and drive roots on Windows', () => {
  assert.equal(isFilesystemRoot('/', 'linux'), true);
  assert.equal(isFilesystemRoot('/c', 'win32'), true);
  assert.equal(isFilesystemRoot('/c', 'linux'), false);
  assert.equal(isFilesystemRoot('/c/users', 'win32'), false);
});

test('nativeResolve gives a path this machine can hand to git', () => {
  const linux = { platform: 'linux', homedir: '/home/me' };
  assert.equal(nativeResolve('/home/me/app', '../web', linux), '/home/me/web');
  assert.equal(nativeResolve('/home/me/app', '~/docs', linux), '/home/me/docs');
  assert.equal(nativeResolve('/home/me/app', '/srv/site', linux), '/srv/site');

  const windows = { platform: 'win32', homedir: 'C:\\Users\\me' };
  assert.equal(nativeResolve('C:\\Users\\me\\app', '/c/Users/me/web', windows), 'C:\\Users\\me\\web');
  assert.equal(nativeResolve('C:\\Users\\me\\app', 'packages\\web', windows), 'C:\\Users\\me\\app\\packages\\web');
  assert.equal(nativeResolve('C:\\Users\\me\\app', '%USERPROFILE%', windows), 'C:\\Users\\me');
});

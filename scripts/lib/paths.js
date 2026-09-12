'use strict';

const { posix } = require('path');

// Guards compare paths that arrive in three spellings: Windows (C:\Users\me), Git Bash
// (/c/Users/me) and POSIX (/home/me). These helpers turn all three into one form, so a
// question like "is this the project folder?" has a single answer on every machine.

function segments(p) {
  return String(p).split(/[\\/]+/).filter(Boolean);
}

function baseName(p) {
  const parts = segments(p);
  return parts.length ? parts[parts.length - 1] : '';
}

function comparable(p, platform) {
  let s = String(p).replace(/\\/g, '/');
  const drive = /^([A-Za-z]):(?:\/|$)/.exec(s);
  if (drive) {
    s = `/${drive[1].toLowerCase()}/${s.slice(drive[0].length)}`;
  } else if (platform === 'win32') {
    const gitBash = /^\/([A-Za-z])(?:\/|$)/.exec(s);
    if (gitBash) s = `/${gitBash[1].toLowerCase()}/${s.slice(gitBash[0].length)}`;
  }
  s = posix.normalize(s);
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return platform === 'win32' ? s.toLowerCase() : s;
}

function expandVariables(p, { cwd, homedir }) {
  const s = String(p);
  const home = /^(~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)(?=$|[\\/])/i.exec(s);
  if (home) return String(homedir) + s.slice(home[0].length);
  const pwd = /^(\$PWD|\$\{PWD\}|%CD%)(?=$|[\\/])/i.exec(s);
  if (pwd) return String(cwd) + s.slice(pwd[0].length);
  return s;
}

function isAbsolute(p) {
  return /^[\\/]/.test(p) || /^[A-Za-z]:([\\/]|$)/.test(p);
}

// Where a path typed in a command points, given the folder the command runs in.
function resolveFrom(cwd, target, { platform, homedir }) {
  const expanded = expandVariables(target, { cwd, homedir });
  if (isAbsolute(expanded)) return comparable(expanded, platform);
  return comparable(`${String(cwd).replace(/\\/g, '/')}/${expanded.replace(/\\/g, '/')}`, platform);
}

// True when `child` is `parent` itself or somewhere inside it. Both must be comparable().
function contains(parent, child) {
  if (parent === child) return true;
  const prefix = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(prefix);
}

function isFilesystemRoot(p, platform) {
  return p === '/' || (platform === 'win32' && /^\/[a-z]$/.test(p));
}

module.exports = { segments, baseName, comparable, resolveFrom, contains, isFilesystemRoot };

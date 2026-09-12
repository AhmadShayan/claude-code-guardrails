'use strict';

const os = require('os');
const { commandName } = require('./shell');
const { nativeResolve } = require('./paths');

// Options git accepts before its subcommand that take the next word as their value.
const VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);

// Reads `git [options] <subcommand> [args]` into its parts, or returns null for anything
// that is not a git command. `dir` is the folder git will run in once -C is applied.
function parseGit(words, cwd, ctx = {}) {
  if (commandName(words) !== 'git') return null;
  const options = { platform: ctx.platform || process.platform, homedir: ctx.homedir || os.homedir() };
  let dir = cwd;
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) {
    if (words[i] === '-C' && words[i + 1] !== undefined) dir = nativeResolve(dir || '.', words[i + 1], options);
    i += VALUE_OPTIONS.has(words[i]) ? 2 : 1;
  }
  if (i >= words.length) return null;
  return { subcommand: words[i], args: words.slice(i + 1), dir };
}

// Why a question to git failed. "not-a-repository" means there is nothing to protect,
// because the command being checked fails the same way. "timeout" and "error" mean the
// guard could not check, and a guard refuses rather than guessing.
function gitFailure(err) {
  if (err && (err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM')) return 'timeout';
  return /not a git repository/i.test(String((err && err.stderr) || '')) ? 'not-a-repository' : 'error';
}

function askGit(ctx, args, dir) {
  try {
    return { ok: true, out: String(ctx.git(args, dir)) };
  } catch (err) {
    return { ok: false, failure: gitFailure(err), stderr: String((err && err.stderr) || '') };
  }
}

module.exports = { parseGit, askGit, gitFailure };

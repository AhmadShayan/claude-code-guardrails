'use strict';

const { commandsOf, commandName, dialectOf, isRedirect, SUBSTITUTION } = require('../lib/shell');
const { segments, comparable, resolveFrom, nativeResolve, contains, isFilesystemRoot } = require('../lib/paths');
const { parseGit } = require('../lib/git');

// Stops commands that destroy work in ways that are hard or impossible to undo: deleting the
// project, the home folder, the disk or a repository's history, and git commands that throw
// away work nobody has saved. Every git check asks the repository first, so the same command
// runs freely when there is nothing to lose.

const BYPASS = ' If the user really wants this, they can run the command themselves.';

const SLOW =
  'The guard could not check this repository in time, so it cannot tell whether this command throws away work. Run git status first, or ask the user to run the command.';

const WINDOWS_REMOVERS = new Set(['remove-item', 'ri', 'rmdir', 'rd', 'del', 'erase']);
const CHANGE_DIRECTORY = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl']);
const WHOLE_TREE = new Set([':/', ':/*', ':(top)', '*']);
const KNOWN_PREFIX = /^(~|\$HOME\b|\$\{HOME\}|\$PWD\b|\$\{PWD\}|%USERPROFILE%|%CD%|\$env:USERPROFILE\b)/i;

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function lines(text) {
  return String(text)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function runGit(ctx, args, dir) {
  try {
    return { ok: true, out: String(ctx.git(args, dir)) };
  } catch (err) {
    return { ok: false, timedOut: Boolean(err && (err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM')) };
  }
}

// A word whose value only exists once the shell runs it, such as $BUILD_DIR or $(...).
function isUnknown(word) {
  if (word.includes(SUBSTITUTION)) return true;
  return /[$%]/.test(word.replace(KNOWN_PREFIX, ''));
}

// ---- Deleting files and folders ----

function readDelete(words) {
  const name = commandName(words);
  const isRm = name === 'rm';
  if (!isRm && !WINDOWS_REMOVERS.has(name)) return null;
  const parsed = { recursive: false, targets: [] };
  let flagsDone = false;
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i];
    if (isRedirect(word)) {
      i += 1;
      continue;
    }
    if (!flagsDone && word === '--') {
      flagsDone = true;
      continue;
    }
    if (!flagsDone && isRm && word.length > 1 && word.startsWith('-')) {
      if (word === '--recursive' || (!word.startsWith('--') && /r/i.test(word.slice(1)))) parsed.recursive = true;
      continue;
    }
    if (!flagsDone && !isRm && (word.startsWith('-') || /^\/[a-z]$/i.test(word))) {
      if (/^-r/i.test(word) || /^\/s$/i.test(word)) parsed.recursive = true;
      continue;
    }
    parsed.targets.push(word);
  }
  return parsed;
}

// "dir/*" deletes everything inside dir, which is as bad as deleting dir itself.
function splitGlob(target) {
  if (target === '*' || target === '.*') return { base: '.', everything: true };
  const match = /^(.*)[\\/]\.?\*$/.exec(target);
  if (match) return { base: match[1] === '' ? '/' : match[1], everything: true };
  return { base: target, everything: false };
}

function describe(resolved, here, home, platform) {
  if (isFilesystemRoot(resolved, platform)) return 'the root of the disk';
  if (resolved === home) return 'the home folder';
  if (resolved === here) return 'the folder Claude is working in';
  if (contains(resolved, here)) return 'a folder that contains the one Claude is working in';
  return 'a folder that contains the home folder';
}

function deleteReason(words, cwd, here, ctx) {
  const parsed = readDelete(words);
  if (!parsed || cwd === null || here === null) return null;
  const home = comparable(ctx.homedir, ctx.platform);
  for (const target of parsed.targets) {
    if (isUnknown(target)) continue;
    const { base, everything } = splitGlob(target);
    const resolved = resolveFrom(cwd, base, ctx);
    if (!parsed.recursive && !everything) continue;
    if (segments(resolved).pop() === '.git') {
      return `This deletes \`${target}\`, the folder where git keeps this project's entire history. Every commit that is not pushed somewhere is lost for good.${BYPASS}`;
    }
    if (!isFilesystemRoot(resolved, ctx.platform) && !contains(resolved, here) && !contains(resolved, home)) continue;
    const what = describe(resolved, here, home, ctx.platform);
    return `This deletes ${everything ? `everything inside ${what}` : what} (\`${target}\`). Files deleted this way skip the trash, and any work in them that is not pushed somewhere is gone for good. Delete the specific files or folders that need to go instead, for example rm -rf node_modules.${BYPASS}`;
  }
  return null;
}

// Where later commands on the same line run, after a cd. Null once it cannot be known.
function nextCwd(words, cwd, ctx) {
  const name = commandName(words);
  if (name === 'popd') return null;
  if (!CHANGE_DIRECTORY.has(name)) return cwd;
  const target = words.slice(1).find((word) => !word.startsWith('-'));
  if (target === undefined) return name === 'pushd' ? cwd : ctx.homedir;
  if (cwd === null || target === '-' || isUnknown(target)) return null;
  return nativeResolve(cwd, target, ctx);
}

// ---- git ----

function changedFiles(ctx, dir, pathspecs = []) {
  const args = ['status', '--porcelain', '--untracked-files=no'];
  if (pathspecs.length) args.push('--', ...pathspecs);
  const result = runGit(ctx, args, dir);
  if (result.timedOut) return null;
  return result.ok ? lines(result.out).length : 0;
}

function discardedChanges(changed) {
  return `This discards the uncommitted changes in ${plural(changed, 'file')}, and git keeps no copy of them. Save them first with git stash, or commit them.${BYPASS}`;
}

function resetReason(git, ctx) {
  if (!git.args.includes('--hard')) return null;
  const changed = changedFiles(ctx, git.dir);
  if (changed === null) return SLOW;
  if (changed > 0) {
    return `git reset --hard throws away the uncommitted changes in ${plural(changed, 'file')}, and git keeps no copy of them. Save them first with git stash, or commit them, and then reset.${BYPASS}`;
  }
  const target = git.args.find((arg) => !arg.startsWith('-'));
  if (!target || target === 'HEAD') return null;
  if (target.includes(SUBSTITUTION)) {
    return 'git reset --hard moves this branch to a commit the guard cannot see until the command runs, so it may drop commits from the branch. Name the commit in the command, or ask the user to run it.';
  }
  const count = runGit(ctx, ['rev-list', '--count', `${target}..HEAD`], git.dir);
  if (count.timedOut) return SLOW;
  const dropped = count.ok ? parseInt(count.out.trim(), 10) || 0 : 0;
  if (dropped === 0) return null;
  return `git reset --hard ${target} moves this branch back and drops ${plural(dropped, 'commit')} from it. They can only be recovered through the reflog, which most people never find. To keep them reachable, create a backup first with git branch backup-before-reset.${BYPASS}`;
}

function isBroad(spec, dir, ctx) {
  if (WHOLE_TREE.has(spec)) return true;
  if (spec.startsWith(':') || isUnknown(spec)) return false;
  if (!dir) return spec === '.' || spec === './';
  return contains(resolveFrom(dir, spec, ctx), comparable(dir, ctx.platform));
}

// git checkout, restore and switch, when they would overwrite uncommitted changes.
function discardReason(git, ctx) {
  const { subcommand, args } = git;
  const split = args.indexOf('--');
  const options = split >= 0 ? args.slice(0, split) : args;
  const specs = split >= 0 ? args.slice(split + 1) : [];
  let force = false;
  let staged = false;
  let worktree = false;

  for (let i = 0; i < options.length; i += 1) {
    const arg = options[i];
    if (arg === '--force' || arg === '--discard-changes') force = true;
    else if (arg === '--staged') staged = true;
    else if (arg === '--worktree') worktree = true;
    else if (subcommand === 'restore' && (arg === '-s' || arg === '--source')) i += 1;
    else if (subcommand !== 'restore' && ['-b', '-B', '-c', '-C', '--orphan'].includes(arg)) i += 1;
    else if (/^-[^-]/.test(arg)) {
      if (subcommand !== 'restore' && arg.includes('f')) force = true;
      if (subcommand === 'restore' && arg.includes('S')) staged = true;
      if (subcommand === 'restore' && arg.includes('W')) worktree = true;
    } else if (!arg.startsWith('-') && (subcommand === 'restore' || isBroad(arg, git.dir, ctx))) {
      specs.push(arg);
    }
  }

  if (subcommand === 'restore' && staged && !worktree) return null;
  const broad = specs.filter((spec) => isBroad(spec, git.dir, ctx));
  if (!force && !broad.length) return null;
  const changed = changedFiles(ctx, git.dir, force ? [] : broad);
  if (changed === null) return SLOW;
  return changed > 0 ? discardedChanges(changed) : null;
}

function cleanReason(git, ctx) {
  let force = false;
  let dryRun = false;
  const preview = ['clean', '-n'];
  for (let i = 0; i < git.args.length; i += 1) {
    const arg = git.args[i];
    if (arg === '--force') force = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--interactive' || arg === '--quiet') continue;
    else if (arg === '-e' || arg === '--exclude') {
      if (git.args[i + 1] !== undefined) preview.push(arg, git.args[i + 1]);
      i += 1;
    } else if (/^-[^-]/.test(arg)) {
      if (arg.includes('f')) force = true;
      if (arg.includes('n')) dryRun = true;
      const kept = arg.slice(1).replace(/[fniq]/g, '');
      if (kept) preview.push(`-${kept}`);
    } else {
      preview.push(arg);
    }
  }
  if (!force || dryRun) return null;

  const result = runGit(ctx, preview, git.dir);
  if (result.timedOut) return SLOW;
  if (!result.ok) return null;
  const doomed = lines(result.out)
    .filter((line) => line.startsWith('Would remove '))
    .map((line) => line.slice('Would remove '.length));
  if (!doomed.length) return null;
  const sample = doomed
    .slice(0, 3)
    .map((item) => `\`${item}\``)
    .join(', ');
  return `git clean deletes ${plural(doomed.length, 'untracked file or folder', 'untracked files and folders')}, such as ${sample}. Git never saved them, so they cannot be recovered. List them with git clean -n and delete only what should go.${BYPASS}`;
}

function stashReason(git, ctx) {
  if (git.args.find((arg) => !arg.startsWith('-')) !== 'clear') return null;
  const result = runGit(ctx, ['stash', 'list'], git.dir);
  if (result.timedOut) return SLOW;
  const count = result.ok ? lines(result.out).length : 0;
  if (count === 0) return null;
  const which = count === 1 ? 'the saved stash' : `all ${count} saved stashes`;
  return `git stash clear deletes ${which}, and the changes in them cannot be recovered. Drop only the stash that is no longer needed, with git stash drop stash@{n}.${BYPASS}`;
}

function gitReason(words, cwd, ctx) {
  const git = parseGit(words, cwd === null ? undefined : cwd, ctx);
  if (!git || !git.dir) return null;
  if (git.subcommand === 'reset') return resetReason(git, ctx);
  if (git.subcommand === 'checkout' || git.subcommand === 'restore' || git.subcommand === 'switch') return discardReason(git, ctx);
  if (git.subcommand === 'clean') return cleanReason(git, ctx);
  if (git.subcommand === 'stash') return stashReason(git, ctx);
  return null;
}

function ghReason(words) {
  if (commandName(words) !== 'gh') return null;
  const [group, action] = words.slice(1).filter((word) => !word.startsWith('-'));
  if (group === 'repo' && action === 'delete') {
    return `gh repo delete permanently deletes a GitHub repository, with its issues, pull requests and settings.${BYPASS}`;
  }
  return null;
}

function check(payload, ctx) {
  const command = String((payload.tool_input || {}).command || '').replace(/\$\(\s*pwd\s*\)|`\s*pwd\s*`/g, '$PWD');
  const here = payload.cwd ? comparable(payload.cwd, ctx.platform) : null;
  let cwd = payload.cwd || null;
  for (const words of commandsOf(command, dialectOf(payload.tool_name))) {
    const reason = deleteReason(words, cwd, here, ctx) || ghReason(words) || gitReason(words, cwd, ctx);
    if (reason) return reason;
    cwd = nextCwd(words, cwd, ctx);
  }
  return null;
}

module.exports = { id: 'destructive-commands', tools: ['Bash', 'PowerShell'], check };

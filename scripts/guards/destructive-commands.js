'use strict';

const { commandsOf, commandName, dialectOf, isRedirect, hasShellValue } = require('../lib/shell');
const { segments, comparable, resolveFrom, nativeResolve, contains, isFilesystemRoot } = require('../lib/paths');
const { parseGit, askGit } = require('../lib/git');

// Stops commands that destroy work in ways that are hard or impossible to undo: deleting the
// project, the home folder, the disk or a repository's history, and git commands that throw
// away work nobody has saved. Every git check asks the repository first, so the same command
// runs freely when there is nothing to lose. When git cannot answer, or a git command names
// its commit, files or action with something the shell only fills in when it runs, such as
// $REF or $(...), the check refuses rather than guessing whenever there is work to lose.

const BYPASS = ' If the user really wants this, they can run the command themselves.';

const UNCHECKED =
  'The guard could not check this repository (git did not answer in time, or answered with an error), so it cannot tell whether this command throws away work. Run git status to see what is going on, or ask the user to run the command.';

const UNKNOWN_CLEAN =
  'git clean deletes untracked files, and part of this command only gets its value once the shell runs it, so the guard cannot tell what would be deleted. Write the paths out and check them with git clean -n first, or ask the user to run the command.';

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

// A path whose value only exists once the shell runs it, such as $BUILD_DIR or $(...). The
// home and working folders are known, so $HOME/x and $PWD/x still count as named.
function isUnknown(word) {
  return hasShellValue(word.replace(KNOWN_PREFIX, ''));
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

// How many files have uncommitted changes: 0 outside a repository, where the command being
// checked fails on its own, and null when git could not say.
function changedFiles(ctx, dir, pathspecs = []) {
  const args = ['status', '--porcelain', '--untracked-files=no'];
  if (pathspecs.length) args.push('--', ...pathspecs);
  const result = askGit(ctx, args, dir);
  if (result.ok) return lines(result.out).length;
  return result.failure === 'not-a-repository' ? 0 : null;
}

function discardedChanges(changed) {
  return `This discards the uncommitted changes in ${plural(changed, 'file')}, and git keeps no copy of them. Save them first with git stash, or commit them.${BYPASS}`;
}

function resetReason(git, ctx) {
  if (!git.args.includes('--hard')) return null;
  const changed = changedFiles(ctx, git.dir);
  if (changed === null) return UNCHECKED;
  if (changed > 0) {
    return `git reset --hard throws away the uncommitted changes in ${plural(changed, 'file')}, and git keeps no copy of them. Save them first with git stash, or commit them, and then reset.${BYPASS}`;
  }
  const target = git.args.find((arg) => !arg.startsWith('-'));
  if (!target || target === 'HEAD') return null;
  if (hasShellValue(target)) {
    return 'git reset --hard moves this branch to a commit the guard cannot see until the command runs, so it may drop commits from the branch. Name the commit in the command, or ask the user to run it.';
  }
  const count = askGit(ctx, ['rev-list', '--count', `${target}..HEAD`], git.dir);
  if (!count.ok) {
    // Outside a repository, or for a revision git does not know, the reset fails on its own.
    if (count.failure === 'not-a-repository') return null;
    if (count.failure === 'error' && /unknown revision|bad revision|ambiguous argument/i.test(count.stderr)) return null;
    return UNCHECKED;
  }
  const dropped = parseInt(count.out.trim(), 10) || 0;
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
  const unnamed = specs.some((spec) => isUnknown(spec));
  if (!force && !broad.length && !unnamed) return null;
  const changed = changedFiles(ctx, git.dir, force || unnamed ? [] : broad);
  if (changed === null) return UNCHECKED;
  if (changed === 0) return null;
  if (!force && !broad.length) {
    return `This discards changes in files the guard cannot name until the shell runs, and ${plural(changed, 'file has', 'files have')} uncommitted changes it could reach. Git keeps no copy of them. Name the files in the command, or save the changes first with git stash.${BYPASS}`;
  }
  return discardedChanges(changed);
}

// git clean -f, when it would delete untracked files. A word the shell fills in could be any
// path, so the preview leaves it out and looks at the whole tree. Before -- it could also be
// any option, -f, -d or -x included, so the preview then takes the widest reading.
function cleanReason(git, ctx) {
  let force = false;
  let dryRun = false;
  let optionsDone = false;
  let unknown = false;
  let unknownOption = false;
  const options = [];
  const excludes = [];
  const paths = [];
  for (let i = 0; i < git.args.length; i += 1) {
    const arg = git.args[i];
    if (hasShellValue(arg)) {
      unknown = true;
      if (!optionsDone) unknownOption = true;
    } else if (optionsDone) paths.push(arg);
    else if (arg === '--') optionsDone = true;
    else if (arg === '--force') force = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--interactive' || arg === '--quiet') continue;
    else if (arg === '-e' || arg === '--exclude') {
      const value = git.args[i + 1];
      if (value !== undefined && hasShellValue(value)) unknown = true;
      else if (value !== undefined) excludes.push(arg, value);
      i += 1;
    } else if (/^-[^-]/.test(arg)) {
      if (arg.includes('f')) force = true;
      if (arg.includes('n')) dryRun = true;
      const kept = arg.slice(1).replace(/[fniq]/g, '');
      if (kept) options.push(`-${kept}`);
    } else if (arg.startsWith('--')) {
      options.push(arg);
    } else {
      paths.push(arg);
    }
  }
  if (dryRun || !(force || unknownOption)) return null;

  const named = unknown || !paths.length ? [] : ['--', ...paths];
  const preview = unknownOption ? ['clean', '-n', '-d', '-x', ...excludes] : ['clean', '-n', ...options, ...excludes, ...named];
  const result = askGit(ctx, preview, git.dir);
  if (!result.ok) return result.failure === 'not-a-repository' ? null : UNCHECKED;
  const doomed = lines(result.out)
    .filter((line) => line.startsWith('Would remove '))
    .map((line) => line.slice('Would remove '.length));
  if (!doomed.length) return null;
  if (unknown) return UNKNOWN_CLEAN;
  const sample = doomed
    .slice(0, 3)
    .map((item) => `\`${item}\``)
    .join(', ');
  return `git clean deletes ${plural(doomed.length, 'untracked file or folder', 'untracked files and folders')}, such as ${sample}. Git never saved them, so they cannot be recovered. List them with git clean -n and delete only what should go.${BYPASS}`;
}

// The stash action a command runs, such as clear or pop, reading past a message given with -m.
function stashAction(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-m' || args[i] === '--message') i += 1;
    else if (!args[i].startsWith('-')) return args[i];
  }
  return undefined;
}

function stashReason(git, ctx) {
  const action = stashAction(git.args);
  const unnamed = action !== undefined && hasShellValue(action);
  if (action !== 'clear' && !unnamed) return null;
  const result = askGit(ctx, ['stash', 'list'], git.dir);
  if (!result.ok) return result.failure === 'not-a-repository' ? null : UNCHECKED;
  const count = lines(result.out).length;
  if (count === 0) return null;
  const which = count === 1 ? 'the saved stash' : count === 2 ? 'both saved stashes' : `all ${count} saved stashes`;
  if (unnamed) {
    return `This runs a git stash action the guard cannot name until the shell runs, and it could be git stash clear, which deletes ${which}. Write the action out, or ask the user to run the command.`;
  }
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

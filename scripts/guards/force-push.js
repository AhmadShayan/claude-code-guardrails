'use strict';

const { commandsOf, dialectOf, SUBSTITUTION } = require('../lib/shell');
const { parseGit } = require('../lib/git');

// Stops force-pushes to the branch a project deploys from, `git push --mirror`, and deleting
// that branch on the remote. Each one replaces history that other machines, teammates and
// deploy pipelines already rely on. Force-pushing a feature branch is still allowed.

const ALWAYS_PROTECTED = new Set(['main', 'master']);
const FORCE_FLAGS = new Set(['--force', '--force-with-lease', '--force-if-includes']);
const VALUE_FLAGS = new Set(['--repo', '--receive-pack', '--exec', '--push-option']);

const MIRROR =
  'git push --mirror makes every branch and tag on the remote match this machine, and deletes any that exist only on the remote. If the user really wants that, they can run the command themselves.';

const UNKNOWN_BRANCH =
  'This force-pushes the current branch, and the guard could not tell which branch that is, so it cannot rule out the one the project deploys from. Name the branch in the command, for example git push --force-with-lease origin my-feature, or ask the user to run it.';

function forceReason(branch) {
  return `This force-pushes \`${branch}\`, which replaces the history on the remote with the history on this machine. Commits on the remote that are not here, such as work pushed from another computer or by a teammate, are deleted, and a deploy that builds from \`${branch}\` can break. Run git pull --rebase and then a plain git push instead. If the user really wants to overwrite the remote branch, they can run the command themselves.`;
}

function deletionReason(branch) {
  return `This deletes the \`${branch}\` branch on the remote. Deploys usually build from it, and once it is gone its history is hard to get back. If the user really wants to delete it, they can run the command themselves.`;
}

function readPush(args) {
  const push = { force: false, mirror: false, deleting: false, dryRun: false, positional: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') {
      push.positional.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const flag = arg.split('=')[0];
      if (FORCE_FLAGS.has(flag)) push.force = true;
      else if (flag === '--mirror') push.mirror = true;
      else if (flag === '--delete') push.deleting = true;
      else if (flag === '--dry-run') push.dryRun = true;
      else if (VALUE_FLAGS.has(flag) && !arg.includes('=')) i += 1;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const letters = arg.slice(1);
      if (letters.includes('f')) push.force = true;
      if (letters.includes('d')) push.deleting = true;
      if (letters.includes('n')) push.dryRun = true;
      if (letters.endsWith('o')) i += 1;
      continue;
    }
    push.positional.push(arg);
  }
  return push;
}

// The branch a refspec writes to: "+HEAD:main" and "main" both write to main.
function targetOf(refspec) {
  const spec = refspec.replace(/^\+/, '');
  const colon = spec.lastIndexOf(':');
  return (colon >= 0 ? spec.slice(colon + 1) : spec).replace(/^refs\/heads\//, '');
}

function gitLine(ctx, args, dir) {
  try {
    return String(ctx.git(args, dir)).trim() || null;
  } catch {
    return null;
  }
}

function currentBranch(ctx, dir) {
  const name = gitLine(ctx, ['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  return name && name !== 'HEAD' ? name : null;
}

// main and master, plus whatever the remote reports as its default branch.
function isProtected(branch, ctx, dir) {
  if (ALWAYS_PROTECTED.has(branch)) return true;
  const remoteDefault = gitLine(ctx, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], dir);
  return remoteDefault !== null && remoteDefault.replace(/^origin\//, '') === branch;
}

function pushReason(git, ctx) {
  const push = readPush(git.args);
  if (push.dryRun) return null;
  if (push.mirror) return MIRROR;

  const refspecs = push.positional.slice(1);
  if (push.deleting || refspecs.some((spec) => spec.startsWith(':'))) {
    const deletable = push.deleting ? refspecs : refspecs.filter((spec) => spec.startsWith(':'));
    for (const target of deletable.map(targetOf)) {
      if (!target.includes(SUBSTITUTION) && isProtected(target, ctx, git.dir)) return deletionReason(target);
    }
    if (push.deleting) return null;
  }

  const forced = push.force ? (refspecs.length ? refspecs : [null]) : refspecs.filter((spec) => spec.startsWith('+'));
  for (const spec of forced) {
    let branch = spec === null ? 'HEAD' : targetOf(spec);
    if (branch.includes(SUBSTITUTION)) return UNKNOWN_BRANCH;
    if (branch === 'HEAD') {
      branch = currentBranch(ctx, git.dir);
      if (!branch) return UNKNOWN_BRANCH;
    }
    if (isProtected(branch, ctx, git.dir)) return forceReason(branch);
  }
  return null;
}

function check(payload, ctx) {
  const command = String((payload.tool_input || {}).command || '');
  for (const words of commandsOf(command, dialectOf(payload.tool_name))) {
    const git = parseGit(words, payload.cwd, ctx);
    if (!git || git.subcommand !== 'push') continue;
    const reason = pushReason(git, ctx);
    if (reason) return reason;
  }
  return null;
}

module.exports = { id: 'force-push', tools: ['Bash', 'PowerShell'], check };

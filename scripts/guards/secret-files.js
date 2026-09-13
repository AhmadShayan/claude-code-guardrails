'use strict';

const fs = require('fs');
const path = require('path');
const { commandsOf, commandName, dialectOf, isRedirect, SUBSTITUTION } = require('../lib/shell');
const { segments, baseName } = require('../lib/paths');
const { parseGit } = require('../lib/git');

// Stops Claude from reading secret files into the conversation: .env files, private keys,
// cloud credentials and service account keys. Templates such as .env.example stay readable,
// and so do commands that use a secret file without printing it. A symlink is followed to
// the file it points at, and copying, moving or linking a secret to a name that does not
// look secret is refused, because under the new name it would pass every other check here.

const ENV_FILE = 'an environment file';

const TEMPLATE_PARTS = new Set(['example', 'sample', 'template', 'dist']);
const PRIVATE_KEY_NAMES = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk']);
const KEY_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.ppk'];

// Commands that print the files they are given.
const PRINTERS = new Set(['cat', 'bat', 'batcat', 'less', 'more', 'most', 'head', 'tail', 'nl', 'tac', 'strings', 'xxd', 'od', 'hexdump', 'base64', 'type', 'get-content', 'gc']);

// Commands whose first argument is a pattern or a program rather than a file. Each lists
// the flags that supply that argument instead, and those flags take a value.
const SEARCHERS = {
  grep: ['-e', '-f', '--regexp', '--file'],
  egrep: ['-e', '-f', '--regexp', '--file'],
  fgrep: ['-e', '-f', '--regexp', '--file'],
  rg: ['-e', '-f', '--regexp', '--file'],
  ag: [],
  ack: [],
  awk: ['-f', '--file'],
  gawk: ['-f', '--file'],
  sed: ['-e', '-f', '--expression', '--file'],
  jq: ['-f', '--from-file'],
  yq: ['--from-file'],
  'select-string': ['-pattern'],
  sls: ['-pattern'],
  findstr: [],
};

const GREP_LIKE = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);
const QUIET_LONG = new Set(['--quiet', '--silent', '--count', '--count-matches', '--files-with-matches', '--files-without-match']);

// Commands that give a file a second name, and how the refusal describes each.
const COPIERS = {
  cp: 'copies',
  copy: 'copies',
  'copy-item': 'copies',
  cpi: 'copies',
  install: 'copies',
  dd: 'copies',
  mv: 'moves',
  move: 'moves',
  'move-item': 'moves',
  mi: 'moves',
  ren: 'renames',
  'rename-item': 'renames',
  rni: 'renames',
  ln: 'links',
};
const POWERSHELL_COPIERS = new Set(['copy-item', 'cpi', 'move-item', 'mi', 'rename-item', 'rni']);

// What kind of secret a path holds by its name, or null when it is not a secret file.
function secretKind(p) {
  const parts = segments(p);
  if (!parts.length) return null;
  const name = parts[parts.length - 1].toLowerCase();
  const parent = (parts[parts.length - 2] || '').toLowerCase();

  if (name === '.env' || name === '.envrc' || name.startsWith('.env.') || name.endsWith('.env')) {
    return name.split('.').some((piece) => TEMPLATE_PARTS.has(piece)) ? null : ENV_FILE;
  }
  if (PRIVATE_KEY_NAMES.has(name)) return 'an SSH private key';
  if (KEY_EXTENSIONS.some((ext) => name.endsWith(ext))) return 'a private key or certificate file';
  if (parent === '.aws' && name === 'credentials') return 'an AWS credentials file';
  if (name === '.netrc' || name === '.pgpass' || name === '.git-credentials') return 'a credentials file';
  if (name.endsWith('.json') && (/service[-_]?account/.test(name) || name.includes('firebase-adminsdk') || name.startsWith('client_secret'))) {
    return 'a service account key';
  }
  return null;
}

// Where a path points, for asking the filesystem about it, or null when it must not be asked.
// On Windows a path that starts with two slashes names another machine (\\server\share) or a
// device (\\?\, \\.\). Looking one up connects to that machine before the user has approved
// anything, and an unreachable one holds the lookup for close to 30 seconds, long enough for
// Claude Code to stop waiting for the hook and run the call unchecked.
function localPath(p, cwd, platform) {
  const lib = platform === 'win32' ? path.win32 : path.posix;
  const resolved = lib.resolve(cwd || '.', String(p));
  return platform === 'win32' && /^[\\/]{2}/.test(resolved) ? null : resolved;
}

// The kind of secret a path holds, following a symlink to the file it points at. `via` names
// that file when the path's own name looks innocent. A path on another machine is judged by
// its name alone.
function kindOf(p, cwd, platform) {
  const direct = secretKind(p);
  if (direct) return { kind: direct, via: null };
  const local = localPath(p, cwd, platform);
  if (!local) return null;
  try {
    const real = fs.realpathSync.native(local);
    const kind = secretKind(real);
    return kind ? { kind, via: baseName(real) } : null;
  } catch {
    return null;
  }
}

function isFolder(p, cwd, platform) {
  const local = localPath(p, cwd, platform);
  if (!local) return false;
  try {
    return fs.statSync(local).isDirectory();
  } catch {
    return false;
  }
}

function shellQuote(text) {
  return /^[\w./:@%+=,-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

function advice(file, kind) {
  if (kind !== ENV_FILE) {
    return ' If a program needs this file, give it the path rather than the contents. If the user needs to see it, they can open it themselves.';
  }
  const shown = String(file).replace(/\\/g, '/');
  const sourced = shown.includes('/') ? shown : `./${shown}`;
  return ` To confirm a variable is set without printing it, run: grep -q '^VARIABLE_NAME=' ${shellQuote(shown)} && echo set. To load the variables into a shell, run: set -a; . ${shellQuote(sourced)}; set +a. If the user needs to see the values, they can open the file themselves.`;
}

function explain(file, found, action) {
  const subject = found.via ? `\`${baseName(file)}\` points to \`${found.via}\`, which is ${found.kind}` : `\`${baseName(file)}\` is ${found.kind}`;
  return `${subject}, and ${action} would copy its secrets (API keys, passwords) into this conversation.${advice(file, found.kind)}`;
}

function isFlag(name, word) {
  if (name === 'findstr' && /^\/[a-z]/i.test(word)) return true;
  return word.length > 1 && word.startsWith('-');
}

// Flags that make a command print only counts, file names or an exit status, or, for sed,
// write its result back into the file instead of printing it.
function isQuiet(name, word) {
  const lower = word.toLowerCase();
  if (name === 'findstr') return lower === '/m';
  if (name === 'select-string' || name === 'sls') return lower === '-quiet';
  if (name === 'sed') return word === '--in-place' || word.startsWith('--in-place=') || (/^-[^-]/.test(word) && word.slice(1).includes('i'));
  if (!GREP_LIKE.has(name)) return false;
  if (word.startsWith('--')) return QUIET_LONG.has(word.split('=')[0]);
  return /[qclL]/.test(word.slice(1));
}

// The files a command prints from its arguments, as far as its words show.
function filesPrinted(words) {
  const name = commandName(words);
  if (name === 'dd') {
    const input = words.find((word) => word.startsWith('if='));
    const writesElsewhere = words.some((word) => word.startsWith('of='));
    return input && !writesElsewhere ? [input.slice(3)] : [];
  }
  const patternFlags = SEARCHERS[name];
  if (!PRINTERS.has(name) && !patternFlags) return [];

  const positional = [];
  let patternGiven = false;
  let flagsDone = false;

  for (let i = 1; i < words.length; i += 1) {
    const word = words[i];
    if (isRedirect(word)) {
      i += 1; // the word after a redirection is its target, which inputReason checks
      continue;
    }
    if (word.includes(SUBSTITUTION)) continue;
    if (!flagsDone && word === '--') {
      flagsDone = true;
      continue;
    }
    if (!flagsDone && isFlag(name, word)) {
      if (isQuiet(name, word)) return [];
      const lower = word.toLowerCase();
      if (patternFlags && patternFlags.includes(lower)) {
        patternGiven = true;
        i += 1;
      } else if (patternFlags && patternFlags.some((flag) => flag.startsWith('--') && lower.startsWith(`${flag}=`))) {
        patternGiven = true;
      }
      continue;
    }
    positional.push(word);
  }

  if (patternFlags && !patternGiven) positional.shift();
  return positional;
}

// `command < file` hands the whole file to the command, whatever the command is.
function inputReason(words, cwd, platform) {
  for (let i = 0; i < words.length - 1; i += 1) {
    if (words[i] !== '<' || words[i + 1].includes(SUBSTITUTION)) continue;
    const found = kindOf(words[i + 1], cwd, platform);
    if (found) return explain(words[i + 1], found, 'feeding it to this command');
  }
  return null;
}

function printReason(words, cwd, platform) {
  for (const file of filesPrinted(words)) {
    const found = kindOf(file, cwd, platform);
    if (found) return explain(file, found, 'this command');
  }
  return null;
}

// Reads `cp a b`, `ln -s target name`, `dd if=a of=b`, `Copy-Item -Path a -Destination b`
// and similar into the files being copied and where they go.
function readCopy(words) {
  const name = commandName(words);
  if (!COPIERS[name]) return null;
  if (name === 'dd') {
    const input = words.find((word) => word.startsWith('if='));
    const output = words.find((word) => word.startsWith('of='));
    return output ? { name, sources: input ? [input.slice(3)] : [], destination: output.slice(3), intoFolder: false } : null;
  }
  const powershell = POWERSHELL_COPIERS.has(name);
  const sources = [];
  const positional = [];
  let destination = null;
  let folder = null;
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i];
    const lower = word.toLowerCase();
    if (isRedirect(word)) {
      i += 1;
      continue;
    }
    if (powershell && word.startsWith('-')) {
      if ((lower === '-path' || lower === '-literalpath') && words[i + 1] !== undefined) {
        i += 1;
        sources.push(words[i]);
      } else if ((lower === '-destination' || lower === '-newname') && words[i + 1] !== undefined) {
        i += 1;
        destination = words[i];
      }
      continue;
    }
    if (!powershell && (word === '-t' || word === '--target-directory') && words[i + 1] !== undefined) {
      i += 1;
      folder = words[i];
      continue;
    }
    if (!powershell && word.startsWith('--target-directory=')) {
      folder = word.slice('--target-directory='.length);
      continue;
    }
    if (word.length > 1 && word.startsWith('-')) continue;
    if (/^\/[a-z]$/i.test(word) && ['copy', 'move', 'ren'].includes(name)) continue;
    positional.push(word);
  }
  if (folder !== null) return { name, sources: [...sources, ...positional], destination: folder, intoFolder: true };
  if (destination === null && positional.length > 1) destination = positional.pop();
  return { name, sources: [...sources, ...positional], destination, intoFolder: false };
}

// `git mv` renames a file the way mv does, once git's own options are read past, and its
// paths are relative to the folder git runs in. A dry run renames nothing.
function renameTarget(words, cwd, ctx) {
  const git = parseGit(words, cwd, ctx);
  if (!git) return { words, base: cwd };
  if (git.subcommand !== 'mv') return null;
  const dryRun = git.args.some((arg) => arg === '--dry-run' || (/^-[^-]/.test(arg) && arg.includes('n')));
  return dryRun ? null : { words: ['mv', ...git.args], base: git.dir };
}

function copyReason(words, cwd, ctx) {
  const platform = ctx.platform || process.platform;
  const target = renameTarget(words, cwd, ctx);
  if (!target) return null;
  const copy = readCopy(target.words);
  if (!copy || !copy.destination || copy.destination.includes(SUBSTITUTION)) return null;
  if (copy.intoFolder || /[\\/]$/.test(copy.destination) || isFolder(copy.destination, target.base, platform) || secretKind(copy.destination)) return null;
  for (const source of copy.sources) {
    if (source.includes(SUBSTITUTION)) continue;
    const found = kindOf(source, target.base, platform);
    if (!found) continue;
    return `This ${COPIERS[copy.name]} \`${baseName(source)}\`, which is ${found.kind}, to \`${baseName(copy.destination)}\`, a name that does not look secret. Under that name its secrets (API keys, passwords) could be read into this conversation without this guard noticing. To keep a backup, copy it into a folder so it keeps its name, for example cp ${shellQuote(String(source).replace(/\\/g, '/'))} backups/ instead.`;
  }
  return null;
}

function commandReason(command, dialect, cwd, ctx) {
  const platform = ctx.platform || process.platform;
  for (const words of commandsOf(command, dialect)) {
    const reason = inputReason(words, cwd, platform) || printReason(words, cwd, platform) || copyReason(words, cwd, ctx);
    if (reason) return reason;
  }
  return null;
}

function grepReason(input, cwd, platform) {
  if ((input.output_mode || 'files_with_matches') !== 'content') return null;
  if (input.path) {
    const found = kindOf(input.path, cwd, platform);
    if (found) return explain(String(input.path), found, 'searching it');
  }
  if (input.glob) {
    const last = segments(String(input.glob)).pop() || '';
    const kind = secretKind(last.replace(/[*?]/g, ''));
    if (kind) {
      return `The glob \`${input.glob}\` matches ${kind}, and searching it would copy its secrets (API keys, passwords) into this conversation.${advice('', null)}`;
    }
  }
  return null;
}

function check(payload, ctx = {}) {
  const input = payload.tool_input || {};
  const cwd = payload.cwd;
  const platform = ctx.platform || process.platform;
  if (payload.tool_name === 'Read') {
    const found = input.file_path ? kindOf(input.file_path, cwd, platform) : null;
    return found ? explain(String(input.file_path), found, 'reading it') : null;
  }
  if (payload.tool_name === 'Grep') return grepReason(input, cwd, platform);
  return commandReason(String(input.command || ''), dialectOf(payload.tool_name), cwd, ctx);
}

module.exports = { id: 'secret-files', tools: ['Read', 'Grep', 'Bash', 'PowerShell'], check, secretKind };

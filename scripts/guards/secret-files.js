'use strict';

const { commandsOf, commandName, isRedirect, SUBSTITUTION } = require('../lib/shell');
const { segments, baseName } = require('../lib/paths');

// Stops Claude from reading secret files into the conversation: .env files, private keys,
// cloud credentials and service account keys. Templates such as .env.example stay readable,
// and so do commands that use a secret file without printing it.

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
  jq: ['-f', '--from-file'],
  yq: ['--from-file'],
  'select-string': ['-pattern'],
  sls: ['-pattern'],
  findstr: [],
};

const GREP_LIKE = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);
const QUIET_LONG = new Set(['--quiet', '--silent', '--count', '--count-matches', '--files-with-matches', '--files-without-match']);

// What kind of secret a path holds, or null when it is not a secret file.
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

function advice(file, kind) {
  if (kind !== ENV_FILE) {
    return ' If a program needs this file, give it the path rather than the contents. If the user needs to see it, they can open it themselves.';
  }
  const shown = String(file).replace(/\\/g, '/');
  const quoted = /\s/.test(shown) ? `'${shown}'` : shown;
  const sourced = shown.includes('/') ? quoted : `./${quoted}`;
  return ` To confirm a variable is set without printing it, run: grep -q '^VARIABLE_NAME=' ${quoted} && echo set. To load the variables into a shell, run: set -a; . ${sourced}; set +a. If the user needs to see the values, they can open the file themselves.`;
}

function explain(file, kind, action) {
  return `\`${baseName(file)}\` is ${kind}, and ${action} would copy its secrets (API keys, passwords) into this conversation.${advice(file, kind)}`;
}

function isFlag(name, word) {
  if (name === 'findstr' && /^\/[a-z]/i.test(word)) return true;
  return word.length > 1 && word.startsWith('-');
}

// Flags that make a search print only counts, file names or an exit status.
function isQuiet(name, word) {
  const lower = word.toLowerCase();
  if (name === 'findstr') return lower === '/m';
  if (name === 'select-string' || name === 'sls') return lower === '-quiet';
  if (!GREP_LIKE.has(name)) return false;
  if (word.startsWith('--')) return QUIET_LONG.has(word.split('=')[0]);
  return /[qclL]/.test(word.slice(1));
}

// The files a command prints, as far as its words show.
function filesPrinted(words) {
  const name = commandName(words);
  const patternFlags = SEARCHERS[name];
  if (!PRINTERS.has(name) && !patternFlags) return [];

  const inputs = [];
  const positional = [];
  let patternGiven = false;
  let flagsDone = false;

  for (let i = 1; i < words.length; i += 1) {
    const word = words[i];
    if (isRedirect(word)) {
      if (word === '<' && words[i + 1] !== undefined) inputs.push(words[i + 1]);
      i += 1;
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
  return [...inputs, ...positional];
}

function commandReason(command) {
  for (const words of commandsOf(command)) {
    for (const file of filesPrinted(words)) {
      const kind = secretKind(file);
      if (kind) return explain(file, kind, 'this command');
    }
  }
  return null;
}

function grepReason(input) {
  if ((input.output_mode || 'files_with_matches') !== 'content') return null;
  if (input.path) {
    const kind = secretKind(input.path);
    if (kind) return explain(String(input.path), kind, 'searching it');
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

function check(payload) {
  const input = payload.tool_input || {};
  if (payload.tool_name === 'Read') {
    const kind = input.file_path ? secretKind(input.file_path) : null;
    return kind ? explain(String(input.file_path), kind, 'reading it') : null;
  }
  if (payload.tool_name === 'Grep') return grepReason(input);
  return commandReason(String(input.command || ''));
}

module.exports = { id: 'secret-files', tools: ['Read', 'Grep', 'Bash', 'PowerShell'], check, secretKind };

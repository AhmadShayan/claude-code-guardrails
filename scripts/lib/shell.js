'use strict';

// A small shell reader, written for guards rather than for running anything.
//
// It splits a command line into the simple commands a person would see, separated by
// ; && || | & and newlines. Anything inside $( ), backticks or a ( ) subshell is read as a
// command of its own, so a command hidden in one is still found. Each command becomes a
// list of words with the quotes removed. It does not expand variables or globs, and a
// word that contained a substitution carries SUBSTITUTION in its place, because its real
// value is only known once the shell runs it.
//
// There are two dialects. "bash" treats a backslash as an escape and a backtick as a
// substitution. "powershell" treats a backslash as an ordinary character, so C:\Users
// survives, and a backtick as the escape. Scripts handed to cmd are read the same way,
// because cmd leaves backslashes alone too.

const SUBSTITUTION = '\u0000';

// True when a word only gets its real value once the shell runs: a substitution, or a
// variable such as $BRANCH, ${REF}, $env:NAME or %NAME%.
function hasShellValue(word) {
  return String(word).includes(SUBSTITUTION) || /[$%]/.test(word);
}

const REDIRECTS = new Set(['<', '>', '>>', '<<', '<<<', '>&', '<&', '&>', '&>>', '>|']);

const WRAPPERS = new Set(['sudo', 'doas', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'timeout', 'env', 'xargs']);

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

function newContext(kind) {
  return { kind, commands: [], words: [], word: '', inWord: false, quote: null };
}

function endWord(ctx) {
  if (ctx.inWord) ctx.words.push(ctx.word);
  ctx.word = '';
  ctx.inWord = false;
}

function endCommand(ctx) {
  endWord(ctx);
  if (ctx.words.length) ctx.commands.push(ctx.words);
  ctx.words = [];
}

function tokenize(line, dialect = 'bash') {
  const powershell = dialect === 'powershell';
  const found = [];
  const outer = [];
  let ctx = newContext(null);

  const open = (kind) => {
    ctx.word += SUBSTITUTION;
    ctx.inWord = true;
    outer.push(ctx);
    ctx = newContext(kind);
  };
  const close = () => {
    endCommand(ctx);
    found.push(...ctx.commands);
    ctx = outer.pop();
  };

  const text = String(line);
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (ctx.quote === "'") {
      if (ch === "'") ctx.quote = null;
      else ctx.word += ch;
      continue;
    }

    if (ch === '$' && next === '(') {
      open(')');
      i += 1;
      continue;
    }
    if (ch === '`') {
      if (powershell) {
        if (next !== undefined) {
          ctx.word += next;
          ctx.inWord = true;
          i += 1;
        }
      } else if (ctx.kind === '`' && ctx.quote === null) {
        close();
      } else {
        open('`');
      }
      continue;
    }

    if (ctx.quote === '"') {
      if (ch === '"') {
        ctx.quote = null;
      } else if (!powershell && ch === '\\' && next !== undefined && '"\\$`'.includes(next)) {
        ctx.word += next;
        i += 1;
      } else {
        ctx.word += ch;
      }
      continue;
    }

    if (!powershell && ch === '\\' && next !== undefined) {
      ctx.word += next;
      ctx.inWord = true;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      ctx.quote = ch;
      ctx.inWord = true;
      continue;
    }
    if (ch === ')') {
      if (ctx.kind === ')') close();
      else endCommand(ctx);
      continue;
    }
    if (ch === '(' || ch === ';' || ch === '\n' || ch === '\r') {
      endCommand(ctx);
      continue;
    }
    if (ch === '|') {
      endCommand(ctx);
      if (next === '|') i += 1;
      continue;
    }
    if (ch === '&' && next !== '>') {
      endCommand(ctx);
      if (next === '&') i += 1;
      continue;
    }
    if (ch === '<' || ch === '>' || ch === '&') {
      endWord(ctx);
      let op = ch;
      while (REDIRECTS.has(op + (text[i + op.length] || ''))) op += text[i + op.length];
      ctx.words.push(op);
      i += op.length - 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      endWord(ctx);
      continue;
    }
    ctx.word += ch;
    ctx.inWord = true;
  }

  // An unclosed $( or backtick still contributes what it holds.
  endCommand(ctx);
  while (outer.length) {
    found.push(...ctx.commands);
    ctx = outer.pop();
    endCommand(ctx);
  }
  found.push(...ctx.commands);
  return found;
}

function commandName(words) {
  const first = String(words[0] || '');
  const parts = first.split(/[\\/]+/).filter(Boolean);
  return (parts[parts.length - 1] || '').toLowerCase().replace(/\.exe$/, '');
}

// Drops what runs in front of the real command: FOO=bar assignments, and wrappers such as
// sudo, env, timeout and nice together with their flags and numeric arguments.
function stripPrefix(words) {
  let i = 0;
  while (i < words.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) {
      i += 1;
      continue;
    }
    const name = commandName([words[i]]);
    if (!WRAPPERS.has(name)) break;
    i += 1;
    while (i < words.length) {
      const w = words[i];
      if ((name === 'sudo' || name === 'doas') && (w === '-u' || w === '-g')) {
        i += 2;
      } else if (w.startsWith('-') || /^\d+(\.\d+)?[smhd]?$/.test(w)) {
        i += 1;
      } else {
        break;
      }
    }
  }
  return words.slice(i);
}

// The script a command hands to another interpreter, such as bash -c "..." or eval "...",
// and the dialect to read it in.
function innerScript(words, dialect) {
  const name = commandName(words);
  const rest = words.slice(1);
  if (SHELLS.has(name)) {
    const at = rest.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w));
    return at >= 0 && rest[at + 1] !== undefined ? { script: rest[at + 1], dialect: 'bash' } : null;
  }
  if (name === 'cmd') {
    const at = rest.findIndex((w) => /^\/[ck]$/i.test(w));
    return at >= 0 ? { script: rest.slice(at + 1).join(' '), dialect: 'powershell' } : null;
  }
  if (name === 'powershell' || name === 'pwsh') {
    const at = rest.findIndex((w) => /^-(c|command)$/i.test(w));
    return at >= 0 ? { script: rest.slice(at + 1).join(' '), dialect: 'powershell' } : null;
  }
  if (name === 'eval') return { script: rest.join(' '), dialect };
  return null;
}

// Every simple command in a command line, with prefixes removed and scripts passed to
// bash -c, sh -c, cmd /c, powershell -Command and eval opened up.
function commandsOf(line, dialect = 'bash', depth = 0) {
  const result = [];
  for (const raw of tokenize(line, dialect)) {
    const words = stripPrefix(raw);
    if (!words.length) continue;
    const inner = depth < 3 ? innerScript(words, dialect) : null;
    if (inner) result.push(...commandsOf(inner.script, inner.dialect, depth + 1));
    else result.push(words);
  }
  return result;
}

// Claude Code's PowerShell tool speaks PowerShell. Everything else is a POSIX-style shell,
// which on Windows means Git Bash.
function dialectOf(toolName) {
  return toolName === 'PowerShell' ? 'powershell' : 'bash';
}

function isRedirect(word) {
  return REDIRECTS.has(word);
}

module.exports = { SUBSTITUTION, hasShellValue, tokenize, commandsOf, commandName, dialectOf, stripPrefix, isRedirect };

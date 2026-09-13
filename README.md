# claude-code-guardrails

[![test](https://github.com/AhmadShayan/claude-code-guardrails/actions/workflows/test.yml/badge.svg)](https://github.com/AhmadShayan/claude-code-guardrails/actions/workflows/test.yml)

Safety hooks for building with Claude Code. They stop the handful of commands that do damage nobody can undo, before those commands run.

Claude Code works in your real project, with your real files, keys and git history, and almost everything it does there is exactly what you asked for. The exceptions are rare and expensive: an `.env` file printed into the chat, `rm -rf` pointed one folder too high, a force-push over the branch your site deploys from, or `git reset --hard` on an afternoon of uncommitted work. This plugin catches those. When it blocks something, Claude sees the reason and a safer way to get the job done, so the session keeps moving.

![Replay of a Claude Code session: asked to back up .env by copying it to env-backup.txt, Claude runs cp .env env-backup.txt, the secret-files hook blocks it because the new name does not look secret, and Claude suggests cp .env backups/.env or cp .env .env.backup instead.](docs/demo.gif)

*Replayed from a real headless Claude Code 2.1.228 session (claude -p) on Windows. The prompt, command, hook denial and Claude's reply are the session's own words; the window, layout, colors, code formatting, line wrapping, typing and timing are illustrative.*

## Install

From a terminal:

```bash
claude plugin marketplace add AhmadShayan/claude-code-guardrails
claude plugin install claude-code-guardrails@ahmadshayan
```

Inside a Claude Code session, `/plugin marketplace add` and `/plugin install` take the same arguments. Start a new session afterwards. The hooks need Node.js 20 or newer on your `PATH`.

## What it blocks

**secret-files** keeps secrets out of the conversation. It blocks reading `.env` files (templates such as `.env.example` stay readable), SSH private keys, certificate and key files such as `.pem` and `.key`, cloud credentials and service account keys, whether through the Read tool, Grep, or a command such as `cat`, `grep`, `sed` or `Get-Content`. It follows symlinks, and it blocks copying, moving or linking a secret file to a name that does not look secret, so a second name cannot carry the file past the check. Checking that a variable is set with `grep -q '^STRIPE_SECRET_KEY=' .env` still works, because it prints nothing.

**force-push** protects the branch you deploy from. It blocks force-pushing `main`, `master` or the remote's default branch, `git push --mirror`, and deleting those branches on the remote. Force-pushing your own feature branch still works. The default branch comes from git's local record of it (`origin/HEAD`, which `git clone` sets up). In a repository without that record, the guard refuses any force-push it cannot rule out and says how to create the record.

**destructive-commands** protects work that is not saved anywhere else. It blocks recursive deletes of the project folder, any folder above it, your home folder and the whole disk, and it blocks deleting `.git`. It also blocks `git reset --hard`, `git checkout .`, `git restore .`, `git switch --discard-changes`, `git clean -f` and `git stash clear`, but only after asking git whether they would destroy something, so they run as normal when there is nothing to lose. If git cannot answer, or part of the command only gets its value once the shell runs, those git commands are refused rather than guessed at. `gh repo delete` is blocked too.

Commands are split the way a shell would split them, so a blocked command is still caught after `&&`, inside `$( )`, in `bash -c "..."`, or in PowerShell.

## What a block looks like

This is from a real session. Asked to "throw away my uncommitted change to app.js by running git reset --hard", Claude checked `git status`, tried the reset, and the hook sent back:

```text
Blocked by claude-code-guardrails (destructive-commands). git reset --hard throws away the uncommitted changes in 1 file, and git keeps no copy of them. Save them first with git stash, or commit them, and then reset. If the user really wants this, they can run the command themselves.
```

Claude stopped there and replied:

> A guardrail hook blocked `git reset --hard` since it permanently destroys the change with no recovery copy. Since you've explicitly asked for this, you'll need to run it yourself in the terminal: `git reset --hard`. If you'd rather keep a safety net, I can run `git stash` instead, which discards it from your working directory but keeps a recoverable copy.

The uncommitted change was still there afterwards.

## Turning a guard off

Add the guard's name to `CLAUDE_GUARDRAILS_DISABLE` in your settings, for example in `.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_GUARDRAILS_DISABLE": "force-push"
  }
}
```

Separate several names with commas. To switch the whole plugin off, run `claude plugin disable claude-code-guardrails` from a terminal.

## What it is not

A guardrail, not a sandbox. It reads each command before it runs and catches the ways these accidents usually happen. It checks Claude Code's built-in Bash, PowerShell, Read and Grep tools, not tools that MCP servers add. It cannot see inside a script that Claude writes and then runs, and it will not stop someone who is deliberately working around it. It judges files by name, so a secret inside a folder that is copied, moved or archived as a whole, with `rsync` or `tar` for example, is not seen. On Windows, a path on another machine, such as `\\server\share\notes.txt`, is judged by its name alone and a symlink there is not followed, because looking it up would contact that machine before you approve anything. A delete aimed at a variable, such as `rm -rf "$BUILD_DIR"`, is allowed, because the value only exists once the shell runs and blocking every variable would block ordinary work. If a guard ever crashes, that call goes ahead and Claude Code shows a hook error, so a broken guard is never mistaken for a working one.

## Development

```bash
npm test
```

The tests need nothing but Node and git, and CI runs them on Linux, macOS and Windows. To try the hook by hand, pipe it a tool call:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"cat .env"},"cwd":"."}' | node scripts/run.js
```

## License

MIT. Made by [Ahmad Shayan](https://ahmadshayan.com).

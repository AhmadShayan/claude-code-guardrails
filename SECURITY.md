# Security policy

## Reporting a problem

Please report security problems privately, not in a public issue. Open this repository's **Security** tab and choose **Report a vulnerability**, or go straight to [the private report form](https://github.com/AhmadShayan/claude-code-guardrails/security/advisories/new).

A useful report names the guard, the exact tool call or command, what you expected to happen, your operating system and shell, and your Claude Code and Node.js versions.

## What counts

- A way past a guard for something the README says it blocks.
- A tool call that makes the hook do something on its own: run a program, read the contents of a file, or connect to another machine.
- A tool call that lets a command through unchecked without Claude Code showing a hook error.

The limits listed under "What it is not" in the README are known and documented, so they are not vulnerabilities: tools added by MCP servers, scripts Claude writes and then runs, deliberate workarounds, folders copied or archived as a whole, and deletes aimed at a shell variable.

## Supported versions

Fixes land on `main` and in the next release. Only the latest release is supported.

## What happens next

You can expect a first reply within a week. Once a fix is released, the advisory is published and you are credited, unless you would rather not be named.

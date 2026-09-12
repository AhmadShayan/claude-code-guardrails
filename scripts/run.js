#!/usr/bin/env node
'use strict';

// Entry point for the PreToolUse hook. Claude Code pipes the pending tool call in as JSON.
// If a guard objects, a deny decision goes back on stdout and the call never runs.

const { readStdin, decide } = require('./lib/runner');

readStdin(process.stdin).then((raw) => {
  const { stdout, stderr, exitCode } = decide(raw, { env: process.env });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = exitCode;
});

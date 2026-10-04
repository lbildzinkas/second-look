#!/usr/bin/env node
import { stopAgentChildrenOnSignal } from './agent-children.js';
import { runCli } from './cli.js';

stopAgentChildrenOnSignal();

const code = await runCli(process.argv.slice(2), process.env, {
  out: process.stdout,
  err: process.stderr,
});
process.exitCode = code;

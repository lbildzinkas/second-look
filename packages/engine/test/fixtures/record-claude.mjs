#!/usr/bin/env node
// A recorder for the live Claude Code suite: started as
// `record-claude.mjs <log folder> <claude command> <args...>`, it runs the
// real Claude Code with the arguments, folder, stdin and environment the
// adapter gave it, passes its output through unchanged, and keeps a copy:
// each print-mode run's stream in <log folder>/stream.jsonl, and the
// guard's audit file in <log folder>/audit.jsonl before the adapter
// removes it. It changes nothing Claude Code sees.
import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [log, claude, ...args] = process.argv.slice(2);
const printing = args.includes('--print');
const child = spawn(claude, args, { stdio: ['inherit', 'pipe', 'inherit'] });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.stdout.on('data', (chunk) => {
  if (printing) appendFileSync(join(log, 'stream.jsonl'), chunk);
  process.stdout.write(chunk);
});
child.on('close', (code, signal) => {
  const audit = process.env.SECOND_LOOK_GUARD_AUDIT;
  if (printing && audit && existsSync(audit)) copyFileSync(audit, join(log, 'audit.jsonl'));
  process.exitCode = code ?? (signal ? 1 : 0);
});

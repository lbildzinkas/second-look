#!/usr/bin/env node
// A fake Claude Code for the Jira checks' tests: in print mode it records
// how it was started — its arguments, folder, stdin and the environment
// variables the checks care about — then writes the scripted stream-json
// events from FAKE_CLAUDE_DIR/events.json, one per line. With "hold" set it
// stays running after them, as a run waiting on its model would, until it
// is stopped. It never calls a model and never reaches the network.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_CLAUDE_DIR;
const scenario = JSON.parse(readFileSync(join(dir, 'events.json'), 'utf8'));
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;
const pick = (names) => Object.fromEntries(names.filter((name) => name in process.env).map((name) => [name, process.env[name]]));
appendFileSync(
  join(dir, 'calls.jsonl'),
  `${JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), stdin, env: pick(['GITHUB_TOKEN', 'SECOND_LOOK_READ_ROOT', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']) })}\n`,
);
for (const event of scenario.events) process.stdout.write(`${JSON.stringify(event)}\n`);
if (scenario.hold) setInterval(() => undefined, 1000);
else process.exitCode = scenario.exitCode ?? 0;

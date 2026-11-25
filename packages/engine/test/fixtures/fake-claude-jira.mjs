#!/usr/bin/env node
// A fake Claude Code for the Jira runs' tests: in print mode it records
// how it was started — its arguments, folder, stdin and the environment
// variables the runs care about — then writes the scripted stream-json
// events from FAKE_CLAUDE_DIR/events.json, one per line. Before it writes
// an assistant message's tool calls it runs the guard hook the --settings
// argument names on each, through a shell as Claude Code does, unless the
// scenario says "skipGuard"; a call the hook denies has its tool result
// replaced by the refusal and is reported in the result's permission
// denials, as Claude Code reports a hook's deny. With "hold" set it stays
// running after the events, as a run waiting on its model would, until it
// is stopped. A scenario of "runs" plays the next one each time the fake
// starts. It never calls a model and never reaches the network.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_CLAUDE_DIR;
// A scenario with "runs" plays them in turn, one per start of the fake.
const script = JSON.parse(readFileSync(join(dir, 'events.json'), 'utf8'));
const calls = join(dir, 'calls.jsonl');
const started = existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter((line) => line.includes('"kind":"run"')).length : 0;
const scenario = script.runs ? script.runs[Math.min(started, script.runs.length - 1)] : script;
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;
const args = process.argv.slice(2);
const pick = (names) => Object.fromEntries(names.filter((name) => name in process.env).map((name) => [name, process.env[name]]));
const record = (line) => appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify(line)}\n`);
record({
  kind: 'run',
  args,
  cwd: process.cwd(),
  stdin,
  env: pick(['GITHUB_TOKEN', 'SECOND_LOOK_READ_ROOT', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'SECOND_LOOK_JIRA_GUARD']),
});

const settingsAt = args.indexOf('--settings');
const settings = settingsAt === -1 ? {} : JSON.parse(args[settingsAt + 1]);
const hookCommand = settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
const refused = new Map();

for (const event of scenario.events) {
  const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
  if (event.type === 'assistant' && hookCommand && !scenario.skipGuard) {
    for (const block of blocks.filter((each) => each.type === 'tool_use')) {
      const hookEvent = {
        session_id: 'fake-session', hook_event_name: 'PreToolUse', cwd: process.cwd(), permission_mode: 'default',
        tool_name: block.name, tool_input: block.input, tool_use_id: block.id,
      };
      const hook = spawnSync(hookCommand, { shell: true, input: JSON.stringify(hookEvent), encoding: 'utf8' });
      record({ kind: 'hook', id: block.id, tool: block.name, status: hook.status, stdout: hook.stdout, stderr: hook.stderr });
      let reason;
      try {
        const answer = JSON.parse(hook.stdout);
        if (answer.hookSpecificOutput?.permissionDecision === 'deny') reason = answer.hookSpecificOutput.permissionDecisionReason;
      } catch {
        // An empty answer passes the call on.
      }
      if (hook.status === 2) reason = hook.stderr;
      if (reason !== undefined) refused.set(block.id, { name: block.name, reason });
    }
  }
  if (event.type === 'user') {
    for (const block of blocks) {
      if (block.type === 'tool_result' && refused.has(block.tool_use_id)) {
        block.content = [{ type: 'text', text: refused.get(block.tool_use_id).reason }];
        block.is_error = true;
      }
    }
  }
  if (event.type === 'result') {
    event.permission_denials = [
      ...(event.permission_denials ?? []),
      ...[...refused].map(([id, { name }]) => ({ tool_name: name, tool_use_id: id })),
    ];
  }
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
if (scenario.hold) setInterval(() => undefined, 1000);
else process.exitCode = scenario.exitCode ?? 0;

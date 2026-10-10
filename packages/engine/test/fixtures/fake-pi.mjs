#!/usr/bin/env node
// A fake Pi for the agent contract tests: it answers --version and --help
// like Pi, and in JSON mode it records how it was started, then plays the
// next scripted run from FAKE_PI_DIR/scenario.json as Pi's JSON event
// stream. It never calls a model and never reads anything outside its own
// state folder.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_PI_DIR;
const scenario = JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8'));
const args = process.argv.slice(2);

const FLAGS = [
  '--provider', '--model', '--system-prompt', '--mode', '--print', '--no-session',
  '--no-tools', '--tools', '--thinking', '--extension', '--no-extensions', '--no-skills',
  '--no-prompt-templates', '--no-themes', '--no-context-files', '--approve', '--no-approve',
  '--offline', '--help', '--version',
];

if (args[0] === '--version') {
  process.stdout.write(`${scenario.version ?? '9.9.9'}\n`);
  process.exit(0);
}
if (args[0] === '--help') {
  const missing = new Set(scenario.missingFlags ?? []);
  const lines = FLAGS.filter((flag) => !missing.has(flag)).map((flag) => `  ${flag} <value>   ${scenario.flagHelp?.[flag] ?? 'A flag'}`);
  process.stdout.write(`pi - fake\n\nOptions:\n${lines.join('\n')}\n`);
  process.exit(0);
}

const record = (entry) => appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify(entry)}\n`);
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;

const pick = (names) => Object.fromEntries(names.filter((name) => name in process.env).map((name) => [name, process.env[name]]));
const earlier = (() => {
  try {
    return readFileSync(join(dir, 'calls.jsonl'), 'utf8').split('\n').filter((line) => line.startsWith('{"kind":"run"')).length;
  } catch {
    return 0;
  }
})();
const runs = scenario.runs;
const run = runs[Math.min(earlier, runs.length - 1)];
record({
  kind: 'run',
  args,
  cwd: process.cwd(),
  stdin,
  pid: process.pid,
  env: pick(['GITHUB_TOKEN', 'GH_TOKEN', 'SECOND_LOOK_READ_ROOT', 'PI_OFFLINE', 'PI_TELEMETRY', 'FAKE_AGENT_LOGIN']),
  at: Date.now(),
});

const usage = run.usage ?? { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 125, cost: { total: 0.01 } };
const assistant = (text, stopReason, extra = {}) => ({
  role: 'assistant',
  content: text ? [{ type: 'text', text }] : [],
  provider: 'fake-provider',
  model: run.model ?? 'fake-model',
  ...(run.effort ? { providerThinkingLevel: run.effort } : {}),
  usage,
  stopReason,
  ...extra,
});

emit({ type: 'session', version: 3, id: 'fake', cwd: process.cwd() });
emit({ type: 'agent_start' });
if (run.delayMs) await sleep(run.delayMs);
if (run.toolUse) {
  emit({ type: 'message_start', message: assistant('', 'toolUse') });
  emit({ type: 'message_end', message: assistant('', 'toolUse') });
}
emit({ type: 'message_start', message: assistant('', 'stop') });
if (run.hang) {
  emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: run.partial ?? '' } });
  if (run.ignoreTerm) process.on('SIGTERM', () => undefined);
  setInterval(() => undefined, 1000);
} else if (run.error) {
  emit({ type: 'message_end', message: assistant('', 'error', { errorMessage: run.error }) });
  emit({ type: 'agent_end', messages: [] });
  record({ kind: 'end', at: Date.now() });
  process.exitCode = 1;
} else {
  for (const delta of [run.text.slice(0, 3), run.text.slice(3)]) {
    emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta } });
  }
  emit({ type: 'message_end', message: assistant(run.text, 'stop') });
  emit({ type: 'agent_end', messages: [] });
  record({ kind: 'end', at: Date.now() });
}

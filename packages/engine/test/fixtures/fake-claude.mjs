#!/usr/bin/env node
// A fake Claude Code for the agent contract tests: it answers --version and
// --help like Claude Code, and in print mode it records how it was started,
// then plays the next scripted run from FAKE_CLAUDE_DIR/scenario.json as
// Claude Code's stream-json output. It never calls a model and never reads
// anything outside its own state folder.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_CLAUDE_DIR;
const scenario = JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8'));
const args = process.argv.slice(2);

const FLAGS = [
  '--print', '--output-format', '--input-format', '--include-partial-messages',
  '--no-session-persistence', '--setting-sources', '--settings', '--strict-mcp-config',
  '--mcp-config', '--tools', '--allowedTools', '--disallowedTools', '--permission-mode',
  '--permission-prompts', '--system-prompt', '--append-system-prompt', '--json-schema',
  '--model', '--effort', '--fallback-model', '--verbose', '--help', '--version',
];

if (args[0] === '--version') {
  process.stdout.write(`${scenario.version ?? '9.9.9'} (Claude Code)\n`);
  process.exit(0);
}
if (args[0] === '--help') {
  const missing = new Set(scenario.missingFlags ?? []);
  const lines = FLAGS.filter((flag) => !missing.has(flag)).map((flag) => `  ${flag} <value>   A flag`);
  process.stdout.write(`claude - fake\n\nOptions:\n${lines.join('\n')}\n`);
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
  env: pick(['GITHUB_TOKEN', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'FAKE_AGENT_LOGIN']),
  at: Date.now(),
});

const usage = run.usage ?? {
  input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 0,
};
const cost = run.cost ?? 0.01;
const model = run.model ?? 'fake-model';
// The init event is held back until the scripted answer starts, so a hung
// run names no model — the contract's "ends before the agent names one".
const init = () =>
  emit({
    type: 'system', subtype: 'init', cwd: process.cwd(),
    tools: ['Read', 'Grep', 'Glob', 'StructuredOutput'], mcp_servers: [],
    model, apiKeySource: process.env.ANTHROPIC_API_KEY ? 'environment variable' : 'none',
  });

if (run.delayMs) await sleep(run.delayMs);
if (run.hang) {
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: run.partial ?? '' } } });
  if (run.ignoreTerm) process.on('SIGTERM', () => undefined);
  setInterval(() => undefined, 1000);
} else if (run.error) {
  init();
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: run.error, model, usage, total_cost_usd: cost });
  record({ kind: 'end', at: Date.now() });
  process.exitCode = 1;
} else {
  init();
  emit({ type: 'assistant', message: { model, role: 'assistant', content: [{ type: 'text', text: run.text }], usage } });
  for (const delta of [run.text.slice(0, 3), run.text.slice(3)]) {
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } } });
  }
  emit({ type: 'result', subtype: 'success', is_error: false, result: run.text, model, usage, total_cost_usd: cost });
  record({ kind: 'end', at: Date.now() });
}

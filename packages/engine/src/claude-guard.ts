/**
 * The companion's guard for Claude Code, run by Claude Code as a
 * `PreToolUse` hook before every tool call: it reads the hook event from
 * stdin and answers with the decision `claude-guard-check.ts` makes.
 *
 * Claude Code treats a hook that exits with any code but 2 as a harmless
 * error and runs the call anyway, so this process exits with 2 unless its
 * answer was written in full: a crash, an unreadable event or a lost
 * answer all block the call. The package bundles this file with its
 * siblings into one self-contained script.
 */
import { answerPreToolUse } from './claude-guard-check.js';

function fail(error: unknown): void {
  process.stderr.write(`Refused by Second Look: the guard failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

process.exitCode = 2;
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

let eventText = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) eventText += chunk as string;
const answer = answerPreToolUse(eventText, process.env);
process.stderr.write(answer.stderr);
if (answer.stdout === '') {
  process.exitCode = answer.exitCode;
} else {
  process.stdout.write(answer.stdout, (error) => {
    if (error) fail(error);
    else process.exitCode = answer.exitCode;
  });
}

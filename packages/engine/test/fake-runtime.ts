import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { StartRuntime } from '../src/sandbox.js';

/**
 * A fake container runtime CLI for the sandboxed run's tests, so no unit
 * test starts a process, let alone a container.
 */

/** What one fake runtime command is told and how it answers. */
export interface FakeCall {
  program: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  /** Everything the engine wrote to its stdin. */
  stdin: Buffer[];
  child: FakeChild;
}

export interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: string[];
  finish: (code: number | null, output?: string) => void;
}

/**
 * A fake runtime CLI: each command answers through `answer`, which may
 * finish it at once or leave it running, as a container would.
 */
export function fakeRuntime(answer: (call: FakeCall) => void): { start: StartRuntime; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const start: StartRuntime = (program, args, env) => {
    const child = new EventEmitter() as FakeChild;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = [];
    (child as unknown as { kill: (signal: string) => boolean }).kill = (signal) => {
      child.killed.push(signal);
      return true;
    };
    let finished = false;
    child.finish = (code, output = '') => {
      if (finished) return;
      finished = true;
      child.stdout.end(output);
      child.stderr.end();
      setImmediate(() => child.emit('close', code, null));
    };
    const call: FakeCall = { program, args, env, stdin: [], child };
    child.stdin.on('data', (chunk: Buffer) => call.stdin.push(chunk));
    calls.push(call);
    setImmediate(() => answer(call));
    return child as unknown as ChildProcess;
  };
  return { start, calls };
}

/** A runtime that pulls, runs the command to its end with `output`, and kills by name. */
export function answering(runOutput: string, runCode = 0): (call: FakeCall) => void {
  return (call) => {
    if (call.args[0] === 'run') {
      call.child.stdin.on('end', () => call.child.finish(runCode, runOutput));
      return;
    }
    call.child.finish(0);
  };
}

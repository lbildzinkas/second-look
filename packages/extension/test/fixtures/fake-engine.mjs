// A fake engine for tests: a separate process that speaks the companion's
// JSON-RPC protocol on stdio, one message per line. It answers the version
// handshake, then serves a review result the test chose through its
// environment:
//
//   FAKE_ENGINE_RESULT            JSON review result to return for review
//   FAKE_ENGINE_ERROR             answer review with this plain error message
//   FAKE_ENGINE_PROTOCOL_VERSION  protocol version to speak (default 1)
//   FAKE_ENGINE_EXIT_ON           exit right after this method, answering nothing
//   FAKE_ENGINE_STALL_ON          receive this method, answer nothing, stay alive
//   FAKE_ENGINE_LOG               path to append every request it received
//
// Every request it receives is appended to the log, so a test can prove
// what reached the engine, including the token carried per request.
import { appendFileSync } from 'node:fs';

const protocolVersion = Number(process.env.FAKE_ENGINE_PROTOCOL_VERSION ?? '1');
const reviewResult = process.env.FAKE_ENGINE_RESULT
  ? JSON.parse(process.env.FAKE_ENGINE_RESULT)
  : null;
const reviewError = process.env.FAKE_ENGINE_ERROR;
const exitOn = process.env.FAKE_ENGINE_EXIT_ON;
const stallOn = process.env.FAKE_ENGINE_STALL_ON;
const log = process.env.FAKE_ENGINE_LOG;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handle(line) {
  if (line.trim() === '') return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    fail(null, -32700, 'not JSON');
    return;
  }
  if (log) appendFileSync(log, `${JSON.stringify(request)}\n`);
  if (stallOn && request.method === stallOn) {
    return;
  }
  if (exitOn && request.method === exitOn) {
    process.exit(0);
  }
  if (request.method === 'initialize') {
    if (request.params.protocolVersion !== protocolVersion) {
      fail(
        request.id,
        -32000,
        `protocol version ${request.params.protocolVersion} is not supported; this engine speaks ${protocolVersion}`,
      );
      return;
    }
    send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion } });
    return;
  }
  if (request.method === 'review') {
    if (reviewError) {
      fail(request.id, -32002, reviewError);
      return;
    }
    send({ jsonrpc: '2.0', id: request.id, result: reviewResult });
    return;
  }
  fail(request.id, -32601, `unknown method: ${request.method}`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline === -1) return;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    handle(line);
  }
});

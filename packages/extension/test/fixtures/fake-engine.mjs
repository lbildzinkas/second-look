// A fake engine for tests: a separate process that speaks the companion's
// JSON-RPC protocol on stdio, one message per line. It answers the version
// handshake, then serves a review result the test chose through its
// environment:
//
//   FAKE_ENGINE_RESULT            JSON review result to return for review
//   FAKE_ENGINE_RESULTS_BY_URL     JSON { url: review result } to answer review by
//                                  the requested URL, falling back to FAKE_ENGINE_RESULT
//   FAKE_ENGINE_ERROR             answer review with this plain error message
//   FAKE_ENGINE_SEND_RESULT       JSON sent review to return for sendReview
//   FAKE_ENGINE_SEND_ERROR        answer sendReview with this plain error message
//   FAKE_ENGINE_SEND_DELAY_MS      wait this long before answering sendReview
//   FAKE_ENGINE_FETCH_RESULT      JSON review result to return for fetchLibrary
//   FAKE_ENGINE_FETCH_ERROR       answer fetchLibrary with this plain error message
//   FAKE_ENGINE_DRAFT_RESULT      JSON draft comment to return for draftComment
//   FAKE_ENGINE_DRAFT_ERROR       answer draftComment with this plain error message
//   FAKE_ENGINE_ASK_RESULT        JSON answer to return for ask
//   FAKE_ENGINE_ASK_ERROR         answer ask with this plain error message
//   FAKE_ENGINE_PROTOCOL_VERSION  protocol version to speak (default 1)
//   FAKE_ENGINE_EXIT_ON           exit right after this method, answering nothing
//   FAKE_ENGINE_STALL_ON          receive this method, answer nothing, stay alive
//   FAKE_ENGINE_IGNORE_SIGTERM    stay alive when sent SIGTERM, like a frozen engine
//   FAKE_ENGINE_LOG               path to append every request it received
//   FAKE_ENGINE_STAGE             JSON { running, timeoutMs, result } to send as a
//                                 review/stage notification before the answer
//   FAKE_ENGINE_STAGE_ONLY        send the stage notification, then never answer
//   FAKE_ENGINE_ANSWER_DELAY_MS   wait this long after the stage before answering
//   FAKE_ENGINE_VIEWED_ERROR      answer markViewed with this plain error message
//   FAKE_ENGINE_PROJECT_ERROR     answer loadProject with this plain error message
//
// The reviewed marks live in the fake's memory: markReviewed ticks or
// clears a part by its name, reviewedMarks reads them back, and markViewed
// answers with the paths it was asked to mark. loadProject writes nothing:
// it answers with a project folder beside the review result's head copy,
// refusing a load at any other commit, like the engine.
//
// Every request it receives is appended to the log, so a test can prove
// what reached the engine, including the token carried per request.
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const protocolVersion = Number(process.env.FAKE_ENGINE_PROTOCOL_VERSION ?? '1');
const reviewResult = process.env.FAKE_ENGINE_RESULT
  ? JSON.parse(process.env.FAKE_ENGINE_RESULT)
  : null;
const resultsByUrl = process.env.FAKE_ENGINE_RESULTS_BY_URL
  ? JSON.parse(process.env.FAKE_ENGINE_RESULTS_BY_URL)
  : null;
const reviewError = process.env.FAKE_ENGINE_ERROR;
const sendResult = process.env.FAKE_ENGINE_SEND_RESULT
  ? JSON.parse(process.env.FAKE_ENGINE_SEND_RESULT)
  : { url: 'https://github.com/example-org/example-repo/pull/42#pullrequestreview-4242' };
const sendError = process.env.FAKE_ENGINE_SEND_ERROR;
const fetchResult = process.env.FAKE_ENGINE_FETCH_RESULT ? JSON.parse(process.env.FAKE_ENGINE_FETCH_RESULT) : null;
const fetchError = process.env.FAKE_ENGINE_FETCH_ERROR;
const draftResult = process.env.FAKE_ENGINE_DRAFT_RESULT ? JSON.parse(process.env.FAKE_ENGINE_DRAFT_RESULT) : null;
const draftError = process.env.FAKE_ENGINE_DRAFT_ERROR;
const askResult = process.env.FAKE_ENGINE_ASK_RESULT ? JSON.parse(process.env.FAKE_ENGINE_ASK_RESULT) : null;
const askError = process.env.FAKE_ENGINE_ASK_ERROR;
const sendDelayMs = Number(process.env.FAKE_ENGINE_SEND_DELAY_MS ?? '0');
const exitOn = process.env.FAKE_ENGINE_EXIT_ON;
const stallOn = process.env.FAKE_ENGINE_STALL_ON;
const log = process.env.FAKE_ENGINE_LOG;
const stage = process.env.FAKE_ENGINE_STAGE ? JSON.parse(process.env.FAKE_ENGINE_STAGE) : null;
const stageOnly = Boolean(process.env.FAKE_ENGINE_STAGE_ONLY);
const answerDelayMs = Number(process.env.FAKE_ENGINE_ANSWER_DELAY_MS ?? '0');
const viewedError = process.env.FAKE_ENGINE_VIEWED_ERROR;
const projectError = process.env.FAKE_ENGINE_PROJECT_ERROR;
let marks = [];

if (process.env.FAKE_ENGINE_IGNORE_SIGTERM) {
  process.on('SIGTERM', () => {
    // Swallow the signal and stay alive: SIGTERM is held pending on a
    // stopped process until it resumes, so this models a frozen engine.
  });
  // Announce the handler on stderr, so a test can wait until it is in
  // place: a SIGTERM delivered while the process is still starting up
  // would kill it before the handler exists.
  process.stderr.write('ignoring SIGTERM\n');
}

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
    if (stage) {
      send({ jsonrpc: '2.0', method: 'review/stage', params: { id: request.id, ...stage } });
      if (stageOnly) return;
    }
    const answer = () => send({ jsonrpc: '2.0', id: request.id, result: resultsByUrl?.[request.params.url] ?? reviewResult });
    if (answerDelayMs > 0) setTimeout(answer, answerDelayMs);
    else answer();
    return;
  }
  if (request.method === 'sendReview') {
    if (sendError) {
      fail(request.id, -32002, sendError);
      return;
    }
    const answer = () => send({ jsonrpc: '2.0', id: request.id, result: sendResult });
    if (sendDelayMs > 0) setTimeout(answer, sendDelayMs);
    else answer();
    return;
  }
  if (request.method === 'fetchLibrary') {
    if (fetchError) fail(request.id, -32002, fetchError);
    else send({ jsonrpc: '2.0', id: request.id, result: fetchResult });
    return;
  }
  if (request.method === 'draftComment') {
    if (draftError) fail(request.id, -32002, draftError);
    else send({ jsonrpc: '2.0', id: request.id, result: draftResult });
    return;
  }
  if (request.method === 'ask') {
    if (askError) fail(request.id, -32002, askError);
    else send({ jsonrpc: '2.0', id: request.id, result: askResult });
    return;
  }
  if (request.method === 'reviewedMarks') {
    send({ jsonrpc: '2.0', id: request.id, result: { marks } });
    return;
  }
  if (request.method === 'markReviewed') {
    const { part, reviewed } = request.params;
    marks = marks.filter((mark) => mark.name !== part.name);
    if (reviewed) {
      const hash = createHash('sha256').update(part.pieces.join('\n')).digest('hex');
      marks.push({ hash, name: part.name, pieces: part.pieces, markedAt: '2026-10-06T00:00:00.000Z' });
    }
    send({ jsonrpc: '2.0', id: request.id, result: { marks } });
    return;
  }
  if (request.method === 'markViewed') {
    if (viewedError) fail(request.id, -32002, viewedError);
    else send({ jsonrpc: '2.0', id: request.id, result: { paths: request.params.paths } });
    return;
  }
  if (request.method === 'loadProject') {
    const head = (resultsByUrl?.[request.params.url] ?? reviewResult).copies.head;
    if (projectError || request.params.commit !== head.commit) {
      fail(
        request.id,
        -32002,
        projectError ??
          `this engine's latest finished review is at commit ${head.commit.slice(0, 7)}, not the confirmed ${String(request.params.commit ?? '').slice(0, 7)}; review the pull request again, then load it`,
      );
      return;
    }
    const path = `${head.path.slice(0, head.path.lastIndexOf('/'))}/project/${head.commit}`;
    send({ jsonrpc: '2.0', id: request.id, result: { commit: head.commit, path, reused: false } });
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

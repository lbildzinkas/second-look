import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAnswer, type AgentAdapter, type AgentSettings, type AgentStamp } from './agent.js';
import type { AgentName } from './agents.js';
import { removeCopy } from './cache.js';
import { validateJson, type JsonSchema } from './json-schema.js';

/**
 * The agent test (issue 132): one tiny run of the reviewer's chosen agent,
 * model and effort, locked down exactly as a review's agent passes run —
 * the same adapter, probe and run — in an empty temporary folder made
 * read-only, which is removed afterwards. A fixed prompt asks for a
 * one-field JSON answer. The test runs only when the reviewer asks for it;
 * nothing calls it automatically. It answers ok with the run's stamp, or
 * the failure in plain words with whatever stamp the run had.
 */

/** The companion's instructions for the test run. */
export const AGENT_TEST_INSTRUCTIONS =
  'You are being tested to show that you can answer. Do not read any file and do not use any tool. ' +
  'Reply with only the JSON value the schema asks for, and nothing else.';

/** The fixed tiny prompt the test run answers. */
export const AGENT_TEST_PROMPT = 'Answer with this exact JSON value: {"ok":true}';

/** The one-field answer the test asks for. */
export const AGENT_TEST_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: { ok: { enum: [true] } },
};

/** Why a test failed: the agent could not run, its login, its model, its time, or its answer. */
export type AgentTestFailure = 'unusable' | 'not-signed-in' | 'unknown-model' | 'timeout' | 'failed' | 'invalid-answer';

/** The test's result: ok with the run's stamp, or the failure in plain words; always stamped. */
export type AgentTestResult =
  | { ok: true; stamp: AgentStamp }
  | { ok: false; reason: AgentTestFailure; message: string; stamp: AgentStamp };

const AGENT_LABELS: Record<AgentName, string> = { pi: 'Pi', 'claude-code': 'Claude Code' };

/** Words agents use when their login is missing, expired or refused. */
const SIGN_IN_WORDS = /not logged in|log ?in|sign(?:ed)? ?in|api[ _-]?key|unauthori[sz]ed|authenticat|oauth|credential/i;

/** The failure of a run the agent ended with `error`, in plain words. */
function runFailure(label: string, error: string, model: string | undefined): { reason: AgentTestFailure; message: string } {
  if (SIGN_IN_WORDS.test(error)) return { reason: 'not-signed-in', message: `${label} is not signed in: ${error}` };
  if (model && /model/i.test(error)) {
    return { reason: 'unknown-model', message: `${label} cannot run the model ${JSON.stringify(model)}: ${error}` };
  }
  return { reason: 'failed', message: `${label} failed: ${error}` };
}

/**
 * Runs the test once on the adapter with the settings' model, effort,
 * account label and timeout: the agent is probed first and never run when
 * it cannot be locked down, and the one run is never retried.
 */
export async function testAgent(adapter: AgentAdapter, name: AgentName, settings: AgentSettings): Promise<AgentTestResult> {
  const label = AGENT_LABELS[name];
  const withAccount = (stamp: AgentStamp): AgentStamp => (settings.account ? { ...stamp, account: settings.account } : stamp);
  const probe = await adapter.probe();
  if (!probe.usable) {
    const stamp: AgentStamp = {
      agent: probe.agent,
      agentVersion: probe.version,
      model: null,
      effort: null,
      ...(probe.login ? { login: probe.login } : {}),
      runAt: new Date().toISOString(),
    };
    const message = probe.reason ?? `${label} cannot run with the companion's lockdown`;
    return { ok: false, reason: 'unusable', message, stamp: withAccount(stamp) };
  }
  const root = await mkdtemp(join(tmpdir(), 'second-look-agent-test-'));
  try {
    await chmod(root, 0o555);
    const outcome = await adapter.run({
      root,
      instructions: AGENT_TEST_INSTRUCTIONS,
      prompt: AGENT_TEST_PROMPT,
      schema: AGENT_TEST_SCHEMA,
      timeoutMs: settings.timeoutMs,
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.effort ? { effort: settings.effort } : {}),
    });
    const stamp = withAccount(outcome.stamp);
    if (outcome.status === 'timeout') {
      const seconds = Math.round(settings.timeoutMs / 1000);
      return { ok: false, reason: 'timeout', message: `${label} did not answer within ${seconds} seconds`, stamp };
    }
    if (outcome.status === 'failed') {
      return { ok: false, ...runFailure(label, outcome.error ?? 'the run ended without an answer', settings.model), stamp };
    }
    const parsed = parseAnswer(outcome.text);
    const problems = 'error' in parsed ? [parsed.error] : validateJson(parsed.value, AGENT_TEST_SCHEMA);
    if (problems.length > 0) {
      const message = `${label} answered, but not with the JSON the test asks for: ${problems.join('; ')}`;
      return { ok: false, reason: 'invalid-answer', message, stamp };
    }
    return { ok: true, stamp };
  } finally {
    await removeCopy(root);
  }
}

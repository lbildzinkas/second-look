import {
  DEFAULT_AGENT_SETTINGS,
  runAgentTasks,
  type AgentAdapter,
  type AgentProbe,
  type AgentResult,
  type AgentSettings,
} from './agent.js';
import { ensureCopy } from './cache.js';
import { GitHubClient, parsePullRequestUrl } from './github.js';
import type { JsonSchema } from './json-schema.js';
import type { ChangeCopy } from './protocol.js';
import { UNTRUSTED_INPUT_RULE, untrustedBlock } from './untrusted.js';

/**
 * The answer the probe asks for. The probe's prompt is fixed: it checks
 * the agent's setup and lockdown, never reviews anything, and the contract
 * tests use it. Review prompts, such as grouping, land with their
 * evaluation (ADR 0006).
 */
export const PROBE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'outcome', 'lines', 'detail'],
  properties: {
    target: { type: 'string' },
    outcome: { enum: ['read', 'refused', 'missing'] },
    lines: { type: ['integer', 'null'] },
    detail: { type: 'string' },
  },
};

/** The probe's system prompt: the agent's setting and the answer's schema. */
export const PROBE_INSTRUCTIONS = [
  'You are the agent of Second Look, a companion that helps a human review a pull request.',
  'Your current folder is a read-only copy of the change. You can only use file-reading tools on it:',
  'you have no shell and no network.',
  UNTRUSTED_INPUT_RULE,
  'This is a probe of your setup, not a review. Try to read the target you are given, once, with your',
  'tools (ls for a folder), and report what happened: "read" when the tool returned content, "refused"',
  'when the call was blocked or refused, "missing" when the tool found no such file. Give the number of',
  'lines read or entries listed, or null when nothing was read, and the tool\'s message in one line as',
  'the detail. Never guess, and never repeat the content you read.',
  'Answer with only one JSON value and no other text, matching this JSON schema:',
  JSON.stringify(PROBE_SCHEMA),
].join('\n');

/** The probe's task for one target, with the pull request's own text marked as untrusted. */
export function probePrompt(
  target: string,
  pullRequest: { title: string; description: string },
  blockId?: string,
): string {
  return [
    `Try to read this target: ${JSON.stringify(target)}`,
    '',
    'The pull request under review, for context only:',
    untrustedBlock('pull request title', pullRequest.title, blockId),
    untrustedBlock('pull request description', pullRequest.description, blockId),
  ].join('\n');
}

/** Version of the probe report's shape. */
export const AGENT_PROBE_VERSION = 1 as const;

/** What the agent probe prints. */
export interface AgentProbeReport {
  version: typeof AGENT_PROBE_VERSION;
  pullRequest: { url: string; number: number; headSha: string };
  /** The read-only head copy the agent worked in. */
  copy: ChangeCopy;
  agent: AgentProbe;
  /** One result per target, in order, each stamped. */
  results: (AgentResult & { target: string })[];
}

export interface AgentProbeOptions {
  /** GitHub token for fetching the pull request; it never reaches the agent. */
  token: string;
  fetch?: typeof fetch;
  cacheDir: string;
  adapter: AgentAdapter;
  /** Paths or URLs the agent is asked to read; `.`, the copy's root, by default. */
  targets?: readonly string[];
  settings?: AgentSettings;
}

/**
 * Runs the agent probe on a pull request: takes the read-only head copy,
 * then asks the agent, locked down, to read each target and report what
 * happened. A credential path or a URL must come back refused: the
 * companion's guard refuses them for every agent (docs/agent-safety.md
 * names this probe as the way to check a setup).
 */
export async function runAgentProbe(url: string, options: AgentProbeOptions): Promise<AgentProbeReport> {
  const ref = parsePullRequestUrl(url);
  if (!ref) {
    throw new Error(
      `not a GitHub pull request URL: ${url}\n` +
        'expected the form https://github.com/{owner}/{repo}/pull/{number}',
    );
  }
  const client = new GitHubClient({ token: options.token, fetch: options.fetch });
  const pullRequest = await client.getPullRequestSummary(ref);
  const copy = await ensureCopy({
    cacheDir: options.cacheDir,
    ref,
    commit: pullRequest.headSha,
    download: (wanted) => client.downloadTarball(ref, wanted),
  });
  const targets = options.targets && options.targets.length > 0 ? options.targets : ['.'];
  const { probe, results } = await runAgentTasks(
    options.adapter,
    targets.map((target) => ({
      root: copy.path,
      instructions: PROBE_INSTRUCTIONS,
      prompt: probePrompt(target, pullRequest),
      schema: PROBE_SCHEMA,
    })),
    options.settings ?? DEFAULT_AGENT_SETTINGS,
  );
  return {
    version: AGENT_PROBE_VERSION,
    pullRequest: { url: pullRequest.url, number: pullRequest.number, headSha: pullRequest.headSha },
    copy,
    agent: probe,
    results: results.map((result, index) => ({ target: targets[index]!, ...result })),
  };
}

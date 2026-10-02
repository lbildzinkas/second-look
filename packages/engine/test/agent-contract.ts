import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_SETTINGS,
  runAgentTasks,
  type AgentAdapter,
  type AgentSettings,
  type AgentTask,
} from '../src/agent.js';
import type { JsonSchema } from '../src/json-schema.js';

/** One scripted run of a fake agent executable. */
export interface ContractRun {
  /** The final answer text. */
  text?: string;
  /** Write `partial`, then never finish. */
  hang?: boolean;
  partial?: string;
  /** End the run with this model error. */
  error?: string;
  /** Wait this long before answering. */
  delayMs?: number;
  model?: string;
  effort?: string;
}

export interface ContractScenario {
  version?: string;
  /** The installed version lacks part of the lockdown. */
  lacksLockdown?: boolean;
  /** No agent executable is installed. */
  notInstalled?: boolean;
  runs: ContractRun[];
}

/** What the fake recorded about one run. */
export interface RecordedRun {
  prompt: string;
  cwd: string;
  env: Record<string, string>;
  at: number;
}

/** A fake agent executable, driven through the adapter under test. */
export interface ContractAgent {
  adapter: AgentAdapter;
  /** The runs the fake executable saw, in start order. */
  runs(): RecordedRun[];
  /** When each finished run ended, in end order. */
  ends(): number[];
}

/** Environment the contract gives the engine: a GitHub login and the agent's own. */
export const ENGINE_GITHUB_TOKEN = 'ghp_contract-token-must-not-reach-the-agent';
export const AGENT_OWN_LOGIN = 'the-agent-own-login';

const SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict'],
  properties: { verdict: { enum: ['yes', 'no'] } },
};

function task(root: string, prompt = 'Is this a fixed probe? Answer yes or no.'): AgentTask {
  return { root, instructions: 'Fixed contract instructions.', prompt, schema: SCHEMA };
}

const FAST: AgentSettings = { ...DEFAULT_AGENT_SETTINGS, timeoutMs: 10_000 };

/**
 * The contract every agent adapter must pass, run against a fake agent
 * executable: probing, schema-checked answers with one retry, the stamp,
 * timeouts that keep partial results, the concurrency limit, and the
 * GitHub login kept from the agent while its own login passes untouched.
 */
export function describeAgentContract(name: string, start: (scenario: ContractScenario) => ContractAgent): void {
  describe(`${name} adapter contract`, () => {
    const root = mkdtempSync(join(tmpdir(), 'second-look-contract-copy-'));

    it('probes the installed version and the lockdown it offers', async () => {
      const agent = start({ version: '1.2.3', runs: [{ text: '{"verdict":"yes"}' }] });
      const probe = await agent.adapter.probe();
      expect(probe).toMatchObject({ agent: agent.adapter.agent, version: '1.2.3', usable: true });
      expect(probe.lockdown.length).toBeGreaterThan(0);
    });

    it('returns a schema-valid answer stamped with agent, version, model, effort, date, tokens and cost', async () => {
      const agent = start({
        version: '1.2.3',
        runs: [{ text: '{"verdict":"yes"}', model: 'model-a', effort: 'high' }],
      });
      const before = Date.now();
      const { results } = await runAgentTasks(agent.adapter, [task(root)], FAST);
      expect(results).toHaveLength(1);
      const result = results[0]!;
      expect(result).toMatchObject({ ok: true, answer: { verdict: 'yes' }, attempts: 1 });
      const stamp = result.stamp;
      expect(stamp.agent).toBe(agent.adapter.agent);
      expect(stamp.agentVersion).toBe('1.2.3');
      expect(stamp.model).toContain('model-a');
      expect(stamp.effort).toBe('high');
      expect(Date.parse(stamp.runAt)).toBeGreaterThanOrEqual(before - 1000);
      expect(stamp.tokens).toMatchObject({ input: 100, output: 20, total: 125 });
      expect(stamp.costUsd).toBeCloseTo(0.01);
    });

    it('runs the agent in the read-only copy with the prompt it was given', async () => {
      const agent = start({ runs: [{ text: '{"verdict":"no"}' }] });
      await runAgentTasks(agent.adapter, [task(root, 'The one fixed prompt.')], FAST);
      const [run] = agent.runs();
      expect(run!.prompt).toBe('The one fixed prompt.');
      expect(realpathSync(run!.cwd)).toBe(realpathSync(root));
    });

    it('retries an invalid answer once, telling the agent why', async () => {
      const agent = start({ runs: [{ text: '{"verdict":"maybe"}' }, { text: '{"verdict":"no"}' }] });
      const { results } = await runAgentTasks(agent.adapter, [task(root)], FAST);
      expect(results[0]).toMatchObject({ ok: true, answer: { verdict: 'no' }, attempts: 2 });
      expect(results[0]!.stamp.tokens!.total).toBe(250);
      const runs = agent.runs();
      expect(runs).toHaveLength(2);
      expect(runs[1]!.prompt).toContain('/verdict should be one of "yes", "no"');
    });

    it('reports a failure after the second invalid answer, never a guess', async () => {
      const agent = start({
        runs: [{ text: 'I think {"verdict":"yes"}' }, { text: '{"verdict":"yes","extra":1}' }],
      });
      const { results } = await runAgentTasks(agent.adapter, [task(root)], FAST);
      expect(results[0]).toMatchObject({ ok: false, reason: 'invalid-answer', attempts: 2 });
      expect(results[0]).not.toHaveProperty('answer');
      expect(results[0]!.stamp).toBeDefined();
      expect(agent.runs()).toHaveLength(2);
    });

    it('reports an agent error as a failure with its message', async () => {
      const agent = start({ runs: [{ error: 'rate limited' }] });
      const { results } = await runAgentTasks(agent.adapter, [task(root)], FAST);
      expect(results[0]).toMatchObject({ ok: false, reason: 'agent-failed', attempts: 1 });
      expect(results[0]!.ok === false && results[0]!.message).toContain('rate limited');
    });

    it('stops a run at its timeout and keeps what it wrote, while other tasks finish', async () => {
      const agent = start({ runs: [{ hang: true, partial: '{"verd' }, { text: '{"verdict":"yes"}' }] });
      const { results } = await runAgentTasks(agent.adapter, [task(root), task(root)], {
        ...DEFAULT_AGENT_SETTINGS,
        timeoutMs: 1500,
        concurrency: 1,
      });
      expect(results[0]).toMatchObject({ ok: false, reason: 'timeout', partial: '{"verd', attempts: 1 });
      expect(results[0]!.stamp.agent).toBe(agent.adapter.agent);
      expect(results[1]).toMatchObject({ ok: true, answer: { verdict: 'yes' } });
    });

    it('stamps no model when the run ends before the agent names one', async () => {
      const agent = start({ runs: [{ hang: true, partial: '{"verd' }] });
      const { results } = await runAgentTasks(agent.adapter, [task(root)], {
        ...DEFAULT_AGENT_SETTINGS,
        timeoutMs: 1500,
        model: 'asked-for/model',
      });
      expect(results[0]).toMatchObject({ ok: false, reason: 'timeout' });
      expect(results[0]!.stamp.model).toBeNull();
    });

    it('runs at most the configured number of agents at once', async () => {
      const agent = start({ runs: [{ text: '{"verdict":"yes"}', delayMs: 400 }] });
      const tasks = [task(root), task(root), task(root), task(root), task(root)];
      const { results } = await runAgentTasks(agent.adapter, tasks, { ...FAST, concurrency: 2 });
      expect(results.every((result) => result.ok)).toBe(true);
      const starts = agent.runs().map((run) => run.at);
      const ends = agent.ends();
      const busiest = Math.max(...starts.map((at) => starts.filter((s) => s <= at).length - ends.filter((e) => e <= at).length));
      expect(busiest).toBeLessThanOrEqual(2);
      expect(busiest).toBe(2);
    });

    it('keeps the GitHub login from the agent and leaves the agent its own', async () => {
      const agent = start({ runs: [{ text: '{"verdict":"yes"}' }] });
      await runAgentTasks(agent.adapter, [task(root)], FAST);
      const [run] = agent.runs();
      expect(run!.env['GITHUB_TOKEN']).toBeUndefined();
      expect(run!.env['GH_TOKEN']).toBeUndefined();
      expect(JSON.stringify(run)).not.toContain(ENGINE_GITHUB_TOKEN);
      expect(run!.env['FAKE_AGENT_LOGIN']).toBe(AGENT_OWN_LOGIN);
    });

    it('never runs an agent that lacks part of the lockdown', async () => {
      const agent = start({ lacksLockdown: true, runs: [{ text: '{"verdict":"yes"}' }] });
      const { probe, results } = await runAgentTasks(agent.adapter, [task(root)], FAST);
      expect(probe.usable).toBe(false);
      expect(probe.reason).toMatch(/lockdown/);
      expect(results[0]).toMatchObject({ ok: false, reason: 'unusable', attempts: 0 });
      expect(results[0]!.stamp).toMatchObject({ agent: agent.adapter.agent, model: null, effort: null });
      expect(agent.runs()).toHaveLength(0);
    });

    it('says plainly when the agent is not installed', async () => {
      const agent = start({ notInstalled: true, runs: [{ text: '{"verdict":"yes"}' }] });
      const { probe, results } = await runAgentTasks(agent.adapter, [task(root)], FAST);
      expect(probe).toMatchObject({ usable: false, version: '' });
      expect(probe.reason).toMatch(/could not be started/);
      expect(results[0]).toMatchObject({ ok: false, reason: 'unusable' });
    });
  });
}

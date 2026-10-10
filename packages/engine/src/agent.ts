/**
 * The agent adapter interface (ADR 0004): how the engine runs the coding
 * agent the reviewer already has installed — Pi and Claude Code today —
 * non-interactively, with the companion's own prompt and a JSON schema for
 * the answer.
 *
 * An adapter does two things:
 *
 * - **probe** asks the installed agent its version and what it supports,
 *   and says whether it can be run with the companion's lockdown at all.
 *   An agent that lacks any part of the lockdown is never run.
 * - **run** starts the agent once on a read-only copy of the change and
 *   returns its final text with the stamp of that run.
 *
 * Every run is locked down by the strongest mechanism the agent offers:
 * file-reading tools only, so no shell and no network; the agent's own
 * settings, extensions and context files from the pull request switched
 * off; every path confined to the read-only copy, with credential paths
 * (SSH keys, cloud credentials, the GitHub login) refused by name — by
 * the companion's guard, inside Pi's process as an extension and before
 * every Claude Code tool call as a hook (see docs/agent-safety.md). The
 * agent signs in with its own login: the companion never reads or stores
 * it, and the GitHub token the engine holds never reaches the agent —
 * {@link GITHUB_TOKEN_VARIABLES} names the variables every adapter strips.
 *
 * {@link runAgentTasks} sits on top of any adapter: it checks each answer
 * against its schema and the task's own check, retries an invalid answer
 * once and then reports the failure — it never guesses an answer — and
 * runs tasks at most
 * `concurrency` at a time, each under its own timeout, keeping whatever
 * finished when another task times out. On a budget that stops the runs,
 * a task, or its retry, starts only while an agent run is left.
 */
import { countAgentRun, hasAgentRunLeft, limitReason, type BudgetMeter } from './budget.js';
import { validateJson, type JsonSchema } from './json-schema.js';

/** What a probe learned about the installed agent. */
export interface AgentProbe {
  /** The adapter's agent, such as `pi`. */
  agent: string;
  /** The installed version, as the agent reports it; empty when it could not be read. */
  version: string;
  /** True when every part of the lockdown is available, so the agent may run. */
  usable: boolean;
  /** Why the agent cannot run, when it is not usable. */
  reason?: string;
  /** Optional features this version supports. */
  supports: {
    /** The agent takes an effort (thinking) level. */
    effort: boolean;
  };
  /** The lockdown mechanisms this run will use, strongest first, for the reader to check. */
  lockdown: string[];
}

/** One run of the agent. */
export interface AgentRunRequest {
  /** The read-only copy the agent works in; the only folder it may read. */
  root: string;
  /** The companion's own instructions, including the answer's schema. */
  instructions: string;
  /** The task, with any untrusted text already cleaned and marked as such. */
  prompt: string;
  /**
   * The schema the answer must meet. Claude Code enforces it through its
   * own `--json-schema` flag; Pi's instructions embed it, so Pi's adapter
   * does not read it.
   */
  schema?: JsonSchema;
  /** The model to use; the agent's own default when absent. */
  model?: string;
  /** The effort level to ask for; the agent's own default when absent. */
  effort?: string;
  /** The run is stopped after this many milliseconds. */
  timeoutMs: number;
}

/** Tokens a run used, as the agent reports them. */
export interface AgentTokens {
  input: number;
  output: number;
  /** Prompt tokens read from or written to the provider's cache. */
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/**
 * Which login a run signed in with, as the companion can tell without ever
 * reading the login itself.
 */
export interface AgentLogin {
  /** Where the login came from, in plain words. */
  source: string;
  /** A warning that this login silently overrides another. */
  warning?: string;
}

/**
 * Who answered and at what cost: stamped on every result, successful or
 * not, so the reviewer can always tell which agent, model and effort
 * said what.
 */
export interface AgentStamp {
  agent: string;
  agentVersion: string;
  /** `provider/model` as the agent reports it; null when the run ended before saying. */
  model: string | null;
  /** The effort level the agent reports, else the one asked for; null when neither is known. */
  effort: string | null;
  /** Which login the run used, when the adapter can tell; the companion never reads the login itself. */
  login?: AgentLogin;
  /**
   * The reviewer's label for the account or subscription this run bills,
   * when the settings gave one; the companion never reads the login
   * itself, so the label is only what the reviewer told it.
   */
  account?: string;
  /** When the run started, as an ISO 8601 time. */
  runAt: string;
  /** Tokens used, when the agent reports them. */
  tokens?: AgentTokens;
  /** Cost in US dollars, when the agent reports it. */
  costUsd?: number;
}

/** What one run produced. */
export interface AgentRunOutcome {
  /** `completed` when the agent finished; `timeout` and `failed` keep whatever it wrote. */
  status: 'completed' | 'timeout' | 'failed';
  /** The final text, or the text written so far when the run did not complete. */
  text: string;
  /** Why the run failed, when it did. */
  error?: string;
  stamp: AgentStamp;
}

/** Runs one installed coding agent; see the module comment for the contract. */
export interface AgentAdapter {
  /** The agent's name, such as `pi`. */
  readonly agent: string;
  probe(): Promise<AgentProbe>;
  run(request: AgentRunRequest): Promise<AgentRunOutcome>;
}

/**
 * Environment variables that carry the GitHub login. Every adapter removes
 * them from the agent's environment, so the token the engine holds never
 * reaches the agent.
 */
export const GITHUB_TOKEN_VARIABLES = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
] as const;

/**
 * What the companion asks each agent run for, and how its runs are paced:
 * settings, with {@link DEFAULT_AGENT_SETTINGS}.
 */
export interface AgentSettings {
  /** Each run is stopped after this many milliseconds. */
  timeoutMs: number;
  /** At most this many agent runs at once. */
  concurrency: number;
  model?: string;
  effort?: string;
  /**
   * The reviewer's label for the account or subscription each run bills,
   * stamped on every result; empty or absent stamps nothing.
   */
  account?: string;
  /** The review's budget meter, which counts every run started, a retry included; absent counts nothing. */
  budget?: BudgetMeter;
  /**
   * True when the meter's agent-run limit stops the runs: a task starts,
   * and its retry, only while a run is left, else it fails saying so. The
   * review's stages stop; the reviewer's asks and drafts only count.
   */
  stopAtBudget?: boolean;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  timeoutMs: 5 * 60 * 1000,
  concurrency: 2,
};

/**
 * How long one agent stage of a review, such as grouping or ranking, may
 * take: the agent's probe, and the run with its one retry, each under the
 * agent's timeout.
 */
export function agentStageTimeoutMs(settings: AgentSettings): number {
  return 2 * settings.timeoutMs + 60_000;
}

/** One question for the agent, with the schema its answer must meet. */
export interface AgentTask {
  /** The read-only copy the agent works in. */
  root: string;
  instructions: string;
  prompt: string;
  schema: JsonSchema;
  /**
   * Checks a schema-valid answer further, such as that every id it names
   * was offered, or that every line it cites is in the copy; returns the
   * problems, which count like schema problems.
   */
  check?: (answer: unknown) => string[] | Promise<string[]>;
}

/** Why a task produced no answer; `budget-limit` when the agent-run limit kept a run, or its retry, from starting. */
export type AgentFailureReason = 'unusable' | 'timeout' | 'agent-failed' | 'invalid-answer' | 'budget-limit';

/** A task's result: a schema-valid answer, or a failure that says why; always stamped. */
export type AgentResult =
  | { ok: true; answer: unknown; attempts: number; stamp: AgentStamp }
  | {
      ok: false;
      reason: AgentFailureReason;
      message: string;
      attempts: number;
      /** What the agent wrote before the run ended, kept for the reader; never used as an answer. */
      partial?: string;
      stamp: AgentStamp;
    };

/**
 * Why what a task was to settle is left not checked, naming the limit,
 * when the agent-run limit kept the task or its retry from running;
 * undefined when it ran or failed otherwise.
 */
export function agentRunLimitReason(result: AgentResult, settings: AgentSettings, toDo: string): string | undefined {
  if (result.ok || result.reason !== 'budget-limit' || settings.budget === undefined) return undefined;
  return limitReason(settings.budget, 'agentRuns', toDo);
}

/**
 * Reads an answer: the whole text must be one JSON value, optionally inside
 * a single fenced code block. Anything else is not an answer.
 */
export function parseAnswer(text: string): { value: unknown } | { error: string } {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text.trim());
  const body = fenced ? fenced[1]! : text.trim();
  try {
    return { value: JSON.parse(body) as unknown };
  } catch {
    return { error: 'the answer is not a single JSON value' };
  }
}

/** Adds up two runs' tokens and cost, so a retried task's stamp counts both. */
function combineStamps(earlier: AgentStamp, later: AgentStamp): AgentStamp {
  const tokens =
    earlier.tokens && later.tokens
      ? {
          input: earlier.tokens.input + later.tokens.input,
          output: earlier.tokens.output + later.tokens.output,
          cacheRead: earlier.tokens.cacheRead + later.tokens.cacheRead,
          cacheWrite: earlier.tokens.cacheWrite + later.tokens.cacheWrite,
          total: earlier.tokens.total + later.tokens.total,
        }
      : (later.tokens ?? earlier.tokens);
  const costUsd =
    earlier.costUsd !== undefined && later.costUsd !== undefined
      ? earlier.costUsd + later.costUsd
      : (later.costUsd ?? earlier.costUsd);
  return {
    ...later,
    runAt: earlier.runAt,
    ...(tokens ? { tokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

const RETRY_NOTE =
  'Your previous answer was rejected because it did not meet the schema and rules:';

/** Stamps the reviewer's account label, when the settings gave one, on a run's stamp. */
function withAccount(stamp: AgentStamp, account: string | undefined): AgentStamp {
  return account ? { ...stamp, account } : stamp;
}

/** The stamp of a task the agent never ran, from what its probe learned. */
function probeStamp(probe: AgentProbe, account: string | undefined): AgentStamp {
  return withAccount(
    { agent: probe.agent, agentVersion: probe.version, model: null, effort: null, runAt: new Date().toISOString() },
    account,
  );
}

async function runTask(
  adapter: AgentAdapter,
  task: AgentTask,
  settings: AgentSettings,
  probe: AgentProbe,
): Promise<AgentResult> {
  let stamp: AgentStamp | undefined;
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const meter = settings.budget;
    if (meter && settings.stopAtBudget && !hasAgentRunLeft(meter)) {
      const message =
        attempt === 1
          ? `the agent was not run: ${limitReason(meter, 'agentRuns', 'run it')}`
          : `the answer was invalid (${problems.join('; ')}) and was not retried: ${limitReason(meter, 'agentRuns', 'retry it')}`;
      return { ok: false, reason: 'budget-limit', message, attempts: attempt - 1, stamp: stamp ?? probeStamp(probe, settings.account) };
    }
    const prompt =
      attempt === 1
        ? task.prompt
        : `${task.prompt}\n\n${RETRY_NOTE}\n- ${problems.join('\n- ')}\nAnswer again with only the JSON value.`;
    if (meter) countAgentRun(meter);
    const outcome = await adapter.run({
      root: task.root,
      instructions: task.instructions,
      prompt,
      schema: task.schema,
      timeoutMs: settings.timeoutMs,
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.effort ? { effort: settings.effort } : {}),
    });
    const current = stamp
      ? combineStamps(stamp, withAccount(outcome.stamp, settings.account))
      : withAccount(outcome.stamp, settings.account);
    stamp = current;
    if (outcome.status !== 'completed') {
      return {
        ok: false,
        reason: outcome.status === 'timeout' ? 'timeout' : 'agent-failed',
        message:
          outcome.status === 'timeout'
            ? `the agent did not finish within ${settings.timeoutMs} ms`
            : (outcome.error ?? 'the agent failed'),
        attempts: attempt,
        partial: outcome.text,
        stamp: current,
      };
    }
    const parsed = parseAnswer(outcome.text);
    problems = 'error' in parsed ? [parsed.error] : validateJson(parsed.value, task.schema);
    if ('value' in parsed && problems.length === 0 && task.check) problems = await task.check(parsed.value);
    if ('value' in parsed && problems.length === 0) {
      return { ok: true, answer: parsed.value, attempts: attempt, stamp: current };
    }
  }
  return {
    ok: false,
    reason: 'invalid-answer',
    message: `the answer was invalid twice: ${problems.join('; ')}`,
    attempts: 2,
    stamp: stamp!,
  };
}

/**
 * Runs each task on the agent, at most `settings.concurrency` at once,
 * and returns their results in the tasks' order. The agent is probed
 * first; when it cannot run with the lockdown, no task runs and each
 * result says why. A task that times out or fails does not stop the
 * others, so every finished answer is kept.
 */
export async function runAgentTasks(
  adapter: AgentAdapter,
  tasks: readonly AgentTask[],
  settings: AgentSettings = DEFAULT_AGENT_SETTINGS,
): Promise<{ probe: AgentProbe; results: AgentResult[] }> {
  const probe = await adapter.probe();
  if (!probe.usable) {
    const message = probe.reason ?? `${probe.agent} cannot run with the companion's lockdown`;
    const stamp = probeStamp(probe, settings.account);
    return {
      probe,
      results: tasks.map(() => ({ ok: false, reason: 'unusable', message, attempts: 0, stamp })),
    };
  }
  const results: AgentResult[] = new Array(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await runTask(adapter, tasks[index]!, settings, probe);
    }
  };
  const workers = Math.max(1, Math.min(settings.concurrency, tasks.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return { probe, results };
}

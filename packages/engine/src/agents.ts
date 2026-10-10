import type { AgentAdapter } from './agent.js';
import { claudeCodeAdapter, type ClaudeCodeAdapterOptions } from './claude-code.js';
import { piAdapter, type PiAdapterOptions } from './pi.js';

/**
 * The adapters the companion can drive, chosen by name (ADR 0004). The
 * engine's settings name one — Pi or Claude Code today — and VS Code's
 * settings offer the same names, so the reviewer switches agents in one
 * place and every result's stamp says which one answered. An adapter for a
 * name that is not installed, or a version too old for the lockdown, is
 * never run: its probe says so in plain words.
 */

/** The agents the companion can drive, in the order the settings offer them. */
export const AGENT_NAMES = ['pi', 'claude-code'] as const;

/** One of {@link AGENT_NAMES}. */
export type AgentName = (typeof AGENT_NAMES)[number];

/** The options each adapter reads; tests point them at a fake agent. */
export interface AgentAdapterOptions {
  /** How the engine starts Pi; `['pi']` by default. */
  pi?: Pick<PiAdapterOptions, 'command' | 'guardPath'>;
  /** How the engine starts Claude Code; `['claude']` by default. */
  claudeCode?: Pick<ClaudeCodeAdapterOptions, 'command' | 'guardPath'>;
  /** The engine's environment, which the agent inherits minus the GitHub login. */
  env?: NodeJS.ProcessEnv;
}

/** True when `value` names an adapter the companion can drive. */
export function isAgentName(value: string): value is AgentName {
  return (AGENT_NAMES as readonly string[]).includes(value);
}

/**
 * The effort levels each agent accepts, as its own help lists them:
 * Claude Code's `--effort` and Pi's `--thinking`.
 */
export const AGENT_EFFORT_LEVELS: Record<AgentName, readonly string[]> = {
  pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'claude-code': ['low', 'medium', 'high', 'xhigh', 'max'],
};

/** A plain identifier: letters, digits, `.`, `_`, `-`, `/` and `:`, never starting with `-`. */
const PLAIN_IDENTIFIER = /^[A-Za-z0-9._/:][A-Za-z0-9._/:-]*$/;

/**
 * Why a model or effort cannot reach the agent's command line, in plain
 * words; absent when both can. Each value lands as the argument of a
 * flag, so only a plain identifier is passed — never one that starts
 * with `-` and reads as another flag — and the effort must be one of the
 * levels the agent accepts. An empty or absent value asks for the
 * agent's own default and is always fine.
 */
export function modelAndEffortProblem(
  agent: AgentName,
  choice: { model?: string; effort?: string },
): string | undefined {
  const { model, effort } = choice;
  const plain = 'use only letters, digits and . _ - / :, not starting with -';
  if (model && !PLAIN_IDENTIFIER.test(model)) return `the model ${JSON.stringify(model)} is not a plain name: ${plain}`;
  if (!effort) return undefined;
  if (!PLAIN_IDENTIFIER.test(effort)) return `the effort ${JSON.stringify(effort)} is not a plain level: ${plain}`;
  const levels = AGENT_EFFORT_LEVELS[agent];
  if (!levels.includes(effort)) {
    return `${agent} does not accept the effort ${JSON.stringify(effort)}: choose ${levels.join(', ')}, or leave it empty for the agent's own default`;
  }
  return undefined;
}

/**
 * Starts the named agent's adapter. An unknown name throws a plain error
 * naming the choices, so a typo never silently picks another agent.
 */
export function agentAdapter(name: string, options: AgentAdapterOptions = {}): AgentAdapter {
  if (name === 'pi') return piAdapter({ ...options.pi, env: options.env });
  if (name === 'claude-code') return claudeCodeAdapter({ ...options.claudeCode, env: options.env });
  throw new Error(`unknown agent "${name}": choose ${AGENT_NAMES.join(' or ')}`);
}

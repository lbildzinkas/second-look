import type { AgentAdapter } from './agent.js';
import { claudeCodeAdapter, type ClaudeCodeAdapterOptions } from './claude-code.js';
import { piAdapter, type PiAdapterOptions } from './pi.js';

/**
 * The adapters the companion can drive, chosen by name (ADR 0004). The
 * engine's settings name one — Pi or Claude Code today — and VS Code's
 * settings offer the same names, so the reviewer switches agents in one
 * place and every result's stamp says which one answered. An adapter for a
 * name that is not installed, or a version too old for the lockdown, is
 * never run: its probe says so in plain words. The reviewer's path setting
 * for an agent, when it names one, replaces the command the adapter starts.
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
 * Starts the named agent's adapter, running the executable at `path` in
 * place of its command when a path is given. An unknown name throws a
 * plain error naming the choices, so a typo never silently picks another
 * agent.
 */
export function agentAdapter(name: string, options: AgentAdapterOptions = {}, path?: string): AgentAdapter {
  const command = path ? { command: [path] } : {};
  if (name === 'pi') return piAdapter({ ...options.pi, ...command, env: options.env });
  if (name === 'claude-code') return claudeCodeAdapter({ ...options.claudeCode, ...command, env: options.env });
  throw new Error(`unknown agent "${name}": choose ${AGENT_NAMES.join(' or ')}`);
}

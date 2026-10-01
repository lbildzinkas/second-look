# Drive the reviewer's installed agent CLIs

The companion does its model work by calling the coding agents the reviewer already has installed (Claude Code, Pi, Codex) non-interactively, with the companion's own prompts and skills, behind one adapter interface that probes each tool's version for what it supports. It does not call model APIs directly or embed an agent SDK, so it reuses agents that are already good, runs on the reviewer's own subscriptions, and never handles tokens.

## Considered Options

- Anthropic's Agent SDK: rejected, it steers products towards API keys and ties the companion to one vendor.
- The Agent Client Protocol: rejected for now, it has no structured final answer.
- Direct model API calls with a home-grown agent loop: rejected, it rebuilds what the agents already do well and needs keys.

## Consequences

Anthropic's terms are unclear on third-party tools driving a user's own Claude Code; this will be disclosed in the README.

import type { AgentAdapter, AgentSettings, AgentStamp } from './agent.js';
import { EXPLAIN_PROMPT_ID, explainPart } from './explain.js';
import type { AskAnswer, AskSection, PartCitation, ReviewResult } from './protocol.js';

/**
 * The asks (the glossary's ask): fixed, typed requests the reviewer makes
 * about one part, answered by the agent with the answer's stamp; no free
 * chat. Every ask is defined here and only here, in {@link ASKS}: the
 * words the part's context menu shows, the prompt that answers it, which
 * lands with its evaluation cases (ADR 0006), and the sections its answer
 * reads as in the panel. The protocol's `ask` request names an ask by its
 * kind, and the extension offers one context-menu command per kind.
 */

/** What an ask is answered from: one part of the engine's latest review, and the agent that answers. */
export interface AskContext {
  result: ReviewResult;
  /** The part asked about, by its index in the result's parts. */
  part: number;
  adapter: AgentAdapter;
  settings?: AgentSettings;
}

/** An ask's reply: its sections and the checked lines they cite, or why there is none; always stamped. */
export type AskReply =
  | { outcome: 'answered'; sections: AskSection[]; cited: PartCitation[]; promptVersion: string; stamp: AgentStamp }
  | { outcome: 'fell back'; detail: string; promptVersion: string; stamp: AgentStamp };

/** One ask: the words its menu entry shows, the prompt behind it, and how it is answered. */
export interface AskDefinition {
  /** The words the part's context menu shows, such as "Explain this part". */
  title: string;
  /** The prompt's id in the evaluation's prompt registry. */
  promptId: string;
  answer: (context: AskContext) => Promise<AskReply>;
}

/** Every ask, by its kind: add a new ask here. */
export const ASKS = {
  explain: {
    title: 'Explain this part',
    promptId: EXPLAIN_PROMPT_ID,
    answer: async ({ result, part, adapter, settings }) => {
      const explained = await explainPart(result.parts, part, {
        adapter,
        ...(settings ? { settings } : {}),
        root: result.copies.head.path,
        pullRequest: result.pullRequest,
      });
      const { promptVersion, stamp } = explained;
      if (explained.answer === undefined) return { outcome: 'fell back', detail: explained.detail, promptVersion, stamp };
      const sections = [
        { heading: 'What it does', text: explained.answer.does.trim() },
        { heading: 'Why it matters to the change', text: explained.answer.matters.trim() },
      ];
      return { outcome: 'answered', sections, cited: explained.cited, promptVersion, stamp };
    },
  },
} as const satisfies Record<string, AskDefinition>;

/** An ask's kind, the key it has in {@link ASKS}. */
export type AskKind = keyof typeof ASKS;

/** Every ask's kind, in the order the menu offers them. */
export const ASK_KINDS = Object.keys(ASKS) as AskKind[];

/** True when the value names an ask. */
export function isAskKind(value: unknown): value is AskKind {
  return typeof value === 'string' && (ASK_KINDS as readonly string[]).includes(value);
}

/**
 * Answers one ask about one part of a review result, or throws with the
 * plain reason there is no answer: the part is none of the result's, or
 * the agent gave no answer the checks accepted.
 */
export async function askAboutPart(kind: AskKind, context: AskContext): Promise<AskAnswer> {
  const part = context.result.parts[context.part];
  if (part === undefined) throw new Error(`the review has no part ${context.part}`);
  const reply = await ASKS[kind].answer(context);
  if (reply.outcome === 'fell back') throw new Error(`no answer: ${reply.detail}`);
  const { sections, cited, promptVersion, stamp } = reply;
  return { ask: kind, part: context.part, partName: part.name ?? part.path, sections, cited, promptVersion, stamp };
}

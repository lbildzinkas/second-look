import type { AgentAdapter, AgentSettings, AgentStamp } from './agent.js';
import { COVER_PROMPT_ID, findCoverage } from './cover.js';
import { EXPLAIN_PROMPT_ID, explainPart } from './explain.js';
import type { AskAnswer, AskedClaim, AskSection, Claim, PartCitation, ReviewResult } from './protocol.js';
import { VERDICTS_PROMPT_ID } from './verdicts.js';
import { verifyClaim } from './verify.js';

/**
 * The asks (the glossary's ask): fixed, typed requests the reviewer makes
 * about one part, answered by the agent with the answer's stamp; no free
 * chat. Every ask is defined here and only here, in {@link ASKS}: the
 * words the part's context menu shows, the prompt that answers it, which
 * lands with its evaluation cases (ADR 0006), whether it checks a claim
 * the reviewer picks or selects, and the sections its answer reads as in
 * the panel. The protocol's `ask` request names an ask by its
 * kind, and the extension offers one context-menu command per kind.
 */

/** What an ask is answered from: one part of the engine's latest review, and the agent that answers. */
export interface AskContext {
  result: ReviewResult;
  /** The part asked about, by its index in the result's parts. */
  part: number;
  adapter: AgentAdapter;
  settings?: AgentSettings;
  /** The claim to verify, for an ask that takes one. */
  claim?: AskedClaim;
}

/** An ask's reply: its sections and the checked lines they cite, or why there is none; always stamped. */
export type AskReply =
  | {
      outcome: 'answered';
      sections: AskSection[];
      cited: PartCitation[];
      promptVersion: string;
      stamp: AgentStamp;
      /** The claim a verify ask judged, and its index in the review's claims. */
      claim?: { index: number; claim: Claim };
    }
  | { outcome: 'fell back'; detail: string; promptVersion: string; stamp: AgentStamp };

/** One ask: the words its menu entry shows, the prompt behind it, and how it is answered. */
export interface AskDefinition {
  /** The words the part's context menu shows, such as "Explain this part". */
  title: string;
  /** The prompt's id in the evaluation's prompt registry. */
  promptId: string;
  /** True when the ask checks one claim of the part, which the reviewer picks or selects. */
  takesClaim: boolean;
  answer: (context: AskContext) => Promise<AskReply>;
}

/** Every ask, by its kind: add a new ask here. */
export const ASKS = {
  explain: {
    title: 'Explain this part',
    promptId: EXPLAIN_PROMPT_ID,
    takesClaim: false,
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
  verify: {
    title: 'Verify this claim',
    promptId: VERDICTS_PROMPT_ID,
    takesClaim: true,
    answer: async ({ result, part, adapter, settings, claim }) => {
      if (claim === undefined) throw new Error('select the text to verify in the diff, or pick one of the claims');
      return verifyClaim({ result, part, claim, adapter, ...(settings ? { settings } : {}) });
    },
  },
  cover: {
    title: 'What covers this?',
    promptId: COVER_PROMPT_ID,
    takesClaim: false,
    answer: async ({ result, part, adapter, settings }) => {
      const covered = await findCoverage(result.parts, part, {
        adapter,
        ...(settings ? { settings } : {}),
        root: result.copies.head.path,
        pullRequest: result.pullRequest,
      });
      const { promptVersion, stamp, checks } = covered;
      if (covered.answer === undefined || checks === undefined) return { outcome: 'fell back', detail: covered.detail, promptVersion, stamp };
      // None found is an answer: the summary says so, and where the agent looked.
      const none = checks.tests.length === 0 && checks.manualChecks.length === 0;
      const sections = [{ heading: none ? 'None found' : 'What covers it', text: covered.answer.summary.trim() }];
      if (checks.manualChecks.length > 0) {
        const quoted = checks.manualChecks.map((check) => `"${check.quote}" (the description, line ${check.line})`);
        sections.push({ heading: 'Manual checks the pull request reports', text: quoted.join(' ') });
      }
      const cited = checks.tests.map((each) => ({ path: each.path, side: 'head' as const, line: each.line, quote: each.quote }));
      return { outcome: 'answered', sections, cited, promptVersion, stamp };
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
 * plain reason there is no answer: the part is none of the result's, the
 * claim to verify is none of the part's, or the agent gave no answer the
 * checks accepted.
 */
export async function askAboutPart(kind: AskKind, context: AskContext): Promise<AskAnswer> {
  const part = context.result.parts[context.part];
  if (part === undefined) throw new Error(`the review has no part ${context.part}`);
  const reply: AskReply = await ASKS[kind].answer(context);
  if (reply.outcome === 'fell back') throw new Error(`no answer: ${reply.detail}`);
  const { sections, cited, promptVersion, stamp, claim } = reply;
  return { ask: kind, part: context.part, partName: part.name ?? part.path, sections, cited, promptVersion, stamp, ...(claim ? { claim } : {}) };
}

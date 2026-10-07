import { randomBytes } from 'node:crypto';
import {
  DEFAULT_AGENT_SETTINGS,
  runAgentTasks,
  type AgentAdapter,
  type AgentSettings,
} from './agent.js';
import { docsUrlProblem } from './doc-fetch.js';
import type { JsonSchema } from './json-schema.js';
import type { DocLink, DocSuggestions, LibraryApi } from './protocol.js';
import { UNTRUSTED_INPUT_RULE, untrustedBlock } from './untrusted.js';

/**
 * The doc-links prompt: for the library APIs a change uses that no
 * published inventory linked at the pinned version, the agent suggests
 * the documentation page of each, from what it knows. The agent has no
 * network and the engine never fetches a suggestion: it checks only that
 * each names an API it was asked about and is an https address on a
 * named public host, and the reviewer sees every suggestion labelled as
 * the agent's, after the links an inventory gave. The prompt is
 * versioned like code and lands with its evaluation cases (ADR 0006);
 * bump {@link DOC_LINKS_PROMPT_VERSION}, and its entry in the
 * evaluation's `prompts.json`, whenever the instructions, the prompt or
 * the schema change.
 */

/** The doc-links prompt's id in the evaluation's prompt registry. */
export const DOC_LINKS_PROMPT_ID = 'doc-links';

/** The doc-links prompt's version. */
export const DOC_LINKS_PROMPT_VERSION = '1';

/** The longest address a suggestion may give. */
export const MAX_DOC_URL = 400;

/** The answer the doc-links prompt asks for. */
export const DOC_LINKS_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['links'],
  properties: {
    links: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['api', 'url'],
        properties: {
          api: { type: 'string' },
          url: { type: 'string' },
        },
      },
    },
  },
};

/** An answer that met {@link DOC_LINKS_SCHEMA}: each suggestion names an API by its id. */
export interface DocSuggestionAnswer {
  links: { api: string; url: string }[];
}

const FINAL_ANSWER_RULE =
  'When you have read enough, give your final message as the JSON value alone: start it with { and end it ' +
  'with }, with no summary of what you read before or after it.';

/** The doc-links prompt's system prompt: the agent's setting, the rules and the answer's schema. */
export const DOC_LINKS_INSTRUCTIONS = [
  'You are the agent of Second Look, a companion that helps a human review a pull request.',
  "Your current folder is a read-only copy of the pull request's head version. You can only use",
  'file-reading tools on it: you have no shell and no network.',
  UNTRUSTED_INPUT_RULE,
  'Your task is to suggest where each library API listed is documented, at the version the project',
  "pins. No published inventory of that version linked it, so the reviewer sees your link labelled as",
  'your suggestion, which nothing checked.',
  'Rules:',
  '- api: the id the list gives the API, such as a1.',
  "- url: the https address of the page that documents the API on the library's own documentation",
  '  site or API reference, at the pinned version where the site keeps a page per version, such as a',
  '  path that names the version. For a library with no documentation site, give its source',
  "  repository's page for the API's file or its README at that version's tag. Never a search page, a",
  '  forum, a question site, a blog post or a mirror.',
  '- Suggest a page only when you know it exists; leave an API out when you are not sure. An empty list',
  '  is a valid answer.',
  `- At most one link per API, only for the APIs listed, each under ${MAX_DOC_URL} characters, with no user name,`,
  '  password or port.',
  'Answer with only one JSON value and no other text, no words before or after it, matching this',
  'JSON schema:',
  JSON.stringify(DOC_LINKS_SCHEMA),
  FINAL_ANSWER_RULE,
].join('\n');

/** The id the prompt gives an API: its place in the list, from 1. */
function apiId(index: number): string {
  return `a${index + 1}`;
}

/** The task: the APIs, each with its library, the pinned version and where the change uses it, as untrusted text. */
export function docLinksPrompt(apis: readonly LibraryApi[], blockId?: string): string {
  const id = blockId ?? randomBytes(8).toString('hex');
  const lines = apis.map((api, index) => {
    const used = api.uses.slice(0, 3).map((use) => `${use.path}:${use.line}`).join(', ');
    const library = api.ecosystem === '.NET' ? `.NET at target framework ${api.version}` : `${api.library} ${api.version} from ${api.ecosystem}`;
    return `${apiId(index)}: ${api.api} — ${library}, pinned by ${api.pinnedBy}; used at ${used}`;
  });
  return [
    `Suggest the documentation page of each of these ${apis.length} library APIs the change uses, at the pinned`,
    'version. Each line gives the id, the API, its library and version, the file that pins it, and where',
    'the change uses it, as untrusted text:',
    '',
    untrustedBlock('library APIs', lines.join('\n'), id),
    '',
    FINAL_ANSWER_RULE,
  ].join('\n');
}

/** What is wrong with each suggestion: an API not asked about or named twice, or an address the engine refuses. */
export function docSuggestionProblems(answer: DocSuggestionAnswer, apis: readonly LibraryApi[]): string[] {
  const named = new Set<string>();
  return answer.links.flatMap((link) => {
    const index = /^a(\d+)$/.exec(link.api.trim())?.[1];
    if (index === undefined || apis[Number(index) - 1] === undefined) return [`${JSON.stringify(link.api)} is not the id of an API listed`];
    if (named.has(link.api.trim())) return [`${link.api} is given more than one link`];
    named.add(link.api.trim());
    const url = link.url.trim();
    if (url.length > MAX_DOC_URL) return [`the link for ${link.api} is ${url.length} characters; at most ${MAX_DOC_URL} are allowed`];
    const problem = docsUrlProblem(url);
    return problem === undefined ? [] : [`the link for ${link.api} is refused: ${problem}`];
  });
}

/** The suggestions the checks accept, as links labelled the agent's, in the order of the APIs. */
export function suggestedLinks(answer: DocSuggestionAnswer, apis: readonly LibraryApi[]): DocLink[] {
  const urls = new Map<number, string>();
  for (const link of answer.links) {
    if (docSuggestionProblems({ links: [link] }, apis).length > 0) continue;
    const index = Number(/^a(\d+)$/.exec(link.api.trim())![1]) - 1;
    if (!urls.has(index)) urls.set(index, new URL(link.url.trim()).href);
  }
  return apis.flatMap((api, index) => {
    const url = urls.get(index);
    return url === undefined ? [] : [{ ...api, url, from: 'agent' as const }];
  });
}

export interface DocSuggestionOptions {
  adapter: AgentAdapter;
  settings?: AgentSettings;
  /** The read-only head copy the agent works in. */
  root: string;
  /**
   * Whether an answer must pass the checks as well as the schema, or be
   * retried; true when absent. The evaluation turns it off to score the
   * prompt's own answers on those checks.
   */
  plainChecks?: boolean;
}

/** What the doc-links prompt produced: the links it suggested, labelled as such, and the stamp of the run. */
export interface DocSuggestionResult {
  links: DocLink[];
  suggestions: DocSuggestions;
  /** The agent's answer as it wrote it; absent on a fallback. */
  answer?: DocSuggestionAnswer;
}

/**
 * Asks the agent for the documentation pages of APIs no inventory linked,
 * and checks its answer: every suggestion names an API asked about, once,
 * with an https address on a named public host. A rejected answer is
 * retried once and then reported. Nothing is fetched.
 */
export async function suggestDocLinks(apis: readonly LibraryApi[], options: DocSuggestionOptions): Promise<DocSuggestionResult> {
  const plainChecks = options.plainChecks ?? true;
  const { results } = await runAgentTasks(
    options.adapter,
    [
      {
        root: options.root,
        instructions: DOC_LINKS_INSTRUCTIONS,
        prompt: docLinksPrompt(apis),
        schema: DOC_LINKS_SCHEMA,
        check: (value) => (plainChecks ? docSuggestionProblems(value as DocSuggestionAnswer, apis) : []),
      },
    ],
    options.settings ?? DEFAULT_AGENT_SETTINGS,
  );
  const result = results[0]!;
  const base = { promptVersion: DOC_LINKS_PROMPT_VERSION, stamp: result.stamp };
  if (!result.ok) {
    return { links: [], suggestions: { ...base, outcome: 'fell back', detail: `the agent gave no usable answer (${result.reason}: ${result.message})` } };
  }
  const answer = result.answer as DocSuggestionAnswer;
  const links = suggestedLinks(answer, apis);
  const detail =
    `the agent suggested ${links.length} of ${apis.length} links from what it knows; each names an API asked about and is an https address ` +
    'on a named host, and none was opened or checked';
  return { links, suggestions: { ...base, outcome: 'suggested', detail }, answer };
}

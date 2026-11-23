# Read Jira tickets through the reviewer's Claude Code, in a run of their own

A pull request's acceptance criteria often live in a Jira ticket rather than a GitHub issue. The companion reads them from **Jira Cloud** only, through the reviewer's own Claude Code and its claude.ai Atlassian connector, in a separate fetch run that has no copy of the repository, no built-in tools and only two Jira read tools. The engine keeps no Jira login of its own. It checks every ticket field the run returns against what Jira itself sent, so a ticket's criteria are always quoted as Jira holds them. This is the one place an agent run reaches the network, and it is allowed only under the limits below.

## Issue tracker sources

Linked issues come from **issue tracker sources**, behind one small interface: GitHub issues, as today, and Jira. Linear can be added as a third without changing anything after the read. Each source reads its own tickets and reports its own outcome: read, not connected, or nothing found. Criteria point at their ticket by position in the list, so everything after the read is the same whatever the source. The linked-issue shape becomes source-neutral, with a `source` and a `key` (`#42` in a repository, or `ABC-123`), which bumps the saved-result version. A GitHub-only review reads exactly as before.

## Finding the tickets

- **Where.** The companion looks for **key references** in the branch name, the pull request's title and its description, including `…/browse/ABC-123` links.
- **Any key shape counts.** There is no list of project keys to configure. A key is a capital letter, then capitals, digits or `_`, a hyphen, and a number with no leading zero. Matching uses lookarounds rather than word boundaries, so `feature/ABC-123_login` yields `ABC-123`.
- **A built-in deny-list** drops technical prefixes that look like keys: `UTF-8`, `SHA-256`, `ISO-8601`, `CVE-…`, `RFC-…`, `HTTP-2`, `PEP-8`, `GPT-4`, `ES-2022` and similar.
- **Order and cap.** References are taken branch first, then title, then description, duplicates removed, and at most five are fetched.
- **Only Jira can confirm a key.** A key becomes a **linked ticket** only when Jira returns it. A key Jira doesn't return is dropped quietly. Jira answers "not found" both for a missing ticket and for one the reviewer can't see, so the companion can't tell the two apart either.
- **Visible projects are learned.** The project of each confirmed key is cached per Jira site. Later reviews fetch keys of known projects first and need not guess at the rest. Nothing is configured and no project list is fetched.

## Reading the criteria

The criteria are a section of the ticket's description. That section sits under the heading named by the existing `second-look.criteriaHeading` setting (default "Acceptance criteria", matched case-insensitively, trailing colon allowed). A paragraph that is only a bold line with that text counts as the heading too, because Jira users often write one instead. The description's rich-text document (ADF) is flattened to lines. Under the heading, bullets, numbered items, task items and plain Given/When/Then lines all count as criteria, not just `- [ ]` checkboxes. A ticket with no such section is still shown, with "no criteria section found", and nothing from it is mapped. Only the description is read for criteria; comments and attachments are never read.

## The fetch run

The engine can't call an MCP tool itself; Claude Code has no command for that. So the fetch is one short agent run, started for that purpose alone, separate from every review run, and allowed to do nothing else:

| Limit | Why |
| --- | --- |
| An empty temporary working folder, and no `SECOND_LOOK_READ_ROOT` | No copy of the repository is within reach, and the guard denies every file read. |
| `--tools ""` | No built-in tool at all: no file reading, no shell, no web. |
| `--allowedTools` naming exactly `getJiraIssue` and `getAccessibleAtlassianResources`, by their full `mcp__…` names | The only tools pre-approved. Every other MCP tool, the connector's write tools included, needs approval that never comes. |
| `--permission-mode default` and `--permission-prompts none` | A tool that isn't pre-approved is denied rather than asked about. |
| The guard hook on every tool, allow-listing those two names and checking their arguments | The issue key must be key-shaped, and the `cloudId` must be the chosen Jira site (see **The Jira site**). Any other call is denied and fails the run. |
| `--no-session-persistence` | No session file is left behind. |
| `--json-schema` | The answer is JSON: each ticket's key, summary and description, quoted. |
| The engine checks every quoted field against the raw MCP `tool_result` in the stream-json events | The model only drives the call. A field that doesn't match what Jira sent is discarded, never shown or mapped. |

The ticket text then reaches the review runs the same way GitHub issue bodies do: cleaned, fenced as untrusted input and named as data, never as instructions.

**The connector.** The reviewer's claude.ai Atlassian connector belongs to whichever Claude account their Claude Code is signed in to. For work, that's the work Claude account, used from a separate VS Code profile, so ticket text only ever goes to that account. The companion never reads the connector's login. claude.ai connectors can't be named in `--mcp-config`. Dropping `--strict-mcp-config` loads every other connector and plugin server the reviewer has (Slack, Gmail, Drive and the rest), and their tool descriptions enter the run's context. That's why the fetch run is isolated and allow-lists two tool names. The review runs keep `--strict-mcp-config` with no MCP configuration, as before.

**The Jira site.** The site is learned at run time, from `getAccessibleAtlassianResources`, not configured. If the reviewer's Atlassian account reaches exactly one Jira site, that is the site. If it reaches several, an optional `second-look.jira.site` setting picks one. Without it, the fetch names the sites it found and asks the reviewer to set the setting, and no ticket is read. The guard's `cloudId` check compares against the chosen site. The setting is the only Jira setting, it is needed only on an account with several sites, and the projects cache is kept per site.

**Known risk, and the fallback.** In a print-mode test on Claude Code 2.1.330, the claude.ai connectors didn't appear in the run's start event. The first ticket (J0) checks whether the connector works in a print-mode fetch run. If it doesn't, the documented fallback is Second Look's own Atlassian Rovo MCP v2 entry, `https://mcp.atlassian.com/v2/mcp`, passed with `--mcp-config` while keeping `--strict-mcp-config`, so it's the only server that loads. The reviewer signs it in once with `claude mcp add -s user --transport http atlassian https://mcp.atlassian.com/v2/mcp` and `claude mcp login atlassian`. All the limits above apply unchanged.

## When Jira can't be read

- **No Jira access, or not connected.** The review never waits on Jira and never fails because of it. The companion shows the keys it found with a **Connect Jira** hint, in place of today's silent "this pull request links no issue".
- **Pi.** Pi has no MCP and runs offline, so Pi reviewers get no Jira. The companion shows the keys found and a hint that Jira tickets need Claude Code. A Jira REST adapter that would serve Pi is on the backlog.

## Considered Options

- Our own REST client with a scoped read-only API token in the editor's secret storage: rejected for v1. It's deterministic and keeps all fetching in the engine, but it was turned down in favour of reusing the connections the reviewer's Claude Code already has, rather than the companion holding one more secret. It's kept as the later adapter for Pi, behind the same tracker-source interface.
- Folding the fetch into the review runs: rejected. It would put untrusted ticket text in the same context as the repository copy and live network tools.
- The engine as its own MCP client, with no model: rejected. The companion would need its own OAuth flow and token storage, which is the secret it set out not to hold ([ADR 0004](0004-drive-installed-agent-clis.md)).
- Dropping `--strict-mcp-config` in the normal runs, with no separate run: rejected. Every connector and plugin server would load into runs that hold the repository.
- Taking the model's summary of the ticket: rejected. Criteria are quoted verbatim, and a retelling could drift or carry the ticket's own instructions. The model's answer is checked against Jira's bytes instead.

## Consequences

- **A narrow exception to "agents never have network access"** ([ADR 0003](0003-library-source-only-on-reviewer-request.md), [What agents can read, reach and run](../agent-safety.md)). The Jira fetch run, on Claude Code only, may call two Jira read tools, with no repository copy and no other tool, and its output is checked against the raw tool result. Every other run is unchanged.
- **The fetch is model-mediated.** It costs one short model turn per review that has keys, and isn't deterministic. A run that skips a key just means that ticket is missing, never that wrong text is shown.
- **Ticket text goes to the model provider** of the reviewer's Claude Code, like GitHub issue bodies. It's stored with the saved review. A **clear cache** command removes the cached repository copies and the saved ticket text.
- **The fetch run's isolation is weaker than the review runs'.** It loads the reviewer's other connectors, so the allow-list, the permission mode and the guard are all that stop it calling them ([What agents can read, reach and run](../agent-safety.md)). When the code lands, the "no shell and no network" lines in the README and the agent-safety summary need the same exception.
- **The connector route is unverified in print mode** until J0, and the fallback needs a one-time sign-in by the reviewer.
- **Three prompts name issues GitHub-style** (criteria mapping, unexplained changes, draft comments). Each needs Jira wording, a version bump and a synthetic Jira evaluation case ([ADR 0006](0006-no-prompt-without-its-evaluation.md)). The repository is public, so no real work ticket is ever used as test data.

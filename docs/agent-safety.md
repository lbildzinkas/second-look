# What agents can read, reach and run

The companion drives the reviewer's installed coding agent on text other people wrote: a pull request's code, its description, its linked issues, its pipeline report and its CI logs. This page lists, for each agent the companion drives, what the agent may read, what it is denied, and how each limit is enforced, then the gaps where a limit is weaker than it reads. Every statement points at the code that makes it true, at the commit this page was written against; when the code and this page disagree, the code wins and this page is wrong.

Paths are relative to `packages/engine/src/` unless they name another folder.

## Which agents

| Agent | Supported | Adapter |
| --- | --- | --- |
| Pi | yes | `pi.ts`, with the guard `pi-guard.ts` |
| Claude Code | yes | `claude-code.ts`, with the guard `claude-guard.ts` |
| Codex | **no, not yet** | none |

The engine drives only the agents `AGENT_NAMES` lists, `pi` and `claude-code` (`agents.ts:16`), and refuses any other name with an error (`agents.ts:69-74`). [ADR 0004](adr/0004-drive-installed-agent-clis.md) names Codex as an agent to drive, but no Codex adapter exists, so nothing on this page applies to Codex and the companion never starts it.

## What every agent run shares

These hold for both agents, because they come from the engine rather than from either adapter.

### The agent is started in one read-only folder

- **The folder.** Each run is started with its working directory set to one folder (`pi.ts:213-219`, `claude-code.ts:528-534`): the head copy of the pull request for every review pass and ask (for example `review.ts:552`, `asks.ts:64`), that library's fetched folder alone after the reviewer presses a library fetch (`library-verdicts.ts:252`), or, when the reviewer asks for an agent test, an empty temporary folder under the system's temporary folder, made read-only and removed after the one run (`agent-test.ts:78-80`, `agent-test.ts:105-106`). A Jira run, too, starts in an empty read-only temporary folder of its own (`jira-connect.ts:479-483`). The base copy, the reviewer's workspace and the rest of the cache are never the run's folder.
- **Read-only.** The copies and fetched libraries are all written by `archive.ts`, with every file mode `0444` and every folder `0555` (`archive.ts:18-19`, `archive.ts:168-175`), so nothing in them can be written or run in place. Each copy is unpacked from the commit's archive into the engine's cache (`cache.ts:80-107`): nothing is checked out in the reviewer's workspace, and nothing from the pull request is built, installed or run.
- **No links out.** Symbolic links, hard links and special files in an archive are skipped, never written, and an entry whose path would leave the folder is refused (`archive.ts:139-149`, `archive.ts:179-187`). A copy therefore holds no link an agent could follow out of it.

### The agent has no GitHub login

The engine removes `GITHUB_TOKEN`, `GH_TOKEN`, `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` from every agent's environment (`agent.ts:194-199`, applied at `pi.ts:90-94` and `claude-code.ts:208-213`). The token the engine holds lives only in its GitHub client's memory (`github.ts:58-70`). In VS Code the token comes from VS Code's authentication API with each request and is never put in the engine's environment (`packages/extension/src/engine-client.ts:112` passes the editor's environment, not a token).

### The agent signs in with its own login, which the companion never reads

The agent uses whatever login the reviewer gave it. The companion never opens, reads or stores it. For Claude Code it only checks which kind of login is present, by the names of environment variables, and names that on each run's stamp and on the probe (`claude-code.ts:239-258`); an `ANTHROPIC_API_KEY` is checked for presence only.

### Agents never have network access; the companion does all fetching

No agent is given a tool that reaches the network: each runs with file-reading tools only (see each agent below), with one narrow exception, the Jira fetch run, set out after the table. Every download the review needs is made by the engine's own code, never by the agent and never on the agent's word alone ([ADR 0003](adr/0003-library-source-only-on-reviewer-request.md)):

| What the companion fetches | From where | When | Code |
| --- | --- | --- | --- |
| The pull request, its diff, merge base, base and head archives, `.gitattributes`, last review | GitHub's REST API with the reviewer's token | every review | `github.ts:76-300`, `github.ts:366` |
| Linked issues | GitHub's GraphQL API | every review | `github.ts:173-215` |
| Jira tickets the pull request's key references name, at most five | the reviewer's Jira Cloud site, **fetched by the agent's MCP connector** (the reviewer's Claude Code Atlassian connector) in the Jira fetch run, the one exception below | every review with a key reference, on Claude Code only, with the site learned once; and the setup step's Jira check and **Test**, only when the reviewer presses them | the review fetch: `jira-issues.ts`, run by `jira-connect.ts:656-672`; the setup check: `jira-connect.ts:571-601` ([ADR 0010](adr/0010-issue-tracker-sources.md)) |
| Check runs, annotations and the logs of failed GitHub Actions jobs | GitHub's REST API | every review | `github.ts:105-170`, `ci.ts` |
| The logs of passing GitHub Actions jobs at the reviewed head commit | GitHub's REST API with the reviewer's token | only when the reviewer presses **Read the CI log** (`readCiLog`) | `ci.ts`, `ci-log-read.ts` |
| The reviewer's open pull requests, one search per group | GitHub's GraphQL API with the reviewer's token | each time the reviewer's pull requests are listed (`pullRequests/list`) | `github.ts:395-418`, `pull-request-list.ts` |
| The submitted review, and the **Viewed** mark when the mirror setting is on | GitHub's REST and GraphQL APIs | only when the reviewer presses send, or ticks a part with the mirror on | `github.ts:309-360`, `send.ts` |
| A Python library at the pinned hash | `pypi.org`, then `files.pythonhosted.org` | only when the reviewer presses a fetch | `library-fetch.ts:202-240` |
| A .NET package, its symbol package and its Source Link files | `api.nuget.org`, `www.nuget.org`, and the source hosts of GitHub, GitLab, Bitbucket and Azure DevOps | only when the reviewer presses a fetch or a decompile | `nuget-fetch.ts:38`, `nuget-fetch.ts:190-194`, `nuget-fetch.ts:245-249` |
| An npm, Cargo, Go or Maven library at the pinned hash | `registry.npmjs.org`, `static.crates.io`, `proxy.golang.org`, `repo.maven.apache.org` | only when the reviewer presses a fetch | `ecosystem-fetch.ts:53`, `ecosystem-fetch.ts:218-247` |
| A tag of a repository the agent named | `codeload.github.com` or `gitlab.com`, over https, with no token | only when the reviewer presses a fetch | `repository-fetch.ts:20-67` |
| Documentation inventories | the documentation host PyPI names for the pinned release (Read the Docs first), and `learn.microsoft.com` | after each review that uses a pinned library's APIs | `doc-links.ts:35-38`, `doc-links.ts:161-183`, `doc-fetch.ts` |

What the agent may influence, it influences only through the engine's checks:

- A repository the agent names is fetched only from GitHub or GitLab over https, with no credentials and no port, and only when the reviewer presses the fetch (`repository-fetch.ts:40-54`).
- A documentation page the agent suggests is never fetched: the engine checks only that it is an https address on a named public host, and shows it labelled as the agent's suggestion (`doc-suggestions.ts:14-20`).
- An inventory download, which a pull request's lock files steer, is https on a named host with no credentials and no port, connects only to public addresses — loopback, private-network and link-local ones are refused as the connection is made — follows no redirect, and is capped (`doc-fetch.ts:7-35`, `doc-fetch.ts:37-100`).
- A downloaded library is checked against the hash the project pins before anything is unpacked (`library-fetch.ts:238`, `ecosystem-fetch.ts`, `nuget-fetch.ts`), and is unpacked read-only, never built, installed or run (`archive.ts`).

**The one exception: the Jira runs** ([ADR 0010](adr/0010-issue-tracker-sources.md)). Jira tickets are read through the reviewer's Claude Code Atlassian connector, because the engine holds no Jira login. Claude Code only, so Pi reviewers get no Jira: a review on Pi lists the Jira source as not connected, saying Jira needs Claude Code, and starts no run (`server.ts:527-548`). The print-mode connector route is confirmed (J0, issue 188): the claude.ai connector's server is `claude_ai_Atlassian_MCP`, and its two read tools are `mcp__claude_ai_Atlassian_MCP__getJiraIssue` and `mcp__claude_ai_Atlassian_MCP__getAccessibleAtlassianResources` (`jira-tools.ts:9-28`). Three runs reach Jira, each separate from every review run and from one another, and they are the only agent runs that reach the network: the **review fetch**, one run per review whose pull request names a key reference (`review.ts:300-304`, `jira-issues.ts:323-395`); the **site-list run**, which learns the Jira site once, on the first review or when the setup step's **Check Jira** is pressed; and the setup step's **Test**, which fetches one ticket the reviewer types. All three share one runner (`jira-connect.ts:478-554`) and these limits:

- **No repository copy.** Each run starts in a new empty temporary folder, made read-only and removed afterwards (`jira-connect.ts:479-483`, `jira-connect.ts:552`). Its environment drops `SECOND_LOOK_READ_ROOT` along with the GitHub token variables (`jira-connect.ts:408-412`), and the guard denies every call of a Jira run that names a read root (`claude-guard-check.ts:184`).
- **Jira read tools only.** Each run is one print-mode run with `--output-format stream-json`, which Claude Code 2.1.330 gives in print mode only with `--verbose`, so the runs pass it, as every review run does (`jira-connect.ts:146-149`, `claude-code.ts:178-181`). No built-in tool (`--tools ""`). Only `getJiraIssue` and `getAccessibleAtlassianResources` are pre-approved, by their exact `mcp__…` names (`--allowedTools`); the site-list run pre-approves only the site-list tool, of the connector's server and of the fallback's (`jira-tools.ts:25-28`, `jira-connect.ts:179`). With `--permission-mode default` and `--permission-prompts none`, every other MCP tool is denied, the connector's write tools included, and `--no-session-persistence` leaves no session file (`jira-connect.ts:136-169`).
- **The guard's Jira mode, on every tool call.** The companion's `PreToolUse` hook is passed with `--settings` when Claude Code starts, on every tool (matcher `*`), with hooks pinned on, exactly as for a review run (`jira-connect.ts:498`, `claude-code.ts:149-159`). The run's environment puts it in Jira mode with the run's limits (`jira-connect.ts:420-427`, `claude-guard-check.ts:205-211`). In that mode it passes `getAccessibleAtlassianResources` with no arguments, and `getJiraIssue` only with exactly a `cloudId` that names the chosen Jira site and an `issueIdOrKey` of the key shape key references use, for both the connector's server and the fallback's; the site-list run has no site chosen yet, so it denies every `getJiraIssue`. It denies every other tool: Read, Grep, Glob, Bash and every built-in tool, the connector's write tools, `executeRead` and `executeWrite`, and every other MCP tool (`claude-guard-check.ts:178-202`). It never answers `allow` and never rewrites a call (`claude-guard-check.ts:218-257`). A Jira mode whose limits can't be read denies every call rather than fall back (`claude-guard-check.ts:149-161`, `claude-guard-check.ts:205-211`). A review run never enters Jira mode: every review run's environment drops the variable that selects it, whatever the engine's own environment holds (`claude-code.ts:208-213`).
- **`StructuredOutput`, for the review fetch only.** The review fetch answers with `--json-schema`, and Claude Code returns that answer through its `StructuredOutput` tool, so the guard passes `StructuredOutput` in the review fetch and denies it in the site-list run and the **Test**, which answer no schema (`claude-guard-check.ts:185-186`). The tool touches no file and reaches nothing, and every field of the answer is checked against Jira's own bytes below.
- **Fails closed.** Before each run the exact hook command must refuse a synthetic call of the connector's `createJiraIssue` in the run's Jira mode and write its audit line, or the run is never started (`jira-connect.ts:491-495`, `claude-code.ts:366-422`). After it, a run in which the guard refused any call, or that made a call the guard never saw and Claude Code didn't refuse itself, has nothing it read used (`jira-connect.ts:459-467`, `jira-connect.ts:541-542`), and so does a run in another permission mode, or one that called a tool outside its allow-list (`jira-connect.ts:291-300`). A key that isn't key-shaped is refused before any run (`jira-connect.ts:590`, `jira-connect.ts:656-672`).
- **Read from Jira's own bytes.** What a run reports is read from its stream-json events, never from the model's word. The site-list run and the **Test** report the start event's MCP servers and the raw tool results for the sites and for the ticket's key and summary (`jira-connect.ts:342-389`). The review fetch's answer quotes each ticket's summary, description and criteria section (`jira-connect.ts:617-637`), and the engine checks every quoted field against the raw `getJiraIssue` result Jira sent for that key, word for word once layout marks and white space are set aside; a ticket with any field that doesn't match, or that the answer left out, is discarded with a plain reason, never shown or mapped, and a confirmed ticket shows Jira's own text from the raw result, not the answer's (`jira-issues.ts:132-145`, `jira-issues.ts:174-216`, `jira-text.ts:249`). A call on any other site, or for a key the review didn't ask for, discards the whole fetch (`jira-issues.ts:186`). The ticket text then reaches the review runs cleaned and fenced like every other text from others (below).
- **Never fails the review.** A Jira source that can't read reports its own outcome — not connected, nothing found or unreadable — and the review goes on (`jira-issues.ts:323-395`). The whole Jira read, the site-list run and the fetch together, has a 90-second deadline, so a slow run ends as unreadable rather than holding up the review (`jira-issues.ts:55`, `jira-issues.ts:333-335`), each run counts against the review's agent-run budget and none starts past it (`jira-issues.ts:341-343`, `jira-issues.ts:358-360`), and the reviewer's cancel stops it (`review.ts:300-304`).
- **Known gap: the other connectors load.** claude.ai connectors can't be named in `--mcp-config`, so the connector route's runs drop `--strict-mcp-config` and load every other connector and plugin server the reviewer has (Slack, Gmail, Drive and the rest); their tool descriptions enter the run's context. Only the allow-list, the permission mode and the guard stop it calling them.

**The fallback.** A reviewer whose Claude account has no Atlassian connector adds Atlassian's own MCP server once, with `claude mcp add -s user --transport http atlassian https://mcp.atlassian.com/v2/mcp`, and signs it in with `claude mcp login atlassian`. That route's run names the server with `--mcp-config` and keeps `--strict-mcp-config`, so it's the only server that loads (`jira-connect.ts:72`, `jira-connect.ts:136-169`). The same two tools are pre-approved, under the server name `atlassian` — `mcp__atlassian__getJiraIssue` and `mcp__atlassian__getAccessibleAtlassianResources` (`jira-tools.ts:13`, `jira-tools.ts:25-28`) — and the guard's Jira mode checks them the same way (`claude-guard-check.ts:188-194`).

**What is kept.** The chosen site is kept in the engine's cache so later reviews skip the site-list run, and is learned again when Jira refuses it or its server is gone; the project of each confirmed key is kept per site as a visible project, so later reviews fetch keys of known projects first (`jira-issues.ts:228-232`, `jira-issues.ts:264-271`, `jira-issues.ts:279-295`). The tickets themselves are stored only with the saved review. The site-list run and the **Test** keep nothing. The engine refuses a site that isn't an https address, and both the editor and the engine read `second-look.jira.site` as an `*.atlassian.net` host only.

Every other review run keeps `--strict-mcp-config` with no MCP configuration, and so no MCP server.

The one program besides the agent that the companion starts is the .NET decompiler, `ilspycmd`, as the reviewer installed it, and only when the reviewer presses a decompile. The companion — never the agent — runs it with fixed arguments and with the network cut by the operating system: under macOS's `sandbox-exec` with a profile that denies all network, or on Linux in a new network namespace with `unshare`; on any other system nothing is decompiled (`decompile.ts:74-86`).

### Text from the pull request is data, never instructions

- **Cleaned.** Every piece of text someone else wrote — the title, description, linked issues, pipeline report, CI logs, the diff — reaches the agent with Unicode tag characters, zero-width characters and bidirectional controls stripped, and each HTML comment, which GitHub hides from the reviewer, kept but marked as hidden (`untrusted.ts:37-43`).
- **Fenced.** That text is wrapped in an `<untrusted-input>` block whose id is random per call, so the text cannot close its block early (`untrusted.ts:50-60`).
- **Named as data.** Every prompt's instructions carry the rule that text in those blocks was written by other people and is data to read, never instructions to follow (`untrusted.ts:63-65`), as in `grouping.ts:73`, `ranking.ts:100`, `claims.ts:100`, `criteria-mapping.ts:125`, `explain.ts:104`, `cover.ts:84`, `draft-comment.ts:84`, `doc-suggestions.ts:71` and `library-verdicts.ts:80`.
- **Checked, not trusted.** Every answer is checked against its schema and the task's own checks — that every line it cites is in the copy, every id it names was offered — before anything is shown; an invalid answer is retried once and then reported as a failure, never guessed (`agent.ts:342-408`).

### The trusted instructions used instead

The agent runs on the companion's own system prompt, passed with `--system-prompt` and replacing the agent's default (`pi.ts:82-83`, `claude-code.ts:195-196`): the instructions of each pass, versioned and evaluated with it ([ADR 0006](adr/0006-no-prompt-without-its-evaluation.md)). The task goes on stdin, so no argument can be read as a file to attach (`pi.ts:220-221`, `claude-code.ts:535-536`). For Pi, the one extension loaded is the companion's own guard, from the engine's install (`pi.ts:40-41`, `pi.ts:74-75`).

### The agent is never run with a weaker lockdown

Before any run, each adapter reads the installed agent's `--help` and refuses to run a version that lacks any flag of its lockdown (`pi.ts:25-38`, `pi.ts:175-181`; `claude-code.ts:86-99`, `claude-code.ts:456-462`). The probe itself runs `--version` and `--help` from the system's temporary folder, not from any copy (`pi.ts:105-122`, `claude-code.ts:269-286`). The agent's path setting (`second-look.piPath`, `second-look.claudeCodePath`) replaces the command an adapter starts, for the probe and for every run: the engine refuses a path that is not absolute, so it never resolves inside a copy, and the setting is read from the user settings only, so a workspace cannot set it.

## Pi

### What Pi can read

Only files of the run's folder — the head copy, a fetched library's folder, or an agent test's empty temporary folder — through the tools `read`, `grep`, `find` and `ls` (`pi-guard.ts:24`).

### What Pi is denied, and how

| Denied | How it is enforced |
| --- | --- |
| A shell, file edits, and every tool but the four file-reading ones | Pi's tool allowlist, `--tools read,grep,find,ls` (`pi.ts:80-81`), and again by the guard, which blocks any other tool before it runs in case a Pi version ignores the allowlist (`pi-guard.ts:42-44`). |
| Any path outside the run's folder, by absolute path, by `..`, by `~` or through a symbolic link | The guard resolves each tool's `path` the way Pi does, refuses it unless it sits inside the folder, then resolves its real path and refuses it again unless that is inside the folder's real path, and hands the tool the checked real path so it reads exactly what was checked (`pi-guard.ts:26-30`, `read-guard.ts:65-69`, `read-guard.ts:85-115`, `pi-guard.ts:71-78`). |
| Credential paths: SSH keys (`~/.ssh`), GPG keys (`~/.gnupg`), cloud credentials (`~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.kube`, `~/.docker/config.json`), the GitHub login (`~/.config/gh`, `~/.git-credentials`, `~/.config/git/credentials`, `~/.netrc`), `~/.npmrc`, and the agents' own logins (`~/.pi/agent/auth.json`, `~/.claude/.credentials.json`, `~/.codex/auth.json`) | Refused by name before the file system is touched there, whatever the run's folder is, from the list Claude Code's guard shares (`read-guard.ts:31-47`, `read-guard.ts:94-95`). |
| URLs | Any path that reads as a URL is refused (`read-guard.ts:53`, `read-guard.ts:91-93`). |
| Reading anything when the run's folder is not set | The guard blocks every call without `SECOND_LOOK_READ_ROOT` (`pi-guard.ts:45`), which the adapter sets to the run's folder (`pi.ts:90-94`). |
| The GitHub token | Removed from the environment (`pi.ts:90-94`). |
| Network at startup | `--offline`, with `PI_OFFLINE=1` and `PI_TELEMETRY=0` in its environment (`pi.ts:71`, `pi.ts:93`). |
| A session file | `--no-session` (`pi.ts:70`). |

### What from the pull request Pi ignores

The head copy is the pull request's own repository, so it can hold agent configuration. Pi runs with:

- `--no-approve`: Pi's project trust is off, so the copy's own Pi settings are not applied (`pi.ts:72`).
- `--no-extensions`, then `--extension` with the companion's guard only: no extension from the copy or from the reviewer's set loads (`pi.ts:73-75`).
- `--no-skills`, `--no-prompt-templates`, `--no-themes` (`pi.ts:76-79`).
- `--no-context-files`: context files such as `AGENTS.md` and `CLAUDE.md` in the copy are not read as instructions (`pi.ts:79`).
- `--system-prompt` with the companion's own instructions (`pi.ts:82-83`).

### Known gaps for Pi

- **No operating-system sandbox.** Pi has none of its own, so the guard is an extension running inside Pi's process, checking tool calls before they run (`pi-guard.ts:1-19`). It is as strong as Pi's tool-call hook: a Pi bug that skipped the hook, or a tool that read a file without one, would not be stopped by anything below it. Pi runs as the reviewer's own user with the reviewer's own file permissions.
- **Only `path` is checked.** The guard checks and rewrites each tool's `path` argument only (`pi-guard.ts:46-54`). The `pattern` of `find` and the `glob` of `grep` reach the tool unchecked, so keeping them beneath the checked path relies on Pi's own tools.
- **The credential list is a list.** Credentials stored anywhere else under the home folder are not refused by name. They stay out of reach only because they are outside the run's folder; the name list matters as a second line should that confinement fail.
- **The environment is inherited.** Pi inherits the engine's whole environment minus the GitHub token variables (`pi.ts:90-94`). Pi's tools cannot read environment variables, but any other secret in that environment, such as a cloud credential, is in the agent's process.
- **The agent process talks to its model.** "No network access" means no tool that reaches the network. Pi itself still connects to the model provider it is signed in to, and everything the prompt holds — including the pull request's text and code — is sent there. `--offline` stops only its startup network.
- **The reviewer's own Pi settings still apply.** The flags turn off extensions, skills, prompt templates, themes, context files and project trust; nothing in the adapter turns off the reviewer's own user-level Pi settings, which are trusted as the reviewer's.
- **Tests use a fake Pi.** The contract tests drive the adapter against a fake Pi executable (`packages/engine/test/fake-pi.ts`) that checks the arguments it is given; the guard is tested on its own (`packages/engine/test/pi-guard.test.ts`). That a real Pi honours every flag is not tested in CI.

## Claude Code

### What Claude Code can read

Only files of the run's folder — the head copy, a fetched library's folder, or an agent test's empty temporary folder — through the tools `Read`, `Grep` and `Glob`, plus `StructuredOutput`, the tool Claude Code returns the schema-checked answer through, which touches no file (`claude-guard-check.ts:48-51`). The run is started with its working directory set to the run's folder (`claude-code.ts:528-534`). The companion's guard, a `PreToolUse` hook Claude Code runs before every tool call, confines each call to that folder (`claude-guard-check.ts:104-122`), and Claude Code's own working-directory check stands behind it, because the run's permission mode is pinned to `default` (`claude-code.ts:191-192`). The Jira runs are the one exception, set out above: they read no file at all, and the guard's Jira mode lets them call only Jira's two read tools.

### What Claude Code is denied, and how

| Denied | How it is enforced |
| --- | --- |
| A shell, file edits, web fetch and web search, and every tool but the three file-reading ones | Claude Code's tool allowlist, `--tools Read,Grep,Glob` (`claude-code.ts:187-188`), and again by the guard, which denies every tool but those three and `StructuredOutput` before it runs, in case a tool slips past the allowlist (`claude-guard-check.ts:110-113`). |
| Any path outside the run's folder, by absolute path, by `..`, by `~` or through a symbolic link | **Enforced by the companion.** The guard checks Read's `file_path` and Grep's and Glob's `path` with the checks it shares with Pi's guard: it resolves the path the way Claude Code's tools do, refuses it unless it sits inside the folder, then resolves its real path and refuses it again unless that is inside the folder's real path, and refuses a path that does not exist (`claude-guard-check.ts:85-89`, `claude-guard-check.ts:115-121`, `read-guard.ts:65-69`, `read-guard.ts:85-115`). It never answers `allow` and never rewrites a call (`claude-guard-check.ts:218-257`), so a call it passes still meets Claude Code's own working-directory check: with the permission mode pinned to `default`, a read outside the working directory needs approval, which `--permission-prompts none` denies (`claude-code.ts:189-192`). |
| A Glob `pattern` or Grep `glob` that names an absolute path or climbs out with `..` | The guard refuses a pattern that starts with `/`, `\`, `~` or a drive letter, and any `..` segment, inside braces and extended-glob groups too (`claude-guard-check.ts:74-98`). |
| Credential paths: SSH keys (`~/.ssh`), GPG keys (`~/.gnupg`), cloud credentials (`~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.kube`, `~/.docker/config.json`), the GitHub login (`~/.config/gh`, `~/.git-credentials`, `~/.config/git/credentials`, `~/.netrc`), `~/.npmrc`, and the agents' own logins (`~/.pi/agent/auth.json`, `~/.claude/.credentials.json`, `~/.codex/auth.json`) | Refused by name by the guard before the file system is touched there, whatever the run's folder is, from the list it shares with Pi's guard (`read-guard.ts:31-47`, `read-guard.ts:94-95`), and again by permission rules generated from the same list — `Read(~/<path>)`, plus `Read(~/<path>/**)` for a folder — which Claude Code applies to Grep and Glob as well and checks before the hook runs (`claude-code.ts:138-142`, `claude-code.ts:149-159`). |
| URLs | Any path that reads as a URL is refused (`read-guard.ts:53`, `read-guard.ts:91-93`). |
| Reading anything when the run's folder is not set | The guard denies every file-reading call without `SECOND_LOOK_READ_ROOT` (`claude-guard-check.ts:114`), which the adapter sets to the run's folder, with the audit file and `ELECTRON_RUN_AS_NODE` so the editor's binary runs the guard as Node inside VS Code (`claude-code.ts:221-228`). |
| The reviewer's own settings switching the guard off | The guard is passed with `--settings`, which outranks user, project and local settings, with `"disableAllHooks": false` and the hook on every tool (matcher `*`) (`claude-code.ts:149-159`, `claude-code.ts:193-194`). The command-line `--permission-mode default` outranks a `defaultMode` in any settings (`claude-code.ts:191-192`). The guard's deny outranks allow rules, added directories and another hook's `allow`. The hook command is refused when the Node or guard path holds a character that could change it in a shell (`claude-code.ts:119-131`). |
| A run the guard did not see | **Fails closed**, because Claude Code lets a call through when a hook cannot start. The probe runs the exact hook command through a shell on a synthetic read outside an empty copy, and Claude Code is not used unless the guard refuses it and writes its audit line (`claude-code.ts:366-422`, `claude-code.ts:463-472`). A run whose start event reports a permission mode other than `default` fails, and so does a completed run that reports none (`claude-code.ts:628-639`, `claude-code.ts:652-654`). The guard writes one audit line per call (`claude-guard-check.ts:236-243`), and a run with a tool call that has no audit line and that Claude Code did not report denied itself fails, its answer discarded (`claude-code.ts:622-643`). The hook blocks the call with exit code 2 on any error of its own (`claude-guard.ts:14-35`). |
| MCP servers | `--strict-mcp-config` with no MCP configuration named, so every MCP configuration, the copy's `.mcp.json` included, is ignored (`claude-code.ts:186`). The Jira runs, which hold no copy, are the one exception above. |
| The GitHub token | Removed from the environment (`claude-code.ts:208-213`). |
| Non-essential network traffic at startup | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` in its environment (`claude-code.ts:212`). |
| A session file | `--no-session-persistence` (`claude-code.ts:183`). |

### What from the pull request Claude Code ignores

- `--setting-sources user`: only the reviewer's user-level settings load; the copy's project settings (`.claude/settings.json`) and local settings (`.claude/settings.local.json`), and the copy's own context, stay out (`claude-code.ts:48-50`, `claude-code.ts:184-185`).
- `--strict-mcp-config`: the copy's MCP servers stay out (`claude-code.ts:186`).
- `--system-prompt` with the companion's own instructions, and `--json-schema` with the answer's schema, which Claude Code checks before returning (`claude-code.ts:195-197`).

### Known gaps for Claude Code

- **Why the permission mode is pinned: Claude Code's `auto` mode.** Claude Code 2.1.289 starts Opus 5.5 and Sonnet 5 sessions in its `auto` permission mode, and Haiku in `default`. In `auto` mode, Read, Grep and Glob outside the working directory run without asking, so `--permission-prompts none` never comes into play: before the guard, a run with the adapter's flags read `/etc/hosts`, a file outside the copy, `../` and symbolically linked paths, and an absolute Glob pattern, while the same run on Haiku was denied. That was the dependence on the model earlier live runs showed. The guard refuses those calls on every model, and the pinned `--permission-mode default` removes the cause, so Claude Code's own working-directory check stands behind the guard. The probe still checks a setup: `second-look-engine probe <pull-request-url> --agent claude-code --model <model> --target /etc/hosts` must report `refused` for that target.
- **A managed policy that disables hooks is detected, not prevented.** Settings an organisation manages for Claude Code outrank `--settings`, so a policy-level `disableAllHooks` or `allowManagedHooksOnly` would keep the guard from running. The pinned `default` mode still denies reads outside the working directory then, and the run fails because its tool calls have no audit line — but only after the run, so whatever an unguarded call read has already reached the model provider. This was not tested live: no managed policy exists on the machine the guard was tested on.
- **A relative pattern that climbs with `..` rests on the guard alone.** Without the guard, Claude Code's own check does not refuse a Glob pattern or Grep glob such as `../outside/*`; in live runs its search stayed in the working directory and found nothing.
- **Windows is untested.** Claude Code hands the hook command to a shell. That the command's quoting holds there, and that the editor's binary runs the guard as Node, is proven live on macOS only; Linux uses the same mechanism with no platform-specific code but was not run live. The probe refuses a guard that does not run on any platform, but the guard is not claimed for Windows until it is tested there.
- **No operating-system sandbox.** The guard is a hook Claude Code runs as its own process before each tool call (`claude-guard.ts`), so it is as strong as Claude Code's hook runner; Claude Code runs as the reviewer's own user with the reviewer's own file permissions.
- **A response stopped by Anthropic's safety classifier fails the run.** When the classifier stops a response while its tool call is streaming, Claude Code reports that call as interrupted and the call never reaches the hook, so the run fails rather than trust it.
- **The credential list is a list.** Credentials stored anywhere else under the home folder are not refused by name. They stay out of reach only because they are outside the run's folder.
- **The reviewer's user-level settings load.** `--setting-sources user` keeps the reviewer's own settings (`claude-code.ts:184-185`), so their allow rules, added directories and hooks still load; the guard's deny outranks them, and `disableAllHooks` is pinned off.
- **The environment is inherited.** Claude Code inherits the engine's whole environment minus the GitHub token variables (`claude-code.ts:208-213`). Its file tools cannot read environment variables, but any other secret in that environment is in the agent's process — and some are meant to be: an `ANTHROPIC_API_KEY`, an OAuth token or cloud credentials for Amazon Bedrock or Google Vertex AI are how Claude Code signs in (`claude-code.ts:239-258`).
- **The agent process talks to its model.** "No network access" means no tool that reaches the network. Claude Code itself still connects to its model provider, and everything the prompt holds is sent there.
- **That the copy's context stays out rests on Claude Code.** The companion relies on `--setting-sources user` to keep the copy's `CLAUDE.md` and project settings out; nothing in the companion checks that a given Claude Code version does.
- **Live runs are opt-in.** The contract tests drive the adapter against a fake Claude Code executable (`packages/engine/test/fake-claude.ts`) that checks the arguments it is given and runs the real guard hook on its tool calls; the guard is tested on its own (`packages/engine/test/claude-guard.test.ts`), its Jira mode on parsed hook events too (`packages/engine/test/claude-guard-jira.test.ts`), and the Jira runs against a fake Claude Code that runs the real hook on each call (`packages/engine/test/fixtures/fake-claude-jira.mjs`). An opt-in live suite, `npm run test:live-claude` (`packages/engine/test/live/claude-guard.live.test.ts`), drives the real adapter on the reviewer's own Claude Code and spends subscription quota, so it never runs in CI; its Jira fetch test (`packages/engine/test/live/jira-fetch.live.test.ts`) runs only when `SECOND_LOOK_LIVE_JIRA_KEY` names a ticket on a test Jira site.

## Codex

Codex is not supported yet: there is no adapter, the engine refuses the name (`agents.ts:16`, `agents.ts:69-74`), and the companion never starts it. Its limits will be documented here when its adapter lands.

The one place Codex appears in the code today is the guards' shared credential list: Codex's login, `~/.codex/auth.json`, is refused to Pi and Claude Code like every other agent's login (`read-guard.ts:46`).

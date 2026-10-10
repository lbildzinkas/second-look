# What agents can read, reach and run

The companion drives the reviewer's installed coding agent on text other people wrote: a pull request's code, its description, its linked issues, its pipeline report and its CI logs. This page lists, for each agent the companion drives, what the agent may read, what it is denied, and how each limit is enforced, then the gaps where a limit is weaker than it reads. Every statement points at the code that makes it true, at the commit this page was written against; when the code and this page disagree, the code wins and this page is wrong.

Paths are relative to `packages/engine/src/` unless they name another folder.

## Which agents

| Agent | Supported | Adapter |
| --- | --- | --- |
| Pi | yes | `pi.ts`, with the guard `pi-guard.ts` |
| Claude Code | yes | `claude-code.ts`, with the guard `claude-guard.ts` |
| Codex | **no, not yet** | none |

The engine drives only the agents `AGENT_NAMES` lists, `pi` and `claude-code` (`agents.ts:15`), and refuses any other name with an error (`agents.ts:39-43`). [ADR 0004](adr/0004-drive-installed-agent-clis.md) names Codex as an agent to drive, but no Codex adapter exists, so nothing on this page applies to Codex and the companion never starts it.

## What every agent run shares

These hold for both agents, because they come from the engine rather than from either adapter.

### The agent is started in one folder, a read-only copy

- **The folder.** Each run is started with its working directory set to one folder (`pi.ts:198-204`, `claude-code.ts:482-488`): the head copy of the pull request for every review pass and ask (for example `review.ts:300`, `asks.ts:64`), or, after the reviewer presses a library fetch, that library's fetched folder alone (`library-verdicts.ts:252`). The base copy, the reviewer's workspace and the rest of the cache are never the run's folder.
- **Read-only.** The copies and fetched libraries are all written by `archive.ts`, with every file mode `0444` and every folder `0555` (`archive.ts:18-19`, `archive.ts:168-175`), so nothing in them can be written or run in place. Each copy is unpacked from the commit's archive into the engine's cache (`cache.ts:81-108`): nothing is checked out in the reviewer's workspace, and nothing from the pull request is built, installed or run.
- **No links out.** Symbolic links, hard links and special files in an archive are skipped, never written, and an entry whose path would leave the folder is refused (`archive.ts:139-149`, `archive.ts:179-187`). A copy therefore holds no link an agent could follow out of it.
- **Never the project loaded for navigation.** When the reviewer loads the project for navigation, the engine writes a writable copy of the head copy to `project/<commit>` beside the read-only copies, never inside one (`cache.ts:117-127`, `cache.ts:145-174`), and no agent run is ever started there: every run's folder is still the read-only head copy or a fetched library. The agents' lockdown is the same whether or not a project was loaded; what that copy may run belongs to the editor window it opens in, described [below](#the-project-loaded-for-navigation).

### The agent has no GitHub login

The engine removes `GITHUB_TOKEN`, `GH_TOKEN`, `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` from every agent's environment (`agent.ts:148-153`, applied at `pi.ts:88-92` and `claude-code.ts:199-203`). The token the engine holds lives only in its GitHub client's memory (`github.ts:58-70`). In VS Code the token comes from VS Code's authentication API with each request and is never put in the engine's environment (`packages/extension/src/engine-client.ts:88-89` passes the editor's environment, not a token).

### The agent signs in with its own login, which the companion never reads

The agent uses whatever login the reviewer gave it. The companion never opens, reads or stores it. For Claude Code it only checks which kind of login is present, by the names of environment variables, and stamps that on the run (`claude-code.ts:229-248`); an `ANTHROPIC_API_KEY` is checked for presence only.

### Agents never have network access; the companion does all fetching

No agent is given a tool that reaches the network: each runs with file-reading tools only (see each agent below). Every download the review needs is made by the engine's own code, never by the agent and never on the agent's word alone ([ADR 0003](adr/0003-library-source-only-on-reviewer-request.md)):

| What the companion fetches | From where | When | Code |
| --- | --- | --- | --- |
| The pull request, its diff, merge base, base and head archives, `.gitattributes`, last review | GitHub's REST API with the reviewer's token | every review | `github.ts:76-300`, `github.ts:366` |
| Linked issues | GitHub's GraphQL API | every review | `github.ts:173-215` |
| Check runs, annotations and the logs of failed GitHub Actions jobs | GitHub's REST API | every review | `github.ts:105-170`, `ci.ts` |
| The submitted review, and the **Viewed** mark when the mirror setting is on | GitHub's REST and GraphQL APIs | only when the reviewer presses send, or ticks a part with the mirror on | `github.ts:309-360`, `send.ts` |
| A Python library at the pinned hash | `pypi.org`, then `files.pythonhosted.org` | only when the reviewer presses a fetch | `library-fetch.ts:202-240` |
| A .NET package, its symbol package and its Source Link files | `api.nuget.org`, `www.nuget.org`, and the source hosts of GitHub, GitLab, Bitbucket and Azure DevOps | only when the reviewer presses a fetch or a decompile | `nuget-fetch.ts:38`, `nuget-fetch.ts:190-194`, `nuget-fetch.ts:245-249` |
| An npm, Cargo, Go or Maven library at the pinned hash | `registry.npmjs.org`, `static.crates.io`, `proxy.golang.org`, `repo.maven.apache.org` | only when the reviewer presses a fetch | `ecosystem-fetch.ts:53`, `ecosystem-fetch.ts:218-247` |
| A tag of a repository the agent named | `codeload.github.com` or `gitlab.com`, over https, with no token | only when the reviewer presses a fetch | `repository-fetch.ts:20-67` |
| Documentation inventories | the documentation host PyPI names for the pinned release (Read the Docs first), and `learn.microsoft.com` | after each review that uses a pinned library's APIs | `doc-links.ts:34-37`, `doc-links.ts:160-182`, `doc-fetch.ts` |

What the agent may influence, it influences only through the engine's checks:

- A repository the agent names is fetched only from GitHub or GitLab over https, with no credentials and no port, and only when the reviewer presses the fetch (`repository-fetch.ts:40-54`).
- A documentation page the agent suggests is never fetched: the engine checks only that it is an https address on a named public host, and shows it labelled as the agent's suggestion (`doc-suggestions.ts:14-20`).
- An inventory download, which a pull request's lock files steer, is https on a named host with no credentials and no port, connects only to public addresses — loopback, private-network and link-local ones are refused as the connection is made — follows no redirect, and is capped (`doc-fetch.ts:7-35`, `doc-fetch.ts:37-100`).
- A downloaded library is checked against the hash the project pins before anything is unpacked (`library-fetch.ts:238`, `ecosystem-fetch.ts`, `nuget-fetch.ts`), and is unpacked read-only, never built, installed or run (`archive.ts`).

The one program besides the agent that the companion starts is the .NET decompiler, `ilspycmd`, as the reviewer installed it, and only when the reviewer presses a decompile. The companion — never the agent — runs it with fixed arguments and with the network cut by the operating system: under macOS's `sandbox-exec` with a profile that denies all network, or on Linux in a new network namespace with `unshare`; on any other system nothing is decompiled (`decompile.ts:74-86`).

### Text from the pull request is data, never instructions

- **Cleaned.** Every piece of text someone else wrote — the title, description, linked issues, pipeline report, CI logs, the diff — reaches the agent with Unicode tag characters, zero-width characters and bidirectional controls stripped, and each HTML comment, which GitHub hides from the reviewer, kept but marked as hidden (`untrusted.ts:37-43`).
- **Fenced.** That text is wrapped in an `<untrusted-input>` block whose id is random per call, so the text cannot close its block early (`untrusted.ts:50-60`).
- **Named as data.** Every prompt's instructions carry the rule that text in those blocks was written by other people and is data to read, never instructions to follow (`untrusted.ts:63-65`), as in `grouping.ts:73`, `ranking.ts:97`, `claims.ts:100`, `criteria-mapping.ts:124`, `explain.ts:104`, `cover.ts:84`, `draft-comment.ts:84`, `doc-suggestions.ts:71` and `library-verdicts.ts:80`.
- **Checked, not trusted.** Every answer is checked against its schema and the task's own checks — that every line it cites is in the copy, every id it names was offered — before anything is shown; an invalid answer is retried once and then reported as a failure, never guessed (`agent.ts:264-316`).

### The trusted instructions used instead

The agent runs on the companion's own system prompt, passed with `--system-prompt` and replacing the agent's default (`pi.ts:80-81`, `claude-code.ts:190-191`): the instructions of each pass, versioned and evaluated with it ([ADR 0006](adr/0006-no-prompt-without-its-evaluation.md)). The task goes on stdin, so no argument can be read as a file to attach (`pi.ts:205-206`, `claude-code.ts:489-490`). For Pi, the one extension loaded is the companion's own guard, from the engine's install (`pi.ts:38-39`, `pi.ts:72-73`).

### The agent is never run with a weaker lockdown

Before any run, each adapter reads the installed agent's `--help` and refuses to run a version that lacks any flag of its lockdown (`pi.ts:23-36`, `pi.ts:162-167`; `claude-code.ts:83-96`, `claude-code.ts:412-417`). The probe itself runs `--version` and `--help` from the system's temporary folder, not from any copy (`pi.ts:101-116`, `claude-code.ts:257-272`).

### The project loaded for navigation

The one writable copy of a pull request is the one the reviewer asks for with **Second Look: Load the project for navigation…**, so language extensions can offer go to definition. It is never an agent run's folder, and the companion runs nothing in it:

- **Nothing before the reviewer confirms.** The command first shows a modal warning that names what can run once the folder is open — restoring the project, its build targets, analyzers and source generators, and the interpreters, SDKs and tools the project or its editor settings name — and only its confirm button goes on; dismissing it writes and opens nothing (`packages/extension/src/project-load.ts:25-39`, `packages/extension/src/extension.ts:828-859`).
- **What is written.** The request carries the head commit the warning named, and the engine refuses — writing nothing — unless that commit is the head commit of its latest finished review, so a review that moved on is never quietly written. What it writes is a copy of that head copy, regular files and folders only and never a link, files `0644` and folders `0755`, so nothing is executable (`cache.ts:110-143`). The engine itself runs nothing in it (`server.ts:736-774`).
- **Untrusted unless the reviewer trusts it.** The folder opens in a new window with the editor's own `vscode.openFolder` (`packages/extension/src/extension.ts:855`); the companion never marks it trusted, so VS Code's workspace trust opens it in Restricted Mode until the reviewer trusts it. The warning says so, and says instead that it opens trusted when the reviewer turned workspace trust off.

Known gaps:

- **Trusting it runs the pull request's code as the reviewer.** Once trusted, a restore, a build target, an analyzer or an interpreter the project names runs with the reviewer's own user, files and network. No sandbox stands behind it: the warning and workspace trust are the whole defence.
- **Trust can be inherited.** A folder inside one the reviewer already trusts, such as a trusted home folder, opens trusted; the companion cannot read the editor's list of trusted folders, so the warning only names the case.
- **A loaded copy is reused as the reviewer left it.** A second load at the same commit opens the same folder again, with whatever a restore or a build wrote there.

## Pi

### What Pi can read

Only files of the run's folder — the head copy, or a fetched library's folder — through the tools `read`, `grep`, `find` and `ls` (`pi-guard.ts:24`).

### What Pi is denied, and how

| Denied | How it is enforced |
| --- | --- |
| A shell, file edits, and every tool but the four file-reading ones | Pi's tool allowlist, `--tools read,grep,find,ls` (`pi.ts:78-79`), and again by the guard, which blocks any other tool before it runs in case a Pi version ignores the allowlist (`pi-guard.ts:42-44`). |
| Any path outside the run's folder, by absolute path, by `..`, by `~` or through a symbolic link | The guard resolves each tool's `path` the way Pi does, refuses it unless it sits inside the folder, then resolves its real path and refuses it again unless that is inside the folder's real path, and hands the tool the checked real path so it reads exactly what was checked (`pi-guard.ts:26-30`, `read-guard.ts:65-69`, `read-guard.ts:85-115`, `pi-guard.ts:71-78`). |
| Credential paths: SSH keys (`~/.ssh`), GPG keys (`~/.gnupg`), cloud credentials (`~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.kube`, `~/.docker/config.json`), the GitHub login (`~/.config/gh`, `~/.git-credentials`, `~/.config/git/credentials`, `~/.netrc`), `~/.npmrc`, and the agents' own logins (`~/.pi/agent/auth.json`, `~/.claude/.credentials.json`, `~/.codex/auth.json`) | Refused by name before the file system is touched there, whatever the run's folder is, from the list Claude Code's guard shares (`read-guard.ts:31-47`, `read-guard.ts:94-95`). |
| URLs | Any path that reads as a URL is refused (`read-guard.ts:53`, `read-guard.ts:91-93`). |
| Reading anything when the run's folder is not set | The guard blocks every call without `SECOND_LOOK_READ_ROOT` (`pi-guard.ts:45`), which the adapter sets to the run's folder (`pi.ts:88-92`). |
| The GitHub token | Removed from the environment (`pi.ts:88-92`). |
| Network at startup | `--offline`, with `PI_OFFLINE=1` and `PI_TELEMETRY=0` in its environment (`pi.ts:69`, `pi.ts:91`). |
| A session file | `--no-session` (`pi.ts:68`). |

### What from the pull request Pi ignores

The head copy is the pull request's own repository, so it can hold agent configuration. Pi runs with:

- `--no-approve`: Pi's project trust is off, so the copy's own Pi settings are not applied (`pi.ts:70`).
- `--no-extensions`, then `--extension` with the companion's guard only: no extension from the copy or from the reviewer's set loads (`pi.ts:71-73`).
- `--no-skills`, `--no-prompt-templates`, `--no-themes` (`pi.ts:74-77`).
- `--no-context-files`: context files such as `AGENTS.md` and `CLAUDE.md` in the copy are not read as instructions (`pi.ts:77`).
- `--system-prompt` with the companion's own instructions (`pi.ts:80-81`).

### Known gaps for Pi

- **No operating-system sandbox.** Pi has none of its own, so the guard is an extension running inside Pi's process, checking tool calls before they run (`pi-guard.ts:1-19`). It is as strong as Pi's tool-call hook: a Pi bug that skipped the hook, or a tool that read a file without one, would not be stopped by anything below it. Pi runs as the reviewer's own user with the reviewer's own file permissions.
- **Only `path` is checked.** The guard checks and rewrites each tool's `path` argument only (`pi-guard.ts:46-54`). The `pattern` of `find` and the `glob` of `grep` reach the tool unchecked, so keeping them beneath the checked path relies on Pi's own tools.
- **The credential list is a list.** Credentials stored anywhere else under the home folder are not refused by name. They stay out of reach only because they are outside the run's folder; the name list matters as a second line should that confinement fail.
- **The environment is inherited.** Pi inherits the engine's whole environment minus the GitHub token variables (`pi.ts:88-92`). Pi's tools cannot read environment variables, but any other secret in that environment, such as a cloud credential, is in the agent's process.
- **The agent process talks to its model.** "No network access" means no tool that reaches the network. Pi itself still connects to the model provider it is signed in to, and everything the prompt holds — including the pull request's text and code — is sent there. `--offline` stops only its startup network.
- **The reviewer's own Pi settings still apply.** The flags turn off extensions, skills, prompt templates, themes, context files and project trust; nothing in the adapter turns off the reviewer's own user-level Pi settings, which are trusted as the reviewer's.
- **Tests use a fake Pi.** The contract tests drive the adapter against a fake Pi executable (`packages/engine/test/fake-pi.ts`) that checks the arguments it is given; the guard is tested on its own (`packages/engine/test/pi-guard.test.ts`). That a real Pi honours every flag is not tested in CI.

## Claude Code

### What Claude Code can read

Only files of the run's folder — the head copy, or a fetched library's folder — through the tools `Read`, `Grep` and `Glob`, plus `StructuredOutput`, the tool Claude Code returns the schema-checked answer through, which touches no file (`claude-guard-check.ts:34-37`). The run is started with its working directory set to the run's folder (`claude-code.ts:482-488`). The companion's guard, a `PreToolUse` hook Claude Code runs before every tool call, confines each call to that folder (`claude-guard-check.ts:90-108`), and Claude Code's own working-directory check stands behind it, because the run's permission mode is pinned to `default` (`claude-code.ts:186-187`).

### What Claude Code is denied, and how

| Denied | How it is enforced |
| --- | --- |
| A shell, file edits, web fetch and web search, and every tool but the three file-reading ones | Claude Code's tool allowlist, `--tools Read,Grep,Glob` (`claude-code.ts:182-183`), and again by the guard, which denies every tool but those three and `StructuredOutput` before it runs, in case a tool slips past the allowlist (`claude-guard-check.ts:96-99`). |
| Any path outside the run's folder, by absolute path, by `..`, by `~` or through a symbolic link | **Enforced by the companion.** The guard checks Read's `file_path` and Grep's and Glob's `path` with the checks it shares with Pi's guard: it resolves the path the way Claude Code's tools do, refuses it unless it sits inside the folder, then resolves its real path and refuses it again unless that is inside the folder's real path, and refuses a path that does not exist (`claude-guard-check.ts:71-75`, `claude-guard-check.ts:101-107`, `read-guard.ts:65-69`, `read-guard.ts:85-115`). It never answers `allow` and never rewrites a call (`claude-guard-check.ts:115-153`), so a call it passes still meets Claude Code's own working-directory check: with the permission mode pinned to `default`, a read outside the working directory needs approval, which `--permission-prompts none` denies (`claude-code.ts:184-187`). |
| A Glob `pattern` or Grep `glob` that names an absolute path or climbs out with `..` | The guard refuses a pattern that starts with `/`, `\`, `~` or a drive letter, and any `..` segment, inside braces and extended-glob groups too (`claude-guard-check.ts:60-84`). |
| Credential paths: SSH keys (`~/.ssh`), GPG keys (`~/.gnupg`), cloud credentials (`~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.kube`, `~/.docker/config.json`), the GitHub login (`~/.config/gh`, `~/.git-credentials`, `~/.config/git/credentials`, `~/.netrc`), `~/.npmrc`, and the agents' own logins (`~/.pi/agent/auth.json`, `~/.claude/.credentials.json`, `~/.codex/auth.json`) | Refused by name by the guard before the file system is touched there, whatever the run's folder is, from the list it shares with Pi's guard (`read-guard.ts:31-47`, `read-guard.ts:94-95`), and again by permission rules generated from the same list — `Read(~/<path>)`, plus `Read(~/<path>/**)` for a folder — which Claude Code applies to Grep and Glob as well and checks before the hook runs (`claude-code.ts:135-139`, `claude-code.ts:146-156`). |
| URLs | Any path that reads as a URL is refused (`read-guard.ts:53`, `read-guard.ts:91-93`). |
| Reading anything when the run's folder is not set | The guard denies every file-reading call without `SECOND_LOOK_READ_ROOT` (`claude-guard-check.ts:100`), which the adapter sets to the run's folder, with the audit file and `ELECTRON_RUN_AS_NODE` so the editor's binary runs the guard as Node inside VS Code (`claude-code.ts:211-218`). |
| The reviewer's own settings switching the guard off | The guard is passed with `--settings`, which outranks user, project and local settings, with `"disableAllHooks": false` and the hook on every tool (matcher `*`) (`claude-code.ts:146-156`, `claude-code.ts:188-189`). The command-line `--permission-mode default` outranks a `defaultMode` in any settings (`claude-code.ts:186-187`). The guard's deny outranks allow rules, added directories and another hook's `allow`. The hook command is refused when the Node or guard path holds a character that could change it in a shell (`claude-code.ts:116-128`). |
| A run the guard did not see | **Fails closed**, because Claude Code lets a call through when a hook cannot start. The probe runs the exact hook command through a shell on a synthetic read outside an empty copy, and Claude Code is not used unless the guard refuses it and writes its audit line (`claude-code.ts:357-392`, `claude-code.ts:418-427`). A run whose start event reports a permission mode other than `default` fails, and so does a completed run that reports none (`claude-code.ts:575-586`, `claude-code.ts:599-601`). The guard writes one audit line per call (`claude-guard-check.ts:133-140`), and a run with a tool call that has no audit line and that Claude Code did not report denied itself fails, its answer discarded (`claude-code.ts:569-590`). The hook blocks the call with exit code 2 on any error of its own (`claude-guard.ts:14-35`). |
| MCP servers | `--strict-mcp-config` with no MCP configuration named, so every MCP configuration, the copy's `.mcp.json` included, is ignored (`claude-code.ts:181`). |
| The GitHub token | Removed from the environment (`claude-code.ts:199-203`). |
| Non-essential network traffic at startup | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` in its environment (`claude-code.ts:202`). |
| A session file | `--no-session-persistence` (`claude-code.ts:178`). |

### What from the pull request Claude Code ignores

- `--setting-sources user`: only the reviewer's user-level settings load; the copy's project settings (`.claude/settings.json`) and local settings (`.claude/settings.local.json`), and the copy's own context, stay out (`claude-code.ts:45-47`, `claude-code.ts:179-180`).
- `--strict-mcp-config`: the copy's MCP servers stay out (`claude-code.ts:181`).
- `--system-prompt` with the companion's own instructions, and `--json-schema` with the answer's schema, which Claude Code checks before returning (`claude-code.ts:190-192`).

### Known gaps for Claude Code

- **Why the permission mode is pinned: Claude Code's `auto` mode.** Claude Code 2.1.289 starts Opus 5.5 and Sonnet 5 sessions in its `auto` permission mode, and Haiku in `default`. In `auto` mode, Read, Grep and Glob outside the working directory run without asking, so `--permission-prompts none` never comes into play: before the guard, a run with the adapter's flags read `/etc/hosts`, a file outside the copy, `../` and symbolically linked paths, and an absolute Glob pattern, while the same run on Haiku was denied. That was the dependence on the model earlier live runs showed. The guard refuses those calls on every model, and the pinned `--permission-mode default` removes the cause, so Claude Code's own working-directory check stands behind the guard. The probe still checks a setup: `second-look-engine probe <pull-request-url> --agent claude-code --model <model> --target /etc/hosts` must report `refused` for that target.
- **A managed policy that disables hooks is detected, not prevented.** Settings an organisation manages for Claude Code outrank `--settings`, so a policy-level `disableAllHooks` or `allowManagedHooksOnly` would keep the guard from running. The pinned `default` mode still denies reads outside the working directory then, and the run fails because its tool calls have no audit line — but only after the run, so whatever an unguarded call read has already reached the model provider. This was not tested live: no managed policy exists on the machine the guard was tested on.
- **A relative pattern that climbs with `..` rests on the guard alone.** Without the guard, Claude Code's own check does not refuse a Glob pattern or Grep glob such as `../outside/*`; in live runs its search stayed in the working directory and found nothing.
- **Windows is untested.** Claude Code hands the hook command to a shell. That the command's quoting holds there, and that the editor's binary runs the guard as Node, is proven live on macOS only; Linux uses the same mechanism with no platform-specific code but was not run live. The probe refuses a guard that does not run on any platform, but the guard is not claimed for Windows until it is tested there.
- **No operating-system sandbox.** The guard is a hook Claude Code runs as its own process before each tool call (`claude-guard.ts`), so it is as strong as Claude Code's hook runner; Claude Code runs as the reviewer's own user with the reviewer's own file permissions.
- **A response stopped by Anthropic's safety classifier fails the run.** When the classifier stops a response while its tool call is streaming, Claude Code reports that call as interrupted and the call never reaches the hook, so the run fails rather than trust it.
- **The credential list is a list.** Credentials stored anywhere else under the home folder are not refused by name. They stay out of reach only because they are outside the run's folder.
- **The reviewer's user-level settings load.** `--setting-sources user` keeps the reviewer's own settings (`claude-code.ts:179-180`), so their allow rules, added directories and hooks still load; the guard's deny outranks them, and `disableAllHooks` is pinned off.
- **The environment is inherited.** Claude Code inherits the engine's whole environment minus the GitHub token variables (`claude-code.ts:199-203`). Its file tools cannot read environment variables, but any other secret in that environment is in the agent's process — and some are meant to be: an `ANTHROPIC_API_KEY`, an OAuth token or cloud credentials for Amazon Bedrock or Google Vertex AI are how Claude Code signs in (`claude-code.ts:229-248`).
- **The agent process talks to its model.** "No network access" means no tool that reaches the network. Claude Code itself still connects to its model provider, and everything the prompt holds is sent there.
- **That the copy's context stays out rests on Claude Code.** The companion relies on `--setting-sources user` to keep the copy's `CLAUDE.md` and project settings out; nothing in the companion checks that a given Claude Code version does.
- **Live runs are opt-in.** The contract tests drive the adapter against a fake Claude Code executable (`packages/engine/test/fake-claude.ts`) that checks the arguments it is given and runs the real guard hook on its tool calls; the guard is tested on its own (`packages/engine/test/claude-guard.test.ts`). An opt-in live suite, `npm run test:live-claude` (`packages/engine/test/live/claude-guard.live.test.ts`), drives the real adapter on the reviewer's own Claude Code and spends subscription quota, so it never runs in CI.

## Codex

Codex is not supported yet: there is no adapter, the engine refuses the name (`agents.ts:15`, `agents.ts:39-43`), and the companion never starts it. Its limits will be documented here when its adapter lands.

The one place Codex appears in the code today is the guards' shared credential list: Codex's login, `~/.codex/auth.json`, is refused to Pi and Claude Code like every other agent's login (`read-guard.ts:46`).

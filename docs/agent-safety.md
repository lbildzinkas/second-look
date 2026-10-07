# What agents can read, reach and run

The companion drives the reviewer's installed coding agent on text other people wrote: a pull request's code, its description, its linked issues, its pipeline report and its CI logs. This page lists, for each agent the companion drives, what the agent may read, what it is denied, and how each limit is enforced, then the gaps where a limit is weaker than it reads. Every statement points at the code that makes it true, at the commit this page was written against; when the code and this page disagree, the code wins and this page is wrong.

Paths are relative to `packages/engine/src/` unless they name another folder.

## Which agents

| Agent | Supported | Adapter |
| --- | --- | --- |
| Pi | yes | `pi.ts`, with the guard `pi-guard.ts` |
| Claude Code | yes | `claude-code.ts` |
| Codex | **no, not yet** | none |

The engine drives only the agents `AGENT_NAMES` lists, `pi` and `claude-code` (`agents.ts:15`), and refuses any other name with an error (`agents.ts:39-43`). [ADR 0004](adr/0004-drive-installed-agent-clis.md) names Codex as an agent to drive, but no Codex adapter exists, so nothing on this page applies to Codex and the companion never starts it.

## What every agent run shares

These hold for both agents, because they come from the engine rather than from either adapter.

### The agent is started in one folder, a read-only copy

- **The folder.** Each run is started with its working directory set to one folder (`pi.ts:197-203`, `claude-code.ts:241-247`): the head copy of the pull request for every review pass and ask (for example `review.ts:300`, `asks.ts:64`), or, after the reviewer presses a library fetch, that library's fetched folder alone (`library-verdicts.ts:252`). The base copy, the reviewer's workspace and the rest of the cache are never the run's folder.
- **Read-only.** The copies and fetched libraries are all written by `archive.ts`, with every file mode `0444` and every folder `0555` (`archive.ts:18-19`, `archive.ts:168-175`), so nothing in them can be written or run in place. Each copy is unpacked from the commit's archive into the engine's cache (`cache.ts:80-107`): nothing is checked out in the reviewer's workspace, and nothing from the pull request is built, installed or run.
- **No links out.** Symbolic links, hard links and special files in an archive are skipped, never written, and an entry whose path would leave the folder is refused (`archive.ts:139-149`, `archive.ts:179-187`). A copy therefore holds no link an agent could follow out of it.

### The agent has no GitHub login

The engine removes `GITHUB_TOKEN`, `GH_TOKEN`, `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` from every agent's environment (`agent.ts:146-151`, applied at `pi.ts:87-91` and `claude-code.ts:107-111`). The token the engine holds lives only in its GitHub client's memory (`github.ts:58-70`). In VS Code the token comes from VS Code's authentication API with each request and is never put in the engine's environment (`packages/extension/src/engine-client.ts:84-85` passes the editor's environment, not a token).

### The agent signs in with its own login, which the companion never reads

The agent uses whatever login the reviewer gave it. The companion never opens, reads or stores it. For Claude Code it only checks which kind of login is present, by the names of environment variables, and stamps that on the run (`claude-code.ts:122-141`); an `ANTHROPIC_API_KEY` is checked for presence only.

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
- **Checked, not trusted.** Every answer is checked against its schema and the task's own checks — that every line it cites is in the copy, every id it names was offered — before anything is shown; an invalid answer is retried once and then reported as a failure, never guessed (`agent.ts:262-314`).

### The trusted instructions used instead

The agent runs on the companion's own system prompt, passed with `--system-prompt` and replacing the agent's default (`pi.ts:79-80`, `claude-code.ts:98-99`): the instructions of each pass, versioned and evaluated with it ([ADR 0006](adr/0006-no-prompt-without-its-evaluation.md)). The task goes on stdin, so no argument can be read as a file to attach (`pi.ts:204-205`, `claude-code.ts:248-249`). For Pi, the one extension loaded is the companion's own guard, from the engine's install (`pi.ts:37-38`, `pi.ts:71-72`).

### The agent is never run with a weaker lockdown

Before any run, each adapter reads the installed agent's `--help` and refuses to run a version that lacks any flag of its lockdown (`pi.ts:22-35`, `pi.ts:161-166`; `claude-code.ts:51-62`, `claude-code.ts:206-211`). The probe itself runs `--version` and `--help` from the system's temporary folder, not from any copy (`pi.ts:100-115`, `claude-code.ts:150-165`).

## Pi

### What Pi can read

Only files of the run's folder — the head copy, or a fetched library's folder — through the tools `read`, `grep`, `find` and `ls` (`pi-guard.ts:23`).

### What Pi is denied, and how

| Denied | How it is enforced |
| --- | --- |
| A shell, file edits, and every tool but the four file-reading ones | Pi's tool allowlist, `--tools read,grep,find,ls` (`pi.ts:77-78`), and again by the guard, which blocks any other tool before it runs in case a Pi version ignores the allowlist (`pi-guard.ts:77-79`). |
| Any path outside the run's folder, by absolute path, by `..`, by `~` or through a symbolic link | The guard resolves each tool's `path` the way Pi does, refuses it unless it sits inside the folder, then resolves its real path and refuses it again unless that is inside the folder's real path, and hands the tool the checked real path so it reads exactly what was checked (`pi-guard.ts:59-65`, `pi-guard.ts:93-115`, `pi-guard.ts:132-139`). |
| Credential paths: SSH keys (`~/.ssh`), GPG keys (`~/.gnupg`), cloud credentials (`~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.kube`, `~/.docker/config.json`), the GitHub login (`~/.config/gh`, `~/.git-credentials`, `~/.config/git/credentials`, `~/.netrc`), `~/.npmrc`, and the agents' own logins (`~/.pi/agent/auth.json`, `~/.claude/.credentials.json`, `~/.codex/auth.json`) | Refused by name before the file system is touched there, whatever the run's folder is (`pi-guard.ts:29-45`, `pi-guard.ts:94-96`). |
| URLs | Any path that reads as a URL is refused (`pi-guard.ts:50`, `pi-guard.ts:90-92`). |
| Reading anything when the run's folder is not set | The guard blocks every call without `SECOND_LOOK_READ_ROOT` (`pi-guard.ts:80`), which the adapter sets to the run's folder (`pi.ts:87-91`). |
| The GitHub token | Removed from the environment (`pi.ts:87-91`). |
| Network at startup | `--offline`, with `PI_OFFLINE=1` and `PI_TELEMETRY=0` in its environment (`pi.ts:68`, `pi.ts:90`). |
| A session file | `--no-session` (`pi.ts:67`). |

### What from the pull request Pi ignores

The head copy is the pull request's own repository, so it can hold agent configuration. Pi runs with:

- `--no-approve`: Pi's project trust is off, so the copy's own Pi settings are not applied (`pi.ts:69`).
- `--no-extensions`, then `--extension` with the companion's guard only: no extension from the copy or from the reviewer's set loads (`pi.ts:70-72`).
- `--no-skills`, `--no-prompt-templates`, `--no-themes` (`pi.ts:73-76`).
- `--no-context-files`: context files such as `AGENTS.md` and `CLAUDE.md` in the copy are not read as instructions (`pi.ts:76`).
- `--system-prompt` with the companion's own instructions (`pi.ts:79-80`).

### Known gaps for Pi

- **No operating-system sandbox.** Pi has none of its own, so the guard is an extension running inside Pi's process, checking tool calls before they run (`pi-guard.ts:1-17`). It is as strong as Pi's tool-call hook: a Pi bug that skipped the hook, or a tool that read a file without one, would not be stopped by anything below it. Pi runs as the reviewer's own user with the reviewer's own file permissions.
- **Only `path` is checked.** The guard checks and rewrites each tool's `path` argument only (`pi-guard.ts:81-93`). The `pattern` of `find` and the `glob` of `grep` reach the tool unchecked, so keeping them beneath the checked path relies on Pi's own tools.
- **The credential list is a list.** Credentials stored anywhere else under the home folder are not refused by name. They stay out of reach only because they are outside the run's folder; the name list matters as a second line should that confinement fail.
- **The environment is inherited.** Pi inherits the engine's whole environment minus the GitHub token variables (`pi.ts:87-91`). Pi's tools cannot read environment variables, but any other secret in that environment, such as a cloud credential, is in the agent's process.
- **The agent process talks to its model.** "No network access" means no tool that reaches the network. Pi itself still connects to the model provider it is signed in to, and everything the prompt holds — including the pull request's text and code — is sent there. `--offline` stops only its startup network.
- **The reviewer's own Pi settings still apply.** The flags turn off extensions, skills, prompt templates, themes, context files and project trust; nothing in the adapter turns off the reviewer's own user-level Pi settings, which are trusted as the reviewer's.
- **Tests use a fake Pi.** The contract tests drive the adapter against a fake Pi executable (`packages/engine/test/fake-pi.ts`) that checks the arguments it is given; the guard is tested on its own (`packages/engine/test/pi-guard.test.ts`). That a real Pi honours every flag is not tested in CI.

## Claude Code

### What Claude Code can read

The run's folder — the head copy, or a fetched library's folder — through the tools `Read`, `Grep` and `Glob` (`claude-code.ts:45`), and, when Claude Code's own confinement fails, whatever lies outside it. The run is started with its working directory set to the run's folder (`claude-code.ts:241-247`), and with `--permission-prompts none` anything that would ask for permission is denied rather than asked (`claude-code.ts:96-97`): that is the intended confinement of the file tools to the working directory. It is Claude Code's own, not the companion's, and it does not hold reliably — live runs showed it to depend on the model (see the gaps below), so anything the reviewer's own user can read must be treated as within Claude Code's reach.

### What Claude Code is denied, and how

| Denied | How it is enforced |
| --- | --- |
| A shell, file edits, web fetch and web search, and every tool but the three file-reading ones | Claude Code's tool allowlist, `--tools Read,Grep,Glob` (`claude-code.ts:94-95`). |
| Any path outside the run's folder, including every credential path — SSH keys, cloud credentials, the GitHub login, its own and other agents' logins | **Not a denial the companion enforces.** The intended mechanism is Claude Code's own confinement of its file tools to the working directory, with permission prompts denied (`claude-code.ts:96-97`, `claude-code.ts:241-247`); the companion adds no check of its own and refuses no credential path by name, and that confinement was falsified in live runs — it held with one model and not with another (see the gaps). Treat these paths as readable. |
| MCP servers | `--strict-mcp-config` with no MCP configuration named, so every MCP configuration, the copy's `.mcp.json` included, is ignored (`claude-code.ts:93`). |
| The GitHub token | Removed from the environment (`claude-code.ts:107-111`). |
| Non-essential network traffic at startup | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` in its environment (`claude-code.ts:110`). |
| A session file | `--no-session-persistence` (`claude-code.ts:90`). |

### What from the pull request Claude Code ignores

- `--setting-sources user`: only the reviewer's user-level settings load; the copy's project settings (`.claude/settings.json`) and local settings (`.claude/settings.local.json`), and the copy's own context, stay out (`claude-code.ts:23-25`, `claude-code.ts:91-92`).
- `--strict-mcp-config`: the copy's MCP servers stay out (`claude-code.ts:93`).
- `--system-prompt` with the companion's own instructions, and `--json-schema` with the answer's schema, which Claude Code checks before returning (`claude-code.ts:98-100`).

### Known gaps for Claude Code

- **No operating-system sandbox, and no companion-side guard.** Every limit is a flag Claude Code honours itself. Unlike Pi, there is no guard of the companion's own checking each tool call, so path confinement and the denial of credential paths rest entirely on Claude Code's confinement of its file tools to the working directory. Claude Code runs as the reviewer's own user with the reviewer's own file permissions.
- **Confinement to the run's folder failed in a live run, and depends on the model.** Locked down exactly as this page describes — working directory a read-only copy (`claude-code.ts:241-247`), `--tools Read,Grep,Glob` (`claude-code.ts:94-95`), `--permission-prompts none` (`claude-code.ts:96-97`) — Claude Code 2.1.289, driven through the engine's own adapter, read `/etc/hosts` from outside the copy with its default model (`claude-opus-5-5`) and reached a path under `~/.ssh` un-blocked (the tool answered "File does not exist", not a denial), while the identical run pinned to `--model haiku` was denied ("Path is outside allowed working directories"). Nothing the companion runs beside Claude Code can close this from outside its process, so a reviewer must not trust the outside-folder denial for a setup they have not checked: run `second-look-engine probe <pull-request-url> --agent claude-code --model <model> --target /etc/hosts` (any path outside the copy serves) and read the report's `outcome` for that target — `refused` is the denial holding, `read` is it failing.
- **The reviewer's user-level settings load.** `--setting-sources user` keeps the reviewer's own settings (`claude-code.ts:91-92`). A user-level permission rule that allows reading outside the working directory, or an added directory, would widen what the agent may read, and the reviewer's own hooks still run. The companion does not inspect those settings.
- **The environment is inherited.** Claude Code inherits the engine's whole environment minus the GitHub token variables (`claude-code.ts:107-111`). Its file tools cannot read environment variables, but any other secret in that environment is in the agent's process — and some are meant to be: an `ANTHROPIC_API_KEY`, an OAuth token or cloud credentials for Amazon Bedrock or Google Vertex AI are how Claude Code signs in (`claude-code.ts:122-141`).
- **The agent process talks to its model.** "No network access" means no tool that reaches the network. Claude Code itself still connects to its model provider, and everything the prompt holds is sent there.
- **That the copy's context stays out rests on Claude Code.** The companion relies on `--setting-sources user` to keep the copy's `CLAUDE.md` and project settings out; nothing in the companion checks that a given Claude Code version does.
- **Tests use a fake Claude Code.** The contract tests drive the adapter against a fake Claude Code executable (`packages/engine/test/fake-claude.ts`) that checks the arguments it is given. That a real Claude Code honours every flag is not tested in CI.

## Codex

Codex is not supported yet: there is no adapter, the engine refuses the name (`agents.ts:15`, `agents.ts:39-43`), and the companion never starts it. Its limits will be documented here when its adapter lands.

The one place Codex appears in the code today is the Pi guard's credential list: Codex's login, `~/.codex/auth.json`, is refused to Pi like every other agent's login (`pi-guard.ts:44`).

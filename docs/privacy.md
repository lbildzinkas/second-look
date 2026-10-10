# What stays on the machine and what is sent

The companion works on text written by other people — a pull request's code, its description, its linked issues, its CI logs — so this page says plainly what it keeps on your machine, what it sends to GitHub, and what reaches your model provider. The security detail — what each agent can read, what it is denied and how each limit is enforced — is in [What agents can read, reach and run](agent-safety.md); this page stays at the level of data.

## What stays on your machine

**The cache.** The engine keeps a per-pull-request cache — read-only copies of the base and head versions of the change, downloaded as archives; the libraries you fetch; your reviewed marks; the record of your last look — in the platform's per-user cache folder: `~/Library/Caches/second-look` on macOS, `~/.cache/second-look` on Linux, `%LOCALAPPDATA%\second-look\cache` on Windows. The `SECOND_LOOK_CACHE_DIR` environment variable names another folder when the editor was started with one. Nothing is ever checked out into your workspace, and the copies are written with read-only file modes — nothing from the pull request is built, installed or run. To delete a cache, make it writable first, because the files themselves are read-only: `chmod -R u+w ~/.cache/second-look && rm -rf ~/.cache/second-look` (adjust the path per platform).

**The GitHub token.** In VS Code the token comes from the editor's built-in GitHub sign-in, travels with each request to the engine, is used only for that request, and is never written to disk or logs. It never reaches the agent: the engine removes the GitHub token variables from every agent's environment.

**The agent's login.** The agent you chose signs in with its own login, which the companion never opens, reads or stores. For Claude Code it checks only which kind of login is present, to stamp the run and to say in the probe of the installed agents which one it would use. The `second-look.agentAccount` setting is a label you type yourself, nothing more.

**Your reviewed marks.** Kept locally, per pull request, keyed by each part's content, in the pull request's own cache folder. They are sent nowhere unless you turn the mirror setting on (below).

**The engine's own settings and stamps.** What the settings choose, and what each run reports — agent, version, model, effort, run date, tokens and cost when the agent reports them — stay in the results shown to you and in nothing else.

## What is sent to GitHub

**Reads, with your token.** One review reads the pull request's metadata, its description in full (never truncated), its full diff, the repository's `.gitattributes` at the head commit (for the noise labels), the issues the pull request links, the CI check runs with their annotations and the logs of failed GitHub Actions jobs, and — to know where your last look was, when no local record exists — your last submitted review. Base and head archives are downloaded for the read-only copies. All of it is read-only.

**The list of your pull requests.** Listing your open pull requests to pick one runs one read-only GitHub search per group — review requested from you, yours, involving you, and open in the open folder's repository when it is a GitHub one — with your token, and reads each one's title, author, the start of its description, its review state and its size. Whether new commits landed since your last look comes from the local record of your last look, which the list only reads: nothing is stored.

**Writes, only when you press.** The companion's one write is the review you submit: pressing Submit on the Send review page asks for the GitHub sign-in at that moment and sends one request, every comment mapped to its position and the whole review pinned to the head commit it read. With the `second-look.mirrorViewedToGitHub` setting on, marking the last part of a file reviewed also marks that whole file **Viewed** on GitHub. Nothing else is ever written: the companion never posts a comment, a review or a reaction on its own.

## What reaches your model provider

The agent runs on your machine but talks to the model provider it is signed in to, and everything its prompt holds — including the pull request's code and text — is sent there. That is what the agent is for, and it is the same traffic the agent makes when you use it yourself. Around it, the companion holds the line it can: the pull request's text reaches the agent cleaned and fenced as data, never as instructions; every answer is checked before anything is shown; and the agent itself runs with file-reading tools only, on a read-only copy, with no network tool and no GitHub token. [What agents can read, reach and run](agent-safety.md) documents each limit and each known gap, per agent.

## The other downloads

Besides GitHub, the engine itself — never the agent — downloads three kinds of thing, each on a named public host over https with no credentials:

- **A library you fetch**, only when you press the link on a finding: the exact version the project pins, from the ecosystem's own host (PyPI's file host, nuget.org, npm, crates.io, the Go module proxy, Maven Central, or a tag archive from GitHub or GitLab), checked against the hash the project pins before anything is unpacked, then unpacked read-only and never built, installed or run.
- **Documentation inventories**, after each review that uses a pinned library's APIs: the documentation host PyPI names for the pinned release, and `learn.microsoft.com` for .NET. Capped, no redirects, no credentials.
- **The .NET decompiler's input**, when you press a decompile: the exact package, hash-checked as above. The decompiler itself runs with the network cut by the operating system.

A documentation page the agent suggests is never fetched; it is checked only as an address and shown labelled as a suggestion.

## Where to read more

- [What agents can read, reach and run](agent-safety.md) — the security document: per agent, what it may read, what it is denied, how each limit is enforced, and the known gaps.
- [The tested models](tested-models.md) — the agent, model and effort combinations the evaluation has been run against, and how each scored.

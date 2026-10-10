# Getting started

Second Look is a VS Code companion for human pull request review: it ranks the change by what matters, checks its claims against real code, and lets the reviewer send comments to GitHub. This page installs it and sets it up; [How a review works](reviewing.md) explains what you see once it runs.

## Installing the extension and the engine

The companion ships as one extension package, a `.vsix` file that carries everything it needs: the extension itself, the engine that does the reading and checking, and the parser grammars for the languages the engine reads. It is one universal package — no per-operating-system builds, no native modules — and there is nothing else to install: the engine is a separate local process, but the extension starts it from its own install and runs it on the editor's own binary, so no Node.js of your own is needed. It needs VS Code 1.90 or later.

Every version tag (`v*`) builds this package exactly as CI builds it and publishes it as an asset of that tag's [GitHub Release](https://github.com/lbildzinkas/second-look/releases), so the repository's Releases section always offers the latest package for download; publishing to the VS Code Marketplace or Open VSX is a separate, manual release step. To install:

1. Download the `.vsix` from the [latest release](https://github.com/lbildzinkas/second-look/releases/latest) — the file is named `second-look-extension-<version>.vsix`, with the version it installs.
2. In VS Code's Extensions view, open the `…` menu and choose **Install from VSIX…**.
3. Pick the downloaded file.

Or from a terminal, with the editor's own command line on the `PATH`:

```sh
code --install-extension second-look-extension-<version>.vsix
```

To update to a newer version, download the newer `.vsix` from the latest release and install it the same way — installing a package over the installed extension replaces it, so nothing needs removing first. To uninstall, open Second Look's entry in the Extensions view, choose **Uninstall** from its `…` menu, or run `code --uninstall-extension lbildzinkas.second-look-extension`.

To build the package yourself from source instead, see the repository's [README](../README.md#packaging-the-extension).

## Installing a coding agent

The companion does its model work through a coding agent you already have: it drives the agent you installed and signed in, on your own subscription, and never calls a model provider of its own and never handles the agent's login. One of these must be installed and signed in before a review:

| Agent | What it needs | Started as |
| --- | --- | --- |
| Pi | the `pi` command line tool, installed and signed in with its own login | `pi` |
| Claude Code | the `claude` command line tool, installed and signed in — a stored subscription sign-in, an OAuth token, or cloud credentials in the environment | `claude` |

Codex is not supported yet.

The tool must be on the `PATH` the editor was started with. An agent that is missing, or a version too old for the companion's lockdown, is never run: the engine's agent probe reports what is missing in plain words, the review still completes with the plain passes, and each result says why the agent's was not used.

What each agent may read while it works, what it is denied and how each limit is enforced — including the known gaps — is documented in [What agents can read, reach and run](agent-safety.md).

One optional extra: when a review's finding offers to decompile a .NET package that has no exact source, the companion runs ILSpy's `ilspycmd` as you installed it. Install it with `dotnet tool install --global ilspycmd` if you want that route; it is looked for on the `PATH` and in `~/.dotnet/tools`, and it is run with the network cut on macOS and Linux — on Windows nothing is decompiled yet. Nothing else needs it.

## Choosing the agent, model, effort and account

The settings live under the `second-look` section (Settings, then search for "second look"):

| Setting | What it picks | Default |
| --- | --- | --- |
| `second-look.agent` | The agent every agent pass of a review runs on: `pi` or `claude-code`. | `pi` |
| `second-look.agentModel` | The model, in the agent's own naming — for example `anthropic/claude-sonnet-5` for Pi or `sonnet` for Claude Code. | empty: the agent's own default model |
| `second-look.agentEffort` | The effort (thinking) level, one the agent accepts — for example `low`, `medium`, `high`, `xhigh` or `max` for Claude Code, or `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` for Pi. | empty: the agent's own default effort |
| `second-look.agentAccount` | A label for the account or subscription the agent bills, such as `Claude Max (work address)`. | empty: hidden |
| `second-look.criteriaHeading` | The heading the acceptance criteria checklist sits under in the issues a pull request links. | `Acceptance criteria` |
| `second-look.mirrorViewedToGitHub` | Whether reviewed marks are mirrored to GitHub's "Viewed" checkbox. Off by default, because the GitHub Pull Requests extension syncs the same field. | off |
| `second-look.budget.agentRuns` | The most agent runs one review may start, a retry included. | `0`: no limit |
| `second-look.budget.filesFetched` | The most files one review may download. | `0`: no limit |
| `second-look.budget.downloadMiB` | The most mebibytes one review may download. | `0`: no limit |

The agent, model, effort and account live in the user settings only: a workspace or folder settings file, such as a pull request's own `.vscode/settings.json`, cannot change them, and VS Code lists them as restricted in an untrusted workspace. The engine refuses, before any agent starts, a model or effort that is not a plain name — letters, digits and `.` `_` `-` `/` `:`, not starting with `-` — and an effort the chosen agent does not accept, and says why.

The budget settings live in the user settings only too, and travel with each review request. The engine meters the review against them — every agent run it starts, every file it downloads and their bytes, its later library fetches, asks and drafts included — and the review's result carries the limits and the use so far as `budget`. The review stops at them: an agent pass starts only while a run is left, and what the limit leaves, such as claims and acceptance criteria, stays not checked with the limit as the reason; documentation and library downloads past the file or size limit are refused, but the review's own reads of the pull request never are. Asks and drafts are only counted.

The agent, model, effort and account travel with each review request, so switching them needs no restart: the next review runs its agent passes on the new choice, and every agent-produced result is stamped with it, the effort that answered included — shown as `default effort` when the run asked for none.

The status bar always shows what is in use, as `Second Look: Pi · default model · default effort` — or, say, `Second Look: Claude Code · claude-sonnet-5-5 · effort high` — with the account label beside it when one is set, and a gear before it until you choose anything. A beaker before it warns that the chosen agent, model and effort were never tested by the companion's evaluation, with the full warning in its tooltip — the warning blocks nothing, every review still runs and is stamped with who answered — naming where the current list is published: [the tested models](tested-models.md). When Claude Code is the agent, it also warns when an `ANTHROPIC_API_KEY` inherited from the editor's environment silently overrides the subscription sign-in.

Clicking the status bar, or running **Second Look: Choose agent and model**, opens a quick pick of the agent, the model (with the effort it was tested at, where it was), the effort and the account label: each pick writes that one value to your user settings, and changing the agent goes on to its model and effort. Its last item, **Open the setup in the side bar**, focuses the Second Look side bar. A value your workspace settings set overrides the user one, so the quick pick marks it and warns when your change would not take effect.

### Which passes the agent runs

The grouping pass always runs on the chosen agent, and the ranking pass runs on it only for an agent, model and effort whose evaluation matched or beat the plain ranking; elsewhere the plain ranking stays and each result says which ranking it shows and why. [The tested models](tested-models.md) lists the tested combinations and their scores.

### Billing and subscriptions

Every agent run bills the login the agent is signed in with — your subscription, your keys. The companion never reads, stores or copies that login: the account setting is only a label you give it, stamped on the results. Each run also carries a stamp — the agent, its version, the model, the effort, the run date, and the tokens and cost when the agent reports them — so you can always tell which agent, model and effort said what.

## Starting a review

1. Click the **Second Look** icon in the Activity Bar (an eye with a check mark), then the **Review a pull request** button on the side bar's second step, or the pull request button in the view's title bar. Running **Second Look: Review pull request** from the Command Palette does the same: the Second Look side bar opens when the review starts.
2. Paste a GitHub pull request URL, such as `https://github.com/{owner}/{repo}/pull/{number}`.
3. Sign in with VS Code's built-in GitHub login when it asks (the `repo` scope of the editor's GitHub account).

The review fills the Second Look side bar and the overview tab opens beside it; results arrive in stages while the agent works. [How a review works](reviewing.md) walks through each one.

## Where the companion keeps things

The engine keeps a per-pull-request cache on your machine — read-only copies of the change, fetched libraries, your reviewed marks, the record of your last look — in the platform's per-user cache folder: `~/Library/Caches/second-look` on macOS, `~/.cache/second-look` on Linux, `%LOCALAPPDATA%\second-look\cache` on Windows. Nothing is ever checked out or written into your workspace. [What stays on the machine and what is sent](privacy.md) explains in full what is kept, what is sent to GitHub and what reaches the model provider.

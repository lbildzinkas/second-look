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

The tool must be on the `PATH` the editor was started with, or named by its path setting below. An agent that is missing, or a version too old for the companion's lockdown, is never run: the engine's agent probe reports what is missing in plain words, the review still completes with the plain passes, and each result says why the agent's was not used.

What each agent may read while it works, what it is denied and how each limit is enforced — including the known gaps — is documented in [What agents can read, reach and run](agent-safety.md).

One optional extra: when a review's finding offers to decompile a .NET package that has no exact source, the companion runs ILSpy's `ilspycmd` as you installed it. Install it with `dotnet tool install --global ilspycmd` if you want that route; it is looked for on the `PATH` and in `~/.dotnet/tools`, and it is run with the network cut on macOS and Linux — on Windows nothing is decompiled yet. Nothing else needs it.

## Choosing the agent, model, effort and account

The settings live under the `second-look` section of the editor's Settings — opened straight at the companion's own settings by the Second Look side bar's title `⋯` menu, **Open Second Look settings** — or by searching Settings for "second look":

| Setting | What it picks | Default |
| --- | --- | --- |
| `second-look.agent` | The agent every agent pass of a review runs on: `pi` or `claude-code`. | `pi` |
| `second-look.agentModel` | The model, in the agent's own naming — for example `anthropic/claude-sonnet-5` for Pi or `sonnet` for Claude Code. | empty: the agent's own default model |
| `second-look.agentEffort` | The effort (thinking) level, one the agent accepts — for example `low`, `medium`, `high`, `xhigh` or `max` for Claude Code, or `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` for Pi. | empty: the agent's own default effort |
| `second-look.agentAccount` | A label for the account or subscription the agent bills, such as `Claude Max (work address)`. | empty: hidden |
| `second-look.claudeCodePath` | The absolute path of the Claude Code executable, started in place of `claude`. User settings only. | empty: `claude` on the `PATH` |
| `second-look.piPath` | The absolute path of the Pi executable, started in place of `pi`. User settings only. | empty: `pi` on the `PATH` |
| `second-look.jira.site` | The Jira Cloud site to read tickets from, such as `your-team.atlassian.net`, needed only when your Atlassian account reaches several. Only an `atlassian.net` site is accepted. User settings only. | empty: the account's only site |
| `second-look.criteriaHeading` | The heading the acceptance criteria checklist sits under in the issues a pull request links. | `Acceptance criteria` |
| `second-look.mirrorViewedToGitHub` | Whether reviewed marks are mirrored to GitHub's "Viewed" checkbox. Off by default, because the GitHub Pull Requests extension syncs the same field. | off |
| `second-look.budget.agentRuns` | The most agent runs one review may start, a retry included. | `0`: no limit |
| `second-look.budget.filesFetched` | The most files one review may download. | `0`: no limit |
| `second-look.budget.downloadMiB` | The most mebibytes one review may download. | `0`: no limit |

The agent, model, effort, account, each agent's executable path and the Jira site live in the user settings only: a workspace or folder settings file, such as a pull request's own `.vscode/settings.json`, cannot change them, and VS Code lists them as restricted in an untrusted workspace. Each VS Code profile keeps its own user settings, so they can differ per profile (see [A separate profile for work](#a-separate-profile-for-work)). The engine refuses, before any agent starts, a model or effort that is not a plain name — letters, digits and `.` `_` `-` `/` `:`, not starting with `-` — and an effort the chosen agent does not accept, and says why.

The budget settings live in the user settings only too, and travel with each review request. The engine meters the review against them — every agent run it starts, every file it downloads and their bytes, its later library fetches, CI log reads, asks and drafts included — and the review's result carries the limits and the use so far as `budget`. The review stops at them: an agent pass starts only while a run is left, and what the limit leaves, such as claims and acceptance criteria, stays not checked with the limit as the reason; documentation and library downloads past the file or size limit are refused, but the review's own reads of the pull request never are. Asks and drafts are only counted.

The agent, model, effort, account and the agent's path travel with each review request, so switching them needs no restart: the next review runs its agent passes on the new choice, and every agent-produced result is stamped with it, the effort that answered included — shown as `default effort` when the run asked for none.

The status bar always shows what is in use, as `Second Look: Pi · default model · default effort` — or, say, `Second Look: Claude Code · claude-sonnet-5-5 · effort high` — with the account label beside it when one is set, and a gear before it until you choose anything. A beaker before it warns that the chosen agent, model and effort were never tested by the companion's evaluation, with the full warning in its tooltip — the warning blocks nothing, every review still runs and is stamped with who answered — naming where the current list is published: [the tested models](tested-models.md). When Claude Code is the agent, it also warns when an `ANTHROPIC_API_KEY` inherited from the editor's environment silently overrides the subscription sign-in. While a review runs, it instead spins and names the stage running, its place and who works on it; [how a review works](reviewing.md) shows what it says.

Clicking the status bar, or running **Second Look: Choose agent and model**, opens a quick pick of the agent, the model (with the effort it was tested at, where it was), the effort and the account label: each pick writes that one value to your user settings, and changing the agent goes on to its model and effort. Its last item, **Open the setup in the side bar**, opens the setup form in step 1 of the Second Look side bar. A value your workspace settings set overrides the user one, so the quick pick marks it and warns when your change would not take effect.

The setup form opens by itself once, the first time you open the side bar with no `second-look.agent` setting; after that, step 1's **change** link and the quick pick open it. It shows a card per agent from the engine's probe — its version, "ready" and the login it would use, or "not found" with an install link — then the model, the tested ones first and marked with the effort they were tested at, the agent's own default, then **Other…** to type any model; the effort levels, the default first and the tested one marked; and the optional account label. **Save** writes the agent, model, effort and account to your user settings, checked as the engine checks them; **Use the defaults** closes the form and writes nothing. **Test** runs the chosen agent, model and effort once, on a tiny locked-down prompt, only when you press it, and shows ok with the run's stamp or why it failed. When the probe finds no chosen agent, and only then, an agent path field writes that agent's path setting to your user settings, and the probe runs again.

### A separate profile for work

Your work reviews may need a different Claude account from your own, so that work code and work tickets only reach the account your work allows. A VS Code profile keeps that apart. Create one with **Profiles: New Profile…**, open your work folders in it, and set the agent settings in that profile's user settings: each profile has its own `second-look.agent`, `agentModel`, `agentEffort`, `agentAccount`, `claudeCodePath`, `piPath` and `jira.site`. Setting a label such as `Claude Max (work address)` in `second-look.agentAccount` stamps it on every result from that profile.

A profile changes the companion's settings, not which account Claude Code is signed in to: every `claude` on the machine shares one sign-in, kept in `~/.claude`, unless `CLAUDE_CONFIG_DIR` names another folder. To give the work profile its own Claude sign-in, point its `second-look.claudeCodePath` at a small script that sets that folder and starts Claude Code, for example `~/bin/claude-work`:

```sh
#!/bin/sh
CLAUDE_CONFIG_DIR="$HOME/.claude-work" exec claude "$@"
```

Make it executable (`chmod +x ~/bin/claude-work`), sign it in once from a terminal with `~/bin/claude-work` and `/login` on the work account, and give its absolute path to `second-look.claudeCodePath` in the work profile. Step 1's login line and every stamp then come from that sign-in, and so does the Jira row's Atlassian connector, since a claude.ai connector belongs to the Claude account it was authorised on.

### Which passes the agent runs

The grouping pass always runs on the chosen agent, and the ranking pass runs on it only for an agent, model and effort whose evaluation matched or beat the plain ranking; elsewhere the plain ranking stays and each result says which ranking it shows and why. [The tested models](tested-models.md) lists the tested combinations and their scores.

### Billing and subscriptions

Every agent run bills the login the agent is signed in with — your subscription, your keys. The companion never reads, stores or copies that login: the account setting is only a label you give it, stamped on the results. Each run also carries a stamp — the agent, its version, the model, the effort, the run date, and the tokens and cost when the agent reports them — so you can always tell which agent, model and effort said what.

## Connecting Jira

A pull request's acceptance criteria may live in a Jira Cloud ticket rather than a GitHub issue. The companion reads Jira through your own Claude Code and its Atlassian connection, never through a Jira token of its own, so it is Claude Code only: with Pi as the agent, step 1's Jira row and step 6 say "Jira criteria need Claude Code". Reviews read the tickets a pull request names through the connection this sets up and checks ([ADR 0010](adr/0010-issue-tracker-sources.md)).

1. **Authorise the Atlassian connector** on claude.ai, under **Settings → Connectors**, signed in to the Claude account this profile's Claude Code uses: your work account for work tickets.
2. Or, if that Claude account has no Atlassian connector, **add Atlassian's own MCP server** once, from a terminal:

   ```sh
   claude mcp add -s user --transport http atlassian https://mcp.atlassian.com/v2/mcp
   claude mcp login atlassian
   ```

3. Open the Jira row at the bottom of step 1's setup form, or press **Connect Jira** in step 6 when a pull request names a Jira key, and press **Check Jira**. It runs Claude Code once, with no copy of the code and only Jira's read tools, and shows one of:
   - **Connected**, with the Jira site it will read from. Type a ticket key and press **Test** to fetch that one ticket: the row shows its key and summary, or why Jira didn't return it.
   - **Needs login**: the connection is there but not signed in. Reconnect the connector on claude.ai, or run `claude mcp login atlassian` for the fallback, then check again.
   - **Not configured**: Claude Code has no Atlassian connection. Do step 1 or 2, then check again.

The site is learned from your Atlassian account. When it reaches more than one Jira site, the row names them all, and `second-look.jira.site` picks one, such as `your-team.atlassian.net`; its **Open the site setting** link opens it. Only an `atlassian.net` site is accepted, and the site chosen is the only one a ticket is ever fetched from. What these runs may do is set out in [What agents can read, reach and run](agent-safety.md).

## Starting a review

1. Click the **Second Look** icon in the Activity Bar (an eye with a check mark). The side bar's second step lists your open pull requests from GitHub, with VS Code's GitHub sign-in: review requested from you, yours, involving you, and open in the folder's repository, each with its short description, review state and size. Typing in its box filters the list; the chips show one group at a time, and the refresh button in the view's title bar reloads it, while the view's badge counts the pull requests waiting on you.
2. Press **Review** on a pull request, or paste a GitHub pull request URL, such as `https://github.com/{owner}/{repo}/pull/{number}`, into the same box. The pull request button in the view's title bar, and **Second Look: Review pull request** from the Command Palette, ask for a URL instead: the Second Look side bar opens when the review starts.
3. Sign in with VS Code's built-in GitHub login when it asks (the `repo` scope of the editor's GitHub account). Signed out, the list offers a **Sign in to GitHub** button; a pasted URL works without it, and the review asks then.

The review fills the Second Look side bar and the overview tab opens beside it; results arrive in stages while the agent works. [How a review works](reviewing.md) walks through each one.

## Where the companion keeps things

The engine keeps a per-pull-request cache on your machine — read-only copies of the change, fetched libraries, your reviewed marks, the record of your last look, the latest review result — in the platform's per-user cache folder: `~/Library/Caches/second-look` on macOS, `~/.cache/second-look` on Linux, `%LOCALAPPDATA%\second-look\cache` on Windows. Nothing is ever checked out or written into your workspace. [What stays on the machine and what is sent](privacy.md) explains in full what is kept, what is sent to GitHub and what reaches the model provider.

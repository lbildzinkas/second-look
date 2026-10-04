# Second Look

Second Look is a VS Code companion for human pull request review: it ranks the change by what matters, checks its claims against real code, and lets the reviewer send comments to GitHub.

- [CONTEXT.md](CONTEXT.md) — the project glossary: the shared words and what they mean.
- [docs/adr/](docs/adr/) — the numbered decision records behind the design.

## Repository layout

The repository is a TypeScript workspace with three packages:

- `packages/engine` — the engine: a separate local process that fetches a pull request, parses its full diff into files and hunks, reads the changed files' syntax trees from read-only copies of the change, and offers its result two ways: printed as typed, versioned JSON by the review command, and over a JSON-RPC protocol on stdio by the serve command (ADR 0005). It also reads portable PDB files, the .NET debug files that record each source file's hash and Source Link URL. It drives the reviewer's installed coding agent, Pi or Claude Code, through one adapter interface (ADR 0004).
- `packages/extension` — the VS Code extension: a thin client that starts the engine as its own process, talks the JSON-RPC protocol to it after a version handshake, and shows the result as the ranked review tree, with each part readable in the editor's multi-file diff over read-only copies, and the review's overview with the story, the claims and their verdicts, and the description, and the findings as the companion's own comment threads on the diff. Its settings pick the agent, the model and the account label; the status bar shows what they choose.
- `packages/evaluation` — the evaluation: runs the engine offline over recorded pull requests and scores it against a stored baseline; see [its README](packages/evaluation/README.md).

The protocol types live in `packages/engine/src/protocol.ts` and `packages/engine/src/rpc.ts`, carry their versions, and are shared by all three packages.

## Building and testing

Requires Node 20 or later. One command installs, type-checks, lints and tests everything:

```sh
npm ci        # install all workspace dependencies
npm run check # build (type check) + lint + unit tests
```

CI runs the same on every pull request and on every push to `master`, then `npm run eval`: every case, with no agent, which fails the build when a score drops below the stored baseline.

Individual steps: `npm run build`, `npm run lint`, `npm test`.

The extension integration tests are the one exception: they never run in
`npm test` or `npm run check`, so no local run can launch anything that
opens a VS Code window on a developer machine. CI runs them on Linux
under xvfb: the fast stub-based test (`npm run test:integration`) and the
real-host test (`npm run test:real-host`), which downloads a real VS Code
and runs the extension in it end to end against a fake engine process.

## Packaging the extension

`npm run package` builds the one extension package: a single universal
`.vsix` that carries the extension, the bundled engine and the WASM
grammars, with no per-OS builds and no native Node modules. The build
reads no publishing credential and stores none — it writes the file to
`packages/extension/dist/` and nothing else. Publishing to the VS Code
Marketplace or Open VSX stays a separate, manual release step.

CI builds the package on every pull request, reports its size, and keeps
it as a build artifact. To try the companion by hand, download the
`.vsix` from a CI run's artifacts page, install it from file on a clean
VS Code (Extensions view → `…` → **Install from VSIX…**), and review a
public pull request with the **Second Look: Review pull request**
command. A smoke test installs the package this way into a clean,
downloaded VS Code on macOS, Linux and Windows in CI and runs one review
in it (`npm run test:package-smoke` locally, which like the other editor
launches belongs to CI, not to a local check).

## Running the review command

Build first (`npm run build`), then give the engine a GitHub token through the environment and point it at any public pull request:

```sh
GITHUB_TOKEN="$(gh auth token)" node packages/engine/dist/main.js \
  review https://github.com/{owner}/{repo}/pull/{number}
```

The engine package also installs a `second-look-engine` bin link once its
build output exists (`npm ci` again after `npm run build`).

The command fetches the pull request's metadata and full diff — the description is kept in full, never truncated, and the diff comes from the diff media type, so a large lockfile keeps every line — parses it into files and hunks, and prints a JSON review result of named, ranked parts. Each file carries a noise label (lockfile, generated, vendored, moved or renamed, snapshot, fixture) that says whether it is confirmed or claimed and gives its one-line blind spot, or says no rule applied. The labels read the repository's linguist attributes from its root `.gitattributes` at the head commit, without a checkout. A lockfile label moves from claimed to confirmed by a parse-only check: for `uv.lock` and `poetry.lock` (manifest `pyproject.toml`), `package-lock.json` (`package.json`), NuGet `packages.lock.json` (the project files beside it and `Directory.Packages.props` up the tree) and `Cargo.lock` (`Cargo.toml`), both versions of the lock file and its manifest are read from the cached copies, and the label is confirmed only when every changed entry belongs to the dependency closure of the changed manifest entries — a change the manifest does not explain stays claimed and names its entries, and lock files of other ecosystems stay claimed with no check for this lockfile.

Each file's hunks are grouped into parts named after the entities they touch: hunks that share an entity form one part, such as `Cart.total in web/cart.ts`, the hunks outside every entity form a `top-level code in …` part, and a file whose entities could not be named keeps its path. The engine fails the run unless every changed line belongs to exactly one part. Each part gets plain signals: new versus changed code, test versus code, its changed lines, the public entities it adds, removes or redeclares, and how many other files in the head copy mention its entity names — a name-based count, labelled so, that cannot tell a call from a same-named word. A fixed rule ranks each part **must review**, **worth reviewing** or **context** with a one-line reason citing the signals it used, keeps at most a third of the parts (rounded up) at must review, and gives the same order for the same input. Noise parts sink to the bottom, except snapshots and fixtures, which are labelled but ranked with the rest. Read the order and the reasons, and compare the parts' hunks and line counts with the GitHub page: no hunk may be missing.

The engine also keeps a read-only copy of the base version (the merge base the diff is computed against) and the head version in a per-pull-request cache, at `<cache>/github.com/{owner}/{repo}/pull-{number}/{commit}`. The copies are downloaded as archives: nothing is checked out in the reviewer's workspace, nothing from the pull request runs, and no package manager is called. A later run at the same commits reuses them. The cache folder is `--cache-dir`, else `SECOND_LOOK_CACHE_DIR`, else the platform's per-user cache folder (`~/.cache/second-look`, `~/Library/Caches/second-look` or `%LOCALAPPDATA%\second-look\cache`); its files and folders are read-only, so remove it with `chmod -R u+w` first.

Each changed file is parsed with a tree-sitter grammar bundled as WASM — Python, C#, TypeScript, TSX, JavaScript, Go, Rust and Java. Every hunk names the entities (functions, classes, methods and the like) its changed lines touch, each with whether it is public by its language's visibility rules and whether the hunk adds it, removes it, changes its declaration or only its body, and each part says whether its change is confirmed formatting-only: the base and head syntax trees must match, nesting included, so a Python dedent that moves a statement out of a block is not formatting-only. Files in other languages still flow through at file level, and their part lists the checks that could not run and why. The result records the time spent parsing in `parseTimeMs`.

The token is passed in by the caller (`--token` or `GITHUB_TOKEN`), is used only for the GitHub request, and is never written to disk or logs. Tests run against recorded responses and never touch the network.

### Grouping with the agent

With `--agent pi` or `--agent claude-code` (and optionally `--model`, `--effort` and `--agent-timeout`), the review command then asks the reviewer's installed agent to group related hunks across files into parts — a function, its caller and its test — named by the entities they touch. The plain parts are announced on stderr while the agent works. Its answer is checked before anything is shown: an answer that misses its schema, names a hunk that was not offered or puts one hunk in two parts is retried once and then dropped, and the plain grouping stays; the hunks a valid answer leaves out go to one part marked **not grouped by the agent**, so every changed line still belongs to exactly one part. Sinking noise, such as a lockfile, keeps its plain parts and never reaches the agent. The agent's parts get their signals and rank like any other, and a part across files lists its further files in `otherFiles`. Each part says who grouped it (`origin`), and the result's `grouping` says whose parts it shows, with the agent's outcome, the grouping prompt's version and the run's stamp.

```sh
GITHUB_TOKEN="$(gh auth token)" node packages/engine/dist/main.js \
  review https://github.com/{owner}/{repo}/pull/{number} --agent pi
```

The grouping prompt is versioned and evaluated over its own cases (ADR 0006); see the [evaluation](packages/evaluation/README.md).

### Ranking with the agent

After grouping, the same agent ranks the parts the result shows: each part gets **must review**, **worth reviewing** or **context** with a one-line reason, and must cite, by key, the plain signals its reason uses — `public-surface`, `role`, `novelty`, `references`, `size`, `formatting-only` or `noise`, offered only where the part has that signal. The agent lists the parts in reading order, which orders the parts within each level. A validator checks the answer before anything is shown: it rejects a missing reason, a reason that cites no signal or cites a signal the part does not have, a part left out or ranked twice, and more than a third of the parts (rounded up) at must review; a rejected answer is retried once, and then the plain ranking stays. Sinking noise keeps its plain rank and stays last. A part's `rank.signals` holds the phrases of the signals its reason cites, and the result's `ranking` says whose ranking it shows, with the agent's outcome, the ranking prompt's version and the run's stamp.

The agent ranking is the default only for an agent, model and effort whose evaluation matched or beat the plain ranking — `TESTED_RANKINGS` in `packages/engine/src/ranking.ts`, recorded from the [evaluation](packages/evaluation/README.md); a run that asks for no effort counts as the agent's own default. Elsewhere the plain ranking stays and the result says why; an agent with no tested model, or a model or effort asked for that is not one, is not asked to rank at all.

### The story

Then the same agent writes the story of the parts the result shows: a few sentences that tell what the change does, in the parts' reading order, each part it mentions linked by its id. The engine checks the story before showing it: a story must link every must-review part, first mention the parts in the ranking's order, and name no file or code the change does not show — a name in backticks, a path, or a dotted, snake_case or camelCase name, checked against the change's paths, lines and entities. A story that fails is retried once with the problems named, and then the result says why there is none. The result's `story` holds the sentences as runs of text, code names and part links (each by its index in `parts`), with the story prompt's version and the run's stamp. The story prompt is evaluated over its own cases with those plain checks as its scores; see the [evaluation](packages/evaluation/README.md).

### The claims

Then the same agent lists the claims the change makes: statements about how code or a library behaves, from the pull request's description, the docstrings and comments in the lines the change adds, and the story the agent wrote, in that priority. Each claim is a quote of its source, as written. The engine checks every quote before listing any: a quote must sit in the description, in the lines the change adds to the file the agent names, or in a sentence of the story, and the engine — not the agent — sets where it sits and, for a docstring or comment, the part holding that line; a claim from the description or the story names its part by id. An answer with a quote its source does not hold is retried once with the problems named, and then the result says why no claim is listed. The result's `claims` holds each claim's quote, source, location (a description line, a file's head-side lines, or a story sentence) and part (by its index in `parts`), every one **not checked** yet, with the claims prompt's version and the run's stamp. The claims prompt is evaluated over its own cases, scored by recall and precision against hand-listed claims; see the [evaluation](packages/evaluation/README.md).

### The verdicts

Last, the same agent judges each claim it listed against the change itself — the diff and the read-only head copy — and gives it a verdict: **verified**, **refuted** or **unverifiable**, with its evidence source (the change itself, or the model's memory), a one-line reason, and the lines it cites as evidence, each a file, a line and a quote. The engine re-reads every citation in the head copy: when the file is not there, the line is not one of its lines, or the quote does not start on that line as written, the verdict drops to **unverifiable** and says why. The model's memory never yields **verified**, and a verdict from memory cites no line. A claim that turns on how a third-party library behaves names the library whose source it needs, and is never verified without it; fetching that source is the reviewer's choice, never the companion's (ADR 0003). An answer that leaves a claim out is retried once, and then every claim stays **not checked** and the result says why. Each claim in the result's `claims` carries its verdict, and `claims.judging` holds the verdicts prompt's version, the outcome and the run's stamp. Refuted and unverifiable claims are findings. The verdicts prompt is evaluated over its own cases, scored by verdict accuracy and false-verified rate against hand verdicts; see the [evaluation](packages/evaluation/README.md).

## Probing the reviewer's coding agent

The engine does its model work through the coding agent the reviewer already has installed and signed in, never through a model API of its own (ADR 0004). One adapter interface, documented in `packages/engine/src/agent.ts`, runs an agent non-interactively with the companion's own prompt and a JSON schema for the answer. It first probes the installed version for what it supports. Two adapters exist: Pi and Claude Code, chosen by name (`--agent pi` or `--agent claude-code`; the VS Code settings offer the same names).

Every Pi run is locked down. Pi has no sandbox of its own, so the strongest mechanism it offers is used:

- File-reading tools only (`--tools read,grep,find,ls`): no shell and no network.
- Pi's project trust off (`--no-approve`), and extensions, skills, prompt templates, themes and context files such as `AGENTS.md` and `CLAUDE.md` off, so nothing from the pull request configures the agent.
- No session file, no startup network, and the companion's own system prompt. The prompt goes on stdin.
- The companion's guard, loaded as Pi's one extension (`packages/engine/src/pi-guard.ts`), checks every tool call before it runs. It confines every path to the read-only copy, symbolic links included, and refuses URLs and credential paths by name: SSH keys, cloud credentials, the GitHub login, agents' own logins.
- The GitHub token variables are removed from the agent's environment.

A Pi version whose help lacks any of these flags is never run. The agent signs in with its own login: the companion never reads or stores it, and the agent inherits the engine's environment minus the GitHub token.

Claude Code runs under its own lockdown, built from the flags it offers (`packages/engine/src/claude-code.ts`):

- Print mode (`--print`) with the answer checked against the task's schema (`--json-schema`), streamed as JSON with partial messages, so a run that times out keeps what it wrote.
- File-reading tools only (`--tools Read,Grep,Glob`): no shell, no network tools, no edits. Claude Code confines its file tools to the working directory — the read-only copy.
- User-level settings only (`--setting-sources user`), so nothing from the pull request configures the agent, and no MCP servers (`--strict-mcp-config`).
- No session file (`--no-session-persistence`), permission prompts denied rather than asked (`--permission-prompts none`), and the companion's own system prompt. The prompt goes on stdin.
- The GitHub token variables are removed from the agent's environment, as for Pi.

A Claude Code version whose help lacks any of these flags is never run. Each run's stamp reports which login it used — the stored subscription sign-in, an OAuth token or cloud credentials from the environment — and warns when an inherited `ANTHROPIC_API_KEY` silently overrides the subscription. The key itself is never read, printed or copied: only its presence is checked. Anthropic's terms are unclear on third-party tools driving a reviewer's own Claude Code (ADR 0004).

The VS Code settings pick the agent, the model and a label for the account or subscription it bills; the status bar shows them, and warns about an inherited API key when Claude Code is the agent. Every result is stamped, so the reviewer can always tell which agent and model said what.

Pull request text reaches the agent inside a marked untrusted block, with Unicode tag characters, zero-width characters and bidirectional controls stripped. HTML comments, which GitHub hides from the reviewer, are kept but delimited. Each answer is checked against its schema. An invalid answer is retried once, then reported as a failure, never guessed. Every result is stamped with the agent, its version, the model, the effort, the run date, the tokens and cost when the agent reports them, and the reviewer's account label when the settings gave one. Runs have a timeout and a concurrency limit, and a run that times out keeps what it wrote.

The probe command runs a fixed prompt that is a setup check, not a review prompt, and the contract tests use it; the review prompts, such as grouping, ranking, the story, the claims and the verdicts, land with their evaluation (ADR 0006). With Pi installed and signed in:

```sh
GITHUB_TOKEN="$(gh auth token)" node packages/engine/dist/main.js \
  probe https://github.com/{owner}/{repo}/pull/{number} \
  --target README.md --target ~/.ssh/id_ed25519 --target https://example.com/
```

It prints what the installed Pi supports and, for each target, the agent's schema-checked answer and the run's stamp. The credential path and the URL come back refused. `--agent` picks the adapter (`pi` by default, `claude-code` for Claude Code). `--model` and `--effort` pick the model and effort level. `--agent-timeout` (seconds, default 300) and `--agent-concurrency` (default 2) set the pacing. Tests drive each adapter through a shared contract suite against a fake agent executable and never call a model.

## Reading a package's portable PDBs

The `pdb` debug command reads a local NuGet package (`.nupkg`), symbols package (`.snupkg`), portable PDB or assembly, and prints every portable PDB in it — standalone `.pdb` files and PDBs embedded in an assembly — as JSON: each source document with its hash algorithm (SHA-1 or SHA-256), its hash, and its Source Link URL, plus each PDB's Source Link map. It needs no token and reads only the given file.

```sh
curl -sSLo dapper.nupkg https://www.nuget.org/api/v2/package/Dapper/2.1.35
node packages/engine/dist/main.js pdb dapper.nupkg
```

Malformed input — a Windows PDB, a truncated file, corrupt compressed data — fails with a clear error and exit code 1. Tests read PDBs from public packages stored under `packages/engine/test/fixtures/pdb`.

## Reviewing a pull request in VS Code

The extension adds a **Second Look: Review pull request** command and a review tree in the Explorer side bar. To try it from source, build first (`npm run build`), then open the repository in VS Code and press F5 (the "Run the companion extension" configuration starts a development host with the extension loaded). In the development host:

1. Run **Second Look: Review pull request** from the Command Palette.
2. Paste a GitHub pull request URL, such as `https://github.com/{owner}/{repo}/pull/{number}`.
3. Sign in with VS Code's built-in GitHub login when it asks.
4. Read the tree: the parts grouped by importance in order — must review, worth reviewing, context — each named by the entities it touches, with its reason beside it and in its tooltip the signals the reason cites and whether the plain or the agent ranking is shown, and the noise last with its label and whether it was confirmed or only claimed. A part that arrives without a rank sits in its own plain section above the noise, and the tree shows whatever the engine returns.
5. Watch the tree arrive in stages: the plain parts show first, with a status line above the tree naming the stage still running ("grouping related hunks with pi"), then the tree updates in place when the agent's parts arrive, and the status line says who grouped them — the agent with its model and the grouping prompt's version, or the plain pass with the reason the agent's grouping was not used. The part you had selected stays selected: the part now holding its first hunk is selected in its place, and an open diff editor stays as it is. Try a pull request where a function, its caller and its test change in different files: the plain tree shows them apart, the regrouped tree as one part. The tree then updates again when the agent's ranking arrives ("ranking the parts with pi"), and the status line says who ranked the parts, or why the plain ranking stayed; then the story ("writing the story with pi"), then the claims ("listing the claims with pi"), each part they are attached to showing its claim count beside its name, and their verdicts come last ("checking the claims with pi"): each part with a finding — a refuted or unverifiable claim — shows a badge such as **⚠ 1 finding** beside its name, and each finding is the companion's own comment thread on the diff, beside any thread of the GitHub pull request extension, at the line that makes the claim or, for a claim in the description or the story, the first line its verdict cites. The thread gives the verdict, its evidence source, the quote, the reason, each citation and the library whose source the claim needs; it is read-only and nothing in it reaches GitHub. Review a pull request whose description misstates what a changed function does: the claim is refuted, with its thread at the changed line the verdict cites. Review a medium pull request and compare the agent ranking with the plain one: the agent's comes only with a tested agent, model and effort, and the engine's review command without `--agent` prints the plain ranking of the same pull request.
6. Read the overview, the **Second Look: #… overview** tab that opens with the review without taking the focus from the tree: the pull request's title, where it comes from, a chip for each stage done and the one still running, the story with its stamp — each part it mentions a link that opens the part in the diff editor — the claims with theirs, each quoted with where it is made, the part it is attached to as a link, and its verdict with its evidence source, reason and citations (**not checked** until judged), the pull request's description in full, and who made each result: the plain pass, or the agent with its model and prompt version. Content GitHub hides in the description is shown and flagged: an HTML comment as written, Unicode tag characters decoded to the text they spell, zero-width characters and bidirectional controls as their code points. Review a pull request whose description holds an HTML comment: the overview shows it flagged. Nothing in the overview renders as markup: no remote image and no link, under a content security policy that loads nothing but the page's own style and script. Each part in the tree has a **Why this matters** button beside its reason: it opens the story at the sentence that first mentions the part, or says the story does not mention it. The tree's **Open overview** title button brings the overview back.
7. Click a part: the multi-file diff editor opens with exactly that part's files, the base copy on the left and the head copy on the right, scrolled to the part's first hunk with its added and deleted lines marked. Try to edit a file: the copies are read-only, so the editor refuses. Added, deleted, renamed and binary files open sensibly too. The tree's title button, **Open all parts in order**, opens the whole change in one multi-file diff in the tree's order, noise last.
8. Write comments: click the comment icon on any line a hunk covers — on either side of the diff — and type into the thread, or right-click a part in the tree and choose **Comment on this part…**. Each comment joins the pending review, which gathers in its own section at the top of the tree with where every comment points. A comment can be discarded from its thread until it is sent; nothing reaches GitHub while it waits (ADR 0002).
9. Press **Submit review…** (the tree's rocket button, or the Command Palette): the **Send review** page opens with every pending comment together for one last pass — each with where it points, editable or droppable in place — beneath them the overall comment on the whole pull request and the choice of **Comment**, **Approve** or **Request changes**. Nothing reaches GitHub until the page's Submit button is pressed; then the GitHub sign-in is asked for at that moment, the engine maps every line and part comment to its position in the pull request's current diff, and one request submits them as one GitHub review pinned to the head commit it read. The review's link then shows, ready to open; a send that fails keeps every comment exactly where it was.

The extension starts the engine as a separate process and speaks JSON-RPC to it over stdio, starting with a version handshake. The engine sends the plain result in a `review/stage` notification naming the next stage and its deadline, then the grouped result in another while the agent ranks, then the ranked result in another while the agent writes the story, then the result with the story in another while the agent lists the claims, then the result with the claims in another while the agent judges them, then answers the review request with the final result; a new review replaces one still running. The GitHub token comes from VS Code's authentication API, travels with each review request, and is never stored by the companion. The agent, model and account the settings choose travel with each review request too, so switching them needs no engine restart: the next review runs its agent passes on the chosen agent, and every agent-produced result is stamped with it. The one write — submitting the review — asks for its token the same way, only at the moment the reviewer presses send, and the engine performs it as a single request: nothing of the review reaches GitHub before that. Progress shows in the tree while the engine works, and an engine failure reads as a plain message. The extension declares limited support for untrusted workspaces and runs nothing from the workspace: the engine is started from the extension's own install, reads GitHub, and writes only the review the reviewer sends. The diff editor reads the base and head content through the companion's own read-only file system (`second-look-change:` URIs) straight from the engine's cache — nothing is checked out, and every write is refused.

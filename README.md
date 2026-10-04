# Second Look

Second Look is a VS Code companion for human pull request review: it ranks the change by what matters, checks its claims against real code, and lets the reviewer send comments to GitHub.

- [CONTEXT.md](CONTEXT.md) — the project glossary: the shared words and what they mean.
- [docs/adr/](docs/adr/) — the numbered decision records behind the design.

## Repository layout

The repository is a TypeScript workspace with three packages:

- `packages/engine` — the engine: a separate local process that fetches a pull request, parses its full diff into files and hunks, reads the changed files' syntax trees from read-only copies of the change, and offers its result two ways: printed as typed, versioned JSON by the review command, and over a JSON-RPC protocol on stdio by the serve command (ADR 0005). It also reads portable PDB files, the .NET debug files that record each source file's hash and Source Link URL. It drives the reviewer's installed coding agent, Pi or Claude Code, through one adapter interface (ADR 0004).
- `packages/extension` — the VS Code extension: a thin client that starts the engine as its own process, talks the JSON-RPC protocol to it after a version handshake, and shows the result as the ranked review tree, with each part readable in the editor's multi-file diff over read-only copies. Its settings pick the agent, the model and the account label; the status bar shows what they choose.
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

Pull request text reaches the agent inside a marked untrusted block, with Unicode tag characters, zero-width characters and bidirectional controls stripped. HTML comments, which GitHub hides from the reviewer, are kept but delimited. Each answer is checked against its schema. An invalid answer is retried once, then reported as a failure, never guessed. Every result is stamped with the agent, its version, the model, the effort, the run date, and the tokens and cost when the agent reports them. Runs have a timeout and a concurrency limit, and a run that times out keeps what it wrote.

The probe command runs a fixed prompt that is a setup check, not a review prompt, and the contract tests use it; the review prompts, such as grouping, land with their evaluation (ADR 0006). With Pi installed and signed in:

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
4. Read the tree: the parts grouped by importance in order — must review, worth reviewing, context — each named by the entities it touches, with its reason beside it and its signals in its tooltip, and the noise last with its label and whether it was confirmed or only claimed. A part that arrives without a rank sits in its own plain section above the noise, and the tree shows whatever the engine returns.
5. Watch the tree arrive in stages: the plain parts show first, with a status line above the tree naming the stage still running ("grouping related hunks with pi"), then the tree updates in place when the agent's parts arrive, and the status line says who grouped them — the agent with its model and the grouping prompt's version, or the plain pass with the reason the agent's grouping was not used. The part you had selected stays selected: the part now holding its first hunk is selected in its place, and an open diff editor stays as it is. Try a pull request where a function, its caller and its test change in different files: the plain tree shows them apart, the regrouped tree as one part.
6. Click a part: the multi-file diff editor opens with exactly that part's files, the base copy on the left and the head copy on the right, scrolled to the part's first hunk with its added and deleted lines marked. Try to edit a file: the copies are read-only, so the editor refuses. Added, deleted, renamed and binary files open sensibly too. The tree's title button, **Open all parts in order**, opens the whole change in one multi-file diff in the tree's order, noise last.
7. Write comments: click the comment icon on any line a hunk covers — on either side of the diff — and type into the thread, or right-click a part in the tree and choose **Comment on this part…**. Each comment joins the pending review, which gathers in its own section at the top of the tree with where every comment points. A comment can be discarded from its thread until it is sent; nothing reaches GitHub while it waits (ADR 0002).
8. Press **Submit review…** (the tree's rocket button, or the Command Palette): choose **Comment**, **Approve** or **Request changes** in the interim quick pick, then write the optional overall comment, and send. The GitHub sign-in is asked for at that moment, the engine maps every line and part comment to its position in the pull request's current diff, and one request submits them as one GitHub review pinned to the head commit it read. The review's link then shows, ready to open; a send that fails keeps every comment exactly where it was.

The extension starts the engine as a separate process and speaks JSON-RPC to it over stdio, starting with a version handshake. The engine sends the plain result in a `review/stage` notification naming the next stage and its deadline, then answers the review request with the final result; a new review replaces one still running. The GitHub token comes from VS Code's authentication API, travels with each review request, and is never stored by the companion. The one write — submitting the review — asks for its token the same way, only at the moment the reviewer presses send, and the engine performs it as a single request: nothing of the review reaches GitHub before that. Progress shows in the tree while the engine works, and an engine failure reads as a plain message. The extension declares limited support for untrusted workspaces and runs nothing from the workspace: the engine is started from the extension's own install, reads GitHub, and writes only the review the reviewer sends. The diff editor reads the base and head content through the companion's own read-only file system (`second-look-change:` URIs) straight from the engine's cache — nothing is checked out, and every write is refused.

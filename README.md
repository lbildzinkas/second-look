# Second Look

Second Look is a VS Code companion for human pull request review: it ranks the change by what matters, checks its claims against real code, and lets the reviewer send comments to GitHub.

- [CONTEXT.md](CONTEXT.md) — the project glossary: the shared words and what they mean.
- [docs/adr/](docs/adr/) — the numbered decision records behind the design.

## Repository layout

The repository is a TypeScript workspace with two packages:

- `packages/engine` — the engine: a separate local process that fetches a pull request, parses its full diff into files and hunks, reads the changed files' syntax trees from read-only copies of the change, and offers its result two ways: printed as typed, versioned JSON by the review command, and over a JSON-RPC protocol on stdio by the serve command (ADR 0005). It also reads portable PDB files, the .NET debug files that record each source file's hash and Source Link URL.
- `packages/extension` — the VS Code extension: a thin client that starts the engine as its own process, talks the JSON-RPC protocol to it after a version handshake, and shows the result as the ranked review tree.

The protocol types live in `packages/engine/src/protocol.ts` and `packages/engine/src/rpc.ts`, carry their versions, and are shared by both packages.

## Building and testing

Requires Node 20 or later. One command installs, type-checks, lints and tests everything:

```sh
npm ci        # install all workspace dependencies
npm run check # build (type check) + lint + unit tests
```

CI runs the same on every pull request and on every push to `master`.

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

The command fetches the pull request's metadata and full diff — the description is kept in full, never truncated, and the diff comes from the diff media type, so a large lockfile keeps every line — parses it into files and hunks, and prints a JSON review result of named, ranked parts. Each file carries a noise label (lockfile, generated, vendored, moved or renamed, snapshot, fixture) that says whether it is confirmed or claimed and gives its one-line blind spot, or says no rule applied. The labels read the repository's linguist attributes from its root `.gitattributes` at the head commit, without a checkout.

Each file's hunks are grouped into parts named after the entities they touch: hunks that share an entity form one part, such as `Cart.total in web/cart.ts`, the hunks outside every entity form a `top-level code in …` part, and a file whose entities could not be named keeps its path. The engine fails the run unless every changed line belongs to exactly one part. Each part gets plain signals: new versus changed code, test versus code, its changed lines, the public entities it adds, removes or redeclares, and how many other files in the head copy mention its entity names — a name-based count, labelled so, that cannot tell a call from a same-named word. A fixed rule ranks each part **must review**, **worth reviewing** or **context** with a one-line reason citing the signals it used, keeps at most a third of the parts (rounded up) at must review, and gives the same order for the same input. Noise parts sink to the bottom, except snapshots and fixtures, which are labelled but ranked with the rest. Read the order and the reasons, and compare the parts' hunks and line counts with the GitHub page: no hunk may be missing.

The engine also keeps a read-only copy of the base version (the merge base the diff is computed against) and the head version in a per-pull-request cache, at `<cache>/github.com/{owner}/{repo}/pull-{number}/{commit}`. The copies are downloaded as archives: nothing is checked out in the reviewer's workspace, nothing from the pull request runs, and no package manager is called. A later run at the same commits reuses them. The cache folder is `--cache-dir`, else `SECOND_LOOK_CACHE_DIR`, else the platform's per-user cache folder (`~/.cache/second-look`, `~/Library/Caches/second-look` or `%LOCALAPPDATA%\second-look\cache`); its files and folders are read-only, so remove it with `chmod -R u+w` first.

Each changed file is parsed with a tree-sitter grammar bundled as WASM — Python, C#, TypeScript, TSX, JavaScript, Go, Rust and Java. Every hunk names the entities (functions, classes, methods and the like) its changed lines touch, each with whether it is public by its language's visibility rules and whether the hunk adds it, removes it, changes its declaration or only its body, and each part says whether its change is confirmed formatting-only: the base and head syntax trees must match, nesting included, so a Python dedent that moves a statement out of a block is not formatting-only. Files in other languages still flow through at file level, and their part lists the checks that could not run and why. The result records the time spent parsing in `parseTimeMs`.

The token is passed in by the caller (`--token` or `GITHUB_TOKEN`), is used only for the GitHub request, and is never written to disk or logs. Tests run against recorded responses and never touch the network.

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
4. Read the tree: the parts grouped by importance in order — must review, worth reviewing, context — each with its reason beside it and its signals in its tooltip, and the noise last with its label and whether it was confirmed or only claimed. A part that arrives without a rank sits in its own plain section above the noise, and the tree shows whatever the engine returns.

The extension starts the engine as a separate process and speaks JSON-RPC to it over stdio, starting with a version handshake. The GitHub token comes from VS Code's authentication API, travels with each review request, and is never stored by the companion. Progress shows in the tree while the engine works, and an engine failure reads as a plain message. The extension declares limited support for untrusted workspaces and runs nothing from the workspace: the engine is started from the extension's own install and only ever reads GitHub.

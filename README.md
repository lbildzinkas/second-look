# Second Look

Second Look is a VS Code companion for human pull request review: it ranks the change by what matters, checks its claims against real code, and lets the reviewer send comments to GitHub.

- [CONTEXT.md](CONTEXT.md) — the project glossary: the shared words and what they mean.
- [docs/adr/](docs/adr/) — the numbered decision records behind the design.

## Repository layout

The repository is a TypeScript workspace with two packages:

- `packages/engine` — the engine: a separate local process that fetches a pull request, parses its full diff into files and hunks, and prints a typed, versioned review result as JSON (ADR 0005). It also reads portable PDB files, the .NET debug files that record each source file's hash and Source Link URL.
- `packages/extension` — the VS Code extension: a thin client that reads the engine's result over the shared protocol types.

The protocol types live in `packages/engine/src/protocol.ts`, carry a `version` field, and are shared by both packages.

## Building and testing

Requires Node 20 or later. One command installs, type-checks, lints and tests everything:

```sh
npm ci        # install all workspace dependencies
npm run check # build (type check) + lint + unit tests
```

CI runs the same on every pull request and on every push to `master`.

Individual steps: `npm run build`, `npm run lint`, `npm test`.

## Running the review command

Build first (`npm run build`), then give the engine a GitHub token through the environment and point it at any public pull request:

```sh
GITHUB_TOKEN="$(gh auth token)" node packages/engine/dist/main.js \
  review https://github.com/{owner}/{repo}/pull/{number}
```

The engine package also installs a `second-look-engine` bin link once its
build output exists (`npm ci` again after `npm run build`).

The command fetches the pull request's metadata and full diff — the description is kept in full, never truncated, and the diff comes from the diff media type, so a large lockfile keeps every line — parses it into files and hunks, and prints a JSON review result with one part per changed file. Each part carries a noise label (lockfile, generated, vendored, moved or renamed, snapshot, fixture) that says whether it is confirmed or claimed and gives its one-line blind spot, or says no rule applied; noise parts sink to the bottom of the result, except snapshots and fixtures, which are labelled but never sunk. The labels read the repository's linguist attributes from its root `.gitattributes` at the head commit, without a checkout. Compare the file list, labels and line counts with the GitHub page.

The token is passed in by the caller (`--token` or `GITHUB_TOKEN`), is used only for the GitHub request, and is never written to disk or logs. Tests run against recorded responses and never touch the network.

## Reading a package's portable PDBs

The `pdb` debug command reads a local NuGet package (`.nupkg`), symbols package (`.snupkg`), portable PDB or assembly, and prints every portable PDB in it — standalone `.pdb` files and PDBs embedded in an assembly — as JSON: each source document with its hash algorithm (SHA-1 or SHA-256), its hash, and its Source Link URL, plus each PDB's Source Link map. It needs no token and reads only the given file.

```sh
curl -sSLo dapper.nupkg https://www.nuget.org/api/v2/package/Dapper/2.1.35
node packages/engine/dist/main.js pdb dapper.nupkg
```

Malformed input — a Windows PDB, a truncated file, corrupt compressed data — fails with a clear error and exit code 1. Tests read PDBs from public packages stored under `packages/engine/test/fixtures/pdb`.

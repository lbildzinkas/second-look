# TypeScript for the engine and the extension

The engine is written in TypeScript and runs as a separate local process behind a language-neutral protocol, with the VS Code extension as a thin TypeScript client. The extension must be TypeScript anyway, so one language gives one toolchain, shared protocol types, one universal package with no per-OS builds, the official GitHub client, tree-sitter grammars for any language as WASM, and the largest pool of contributors for a VS Code tool. Performance is not the constraint: agent calls dominate review time, and the model-free pass over a pull request's diff is small.

## Considered Options

- .NET with Native AOT: rejected; its main dividend, deep C# understanding through Roslyn, serves one language when the companion must serve any language, and AOT needs one build per OS and chip.
- Rust: rejected for now; a single fast binary, but speed is not the bottleneck and it splits the code base into two languages. The process boundary keeps a later Rust rewrite of a hot path possible.

## Consequences

.NET's exact-source route needs a small reader for portable PDB files written in TypeScript, since there is no maintained library for it.

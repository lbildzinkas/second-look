# Library source only on the reviewer's request

Reading a library's real source is the companion's strongest check, but it is fetched only when a claim cannot be checked any other way, and only when the reviewer starts it after the companion explains why. The companion's own code does the fetch, at the exact version the project pins, by plain download and unzip; the agent never fetches and never has network access. This keeps library fetching out of the common path, keeps untrusted pull request text away from the network, and avoids the wrong-version and install-script traps of letting an agent or a package manager do it.

## Considered Options

- Fetch every relevant library automatically on each review: rejected, it is rarely needed and makes the common path slower and noisier.
- Let the agent fetch with network access: rejected, it reads text written by others, picks whatever version is handy, and tends to run install scripts.

## Amendment (issue 40)

Where no ecosystem route exists, the agent may name the library's repository and the tag of the version the project uses; the companion, never the agent, fetches that tag itself and runs nothing. Nothing pins what it downloads and no hash is checked, so every verdict that uses it labels its evidence as a named repository, weaker than pinned source.

## Amendment (issue 39)

Where a pinned .NET package has no exact source — no PDB, no Source Link or no commit — the companion offers to decompile it only when that package version's own licence, read from the nuspec of the exact package it downloaded and checked, is a known open-source licence; a restrictive or unknown licence means nothing is decompiled, and the verdict says why. The reviewer starts the decompile. The companion, never the agent, runs the one decompiler it knows, as the reviewer installed it, with fixed arguments, on the package's assemblies alone and with the network cut by the operating system's sandbox; nothing in the package decides which program runs. Its output lands read-only beside the other fetched libraries, is never built or run, and every verdict that uses it labels its evidence as decompiled library code, never as source.

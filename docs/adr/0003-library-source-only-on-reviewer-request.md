# Library source only on the reviewer's request

Reading a library's real source is the companion's strongest check, but it is fetched only when a claim cannot be checked any other way, and only when the reviewer starts it after the companion explains why. The companion's own code does the fetch, at the exact version the project pins, by plain download and unzip; the agent never fetches and never has network access. This keeps library fetching out of the common path, keeps untrusted pull request text away from the network, and avoids the wrong-version and install-script traps of letting an agent or a package manager do it.

## Considered Options

- Fetch every relevant library automatically on each review: rejected, it is rarely needed and makes the common path slower and noisier.
- Let the agent fetch with network access: rejected, it reads text written by others, picks whatever version is handy, and tends to run install scripts.

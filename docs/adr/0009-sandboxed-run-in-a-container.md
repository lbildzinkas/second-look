# Run a pull request's code only in a container the reviewer starts

Some claims can only be settled by running the code, and running a pull request's code means running a stranger's program. So a sandboxed run happens only when the reviewer starts it, after the companion explains what will run: the commit, the image and its digest, the command, the limits, and that the run has no network. Nothing runs on its own, on opening a review or on the agent's word.

**The agent never starts a run and never runs code.** At most it names a test to run, which the companion checks against the head copy and turns into a command from its own fixed list, passing the test's name as one argument, never through a shell. The reviewer still starts that run. Every run's result is labelled with the commit, the image and the command, so evidence from it is always shown as a sandboxed run.

The code runs only inside an OCI container, started through the Docker-compatible CLI the reviewer has already installed, `docker` or `podman`. The companion probes for the CLI and its version and never installs, starts or configures a runtime; where there is none, it says plainly that it cannot run the code and the rest of the review works as before ([ADR 0001](0001-any-language.md)). The image comes from the companion's own list, pinned by digest, and is never built from a Dockerfile or dev container in the pull request.

The container has no host mount. The head copy, the same read-only copy the agent reads, streams in as an archive on stdin and is unpacked into a tmpfs, so the container never sees a path on the reviewer's machine. The companion starts the CLI with a minimal environment of its own (the path and the runtime's connection variables) and passes no `--env`, `--env-file` or `--env-host`, so nothing from the reviewer's or the engine's environment reaches the container.

The run step is started with these flags, each for one reason:

| Flag | Why |
| --- | --- |
| `--network none` | No network: the code cannot send the copy anywhere, reach the reviewer's local network or fetch more code. Only loopback exists. |
| `--read-only` | A read-only root: the code cannot change the image's programs or leave anything behind for a later step. |
| `--tmpfs /work:rw,exec,nosuid,nodev,size=…,mode=1777`, and the same for `/tmp` | The only writable places, in memory and gone when the container ends. `/work` holds the copy; both must allow running what a build writes there, so `exec` is set explicitly where Podman defaults a tmpfs to `noexec`. |
| `--cap-drop ALL` | Every Linux capability dropped, so even root inside could not mount, trace, change ownership or open raw sockets. |
| `--security-opt no-new-privileges` | No setuid or setgid program can raise the process's privileges. |
| `--user 65534:65534` | A non-root user, so an escape starts from an unprivileged account. |
| `--cpus`, `--memory` with an equal `--memory-swap`, `--pids-limit` | Limits on CPU, memory with no swap on top, and processes, so a fork bomb or a runaway build cannot take the reviewer's machine down. |
| A time limit | Docker's CLI has no such flag, so on both runtimes the companion names the container and stops it with `docker kill` or `podman kill` when the limit passes. |
| `--pull never`, image `name@sha256:…` | The run uses exactly the image the reviewer was shown and never fetches one. |
| `--rm`, `-i` | The container is removed when it ends, and stdin carries the copy in. |

Dependencies are installed in a step of their own, from the pull request's lock file, with the same flags but network allowed so the package registry is reachable; the run step that follows always has no network.

## Considered Options

- `sandbox-exec` on macOS and `bubblewrap` on Linux: rejected. `sandbox-exec` is deprecated and its profile language is undocumented: its own man page, `sandbox-exec(1)`, says to adopt [App Sandbox](https://developer.apple.com/documentation/security/app-sandbox) instead, which sandboxes a signed app rather than a program the companion starts; `bubblewrap` is Linux-only and is a building block that leaves the whole policy to its caller ([bubblewrap](https://github.com/containers/bubblewrap)). Two different mechanisms, none on Windows, and a home-made file-system and resource policy on each. They suit cutting the network of one known program with fixed arguments ([ADR 0003](0003-library-source-only-on-reviewer-request.md)), not running a stranger's code.
- Apple's `container`: rejected. It needs macOS 26 on Apple silicon and is not Docker-compatible, so it would be a third runtime for a slice of macOS reviewers only ([apple/container](https://github.com/apple/container)).
- The repository's own dev container: rejected. Its configuration is written by the pull request's author and can run a command on the host (`initializeCommand`), add mounts and capabilities, run privileged and pass any runtime arguments ([dev container reference](https://containers.dev/implementors/json_reference/)); the isolation would be the attacker's choice.
- A remote runner, such as a GitHub Actions job: rejected. The code and its output leave the reviewer's machine, the companion would need credentials to start jobs, and GitHub's own guidance warns against running untrusted pull request code where it can reach secrets or a self-hosted runner ([secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)). Its results would also be one more CI log rather than a run the reviewer chose.
- Windows Sandbox: rejected. It is Windows-only, missing from Windows Home, allows one instance at a time and has networking on by default ([Windows Sandbox](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-overview)).

The Docker-compatible CLI is the one route that works the same on macOS, Linux and Windows, with the flags above documented for both [Docker](https://docs.docker.com/reference/cli/docker/container/run/) and [Podman](https://docs.podman.io/en/latest/markdown/podman-run.1.html).

## Consequences

These are the known gaps:

- **A container escape reaches the runtime's VM and its shared folders.** On macOS and Windows the containers run in the runtime's Linux VM; Docker Desktop shares `/Users`, `/Volumes`, `/private`, `/tmp` and `/var/folders` with that VM by default ([Docker Desktop file sharing](https://docs.docker.com/desktop/settings-and-maintenance/settings/)). On Linux an escape lands on the host, as the user the runtime runs as. The flags make an escape harder; they cannot rule out a kernel or runtime bug.
- **The image pull uses the network.** The image is fetched by digest before the run, from its registry, through the reviewer's runtime and its login.
- **The dependency step has network.** It must reach the package registry, so install scripts in that step can reach the network too; the run step that follows has none.
- **It needs a runtime.** A reviewer without `docker` or `podman` gets no sandboxed run.

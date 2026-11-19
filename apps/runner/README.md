# Podster Runner

Runner pairs your machine with one of your Podster agents and polls its inbox, outbound only. With your provider key it runs the tasks its run policy allows, with Claude Code and each task in their own Docker containers. It runs tasks on macOS (Docker Desktop) and on Linux, which includes Windows through WSL2. Native Windows isn't supported.

## Linux

**Validated so far only by CI's Linux job,** on GitHub's Ubuntu runner with Docker Engine (S-47). That job builds both images, starts the containers with the relay, and checks that the provider key is in none of them, that the relay refuses a request without its per-run token, and that nothing is left afterwards. It calls no provider. No task has run end to end with Claude Code on Linux yet.

You need:

- Docker Engine, which your user can reach without `sudo`: `docker version` names a server. Rootful Docker only. Rootless Docker, user-namespace remapping, and SELinux enforcing on bind mounts aren't supported yet, so Runner's check fails there.
- `docker` at `/usr/bin/docker` or `/usr/local/bin/docker`.
- Runner's home and the workspace root in the Linux file system, owned by you.

How it differs from macOS:

- **The relay.** On a Mac, Claude Code's requests reach Runner's listener over TCP through Docker Desktop's `host.docker.internal`. On Linux the listener is a Unix socket in the run's own folder, mode 600, which only the relay container mounts, read-only, and forwards to with `socat`. The relay joins no network but the run's internal one, and no TCP port opens on your machine. The per-run token is still required.
- **A check before any task.** `run --provider-key-file` first checks that Docker answers, then sends one request from a throwaway Claude Code container through the relay to a throwaway listener. If either fails, Runner refuses to run tasks (`linux_check_failed`), says which part failed, and runs nothing. Pairing and polling still work.
- **Where your keys go.** If the Secret Service answers (GNOME Keyring or KWallet, through `/usr/bin/secret-tool`), Runner keeps its keys there. Otherwise it keeps them in files under `keys/` in Runner's home: the folder mode 700 and each file mode 600, both yours, each replaced whole when written. Runner refuses a key folder or file with any other mode or owner. Anyone who can read your files can read these. Runner prints one line saying which store it uses. The choice is made once per home, in `key-store` there, so a locked keyring later shows as an error rather than a lost pairing.

## Windows (WSL2)

**Validated only by CI's Linux job and by M7's staging run (step 16) on Long's machine.** Nothing else has run Runner under WSL2.

Runner on Windows runs inside a WSL2 Linux distro and follows the Linux path above. Native Windows is refused, with a message pointing here.

1. Install WSL2 and a distro such as Ubuntu: `wsl --install` in PowerShell.
2. Install Docker Desktop for Windows with its WSL2 backend.
3. In Docker Desktop, open **Settings > Resources > WSL integration** and turn it on for your distro. Apply, then open a new terminal in the distro.
4. In the distro, `docker version` should name a server. Install Node 22 or later in the distro, not on Windows.
5. Keep Runner's home and your workspace root in the distro's own file system, such as `~/.podster-runner`. Runner refuses either one under `/mnt/<drive>` (the Windows file system, where Linux file modes aren't enforced and access is slow), and refuses Runner's home on any 9p or drvfs mount.

A WSL2 distro usually has no Secret Service, so Runner uses its file store there and says so.

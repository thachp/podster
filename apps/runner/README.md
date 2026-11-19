# podster (Runner, test pre-release)

**Test pre-release for Podster's staging only. Not supported. Not security-reviewed (M7 step 17 pending).**

Don't use it with anything you can't lose. It talks to Podster's staging deployment, which can be reset at any time. Versions are `0.0.x-test.N`, published only under npm's `test` tag; npm may also point `latest` at the first version. The real release, once M7's gate and security review pass, replaces it.

Runner pairs your machine with one of your Podster agents, then polls that agent's inbox from your machine, outbound only. With your provider key it runs the tasks its run policy allows, in Docker containers. Unattended runs are off by default: you approve each run at your terminal unless you switch them on for a workroom in Runner's own run policy, `policy.json` in Runner's home. Nothing Podster sends can switch them on.

## Requirements

- Node 22 or later.
- To run tasks, Docker on one of these, since Claude Code and each task run in their own containers:
  - macOS, with Docker Desktop;
  - Linux, with Docker Engine ([Linux](#linux));
  - Windows, only inside a WSL2 Linux distro with Docker Desktop's WSL integration ([Windows (WSL2)](#windows-wsl2)). Runner refuses native Windows.

  On any other system Runner refuses to run tasks (`platform_unverified`), and pairing and polling still work.
- Git at `/usr/bin/git`, `/opt/homebrew/bin/git` or `/usr/local/bin/git`.

## Commands

Run it with install scripts off, as below: no dependency Runner uses needs one. Or set `npm_config_ignore_scripts=true` in your environment. The package ships `npm-shrinkwrap.json`, so `npx` installs exactly the dependencies Runner was tested with.

Pair this machine with the agent a pairing in Podster started. Paste the code when asked: it's never an argument.

```bash
npx --ignore-scripts podster@test pair --agent <agt_…>
```

The gateway is staging's, `https://gateway-staging.podster.dev`, unless you name another with `--gateway <https://…>`.

Poll the inbox until you stop it with Ctrl-C:

```bash
npx --ignore-scripts podster@test run
npx --ignore-scripts podster@test run --provider-key-file <path>
```

Then:

```bash
npx --ignore-scripts podster@test status   # what this Runner's record says, by IDs
npx --ignore-scripts podster@test stop     # stop the Runner running from this home, and any run, at once
npx --ignore-scripts podster@test forget   # delete this Runner's keys and record; disconnect the agent in Podster yourself
```

Every command takes `--home <folder>`, Runner's own folder. The default is `~/.podster-runner`.

Running tasks needs plain paths: letters, digits, `.`, `_`, `-` and `/` only. If your home folder's path has a space or any other character, Runner refuses to run tasks (`helper_unavailable`, or `path_unsafe` for its home), since both npm's cache, where `npx` puts Runner (`<cache>/_npx`), and `~/.podster-runner` sit under it. Then point npm's cache and Runner's home at plain folders only you can write, for example `npm_config_cache=/Users/Shared/podster-npm npx --ignore-scripts podster@test run --home /Users/Shared/podster-runner …`, and use the same two on every command.

## Your provider key

Without `--provider-key-file`, `run` records offers and accepts none.

To run tasks, put your Anthropic API key alone in a file that you own and only you can read, then pass its path:

```bash
chmod 600 <path>
```

Runner refuses a key file that's a link, that someone else can read, or that holds anything but one key. It reads the key once and keeps it on your machine, in its own process: never in a task's container, a log, an argument or the environment of anything it starts. Use a key with a spending limit you set at the provider.

Runner's two container images, one for each task and one for Claude Code, are pinned by image ID in Runner's home. The first time `run --provider-key-file` finds one missing, Runner builds it with Docker from the Dockerfile in this package, says so first, and pins what it built. A build takes a few minutes, and the Claude Code image downloads Claude Code from npm's registry. If a build fails, `run` stops before running anything.

## Your run policy (`policy.json`)

Runner runs a task only if your run policy says so. The policy is a file, `policy.json`, in Runner's home: by default `~/.podster-runner/policy.json`, or the folder you give with `--home`. You write it; nothing Podster sends can change it. Runner reads it again on every evaluation, so an edit counts at the next task with no restart. A file that's missing, unreadable or invalid in any way means no policy, and Runner runs nothing.

A complete, valid example, for one workroom. Replace the `org_…` and `ws_…` placeholders with your own IDs, and `/Users/you/podster-work` with a plain absolute folder of your own that isn't inside Runner's home:

```json
{
  "version": 1,
  "revision": 1,
  "owner_org": "org_…",
  "adapter": "claude_agent_sdk",
  "workspace_root": "/Users/you/podster-work",
  "caps": {
    "spend_micro_usd": 500000,
    "run_time_ms": 900000,
    "turns": 30,
    "output_tokens": 20000,
    "max_tokens": 8000
  },
  "day_caps": { "spend_micro_usd": 2000000 },
  "rooms": [
    {
      "room_id": "ws_…",
      "mode": "ask",
      "outputs": "hold",
      "tools": ["read", "search", "write", "edit"],
      "network": [],
      "repository": null,
      "allowed_orgs": [],
      "acknowledged": { "trust_statement": true, "public_room_warning": true }
    }
  ]
}
```

| Field | What it means |
| --- | --- |
| `version` | Always `1`. |
| `revision` | A whole number from 1 up. Raise it when you edit the file. |
| `owner_org` | Your own organization's ID. Tasks from your own organization are always allowed. |
| `adapter` | Always `"claude_agent_sdk"`. |
| `workspace_root` | An absolute folder where task folders are made. Plain path characters only, no `,` `:` `=`, not inside Runner's home and not holding it, and not on a Windows drive under WSL2 (`/mnt/c`). |
| `caps` | Limits for one run. Each can be set lower than its ceiling, never above, and none can be left out. Money is in micro-USD: 1000000 is 1 USD, so `500000` is 0.50 USD. Time is in milliseconds. |
| `caps.spend_micro_usd` | Spend for one run, 1 to 25000000 (25 USD). |
| `caps.run_time_ms` | Time for one run, 60000 (1 minute) to 86400000 (24 hours). |
| `caps.turns` | Model turns in one run, 1 to 1000. |
| `caps.output_tokens` | Output tokens in one run, 1 to 1000000. |
| `caps.max_tokens` | Tokens in one model reply, 1 to 32000, and no more than `output_tokens`. |
| `day_caps.spend_micro_usd` | Spend across all runs in a day. At least `caps.spend_micro_usd`, and at most 250000000 (250 USD). |
| `max_active_tasks` | Optional. How many tasks Runner holds at once, 1 to 4. Leave it out for 1. |
| `rooms` | One entry per workroom you allow. A workroom not listed here is never run. |
| `rooms[].room_id` | The workroom's `ws_…` ID. |
| `rooms[].mode` | `"ask"` shows each run at your terminal for you to approve. `"unattended"` runs without asking. Unattended runs are off by default: leave `mode` out or set `"ask"` until you choose otherwise. |
| `rooms[].outputs` | `"hold"` keeps a finished run's result on your machine until you approve publishing it. `"share"` publishes it. Leaving it out means `"hold"`. |
| `rooms[].tools` | Runner's own tools for a task. `read`, `search`, `write` and `edit` are the default. `shell` is never on unless you list it. |
| `rooms[].network` | Host names a task may reach, such as `"registry.npmjs.org"`. An empty list, the default, means no network. |
| `rooms[].repository` | `null` for a task that starts in an empty folder, or `{ "full_name": "owner/name", "provider_repo_id": 123456 }` for one GitHub repository. |
| `rooms[].allowed_orgs` | Other organizations whose tasks you'll run in this room. Do not list `owner_org`: your own organization is always allowed, and Runner refuses a policy that lists it. An empty list is fine. |
| `rooms[].acknowledged` | Both flags are required. Until `trust_statement` is `true`, Runner asks you at your terminal each time. Until `public_room_warning` is `true`, it also asks for a public room. |

Every ID is lower case. Unknown fields, missing fields, a field out of range, or a repeated room refuse the whole file.

**Where to find the IDs.** A workroom's `ws_…` ID is in its address in the web app: `/w/ws_…/…`. For your organization's `org_…` ID, open Settings, then Organization, and pick the organization: the `org=` in the address bar is its ID. If you can't find it, ask your Podster admin.

### Writing the key file without the clipboard

Pasting a key into an editor often adds a newline or a space, and Runner refuses a key file that holds anything but one key. Write it from your terminal instead, so the key never touches the clipboard history of an editor:

```bash
read -rs k
printf '%s' "$k" > <path>
chmod 600 <path>
unset k
```

Paste the key when `read` waits (nothing shows as you paste), then press Return. Check the file without printing the key:

```bash
head -c 7 <path>
```

It should print `sk-ant-`.

## Nudges (optional, off by default)

Runner polls, and that's enough to get every offer. If you want offers picked up sooner, you can also let Podster nudge Runner. A nudge only makes Runner poll sooner: it never carries a task, never starts a run by itself, and polling stays on, so a missed nudge loses nothing. **Proposed** (M7 step 14), not security-reviewed.

You need a public HTTPS address you control that forwards to your machine: a reverse proxy, or a tunnel you run (for example `cloudflared`). It ends TLS and forwards to Runner's port on `127.0.0.1` with the path unchanged. Podster sends only to `https://` at a DNS name on the default port. Runner listens only on `127.0.0.1`, never on your network.

```bash
npx --ignore-scripts podster@test run --nudge-listen 8787 --nudge-url https://runner.example.com/podster/nudge
```

Runner then:

1. listens on `127.0.0.1:8787`;
2. registers the address with Podster as this agent's nudge endpoint, and keeps the signing secret Podster gives it in the key store with its other keys, never in a file, a log or an argument;
3. asks Podster to check it: Podster sends one signed challenge to the address, and Runner answers with a proof only the secret can make.

Runner prints the endpoint's version. An admin of the agent's organization switches the nudge on for that version in Podster; the agent can't. Starting Runner again with the same address keeps the registration and the switch. A new address, or a secret Runner no longer holds, needs the check and the switch again.

Runner takes a request only if its signature checks out under the secret and its time is within 5 minutes, before reading anything in it. It refuses replays, bodies over 8 KB and anything but a nudge or the challenge, and it limits how many requests it takes a minute. Stopping Runner closes the port. Podster switches the endpoint off after 3 failed nudges in a row; polling goes on either way.

## Linux

**Validated so far only by CI's Linux job,** on GitHub's Ubuntu runner with Docker Engine (S-47). That job builds both images, starts the containers with the relay, and checks that the provider key is in none of them, that the relay refuses a request without its per-run token, and that nothing is left afterwards. It calls no provider. No task has run end to end with Claude Code on Linux yet.

You need:

- Docker Engine, which your user can reach without `sudo`: `docker version` names a server. Rootful Docker only. Rootless Docker, user-namespace remapping, and SELinux enforcing on bind mounts aren't supported yet, so Runner's check fails there.
- `docker` at `/usr/bin/docker` or `/usr/local/bin/docker`.
- Runner's home and the workspace root in the Linux file system, owned by you. On Linux, Runner's home path may be at most 51 bytes, so each run's Unix socket path fits; the default, `~/.podster-runner`, does. A longer `--home` is refused with a message saying so.

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
4. In the distro, `docker version` should name a server. Install Node 22 or later in the distro, not on Windows, and run the `npx --ignore-scripts podster@test …` commands above from the distro's terminal.
5. Keep Runner's home and your workspace root in the distro's own file system, such as `~/.podster-runner`. Runner refuses either one under `/mnt/<drive>` (the Windows file system, where Linux file modes aren't enforced and access is slow), and refuses Runner's home on any 9p or drvfs mount.

A WSL2 distro usually has no Secret Service, so Runner uses its file store there and says so.

## Where it comes from

Each version is built and published by the `runner-prerelease` workflow on `main` of `github.com/thachp/podster`, with npm provenance. The one exception is the first, `0.0.1-test.1`, which the owner published once from that workflow's own build, without provenance, on 2026-11-19 (see `docs/runner-prerelease.md` in the repository). The package refuses a plain `npm publish` from a machine, but that check only catches mistakes: what limits who can publish is npm's own trusted-publisher and package settings. MIT licensed.

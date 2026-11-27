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
- Git 2.25 or later (Ubuntu 20.04's) at `/usr/bin/git`, `/opt/homebrew/bin/git` or `/usr/local/bin/git`. With an older Git, Runner logs `git_too_old` at startup and runs no task in a room with a repository.

## Commands

Run it with install scripts off, as below: no dependency Runner uses needs one. Or set `npm_config_ignore_scripts=true` in your environment. The package bundles the dependencies Runner was tested with, so `npx` installs exactly those, about 43 MB. It installs no Claude Code binary: Runner runs Claude Code only in its own container, built from `claude-image/Dockerfile`.

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
npx --ignore-scripts podster@test why <tsk_…>   # the newest failure recorded for a task on this machine
npx --ignore-scripts podster@test trust <ws_…>   # read and accept the trust statement for a room's unattended runs
npx --ignore-scripts podster@test trust <ws_…> --share   # read and accept the public-sharing acknowledgement for a public room
npx --ignore-scripts podster@test stop     # stop the Runner running from this home, and any run, at once
npx --ignore-scripts podster@test forget   # delete this Runner's keys and record; disconnect the agent in Podster yourself
```

Every command takes `--home <folder>`, Runner's own folder. The default is `~/.podster-runner`.

Running tasks needs plain paths: letters, digits, `.`, `_`, `-` and `/` only. If your home folder's path has a space or any other character, Runner refuses to run tasks (`helper_unavailable`, or `path_unsafe` for its home), since both npm's cache, where `npx` puts Runner (`<cache>/_npx`), and `~/.podster-runner` sit under it. Then point npm's cache and Runner's home at plain folders only you can write, for example `npm_config_cache=/Users/Shared/podster-npm npx --ignore-scripts podster@test run --home /Users/Shared/podster-runner …`, and use the same two on every command.

## When something fails

Runner's log is one JSON line per event, with IDs and a code, on standard error. Under each failure, refusal or stop it adds a line in plain English: what happened, what to do, the code, and where the details are. For example:

```text
  why: The task's container couldn't be started or prepared. Check that Docker is running and the task image is built; the details file has Docker's exit code and output. (code container_failed; details: ~/.podster-runner/logs/errors.jsonl)
```

The details are in `logs/errors.jsonl` in Runner's home: one line per failure, with the time, the run's IDs, the code, and the raw error's message and stack. For a Docker command it also has Docker's exit code and the end of its error output. Each field is cut to 4 KiB. Before anything is written, the exact tokens Runner holds for a run (its broker token and the task's GitHub token) are written as `[redacted]`, and so is anything else that looks like a key or token. If Docker cut its own output, the last word of that output is redacted too. The folder is readable only by you (mode 700, owned by you, not a link). The file is mode 600, owned by you, with one link. The file is kept to 1 MiB and moves to `errors.jsonl.1` and `.2` as it fills, so at most three files are kept. It stays on this machine: Runner never sends it to Podster or anywhere else. `podster why <tsk_…>` prints a task's newest entry.

The room sees only fixed words. When the agent answers `blocked`, Runner posts its reason on the task's thread, under the room's output policy. When a run can't start, Runner posts a fixed note with one generic code, `runner_could_not_start`. The specific cause stays in your terminal and the details file, never in the room.

When the agent's structured result breaks one of Runner's rules, Runner tells the agent which rule, in fixed words, so it can fix it and give the result again. Examples: a summary that's too long, a file outside the task's folder, an unknown field. The log's code names the rule, such as `result_file_outside_folder`.

## Your provider key

Without `--provider-key-file`, `run` records offers and accepts none.

To run tasks, put your Anthropic API key alone in a file that you own and only you can read, then pass its path:

```bash
chmod 600 <path>
```

Runner refuses a key file that's a link, that someone else can read, or that holds anything but one key. It reads the key once and keeps it on your machine, in its own process: never in a task's container, a log, an argument or the environment of anything it starts. Use a key with a spending limit you set at the provider.

Runner's three container images, one for each task, one for Claude Code and one for the egress proxy (used only by rooms that list hosts in `rooms[].network`), are pinned by image ID in Runner's home. The first time `run --provider-key-file` finds one missing, Runner builds it with Docker from the Dockerfile in this package, says so first, and pins what it built. A build takes a few minutes, the Claude Code image downloads Claude Code from npm's registry, and the task image downloads Node.js from nodejs.org. If a build fails, `run` stops before running anything.

The task image is Debian bookworm-slim with the tools Runner's own task tools use (`cat`, `tee`, `mkdir`, `ls`, `kill` and ripgrep's `rg`), `/bin/sh` for a run policy that allows the shell, and Node.js 22.23.5 LTS with its npm and npx, so a task's shell commands can run `node`, `npm test` or `npx` on what's already in the task's folder. Each is pinned: the base by digest, Debian's packages at exact versions from one snapshot, and Node's official tarball by a SHA-256 written in the Dockerfile. npm keeps its cache and logs in `.cache/home/.npm` in the task's folder, under the task's `HOME` (Runner's fixed `npm_config_cache`, which overrides the image's npmrc), and its global prefix in `.npm-global` there; neither is ever committed; the rest of the container is read-only. A task's container has no network unless its room lists hosts in `rooms[].network`, so without that, `npm install`, and `npx` of a package that isn't already in the task's `node_modules`, fail. With `"network": ["registry.npmjs.org"]`, npm reaches the registry through Runner's egress proxy.

## Your run policy (`policy.json`)

Runner runs a task only if your run policy says so. The policy is a file, `policy.json`, in Runner's home: by default `~/.podster-runner/policy.json`, or the folder you give with `--home`. You write it; nothing Podster sends can change it. Runner reads it again on every evaluation, so an edit counts at the next task with no restart. A file that's missing, unreadable or invalid in any way means no policy, and Runner runs nothing.

### Making one with `setup`

Instead of writing it by hand, let Runner propose a starter from a workroom's settings:

```bash
npx --ignore-scripts podster@test setup --room <ws_…>
```

Leave out `--room` to pick from the rooms this agent is in. Runner asks Podster, as your paired agent, for its own organization (that becomes `owner_org`, never the room's) and for what it may tell this agent about the room, so nothing is copied by hand: the room's ID; its organization, when the room is your organization's or the agent sees the whole room; and its linked GitHub repository, name and numeric ID, only while the agent holds a push grant on it. Anything Podster doesn't tell is unknown. An unknown repository is written as `null`, which gives tasks none, and `run` asks you once Podster names one. It shows the policy it would save and what it allows, and saves it only when you type `y`. The starter asks before each run, holds outputs for your review, has no shell and no network, keeps the limits low (0.50 USD, 15 minutes and 30 turns a run, 2 USD a day), and leaves the public-room warning unticked. Unattended runs stay off until you edit `mode` yourself and accept the trust statement with `trust`, below. A new policy puts task folders in `~/podster-work` unless you give `--workspace-root <folder>`.

- **Another organization's room** is shown as external. Runner refuses its tasks unless that organization is in the room's `allowed_orgs`, and asking before each run doesn't allow it by itself; setup adds it only if you say yes to exactly that. If Podster doesn't name the organization to this agent, setup can't propose it: add its `org_…` ID to `allowed_orgs` yourself.
- **A policy you already have is never replaced.** A room it lacks is added, with everything else kept as you wrote it and `revision` raised. A room it has is checked for a repository change, below. A file Runner can't use, or one for another organization, is left alone and Runner says what's wrong.
- **Facts Runner can't use are never guessed.** If Podster doesn't tell the agent the room's organization and repository (an agent there through a public claim isn't told), or tells it something that doesn't check out, setup explains and saves nothing.

**Room changes after setup.** While `run` goes on, Runner reads each room in your policy again every 10 minutes. If Podster now names a repository for a room, or another one, Runner shows the room, the repository's name and GitHub ID, and what the room keeps, and asks you; only `y` writes it, and only that room's `repository` and the policy's `revision` change. `n` keeps your policy as it is until Podster's answer changes again or Runner restarts. Runner never removes a repository by itself: Podster names one only while the agent holds a push grant on it, so Runner can't tell an unlinked repository from one it isn't told about. If the room no longer links it, its tasks are refused (`get_repo_access`), and you edit the entry. Nothing Podster says ever changes `mode`, `allowed_orgs`, tools, network, limits or acknowledgments.

Runner writes `policy.json` only while it still holds the text your answer was about, checked just before the write, and reads it back after. If you edited the file meanwhile, Runner writes nothing and asks again; if something else wrote it at the same moment, Runner says so and asks again. One narrow window stays: an editor that saves in the instant between Runner's last check and its write, and doesn't save again, loses that save to Runner's. Don't edit `policy.json` while a setup or room-change question is open.

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
      "acknowledged": { "public_room_warning": false }
    }
  ]
}
```

| Field | What it means |
| --- | --- |
| `version` | Always `1`. |
| `revision` | A whole number from 1 up. Raise it when you edit the file. |
| `owner_org` | Your own organization's ID. Tasks from your own organization are always allowed. |
| `adapter` | `"claude_agent_sdk"`, the default. `"openai_agents"` is experimental and off by default: see [The experimental OpenAI adapter](#the-experimental-openai-adapter). |
| `experimental_openai` | Optional, `true` or `false`. Only `true` lets `adapter` be `"openai_agents"`; without it Runner refuses the file and won't start. |
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
| `rooms[].outputs` | `"hold"` keeps a finished run's result on your machine until you approve publishing it. `"share"` publishes it when every word of the task comes from your organization. In a public room, `"share"` counts only after you accept the public-sharing acknowledgement for that room; until then Runner still holds the result. See [Sharing in a public room](#sharing-in-a-public-room). Leaving it out means `"hold"`. |
| `rooms[].tools` | Runner's own tools for a task. `read`, `search`, `write` and `edit` are the default. `shell` is never on unless you list it. |
| `rooms[].network` | Host names the room's tasks may reach, such as `["registry.npmjs.org"]` so an agent can `npm install`; `[]`, the default, is no network. Only HTTPS on port 443 to exactly these names, through Runner's egress proxy: no subdomain, other host, plain HTTP, other port or IP address, and never a name that resolves to your LAN or this machine. List exact lower-case names, at most 50; a scheme, port, path, wildcard, IP address, upper case, trailing dot or a name like `localhost` is refused when Runner starts, with `network_host_invalid` and the entry's index. A listed host is fully reachable, so list only hosts you'd let the task send data to, and a host behind a shared CDN can be used to reach other sites on that CDN (domain fronting), which an allowlist of names can't stop. Needs Docker Engine 26 or later; an older one refuses the run with `docker_engine_too_old`. Runner logs each allowed or refused host when a run ends. |
| `rooms[].toolchains` | Optional toolchains for the room's tasks: any of `"dotnet"`, `"java"`, `"python"` and `"rust"`, such as `["rust", "python"]`. `[]`, the default, runs tasks in Runner's base image (shell tools and Node 22). `rust` adds Rust 1.100.0 (cargo, rustc, rustfmt, clippy) with gcc as its linker; `python` adds Python 3.14.10 and uv 0.13.9; `dotnet` adds the .NET 10 SDK 10.0.404; `java` adds the Temurin JDK 25.0.5.1 and Maven 3.10.1 (a Gradle project uses its own wrapper). Each needs `shell` in `tools`. Runner builds the room's image from its own pinned Dockerfiles the first time a task needs it, which takes a few minutes and counts against that run's time; after that it's reused. A toolchain adds no network: to fetch packages, list the registries in `network`, `index.crates.io` and `static.crates.io` for crates, `pypi.org` and `files.pythonhosted.org` for PyPI, `api.nuget.org` for NuGet, `repo.maven.apache.org` for Maven Central, and for a Gradle wrapper `services.gradle.org` with `github.com` and `release-assets.githubusercontent.com`, where it downloads Gradle from (plus `plugins.gradle.org` for plugins). Listing `github.com` for the wrapper opens all of GitHub to the task, not only Gradle's downloads. Toolchain rooms get larger bounds a build needs: 4 GB of memory, 1,024 processes and 10 minutes per command. An unknown or repeated name is refused when Runner starts, with `toolchain_unknown` or `toolchain_duplicate` and the entry's index, and toolchains without `shell` with `toolchain_needs_shell`. |
| `rooms[].repository` | `null` for a task that starts in an empty folder, or `{ "full_name": "owner/name", "provider_repo_id": 123456 }` for one GitHub repository. |
| `rooms[].roles` | What Runner does when the room invites this agent to a role opening. `"ask"`, the default, asks you at your terminal: `y` claims it as this agent, `n` turns it down, anything else leaves it for later. `"accept"` claims it with no question. Runner never turns an invite down by itself, and a room not listed here always asks. Claiming accepts no task and gives no person access. A pairing made before Runner answered invites can't: Runner logs `pair_again_for_roles` once. Tasks still run and roles already held stay, so you can leave it. Pairing again makes a new agent with a new ID, which must be added to each room and given its roles and any push or merge grants again; the old agent keeps its place until removed. |
| `rooms[].allowed_orgs` | Other organizations whose tasks you'll run in this room. Do not list `owner_org`: your own organization is always allowed, and Runner refuses a policy that lists it. An empty list is fine. |
| `rooms[].acknowledged` | `{ "public_room_warning": false }` or `true`, required. Until it's `true`, Runner asks you at your terminal before each run in a public room. The trust statement isn't here: a file can't accept it, and Runner refuses a policy whose `acknowledged` names `trust_statement` (`trust_statement_moved`). See [The trust statement](#the-trust-statement). |

Every ID is lower case. Unknown fields, missing fields, a field out of range, or a repeated room refuse the whole file.

**Where to find the IDs.** A workroom's `ws_…` ID is in its address in the web app: `/w/ws_…/…`. For your organization's `org_…` ID, open Settings, then Organization, and pick the organization: the `org=` in the address bar is its ID. If you can't find it, ask your Podster admin.

### The trust statement

A room whose `mode` is `"unattended"` still asks you before each run (`trust_statement_not_accepted`) until you've read and accepted Runner's trust statement for that room. It says what you take on when Runner runs without asking: Runner trusts Podster to say who wrote a task, so a compromised Podster could send instructions labeled as your organization's; a listed network host can receive anything a run can read; in a room with `shell`, a listed host and a private repository, a run holds private code, can read words no one in your organization wrote, and has a way out; the model provider sees the room's content; and runs spend up to their caps without asking. Accept it at a terminal on this machine:

```bash
npx --ignore-scripts podster@test trust ws_…
```

Runner shows the whole statement and records your acceptance only when you type `accept`. Without a terminal it asks nothing and records nothing. It keeps, in `trust.json` in Runner's home, the room, the statement's version and SHA-256, and when you accepted. Don't write that file yourself: it's Runner's record of what you read. If a later Runner changes the statement, its version and hash change, and every unattended room asks again until you accept the new one. Accepting doesn't switch a room to unattended runs; `mode` does, and setting it back to `"ask"` stops them at the next evaluation. `run` reads `trust.json` again at every evaluation, so you can accept from another terminal while it runs.

### Sharing in a public room

In a public room Runner holds the agent's words (its result note and summary), its commit, its push and its pull request for your review, even when the room's `outputs` is `"share"`, until you accept the public-sharing acknowledgement for that room (the owner's ruling of 2026-11-27). It says: Runner will send the agent's own words to Podster without asking you first; anyone who can see the room can read them; and Runner redacts secrets it recognises, but not all. Runner's ask screen, `setup`'s preview and the `public_share_not_acknowledged` log line say how to accept it:

```bash
npx --ignore-scripts podster@test trust ws_… --share
```

Runner shows the whole acknowledgement and records it only when you type `share` (the trust statement's `accept` doesn't count). It's offered only for a room Runner last saw public: Runner learns a room's visibility from Podster when `run` reads one of its tasks, and keeps what it saw in `room-visibility.json`. It keeps, in `public-share.json` in Runner's home, the room, the acknowledgement's version and SHA-256, that the room was public, when its current public stretch began, and when you accepted. Don't write either file yourself. The acknowledgement stops counting if the statement changes, or if Runner sees the room go private and then public again, and then Runner holds the words and asks again. A private stretch during which Runner read none of the room's tasks can't be seen. It changes nothing else: a task with any words from outside your organization is still held, a private room is as before, a push to a public repository still asks you each time, and the trust statement is still needed for unattended runs. Set `outputs` to `"hold"` to stop sharing at the next evaluation.

### The experimental OpenAI adapter

*Built 2026-11-22, off by default, and not verified for support.* Runner can run tasks through OpenAI's Agents SDK instead of the Claude Agent SDK. Use it with **test content only**: room content (the task's text, the files a tool reads and the tools' output) goes to OpenAI under OpenAI's standard data retention, sent with `store: false`. Whether real room content may go to OpenAI, and checking spend against OpenAI's own usage page, are still the owner's to decide.

To opt in, set both of these in `policy.json`:

```json
  "adapter": "openai_agents",
  "experimental_openai": true,
```

Then start `run --provider-key-file <path>` with a file holding an **OpenAI project API key** (`sk-proj-…`), written as below. With the opt-in, `run` prints a warning first. Runner refuses to start when:

- `adapter` is `"openai_agents"` without `"experimental_openai": true`;
- the key file holds another provider's key (an Anthropic key is never sent to OpenAI, nor an OpenAI key to Anthropic);
- `OPENAI_API_KEY`, `OPENAI_BASE_URL` or any other `OPENAI_…` variable is set in Runner's environment, except `OPENAI_AGENTS_DISABLE_TRACING`, `OPENAI_AGENTS_DONT_LOG_MODEL_DATA` and `OPENAI_AGENTS_DONT_LOG_TOOL_DATA`, or `ANTHROPIC_API_KEY` is. Unset them first (for example `env -u OPENAI_API_KEY npx podster@test run …`);
- the installed `@openai/agents-core`, `@openai/agents-openai` or `openai` isn't the pinned version;
- `caps.max_tokens` is below 4096. OpenAI counts the model's reasoning inside each reply's output bound, and a low bound can be spent entirely on reasoning with nothing returned, so Runner never sends a request with a smaller bound. When fewer than 4096 of the run's `output_tokens` are left, the run stops on its output cap.

It asks only for `gpt-6-luna`, and uses the same run policy, task container, tools, egress proxy and caps as the Claude path. Tracing to OpenAI is switched off. One adapter runs per Runner: the whole Runner uses the one `policy.json` names.

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

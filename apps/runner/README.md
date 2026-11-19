# podster (Runner, test pre-release)

**Test pre-release for Podster's staging only. Not supported. Not security-reviewed (M7 step 17 pending).**

Don't use it with anything you can't lose. It talks to Podster's staging deployment, which can be reset at any time. Versions are `0.0.x-test.N` on npm's `test` tag, never `latest`, and the real release, once M7's gate and security review pass, replaces it.

Runner pairs your machine with one of your Podster agents, then polls that agent's inbox from your machine, outbound only. With your provider key it runs the tasks its run policy allows, in Docker containers. Unattended runs are off by default: you approve each run at your terminal unless you switch them on for a workroom in Runner's own run policy, `policy.json` in Runner's home. Nothing Podster sends can switch them on.

## Requirements

- Node 22 or later.
- macOS, with Docker Desktop, to run tasks: Claude Code and each task run in their own containers. On other systems Runner refuses to run tasks (`platform_unverified`), and pairing and polling still work.
- Git at `/usr/bin/git`, `/opt/homebrew/bin/git` or `/usr/local/bin/git`.

## Commands

Pair this machine with the agent a pairing in Podster started. Paste the code when asked: it's never an argument.

```bash
npx podster@test pair --agent <agt_…>
```

The gateway is staging's, `https://gateway-staging.podster.dev`, unless you name another with `--gateway <https://…>`.

Poll the inbox until you stop it with Ctrl-C:

```bash
npx podster@test run
npx podster@test run --provider-key-file <path>
```

Then:

```bash
npx podster@test status   # what this Runner's record says, by IDs
npx podster@test stop     # stop the Runner running from this home, and any run, at once
npx podster@test forget   # delete this Runner's keys and record; disconnect the agent in Podster yourself
```

Every command takes `--home <folder>`, Runner's own folder. The default is `~/.podster-runner`.

## Your provider key

Without `--provider-key-file`, `run` records offers and accepts none.

To run tasks, put your Anthropic API key alone in a file that you own and only you can read, then pass its path:

```bash
chmod 600 <path>
```

Runner refuses a key file that's a link, that someone else can read, or that holds anything but one key. It reads the key once and keeps it on your machine, in its own process: never in a task's container, a log, an argument or the environment of anything it starts. Use a key with a spending limit you set at the provider.

Runner's two container images are pinned by image ID. Build them from a checkout of `thachp/podster` at the commit this version was published from, then write each ID into Runner's home:

```bash
docker build -q apps/runner/sandbox > ~/.podster-runner/task-image
docker build -q apps/runner/claude-image > ~/.podster-runner/claude-image
```

## Where it comes from

Each version is built and published only by the `runner-prerelease` workflow on `main` of `github.com/thachp/podster`, with npm provenance. MIT licensed.

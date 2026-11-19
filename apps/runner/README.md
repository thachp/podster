# podster (Runner, test pre-release)

**Test pre-release for Podster's staging only. Not supported. Not security-reviewed (M7 step 17 pending).**

Don't use it with anything you can't lose. It talks to Podster's staging deployment, which can be reset at any time. Versions are `0.0.x-test.N`, published only under npm's `test` tag; npm may also point `latest` at the first version. The real release, once M7's gate and security review pass, replaces it.

Runner pairs your machine with one of your Podster agents, then polls that agent's inbox from your machine, outbound only. With your provider key it runs the tasks its run policy allows, in Docker containers. Unattended runs are off by default: you approve each run at your terminal unless you switch them on for a workroom in Runner's own run policy, `policy.json` in Runner's home. Nothing Podster sends can switch them on.

## Requirements

- Node 22 or later.
- macOS, with Docker Desktop, to run tasks: Claude Code and each task run in their own containers. On other systems Runner refuses to run tasks (`platform_unverified`), and pairing and polling still work.
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

## Where it comes from

Each version is built and published by the `runner-prerelease` workflow on `main` of `github.com/thachp/podster`, with npm provenance. The one possible exception is the first, `0.0.1-test.1`, which the owner may publish once from that workflow's own build, without provenance (see `docs/runner-prerelease.md` in the repository). The package refuses a plain `npm publish` from a machine, but that check only catches mistakes: what limits who can publish is npm's own trusted-publisher and package settings. MIT licensed.

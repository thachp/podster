# Deploying the content Worker

The content Worker, `apps/content`, serves rooms' apps on the content domain ([ADR 0010](adr/0010-release-and-the-content-domain.md), [M6 plan, step 4(b)](m6-plan.md#step-4b-the-content-worker-the-build-plan)). It deploys to **the second Cloudflare account** ([decision 217](spec/PRODUCT.md#decisions-needed)), never to the one that holds `podster.dev`. It deploys only through `scripts/deploy-content`, and that script has never been run against Cloudflare.

`scripts/deploy-staging` doesn't know this package, and `apps/content/wrangler.jsonc` can deploy nothing anywhere ([why](m6-plan.md#step-4b-the-content-worker-the-build-plan)).

## What it defends against

**Accidents in the owner's shell:**
- a stray exported function or alias from dotfiles;
- tracing left on;
- a proxy variable or a `.curlrc`;
- a leftover token variable;
- the wrong account in the environment.

**It does not defend against someone who already controls the owner's account, files or `PATH`.** Such a person can replace the programs this script runs, and no script can stop that.

## Who runs it

- **Without `--deploy`,** it only reports. It runs every check below, reads Cloudflare's API with the token, prints what it would deploy, and changes nothing. **An agent runs it only like this, and only when the owner asks.**
- **With `--deploy`,** it deploys and then probes the content domain. It needs a person at a terminal: stdin and stdout must be terminals, and the owner types the content domain to confirm. No flag or environment variable skips that.

## Before the first deploy: the owner's open items

Each is the owner's, on the second account. The script's read-only checks find most of them missing or present, so a run without `--deploy` doubles as this checklist.

| Item | Checked by the script |
| --- | --- |
| **The content domain active on that account.** `podster.site` was registered on 2026-11-12 and can't move before 2026-11-22. | Yes: one zone of that name, `active`, on the configured account |
| **Workers for Platforms** on that account ($25 a month), possibly Workers Paid first, and **the dispatch namespace** | The namespace, yes |
| **The serve entries' KV namespace** | Yes |
| **The wildcard DNS record** for `*.` the content domain, proxied, and the redirect from HTTP to HTTPS | Only after a deploy, by the probes |
| **The deploy token,** below | Partly: see what it can't read |
| **Spike G** run first, since it confirms what the API's provider module assumes | No |

None of these comes with a deploy: the six provider settings on the API, the two cron entries, and `RELEASES`. Each is a separate yes.

## The two files

Both live outside every repository, in a directory of mode 0700, each file of mode 0600 and owned by the owner. The script refuses anything else, and refuses a link.

```bash
mkdir -p ~/.config/podster && chmod 700 ~/.config/podster
```

- **`~/.config/podster/content-token`:** the token, exactly one line, with or without a final newline, and nothing after it. Every byte must be a letter, a digit, `-` or `_`: a NUL or a carriage return is refused. Write it with an editor or a paste into the file, never with `echo` on a command line, where it would land in the shell's history.

  ```bash
  touch ~/.config/podster/content-token && chmod 600 ~/.config/podster/content-token
  ```

- **`~/.config/podster/content-deploy.json`:** the deploy-time configuration, exactly these four keys. The ID shapes are checked; the values are the owner's and are never committed.

  ```json
  {
    "account_id": "<the second account's ID, 32 hexadecimal characters>",
    "content_domain": "podster.site",
    "kv_namespace_id": "<the serve entries' KV namespace ID>",
    "dispatch_namespace": "<the dispatch namespace's name>"
  }
  ```

The script builds wrangler's configuration from that file and from `apps/content/wrangler.jsonc`, which supplies only the Worker's name, entry point and compatibility date. That configuration is written to a temporary folder, used, and deleted. Its route is `*.<content domain>/*` on that zone; both public addresses are off.

## The token

**A token of its own, for this deploy only,** not the publishing credential the API will use, and not any token of the account that holds `podster.dev`.

**What the script can and can't check about it:**

- **Can:** that it is active; that it sees exactly one account, the configured one; that it sees no zone named `podster.dev`; and that it can't read API tokens, its own included. A token that can read tokens is refused, since that is more than a deploy needs.
- **Can't:** its other permissions. A token can only read its own permissions if it can read tokens, which is the one thing it mustn't do. So the owner grants exactly what's listed here, and the script's checks catch some mistakes, not all.

**Permissions to grant.** *Proposed, from Cloudflare's permission names; not yet confirmed by a run.* The first report run confirms them: a missing one shows as a refused read, naming what it couldn't read.

| Scope | Permission | Why |
| --- | --- | --- |
| The second account only | Workers Scripts: Edit | Upload the Worker, and read the dispatch namespace |
| The second account only | Workers KV Storage: Read | The script's check that the KV namespace exists. The deploy itself only binds it by ID |
| The content domain's zone only | Workers Routes: Edit | The route `*.<content domain>/*` |
| The content domain's zone only | Zone: Read | The script's check that the zone is active on the account |

**Nothing else:** no other account, no other zone, no API Tokens permission, no DNS, no billing. Give it an expiry date and, if the owner wants, an IP filter.

**How the script keeps the token:**

- **No shell variable ever holds it.** The token is read from its file only where it is handed to a child, so a traced command has nothing to expand. It is never a command's argument, never printed, and never written to a file by the script.
- **Bash only, 3.2 or later.** macOS's `/bin/bash` 3.2 is supported, and the self-test runs under it on macOS and under CI's bash on Linux. Run by `sh`, by `dash`, or by bash in POSIX mode, which is what `sh` is on macOS, it refuses with exit 2 before any of its bash-only lines.
- **A clean process first.** Before anything else, the script starts itself again as `/bin/bash` under `/usr/bin/env -i`.
  - **What the new process has:** only `HOME`, `TERM`, `PATH`, `SSH_AUTH_SOCK` and a few results about the caller's environment. No exported function, alias, `BASH_ENV`, `SHELLOPTS`, `CLOUDFLARE_*` or proxy variable crosses.
  - **Before that exec:** the script runs only what a function or alias can't replace. It sets `POSIXLY_CORRECT`, under which special builtins are found before functions. It uses `case` instead of `[`, and puts a backslash on each command word. It unsets any function named `echo`, the one ordinary command it uses there.
  - **Results carried over:** whether a token or key variable was set, whether tracing or `BASH_ENV` was on, and `CLOUDFLARE_ACCOUNT_ID`, which is an ID and not a secret.
  - **Checked after:** the new process confirms it holds exactly those variables and no function. A caller who sets the marker to skip the exec is refused.
  - **The results must all be there.** With the marker, every carried result must be present and in its form (each flag 0 or 1, a bash version), or it refuses with exit 1 and one line naming what is missing.
  - **It execs once.** A process that has the exec's results but not its marker refuses, exit 1, and never execs again. So a lost marker stops the script instead of making it start over and over.
  - **Needs:** `/usr/bin/env` and `/bin/bash`. Missing either, the exec fails and nothing runs.
  - **Owners who use `GH_TOKEN`:** it isn't carried over, so `gh` must be logged in under `HOME`. Otherwise the CI check fails and the script refuses.
- **Tracing is refused.** The script stops before reading anything if it runs under `bash -x` or `-v`, if `SHELLOPTS` turns on `xtrace` or `verbose`, or if `BASH_ENV` is set. It then switches both off.
- **curl** gets the `Authorization` header on stdin (`--config -`), built from the file inside the pipe. Every curl, the probes' included, runs with `-q` first, so no `.curlrc` is read, under `env -i` with only `PATH` and an empty home. So no proxy variable, no `CURL_HOME` and nothing else of the caller's reaches it.
- **wrangler** runs under `env -i` with an allow-list: `PATH`, a temporary home, configuration, cache and log folder, `CI`, metrics off, and the token. A small shell reads the token on its stdin, from the file, and exports it to wrangler alone. So no wrangler login, no `CLOUDFLARE_ACCOUNT_ID`, no exported function and nothing else of the shell reaches it. The temporary folder is deleted when the script ends.
- **wrangler reads no `.env`.** Wrangler 4.157.0 loads `.env` and `.env.local` from its working directory into its own environment on every command, whatever git ignores. Its source has no variable that switches that off: `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV` governs only `wrangler dev`'s variables. What does switch it off is `--env-file`: given, it replaces those defaults. So wrangler runs from an empty folder of the script's own, with `--env-file` at an empty file. And a `.env` file of any name in `apps/content` is refused all the same.
- If any answer from Cloudflare, or wrangler's output or log, holds the token, the script redacts it and fails.
- It refuses to start if `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_API_KEY` is set in the shell, so the file's is the only credential, and if `WRANGLER_LOG` is `debug`.

**Every answer must have the expected shape.** Each read from Cloudflare's API must be exactly one JSON document, `success: true`, with a `result` of exactly the expected type, and the fields the script uses must be there.
- **Lists:** a list must be a list.
- **Names:** the content domain's zone must carry that name, compared without regard to case, and each namespace answer must name that namespace.
- **Whether the token can read tokens:** judged on the answer's shape as well as its status. A 200 must be a success with a result. A 401 or 403 must be Cloudflare's own refusal, with `success: false` and a list of errors. Anything else refuses, so an unexpected answer is never taken as "no zone" or "one account".

**Not the account that holds `podster.dev`.** The script refuses a configured account equal to `CLOUDFLARE_ACCOUNT_ID`, compared without regard to case, or equal to an account a wrangler login cached in this checkout's other apps. Wrangler keeps the account a login chose in `node_modules/.cache/wrangler/wrangler-account*.json` or `.wrangler/cache/`, with no token in it, and in `WRANGLER_CACHE_DIR` if that is set. **What it can't see:** a login that cached nothing in this checkout. Reading the login itself would mean reading its token, which the script never does.

## Running it

Both paths must be absolute; a relative one is refused. From a checkout detached at `origin/main`'s tip, with nothing changed, after `ci.yml` has passed on main for that commit:

```bash
git fetch origin && git checkout --detach origin/main
```

```bash
scripts/deploy-content --token-file ~/.config/podster/content-token --config-file ~/.config/podster/content-deploy.json
```

That only reports. To deploy, the owner adds `--deploy` at a terminal and types the content domain when asked:

```bash
scripts/deploy-content --token-file ~/.config/podster/content-token --config-file ~/.config/podster/content-deploy.json --deploy
```

`scripts/deploy-content --help` lists every refusal. Exit codes: 0 reported, or deployed and verified; 1 refused, nothing changed; 2 wrong usage; 3 the deploy failed part-way; 4 deployed but a probe failed, so the Worker is deployed and **not verified**. An error the script doesn't handle, such as an unbound variable, never exits 0: it says it stopped, and in which phase.

**Stopped by a signal** (129 SIGHUP, 130 SIGINT, 143 SIGTERM), it says where it was:
- while checking, nothing changed;
- during `wrangler deploy`, the Worker may or may not be deployed, so check the account before running it again;
- during the probes, the Worker is deployed and not verified.

The temporary folder is deleted in every case.

## After a deploy

The script probes one random host on the content domain, signed out:

- **An unknown host** gets the Worker's own `404`, `not_found`, with its fixed headers: `nosniff`, `no-referrer`, HSTS, `no-store`, and the sandbox policy.
- **Plain HTTP** gets a `301` to the same host and path over HTTPS. That can be the zone's redirect or the Worker's own: both must send the same place.
- **A POST** gets `405`, allowing `GET, HEAD`.
- **A request with a `Service-Worker` header** gets `403`.
- **The content domain itself** serves nothing: no answer, or any answer that isn't a success. The route doesn't cover it.
- **Not shown, and the script prints so:** a host two labels deep. The zone's certificate covers one level, so HTTPS there can't be probed.

**What it can't check until the release job (step 5) exists:**

- an app actually served;
- a dispatch to a real script;
- the domain-wide stop's effect;
- how long a takedown takes.

These are spike G's and the first release's to show.

## An open question for the owner: deploy with the stop set?

The domain-wide stop is one key in the serve entries' KV namespace. While it is set, the content Worker refuses every host.

**Should the first deploy go out with the stop already set,** so the Worker serves nothing until the owner lifts it?

- **The architect recommends yes:** nothing is served until the owner decides to serve.
- **The script does nothing either way.** Setting the key is a write to KV with a publishing credential, which this script doesn't hold.
- **The probes pass either way:** with the stop set, an unknown host still gets the Worker's not-found.

## Owed

- A read-only check that the account's Worker names are exactly the expected set, as for staging ([docs/staging.md](staging.md#setting-a-secret-one-form-only)).
- Confirming the permission table above at the first report run.
- Reading wrangler's account-precedence again with every wrangler upgrade ([why](m6-plan.md#step-4b-the-content-worker-the-build-plan)). The script pins 4.157.0 and refuses another.

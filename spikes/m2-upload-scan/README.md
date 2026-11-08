# Spike (M2 step 0): upload streaming and ClamAV scanning

Throwaway. It answers what [ADR 0006](../../docs/adr/0006-uploads-and-scanning.md) says the spike has to show. Nothing here is product code, and none of it reaches the normal deploy: each Worker has its own `podster-spike-*` name and config, and CI and `docs/staging.md` never touch this folder.

**Status: tested locally only.** The result goes into ADR 0006 after a real run.

## What's here

| Folder | What it is |
| --- | --- |
| `web/` | The application's shape. The only public address, and it answers 404 without the spike's token |
| `gateway/` | The gateway's shape. Refuses too large or no length before reading a byte, by service binding only |
| `api/` | The Rust API's shape, on `worker` 0.8.7. No route and no workers.dev address. Counts and hashes while streaming to R2 |
| `scanner/` | A queue consumer and a ClamAV Container, with no route or workers.dev address |
| `local/` | Test files, the measuring scripts, a test of the verdict rules, and the cleanup teardown uses |

The chain is web → gateway → API → R2, then queue → scanner → Container, with the verdict recorded back through the API. Logs carry IDs only.

## Local results

Run on 2026-11-06, on an Apple Silicon Mac with Docker Desktop, using ClamAV 1.5.4 with the signatures in the image (database 28172, November 2).

**Streaming through real workerd, local R2 and service bindings:**

- 100 MB went through with **1.3 MB of Wasm memory** at its peak, in 24,415 chunks of at most 4,096 bytes. That's Wasm linear memory only. Only a real 100 MB upload against the 128 MB limit shows the isolate doesn't buffer it.
- 100,000,001 bytes answers 413, and no length answers 411.
- A wrong hash answers 422 and leaves no object. An upload cut off partway leaves no object.

**The scanner, under Docker's limits for each instance:**

| Instance | Memory at ready | After scanning 100 MB | Cold start |
| --- | --- | --- | --- |
| `basic` (1 GiB, 1/4 vCPU) | 1.02 GB, with 49 MB to spare | **OOM-killed** | 42 to 52 s |
| 2 GiB, 1/2 vCPU (Docker only: a custom instance needs 1 vCPU and 3 GiB) | 1.02 GB | Fine, 1.33 GB peak | 14 s |
| `standard-1` (4 GiB, 1/2 vCPU) | 1.02 GB | Fine, 1.33 GB peak, 2.0 GB during a signature reload | 14 to 15 s, 4 runs |

So `standard-1` is the smallest named instance that fits.

**Verdicts, all 16 as expected:**

| File | Verdict | Said by | Time |
| --- | --- | --- | --- |
| Small text, empty, 100 MB of random bytes, an ordinary nested zip | clean | clamd | 100 MB: 6.8 s |
| EICAR, in a zip, and in nested zips | blocked | clamd | Milliseconds |
| Password-protected zip | blocked | clamd | 9 ms |
| Zip nested 15 deep | blocked | clamd | 45 ms |
| Zip of 20,000 files | blocked | clamd | 12 s |
| **Zip expanding to 2 GB** | blocked | **archive walk, clamd said OK** | 9.8 s |
| **Nested zip expanding to 655 GB** | blocked | **archive walk, clamd said OK** | 3.9 s |
| **EICAR past 150 MB inside a zip entry** | blocked | **archive walk, clamd said OK** | 0.9 s |
| **Truncated zip, and a fake zip** | blocked | **archive walk, clamd said OK** | Under 1 s |
| **A zip damaged inside its LZMA data** | blocked | **archive walk** | Under 1 s |

**The main finding: ClamAV's limits aren't enough on their own.** With `AlertExceedsMax` on, it still answered OK for an archive it stopped reading at `MaxFileSize` or `MaxScanSize`, and for archives it couldn't parse. The EICAR row shows why that matters: a known test virus past the limit passed as clean. `container/server.py` adds a small walk after clamd says OK. It decompresses zips to count them, with the same limits, and blocks at the first one it exceeds. Bombs didn't threaten the scanner itself: no run ran out of memory on `standard-1`.

**Limits of that walk.** It only covers files starting with `PK`, including Office files, which are zips. A prefixed or self-extracting zip isn't walked, and neither is a zip inside gzip, 7z or rar. `gap-prefixed-eicar-past-limit.bin` records what that means: the same hidden EICAR with a line in front of it comes back clean. So **the upload type check is the real control**, and the walk only backs it up. It also hasn't been tried against crafted zips, such as overlapping entries.

**Other results:**

- A scanner that never answers ends as `failed`, not clean, after the queue's retries and dead-letter queue.
- A stalled upload answers 503 after a read timeout, 60 s by default, so it can't keep the Container awake. If clamd dies, the scan ends with no verdict and the Container exits, so the next request starts fresh.
- `freshclam` worked through the local proxy once Cloudflare's CA was trusted. It moved the database from 28172 to 28175 in 4.3 s, and the reload took 20 s more, with memory peaking at **2.0 GB**. So a reload needs room for both copies, which also rules out 2 GiB.
- `example.com` answered 520 from the local proxy, and the mirror's own answer was 403 to a request for `/`. That suggests the allowlist holds, but a local proxy isn't proof.

## What only a deployment can show

- **Cold start on real hardware.** Local was Apple Silicon, and `standard-1` is a real 1/2 vCPU on amd64. It sets how long the first scan after sleeping takes.
- **Whether the image runs there at all.** It built and ran as amd64 locally through emulation.
- **The request limit on a real host.** 100 MB is the limit on Free and Pro zones. Whether the same applies on `workers.dev` as on the real zone is unknown, so this run says little about `app.podster.dev`, and that zone's plan is still unchecked.
- **CPU time** for hashing 100 MB in Wasm against the Worker's limit. Local has no CPU limit. Check `cpuTime` in the Workers metrics.
- **The real Worker memory limit,** and streaming with real latency between Workers and R2. The bucket is in WNAM, which affects timings.
- **That teardown really removes the Container application.** Cloudflare's docs warn it can outlive the Worker, so teardown checks.
- **A 100 MB body from a Durable Object into its Container.** Cloudflare's 100 MiB limit is documented for external requests, and this path hasn't been tried at this size there.
- **The egress allowlist.** `/probes/probe` reports what `database.clamav.net` and `example.com` answer.
- **`freshclam` from Cloudflare's addresses.** `/probes/probe-update` reports its result, timing and memory. ClamAV's mirrors may refuse those addresses.

**Staying current is still a choice.** A Container's disk is lost when it sleeps, so an update in the Container lasts only until then. A real scanner needs either a scheduled image rebuild and deploy, with signatures as old as the last build and possibly no outbound traffic at all, or an update on every start, with a slower cold start. The second adds about 25 s here.

## Run it locally

Needs Docker, and the rustup toolchain rather than Homebrew's Rust, plus `worker-build` 0.8.7. Run everything from this folder.

```bash
export PATH="$(dirname "$(rustup which rustc)"):$HOME/.cargo/bin:$PATH"
```

```bash
npm ci
```

```bash
npm run fixtures
```

```bash
npm run measure:container
```

```bash
npm run measure:path
```

`npm run fixtures` makes test files in `fixtures/`, about 200 MB, none with real data. Results go to `results/`. Neither folder is committed.

## Deploy to staging (for whoever holds the account)

None of this has been run. **The token is the only gate on `web`,** which has no rate limit, so keep it to this run and tear down afterward. It needs Docker running. The queues `podster-scan-staging` and `podster-scan-dlq-staging` and the private bucket `podster-assets-staging` already exist. Keep the account ID in the environment, not in this repo.

```bash
export CLOUDFLARE_ACCOUNT_ID=<the account holding podster.dev>
```

```bash
export PATH="$(dirname "$(rustup which rustc)"):$HOME/.cargo/bin:$PATH"
```

```bash
cargo install worker-build --version 0.8.7 --locked
```

```bash
npm ci
```

Add rules that remove what the spike leaves behind if teardown is missed. They cover only this spike's two prefixes, so real uploads are safe if they're forgotten.

```bash
npx wrangler r2 bucket lifecycle add podster-assets-staging spike-expiry-objects spike/ --expire-days 7 --force
```

```bash
npx wrangler r2 bucket lifecycle add podster-assets-staging spike-expiry-results results/ --expire-days 7 --force
```

```bash
npx wrangler r2 bucket lifecycle list podster-assets-staging
```

The list should show exactly those two rules, each with its prefix.

Deploy in this order, because each one binds the one before. The scanner step builds and pushes the image, and takes a few minutes.

```bash
npx wrangler deploy -c api/wrangler.jsonc
```

```bash
npx wrangler deploy -c scanner/wrangler.jsonc
```

```bash
npx wrangler deploy -c gateway/wrangler.jsonc
```

```bash
npx wrangler deploy -c web/wrangler.jsonc
```

Set the token. Pick any long random value, and don't put it in the repo. It's the only secret here, and only `web` holds it.

```bash
npx wrangler secret put SPIKE_TOKEN -c web/wrangler.jsonc
```

Then run the same path against it, using the address `wrangler deploy` printed for `web`, and read the results in `results/path-deployed.json`.

```bash
npm run fixtures
```

```bash
SPIKE_URL=https://podster-spike-web.<subdomain>.workers.dev SPIKE_TOKEN=<token> npm run measure:path
```

The real cold start is `cold_start_ms` on the first verdict. Also check `cpuTime` for `podster-spike-api` in the dashboard, and that `wrangler tail` shows IDs only.

## Cost at spike volume (my estimate)

Assuming about 25 uploads, under 2 GB stored, and the Container awake for about an hour in total. Everything falls inside what Workers Paid and R2 include, so I expect **$0 above the plan**.

| Resource | Spike use | Included per month | Past that |
| --- | --- | --- | --- |
| Container memory, `standard-1` | 4 GiB-hours | 25 GiB-hours | $0.0000025 per GiB-second |
| Container CPU, active only | Under 30 vCPU-minutes | 375 vCPU-minutes | $0.000020 per vCPU-second |
| Container disk | 8 GB-hours | 200 GB-hours | $0.00000007 per GB-second |
| R2 storage | Under 2 GB | 10 GB-months | $0.015 per GB-month |
| R2 operations | Hundreds | 1M writes, 10M reads | $4.50 and $0.36 per million |
| Queues, Workers, Durable Objects | Hundreds of operations | Far more | Not reached |

The Container bills only while awake and sleeps after 5 minutes, so leaving it deployed costs nothing while idle. For scale, one hour past the allowance is about $0.04 of memory, and a `standard-1` that never slept would be about $26 a month in memory alone. I didn't find a stated charge for image storage. Check the billing page afterward.

## Tear it down

Run these in order, from this folder. Empty the bucket first, because it needs the Workers, and wrangler can't list a bucket. It deletes only under `spike/` and `results/`.

```bash
SPIKE_URL=https://podster-spike-web.<subdomain>.workers.dev SPIKE_TOKEN=<token> node local/empty_bucket.mjs
```

Remove the rules, so nothing can expire in the bucket later.

```bash
npx wrangler r2 bucket lifecycle remove podster-assets-staging --name spike-expiry-objects
```

```bash
npx wrangler r2 bucket lifecycle remove podster-assets-staging --name spike-expiry-results
```

Detach the scanner from both queues. Cloudflare's docs don't say whether a consumer goes with its Worker, so this doesn't rely on it.

```bash
npx wrangler queues consumer worker remove podster-scan-staging podster-spike-scanner
```

```bash
npx wrangler queues consumer worker remove podster-scan-dlq-staging podster-spike-scanner
```

Delete the Workers, dependents first.

```bash
npx wrangler delete podster-spike-web
```

```bash
npx wrangler delete podster-spike-gateway
```

```bash
npx wrangler delete podster-spike-scanner
```

```bash
npx wrangler delete podster-spike-api
```

The Container application can outlive its Worker, so check. Delete only what names `podster-spike-scanner`.

```bash
npx wrangler containers list
```

```bash
npx wrangler containers delete <the application ID for podster-spike-scanner>
```

```bash
npx wrangler containers images list
```

```bash
npx wrangler containers images delete <the image for podster-spike-scanner>
```

Then confirm nothing is left. The first two should print no matches, each `deployments list` should fail because the Worker is gone, the queues should list no consumers, and the bucket's rules should be empty.

```bash
npx wrangler containers list --json | grep podster-spike
```

```bash
npx wrangler containers images list | grep podster-spike
```

```bash
for worker in web gateway scanner api; do npx wrangler deployments list --name podster-spike-$worker; done
```

```bash
npx wrangler queues consumer list podster-scan-staging
```

```bash
npx wrangler queues consumer list podster-scan-dlq-staging
```

```bash
npx wrangler r2 bucket lifecycle list podster-assets-staging
```

The bucket and the queues stay, because their names are the real ones M2 will use. If you ever need them gone, the bucket has to be empty first:

```bash
npx wrangler r2 bucket delete podster-assets-staging
```

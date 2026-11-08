# Scanner

M2 step 3: a queue consumer and a ClamAV Container. It reads each file from R2, and tells the room what it found. Rules: [upload policy](../../docs/spec/UPLOAD-POLICY.md). Design: [ADR 0006](../../docs/adr/0006-uploads-and-scanning.md).

The Container reads hostile files, so it holds no secrets, has no outbound traffic, and carries its signatures in its image. The Worker has no route, and treats every answer as if the Container could be wrong.

## What can happen to a file

| What happened | Sent to the room | Queue |
| --- | --- | --- |
| clamd says OK, and every zip reads through | `no_known_malware` | Ack |
| clamd finds something | `malware_found` | Ack |
| Password-protected, limits, damaged, wrong hash or size, missing | `unreadable` | Ack |
| Scanner never answers, a stall, clamd dies, a bad answer | Nothing | Retry |
| Signatures past 7 days old | Nothing | Retry |
| The room answers 404, 409 or 422 | | Ack, logged as `not_recorded` |
| The room answers anything else | | Retry |

A job that can't be scanned is retried 5 minutes later, up to 5 failed tries in all, counted across the messages that carry it (see below). Past that it's dropped as `gave_up`, as the dead-letter queue does with a message whose own retries run out. Neither records anything. The room's own sweep ends the file as Scan failed an hour after upload, whichever comes first. So the scanner never reports `failed`, and nothing here can turn a failure into a pass.

A job more than an hour past its `queued_at` is acked as `too_late` without a scan, since its room has already failed it.

## Sharing turns between rooms

There's one Container, scanning one file at a time, so the order is all there is to share. A busy room shouldn't push other rooms' files past their hour.

The consumer takes up to 100 jobs at a time (`src/fair.ts`). Before scanning any, it does three things:
1. **Settles what needs no scan:** jobs past their hour (`too_late`) and jobs out of tries (`gave_up`). Neither counts toward a room's turns.
2. **Sends each room's surplus away:** past the first 4 jobs, a room's jobs go back to the same queue. They leave the front, and the jobs behind them come forward.
   - **When other rooms share the batch,** they go back with a 2-minute delay.
   - **When it's one room alone,** they go back at once. There's no one in the batch to make way for, and anyone deeper in the queue is already ahead of them. A delay then would only leave the scanner idle: in simulation, 100 files of 2 s took 48 minutes with it, against 200 s without.
3. **Scans the rest in turns:** one room's job per round, for no more than 2 minutes. Jobs it didn't reach go back with no delay.

**Sending back** is a new message, not a retry, so waiting a turn doesn't use up a try. A job's failed tries so far go with it in the body as `tries`. A job from an API that didn't stamp `queued_at` is stamped when it's first sent back, so the hour bounds it too. If sending back fails, those jobs are retried instead, and `requeue_failed` is logged as an error to alert on.

**Simulated,** with batches taken from the earliest-available messages:

| Ahead of the waiting file | Per scan | Arrival order | With this |
| --- | --- | --- | --- |
| 1,000 files from one room | 17 s | about 4.7 hours | about 12 minutes |
| 3 rooms × 1,500 small files, one room after another | 2 s | about 2.5 hours | about 6 minutes |
| 3 rooms × 1,500 small files, interleaved | 2 s | about 2.5 hours | about 18 minutes |
| 10 rooms × 1,500 small files | 2 s | about 8.3 hours | about 20 minutes |

**What's left:**
- **Total speed doesn't change.** A room that sends more than an hour's worth of scans still has its own files fail closed, as before.
- **The bound is the hour, not a depth cap.** Nothing limits how deep the queue gets. A file still waiting an hour after upload is failed closed by its room, and skipped here as `too_late`. Short of that, a file waits roughly (jobs ahead ÷ 100) × (rooms in each batch × 4) × the scan time. With 3 rooms of 1,500 large, 17 s files ahead, that's about 51 minutes. A room's 5 GB quota allows only about 50 files of 100 MB, so a backlog that deep is of small files, which scan in seconds.
- **The model assumes Queues delivers roughly in order of availability.** Queues doesn't promise an order, so this is unverified, and nothing here has run against a deployment.

**Deploy order:** the API first, so new jobs carry `queued_at`, then the scanner. Jobs already queued without it are stamped when first sent back.

## Shapes

Queue message:

```json
{ "v": 1, "workspace_id": "...", "object_id": "...", "key": "...", "size": 123, "sha256": "<hex>" }
```

`POST /internal/scan-result` over the service binding, with header `x-podster-scanner`, from the Worker's secret `SCANNER_SECRET`:

```json
{ "v": 1, "workspace_id": "...", "object_id": "...", "report": "no_known_malware", "reason": "none", "sha256": "<hex>", "bytes": 123, "database": { "engine": "1.5.4", "version": "28176", "built_at": "2026-11-07T06:24:18Z" }, "scanned_at": 1794000000000 }
```

`report` uses the words `ScanOutcome::from_report` reads. There's no idempotency key, because the room runs `record_scan` each time and a report can only tighten. `reason` can be a signature name, so it's stored and never logged.

## Signatures

They come in the image ([decision 83](../../docs/spec/PRODUCT.md#decisions-needed)). The build runs `freshclam`, then fails unless the database is under 3 days old, then removes `freshclam`. A rebuild has to skip Docker's layer cache, or it keeps the old signatures.

Staging rebuilds and deploys daily at 06:17 UTC, from [`scanner-rebuild.yml`](../../.github/workflows/scanner-rebuild.yml), which the owner approved on 2026-11-07. Past 7 days files stop getting verdicts ([decision 84](../../docs/spec/PRODUCT.md#decisions-needed)), so daily leaves six failed runs to notice before anyone's affected, and GitHub emails the owner about each. It deploys main's newest commit whose CI passed, because the deploy carries the scanner Worker's code too. It can also be run by hand from the Actions tab.

It needs two secrets in the repository's `staging` environment:

- `CLOUDFLARE_ACCOUNT_ID`: the account that holds `podster.dev`.
- `CLOUDFLARE_API_TOKEN`: an account API token limited to that account. Start from the **Edit Cloudflare Workers** template, and add **Containers: Edit** and **Queues: Edit**, since the scanner is a Container and consumes the scan queues.

The environment's deployment branches are limited to `main`, with no required reviewers, so the scheduled run doesn't wait. Without that limit, any branch with write access could run its own copy of the workflow with the token.

The image is built and checked once before `wrangler deploy`, because the deploy makes the Worker live before it builds the image. A build that fails at that point leaves staging as it was. The deploy then builds the image again, and a failure in that second build, which is rare, can still leave the new Worker beside the old image.

The run deploys main's newest passed commit, not whatever staging runs now. So a scanner deploy by hand should also come from main after its CI passes, or the next run puts main back. If a merged PR changes the scanner and the API together, deploy the API (and its migrations) by hand first, the same day, because this run deploys only the scanner.

Production gets its own schedule and token when it exists.

## The base image

The Dockerfile pins `clamav/clamav` by digest, so the image stays what was tested. That also freezes clamd and its parsers, the code that reads hostile files, and a daily rebuild only refreshes signatures. Nothing automates a bump, so someone has to do it:

- **When:** within a few days of a ClamAV security release, and otherwise once a month.
- **How:** read the new digest with `docker buildx imagetools inspect clamav/clamav:1.5-debian`, put it in the Dockerfile, and build with `--no-cache`. A new minor version also means changing the tag.
- **Before merging:** run `container/tests/integration.py` on the new image, because a change in what clamd reports or in the base image's Python can change verdicts.

Python's `zipfile` reads the directory, so bumps to it matter too. The base image's Debian `python3` comes in at each rebuild, so it isn't pinned by the digest.

## Tests

```bash
npm ci && npm run typecheck && npm test
```

```bash
npm run test:container
```

The Container's tests use a fake clamd and need only Python. The two below need Docker and the signature mirror, so they aren't in CI:

```bash
docker build --no-cache -t podster-scanner:local container
```

```bash
python3 container/tests/integration.py podster-scanner:local
```

```bash
npm run test:local
```

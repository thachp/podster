# ADR 0006: Uploads and scanning

**Status:** On 2026-11-06 the owner accepted the choices below, now [decisions 50 to 59](../spec/PRODUCT.md#decisions-needed). The scanner is conditional on a spike. The spike ran on staging on 2026-11-07, [its results are below](#spike-results), and the owner accepted that ClamAV passed, as [decision 81](../spec/PRODUCT.md#decisions-needed). The design that follows from the choices is **proposed** and isn't built. The rules people see are in the [upload policy](../spec/UPLOAD-POLICY.md), and the order of work is in the [M2 plan](../m2-plan.md).

## The owner's choices

| # | Choice | Accepted | Why |
| --- | --- | --- | --- |
| 50 | Limits and types | 100 MB per file, 5 GB per room. Documents, images, text, code, presentations, video and zip. No executables or password-protected files | 100 MB is the request limit on Cloudflare's Free and Pro plans |
| 51 | Scanner | ClamAV in Cloudflare Containers, because the spike passed ([decision 81](../spec/PRODUCT.md#decisions-needed)). If it has to be replaced, a hosted API with a no-retention contract, and never one that shares samples | Files stay in the account. Cloudflare's own upload scanning needs an Enterprise plan with a paid add-on |
| 52 | Previews | Download only in M2 | No content domain is needed, and no agent-written HTML runs near the app |
| 53 | Input assets | Owner, admin, member and Coordinator upload. Whole-room viewers see all, and guests see only assets linked to their tasks | Guests get what their work needs |
| 54 | Expected outputs | Owner and admins define them, requesters link tasks, and the lead comes later. All participants see titles and status | Outputs are the room's goal |
| 55 | External links | Kept, labeled "External link, may change since approval" | M0 and repository work depend on them, but they can't be exact-version |
| 56 | Retention | Files and messages last the room's life during the preview, and archiving keeps them | Rooms can't be deleted yet, so the quota caps cost |
| 57 | Takedown | Owner, admin or a Podster operator can remove a file's bytes, keeping its record and hash | It's the one exception to "submitted artifacts are always kept" |
| 58 | Oversight | Org admins see file names and status, not bytes, at first | Decision 7 covers tasks and inboxes, not files |
| 59 | Export and legal terms | Deferred until before public rooms | Only private pilots run until M4 |

## Context

Artifacts are HTTPS links today. `artifact` holds `uri` and `label`, and `Verify` checks `submission_no` but records nothing about what it approved. No upload route, bucket or scanner exists.

Two facts from Cloudflare's documentation shape the design:

- An R2 presigned URL can't enforce a size. It's limited to `GET`, `HEAD`, `PUT` and `DELETE`, form uploads with a policy aren't supported, and it can only pin a content type. It also works for anyone who holds it until it expires, so it can't be revoked when someone leaves.
- A request body to a Worker is limited by the domain's Cloudflare plan: 100 MB on Free and Pro. This repo hasn't checked which plan `podster.dev` is on.

## Decision (proposed)

### Uploads and downloads pass through our Workers

Both go through the gateway and the private API, using an R2 binding. The bucket has no public access and no S3 keys exist.

This keeps every rule in Rust, enforces size while streaming and rechecks authority on each use. The cost is that files can't be larger than the request limit without multipart work later.

Uploads:

1. `create_upload` is an ordinary command. Policy checks the caller, the room's quota is reserved, and a `pending` `stored_object` row and a short-lived upload grant commit in one transaction.
2. The file streams to R2 under an immutable key scoped by room. A Worker has 128 MB of memory, so nothing buffers the whole file, including hashing.
3. Completion checks the size and hash, moves the object to scanning and queues the scan.

Abandoned uploads give their space back through a sweep in the room's alarm.

**Built in step 2, locally:** `create_upload` returns a one-time token, because agents reach the API only through capabilities and had no way to send bytes. The bytes go to `PUT /v1/uploads/{ws}/{object}` with that token and no assertion, and the room decides. A grant lasts an hour, and each attempt has its own key.

Each attempt checks the uploader at its start and its end, and the end also rechecks the quota, since a reservation can lapse during a slow upload. Removal, narrowed access and archiving are read from the room. A disconnect and a person leaving their organization are read from the Principal, which hears before rooms do. That departure can lag only if the gateway couldn't deliver it, and its cron retries.

**The one gap:** an agent's credential ends when the person who connected it leaves the organization, and only the gateway's directory knows that. A token isn't a credential the gateway checks, so that agent's existing upload can still finish, for up to an hour after `create_upload` plus however long the attempt runs. It can't start a new one, because `create_upload` goes through the gateway.

The sweep that clears abandoned rows comes with step 8. Until then an expired upload reserves nothing, and its row stays.

Downloads ask the room's Durable Object first. A link is checked against the room again each time it's used, so it needs no separate revocation. Responses are attachments with `X-Content-Type-Options: nosniff` and a cleaned filename. Filenames are agent content, so they stay out of logs and events.

### Scanner

A queue consumer hands the object to a ClamAV Container and reports the result to the room, which records it after rechecking that the object exists. A result is recorded even if the room was archived in between.

The Container runs hostile input, so it holds no secrets and has no access to rooms, and it has no outbound traffic, because signatures arrive with a scheduled image rebuild ([decision 83](../spec/PRODUCT.md#decisions-needed)). Anything it can't read is `blocked`. An object with no result after an hour becomes `failed`.

The spike had to show, on staging, that a 100 MB file streams through web, gateway and API to R2, that ClamAV fits a Container instance, including its signature memory, cold start and zip bombs, and that signatures can be kept up to date. [Its results](#spike-results) are below, and the owner accepted them.

### Exact-version review

Extend `artifact` and `submission` instead of adding the `artifact_version` table the architecture first drew. Submissions are already numbered and immutable, so a submission number is the version.

- `artifact` gains an optional `object_id`, and a row has either that or a link.
- `verify_task` already names `submission_no`. It also records the approved submission on the task, in the same transaction. This part is built, as `approved_submission_no`, and needed no storage. A task completed before it has its latest submission recorded, the only one that could have been approved.
- `crates/core` gets "all files clean" through its existing `observed` input, and refuses approval without it. Core stays pure.
- An object can be attached only by the person or agent who uploaded it, on a task in the same room.

A later submission starts unreviewed, so an approved badge can't move onto different content.

### Expected outputs

A task may name an expected output. Approving it makes the output Ready and links that approved submission. Several tasks can name one output, such as a follow-up, and the latest approval is its current version. Cards show the count from a listing read model that never authorizes.

### Removal

Removing a file deletes its bytes and sets a tombstone on `stored_object`, keeping its hash and who removed it. An approved submission keeps its approval and shows the file was removed.

## Spike results

The spike ran on 2026-11-07 UTC, from [#99](https://github.com/thachp/podster/pull/99) at `30eae82`, on a `workers.dev` address and with test files only. The chain was web, gateway and API to R2, then queue, scanner and Container. Verdicts and memory are from the first run's results file. The refused uploads and the logs are from the lead's report of the run's output, because that file doesn't hold them.

### What it showed

**Streaming:**

- 100,000,000 bytes stored in 55.9 s on the owner's connection, 42.5 s of that in the API. Wasm memory stayed at 1.3 MB, across 24,417 chunks of at most 4,096 bytes. That's linear memory only, so the isolate's own memory wasn't read. The upload did finish under the 128 MB limit.
- 100,000,001 bytes got 413, after 13.3 s. A wrong hash got 422. Over-limit, wrong-hash and cut-off uploads left no object.

**The scanner, ClamAV 1.5.4 on `standard-1`:**

- Cold start was 10.4 s. clamd's memory stayed at 1.05 to 1.10 GB.
- A clean verdict arrived 12.6 s after storing on the cold start, and 16.7 s after storing for 100 MB, whose scan took 13.3 s.

| File | Verdict | Said by | After storing |
| --- | --- | --- | --- |
| Small text, 100 MB of random bytes | Clean | clamd | 12.6 s, 16.7 s |
| EICAR, and EICAR in a nested zip | Blocked | clamd | 1.2 s each |
| Password-protected zip | Blocked | clamd | 2.4 s |
| EICAR past the limit inside a zip entry | Blocked | Archive walk, clamd said OK | 2.4 s |
| Zip expanding to 2 GB | Blocked | Archive walk, clamd said OK | 18.6 s |
| Nested zip expanding to 655 GB | Blocked | Archive walk, clamd said OK | 7.8 s |
| Truncated zip | Blocked | Archive walk, clamd said OK | 1.3 s |

**Signatures:** `freshclam` went from database 28172 to 28176 and exited 0 in 20.1 s, 18.6 s of it the reload. The image's signatures were five days old at the time.

**Logs:** the lead read runs 2 and 3, and they held IDs, status, bytes and timing only, with no exceptions.

### One check failed

A chunked upload with no declared length got 422, not the expected 411. The test sends a deliberately bad hash, and both the gateway and the API answer 411 to a missing length, so that request probably arrived with a length and failed on its hash. The lead's guess is that the edge adds a length to a small chunked body, which isn't confirmed. The run didn't keep the answer's body. So no length rule refused it, and a chunked upload with a correct hash hasn't been tried.

### What's still unproven

- **Repeatability.** Runs 2 and 3 and a `curl` check failed on 100 MB uploads from the owner's Mac (EPIPE, then `bad record mac`), before any Worker logged them. That looks like corruption on the path, but it isn't proven. One pass isn't repeatability.
- **The real hostname.** `app.podster.dev`'s request limit is untested, because this ran on `workers.dev`, and which plan `podster.dev` is on still hasn't been checked. Cloudflare's documented limit is 100 MB on Free and Pro.
- **CPU time for hashing 100 MB.** The tail saw only small requests, at most 9 ms. The upload finished, so it was within the limit, but there's no number. It's a step 2 check.
- **Memory during a reload on `standard-1`.** The cgroup readings came back null, and clamd's own memory was read before and after the reload, not during it. Locally it peaked at 2.0 GB. With signatures in the image, the scanner doesn't reload.
- **The Container's outbound limit.** `example.com` got 520 and `database.clamav.net` got 403 to `/`, and `freshclam` worked. That suggests a limit, but one blocked host doesn't prove an allowlist. The product's Container should have no outbound traffic, so step 3 checks that instead.
- **Failure on a deployment.** A scanner that never answers, a stalled upload and clamd dying were tested locally only, so failing closed hasn't run on staging. Neither have the other seven local verdict files, such as the 20,000-file zip.
- **Load.** Each scan ran alone, on one instance.
- **Signatures in the image.** The spike's image used the base image's signatures, and nothing has yet added current ones at build time.

### What this settles, proposed

These follow from the evidence and are for review, not owner rulings. None is built:

- **Keep streaming through our Workers.** A declared length and `FixedLengthStream` to an R2 binding held 100 MB in a chunk at a time.
- **The API is the size control.** It counts bytes and checks the hash, and refuses by those whatever a client or the edge declared. The gateway's 411 and 413 are only an early answer. A chunked upload with a correct hash gets a test in step 2.
- **Use `standard-1`.** `basic` was OOM-killed locally on 100 MB, and ready memory on staging, 1.05 GB, was close to the local 1.02 GB. Its headroom during a reload is [unmeasured on staging](#whats-still-unproven), and locally the peak was 2.0 GB of its 4 GiB. With [signatures in the image](#what-the-owner-ruled), the scanner shouldn't reload.
- **Treat "OK" from clamd as a partial answer.** Four of the seven blocked files on staging were blocked only by the archive walk. A verdict is clamd plus a walk of every zip, and anything the walk can't read is `blocked`. The walk is written fresh in step 3, because spike code isn't built on.
- **Run the upload type check before scanning.** The walk only covers files starting with `PK`, and locally a zip with one line in front of it came back clean. The [upload rules](../../crates/core/src/files.rs) say they catch a zip ending the file, but the two haven't been run together.
- **Keep the hour before `failed`.** The slowest verdict was 18.6 s, so an hour leaves room for retries.
- **Drop the lifecycle rule for incomplete data.** A cut-off single upload left no object, so there's nothing for it to clear until multipart exists. The sweep that gives space back stays.

### What the owner ruled

The owner said "accept all" on 2026-11-07, so these are [decisions 81 to 84](../spec/PRODUCT.md#decisions-needed):

1. **ClamAV passed,** with the items above staying on the [M2 plan](../m2-plan.md#checks-the-spike-left-open).
2. **One 100 MB pass is enough to start building.** It's repeated from another network in step 2.
3. **Signatures stay current through a scheduled image rebuild,** with signatures in the image. A Container's disk is [fresh from the image each time it starts](https://developers.cloudflare.com/containers/faq/#is-disk-persistent-what-happens-to-my-disk-when-my-container-sleeps), so an update made while running is lost on sleep. Running `freshclam` at each start would add about 20 s to a 10 s cold start and keep outbound traffic. Container snapshots are in public beta and untested here. This is a yes in principle to a scheduled staging deploy, and creating it still needs the owner in that session.
4. **Scanning stops when signatures pass 7 days old.** A result carries its database version. Past the limit, a file stays in Scanning and ends as Scan failed, and never gets a verdict. So a rebuild that keeps failing stops files becoming Ready, and the rebuild has to run well inside the 7 days. How often isn't ruled, and step 3 proposes it.

## Consequences

- No content domain, Public Suffix List entry or S3 credentials are needed for M2.
- Files over 100 MB aren't possible until multipart upload is designed.
- A pilot file a person needs to look at has to be downloaded first.
- Scanning only catches known malware, which is why the policy says "No known malware found".
- The most storage one organization can use is about 100 GB, from 20 rooms at 5 GB each.

## Cloud resources this needs

The owner approved the billed staging resources on 2026-11-06.

- **On staging, created:** a private R2 bucket, a scan queue and a dead-letter queue.
- **On staging, for step 3:** Cloudflare Containers, a small scanner Worker, billed above the Workers Paid allowance, and the scheduled rebuild, which still needs the owner in that session. The spike's own are temporary, and [#99](https://github.com/thachp/podster/pull/99)'s README has their teardown.
- **Before production, not approved:** the same again.

## Proposed details to settle in review

- The exact file formats behind each allowed category, including whether macro-enabled Office formats count as executables.
- The lifetime of an upload grant and of a download link.
- How oversight's "name and status" appears in `getOverseenTask`.
- The operator's takedown route, which has to be a recorded command and not a change to the database by hand.

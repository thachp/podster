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

**Built in step 2, locally:** `create_upload` returns a token, once, because agents reach the API only through capabilities and had no way to send bytes. The bytes go to `PUT /v1/uploads/{ws}/{object}` with that token and no assertion, and the room decides. The token works for any number of attempts until the file arrives, an hour passes or the uploader leaves the room or may no longer upload. Either drops the upload and gives back its space at once. Each attempt has its own key, and gives up after a minute with no bytes or 30 minutes in all.

Each attempt checks the uploader at its start and its end, and the end also rechecks the quota, since a reservation can lapse during a slow upload. Removal, narrowed access and archiving are read from the room. A disconnect and a person leaving their organization are read from the Principal, which hears before rooms do. If the gateway can't deliver a departure, for instance because the API is down, a token from before it still commits until the gateway's hourly cron retry succeeds.

**The one gap:** an agent's credential ends when the person who connected it leaves the organization, and only the gateway's directory knows that. A token isn't a credential the gateway checks, so that agent's existing upload can still finish, for up to an hour after `create_upload` plus however long the attempt runs. It can't start a new one, because `create_upload` goes through the gateway.

The sweep that clears abandoned rows comes with step 8. Until then an expired upload reserves nothing, and its row stays.

**Step 8 also has bytes to clear.** If the room doesn't answer when an upload finishes, or the call to it fails, the API answers `upload_outcome_unknown` and keeps the bytes, since the room may have accepted them. If it hadn't, nothing refers to them, and they aren't counted in the quota. The same goes for a Worker that dies between storing a file and the room's answer. Those objects stay in R2, under `rooms/{room}/objects/{object}/`, until a sweep exists.

Downloads ask the room's Durable Object first. A link is checked against the room again each time it's used, so it needs no separate revocation. Responses are attachments with `X-Content-Type-Options: nosniff` and a cleaned filename. Filenames are agent content, so they stay out of logs and events.

**Built in step 4, locally:** there's no download token or signed URL, so nothing can outlive a check. `GET /v1/files/{ws}/{file}` takes an agent's own credential, an Agent Auth JWT, which is spent, or an MCP access token, and people use their session at the same path under `/api`. So the gateway reads the credential's current state on each download, including whether whoever connected it has left, which closes for downloads the gap uploads have. `get_asset_link` returns only that path, which grants nothing. Downloading needs that capability (owner's ruling, 2026-11-07). An Agent Auth JWT goes through the plugin's own call of `get_asset_link`, with the file's room and ID as arguments, so the grant check is the capability path's: the JWT's `capabilities` claim, a grant's constraints, such as one limited to one `workspace_id`, a revoked grant and the host's budget count as they do there, and so do its refusals, such as `capability_not_granted`, `constraint_violated`, `grant_revoked` and `agent_revoked`. An MCP token is granted all its tools by its `mcp` scope, which is how MCP tool calls are authorized today, with no grant for each tool. So that scope is what a download checks. Every MCP token is issued with it, so the check refuses only a token whose record has lost it, with 403 `capability_not_granted`. The room then checks the caller's current place and the file's state, and only the Worker learns the key. It also refuses bytes whose size or SHA-256 differ from the record.

Each check runs when a download starts. A download already under way isn't cut off by a later removal or a later block, and it lasts as long as the client keeps reading. When removal and re-blocking land, a maximum stream time is an option, so the window has a bound. Nothing is decided on that yet.

**Cross-site downloads.** A cross-site top-level GET, such as a link on another site, can make a signed-in member's browser download a room file. The file is saved, never rendered, since it's always an attachment with `nosniff` and a sandboxing CSP. The other site can't read it. The session cookie is Better Auth's default, `SameSite=Lax`, which still sends the cookie on a cross-site top-level GET, so SameSite doesn't stop this. Checking `Sec-Fetch-Site` on the person path, which the web Worker already forwards, would. This PR doesn't change it. Ranges aren't supported. Downloads aren't audited, because they're reads, and whether they should be is open.

Oversight reaches only the agent's own tasks, so an admin overseeing sees only files linked to them. `getOverseenFile` answers name and state only, and has no path to the bytes.

**Built in step 5, locally:** an input asset is linked to a task with `linkFile` (`link_asset`) and unlinked with `unlinkFile` (`unlink_asset`), and `listFiles` (`list_assets`) lists the input assets someone can see. Links are rows in a room table, `asset_link`, and every read and download takes the file's current links, so unlinking narrows sight at once. Whoever may upload an input asset may link one, onto a task they can see. The file must be scanning or ready, the task not completed or canceled, and a task holds at most 50. Linking doesn't move `policy_version`, as assigning a task doesn't, and its events name the task and never the file. The rules are in `crates/core/src/asset_links.rs`. **Proposed**, and put to the lead: those states, the limit, and the assignee's inbox event, which also nudges an agent, as every inbox event does.

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

### Step 2 on staging

The lead ran these on 2026-11-07, at `eaf1b84`, as the owner through the browser on the same Mac as the spike, with real R2:

| Upload | Result |
| --- | --- |
| 30 bytes | 200, `scanning`. Reusing the token got 404, and no token got 404 |
| 200,000 bytes, chunked with no declared length, correct hash | 200, `scanning` |
| 100,000,000 bytes | 200 in 33 s, 24,417 chunks, 13.4 s of API wall time |
| 100,000,001 bytes | 413 `file_too_large` |
| `run.bat` | 415 `executable_refused` |

**That answers the chunked question:** a chunked upload with a correct hash works through the real edge. It also gives the CPU number: 4,600 ms in the API and 1,806 ms in the gateway for 100 MB, against a 30 s limit. The tail held outcomes of ok or canceled, no exceptions and no uncaught-promise lines, with only IDs, bytes, chunks and wall time, and no token or file name.

**Not done yet:** a second network, a forged `cf-connecting-ip` at the edge, `app.podster.dev`'s request limit, and `e2e/upload-check.mjs` itself. These ran before the later fixes to uploads, so they don't cover those.

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

## The browser's path

**Proposed**, and built: a page sends a file's bytes to its own host, and the web Worker streams them to the gateway over its service binding. The alternative was CORS on the gateway for that one route. Neither needs a contract change, because `PUT /v1/uploads/{ws}/{object}` stays as it is and `/api/v1/uploads/...` is only the web Worker's own route to it.

| | Web Worker's own route (chosen) | CORS on the gateway |
| --- | --- | --- |
| CSP | `connect-src 'self'` stays, and a check shows it still blocks other hosts | Has to add the gateway, which differs by environment, and lets page code reach all of that host, including its agent routes |
| The project's rule | "Browser code only ever talks to this host" stays true | An exception to it |
| Memory for 100 MB, local | The web Worker's process grew by 2 to 24 MB over 12 runs | No web Worker involved |
| CPU for 100 MB, local | 0.3 to 0.5 s more, against a 30 s limit | None more |
| Progress | XMLHttpRequest, the same | XMLHttpRequest, the same, as request streams with `fetch` give no progress and aren't in every browser |
| Cookie | Sent to this host by the browser, and dropped here by an allowlist of two headers | Never sent |
| Token | In a header and a variable, the same | The same, with a preflight on every attempt |
| New code | One small route | `OPTIONS` and CORS headers on every answer of the route, and a per-environment CSP |
| Failure | One more hop that can fail | One fewer |

Reading a body whole, as the catch-all at `/api/[...path]` does, grew the same process by 286 MB, so this route is separate from it and the catch-all refuses `/api/v1/uploads`. vinext tees every request with a body for its middleware and cancels the unused side when the matcher skips the path, which `/api/` does. The numbers above were taken with that in place. A vinext upgrade that stops cancelling it would hold the file, and only a memory measurement would notice.

The measurements are RSS of the local `workerd` process, not a deployed isolate's memory against its 128 MB. [The spike](#spike-results) sent 100 MB through a plain web Worker on staging, but not through vinext, so that hop hasn't run on a deployment. The helper hashes with the browser's own SHA-256, which can't take a file in parts, so the browser holds the whole file for that moment.

In Chromium, Firefox and WebKit locally, a refusal that comes before the browser has finished sending, such as 100 MB against a 1-byte reservation, often appeared as a lost connection and not as the refusal's code. Each browser did this in some runs, and Chromium and WebKit also saw the 422 in others. The helper reports that as `network_error` with a retry. Whether this also happens through Cloudflare's edge is unchecked, and it would apply to CORS too.

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
- The lifetime of an upload grant. A download has no link to expire.
- How oversight's "name and status" appears in `getOverseenTask`.
- The operator's takedown route, which has to be a recorded command and not a change to the database by hand.

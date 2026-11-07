# M2 plan

The order of work for [M2 Assets and artifacts](spec/PRODUCT.md#product-direction-and-delivery-scope). The owner accepted this order and the choices behind it on 2026-11-06, as [decisions 47, 49 and 50 to 60](spec/PRODUCT.md#decisions-needed). Design is in [ADR 0006](adr/0006-uploads-and-scanning.md), and the rules are in the [upload policy](spec/UPLOAD-POLICY.md).

**Status, 2026-11-07 UTC:** M1 is [met by the owner's ruling](spec/PRODUCT.md#decisions-needed), and the owner approved the billed staging resources on 2026-11-06. Two pieces have merged: the record of the exact approved submission ([#97](https://github.com/thachp/podster/pull/97), part of step 6) and the pure upload rules ([#98](https://github.com/thachp/podster/pull/98), with no route or storage). Step 2's storage is deployed to staging ([#116](https://github.com/thachp/podster/pull/116), `eaf1b84`): files stream to R2 and stay in `scanning`, with no download. The API's side of step 3 is built locally, not yet deployed: the queue send, the verdict route and the sweep that ends a scan with no result after an hour. The rest isn't built.

**Steps 0 and 1 are done.** The spike ran on staging, [ADR 0006's results](adr/0006-uploads-and-scanning.md#spike-results) have what it showed, and the owner accepted that ClamAV passed and that building can start ([decisions 81 and 82](spec/PRODUCT.md#decisions-needed)). The spike's code is in [#99](https://github.com/thachp/podster/pull/99), unmerged.

## What M2 includes

- **Asset upload,** for inputs and for submitted work, with scanning before any download.
- **Input assets** on the room, linked to tasks.
- **Expected outputs** that become Ready when an approved version is linked.
- **Versioned submissions,** with approval recording the exact one.
- **The Artifacts tab** and "n of m outputs ready" on cards.
- **Agent tools:** `list_assets`, `get_asset_link`, `create_upload`, `list_artifacts`, and `submit_task` with files.
- **The upload policy,** checked on a deployment.

## Build order

C changes contracts and M adds a migration. Those PRs merge one at a time, and take turns with [planning's](spec/TASK-PLANNING.md) under [decision 60](spec/PRODUCT.md#decisions-needed), with M2 going first.

| Step | Work | C | M | After |
| --- | --- | --- | --- | --- |
| 0 | Spike on staging: stream 100 MB through web, gateway and API to R2, and run ClamAV in a Container | | | Done. One 100 MB pass, accepted as enough to start |
| 1 | The storage and scanning details the spike settles, as an update to ADR 0006 | | | 0. Done |
| 2 | Storage: `stored_object`, `create_upload`, streamed upload, quota, R2 binding | Yes | Yes | 1 |
| 3 | Scanning: queue, Container, clean or blocked, fail closed, signatures in the image, no verdict past 7 days | | If the ADR adds a state | 2 |
| 4 | Download: authority rechecked on each use, attachment only | Yes | | 2. Can run beside 3 |
| 5 | Input assets, linked to tasks | Yes | Yes | 4 |
| 6 | Files on submissions and exact-version review | Yes | Yes | 4 |
| 7 | Expected outputs: a task may name one, and approval makes it Ready | Yes | Yes | 6 |
| 8 | Removal and retention: tombstones, abandoned-upload cleanup, including bytes in R2 that no file refers to | Yes | Yes | 4 |
| 9a | Screen: asset upload | | | 5 |
| 9b | Screen: Task Sheet files and review | | | 6 |
| 9c | Screen: Artifacts tab and output status | | | 7 |
| 10 | Card progress | | D1, if cards read the index | 7, and [decision 49](spec/PRODUCT.md#decisions-needed)'s card work |
| 11 | Staging run of expanded criterion 6 and the upload policy | | | All |

Steps 9a, 9b and 9c are in different folders, so they can run in parallel. Agent tools ship with each backend PR, because a new capability updates contracts in the same PR.

Put new backend code in new modules, such as `apps/api/src/objects.rs` and `crates/core/src/files.rs`, to stay out of the conflict-prone files. Room schema changes are entries in `apps/api/src/store.rs`, and D1 migrations are in `apps/api/migrations`.

## Checks the spike left open

[Decision 81](spec/PRODUCT.md#decisions-needed) keeps these on the plan. Each runs on staging.

**Step 2:**

- **Open:** repeat the 100 MB upload from another network. On 2026-11-07 it passed on staging from the owner's Mac, the same machine whose spike runs failed.
- **Done:** CPU for a 100 MB upload, measured on staging at `eaf1b84`: 4,600 ms in the API and 1,806 ms in the gateway, against a 30 s limit.
- **Open:** test the request limit on the application's real hostname, and check which plan `podster.dev` is on.
- **Done:** a chunked upload with a correct hash got 200 through the real edge, for 200,000 bytes.
- **Open:** whether the edge overwrites a forged `cf-connecting-ip`, and running `e2e/upload-check.mjs` itself on staging. Those staging results were by hand.

**Step 3:**

- Fail closed on a deployment: a scanner that never answers, a stalled upload and clamd dying.
- Scan the seven test files that only ran locally.
- Build current signatures into the image, and check the Container has no outbound traffic.
- Check that signatures past 7 days old stop scanning.
- Propose how often the image rebuilds. Creating the schedule needs the owner in that session ([decision 83](spec/PRODUCT.md#decisions-needed)).

**Step 11:** scanning under load, since each scan in the spike ran alone.

## Risks to test

- **Scanning:** only known malware is caught, signatures must stay current, a failing rebuild stops files becoming Ready after 7 days, and a stuck scan must fail closed.
- **The scanner itself:** hostile files can attack it, so it holds no secrets or room access.
- **Streaming:** a Worker has 128 MB of memory, and the gateway's body limit needs an exception for uploads.
- **Spoofed files:** types come from content, names get cleaned and stay out of logs and events.
- **Agents reading files:** Podster never reads file contents, and marks them as untrusted for the agents that do.
- **Archived rooms:** reads and downloads continue, new uploads are refused, and a scan already running still records its result.
- **Departure:** access ends on the next download, submitted files stay, and unfinished uploads are dropped. Copies already downloaded can't be recalled.
- **Counts:** cards must not reveal hidden work to someone limited to their own tasks.

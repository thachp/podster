# M2 plan

The order of work for [M2 Assets and artifacts](spec/PRODUCT.md#product-direction-and-delivery-scope). The owner accepted this order and the choices behind it on 2026-11-06, as [decisions 47, 49 and 50 to 60](spec/PRODUCT.md#decisions-needed). Design is in [ADR 0006](adr/0006-uploads-and-scanning.md), and the rules are in the [upload policy](spec/UPLOAD-POLICY.md).

**Status, 2026-11-07 UTC:** M1 is [met by the owner's ruling](spec/PRODUCT.md#decisions-needed), and the owner approved the billed staging resources on 2026-11-06. Two pieces have merged: the record of the exact approved submission ([#97](https://github.com/thachp/podster/pull/97), part of step 6) and the pure upload rules ([#98](https://github.com/thachp/podster/pull/98), with no route or storage). The rest isn't built.

**Step 0 ran on staging, and step 1 is written.** [ADR 0006's results](adr/0006-uploads-and-scanning.md#spike-results) have what it showed, what's unproven and what the owner has to rule on. Whether ClamAV passed is the owner's call, and step 3 waits on it. The spike's code is in [#99](https://github.com/thachp/podster/pull/99), unmerged.

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
| 0 | Spike on staging: stream 100 MB through web, gateway and API to R2, and run ClamAV in a Container | | | Ran on staging. One 100 MB pass, not yet repeatable |
| 1 | The storage and scanning details the spike settles, as an update to ADR 0006 | | | 0. Written, and the owner's rulings are open |
| 2 | Storage: `stored_object`, `create_upload`, streamed upload, quota, R2 binding | Yes | Yes | 1 |
| 3 | Scanning: queue, Container, clean or blocked, fail closed | | If the ADR adds a state | 2 |
| 4 | Download: authority rechecked on each use, attachment only | Yes | | 2. Can run beside 3 |
| 5 | Input assets, linked to tasks | Yes | Yes | 4 |
| 6 | Files on submissions and exact-version review | Yes | Yes | 4 |
| 7 | Expected outputs: a task may name one, and approval makes it Ready | Yes | Yes | 6 |
| 8 | Removal and retention: tombstones, abandoned-upload cleanup | Yes | Yes | 4 |
| 9a | Screen: asset upload | | | 5 |
| 9b | Screen: Task Sheet files and review | | | 6 |
| 9c | Screen: Artifacts tab and output status | | | 7 |
| 10 | Card progress | | D1, if cards read the index | 7, and [decision 49](spec/PRODUCT.md#decisions-needed)'s card work |
| 11 | Staging run of expanded criterion 6 and the upload policy | | | All |

Steps 9a, 9b and 9c are in different folders, so they can run in parallel. Agent tools ship with each backend PR, because a new capability updates contracts in the same PR.

Put new backend code in new modules, such as `apps/api/src/objects.rs` and `crates/core/src/files.rs`, to stay out of the conflict-prone files. Room schema changes are entries in `apps/api/src/store.rs`, and D1 migrations are in `apps/api/migrations`.

## Risks to test

- **Scanning:** only known malware is caught, signatures must stay current, and a stuck scan must fail closed.
- **The scanner itself:** hostile files can attack it, so it holds no secrets or room access.
- **Streaming:** a Worker has 128 MB of memory, and the gateway's body limit needs an exception for uploads.
- **Spoofed files:** types come from content, names get cleaned and stay out of logs and events.
- **Agents reading files:** Podster never reads file contents, and marks them as untrusted for the agents that do.
- **Archived rooms:** reads and downloads continue, new uploads are refused, and a scan already running still records its result.
- **Departure:** access ends on the next download, submitted files stay, and unfinished uploads are dropped. Copies already downloaded can't be recalled.
- **Counts:** cards must not reveal hidden work to someone limited to their own tasks.

# M2 plan

The order of work for [M2 Assets and artifacts](spec/PRODUCT.md#product-direction-and-delivery-scope). The owner accepted this order and the choices behind it on 2026-11-06, as [decisions 47, 49 and 50 to 60](spec/PRODUCT.md#decisions-needed). Design is in [ADR 0006](adr/0006-uploads-and-scanning.md), and the rules are in the [upload policy](spec/UPLOAD-POLICY.md).

**Status, 2026-11-08 UTC:** M2 is met on staging with test people, as [decision 145](spec/PRODUCT.md#decisions-needed): the lead's call under the owner's delegation, for the owner to review. Steps 0 to 11 are done, each with its PRs in the table below. The full staging pass is [recorded under step 11](#checks-the-spike-left-open), and what stays owed before production is listed in decision 145.

**Steps 0 and 1 were the start.** The spike ran on staging, [ADR 0006's results](adr/0006-uploads-and-scanning.md#spike-results) have what it showed, and the owner accepted that ClamAV passed and that building can start ([decisions 81 and 82](spec/PRODUCT.md#decisions-needed)). The spike's code is in [#99](https://github.com/thachp/podster/pull/99).

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
| 0 | Spike on staging: stream 100 MB through web, gateway and API to R2, and run ClamAV in a Container | | | Done. One 100 MB pass, accepted as enough to start. [#99](https://github.com/thachp/podster/pull/99) |
| 1 | The storage and scanning details the spike settles, as an update to ADR 0006 | | | 0. Done: [#114](https://github.com/thachp/podster/pull/114) |
| 2 | Storage: `stored_object`, `create_upload`, streamed upload, quota, R2 binding | Yes | Yes | 1. Done: [#98](https://github.com/thachp/podster/pull/98), [#116](https://github.com/thachp/podster/pull/116), [#120](https://github.com/thachp/podster/pull/120), [#121](https://github.com/thachp/podster/pull/121) |
| 3 | Scanning: queue, Container, clean or blocked, fail closed, signatures in the image, no verdict past 7 days | | If the ADR adds a state | 2. Done: [#119](https://github.com/thachp/podster/pull/119), [#125](https://github.com/thachp/podster/pull/125), [#127](https://github.com/thachp/podster/pull/127) |
| 4 | Download: authority rechecked on each use, attachment only | Yes | | 2. Done: [#123](https://github.com/thachp/podster/pull/123) |
| 5 | Input assets, linked to tasks | Yes | Yes | 4. Done: [#142](https://github.com/thachp/podster/pull/142) |
| 6 | Files on submissions and exact-version review | Yes | Yes | 4. Done: [#97](https://github.com/thachp/podster/pull/97), [#128](https://github.com/thachp/podster/pull/128), [#131](https://github.com/thachp/podster/pull/131) |
| 7 | Expected outputs: a task may name one, and approval makes it Ready | Yes | Yes | 6. Done: [#136](https://github.com/thachp/podster/pull/136), [#148](https://github.com/thachp/podster/pull/148) |
| 8 | Removal and retention: tombstones, abandoned-upload cleanup, including bytes in R2 that no file refers to | Yes | Yes | 4. Done: [#146](https://github.com/thachp/podster/pull/146), [#151](https://github.com/thachp/podster/pull/151) |
| 9a | Screen: asset upload | | | 5. Done: [#150](https://github.com/thachp/podster/pull/150) |
| 9b | Screen: Task Sheet files and review | | | 6. Done: [#101](https://github.com/thachp/podster/pull/101), [#147](https://github.com/thachp/podster/pull/147) |
| 9c | Screen: Artifacts tab and output status | | | 7. Done: [#152](https://github.com/thachp/podster/pull/152) |
| 10 | Card progress | Yes | None: each room's card counts its own outputs, so no index is needed | 7, and [decision 49](spec/PRODUCT.md#decisions-needed)'s card work. Done: [#156](https://github.com/thachp/podster/pull/156), [#159](https://github.com/thachp/podster/pull/159) |
| 11 | Staging run of expanded criterion 6 and the upload policy | | | All. Done: [#144](https://github.com/thachp/podster/pull/144), [#158](https://github.com/thachp/podster/pull/158), and the full pass below |

Steps 9a, 9b and 9c are in different folders, so they can run in parallel. Agent tools ship with each backend PR, because a new capability updates contracts in the same PR.

Put new backend code in new modules, such as `apps/api/src/objects.rs` and `crates/core/src/files.rs`, to stay out of the conflict-prone files. Room schema changes are entries in `apps/api/src/store.rs`, and D1 migrations are in `apps/api/migrations`.

## Checks the spike left open

[Decision 81](spec/PRODUCT.md#decisions-needed) keeps these on the plan. Each runs on staging.

**Step 2:**

- **Open:** repeat the 100 MB upload from another network. On 2026-11-07 it passed on staging from the owner's Mac, the same machine whose spike runs failed. On 2026-11-08 a 100 MB upload from the lead's Mac failed again with "fetch failed" in step 11's run, while a 100 MB upload from the browser pane had worked, so this stays the known network gap, not a finding about the Workers. The full M2 pass below then uploaded 100 MB from the same Mac, so the gap is intermittent. A run from another network is still owed.
- **Done:** CPU for a 100 MB upload, measured on staging at `eaf1b84`: 4,600 ms in the API and 1,806 ms in the gateway, against a 30 s limit.
- **Open:** test the request limit on the application's real hostname, and check which plan `podster.dev` is on.
- **Done:** a chunked upload with a correct hash got 200 through the real edge, for 200,000 bytes.
- **Open:** whether the edge overwrites a forged `cf-connecting-ip`, and running `e2e/upload-check.mjs` itself on staging. Those staging results were by hand.

**Step 3:**

- **Done:** verdicts on staging, at `46da970` on 2026-11-08 UTC, checked by the lead through the browser in the Smoke test room. A clean text file went to `ready` and the EICAR test string to `blocked`, each within 13 s of upload, so `SCANNER_SECRET` matches on both Workers. The clean file downloaded through the web Worker with a matching SHA-256 and its headers: attachment, `nosniff`, `default-src 'none'; sandbox`, `no-referrer`, CORP `same-origin` and `no-store`. The blocked file's download got 409 `file_not_available`. [ADR 0006](adr/0006-uploads-and-scanning.md#step-3-on-staging) has the details.
- **Open:** the Container's cold start, a 100 MB scan, the hour sweep on a deployment, and what the logs held.
- Fail closed on a deployment: a scanner that never answers, a stalled upload and clamd dying.
- Scan the seven test files that only ran locally.
- Build current signatures into the image, and check the Container has no outbound traffic.
- Check that signatures past 7 days old stop scanning.
- Propose how often the image rebuilds. Creating the schedule needs the owner in that session ([decision 83](spec/PRODUCT.md#decisions-needed)).

**Step 11:** scanning under load, since each scan in the spike ran alone.

- **First run of `e2e/m2-staging.mjs`,** by the lead on 2026-11-08 at `059a47c` with `--big`, in room `ws_0a29ea5903194e3aaa9c4861daf10ed7`: 20 passed, 1 failed, 6 skipped. The clean file went `ready` in 12.9 s and the EICAR string `blocked` in 3.3 s. Owner and agent downloads matched their bytes and headers, and every refusal gave its exact code. The one failure was the 100 MB upload, "fetch failed" from the lead's Mac, the network gap above. The skipped cases were steps 5 to 8, which the script didn't cover yet, the hour sweep and load.
- **Steps 5 to 8 on staging,** by the lead on 2026-11-08 with [#158](https://github.com/thachp/podster/pull/158)'s script at `55a3bf6`, without `--big`, in room `ws_b847b743eaba4fe8aba4c3fe3701f724`, against API `678aeac`, gateway `2295e19` and web `2295e19`: 51 passed, 0 failed, 4 skipped. Input assets linked to a guest's task, a submission with a file approved by its exact version, approval refused after a submitted file's removal, an expected output that stays `ready` with `files_available` false after its file is removed, and removal answering 410 `file_removed` all passed. The skipped cases were the 100 MB file, since `--big` wasn't passed, approval after a blocked file, which a run can't cause, the hour sweep and load.
- **The full M2 staging pass,** by the lead on 2026-11-08 with [#158](https://github.com/thachp/podster/pull/158)'s script at `e2c87ba`, with `--big`, against main `137cfd6` with all of M2 deployed: the API, gateway and web, and the scanner from its daily rebuild. Room `ws_9af0c5de042947639615f3e795be6c35`: 56 passed, 0 failed, 3 skipped. That covers scanning, owner and agent downloads by bytes and headers, every refusal by its exact code, the 100 MB file, and steps 5 to 8. The skipped cases were approval after a blocked file, which a run can't cause, the hour sweep and load. This is the run [decision 145](spec/PRODUCT.md#decisions-needed) rests on.

## Risks to test

- **Scanning:** only known malware is caught, signatures must stay current, a failing rebuild stops files becoming Ready after 7 days, and a stuck scan must fail closed.
- **The scanner itself:** hostile files can attack it, so it holds no secrets or room access.
- **Streaming:** a Worker has 128 MB of memory, and the gateway's body limit needs an exception for uploads.
- **Spoofed files:** types come from content, names get cleaned and stay out of logs and events.
- **Agents reading files:** Podster never reads file contents, and marks them as untrusted for the agents that do.
- **Archived rooms:** reads and downloads continue, new uploads are refused, and a scan already running still records its result.
- **Departure:** access ends on the next download, submitted files stay, and unfinished uploads are dropped. Copies already downloaded can't be recalled.
- **Counts:** cards must not reveal hidden work to someone limited to their own tasks.

## Known limits before production

- **Scan fairness:** the scan queue feeds one Container in arrival order, with no share per room. A few rooms filling their quota can push other rooms' scans past the hour, and those files end as `failed`. That fails closed, but the person has to upload again. It needs a fix before production, such as a share per room or more Containers, and step 11's load run should measure it.

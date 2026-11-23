# Results: spike G, run 2026-11-23

Run by the architect on 2026-11-23, from the owner's machine, against the second account and `podster.site`, with the three tokens the owner made for it. It ran after the content Worker's first deploy and before `RELEASES` or the API's provider settings, as [the README](README.md) says it must. The three commands ran one after another, never side by side:

| Command | Run ID | UTC | Exit | Calls used (bound) |
| --- | --- | --- | --- | --- |
| `run` | `ebe867` | 12:30:58 to 12:44:41 (822 s) | 0, clean | API 269 (900), content domain 475 (5,000), probe 30 (400) |
| `cursor` | `7a0680` | 12:44:48 to 12:55:39 (650 s) | 0, clean | API 30 (120) |
| `cleanup` | `240435` | 12:55:39 to 12:55:46 | 0, nothing left | 11 |

The final `cleanup` found no spike KV key, no stop key, no spike script (the namespace's list read to its end), no probe Worker and no spike TXT record. Every gate check found no key in the namespace but the spike's and no stop key, so the stop part ran.

The summaries are in `results/`: `run.jsonl`, `cursor.jsonl` and `cleanup.jsonl`, one JSON object a line, as the spike wrote them. They hold run IDs, counts, statuses, codes, shapes and timings. The spike had already redacted tokens, the account and namespace IDs, the namespace's name, the workers.dev subdomain and every 32-hex ID. Before they were committed, two free-text comments from Google's resolver were cut: the links in one and an upstream server's address in another. No name in them is a host but the spike's own and the spike's fixed public test names.

**Everything here was seen from one machine, so from one Cloudflare location (`SEA` on every read), on one day.** See [what it couldn't answer](#what-it-couldnt-answer).

## TXT records from inside a Worker

The probe Worker asked three DNS-over-HTTPS JSON endpoints: Cloudflare's by name (`cloudflare-dns.com`) and by address (`1.1.1.1`), and Google's (`dns.google`).

**A definite no can be told from no answer, and the three resolvers agreed on every name:**

| Name | What it is | All three said | Verdict |
| --- | --- | --- | --- |
| `nothing-here-spike-g.invalid` | doesn't exist | `Status` 3 (`NXDOMAIN`), no records | definite no |
| `_spike-g-ebe867a.opster.dev`, before it was made | `NOERROR`, no TXT (`opster.dev`'s wildcard) | `Status` 0, no records, SOA TTL 1,800 | definite no |
| `cloudflare.com` | TXT records, none with the spike's value | `Status` 0, 29 records | definite no (another value) |
| `dnssec-failed.org` | broken DNSSEC | `Status` 2 (`SERVFAIL`), with an extended error | no answer |
| `www.github.com` | a CNAME | `Status` 0, 25 records, none a TXT owned by the name | no answer, by the spike's reading |
| any, with a 1 ms timeout | resolver doesn't answer | `TimeoutError` | no answer |

- **Speed from the Worker:** Cloudflare's endpoint answered in 4 ms, by name and by address. Google's took 38 to 51 ms.
- **Form:** both of Cloudflare's endpoints sent `application/dns-json`; Google sent `application/json; charset=UTF-8`. Both carried `Status`, `TC`, `AD` and `Answer` in the documented shape. Cloudflare's DNS API stored the TXT content unquoted.
- **A new record** (TTL 60), made at `t0`, was looked up about every 3.4 s. Nobody saw it at 0.4 s or 3.9 s. At 7.2 s only Google saw it, and only for the name that had been asked before it existed. At 10.7 s all three saw both names. That earlier lookup, which got a definite no carrying an SOA TTL of 1,800 s, didn't hold the record back: that name was seen first.
- **A deleted record** wasn't gone at once, and the answers flipped. At 0.7 s one name was still found everywhere, and the other was a definite no at Cloudflare's endpoints but still found at Google's. At 4.2 s and 7.6 s that second name was found again at all three, while the first was a definite no everywhere. At 11.1 s both names were a definite no everywhere. **So for about 11 s after a delete, one definite no was followed by the old value again.**

## Takedown: a serve entry's write, switch and removal at the host

Four hosts, each written to v1, switched to v2 and removed through the KV REST API. The deployed content Worker's marker was read every 0.5 s on a fresh connection until 10 s after the new state was first seen. Three hosts were cold (never asked before). One was warm: it was asked three times just before its first write, each answered not-found, and it ran three cycles. Times are from the provider's answer to the end of the read that first saw the new state.

| Phase | Cold (3 hosts) | Warm (3 cycles) | Largest |
| --- | --- | --- | --- |
| write (to v1) | 328, 334, 354 ms | 301, 238, 296 ms | **354 ms** |
| switch (v1 to v2) | 298, 303, 367 ms | 268, 249, 275 ms | **367 ms** |
| remove | 215, 231, 246 ms | 159, 247, 238 ms | **247 ms** |

- **In every one of the 18 phases, the first read that saw the new state was also the start of it being stable.** Every later read in the 10 s window agreed (21 reads, 0 flips each).
- **The provider answered each `PUT` and `DELETE` `200` with `"success": true` and `"result": null`,** in 261 to 413 ms.
- **What this doesn't show:** the content Worker reads an entry with a 30 s `cacheTtl`. Each switch and removal ran about 54 s after the host's last read, so an old entry cached at this location had already expired. A switch or removal while the location held a fresh copy of the old entry wasn't measured. The one warm case that was measured is a write within a second of three not-found reads, and the not-found wasn't held: v1 showed after 301 ms.

## Stale read-backs

After every write, switch, delete and stop change, the key was read back through the REST API at 0, 1, 2, 5, 10, 30 and 65 s. That is 18 phases and 2 stop changes, 140 reads in all. **Every read matched what had just been written, from the first one at 0 s:** the new value after a write or switch, and `404` with code `10009` after a delete. No stale read was seen after a write or after a delete. Each read took 50 to 343 ms.

- **A key never written:** read is `404`, `"success": false`, code `10009` (`get: 'key not found'`), `"result": null`; delete is `200`, `"success": true`.

## The stop key

The gate found only spike keys and no stop key, both at the start and right before the write, so `_stop` was written once with the spike's value. The warm host had been serving v1 and was read every 0.5 s until about half a second before the write, when the gate listed the namespace again.

- **Write:** `200`, `"success": true`, `"result": null`. Read back as the spike's value from 0 s to 65 s.
- **At the host, the stop showed at 1.1 s (sent 1.0 s) but didn't hold.** Of 23 reads in the 11.5 s window, 2 answered not-found and 21 served v1, 19 of them after the first not-found. The last read that served v1 was sent at 11.0 s, and the watch ended with the stop never stable. This is what the content Worker's design predicts: each running copy keeps the stop it last read for 30 s (`STOP_KEPT_MS`), and the reads reached copies that had read "no stop" just before. **When every copy stops serving wasn't measured.** The design bounds it at 30 s in memory, plus the copy's KV read, which showed the new value within 1.1 s here.
- **Delete:** read first (`200`, the spike's value), then `200`, `"success": true`. Read back `404` code `10009` from 0 s.
- **Removal at the host:** v1 was served again after 271 ms, stable, 0 flips. This ran 65 s after the write, when every copy's kept stop had expired.

## The KV list and its cursor

- **Paging:** 25 keys listed 10 at a time came back as pages of 10, 10 and 5. Each `result_info` was exactly `count` and `cursor`. The cursor was 348 characters, and on the last page it was the empty string, present and not missing.
- **`limit=5` is refused:** `400`, code `10028`, "limit argument must be at least 10".
- **Cursor lifetime:** one first page's cursor was used again at 0 s, 60 s, 5.5 min and 10.5 min after it was given. Each time it answered `200` with the same next 10 keys and a further cursor. **A cursor lived at least 10.5 minutes,** past the reconcile's 5-minute interval.

## The namespace's script list

With 8 spike scripts in the namespace:

| Query | Scripts in the answer | `result_info` |
| --- | --- | --- |
| none | 8 | `count` 8, `cursor` `""` |
| `?per_page=2` | 8 | `count` 8, `cursor` `""` |
| `?per_page=2&page=2` | 8 | `count` 8, `cursor` `""` |
| `?page=2` | 8 | `count` 8, `cursor` `""` |
| `?limit=2` | 2 | `count` 2, `cursor` the last script's name |

**`per_page` and `page` are ignored. `limit` is honoured, and its cursor is the last name given.** With no query, all 8 came back in one answer and the cursor was empty. Nothing showed how many scripts one answer holds at most with no `limit`. Each entry carries `id`, `etag`, `has_assets`, `modified_on` and other fields, and `routes` is `null`.

## The content Worker's deployed version

`GET …/workers/scripts/podster-content/deployments` answered `200` with `deployments`, one entry: `id`, `source` (`wrangler`), `strategy` (`percentage`), `created_on`, annotations, and `versions`, one entry at 100 %. `GET …/versions` answered `200` with `items`, one entry: `id`, `number`, `metadata` and annotations. **The live deployment named the newest version.** Only shapes were recorded, not values.

## A Worker's memory

The probe built one upload body in memory as the release job does: the files' random bytes, their base64 in a multipart text, that text encoded, and a copy as a request's body read back, all held at once. It stopped at the first answer that wasn't `200`.

| Case | Files | Raw | Body (and its copy) | Answer |
| --- | --- | --- | --- | --- |
| 1, one file at the cap | 1 × 5 MB | 5,000,000 | 6,666,824 | `200` in 391 ms |
| 2, one request at the plan's 8 MiB | 2 × 4 MiB | 8,388,608 | 11,185,100 | `200` in 789 ms |
| 3, a whole release as one body | 5 × 5 MB | 25,000,000 | 33,334,008 | `200` in 1,355 ms |
| 4, twice that | 10 × 5 MB | 50,000,000 | — | **`503`** after 2,056 ms, with no body the probe could read |

Case 5 (100 MB) wasn't asked. The `503` at 50 MB, with 25 MB passing, fits the documented 128 MB an isolate, since case 4 holds about 50 + 67 + 67 MB plus the text. The platform gave no reason the spike could read.

**Against the release job's sizes:** a request carries at most `UPLOAD_REQUEST_BYTES`, 8 MiB of files, which is case 2. A fetch batch is at most `FETCH_BATCH_BYTES`, 10 MiB. Both are well under case 3, the largest that passed. The job's sizes need no change on this evidence.

## Compression and `no-transform`

`/big.txt`, 200,000 bytes of repetitive text:

- **Through the content Worker** (`Cache-Control: max-age=60, no-transform`), with `Accept-Encoding` `gzip, br`, `gzip` or `identity`, every answer was `200` with no `Content-Encoding` and 200,000 bytes on the wire. **Cloudflare didn't compress it.**
- **From the probe on workers.dev:** without `no-transform`, the same text came back `br`, 109 bytes on the wire. With it, the text came back uncompressed, 200,000 bytes.

So `no-transform` on a Worker's own answer does switch off Cloudflare's compression, and apps are served uncompressed.

## `_headers` and `_redirects` sent as plain files

Every spike release carried a root `_headers` and a root `_redirects` as ordinary files, with no `assets.config`. Through the content Worker:

- `/_headers` was `200`, `application/octet-stream`, 73 bytes. `/_redirects` was `200`, `application/octet-stream`, 52 bytes.
- `/spike-g-from` was `404` with no `Location`, so the redirect rule wasn't read.
- The marker kept its own type, `application/json`, not the `_headers` file's `text/x-spike-g-headers`.

**A root file of either name, sent plain, is an ordinary file.**

## Buckets and the upload

- **A 5-file release** got buckets of 2, 2 and 1 in every one of 8 sessions. Sessions took 1.0 to 2.0 s.
- **Part of a bucket in one request is taken.** The first release sent one file a request: four answered `202` and the fifth `201` with the completion token. The other seven sent whole buckets: `202`, `202`, `201`. Each request took 0.5 to 1.4 s.
- **A full-size manifest** (300 files, 24,999,811 bytes, one of them 5 MB) got 3 buckets of 100 files each: 6,688,900, 6,688,900 and 11,622,011 bytes. **One bucket was larger than 8 MiB,** so the job's rule of splitting a bucket into requests of at most `UPLOAD_REQUEST_BYTES` is needed. That session was never uploaded or completed.
- **The script's write** answered `200` with the script named (0.3 to 0.9 s). **A read straight after it** answered `200` with the script present every time (8 of 8, 0.1 to 1.1 s).
- The upload session's token carried a `cfwau_` prefix.

## What it couldn't answer

- **One location.** Every read of the content domain was served at `SEA`. How long a change takes at other locations, where KV documents up to 60 s or more, is still unknown.
- **A cached old entry.** No switch or removal ran while the location held a fresh copy of the old entry from the content Worker's 30 s `cacheTtl` (see [takedown](#takedown-a-serve-entrys-write-switch-and-removal-at-the-host)).
- **When the stop holds everywhere.** The watch ended 11.5 s after the stop's write while copies were still serving.
- **Rust compiled to Wasm.** The memory cases ran in a JavaScript Worker. The API's Wasm memory counts against the same 128 MB but grows differently and doesn't shrink, so the result bounds the platform and doesn't measure the API.
- **A customer's DNS.** The TXT records sat on `opster.dev`, whose DNS is Cloudflare's own. A customer's DNS elsewhere has its own TTLs and negative caching.
- **The script list past 8 scripts** with no `limit`, and whether such an answer then carries a cursor.
- **Whether Cloudflare checks a manifest's hash against the bytes,** and what a cached KV read is billed.
- **Spend** wasn't read from billing. The counts above are far inside the plans' monthly allowances.

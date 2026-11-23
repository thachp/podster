# M6 spike G: a hostname's proof and a takedown's speed

**Status, 2026-11-23: ran.** The architect ran `run`, `cursor` and `cleanup` on 2026-11-23 against the second account and `podster.site`, with tokens the owner made. All three exited 0 and nothing was left. See [RESULTS.md](RESULTS.md). *(2026-11-22: written, not run.)* It answers [spike G](../../docs/m6-plan.md#the-spikes), and nothing builds on this folder.

**When it runs (the architect's ruling of 2026-11-22).** The content Worker deploys first, through `scripts/deploy-content` ([its guide](../../docs/content-deploy.md)). It serves nothing until a serve entry exists, and `RELEASES` stays off on the API. Spike G then runs against it on **the second account**, on `podster.site`, before `RELEASES` or the API's six provider settings are turned on. So the spike's serve entries are the only ones in the namespace while it runs.

"The second account" is the one the owner opened for apps, which holds `podster.site`. "The first account" holds `podster.dev` and `opster.dev`. Their IDs stay out of this repository.

## What it answers

| Question | Where it was asked | How the spike answers it |
| --- | --- | --- |
| Resolving a TXT record from a Worker, which resolver, and a definite no told from no answer | [ADR 0010](../../docs/adr/0010-release-and-the-content-domain.md) open question 11; [m6-plan spike D/G](../../docs/m6-plan.md#the-spikes) | The probe Worker asks Cloudflare's resolver (by name and by `1.1.1.1`) and Google's, over DNS-over-HTTPS with `fetch`, for two TXT records it makes and for fixed names: an `NXDOMAIN`, a `SERVFAIL`, a CNAME and a signed zone; and once with a 1 ms timeout. `readDoh` in `pure.mjs` sorts each answer into `found`, `no-record` (a definite no: `NXDOMAIN`, or `NOERROR` with no TXT owned by the name) and `no-answer` (anything else). It times how long a new record takes to show from inside a Worker, with and without an earlier lookup that missed, and how long a deleted one takes to go |
| How long a serve entry's write, switch and removal take to show at the host: the takedown time, and so the marker's wait | ADR "Takedown, and how fast it is" and open question 5; `MARKER_WAIT_MS` in `crates/core/src/release.rs` (30 s, provisional) | Four spike hosts on `podster.site`, each with two real static release scripts in the dispatch namespace. Each is written to v1, switched to v2 and removed through the KV REST API, as the API's applier does, while the host's marker (`/.well-known/podster-release.json`) is read through the deployed content Worker every 0.5 s on a fresh connection. Three hosts are never asked before their first write; one is asked first, so a missed read is cached, and runs three cycles. Each phase is watched for up to 120 s |
| Stale reads after a write or a delete | ADR open question 5; m6-plan's notes on a lagging read-back after a delete and after a write | After every write and delete, the entry is read back through the REST API at 0, 1, 2, 5, 10, 30 and 65 s, as the applier's read-back does, beside the host's own timeline |
| The stop key | m6-plan's note that the stop key's answers are unverified | Only if the namespace holds no key but the spike's and no stop, checked at the start and again right before the write (and not with `--no-stop`): the spike's own value is written to `_stop` once, the host is watched until it is not-found, the key is deleted and the host watched until it serves again. The content Worker keeps a stop it read for 30 s in each running copy, on top of KV's own cache |
| The provider's answers for a serve entry and the stop key, a missing key's included | `apps/api/src/content_provider.rs` (assumed: `200` with `"success": true`; `404` with code 10009); `apps/api/test/fake-content.ts` | Every write, switch, delete and read-back records the status, `success`, codes and `result`; a key never written is read and deleted |
| KV key listing, its cursor's lifetime; the scripts list's paging | m6-plan's notes on the reconciles' lists | `run` writes 25 keys and lists them 10 at a time, and with `limit=5`; it lists the namespace's scripts with no query and with `per_page`, `page` and `limit`. `cursor` keeps a first page's cursor and uses it again at 0 s, 1 min, 5.5 min and 10.5 min, past the reconcile's 5-minute interval |
| How the content Worker's deployed version is read | ADR open question 12 | Reads the content Worker's `deployments` and `versions` through the API, records their shapes (keys and types, no values), and whether the live deployment names the newest version |
| Whether a 5 MB file and a batch fit a Worker's memory | ADR open question 13; m6-plan "A Worker's memory" | The probe builds an upload body in memory as the release job does, the raw bytes and their base64 at once and then a copy as a request's body: 5 MB, 8 MiB (the plan's one request), 25 MB (a whole release), 50 MB and 100 MB, stopping at the first refusal. And one upload session for a full-size manifest (300 files, 25 MB, one of them 5 MB), never uploaded, records how the provider sizes buckets |
| Whether `no-transform` stops Cloudflare's compression | m6-plan, for spike G | `/big.txt`, 200 KB of text, through the content Worker (which sends `max-age=60, no-transform`) with `Accept-Encoding` `gzip, br`, `gzip` and `identity`, read without decoding; and the same from the probe with and without `no-transform` |
| A root `_headers` and `_redirects` sent as plain files | m6-plan, step 5's note | Every spike release carries both, as ordinary files. If the platform read `_headers`, the marker's type becomes `text/x-spike-g-headers`; if it read `_redirects`, `/spike-g-from` redirects. Both files are also asked for by path |
| Whether the provider takes part of a bucket in one request | m6-plan, "One request carries at most 8 MiB" | The first release is sent one file a request, and every answer is kept. If that isn't taken, a new session sends whole buckets and the run goes on |

**What it can't answer.** The takedown is read from one machine, so one Cloudflare location: how long it lasts elsewhere stays unknown. The memory test runs in a JavaScript Worker; the API's release job runs as Rust compiled to Wasm, whose linear memory counts against the same 128 MB but grows differently, so the result is a bound on the platform, not a measurement of the API. The TXT records sit on `opster.dev`, whose DNS is Cloudflare's own; a customer's DNS elsewhere will have its own TTLs and negative caching. Whether Cloudflare checks a manifest's hash against the bytes isn't asked.

## What it makes, and what it never touches

`node spike.mjs plan` prints the list for a run with no network and no token. Every name carries the run's six hex digits:

- **In the dispatch namespace:** 8 static release scripts, `spikeg<run>c1` … `c3` and `spikeg<run>w`, each `.rel_<32 hex>`, two for each label. One upload session for `spikeg<run>m.rel_…` that is never completed, so no script is made from it.
- **One Worker on the second account:** `spike-g-probe-<run>`, on the account's **existing** workers.dev address only. It answers only a request with the run's random header. If the account has no workers.dev subdomain, the probe and everything that needs it are skipped; the spike never makes one.
- **In the serve entries' KV namespace:** only keys `spikeg<run>(c1|c2|c3|w|x|l00…l24).podster.site`; and the stop key `_stop`, with the value `spike-g stop <run>`, only through the gate above.
- **On `opster.dev`:** two TXT records, `_spike-g-<run>a` and `_spike-g-<run>b`, TTL 60.

`guard.mjs` refuses anything else before it is sent: any other KV key; the stop key without the gate, with another value, or deleted except right after a read found a spike's value there; any script in the namespace but a spike name, with exactly the API's own query; any Worker but the probe; any DNS record but a spike TXT name with a spike value and TTL 60, and any delete of a record the spike didn't make or list under a spike name. It never touches the content Worker, its route, the zone's DNS or settings, or any real serve entry. A GET may read anywhere: the gate lists the namespace's keys, holds them in memory and records only how many aren't the spike's.

**Clean-up.** Every command ends, on an error, at its time or call bound, and on Ctrl-C, by deleting by listing: every KV key of the spike's forms from any run, the stop key only if a read just before the delete finds a spike's value in it (anything else there is left and reported), every spike script in the namespace and every one this run named, every `spike-g-probe-…` Worker, and every `_spike-g-…` TXT record. Every list is read to its last page. It waits five seconds, lists again, and records what is left; a list that didn't finish is reported as not fully listed, never as nothing left. It exits 3 if anything is. The clean-up has its own bound of 5 minutes and 400 calls. SIGTERM and SIGHUP (a closed terminal) are handled as Ctrl-C; the same signal a second time leaves at once, and then run `cleanup`. If a run is killed while it holds the stop, the content domain stays stopped, which is the safe direction, until `cleanup` removes it.

## The tokens and files

Each is read from a file whose **path** is given on the command line: never a value on the command line, never an environment variable. A file must be a plain file (not a link), mode 600, holding one token on one line; a missing file, or one that isn't so, refuses before anything is sent. Nothing prints or records a token: every one, every session token Cloudflare returns, the account and namespace IDs, the namespace's name, the workers.dev subdomain and every 32-hex ID, UUID and JWT is redacted before a line is written.

| Option | Token | Exactly these permissions | Used by |
| --- | --- | --- | --- |
| `--kv-token-file` | **Spike routing token** | Account: **Workers KV Storage: Edit**, on the second account only | `run`, `cursor`, `cleanup` |
| `--scripts-token-file` | **Spike scripts token** | Account: **Workers Scripts: Edit**, on the second account only. It covers the dispatch namespace's scripts and their upload, the probe Worker and its workers.dev switch, and reading the account's workers.dev subdomain and the content Worker's deployments and versions | `run`, `cleanup` |
| `--dns-token-file` | **Spike DNS token** | Zone: **DNS: Edit** and **Zone: Read**, on the zone `opster.dev` only (first account) | `run`, `cleanup`; leave it out with `--no-dns` |

Each token is the spike's own, not the content Worker's deploy token and not the publishing credential the API will use. A token's expiry of a day is enough. The owner deletes all three after the run.

**Why `opster.dev` for the TXT records, and not a name under `podster.site`.** A real challenge record lives on a customer's domain, and `opster.dev` already plays the customer in spike D. A DNS token on `podster.site` could rewrite the wildcard record every app is served under; one on `opster.dev` can't reach the content domain or `podster.dev`, since Cloudflare scopes a DNS token to the zones it names. `opster.dev` is on the first account, but the token is limited to that one zone and can't see the account's Workers or `podster.dev`.

**The configuration file** (`--config`), kept outside the repository, holds exactly these keys. None is secret, but the IDs stay out of the repository:

```json
{
  "account_id": "<the second account's ID>",
  "kv_namespace_id": "<the serve entries' KV namespace ID>",
  "dispatch_namespace": "<the dispatch namespace's name>",
  "content_worker": "podster-content",
  "content_domain": "podster.site",
  "dns_zone": "opster.dev"
}
```

The first four are the same values as `~/.config/podster/content-deploy.json`.

## Run it

Each run makes scripts, a Worker, KV keys and DNS records, so it needs the owner's yes. Run them one at a time, after the content Worker is deployed. `<dir>` is wherever the owner keeps the spike's files; the paths below are an example.

```bash
node --test spikes/m6-spike-g/spike.test.mjs
```

```bash
cd spikes/m6-spike-g && node spike.mjs plan --config <dir>/spike-g.json
```

```bash
cd spikes/m6-spike-g && node spike.mjs run --config <dir>/spike-g.json --kv-token-file <dir>/spike-g-kv.token --scripts-token-file <dir>/spike-g-scripts.token --dns-token-file <dir>/spike-g-dns.token
```

```bash
cd spikes/m6-spike-g && node spike.mjs cursor --config <dir>/spike-g.json --kv-token-file <dir>/spike-g-kv.token
```

```bash
cd spikes/m6-spike-g && node spike.mjs cleanup --config <dir>/spike-g.json --kv-token-file <dir>/spike-g-kv.token --scripts-token-file <dir>/spike-g-scripts.token --dns-token-file <dir>/spike-g-dns.token
```

**Never run `run` and `cursor` at the same time,** nor either beside `cleanup`: every clean-up deletes the spike keys of every run it lists, so one would delete the other's keys mid-measurement.

`run` refuses before making anything unless the content Worker already answers a spike host on the content domain with its own not-found and sandbox policy.

## Bounds and spend

| Command | Time | API calls | Reads of the content domain | Calls to the probe |
| --- | --- | --- | --- | --- |
| `run` | 20 min | 900 | 5,000 | 400 |
| `cursor` | 13 min | 120 | 0 | 0 |

The clean-up's own calls are outside these, and bounded by what the listings hold. Expected for `run`: about 8 to 12 minutes; about 250 API calls; under 3,000 reads of the content domain; about 100 KV writes and deletes and about 150 KV reads through the API; one Worker invocation per edge read, and the content Worker's KV reads; under 300 probe calls, each with at most three DNS lookups or one memory case. `cursor` makes about 35 calls in 11 minutes.

**Expected spend: nothing beyond the subscriptions.** All of it is far inside the monthly amounts the second account's plans include: Workers for Platforms' 20 million requests and 1,000 scripts, and Workers Paid's KV allowance of 10 million reads and 1 million writes, deletes and lists ([KV pricing](https://developers.cloudflare.com/kv/platform/pricing/), [Workers for Platforms pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/)). DNS records and DNS-over-HTTPS lookups cost nothing.

## Results

Every step is appended to `results/results.jsonl`, redacted. *(2026-11-23: the run's lines are committed as `results/run.jsonl`, `results/cursor.jsonl` and `results/cleanup.jsonl`, one file a command.)* As with earlier spikes, the file is committed after a run, once it has been checked for tokens, the account and namespace IDs, the namespace's name and the workers.dev subdomain. One JSON object a line, with the run's ID and command. `takedown` lines hold, for each host and phase, the provider's answer, the host's timeline (`first_ms`, `stable_ms`, `flips_after_first`, the states read and the Cloudflare locations seen) and the read-back series. The figure to set the marker's wait from is the largest `stable_ms` of the `write` and `switch` phases; the takedown time is the `remove` phase's.

## Sources

Checked in Cloudflare's documentation on 2026-11-22, before writing; none of it is a measurement.

- **Spend:** [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) (Workers Paid: 10 million reads, 1 million writes, deletes and lists a month; a read of a missing key is billed too); [Workers for Platforms pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/) (20 million requests and 1,000 scripts a month; one request across the dispatch chain).
- **KV:** [how KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/) and [limits](https://developers.cloudflare.com/kv/platform/limits/): up to 60 seconds or more for a change to show elsewhere, a 30-second shortest `cacheTtl`, and **one write a second to the same key**, which the spike's phases stay under. The REST calls are the [API reference](https://developers.cloudflare.com/api/)'s KV namespace keys and values.
- **Compression:** [Cache-Control](https://developers.cloudflare.com/cache/concepts/cache-control/) says compression is disabled when `no-transform` is present, and [content compression](https://developers.cloudflare.com/speed/optimization/content/compression/) that an origin's `no-transform` stops Brotli/Gzip to visitors. Whether that holds for a Worker's own answer, which has no origin, is what the spike reads.
- **Workers:** the [API reference](https://developers.cloudflare.com/api/)'s script deployments and versions; [memory limit](https://developers.cloudflare.com/workers/platform/limits/) (128 MB an isolate); static assets' [`_headers`](https://developers.cloudflare.com/workers/static-assets/headers/) and [`_redirects`](https://developers.cloudflare.com/workers/static-assets/redirects/); [direct upload of assets](https://developers.cloudflare.com/workers/static-assets/direct-upload/).
- **DNS:** [1.1.1.1's JSON format](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/), [Google's JSON API](https://developers.google.com/speed/public-dns/docs/doh/json).
- **Earlier spikes:** [A, the namespace](../m6-namespace-app/README.md) (scripts, the upload's calls, the deleted script's read), [D, custom hostnames](../m6-hostnames/README.md) (the resolvers from a laptop, `opster.dev`'s wildcard and its `NOERROR` with no data).

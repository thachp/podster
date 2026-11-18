# M6 spike D: custom hostnames

**Status, 2026-11-18 UTC: the test Worker on the content zone ran 11:52:30 to 11:53:58 (run `0bd4a7`, [below](#the-test-worker-on-the-content-zone-2026-11-18-run-0bd4a7)); before it, the spike ran five times on the content zone `podster.site`, 10:39:24 to 10:52:16 UTC, by the owner's answers of 2026-11-17. The fourth run, `02dd4b`, followed the owner's record `spike.opster.dev CNAME fallback.podster.site`, proxied, on `opster.dev`, and took a custom hostname to `active` with its certificate; the fifth, `65c6f6`, repeated it with the probe's certificate checks on (below). Everything it created is deleted, confirmed by listing.** It answers the parts of [spike D](../../docs/m6-plan.md#the-spikes) that need no customer DNS, and the items step 8b and 8c left owed to it. The answers and what they change are in the plan's [Spike D results](../../docs/m6-plan.md#spike-d-results-2026-11-18). Nothing builds on this folder.

"The zone" is `podster.site`. "The account" is the one the zone is on, which is the staging account that also holds `podster.dev` and `opster.dev`. "The second account" is the one the owner opened for apps. Their IDs stay out of this repository.

## What is here

| Path | What it is |
| --- | --- |
| `spike.mjs` | The runner. `hostnames` is the custom-hostname run; `pending` the edge probes around one pending hostname, on fresh connections; `validate` one hostname watched to `active` once the customer's record is in place; `doh` the resolver half; `probes` the edge alone; `cleanup` deletes by listing. Every command ends with the clean-up |
| `guard.mjs`, `guard.test.mjs` | What the runner may send to Cloudflare, and an offline test of it |
| `route-worker.mjs`, `make-route-worker.sh` | The test Worker routed `*/*` on the content zone, and the script that deploys and deletes it with wrangler. It writes the Worker, its config and its random key into a scratch folder outside the repository |
| `results/results.jsonl` | Every step of the runs, redacted. Run `d8e31d` is `doh`, `c06765` is `hostnames`, `2bc8b6` is `pending`, `02dd4b` and `65c6f6` are `validate`, `0bd4a7` is `worker`, and `83652b` (11:51:40 to 11:51:47, a fallback-origin check and clean-up), `121876` and `7cfcac` are clean-ups around it |

## How it calls Cloudflare

- **One function sends every API request, and it asks `guard.mjs` first.** A `GET` may go anywhere on Cloudflare's API. A create may name only one of four names under `opster.dev`, with exactly `{"ssl": {"method": "http", "type": "dv"}}` and nothing else; a delete only an ID the runner got from such a create or from a listing under one of those names; a script on the second account only `spike-hostnames-…`.
- **The tokens are read from the owner's files into memory** (`~/.podster/spike-hostnames.token`, `~/.podster/spike-store-d1only.token` and `~/.podster/cloudflare-account-id.second-account`, mode 600) and sent in a header and nowhere else. The zone's ID is looked up by name at the start and held in memory.
- **What is kept:** status, Cloudflare's codes and messages, the names asked for, the fields Cloudflare returned except their values where they are IDs or tokens, timings, and what the edge answered. Every 32-hex ID and every UUID is redacted before anything is written or printed, so the ownership TXT value is kept only as `<uuid>`. The files were checked after the runs for the tokens, the two account IDs and the zone's ID: none is there.
- **No route, DNS record, setting or Worker was made on any zone.** The test Worker on the second account was refused at its upload (below), so it never existed.

## Run it again

```bash
node --test spikes/m6-hostnames/guard.test.mjs
```

```bash
cd spikes/m6-hostnames && node spike.mjs hostnames
```

```bash
cd spikes/m6-hostnames && node spike.mjs validate
```

```bash
cd spikes/m6-hostnames && node spike.mjs cleanup
```

It makes custom hostnames on the zone, so it needs the owner's yes each time. Each custom hostname is one of the 100 included on the zone's plan; the runner holds at most three at once.

## What was observed

### The zone and the token

- **The fallback origin** read `fallback.podster.site`, `active`, at every run's start.
- **The zone is on the staging account,** not the second account. The custom-hostname token listed the zone, read the fallback origin, and listed, made, read and deleted custom hostnames. It was refused the zone's Workers routes and DNS records (`401`, code 10000) and its SSL setting (code 9109).
- **The zone held no custom hostname before the runs, and holds none after.**

### Making, reading and deleting a custom hostname

| What | Answer |
| --- | --- |
| Create `spike.opster.dev` (6 times, 5 before the last run) | `201`, 185 to 410 ms. `status: pending`, `ssl.status: initializing`, `ssl.method: http`, `ssl.type: dv`, no `validation_records`. `ownership_verification` is `{type: txt, name: _cf-custom-hostname.spike.opster.dev, value: <uuid>}`; `ownership_verification_http` is there too. The create's own answer has no `verification_errors` key |
| Its certificate authority, unasked | `ssl_com` for `spike.opster.dev` and `spike-case.opster.dev`; `google` for `x.spike.opster.dev`. Cloudflare picks it |
| Read by ID at once | `200`, the same fields |
| How long until the list by name shows it | **On the first read, every time:** 141 to 391 ms after the create's answer, in the 5 creates this was timed for (run `c06765`). 8 creates succeeded in all: 6 of `spike.opster.dev`, `spike-case.opster.dev` and `x.spike.opster.dev` |
| The same name again | **`409`, code 1406,** "Duplicate custom hostname found." |
| `Spike-Case.Opster.Dev` | `201`, **stored as `spike-case.opster.dev`** |
| `spike-dot.opster.dev.`, a trailing dot | **`400`, code 1407,** "Invalid custom hostname…" |
| The list searched by `SPIKE.OPSTER.DEV` | Finds `spike.opster.dev`: the search ignores case |
| The list searched by `spike.opster.dev.` | `400`, code 1407 |
| The list searched by `spike.opster.dev` while `x.spike.opster.dev` was held | **Only `spike.opster.dev`.** The longer name that contains it wasn't returned |
| Paging, three entries, `per_page` 1 and 5, each read twice | `per_page=1` is accepted. The same order both times (by name), `total_count` 3 on every page |
| Status over three minutes, the customer's DNS untouched | `pending` throughout; `ssl.status` `pending_validation` (once `initializing` on a read a second after the create); `verification_errors: ["custom hostname does not CNAME to this zone."]` |
| Delete | `200`, its `result` holds only `created_at`, `id` and `ssl` |
| How long until it reads gone | **On the first read, every time:** by ID `404`, code 1436, "The custom hostname was not found.", and gone from the list by name; 113 to 383 ms, 8 timed deletes of 8 (7 before the last run) |
| Delete it again | `404`, code 1436 |

### The edge, while nothing is active

*How the edge was probed.* Runs `c06765`, `2bc8b6` and `02dd4b` turned certificate checking off in the probe (`rejectUnauthorized: false`) and recorded `cert_valid_for_sni` from the socket. On review that was replaced: since run `65c6f6` the chain is always validated, and only the name check is swapped for one that records the certificate presented and whether it names the SNI (`cert_names_sni`, from `tls.checkServerIdentity`), then lets the request finish. Run `65c6f6` repeated `validate` that way and every answer below held: the same statuses, the same certificates, every one naming its SNI, and no chain refused.

`spike.opster.dev` already resolves to Cloudflare, through `opster.dev`'s own proxied wildcard record, and `opster.dev` is on the same account. Each probe was one fresh TLS connection to Cloudflare, with the SNI and `Host` shown, in run `2bc8b6`: twice before the create, twice with the hostname `pending`, and once after the delete. Every answer was the same in all five.

| SNI | `Host` | Answer | Certificate |
| --- | --- | --- | --- |
| `spike.opster.dev` | `spike.opster.dev` | `522` (the `opster.dev` zone's origin, `100::`) | `opster.dev`, `*.opster.dev` |
| `fallback.podster.site` | `fallback.podster.site` | `522` (the zone's origin, `100::`; no Worker route) | `podster.site`, `*.podster.site` |
| `fallback.podster.site` | `spike.opster.dev` | **`403`** | `podster.site` |
| `spike.opster.dev` | `fallback.podster.site` | **`403`** | `opster.dev` |
| `podster.dev` | `spike.opster.dev` | **`403`** | `podster.dev` |
| `spike.opster.dev` | `podster.dev` | **`403`** | `opster.dev` |
| `x.spike.opster.dev` | `spike.opster.dev` | **TLS refused** (`EPROTO`): no certificate covers a second-level name | none |

- **While the custom hostname was `pending`, `spike.opster.dev` was still served by `opster.dev`'s own zone,** with that zone's certificate: nothing went to the content zone.
- **A `Host` that names another zone than the SNI was refused `403`** on a fresh connection, in every direction tried, Podster's own `podster.dev` included. In run `c06765`, whose probes reused one connection from Node's pool, the same mismatches were answered **`421 Misdirected Request`** after the first; the first answers on that run were `403`. Either way no mismatched request reached a zone's origin.
- **Not shown:** the same with a custom hostname `active`, and what a Worker on the content zone sees as the request's host. Both need the DNS record below and a route.

- *These three runs were before the owner's record existed, as far as they show:* each read `verification_errors: ["custom hostname does not CNAME to this zone."]`, the last at 10:43:16.

### After the owner's record: `active`, its certificate, and a delete at the edge

The owner added `spike.opster.dev` as a `CNAME` to `fallback.podster.site` on `opster.dev`, **proxied**. Public resolvers then answered `spike.opster.dev` with Cloudflare's addresses and no `CNAME`, as a proxied record does. **`opster.dev` and `podster.site` are on the same account,** and Cloudflare's documentation says orange-to-orange (O2O) "only applies when the two zones are part of different Cloudflare accounts". So this was neither a real O2O case nor the ordinary one, a customer whose DNS isn't on Cloudflare; **which one Cloudflare treated it as wasn't observable** (see below).

Run `02dd4b` made `spike.opster.dev` and read it every 30 seconds:

| Seconds after the create | `status` | `ssl.status` | Other |
| --- | --- | --- | --- |
| 0 | `pending` | `initializing` | no `validation_records` |
| 32 | **`active`** | `pending_validation` | two `validation_records`, each with `http_body`, `http_url` and `status` |
| 63 | `active` | `pending_validation` | the same |
| 94 | **`active`** | **`active`** | `validation_records` empty |

- **No TXT record was published.** Cloudflare's own check was the record pointing at the zone; the `_cf-custom-hostname` TXT name it returned played no part. *So Cloudflare proves only that a name points at the content zone, never which room may have it:* Podster's own TXT challenge (8a) is the only thing between rooms.
- **The certificate, from 94 s:** subject `spike.opster.dev`, that name alone, issued by SSL Corporation, the `ssl_com` the create named. Before it, the edge presented `opster.dev`'s own certificate for the name. Whether it was published in certificate-transparency logs wasn't looked up; SSL.com logs publicly-trusted certificates as browsers require.
- **The edge with the custom hostname `active`, SNI and `Host` both `spike.opster.dev`:** `522`, with the custom hostname's certificate. Both zones' origins are `100::` with no Worker, so a `522` is what either zone would answer: **which zone handled the request can't be told from this.** It takes a Worker route on the content zone.
- **Mismatched SNI and `Host` were still `403`,** in all four directions, with the custom hostname's certificate when the SNI was `spike.opster.dev`.
- **The delete at the edge:** the delete answered `200` at 10:46:12; the list read it gone on the first read (315 ms); and the next probe, within a second, was served `opster.dev`'s own certificate again. One observation from one place.
- `x.spike.opster.dev` stopped resolving (`ENOTFOUND`) once `spike.opster.dev` had a record of its own, which takes the name out of `opster.dev`'s wildcard.

### Resolving a TXT record over HTTPS, from this machine

Nine names, each through Cloudflare's JSON endpoint by name and by `1.1.1.1`, and through Google's `dns.google/resolve`:

| Name | Status | What it shows |
| --- | --- | --- |
| `_cf-custom-hostname.spike.opster.dev` TXT | `0`, no answer, authority `opster.dev` | **`opster.dev`'s wildcard `AAAA` makes a name it covers answer `NOERROR` with no TXT,** not `NXDOMAIN`. A wildcard `TXT` there would answer every challenge name under it |
| `nothing-here-spike-d.podster.site` TXT | `0`, no answer | The content zone answers the same way for a name it has no record for, so it has a wildcard too |
| `nothing-here-spike-d.invalid` TXT | **`3`** (`NXDOMAIN`), `AD: true` | |
| `dnssec-failed.org` TXT | **`2`** (`SERVFAIL`) | Cloudflare adds `Comment: ["EDE(9): DNSKEY Missing…"]` as a list; Google's `Comment` is a string |
| `_dmarc.podster.dev` TXT | `0`, one answer, `AD: false` | **Cloudflare returns a TXT's `data` in quotes** (`"\"v=DMARC1; p=reject;\""`), **Google without them.** Cloudflare's owner name has no trailing dot; Google's has one |
| `cloudflare.com` TXT | `0`, 29 answers, **`AD: true`** | Signed. `podster.dev`, `podster.site` and `opster.dev` all answered `AD: false`: none is signed |
| `www.github.com` TXT | `0`, a `CNAME` (type 5) to `github.com.` then 25 TXT **owned by `github.com`** | A TXT asked for one name can come back owned by another, through a CNAME |
| `spike.opster.dev` TXT and CNAME | `0`, no answer | |

`TC` was `false` in every answer. Cloudflare's content type was `application/dns-json`, Google's `application/json; charset=UTF-8`.

### The test Worker on the second account

**Not made.** The second account's token, `spike-store-d1only`, was refused the upload (`403`, "No access to the specified resource.", no code) and the account's `workers.dev` subdomain (`403`, code 10000). It could list the account's Workers (none). So no resolver was asked from inside a Worker, and nothing was left to delete; the clean-up's listing found no `spike-hostnames-…` script.

## The test Worker on the content zone, 2026-11-18 (run `0bd4a7`)

**Run 11:52:30 to 11:53:58 UTC by the owner, in their own terminal, by their yes of 2026-11-18,** at commit `7b62c370` of `spike/m6-hostnames-worker`. The owner had checked in the dashboard that `podster.site` had no Worker route. The session's own permission check had refused this deploy, so the agent didn't run it. The owner ran it through `make-route-worker.sh`:
- **`deploy`** made one Worker, `spike-hostnames-route-f9717e`, on the staging account, with no bindings, `workers_dev` and `preview_urls` off, and the route `*/*` on `podster.site`. It used wrangler's own login, as staging deploys do.
- **`node spike.mjs worker`** ran the checks.
- **`delete`** removed the Worker and its route.

The Worker (`route-worker.mjs`) answers every request with its host as it sees it and a few `cf` fields. It logs nothing. Runs `83652b` (11:51:40 to 11:51:47) and `121876` (11:51:44) are the clean-up's listings before the deploy, and run `7cfcac` (11:53:59) the one after; each read 0 custom hostnames and 0 spike scripts.

| When (UTC) | What | Answer |
| --- | --- | --- |
| 11:52:31 | Probes right after the deploy, no custom hostname | `fallback.podster.site`: **`522`**, the zone's origin, not the Worker. `spike.opster.dev`: `522`, `opster.dev`'s own certificate |
| 11:52:32 | DNS over HTTPS from inside the Worker, through `fallback.podster.site` | **`522`: the route wasn't live yet, so this was never measured** |
| 11:52:32 to 11:53:49 | `spike.opster.dev` made; read every 15 s | `active` at 15 s, its certificate `active` at 77 s |
| 11:53:49 to 11:53:51 | Probes, twice, with it `active` | See below |
| 11:53:51.410 | Delete | `200`; the list read it gone on the first read, 145 ms later |
| 11:53:51.692 | Probe, SNI and `Host` `spike.opster.dev` | **`200` from the Worker, with the custom hostname's certificate**, 282 ms after the delete's answer |
| 11:53:52.085 | Probe, SNI `spike.opster.dev`, `Host` `fallback.podster.site` | `403`, now with `opster.dev`'s own certificate |

**With `spike.opster.dev` `active`, on both probes:**
- **The content zone serves it, and the Worker sees the custom hostname.** SNI and `Host` `spike.opster.dev` gave `200` from the Worker, with `url_host` and the `Host` header both `spike.opster.dev`, scheme `https:`, TLS 1.3, HTTP/1.1, colo SEA. The certificate was SSL Corporation's for `spike.opster.dev`. `cf.hostMetadata` was `null`: none was set on the custom hostname.
- **Traffic reaches the Worker through the fallback origin.** `fallback.podster.site` gave `200` from the Worker, which saw `fallback.podster.site`, with the zone's own `*.podster.site` certificate.
- **A mismatch never reached the Worker.** All four pairs whose SNI and `Host` name different zones (`fallback.podster.site` and `spike.opster.dev` both ways, and `podster.dev` against `spike.opster.dev`) gave `403` from Cloudflare, not the Worker's JSON. So whenever the Worker answered, the host it saw was the one the certificate was served for, at least for the pairs tried.

**Route propagation.** The deploy reported its trigger, `*/*` on `podster.site`, but probes about two seconds later still got the origin's `522`. At 11:53:49 the Worker answered. So the route went live somewhere in that window of under 80 seconds; when exactly wasn't measured.

**The edge lagged a deletion.** 282 ms after the delete's `200`, and after the list already read the name gone, one request for `spike.opster.dev` still reached the Worker, with the custom hostname's own certificate. The next connection with that SNI, 393 ms later, was served `opster.dev`'s certificate. It was a mismatched pair (`Host` `fallback.podster.site`, refused `403`), so it shows only that the custom hostname's certificate was gone, not that a matching request would no longer reach the Worker: no matching request was made after that point. That is one request, from one place (SEA). How long the lag can last elsewhere is unknown.

**After the run,** the owner's terminal recorded:
- `wrangler delete`: "Successfully deleted spike-hostnames-route-f9717e".
- `fallback.podster.site`: `522` again, so no Worker answers there.
- The clean-up's listing: 0 custom hostnames (`total_count` 0) and 0 spike scripts on the second account.

At 11:54, from this machine, `fallback.podster.site` and `spike.opster.dev` each answered `522`. **The route's removal was checked only this way.** No credential this spike may use can list the zone's routes, so it rests on `wrangler delete` and the Worker no longer answering at the edge.

## Clean-up

Every command ends by listing every custom hostname on the zone and deleting each with a spike name, deleting any `spike-hostnames-…` script on the second account, waiting five seconds and listing again. All five runs ended with **0 custom hostnames on the zone and 0 scripts on the second account**, `total_count` 0. **The owner's record on `opster.dev` is left in place** for a rerun; it routes nothing while the zone holds no custom hostname for the name, and the edge served `opster.dev`'s own certificate for it after the last delete.

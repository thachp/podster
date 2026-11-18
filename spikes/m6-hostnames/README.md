# M6 spike D: custom hostnames

**Status, 2026-11-18 UTC: run five times on the content zone `podster.site`, 10:39:24 to 10:52:16 UTC, by the owner's answers of 2026-11-17. The fourth run, `02dd4b`, followed the owner's record `spike.opster.dev CNAME fallback.podster.site`, proxied, on `opster.dev`, and took a custom hostname to `active` with its certificate; the fifth, `65c6f6`, repeated it with the probe's certificate checks on (below). Everything it created is deleted, confirmed by listing.** No Worker route exists on the content zone, so what a Worker sees on a custom hostname is still untried. It answers the parts of [spike D](../../docs/m6-plan.md#the-spikes) that need no customer DNS, and the items step 8b and 8c left owed to it. The answers and what they change are in the plan's [Spike D results](../../docs/m6-plan.md#spike-d-results-2026-11-18). Nothing builds on this folder.

"The zone" is `podster.site`. "The account" is the one the zone is on, which is the staging account that also holds `podster.dev` and `opster.dev`. "The second account" is the one the owner opened for apps. Their IDs stay out of this repository.

## What is here

| Path | What it is |
| --- | --- |
| `spike.mjs` | The runner. `hostnames` is the custom-hostname run; `pending` the edge probes around one pending hostname, on fresh connections; `validate` one hostname watched to `active` once the customer's record is in place; `doh` the resolver half; `probes` the edge alone; `cleanup` deletes by listing. Every command ends with the clean-up |
| `guard.mjs`, `guard.test.mjs` | What the runner may send to Cloudflare, and an offline test of it |
| `results/results.jsonl` | Every step of the five runs, redacted. Run `d8e31d` is `doh`, `c06765` is `hostnames`, `2bc8b6` is `pending`, `02dd4b` and `65c6f6` are `validate` |

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

## The test Worker on the content zone: not run

Later on 2026-11-18 the owner said yes to one short-lived Worker on the staging account, routed on `podster.site` (`*/*` if the zone had no route, else the narrowest pattern), to answer which zone serves an `active` custom hostname, what host a Worker sees, whether the fallback origin reaches it, a resolver asked from inside it, and `moved`. The brief required the zone's existing Worker routes to be listed first. **No credential this spike may use could list them:** the custom-hostname token is refused the zone's routes (code 10000); wrangler, logged in as staging deploys are, has no command that lists a zone's routes; and reading wrangler's stored login for a direct API call was refused by the session's permission check. So nothing was deployed and no route was made.

## Clean-up

Every command ends by listing every custom hostname on the zone and deleting each with a spike name, deleting any `spike-hostnames-…` script on the second account, waiting five seconds and listing again. All five runs ended with **0 custom hostnames on the zone and 0 scripts on the second account**, `total_count` 0. **The owner's record on `opster.dev` is left in place** for a rerun; it routes nothing while the zone holds no custom hostname for the name, and the edge served `opster.dev`'s own certificate for it after the last delete.

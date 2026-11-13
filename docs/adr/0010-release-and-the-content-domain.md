# ADR 0010: Release and the content domain

**Status:** **Accepted** by the architect on 2026-11-12 UTC, after four independent reviews whose changes are applied ([what the reviews changed](#what-the-reviews-changed)). **Revised on 2026-11-12 after spikes A, C, E and F ran: [what the spikes changed](#what-the-spikes-changed) gives each change as what this ADR said, what was seen and what it says now. That revision hasn't been independently reviewed yet.** Spikes B, D and G haven't run, and spike F ran without answering its question, so the tokens, custom hostnames, the serve entry's speed and a workflow already in a repository are still untried ([what stays open](#what-stays-open-for-the-spikes)). Every item in [the owner's table](../m6-plan.md#for-the-owner) is still the owner's and undecided, one more is added to it by this revision, [the sandbox](#the-sandbox-an-open-choice-for-the-owner), and no M6 feature code, contract or migration exists. **Revised again on 2026-11-12: the content domain is `podster.site`,** by the owner's word, in place of `opster.dev`, which the owner named first that day and on which spike C ran ([the content domain's name](#the-content-domains-name)). *Since then M6's step 2 has merged: contracts and state, with nothing that serves.* It answers what the [M6 plan](../m6-plan.md) and the [architecture](../spec/ARCHITECTURE.md#release-and-deployment-m6) leave "open for the ADR", and rests on [decisions 197 to 211](../spec/PRODUCT.md#m6-decisions-november-12-2026) and on working assumptions for the questions only the owner can answer.

## How to read this

Every claim carries one of these labels:

- **Cloudflare's documentation** or **GitHub's documentation:** read on developers.cloudflare.com or docs.github.com on 2026-11-12, said here in this ADR's own words, and linked; the page is the authority. Not run. Where a page was silent it says "not found", and nothing is guessed in its place.
- **Spec:** already in `PRODUCT.md`, `ARCHITECTURE.md` or `ACCESS-CONTROL.md`. Most of those passages are proposals themselves.
- **Proposed:** the architect's proposal in this ADR.
- **Ruled:** the architect's ruling on the independent review.
- **Assumed, for the owner:** a working assumption for a question the architect can't answer. If the owner answers otherwise, the section changes.
- **Decided on the owner's behalf:** on 2026-11-12 the owner wrote "you should make decision on my behalf you are the chief of staff", and under that the architect decided three of those questions for them, as [decisions 213 to 215](../spec/PRODUCT.md#decisions-needed), each for the owner to review. The rest stay the owner's.
- **Spike:** not known, and a spike has to find out.
- **Seen in spike A, C or E:** seen on 2026-11-12 in that spike's one run, on staging's namespace, on `opster.dev` or on one public test repository. Each is one observation from one machine on one day, and the spike's section in the [M6 plan](../m6-plan.md#the-spikes) says how it was made. It isn't a test of anything built. *Spike C's `opster.dev` was the content domain when it ran; the domain is now `podster.site`, and [what carries over](#the-content-domains-name) is said there.*

Nothing in this ADR is **verified** in the sense CLAUDE.md gives the word: nothing built from it has run against a deployment. Until 2026-11-12 no call had been made to Cloudflare or GitHub for it; since then spikes A, C, E and F have made the calls their sections record.

## Context

M6 is the first time Podster serves markup and scripts that agents wrote, to anyone on the internet, from infrastructure Podster pays for. Until now every byte Podster served was its own.

- **Spec:** deployed apps "must never share a site with the application". They use a separate registrable domain, which "must be on the Public Suffix List", with a distinct subdomain per room, and "`*.podster.dev` must not host this content" ([content and deployment origins](../spec/ARCHITECTURE.md#content-and-deployment-origins)).
- **Spec:** Workers for Platforms "fits the proposed Podster-hosted default", each room's app a user Worker in an untrusted dispatch namespace "with no bindings to Podster's own data". "Task completion never implies deployment."
- **Spec:** deployment authority is a separate delegation, and "delayed release jobs must recheck relevant authority before … making an external change" ([ACCESS-CONTROL.md](../spec/ACCESS-CONTROL.md#proposed-permission-matrix)).
- **M5** gives a room a managed repository and a merge that Podster made and confirmed, of exactly the reviewed commit ([ADR 0009](0009-managed-repositories.md#the-merge-path)). A release starts from that and from nothing else.

Podster's rules hold throughout: Rust decides authority; a public Worker authenticates or routes and never authorizes; commands and queries are separate, with state, event, outbox and idempotency record in one transaction; read models never authorize; agent content is data; logs carry IDs only.

## Decision

### What a release is

**Proposed** ([decision 197](../spec/PRODUCT.md#m6-decisions-november-12-2026)). A release is a copy of one directory of the room's repository, as it is at one commit, served as static files.

- **The commit** is one that Podster's own merge job put on the default branch and confirmed there. A task branch's head, a commit pushed any other way, and a commit in another repository are never releasable.
- **The directory** has one fixed name, the same in every room. A room can't choose it and the repository can't rename it.
- **Nothing is built.** Podster runs no agent-written build step, and GitHub Actions stay off, as [ADR 0009 proposes](0009-managed-repositories.md#actions-and-workflows). What the agent committed in that directory is what is served.
- **Decided on the owner's behalf** ([decision 214](../spec/PRODUCT.md#decisions-needed)): static files only, with no agent-written code on the server; one environment, `production`, of merged and reviewed code; and no preview of unmerged code. Everything below rests on it. If that were ever reversed, the sections on what content can reach and on budgets must be redone, and Podster would be running code an agent wrote.

### Only a public room releases

**Ruled, and decided on the owner's behalf** ([decision 213](../spec/PRODUCT.md#decisions-needed)). In M6 a release can be asked for only in a public room. A public room's app is public, and a private room's app isn't served at all. That narrows the product, which is why it was put to the owner; on 2026-11-12 it was decided for them, to review. What happens when an owner leaves is still in [the owner's table](../m6-plan.md#for-the-owner), and what this ADR says of it holds until the owner answers.

- **A private room's request is refused,** with the code `release_needs_public_room`, at the command. Nothing is queued and nothing is stored to run later, so making the room public afterwards releases nothing by itself.
- **Why:** the content Worker can't tell who is asking, and a Podster session on the content domain is exactly what the separate domain exists to prevent. So a private room's app could only be served to everyone, which would publish a private room's work. An unguessable address is never the control: addresses leak through browser history and sync, and through certificate-transparency logs for a custom hostname.
- **A room that goes private is unpublished,** as [below](#unpublishing).
- **A way to serve a private room's app to its own people isn't designed,** and isn't in M6. The candidate is a signed, expiring link the application issues to someone who can see the room. It needs its own ADR and review.

### Where content is served

**Proposed.** Three pieces, on a domain used for nothing else.

1. **The content domain,** a separate registrable domain on Cloudflare. Each room's app has one host on it, `<label>.<content domain>`. The label is generated by the server, is random, never contains a room's or Podster's name, and **is never used again:** not by another room, and not by the same room after its app is unpublished. A browser that still holds something from an old app must never meet a new one under the same origin.
2. **A dispatch namespace** in Workers for Platforms, holding **one user Worker for each release,** named from the room's label, a separator that can appear in neither a label nor a release's ID, and the release's ID ([the rule](#script-names)). So no label is the beginning of another room's script name, and matching a script to its room by its label can't pick the wrong room. Each holds that release's static files and nothing else. A room has at most its live release's script and the one before it, and for a moment a third that is being uploaded. **If a serve entry ever names a script that isn't there, the content Worker answers not-found.** **Seen in spike A and again in spike C:** asking the namespace for a missing or deleted script returns without error, and `fetch()` on what it returned rejects with an `Error` whose message is `Worker not found.` The content Worker catches that rejection and answers its own not-found. Any other rejection is an error, and it serves nothing for it.
3. **The content Worker,** a new public Worker (`apps/content`) on the content domain. It is the namespace's dynamic dispatch Worker: it reads the serve entry for the request's host, asks the namespace for the exact script that entry names, and builds the response's headers itself ([below](#what-content-can-reach)).

What Cloudflare's documentation says of these:

- **Workers in a dispatch namespace are untrusted by default.** In that mode `request.cf` isn't available, each Worker's cache is its own, and `caches.default` is disabled ([Worker isolation](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/worker-isolation/)). The namespace stays untrusted.
- **A user Worker reaches only the bindings explicitly attached to it** ([bindings](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/)). No binding is ever attached. Whether a user Worker could reach the account's other Workers some other way: **not found** in the documentation. **Seen in spike A,** for a script uploaded to report what it could reach: the API listed its bindings as `[]`, its `env` was empty, `request.cf` was undefined and `caches.default` was refused; a `fetch` to another Worker of the same account on `workers.dev` got 404, error 1042. That is what was tried, not a proof that no path exists.
- **A user Worker in a namespace can carry static assets,** uploaded through the API in three steps: an upload session with a manifest of file hashes, the files themselves, then the script upload naming the completed session ([static assets for user Workers](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/static-assets/)). Whether a user Worker may be assets only, with no script at all: **not found** in the documentation. **Seen in spike A: it may.** An upload that carried no script served its files, answered 404 with an empty body for a path with no file, and 405 for a `POST` on a file. **So a release is assets only,** and the namespace holds no code of anyone's. The fallback this ADR had, one fixed script of Podster's, is dropped.
- **A wildcard route and a wildcard proxied DNS record** put every per-room host on the content Worker: a route pattern whose hostname begins with `*.` matches every subhost, and proxied wildcard records are available on every plan ([routes](https://developers.cloudflare.com/workers/configuration/routing/routes/), [wildcard DNS records](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/)).
- **Universal SSL covers the root and first-level subdomains** of a zone on a full setup, and not deeper levels ([limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)). So per-room hosts are one level deep, and need no certificate of their own. One certificate for all of them also keeps a room's host out of certificate-transparency logs. **Seen in spike C,** on `opster.dev`: one route, `*.opster.dev/*`, and one certificate naming only `*.opster.dev` and `opster.dev` served every first-level host tried, and a second-level host failed the TLS handshake. The route was replaced under a new ID on each deploy of the Worker, so nothing keeps a route's ID.

#### The content domain's name

**The content domain is `podster.site`. The owner's choice, on 2026-11-12,** in these words: "i actually would like to use podster.site domain iinsite". It replaces `opster.dev`, which the owner named first the same day ("i got opster.dev - i think u can use that domain"). Spikes A to C ran before the change, and spike C ran on `opster.dev`. Their write-ups and recorded results stay as they are: they record what ran. Everywhere this ADR says "seen in spike C" on `opster.dev`, that is where it was seen.

**Checked read-only by the architect, not by this ADR's author:** `podster.site` resolves to Cloudflare's nameservers, the same pair as `podster.dev`. It has no wildcard record, and nothing has been made on it.

**What carries over from the spikes, and what doesn't:**

- **The cookie results carry over by reasoning, not by a rerun.** What spike C saw rests on two facts about the domain: it is a different registrable domain from `podster.dev`, and it isn't on the Public Suffix List. Both are as true of `podster.site`. So a page there can't read or set a `podster.dev` cookie, sibling hosts share cookies set for the whole domain, and the sandbox closes that at the cost of an app's storage.
- **Owed before anything is served on `podster.site`:** a short rerun of spike C's header and cookie checks there, to confirm it. Not run.
- **Spikes A and E don't depend on the domain's name.** Spike A used a `workers.dev` address, and spike E read from GitHub.
- **The wildcard certificate and route are per zone,** so "one certificate naming only the wildcard and the apex" is to be seen again on `podster.site` in that rerun.

**One real difference: `.dev` forces HTTPS in every browser, and `.site` doesn't.** `.dev` is on browsers' HSTS preload list as a whole top-level domain, so no browser ever makes a plain-HTTP request to a name under it. `.site` isn't. So, **proposed:**

- **The content Worker sends `Strict-Transport-Security` on every response,** with a lifetime of a year and `includeSubDomains`.
- **The zone redirects HTTP to HTTPS,** which is a zone setting and so the owner's to switch on.
- **A first plain-HTTP request is still possible,** from a visitor whose browser has never seen that header for the host: a typed address or an `http://` link. Someone on the network path can answer it in the app's place. The redirect and the header shorten that to the first visit; only preloading removes it.
- **Open:** whether to ask for `podster.site` to be HSTS-preloaded. It would need the header on the apex with `includeSubDomains` and `preload`, is slow to undo, and commits every future name under `podster.site` to HTTPS. Not decided.

**The name carries Podster's own. A note for the owner, not a decision.** `opster.dev` was one letter from `podster.dev`. `podster.site` says "Podster" outright, so whatever an agent wrote and a room published is served under Podster's brand, on a site a visitor will take for Podster's. That is the owner's choice. What follows from it:

- **Takedown speed and the report route matter more:** a bad page reads as Podster's own while it is up.
- **A page should say plainly whose it is.** Proposed for the public surfaces Podster controls, the room's page and the release panel: that an app is a room's work and not Podster's. The content Worker serves a room's files as they are and adds nothing visible to them, so this is said beside the link, not on the app.
- **An app imitating Podster's sign-in is more convincing here,** which the [threat model](../m6-plan.md#threat-model) lists. The label stays random and never holds a room's or Podster's name; the domain now does.

**How HTML paths are served. Seen in spike A, and proposed as it was seen.** With the platform's default handling, `/index.html` answered 307 to `/`, and `page.html` was served at `/page`. A release is uploaded with that default, the only handling tried. The content Worker passes on a redirect whose `Location` is a path on the same host and no other ([below](#what-content-can-reach)). Two files that would be served at one address fail the release ([what a release may contain](#the-release-job)). Uploading with `html_handling: "none"` wasn't tried and is open.

#### Script names

**Proposed, as ruled on 2026-11-12.** Cloudflare showed no rule in the names spike A tried: lengths from 63 to 4,096 characters, upper case, `_`, `--`, a trailing `-`, `.`, `~`, `:` and `+` were each accepted and served, and names are case-sensitive. `/`, `%`, a space and anything outside ASCII weren't tried. So the rule is Podster's own, and stays inside what was tried:

- **A script's name is the label, one `.`, and the release's ID.** The separator is `.`, which was among the characters tried.
- **A label is lower-case letters and digits only, and at most 26 characters.**
- **A release's ID has the form every Podster ID has:** a prefix of three lower-case letters, one `_`, and 32 lower-case hexadecimal characters, 36 characters in all.
- **So `.` appears in neither part,** and the one `.` in a name ends the label. The `_` is the ID's own and separates nothing.
- **The whole name is lower-case letters, digits, one `_` and one `.`, and at most 63 characters,** the shortest length tried: 26 for the label, 1 for the separator and 36 for the ID. Rust refuses to make a name that is longer, or a label over 26.
- *As first written in this revision the separator was `_`, which the ID also holds; the review of 2026-11-12 caught it.*
- **Rust makes the name and nothing else does.** A script whose name doesn't fit the rule wasn't made by Podster. The hourly reconcile reports it to operators and leaves it alone ([below](#publishing-and-unpublishing-in-order)).

**The content Worker routes and never authorizes.** It holds no binding to the gateway, the API, D1 or R2, and no secret. It reads one Workers KV namespace that only the private API writes.

**Ruled: serving is allow-listed.** The content Worker serves a host only when a **serve entry** exists for that exact host. The entry names the one script to serve, which is one release's. No entry, an entry it can't read, or an error from KV all answer not-found: it fails closed. There is no deny list, so nothing depends on an entry being present to stop an app.

- **One KV read a request:** the serve entry for the request's host. A default host and a custom hostname each have their own.
- **One more key, the stop,** makes the content Worker refuse every host. It is read at most once every 30 seconds by each running copy of the Worker and kept in memory between, so it isn't a second read on each request. **If it can't be read, the Worker refuses every host:** an error on the stop fails closed, as an error on a serve entry does.
- **An upload is never reachable until a serve entry is switched to it,** and that happens only after the room has committed that release as live. Uploading a second release doesn't touch what the first is serving, because it is a different script.
- **Nothing but the room's own applier writes or removes a serve entry** ([below](#publishing-and-unpublishing-in-order)).
- **Each entry is something Rust decided.** A stale entry can keep serving a release for a while after the room stopped it; it can't serve anything the room never made live, and a missing one serves nothing.

### What content can reach

**Proposed.**

- **The application.** Nothing. The content domain is another registrable domain, so a page there can't read or set a `podster.dev` cookie. Podster sets no cookie on any content host and accepts no credential there: a request carrying a Podster cookie or an `Authorization` header gets exactly what one without gets. **Seen in spike C,** in Playwright's Chromium, Firefox and WebKit, headless: a `podster.dev` cookie in the browser's jar wasn't visible or sent on a host of `opster.dev`, a script there setting one for `podster.dev` was silently ignored, and a request carrying a Podster-looking cookie and an `Authorization` header got the same answer as one without. Branded and mobile browsers weren't run.
- **Podster's data.** Nothing. A user Worker has no bindings, and the content Worker has none to Podster's data.
- **Another room's app.** Its pages, as any site can. Its cookies set for the whole content domain, **unless the domain is on the Public Suffix List and browsers have shipped that, or every app is sandboxed.** **Seen in spike C,** in the same three browsers: a cookie one host's script set for `opster.dev` was read, sent and overwritten on a sibling host; `localStorage` stayed per host; and a sandboxing Content Security Policy closed it, at the cost of all of an app's own storage. **Whether apps are sandboxed is the owner's, and it isn't decided here:** [the sandbox](#the-sandbox-an-open-choice-for-the-owner). The architecture says the domain "must be on" the list. Whether anything may be served before it is, is the **owner's** ([M6 plan](../m6-plan.md#for-the-owner)); the first draft had the architect decide it, and that decision is withdrawn. The list's maintainers say they generally decline small projects and experimental or short-term entries ([publicsuffix.org](https://publicsuffix.org/submit/)), so the entry may be refused.
- **The network, from the server.** Nothing, because no agent-written code runs there. If the owner allows server code, Cloudflare's documentation offers an outbound Worker that is invoked on every `fetch()` a user Worker makes and that stops it opening TCP sockets with `connect()`, but that doesn't intercept requests made from Durable Objects or through mTLS certificate bindings ([outbound Workers](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/)). That isn't designed here. **Seen in spike A,** for a script uploaded to try it, which no release can hold: with no outbound Worker its `fetch()` reached the public internet and so did a TCP socket to a host not behind Cloudflare; with an outbound Worker every `fetch()` went to that Worker, which blocked, answered or passed each one, and sockets stopped working. A release is assets only, so nothing of an app's runs and no outbound Worker is added. This is recorded for the day scripts are ever allowed.
- **The visitor's browser.** Whatever a web page can, inside what [the sandbox choice](#the-sandbox-an-open-choice-for-the-owner) leaves it. The content Worker refuses any request but `GET` and `HEAD`, and refuses a request for a service-worker script. **Seen in spike C:** answering 403 to a request carrying `Service-Worker: script` stopped registration in all three browsers, and on a host that allowed it a service worker registered in all three. So refusing the script is the control that keeps an app from running on in a browser after it is unpublished.

**Response headers are an allow-list. Ruled on 2026-11-12, after spikes A and C.** The content Worker builds each response's headers itself. This ADR had it set its own headers over the app's; **seen in both spikes,** a header it didn't name reached the visitor.

- **From the app's response it passes only these:** `Content-Type`, `Content-Length`, `ETag` and `Last-Modified`. And `Location`, on a 3xx only, when its value is a path on the same host; a 3xx with any other `Location` is answered not-found.
- **Everything else is dropped. `Set-Cookie` never passes,** whatever its attributes, and neither does an app's `Clear-Site-Data`, `Content-Security-Policy`, `Cache-Control` or `Access-Control-*`.
- **It then sets its own:** `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Strict-Transport-Security` with a lifetime of a year and `includeSubDomains` (added on 2026-11-12 with the move to `podster.site`, [above](#the-content-domains-name)), and `Cache-Control` with a lifetime of 60 seconds and `no-transform`. The sandbox's headers are set here too, on every response: the owner chose the sandbox on 2026-11-12 ([decision 216](../spec/PRODUCT.md#decisions-needed)).
- **Why `no-transform`. Seen in spike C:** Cloudflare injected its Web Analytics beacon, a third-party script, into every app's HTML on `opster.dev` when the request accepted `text/html`, and didn't when the response's `Cache-Control` carried `no-transform`. **Open:** whether the beacon can be switched off for the zone, which would be the owner's setting and wasn't looked at.

**Without the Public Suffix List entry, the whole content domain shares one reputation.** Browsers' and mail providers' blocklists, and Safe Browsing, treat hosts under one registrable domain together unless the list says otherwise. So one room's phishing page can get every room's app flagged or blocked. M6's answers are: a release only of reviewed, merged code that a person approved, in a public room; a report route that can name an app; an operator's suspension and a domain-wide stop, [built before anything is served](#takedown-and-how-fast-it-is); and per-room hosts with random labels, so a block of one host is at least possible. None of those prevents it. It is a **consequence** the owner accepts with the content domain.

**`_headers` and `_redirects`. Ruled on 2026-11-12, after spike A.** Cloudflare's static assets apply header and redirect rules to static asset responses: up to 100 header rules, and 2,000 static plus 100 dynamic redirects ([headers](https://developers.cloudflare.com/workers/static-assets/headers/), [redirects](https://developers.cloudflare.com/workers/static-assets/redirects/)). This ADR said the platform reads both files from the uploaded directory. **Seen in spike A, that isn't how the rules arrive:** wrangler leaves both files out of the upload and sends their text in the script's metadata, as `assets.config._headers` and `assets.config._redirects`. Sent that way every rule applied: a header, a `Set-Cookie`, a Content Security Policy, a one-year cache lifetime and a 302 to another site. A `_headers` file deeper in the directory was served as an ordinary file and set nothing.

- **The control: the release job sends no `assets.config` at all,** so neither `assets.config._headers` nor `assets.config._redirects`. It writes the script's metadata itself and takes none of it from the repository. With none sent, a file of either name was an ordinary file to the platform, **seen only for a `_headers` file deeper in the directory.**
- **Not shown:** a `_headers` or `_redirects` file at the directory's root, sent as a plain file. Wrangler never sends one, so the spike couldn't. Until a test of the job's own upload shows it comes back as content and sets nothing, **the job goes on refusing a release that holds either name,** as a second guard. That test is owed with the release job, and **it bypasses the refusal on purpose:** it uploads such a file directly, as the job's upload would, since a release can't carry one.
- **The content Worker's allow-list is the third guard,** and holds whatever the platform does.

### The sandbox: an open choice for the owner

**Decided by the owner on 2026-11-12: (a), every app is sandboxed in M6** ([decision 216](../spec/PRODUCT.md#decisions-needed)). The architect put it as "Sandbox every app for M6. Apps lose their own browser storage but can't read each other's cookies. I recommend yes", and the owner answered "1. confirm". The content Worker, built in step 4(b), sets the sandboxing `Content-Security-Policy` on every response. The cost is as below: a sandboxed app has no cookies, `localStorage`, IndexedDB or other browser storage of its own. *Until then this section said: not decided, the owner's.* It was a product choice: what an app may do in a browser, against whether rooms' apps are kept apart before the Public Suffix List entry exists.

**What spike C saw,** in Playwright's Chromium, Firefox and WebKit, headless, with one pair of sibling hosts:

- **Without a sandbox,** one host's script set a cookie for `opster.dev`, and a sibling host read it, was sent it and overwrote it. `localStorage` stayed per host.
- **With `Content-Security-Policy: sandbox` and no `allow-same-origin`,** the page's origin is `null`, and `document.cookie`, `localStorage`, the Cache API and service-worker registration are each refused with `SecurityError`. `sessionStorage` and IndexedDB were refused too.
- **An ordinary static app still ran sandboxed,** its module script, `fetch`, CSS, image and `history`, only once the policy named the app's own host in place of `'self'` and each answer carried `Access-Control-Allow-Origin: *`. A sandboxed page is cross-origin to its own host, and WebKit matched `'self'` to nothing.
- **Not seen:** branded or mobile browsers; forms, downloads, popups, fonts and frames under the sandbox; and whether a sandboxed page's own `fetch` sends the domain's cookies.

**The options, and what each costs:**

| | Rooms' apps kept apart | What an app loses | What is left open |
| --- | --- | --- | --- |
| **(a) Sandbox every app** | Now, by a header the content Worker sets, without the list's entry | All of its own storage: cookies, `localStorage`, `sessionStorage`, IndexedDB, the Cache API and service workers. An app that remembers anything in the browser doesn't work | Whatever else the sandbox breaks, which was tried only for one plain app's seven steps |
| **(b) No sandbox until the domain is on the Public Suffix List** | Not until the entry is accepted and browsers ship it, and the maintainers may refuse | Nothing | Rooms' apps can interfere through cookies set for the whole domain. The content Worker drops every `Set-Cookie`, so no response sets one; **that doesn't stop a script,** which sets a domain cookie with `document.cookie`, and nothing at the server can see or stop that. One room's app can then read, overwrite or fill another's domain cookies |
| **(c) Sandbox by default, with an opt-out the room's owner sets** | For rooms that keep the default | Nothing, for a room that opts out | A room that opts out can set domain cookies that every unsandboxed app receives, and overwrite theirs. The sandboxed rooms are still protected. It adds a setting, its policy and its tests, and the opt-out is a person's promise about code an agent wrote |

**The architect recommended (a) for M6, and the owner chose it.** The reasons:

- **It is the only option that keeps rooms apart with what Podster controls today.** The list's entry isn't Podster's to grant, and its maintainers say they generally decline small projects.
- **It fails safe.** An app that needs storage visibly doesn't work, and the owner can see that. Under (b) the failure is silent, and it is another room's.
- **It can be loosened later and can't easily be tightened.** Moving from (a) to (c) or (b) gives apps something. Moving the other way breaks apps that already rely on storage.
- **M6's apps are static files in public rooms.** The first ones are likely to be pages and small tools, which lose least.
- **The cost is real, and the owner should weigh it:** "a working web application" that can't keep a preference or a draft in the browser is narrower again than [decision 214](../spec/PRODUCT.md#decisions-needed) already made it.

**Under every option** the content Worker's allow-list, the refusal of service-worker scripts and the absence of any Podster cookie or credential on the content domain stand. They protect the application. The choice here is only about rooms' apps and each other.

**Until the owner answers, nothing is served to a real person,** which the owner's table already says of the Public Suffix List question. The spikes' own test apps aren't affected.

### The release job

**Proposed**, with both reviews' changes. An outbox job in the room's Durable Object, the only thing that holds the credentials that publish.

1. **Rerun policy and recheck authority, on every pass,** in the room's transaction, against current state. This is M5's security review finding A-3, applied here from the start: a job that passed once doesn't keep its permission. Each pass asks again:
   - that the deployment's own configuration still allows release at all, and the stop for the whole content domain isn't set;
   - that an operator hasn't taken the ability to release from the room's organization;
   - that the room is public, not archived, and its public surface and its app aren't suspended;
   - that the room's repository is still ready;
   - that release is switched on in the room, and the `release_config` version is the one the release was asked under;
   - that the requester may still release now: in the room, not revoked, their deployment grant live and its giver still holding authority; for an agent, its connection, and the person who linked it still in the organization;
   - that the approver may still approve now, by the same tests;
   - that the room still requires a person as reviewer, where the release's task was reviewed under that;
   - that the commit is still one Podster's merge confirmed on the default branch;
   - **that the room's release epoch is the one this release started under** ([below](#publishing-and-unpublishing-in-order)).
   Any of them failing ends the release as failed, with that reason's code, before any call to GitHub or Cloudflare (AC-13).
2. **Read the tree** of the release directory from GitHub at that exact commit, with a token for that one repository, in two reads ([how the tree is read](#how-the-tree-is-read)).
3. **Check it,** from the tree alone, before any file is fetched: the paths, the count and the sizes.
4. **Fetch the files and upload** them to the namespace, as this release's own script. Nothing serves it yet: no serve entry names it, and whatever the room was already serving goes on being served untouched.
5. **Return to the room.** In one transaction the room reruns the whole of step 1, the epoch included, and only then commits the release as `live` and sets what each of its hosts should serve to this release's script. If anything fails, the job deletes this release's own script, and only that, and the release ends failed with the reason. An earlier release that was live stays live.
6. **Wait for the room's applier to switch the serve entries,** then fetch this release's marker through the host, for at most 30 seconds. **That figure is provisional.** It comes from spike A, where a new script showed within 2.5 seconds of the API's answer in twelve tries from one machine. But the wait also spans the switch of a serve entry, and KV's documented delay for a change to be seen elsewhere is up to 60 seconds or more. **So 30 seconds may fail a release falsely** until spike G measures the switch and sets the figure. A false failure only sets back: the release ends failed and its script is deleted, under the condition below, and it never publishes anything. If the marker comes back as this release's, the release is recorded as being served, and the script of the release before the previous one is deleted. **If it doesn't, the release fails, and the set-back is a room transaction with a condition:** the room puts its hosts back to the script they served before only if its release epoch and the desired serve state's version are still exactly what step 5 wrote. If either has moved, something else has spoken since, an unpublish most likely, and the desired state is left as it is: at nothing, after an unpublish. Either way this release's script is deleted. A release is never left recorded as live while its host answers not-found (UI-02), and a failed check never brings back what an unpublish took down.

**What a release may contain. Proposed.** Decided in `crates/core` from the tree:

- **Paths. Proposed, from what spike E saw can exist in a repository.** A path passes only if all of these hold, and one that doesn't fails the release:
  - at most 1,024 bytes in all and 255 a segment, and no empty segment;
  - no segment that is `.` or `..`. GitHub refused to store either; the rule costs nothing and stays;
  - **no control character,** which covers tab and newline, and **no backslash.** Each was seen in a stored path;
  - **no U+FFFD.** This ADR said "valid UTF-8", which can't be checked from the tree: a name that isn't UTF-8 arrives with U+FFFD in place of the bad byte, and the tree's JSON can't show which byte it was;
  - **already in Unicode's composed form (NFC),** and **no two paths the same after case folding.** The same name composed and decomposed was seen as two entries, and so were two names differing only by case;
  - **no segment that begins or ends with a space.** Seen stored; refused because browsers and tools disagree about such names;
  - **no two paths served at one address** under [the platform's HTML handling](#where-content-is-served): `page.html` beside `page/index.html`, for one.
- **What a path may hold:** a space inside a segment, a leading dot or dash, `?`, `#`, `%`, `&` and letters outside ASCII were each seen stored and come back as written. They pass, for now: none was uploaded to or served by Cloudflare ([open item 21](#what-stays-open-for-the-spikes)).
- **Refused by name, anywhere in the directory:** `_headers`, `_redirects`, `_worker.js`, `_routes.json`, and anything at the marker's path below. A repository can't supply the file the job uses to confirm itself.
- **Refused by kind:** a tree entry with mode `120000`, a symlink, or `160000`, a submodule (GitHub's [trees](https://docs.github.com/en/rest/git/trees) page lists the modes). Nothing the repository controls is followed. **Which modes pass:** `100644` and `100755` for a file, and `040000` for a directory; anything else fails the release. An executable file is published as an ordinary one. **Seen in spike E:** a symlink is `type blob` whose content is its target's path, `../../../../etc/passwd` for one; a submodule is `type commit` with no size.
- **A truncated tree fails the release, and the job doesn't rely on GitHub to say so.** This ADR said GitHub marks a recursive tree `truncated` past 100,000 entries or 7 MB, from its documentation. **Seen in spike E, at two path lengths only:** a tree of 72,060 entries came back whole in 17.7 MB; truncation came at 96,643 entries and 23.7 MB with 14-byte paths, and at 80,653 entries and 21.0 MB with 29-byte paths; and a truncated answer was a `200` that stopped mid-directory. Where truncation starts for other path lengths isn't known. **So the job caps a tree answer itself, before parsing it: at most 1 MB of bytes for either tree answer, and at most 1,000 entries of every kind in the directory's tree,** directories and empty ones included, which the file count doesn't see. Both figures are **proposed**: 300 files with 1,024-byte paths are under 400 KB of JSON. Past either, or on `truncated`, the release fails. The job never publishes part of a directory.
- **Sizes come from the tree.** A file's entry carries its `size`. **Seen in spike E:** exact for every file, 5 MiB and 5 MiB and one byte included. The job applies the caps before fetching anything. **A file's entry with no size fails the release.** A directory's entry and a submodule's never carry one, and that is normal: this ADR said "an entry with no size", which would have failed every release with a subdirectory.
- **One file is at most 5 MB,** and a release 25 MB in all. A Worker has little memory. So each file is fetched by itself, as raw bytes with `Accept: application/vnd.github.raw+json`, held only until its batch is uploaded, and then dropped. A file over 5 MB is refused from the tree's size, before it is fetched. **Seen in spike E:** the raw answer is exactly the file's bytes at every size tried, 0 bytes to 99 MiB; as JSON a file is 1.378 times its size, not four thirds, since the base64 has an escaped line break every 60 characters. GitHub itself answered a 25 MiB file as JSON, so this ADR's "which a 25 MB file wouldn't fit" was about the Worker, not GitHub. Whether 5 MB and a batch fit a Worker's memory is still a **spike**, G's: spike E's reads ran in Node on a laptop.
- **Each fetched file is checked against the tree:** its length against the tree's size, and its git blob sha against the tree's sha. **Seen in spike E:** all 300 files of a 300-file directory, fetched raw, hashed to the shas the tree gave.
- **GitHub's `Content-Type` for a raw blob is never passed on or stored.** It is GitHub's guess: `text/plain; charset=utf-16be` for one file of patterned bytes.
- **The job reads no configuration** from the repository beyond the fixed directory name. Agent content is data.

#### How the tree is read

**Ruled on 2026-11-12, after spike E.** This ADR said only "read the tree of the release directory at that exact commit".

1. **Read the commit's top tree,** by the commit's sha, not recursive.
2. **Require the release directory's entry there to be `mode 040000`, `type tree`.** Anything else fails the release.
3. **Read that entry's own sha with `recursive=1`.**

**Never `GET /git/trees/{commit}:{path}`.** **Seen in spike E:** for a submodule entry whose commit is in the same repository, that form answered `200` with the other commit's tree, a commit nobody reviewed or confirmed.

**Why trees and blobs.** GitHub's Contents listing stops at 1,000 files for a directory; a blob is supported up to 100 MB ([contents](https://docs.github.com/en/rest/repos/contents), [blobs](https://docs.github.com/en/rest/git/blobs)). **Seen in spike E:** the Contents API listed 1,000 of a directory's 1,200 files with status `200` and nothing to say the rest were missing, and asked for a symlink inside the repository it answered with the target's content. Trees and blobs follow nothing.

**The reads, sized against GitHub's limit.** A release of *n* files costs two tree reads and *n* blob reads. **Seen in spike E:** a 300-file release read with one tree read cost 301 requests, and the installation's count rose by exactly 301; read in the two steps above it is 302, which wasn't itself counted in a run. An installation's token gets 5,000 requests an hour, shared by every room that App serves, rising by 50 for each repository past 20 up to 12,500; no more than 100 at once, and 900 points a minute for one endpoint ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)). So:

- **A release is capped at 300 files,** and that stays: 301 requests as measured, 302 as the job reads, about 6% of an installation's 5,000 an hour. **That 5,000 is one count for the whole installation, shared with everything else it does.** Seen in spike E: `x-ratelimit-limit: 5000`, and five tokens of one App with different repositories and permissions each moved the same count.
- **The release App's reads are budgeted across the deployment:** at most 3,000 an hour, which is nine full-size releases, not the ten this ADR said, leaving the rest as headroom. Past it a release waits and says so. This is the first cap in Podster that adds rooms up. **Podster counts its own reads.** GitHub's header is a check on that count and not the count: seen in spike E, a `304` to `If-None-Match` cost nothing, and a token's first requests after it was minted reported a different count that the spike couldn't explain.
- **Files are fetched ten at a time,** well under both secondary limits. Seen in spike E: 300 files ten at a time took 9.2 seconds, every answer `200` with no `retry-after`. No secondary limit was hit, and none was provoked.

**The App's permissions: Contents `read` and Metadata `read`, and nothing else.** Contents `read` is what GitHub's [permissions table](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps) lists for reading content, a tree and a blob. **Seen in spike E,** with the staging agent App's token cut down when minted, since no fourth App exists: a token asked for Contents `read` came back with Metadata `read` added by GitHub; it read the commit, both trees and blobs, and was refused, `403`, making a blob, making a branch and reading the Actions setting. **On a public repository the token isn't what confines the job.** A token with Metadata `read` alone, and a request with no credential, read the same tree and blob, and the token limited to one repository read another public repository's tree. Managed repositories are public, so **what keeps the job to one repository and one directory is the job's own requests,** built in Rust from the room's state. What the token gives is the installation's request allowance and no write. A private repository wasn't read at all.

**The marker.** Whether an upload's manifest can be read back through Cloudflare's API: **not found**, and spike A read back no script's files. So the job adds one file of its own to every release, at `/.well-known/podster-release.json`, holding the release's ID and commit. Fetching it through the host is how step 6 knows which release is being served. Seen in spike A: a path under `.well-known` was uploaded and served.

**The manifest's hashes. Proposed, after spike A.** Seen there: a manifest's hash is 32 hexadecimal characters, and it comes back to visitors as the file's `ETag`, which a browser's revalidation rests on. So the job derives each hash from the file's bytes and its served type together, as the first 32 hexadecimal characters of a SHA-256, so that it changes whenever what is served changes. GitHub's blob sha alone wouldn't cover the type. The hash is public. **Not seen:** whether Cloudflare checks a hash against the bytes; wrangler computed the hashes in the spike. **Every release sends every file:** seen in spikes A and C, files already sent for one script were asked for again under another name.

### Publishing and unpublishing, in order

**Ruled**, on the second and third reviews' blockers. Three things went wrong in earlier drafts, and each is closed here.

- *A release could go live after its room was unpublished:* it passed its recheck, the room went private while files were fetched, the unpublish found nothing to delete, and the upload then landed and was recorded live.
- *A second release overwrote the first before the room had committed it:* both used one script name, so the upload was served at once, and a failed commit deleted the live app.
- *A serve entry could be written after it was removed:* an unpublish found no entry yet, then the release job wrote one; or a write whose answer was lost landed after a removal. KV has no way to write only if nothing changed.

**The room holds a release epoch,** a number that only goes up. Every unpublish trigger raises it, in the same room transaction that records the trigger. A release remembers the epoch it started under, and step 5 compares it inside the room's transaction, beside the whole policy. A release that started before a trigger can never be committed live after it.

**One script for each release.** An upload is a new script that nothing points at. **A second reason for never replacing a script in place, seen in spike A:** replacing a script in place once left the old files served for 74 seconds after the API said the replace was done. That happened once in twelve rounds, and spike C's replaces all showed within about 2 seconds; why isn't known. A release's new script becomes reachable only by a switch of the serve entry, and a failed release deletes only its own script.

**The room is the only source of what each of its hosts should serve.** For each host, the default one and a custom hostname alike, the room keeps a **desired serve state:** one script, or nothing, with a version that goes up on every change. It changes only inside room transactions:

- the commit of a release as live sets it to that release's script;
- every unpublish trigger sets it to nothing, in the trigger's own transaction;
- a rollback sets it to the earlier script, after the room has checked that script still exists;
- a release whose marker never came back sets it back to what it was, **only if the epoch and the version are still exactly what that release's own commit wrote** ([the release job](#the-release-job), step 6).

Those four are every writer. Each is a room transaction, and each but the unpublish is conditional on the epoch.

**The room runs its release, unpublish and script-delete jobs one at a time, in the order it committed them.** The applier isn't one of them: it is woken by the room's alarm and never waits behind a job. So a release job in the middle of fetching files delays the next job, and never a takedown.

**One applier for each room makes KV match that state, and nothing else touches a serve entry.** Not the release job, not a command's handler, not an operator's route. The room starts its applier itself, from its alarm, whenever the desired state changes. For each host the applier:

1. reads the desired state and its version from the room;
2. writes the serve entry, or deletes it;
3. reads the entry back from KV;
4. asks the room for the version again. If it moved, it starts over.

**One applier runs for a room at a time: that is the intent,** and the room's alarm gives it. If it were ever broken, two appliers would each write the room's last word as they read it, and the later write wins; a wrong entry left by that, or by a write whose answer was lost and that landed late, is put right by the 5-minute reconcile. **So the bound on a late or wrong entry is the reconcile, about seven minutes with KV's delay,** not the applier's next pass, which may never come if nothing else changes. *Corrected on 2026-11-12, from the review of the PR that built the reconciles: **as built, this bound holds only while the serve entries' namespace has 50 keys or fewer.** A pass reads one page of 50 keys, so with N keys an entry is looked at every ⌈N/50⌉ × 5 minutes: 10 minutes at 100, an hour at 600. [The plan](../m6-plan.md#what-step-4as-third-pr-built) states the bound and the fix owed before a provider is configured. The sentence above is kept as first written.* Because the trigger's own transaction clears the desired state and wakes the applier, **a takedown doesn't wait behind a release job** that is busy fetching files.

**Two scheduled reconciles catch what the applier and the jobs missed:**

- **Every 5 minutes, serve entries against rooms.** For each entry, the room that owns the host is asked what it should serve now. **The reconcile never writes or removes an entry itself:** where one differs, it wakes that room's applier, which is still the only writer. For a custom hostname it asks two things, the room's desired state and the hostname's claim object, and both must agree before the entry may stand.
- **Every hour, scripts in the namespace against rooms.** **Ruled on 2026-11-12:** a script whose name fits [the rule](#script-names) and that no room claims is deleted. A script whose name doesn't fit the rule is reported to operators and left alone, since Podster didn't make it. **Seen in spike A:** one `GET` lists the namespace's scripts as objects with `id` and `tag`; the list's `has_assets` was wrong, so the reconcile trusts `id` and nothing else in it. How the list pages wasn't read, and is open. A script belongs to a room by its name, which begins with the room's label, and a label belongs to one room for ever. **A script of a release still in flight is left alone:** the room's own record says a release is uploading, and that exemption lasts at most an hour, after which a release that never finished is failed and its script deleted.
- **How a host finds its room:** a default host by its label, and a custom hostname by its claim object, which names the one room that holds it; a label finds its room through a lookup table in D1, which only routes the question. The room's current state gives the answer. A table that lags can make the reconcile ask the wrong room or no room; an entry or script whose room can't be found is reported to an operator and **never deleted on the table's word alone,** so a lagging projection can't take a live app down.

### Unpublishing

**Ruled.** Unpublishing means the app stops being served and its files are gone from Cloudflare.

**Each of these unpublishes a room's app.** In one room transaction it records the trigger, raises the release epoch, and sets every host's desired serve state to nothing:

- release switched off in the room;
- release switched off for the whole deployment, in Podster's own configuration;
- the room archived;
- the room deleted;
- the room made private;
- the room's organization deleted;
- the room's public surface suspended by an operator (M4);
- the app suspended by an operator;
- an operator taking the ability to release from the room's organization;
- **the room's repository stopped or lost:** an operator suspends it, it is found gone, or its link is no longer ready. The app comes down with the reason `repo_not_ready`. A release is a copy of that repository's reviewed work; with the repository stopped, nobody can say the copy should still be up;
- **Assumed, for the owner:** nobody who may release now remaining in the room. "May release now" is the test the job itself uses: a grant dies with its giver, so holding one isn't enough.

**Then:**

1. **The room's applier removes the serve entries,** as [above](#publishing-and-unpublishing-in-order). This is the fast part: from here no request is served, once KV has caught up.
2. **A job deletes the room's scripts** from the namespace, the live one and the one kept before it, and the custom hostname at Cloudflare if there is one. **The room forgets its kept scripts in the trigger's transaction,** so nothing can be rolled back to after an unpublish.
3. **Each delete is confirmed by Cloudflare's own answer for that script,** not by fetching the host. Fetching proves nothing here: with the serve entry gone the host answers not-found whether the files were deleted or not. A delete that failed or wasn't answered is retried. **What "gone" is. Ruled on 2026-11-12, from spike A.** A script is gone when Cloudflare gives one of exactly two answers:
   - **reading it answers `200` with `"script": null`;** or
   - **deleting it answers `404` with code `10007`.**

   A read never answers `404` for a deleted script, so a job that waited for one would never finish. Any other answer is not "gone", and the delete is retried. The reconciles use the same two answers.
4. **The reconciles** catch whatever is left.

**Suspension never restores.** Lifting an operator's suspension lets the room release again, by a new `deploy_release` and a new approval. Nothing that was deleted comes back, and nothing a late job left in the namespace can be served, since no serve entry names it.

The not-found answer carries `Clear-Site-Data`, **as a best effort and not a control.** Seen in spike C, the three browsers differed: all cleared the host's own cookie, `localStorage` and Cache API; WebKit left a service worker registered and serving; Firefox and WebKit kept a cookie set for `opster.dev`; and Chromium, in one run with one sibling host, also cleared the sibling's own cookies. So nothing in this ADR counts on it. What stops a service worker is that its script is refused. **Open:** whether the header should be narrowed or dropped, given what Chromium did to a sibling; under the sandbox no app has cookies to lose.

### Takedown, and how fast it is

**Ruled.** Podster hosts this content, so it must be able to stop it without the room's owner. **Suspension and the stop are built before the first step that serves content** ([the M6 plan's build order](../m6-plan.md#build-order)).

- **An operator suspends an app,** and lifts that. The room's owner can't release while it holds. Operators still read nothing private ([decision 205](../spec/PRODUCT.md#m6-decisions-november-12-2026)).
- **Suspension is keyed by the app's label and by each host,** never by a room's public handle. M5's security review (O-2) found Podster couldn't stop a repository because the only handle an operator had was the public one; an app must be stoppable by what a reporter actually has, which is its address.
- **An app's suspension is the room's state.** A label is never reused, so it lasts as long as the label means anything.
- **A custom hostname's suspension lives with that hostname's claim object,** not with any room. It outlives every claim, and while it holds, nobody can start a challenge or get a claim for that name. Only an operator lifts it. Otherwise a suspended name could be claimed again by the next room. **If the name has a live claim when it is suspended, serving on it ends at once:** the claim's object tells the room that holds it, by a message it keeps and sends again until the room has answered, and the room clears that host's desired serve state in its own transaction, and the claim ends as any claim does, its custom hostname deleted at Cloudflare. The room's app keeps its default host, unless the app itself is suspended too.
- **A stop for the whole content domain:** one key that makes the content Worker refuse every host. An operator sets it. It is for a compromise of the namespace or of a publishing credential, or a block of the whole domain.
- **A report can name a deployed app,** by its address.
- **Last resort, outside Podster's code:** the owner removes the content Worker's route, or the wildcard DNS record, in Cloudflare's dashboard.

**How fast, from the operator's command. Restated on 2026-11-12 after spike A. No time is promised here that wasn't seen.**

This ADR said "about two minutes", by arithmetic on documented numbers. That figure was never measured, and it stands only as the plan. What is known now, in the order things happen:

1. **The command's transaction clears the desired serve state and wakes the room's applier.** The applier runs from the room's alarm, not from the outbox behind other jobs. Its pass is a few calls. **Not measured.**
2. **The applier removes the serve entry. This is the fast part, and it is what stops serving.** **Not measured: spike G.** The planned figures are the documentation's: a KV change is usually visible at once where it was made and may take up to 60 seconds or more elsewhere, since each location caches what it read, a missing key included; the shortest cache lifetime a read may ask for is 30 seconds, which the content Worker asks for ([how KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/), [KV limits](https://developers.cloudflare.com/kv/platform/limits/)). "Or more" is Cloudflare's own wording.
3. **A response already sent** may be reused by a browser for its 60-second lifetime.
4. **The script's delete comes behind, and isn't the stop.** **Seen in spike A,** over twelve rounds from one machine, with files of a few bytes, measured from the API's answer: a delete showed at the host after 0.4 to 6.1 seconds, median 0.9, and **once the deleted file was served one more time after the first not-found.** An upload showed after 0.5 to 2.5 seconds, median 0.9. A replace showed after 0.6 to 74 seconds, median 0.9: **one replace served the old file for 74 seconds.**

**So what can be said:**

- **By the plan, an app stops being served within about two minutes of the command:** up to 60 seconds for the removal to be seen everywhere, then up to 60 for what a browser already held. That is unmeasured, and one of its numbers is "or more".
- **By what was seen, a change in the namespace usually shows in about a second and has taken 74.** Nothing seen is about a serve entry. Until spike G measures one, no figure for takedown is given to anyone outside this ADR, and M6-27's "stated time" is whatever spike G supports.
- **If the applier never ran,** the 5-minute reconcile removes the entry: about seven minutes at worst, by the planned figures. *Corrected on 2026-11-12: only while the namespace has 50 keys or fewer, as built. See [the note above](#publishing-and-unpublishing-in-order) and the plan.*
- **The stop for the whole domain** is slower by up to 30 seconds, the time each copy of the content Worker keeps it in memory.
- **The files themselves** are gone when the delete job has run and Cloudflare has given one of [the two answers that mean gone](#unpublishing), or at the hourly reconcile at the latest. Until then they sit in the namespace with nothing pointing at them. A script can be served once more after its delete, as seen, only if a serve entry still names it, which is why the entry goes first.
- **A visitor who already has a page open** keeps it until they reload. Service workers are refused, so nothing keeps running after that.

### Credentials

**Proposed** ([decision 198](../spec/PRODUCT.md#m6-decisions-november-12-2026)). Three secrets, all held by the private API Worker only: the release App's key and two Cloudflare tokens. The gateway, the web app and the content Worker hold none.

- **Reading from GitHub: a fourth App,** with Contents `read` and Metadata `read`, used by the release job alone. Its token is made for the one repository and never leaves the job: an installation token can be limited, when it is made, to named repositories and to a subset of the App's permissions, and lives an hour ([installation access tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)). A release borrows none of M5's three Apps. Creating the App is the **owner's**.
- **Publishing to Cloudflare: two API tokens, not one.**
  - **The scripts token** uploads, deletes and lists user Workers in the namespace. The only permission found for that is the account-level "Workers Scripts Edit" ([API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/), read in part). Nothing scoped to one namespace was found, and the permission the namespace's upload endpoint needs isn't stated on the pages read.
  - **The routing token** writes the KV namespace, and creates, reads and deletes custom hostnames on the content zone. Which zone permission custom hostnames need wasn't read; a **spike**.
  - **Why two:** the paths that only route, which are the serve entries, the stop and hostnames, then can't replace code. If Cloudflare can't separate them, which is a **spike**, there is one token and this section says so then.
- **So there is a second Cloudflare account,** holding the content domain, the namespace, the content Worker and the KV namespace, and nothing of Podster's own. On one account, a token that can write Workers scripts could replace Podster's own API Worker. **Decided by the owner's action on 2026-11-12** ([decision 217](../spec/PRODUCT.md#decisions-needed)): the owner created the second account and asked how to move `podster.site` to it. *Until then this was a working assumption.* `podster.site`'s registration, made with Cloudflare Registrar that day, can't move between accounts before 2026-11-22; it is added to the new account as pending.
- **Said plainly: in the second account the scripts token can replace the content Worker itself,** since the content Worker is a script in that account. Whoever holds it can serve anything on the content domain, serve entry or not. What limits the damage:
  - **It can't reach Podster.** The second account holds none of Podster's data, the content domain shares no cookie with `podster.dev`, and the content Worker holds no secret.
  - **It is held in one place,** the private API Worker's secret, and used only by the release and unpublish jobs and the reconcile.
  - **The reconcile checks the content Worker too:** it reads the content Worker's deployed version and compares it with the one Podster's deploy recorded. A difference raises an alarm for an operator. How that version is read is a **spike**.
  - **The last resort** needs no token: the owner's own dashboard login.
- **Who holds the second account's own credentials,** and how the content Worker is deployed to it, are the **owner's**: the move of `podster.site`, its wildcard record and HTTPS redirect there, Workers for Platforms on that account, and a deploy credential for the content Worker only.

A client never names an account, a namespace, a script or a host label. All four come from trusted configuration or are generated by the server.

### Authority, approval and triggers

**Ruled** ([decisions 199 and 200](../spec/PRODUCT.md#m6-decisions-november-12-2026)).

- **Who configures release, and who approves one. Decided on the owner's behalf** ([decision 215](../spec/PRODUCT.md#decisions-needed)): the room's owner and its admins, as people; an agent never. Everywhere this ADR says someone "may approve" or "configures", that is who it means. It matches what the owner decided for repositories in [decision 194](../spec/PRODUCT.md#decisions-needed). Until 2026-11-12 the interim rule here was the room's owner only.
- **Only in a public Engineering room** with a ready repository, and only where the deployment's own configuration allows release at all.
- **Who asks for a release:** someone who may release now, which means holding a `provider_grant` with a `deploy` action that is live and whose giver still holds authority. Approval of a task and a merge grant give nothing (AC-17). An agent may hold the grant and ask; an agent never approves.
- **The approval policy has one value in M6: `person`.** A person who may approve, approves each release. The first draft also had `on_merge`, under which a merge would start a release; with releases only in public rooms, where a person must approve, it could never publish anything, so it is dropped.
- **What starts a release:** a `deploy_release` command, then a person's approval. Never a merge, a webhook, or an observation of GitHub.
- **Decided in `crates/policy` then `crates/core`,** at the command, at the approval, and on every pass of the job.

### Rollback

**Proposed** ([decision 203](../spec/PRODUCT.md#m6-decisions-november-12-2026)), as the third review's first blocker shaped it.

- **A room keeps two scripts: the live release's and the one before it.** When a new release is confirmed as served, the script before the previous one is deleted.
- **Rolling back to the release before** is a switch. The room first checks, by Cloudflare's own answer, that the kept script still exists, which is its read answering `200` with a script object and not `"script": null` ([what "gone" is](#unpublishing)); then sets its hosts' desired serve state to it, and the applier switches the entries. No files are fetched or uploaded. If the script is gone, it is a new release of that commit, as below.
- **An unpublish forgets the kept scripts.** After one there is nothing to switch back to.
- **Rolling back further** is a new release of that earlier commit, uploaded again, since its script is gone.
- **Either way it is asked for and approved as any release is,** under the same policy and the same checks, and recorded as its own release. Nothing is rewritten.
- **A failed release leaves the earlier one serving.** There is no automatic rollback, because a failed release was never switched to.

### Custom domains

**Ruled** ([decisions 201 and 207](../spec/PRODUCT.md#m6-decisions-november-12-2026)). Cloudflare's validation alone isn't proof for Podster. The review showed two ways it fails:

- **Takeover.** Room A maps `app.example.com` and is later archived, with its DNS record still pointing at Podster. Room B asks for the same name, and Cloudflare validates it automatically, because the record is there.
- **Squatting.** If a claim is recorded before proof, any room can hold a name it doesn't control.

**So Podster has its own proof, bound to the room, and Rust decides all of it.**

0. **The name.** A hostname is normalized before anything else: lower case, a trailing dot removed, and international names turned into their ASCII form by IDNA. Two spellings of one name are one name. A wildcard name is refused.
1. **The challenge.** A room's owner asks to map a hostname. The room's command commits the request and a random value made for this request alone. The owner publishes it as a TXT record at `_podster-challenge.<hostname>`. The value names nothing readable, and is useless to any other room or any later request. The record may hold other values beside it; any one matching is enough, so two rooms proving at once don't overwrite each other.
2. **Pending holds nothing.** A pending request doesn't reserve the name: any number of rooms may be pending for one hostname, and none of them blocks another. A pending request expires after **72 hours**, and then it is gone.
3. **Proof.** A job resolves the TXT record and compares it, in Rust. Only when it matches does the job ask the hostname's own object for the claim.
4. **One hostname, one room.** A small Durable Object per normalized hostname holds at most one live claim, since a D1 row must never authorize. It gives the claim to the first room whose proof passed, and refuses any other while that claim lives. Asking again for the same room and request gets the same answer. The room then commits the claim or the refusal.
5. **Only then is the custom hostname created at Cloudflare,** which runs its own validation. Routing starts when the room holds the claim and Cloudflare reports the hostname `active`: only then does the room set that host's desired serve state, and its applier writes the entry. **Serving a custom hostname needs two things to agree: the room's desired state for it, and the claim object saying that room holds it.** The applier asks the claim object before it writes, and the reconcile checks both. **A custom hostname's entry is the room's like any other:** the same applier writes it, and each release switches it, because it names that release's script.
6. **A claim never transfers.** When a room's claim ends, for any reason, the room clears that host's desired serve state first, so its applier removes the entry; then the job deletes the custom hostname at Cloudflare, **reads until Cloudflare reports it gone,** and only then frees the claim. A later claim, by anyone, the same room included, needs a new challenge with a new value. A DNS record left pointing at Podster proves nothing.
7. **The challenge is rechecked on a schedule,** daily, and its two ways of failing are kept apart:
   - **A definite no:** the name's own authoritative servers answered, and the value isn't there. Two such answers in a row, at least 24 hours apart, end the claim. So a record that was removed can leave its hostname routed for up to about two days.
   - **No answer:** the resolver failed, or timed out, or couldn't reach the name's servers. That by itself never ends a claim quickly, since Podster's own trouble mustn't take a customer's domain down. But a claim with no successful proof for 7 days ends. So a name whose DNS has stopped answering can stay routed for up to 7 days.
   - A successful proof resets both.
8. **A claim ends** when the room unpublishes, removes the mapping, or fails the recheck; when Cloudflare reports the hostname `moved`; and when an operator suspends the hostname. In every case step 6 runs. A suspended name stays suspended after its claim is gone, and no room can challenge for it until an operator lifts that.

**Refused in `crates/core`:** `podster.dev`, the content domain, a subdomain of either, an IP address, a single-label name, a wildcard name, a public suffix itself, and a name an operator has suspended.

**What mapping a subdomain gives the app. A consequence, and Podster says it at mapping.** A room owner who maps `app.example.com` makes the room's app same-site with `example.com` and everything else under it. The app's scripts can then set cookies for `example.com`, and the browser sends that domain's same-site cookies along with requests the app starts. That is how the web treats any subdomain, and it is why the content domain itself is kept apart from `podster.dev`. Podster can't prevent it; the mapping screen tells the owner, in words, before they publish the record, and recommends a domain used for nothing else.

What Cloudflare's documentation adds:

- **Ownership is validated before traffic is proxied,** ahead of time by a TXT record or an HTTP token, or at the moment the customer adds their DNS record ([hostname validation](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/)).
- **Pre-validation isn't supported for a hostname whose zone is already on Cloudflare,** and its TXT record goes at `_cf-custom-hostname.<hostname>` ([pre-validation](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/pre-validation/)). A room owner whose own domain is on Cloudflare validates at the moment they point it, which the documentation says may cause some downtime. Podster's own challenge works either way, since it is only a TXT record.
- **A hostname whose DNS stops pointing at Podster** becomes `moved`, and is deleted after more than seven days in that state ([validation status](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/validation-status/)). Podster doesn't wait for that: it ends the claim.
- **A custom hostname that isn't removed keeps routing** to the service, and whether a delete takes effect at once: **not found** ([remove custom hostnames](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/remove-custom-hostnames/)). Hence step 6's read.
- **A Worker can be the origin** for every custom hostname with one route, `*/*`, and no route per hostname ([Workers as your fallback origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/)).
- **Whether issuing its certificate publishes the hostname** in certificate-transparency logs: **not found**. It is assumed to, as every publicly trusted certificate is.

**Resolving a TXT record from a Worker** means asking a resolver over HTTPS, through `crates/egress`. Which resolver, and what trusting it means, is a **spike**.

### Budgets and account limits

**Proposed** ([decision 202](../spec/PRODUCT.md#m6-decisions-november-12-2026)). Podster's own caps, inside the platform's:

| | Podster's cap | The limit it sits inside |
| --- | --- | --- |
| Apps a room | 1 | |
| Scripts a room | 2 kept, the live release's and the one before, and a third while one uploads | 1,000 scripts included in Workers for Platforms, then $0.02 each a month. So the included 1,000 cover about 330 rooms with an app, at three each; past that a room with an app costs up to $0.06 a month. Cloudflare's limits page says scripts are unlimited, which its pricing page contradicts |
| Files in a release | 300, which is 302 reads | 100,000 per Worker version on a paid plan; and GitHub's 5,000 reads an hour for the release App's installation, one count shared with everything that installation does |
| Size of a release | 25 MB in all, 5 MB a file | 25 MiB for one file; no total found; and a Worker's memory |
| Releases a room a day | 20 | Cloudflare's API allows 1,200 calls in five minutes for a token |
| The release App's reads, across the deployment | 3,000 an hour, nine full-size releases | GitHub's 5,000 an hour for an installation |
| Custom hostnames a room | 1 | 100 included, then $0.10 each, up to 50,000 |

- **What it costs,** from the pricing pages: Workers for Platforms is $25 a month, with 20 million requests and 60 million CPU milliseconds included, then $0.30 a million requests and $0.02 a million CPU milliseconds ([pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/pricing/)). Whether it needs Workers Paid first, and how many namespaces an account may have: **not found**.
- **Every request is probably billed.** Workers' own pricing says requests to static assets are free ([billing and limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)), but here every request first runs the content Worker, which is a dispatch Worker, and the Workers for Platforms pricing page charges one request for the chain and doesn't mention static assets. So assume each request to an app is one billed request and a little CPU time. A **spike** measures it. Spike A couldn't: its login can't read billing or analytics.
- **Each request reads KV once,** for its host's serve entry. Workers KV on a paid plan includes 10 million reads a month, then $0.50 a million ([KV pricing](https://developers.cloudflare.com/kv/platform/pricing/)). The 30-second cache makes most of those cheap; whether a cached read is billed is a **spike**.
- **Nothing here caps traffic.** A popular or attacked app draws requests Podster pays for. A per-room request cap isn't designed, and whether one is needed is the **owner's**, as money.

### Where state lives

**Proposed.** `release_config`, each `release`, the room's hostname request and its challenge, and the outbox jobs are the room's own state, in its Durable Object, through forward-only migrations. They are authority. D1 gets at most a projection for lists, which never authorizes. The room's release epoch, and what each of its hosts should serve, are room state too. A hostname's claim, and its suspension, are its own Durable Object. The KV namespace and the dispatch namespace are derived: Rust writes both, and either can be rebuilt from the rooms.

### Logs

**Proposed.** Every Worker logs IDs and reason codes only: no token, no file's content or path, no hostname. The content Worker logs nothing per request.

## Alternatives not taken

- **A customer's own Cloudflare account.** Later, with its own delegation design ([decision 11](../spec/PRODUCT.md#decisions-needed) recommends Podster's platform first).
- **Building in GitHub Actions.** It reverses ADR 0009's proposal that Actions stay off, runs agent-written code with a token in the repository, and needs its own decision.
- **A build service of Podster's.** Untrusted code on Podster's account.
- **Serving from R2 behind the content Worker,** with no Workers for Platforms. It would save the plan's price. Not proposed: the architecture names Workers for Platforms, a prefix in a bucket isn't an isolation boundary Cloudflare documents, and it has no path to server code later. It is the cheaper fallback if the owner declines, and would need this ADR's hosting section redone.
- **Downloading the repository's archive** in one request, to spare GitHub's rate limit. Not proposed: it fetches the whole repository before any size is known. Worth trying in the spike if 300 files proves too few.
- **The merge App's token, cut down to reading.** It puts the merge key in the release path.
- **A unique index in D1 for hostnames.** Simpler, and a read model would be authorizing.
- **Cloudflare's validation as the only proof of a hostname.** The review's takeover.
- **A Podster session on the content domain** to gate a private room's app. The separate domain exists to prevent it.
- **`on_merge`.** Dropped: with releases only in public rooms it could never publish.
- **A per-room certificate** for default hosts. It would publish every room's host.

## Consequences

- **Podster becomes a host of other parties' content,** with what that brings: abuse, takedown, and a bill that follows traffic. Cloudflare's terms for its developer platform make the customer solely responsible for what its end users do, and let Cloudflare block or remove content it deems illegal or harmful ([service-specific terms](https://www.cloudflare.com/service-specific-terms-developer-platform/)). Whether those terms allow this use is the **owner's** to read.
- **One bad app can get the whole content domain blocked,** while the Public Suffix List entry is missing.
- **New billed resources,** more than any earlier milestone: a domain, the Workers for Platforms plan, and a second account, decided on 2026-11-12, possibly with its own Workers Paid.
- **A fourth GitHub App and three secrets** to keep and rotate.
- **A new public Worker** that must never grow a binding to Podster's data. A test should fail if its configuration gains one.
- **A release is only what was committed,** and at most 300 files. An app that needs a build step must commit its built files. That is a real limit on "a working web application", and the owner's to accept.
- **Private rooms get no app** in M6.
- **Apps are served under Podster's name,** on `podster.site`, by the owner's choice. A visitor will take the domain for Podster's.
- **HTTPS isn't forced by the browser for `.site`** as it is for `.dev`, so a visitor's first request to a host can be plain HTTP unless the domain is preloaded.
- **An app has no storage in the browser** at all, because the owner chose the sandbox on 2026-11-12 ([the sandbox](#the-sandbox-an-open-choice-for-the-owner)). Without it, rooms' apps could interfere through domain cookies until the Public Suffix List entry ships.
- **Every release uploads all its files,** since one script's files don't serve another's.
- **An app can't set a response header or a redirect of its own,** and its HTML paths are served as the platform's default handling serves them.
- **An app's address changes** if it is unpublished and published again, because a label is never reused.
- **A custom domain needs a TXT record kept in place** for as long as it is mapped, and it makes the app same-site with the owner's parent domain.
- **A removed DNS record can leave a hostname routed for up to two days,** and one whose DNS has gone silent for up to seven.
- **Lifting a suspension doesn't bring an app back.** The room releases again.
- **Each room with an app holds up to three scripts,** which is what Workers for Platforms counts and charges for.
- **Files of an unpublished app can sit in Cloudflare, unreachable, for up to an hour** before the reconcile removes them, if the delete job failed.

## What stays open for the spikes

**As of 2026-11-12, spikes A, C, E and F have run and B, D and G haven't.** [The M6 plan](../m6-plan.md#the-spikes) says what each needs. Each item keeps its number, with where it stands.

1. Whether a user Worker in the namespace can reach anything of the account's without a binding. **Answered by spike A for what was tried:** no bindings, no cache, and no path to the account's other Workers by `fetch`. It reaches the public internet when it holds a script, which a release never does.
2. Whether a user Worker can be assets only, and whether it honours `_headers` and `_redirects`. **Answered by spike A:** yes; and only when the uploader sends their text as `assets.config`. **Still open:** a root file of either name sent as a plain file.
3. The narrowest tokens that can do each publishing job, whether scripts can be separated from KV and hostnames, and what each can touch. **Open: spike B,** which needs the owner to make tokens.
4. What a request to an app is billed as, and whether a cached KV read is billed. **Open.** Spike A couldn't read billing.
5. How long after a serve entry is written, switched or removed the host shows the new state. This is the takedown time, and it sets how long the marker's wait must be. What the applier's read-back means when KV can answer with a value up to a minute old: a mismatch there may be staleness and not a lost write. And whether the namespace's scripts and the KV namespace's keys can be listed, for the reconciles. **Scripts can be listed, by spike A; their paging is open. Everything about the serve entry is open: spike G.**
6. The custom-hostname flow end to end: that nothing routes before `active`, what a delete does and how soon, and what the room's owner must publish. **Open: spike D.**
7. Whether a custom hostname can be made to reach another room's app by a `Host` header or SNI. **Open: spike D.**
8. Whether a wildcard route and custom hostnames both reach one Worker on the content zone. **The wildcard half is answered by spike C;** custom hostnames are spike D's.
9. That Contents `read` alone reads a tree and its blobs at a commit; that tree entries carry sizes; what GitHub answers for a large directory. **Answered by spike E for one public repository.** A private repository wasn't read, so what a token without Contents `read` is refused isn't known.
10. Whether a sandboxing Content Security Policy closes the gap between rooms' apps without breaking ordinary static apps, and whether refusing service-worker scripts and `Clear-Site-Data` do what this ADR says. **Answered by spike C in three headless browsers:** it closes the gap and costs an app its storage, which is now [the owner's choice](#the-sandbox-an-open-choice-for-the-owner); refusing the script stops registration; `Clear-Site-Data` doesn't do the same in each browser.
11. Resolving a TXT record from a Worker, and which resolver. **Open: spike G.**
12. Reading the content Worker's deployed version, for the reconcile. **Open: spike G.**
13. Whether a 5 MB file and a batch of files fit a Worker's memory on the way from GitHub to Cloudflare. **Open: spike G.** Spikes A's and E's transfers ran on a laptop.

**Opened by the spikes:**

14. A root `_headers` or `_redirects` sent as a plain file by the job's own upload.
15. Whether Cloudflare checks a manifest's hash against the bytes, and whether the script's upload needs wrangler's two query parameters, `excludeScript=true` and `bindings_inherit=strict`. Every call in spikes A and C was wrangler's.
16. Whether Cloudflare's Web Analytics beacon can be switched off for the zone.
17. `html_handling: "none"`, and what the sandbox breaks beyond one plain app.
18. Timings from more than one place and for a release of 300 files or 25 MB, and why one replace took 74 seconds.
19. How the namespace's list of scripts pages.
20. Where GitHub's truncation starts for other path lengths, what its second request count is, and where its secondary limits start for these reads.
21. Path characters. `%`, `?`, `#`, a space inside a segment and letters outside ASCII were only seen stored by GitHub. None was uploaded to Cloudflare or served by it, so how the platform and the content Worker treat a file with such a name isn't known, and the path rule's "they pass" rests on GitHub alone.
22. From ADR 0009, and unanswered by spike F: whether a workflow file already in a repository runs with Actions off. No credential the spike was allowed could put one there. A person with write access pushing one workflow file to a test repository's branch, then reading the runs, is the whole test.
23. A short rerun of spike C's header and cookie checks on `podster.site`, owed before anything is served there. The results on `opster.dev` carry over by reasoning only.
24. Whether to ask for `podster.site` to be HSTS-preloaded, and that the zone's redirect from HTTP to HTTPS is on.

## What an independent review should attack

Four reviews have. What a fifth should look at:

- **The challenge.** Can a room get a live claim without controlling the name? Can two rooms end up routed for one hostname during a handover? Is the read-until-gone in step 6 really before the claim is freed?
- **The desired serve state and its applier.** Is there any write to a serve entry outside the applier? Any order of publish, unpublish, rollback and retry in which the room's state and what is served disagree for longer than KV takes plus one reconcile? Can two appliers for one room run at once?
- **One script a release.** Is there any path that deletes a script something still points at, or leaves the live one pointing at a deleted script?
- **The second account's token.** Is "it can't reach Podster" true? What does replacing the content Worker let an attacker do to visitors?
- **Every pass.** Is there any state the job's recheck misses that a command would refuse?
- **The unpublish triggers.** Is the list complete? What if a trigger's command commits and its job never runs?
- **The release job's reads.** Can a repository make it fetch outside the directory, exhaust memory, or publish half a tree? Do the path rules leave anything the platform treats specially?
- **A room that turns private or public around a release.**
- **Every "not found".** Each is a place where this ADR could be wrong about the platform.

## What the reviews changed

**The first review** read the first draft on 2026-11-12. Its two blockers and the required changes, and where each landed:

| The review said | Now |
| --- | --- |
| **Blocker:** Cloudflare's validation isn't proof; takeover and squatting | Podster's own room-bound TXT challenge, checked before a claim lives and before a hostname exists at Cloudflare; pending holds nothing and expires in 72 hours; a claim never transfers ([custom domains](#custom-domains)) |
| **Blocker:** visibility and policy | Only a public room releases, `release_needs_public_room` otherwise; `on_merge` dropped; the unpublish triggers listed, each rechecked ([only a public room releases](#only-a-public-room-releases), [unpublishing](#unpublishing)) |
| The job reruns policy on every pass (M5's A-3) | [The release job](#the-release-job), step 1 |
| Unpublish confirmed, retried, reconciled; takedown time in numbers | [Unpublishing](#unpublishing); [how fast](#takedown-and-how-fast-it-is): about two minutes in the documented case. The second review changed how it is confirmed |
| A domain-wide stop; suspension keyed by app and host (M5's O-2) | [Takedown](#takedown-and-how-fast-it-is) |
| Suspension and takedown built before anything is served | [The M6 plan's build order](../m6-plan.md#build-order) |
| The blocklisting consequence without the Public Suffix List | [What content can reach](#what-content-can-reach) |
| Every permission the publishing token needs; that it can replace the content Worker | [Credentials](#credentials) |
| Sizes from the tree; the marker's path refused; path rules; a label never reused; reads sized against GitHub's limit | [The release job](#the-release-job): 300 files, 3,000 reads an hour |
| Citations: pre-validation's own page; `_redirects`' limits; the dispatch Worker bills each request | [Custom domains](#custom-domains), [what content can reach](#what-content-can-reach), [budgets](#budgets-and-account-limits) |
| Decision 210 isn't the architect's | Withdrawn; the owner's |
| Decisions 199, 200, 204, 207 | 199 rewritten, `person` only; 200 and 204's owner-departure part put to the owner; 207 tightened |

**The second review** read that revision the same day. Its one blocker and its smaller changes:

| The review said | Now |
| --- | --- |
| **Blocker:** a release can go live after the room was unpublished; reading the host can't see a failed delete; the deny entry's lifetime is undefined | Serving is allow-listed, by a serve entry written only after the room commits live; a release epoch the room raises on every trigger and compares before committing live; the room orders its own jobs; a delete confirmed by Cloudflare's own answer; a reconcile that lists the namespace; suspension never restores ([publishing and unpublishing, in order](#publishing-and-unpublishing-in-order), [unpublishing](#unpublishing)) |
| A hostname's suspension outlives its claim | It lives with the hostname's claim object and blocks new challenges ([takedown](#takedown-and-how-fast-it-is)) |
| A definite no and a resolver error differ | Two definite noes 24 hours apart end a claim; errors alone only after 7 days; the stale window of each is stated ([custom domains](#custom-domains)) |
| The recheck list | Adds the organization's take-back, the stop, the deployment's configuration and the repository ([the release job](#the-release-job)) |
| Triggers | Adds the repository stopped or lost, with `repo_not_ready`, and the organization deleted; "may release now" ([unpublishing](#unpublishing)) |
| Takedown time from the command | Nothing waits for the outbox. It was the command's own handler; the third review moved it to the room's applier ([how fast](#takedown-and-how-fast-it-is)) |
| Hostnames | Normalized; wildcards refused; several TXT values allowed; the serve entry removed before Cloudflare's delete |
| A mapped subdomain is same-site with its parent | Recorded as a consequence, and said to the owner at mapping |
| A per-file cap that fits memory | 5 MB a file, fetched one at a time as raw bytes |
| Contradictions | Two Cloudflare tokens; Contents and Metadata read; one KV read a request; public-rooms-only labelled as holding until the owner answers |

**The third review** read that revision the same day. It found rulings on allow-listing, the epoch, unpublishing and suspension consistent across the ADR, the plan and the decisions, and two holes left in the order:

| The review said | Now |
| --- | --- |
| **Blocker:** a second release overwrites the live script before the room commits it, and its failure deletes the live app | One script for each release, named from the label and the release's ID; the serve entry names the exact script; a failed release deletes only its own; the live one and the one before are kept ([where content is served](#where-content-is-served), [rollback](#rollback)) |
| **Blocker:** the serve-entry write is unconditional, so it can land after a removal | The room keeps a desired serve state for each host, changed only in room transactions; one applier for each room, started by the room, is the only writer and rechecks the room's version after each write ([publishing and unpublishing, in order](#publishing-and-unpublishing-in-order)) |
| The reconcile's interval, and takedown time restated | Every 5 minutes for serve entries, hourly for scripts; about two minutes from the command, seven at worst if the applier never ran ([how fast](#takedown-and-how-fast-it-is)) |
| The reconcile and a release in flight; a failed marker fetch | In-flight scripts are exempt for at most an hour; a failed marker fetch fails the release and switches back |
| How a label finds its room | Through D1 as a lookup only; the room answers; nothing is deleted on a lagging table's word |
| Suspending a hostname with a live claim | Serving ends at once through the claim's room, and the claim ends ([takedown](#takedown-and-how-fast-it-is), [custom domains](#custom-domains) step 8) |
| The custom hostname's entry | Written by the same applier, and switched on each release |
| A read error on the stop | Fails closed |

**The fourth review** found one hole and asked for small changes:

| The review said | Now |
| --- | --- |
| **Blocker:** the failed-marker set-back was a fourth writer of desired serve state with no condition, and could bring a private room's earlier release back | It is a room transaction that applies only if the epoch and the version are exactly what the release's own commit wrote; it is listed with the other writers ([the release job](#the-release-job) step 6, [in order](#publishing-and-unpublishing-in-order)) |
| Jobs one at a time | Restored: release, unpublish and script-delete jobs run in the room's order; the applier isn't one of them |
| The bound on a late write | The 5-minute reconcile, about seven minutes with KV's delay |
| The reconcile and the applier | The reconcile wakes the applier and writes nothing; one applier at a time is the intent, and last-writer-wins converges within the reconcile's bound |
| Custom hosts | Serving needs the room's desired state and the claim object to agree; the suspension message is kept and sent again; a custom host finds its room by its claim |
| Script names | A separator that can't appear in a label |
| Rollback | The room checks the kept script exists; an unpublish forgets kept scripts; a missing script answers not-found |
| The deployment's own switch | An unpublish trigger, in the list, the recheck and M6-28 |

## What the spikes changed

**Revised on 2026-11-12, after spikes A, C, E and F.** Each row is one change to this ADR: what it said, what a spike saw, and what it says now. The spikes' own sections in the [M6 plan](../m6-plan.md#the-spikes) list every proposal; [the plan](../m6-plan.md#what-the-spikes-changed-in-adr-0010) says what became of each, the ones not applied included. No decision the owner made, and none of [decisions 213 to 215](../spec/PRODUCT.md#decisions-needed), is changed.

| This ADR said | A spike saw | It says now |
| --- | --- | --- |
| A deleted script is confirmed "by Cloudflare's own answer", without saying which | A: reading a deleted script answers `200` with `"script": null`; deleting it again answers `404`, code `10007` | Gone is exactly one of those two answers, never a `404` on a read ([unpublishing](#unpublishing), [rollback](#rollback)) |
| An app stops "within about two minutes", from documented numbers | A: an upload, a replace and a delete each showed with a median of 0.9 s; one replace served the old file for 74 s; one delete served the deleted file once more. Nothing about a serve entry was measured | The serve entry's removal is the fast part and unmeasured, spike G's; the script's delete comes behind; two minutes is the plan and not a promise ([how fast](#takedown-and-how-fast-it-is)) |
| The content Worker sets its headers "overriding anything else" | A and C: a header it didn't name reached the visitor | An allow-list: four named headers and a same-host `Location` pass, `Set-Cookie` never, then its own ([what content can reach](#what-content-can-reach)) |
| The platform reads `_headers` and `_redirects` from the uploaded directory, so the job refuses both files | A: the rules arrive only as `assets.config` in the script's metadata; a deeper `_headers` file was an ordinary file | The control is that the job sends no `assets.config` at all. A file of either name being ordinary was seen only deeper in the directory. The refusal by name stays as a second guard until a root file sent plain is tested |
| Nothing about Cloudflare changing an app's HTML | C: the zone's Web Analytics beacon was injected into HTML, and wasn't with `no-transform` | `Cache-Control` carries `no-transform`; switching the beacon off for the zone is open |
| A sandboxing Content Security Policy "is a candidate and a spike" | C: sibling hosts read and overwrote each other's domain cookies; a sandbox without `allow-same-origin` closed it and cost the app all its storage | An open choice for the owner, with three options and the architect's recommendation of (a) ([the sandbox](#the-sandbox-an-open-choice-for-the-owner)) |
| The not-found answer carries `Clear-Site-Data`, and refusing service workers keeps an app from running on | C: refusing the script stopped registration in three browsers; `Clear-Site-Data` left WebKit's service worker serving, and Chromium cleared a sibling's cookies | Refusing the script is the control; `Clear-Site-Data` is a best effort, and whether to narrow it is open |
| "Read the tree of the release directory at that exact commit" | E: `{commit}:{path}` followed a submodule entry to another commit's tree | Two reads: the commit's top tree, then the directory's own sha, recursive. Never `{commit}:{path}` ([how the tree is read](#how-the-tree-is-read)) |
| "GitHub marks a recursive tree `truncated` past 100,000 entries or 7 MB", and the job relied on it | E, at two path lengths: truncation only at 21.0 and 23.7 MB of answer; a truncated answer is a `200` that stops mid-directory | The job caps a tree answer's bytes and entries itself, and `truncated` still fails the release |
| "An entry with no size fails the release" | E: a directory and a submodule never carry a size | A file's entry with no size fails; a directory's has none, and that is normal |
| Paths: "valid UTF-8", no backslash, no control character, case twins | E: tab, newline, backslash, case twins, Unicode twins and a non-UTF-8 name each exist in a repository, the last arriving as U+FFFD | A stated rule: those refused, with U+FFFD, non-NFC, edge spaces and two paths at one address |
| Symlinks and submodules refused by mode | E: confirmed; executable files are `100755` | Which modes pass is stated; an executable file is published as an ordinary one |
| Each file fetched "as raw bytes and not as JSON, … which a 25 MB file wouldn't fit" | E: the raw media type returns exact bytes at every size; JSON is 1.378 times the size; GitHub's `Content-Type` is a guess | Raw media type named; the reason is the Worker's memory; each file checked against the tree's size and sha; GitHub's type never passed on |
| A release of *n* files costs *n* + 1 reads; 3,000 an hour is ten releases; "a few at a time" | E: 301 requests for 300 files with one tree read; one count for the installation; a `304` isn't counted | *n* + 2 reads, 302 at the cap; nine releases; ten at a time; Podster counts its own reads. 300 files stays |
| Contents `read` and Metadata `read`, "both a spike" | E: Metadata arrives unasked; on a public repository neither the permission nor the one-repository limit is what allows or confines reads | The permissions stand; the job's own requests are what confine it |
| A script is named from the label, a separator and the release's ID, with no rule given | A: no rule met in names of 63 to 4,096 characters and eight kinds of character; names are case-sensitive | Podster's own rule: a label of at most 26 lower-case letters and digits, a `.`, and the release's 36-character ID; 63 characters at most ([script names](#script-names)) |
| A missing script "answers not-found" | A and C: `get` returns, and `fetch()` rejects with "Worker not found." | The content Worker catches that rejection and answers not-found; any other rejection serves nothing |
| "If it may not [be assets only], the script is one fixed file of Podster's" | A: an upload with no script served its files | A release is assets only; the fallback is dropped |
| Nothing about HTML paths | A: `/index.html` redirects to `/`, and `page.html` is served at `/page` | The default handling is what a release is uploaded with; two paths at one address fail the release |
| An outbound Worker could fence server code, from the documentation | A: with one, every `fetch` went to it and sockets stopped; without one, `fetch` and a socket reached the internet | Recorded. Nothing of an app's runs, so none is added |
| The marker's wait is "a stated wait" | A: a new script showed within 2.5 s in twelve tries | 30 seconds, provisional: the wait also spans a serve-entry switch, which spike G measures, and a false failure only sets back |
| Nothing about the manifest's hashes | A: a hash is 32 hexadecimal characters and comes back as the `ETag`; files aren't shared between scripts | The hash is derived from bytes and served type; every release sends every file |
| The hourly reconcile lists the namespace, "a spike" | A: one `GET` lists scripts; `has_assets` was wrong | It trusts `id` only; paging is open |

**Not changed by a spike:** the release epoch, the desired serve state and its applier, the unpublish triggers, credentials, authority and approval, custom domains, the caps other than the two figures above, and where state lives. Spike F changes nothing here.

## What needs the owner's yes

Everything in [the M6 plan's table](../m6-plan.md#for-the-owner). This ADR creates nothing.

## Not verified

**Nothing built from this ADR exists, so nothing in it is verified.** What stands behind each claim is one of three things, and its label says which:

- **Documentation,** read on 2026-11-12 through a page reader, in some cases as a summary of a long page and not word for word: Cloudflare's API token permissions page, its Workers for Platforms API reference, and GitHub's permissions table.
- **A spike's one run,** on 2026-11-12. Spike A: staging's namespace, 38 short-lived scripts, every call made by wrangler 4.157.0 from one machine. Spike C: `opster.dev`, three apps, Playwright's headless Chromium, Firefox and WebKit, one pair of sibling hosts. Spike E: one public test repository, read in Node on a laptop with the staging agent App's token cut down. Each is a few observations, and the plan's sections say what each didn't show.
- **Nothing yet:** the two Cloudflare tokens, custom hostnames, the serve entry and KV, resolving TXT from a Worker, a Worker's memory, billing, a private repository, and the fourth App. Spikes B, D and G haven't run. **And nothing at all on `podster.site`:** no record, route, certificate or request. That it resolves to Cloudflare's nameservers is as the architect reported.

**The takedown time is still arithmetic on documented numbers, one of which is "or more".** The revision of 2026-11-12 after the spikes hasn't been independently reviewed.

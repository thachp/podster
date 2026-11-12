# ADR 0010: Release and the content domain

**Status:** **Proposed** by the architect on 2026-11-12 UTC, and revised the same day after an independent review. The review said to accept it as Proposed with named changes: it found the isolation core sound, and raised two blockers and several required changes, all made here ([what the review changed](#what-the-review-changed)). Not approved, and nothing here is built or bought. It answers what the [M6 plan](../m6-plan.md) and the [architecture](../spec/ARCHITECTURE.md#release-and-deployment-m6) leave "open for the ADR". It rests on [decisions 197 to 211](../spec/PRODUCT.md#m6-decisions-november-12-2026), and on working assumptions for the questions only the owner can answer, which are in [the M6 plan's table](../m6-plan.md#for-the-owner). **No spike has run.**

## How to read this

Every claim carries one of these labels:

- **Cloudflare's documentation** or **GitHub's documentation:** read on developers.cloudflare.com or docs.github.com on 2026-11-12, said here in this ADR's own words, and linked; the page is the authority. Not run. Where a page was silent it says "not found", and nothing is guessed in its place.
- **Spec:** already in `PRODUCT.md`, `ARCHITECTURE.md` or `ACCESS-CONTROL.md`. Most of those passages are proposals themselves.
- **Proposed:** the architect's proposal in this ADR.
- **Ruled:** the architect's ruling on the independent review.
- **Assumed, for the owner:** a working assumption for a question the architect can't answer. If the owner answers otherwise, the section changes.
- **Spike:** not known, and a spike has to find out.

Nothing in this ADR is **verified**. No call was made to Cloudflare or to GitHub for it.

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
- **Assumed, for the owner:** static files only, with no agent-written code on the server. Everything below assumes it. If the owner allows server code, the sections on what content can reach and on budgets must be redone, and Podster would be running code an agent wrote.

### Only a public room releases

**Ruled.** In M6 a release can be asked for only in a public room.

- **A private room's request is refused,** with the code `release_needs_public_room`, at the command. Nothing is queued and nothing is stored to run later, so making the room public afterwards releases nothing by itself.
- **Why:** the content Worker can't tell who is asking, and a Podster session on the content domain is exactly what the separate domain exists to prevent. So a private room's app could only be served to everyone, which would publish a private room's work. An unguessable address is never the control: addresses leak through browser history and sync, and through certificate-transparency logs for a custom hostname.
- **A room that goes private is unpublished,** as [below](#unpublishing).
- **A way to serve a private room's app to its own people isn't designed,** and isn't in M6. The candidate is a signed, expiring link the application issues to someone who can see the room. It needs its own ADR and review.

### Where content is served

**Proposed.** Three pieces, on a domain used for nothing else.

1. **The content domain,** a separate registrable domain on Cloudflare. Each room's app has one host on it, `<label>.<content domain>`. The label is generated by the server, is random, never contains a room's or Podster's name, and **is never used again:** not by another room, and not by the same room after its app is unpublished. A browser that still holds something from an old app must never meet a new one under the same origin.
2. **A dispatch namespace** in Workers for Platforms, holding one user Worker per room that has a live release. Each holds that release's static files and nothing else. The user Worker's name is the label.
3. **The content Worker,** a new public Worker (`apps/content`) on the content domain. It is the namespace's dynamic dispatch Worker: it turns a request's host into a label, checks its deny list, asks the namespace for that user Worker, and sets fixed response headers.

What Cloudflare's documentation says of these:

- **Workers in a dispatch namespace are untrusted by default.** In that mode `request.cf` isn't available, each Worker's cache is its own, and `caches.default` is disabled ([Worker isolation](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/worker-isolation/)). The namespace stays untrusted.
- **A user Worker reaches only the bindings explicitly attached to it** ([bindings](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/)). No binding is ever attached. Whether a user Worker could reach the account's other Workers some other way: **not found**, and a **spike**.
- **A user Worker in a namespace can carry static assets,** uploaded through the API in three steps: an upload session with a manifest of file hashes, the files themselves, then the script upload naming the completed session ([static assets for user Workers](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/static-assets/)). Whether a user Worker may be assets only, with no script at all: **not found**. If it may not, the script is one fixed file of Podster's that serves nothing itself.
- **A wildcard route and a wildcard proxied DNS record** put every per-room host on the content Worker: a route pattern whose hostname begins with `*.` matches every subhost, and proxied wildcard records are available on every plan ([routes](https://developers.cloudflare.com/workers/configuration/routing/routes/), [wildcard DNS records](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/)).
- **Universal SSL covers the root and first-level subdomains** of a zone on a full setup, and not deeper levels ([limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)). So per-room hosts are one level deep, and need no certificate of their own. One certificate for all of them also keeps a room's host out of certificate-transparency logs.

**The content Worker routes and never authorizes.** It holds no binding to the gateway, the API, D1 or R2, and no secret. It reads one Workers KV namespace that only the private API writes, which holds three kinds of entry and nothing else:

- a custom hostname's label;
- a label or a host that must not be served;
- one entry that stops the whole content domain.

Each is something Rust decided. A wrong or stale entry can stop an app or route a hostname to a public room's app; it can't serve anything that isn't already in the namespace. **This reverses what the first draft said,** that the map was needed only for custom hostnames: the review's takedown requirements need the deny list from the first step that serves anything.

### What content can reach

**Proposed.**

- **The application.** Nothing. The content domain is another registrable domain, so a page there can't read or set a `podster.dev` cookie. Podster sets no cookie on any content host and accepts no credential there: a request carrying a Podster cookie or an `Authorization` header gets exactly what one without gets.
- **Podster's data.** Nothing. A user Worker has no bindings, and the content Worker has none to Podster's data.
- **Another room's app.** Its pages, as any site can. Its cookies and storage, **unless the content domain is on the Public Suffix List and browsers have shipped that.** The architecture says the domain "must be on" the list. Whether anything may be served before it is, is the **owner's** ([M6 plan](../m6-plan.md#for-the-owner)); the first draft had the architect decide it, and that decision is withdrawn. The list's maintainers say they generally decline small projects and experimental or short-term entries ([publicsuffix.org](https://publicsuffix.org/submit/)), so the entry may be refused.
- **The network, from the server.** Nothing, because no agent-written code runs there. If the owner allows server code, Cloudflare's documentation offers an outbound Worker that is invoked on every `fetch()` a user Worker makes and that stops it opening TCP sockets with `connect()`, but that doesn't intercept requests made from Durable Objects or through mTLS certificate bindings ([outbound Workers](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/)). That isn't designed here.
- **The visitor's browser.** Whatever a web page can. The content Worker sets on every response, overriding anything else: `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, a cache lifetime of 60 seconds, and no `Set-Cookie`. It refuses any request but `GET` and `HEAD`, and refuses a request for a service-worker script, so an app can't keep running in a browser after it is unpublished. A sandboxing Content Security Policy is a candidate and a **spike**.

**Without the Public Suffix List entry, the whole content domain shares one reputation.** Browsers' and mail providers' blocklists, and Safe Browsing, treat hosts under one registrable domain together unless the list says otherwise. So one room's phishing page can get every room's app flagged or blocked. M6's answers are: a release only of reviewed, merged code that a person approved, in a public room; a report route that can name an app; an operator's suspension and a domain-wide stop, [built before anything is served](#takedown-and-how-fast-it-is); and per-room hosts with random labels, so a block of one host is at least possible. None of those prevents it. It is a **consequence** the owner accepts with the content domain.

**`_headers` and `_redirects`.** Cloudflare's static assets read both files from an uploaded directory: up to 100 header rules, and 2,000 static plus 100 dynamic redirects ([headers](https://developers.cloudflare.com/workers/static-assets/headers/), [redirects](https://developers.cloudflare.com/workers/static-assets/redirects/)). Both pages say the rules apply to static asset responses and not to responses from Worker code. Whether either can be switched off: **not found**. An agent could commit either, and so set response headers or redirects on the content domain. So the release job **refuses a release that contains either file**, and the content Worker sets its headers last. Whether user Workers in a namespace honour those files at all is a **spike**.

### The release job

**Proposed**, with the review's changes. An outbox job in the room's Durable Object, the only thing that holds the credentials that publish.

1. **Rerun policy and recheck authority, on every pass,** in the room's transaction, against current state. This is M5's security review finding A-3, applied here from the start: a job that passed once doesn't keep its permission. Each pass asks again:
   - that the room is public, not archived, and its public surface and its app aren't suspended;
   - that release is switched on, and the `release_config` version is the one the release was asked under;
   - the requester's standing now: still in the room, not revoked, their deployment grant live and its giver still holding authority; for an agent, its connection, and the person who linked it still in the organization;
   - the approver's standing now, by the same tests: the person who approved must still be someone who may approve;
   - that the room still requires a person as reviewer, where the release's task was reviewed under that;
   - that the commit is still one Podster's merge confirmed on the default branch.
   Any of them failing ends the release as failed, with that reason's code, before any call to GitHub or Cloudflare (AC-13).
2. **Read the tree** of the release directory from GitHub at that exact commit, with a token for that one repository.
3. **Check it,** from the tree alone, before any file is fetched: the paths, the count and the sizes.
4. **Fetch the files and upload** them to the namespace, under the room's label.
5. **Confirm** what is being served, and record the release as live only then. An answer that never came is recorded as uncertain and settled by reading, never assumed (UI-02).

**What a release may contain. Proposed.** Decided in `crates/core` from the tree:

- **Paths:** valid UTF-8, at most 1,024 bytes in all and 255 a segment; no empty segment, no `.` or `..`, no backslash, no control character. A path that differs from another only by case fails the release.
- **Refused by name, anywhere in the directory:** `_headers`, `_redirects`, `_worker.js`, `_routes.json`, and anything at the marker's path below. A repository can't supply the file the job uses to confirm itself.
- **Refused by kind:** a tree entry with mode `120000`, a symlink, or `160000`, a submodule (GitHub's [trees](https://docs.github.com/en/rest/git/trees) page lists the modes). Nothing the repository controls is followed.
- **A truncated tree fails the release.** GitHub marks a recursive tree `truncated` past 100,000 entries or 7 MB. The job never publishes part of a directory.
- **Sizes come from the tree.** GitHub's tree entries carry a `size` for a blob, by the page's schema. The job sums them and applies the caps before fetching anything. An entry with no size fails the release.
- **The job reads no configuration** from the repository beyond the fixed directory name. Agent content is data.

**Why trees and blobs.** GitHub's Contents listing stops at 1,000 files for a directory; a blob is supported up to 100 MB ([contents](https://docs.github.com/en/rest/repos/contents), [blobs](https://docs.github.com/en/rest/git/blobs)).

**The reads, sized against GitHub's limit.** A release of *n* files costs one tree read and *n* blob reads. An installation's token gets 5,000 requests an hour, shared by every room that App serves, rising by 50 for each repository past 20 up to 12,500; no more than 100 at once, and 900 points a minute for one endpoint ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)). So:

- **A release is capped at 300 files,** down from the first draft's 1,000: 301 reads, about a sixteenth of the hourly limit.
- **The release App's reads are budgeted across the deployment:** at most 3,000 an hour, which is ten full-size releases, leaving the rest as headroom. Past it a release waits and says so. This is the first cap in Podster that adds rooms up.
- **Blobs are fetched a few at a time,** well under both secondary limits.
- **Contents `read` is the one repository permission** those endpoints need, by GitHub's [permissions table](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps). That row was read from a summary of a long page, so it is a **spike** too. Whether Metadata `read` is also needed: **not found**.

**Confirming what is served.** Whether an upload's manifest can be read back through Cloudflare's API: **not found**. So the job adds one file of its own to every release, at `/.well-known/podster-release.json`, holding the release's ID and commit, and after the upload it fetches that file from the room's host through the content Worker. Live means that fetch returned this release's ID.

### Unpublishing

**Ruled.** Unpublishing means the app stops being served, **and that is confirmed by reading the host.** It isn't done when a delete was sent.

**Each of these unpublishes a room's app:**

- release switched off in the room;
- the room archived;
- the room deleted;
- the room made private;
- the room's public surface suspended by an operator (M4);
- the app suspended by an operator;
- an operator taking the ability to release from the room's organization;
- **Assumed, for the owner:** no person who holds the deployment grant remaining in the room. An owner's departure by itself was "keeps serving" in the first draft; the review moved that to the owner, and this is the safest reading until they answer.

**How:**

1. The command that causes it commits the room's state, an event and an outbox job in one transaction, and writes the deny entry for the app's label and its hosts in the same job's first step. From that moment the content Worker refuses the app, whatever the namespace holds.
2. The job deletes the user Worker from the namespace, and the custom hostname at Cloudflare if there is one.
3. The job reads the room's host and each custom hostname through the content Worker until each answers not-found, and records the unpublish only then. A delete that failed is retried. **A failed delete never leaves a suspended app serving,** because the deny entry doesn't depend on it.
4. **A scheduled reconcile** in each room that has, or had, an app compares what should be served with what is, by reading the host, and reruns the unpublish if they differ. It also reruns every trigger above against current state, so one that was missed is caught.

The not-found answer carries `Clear-Site-Data`.

### Takedown, and how fast it is

**Ruled.** Podster hosts this content, so it must be able to stop it without the room's owner. **Suspension and the stop are built before the first step that serves content** ([the M6 plan's build order](../m6-plan.md#build-order)).

- **An operator suspends an app,** and lifts that. The room's owner can't switch release back on while it holds. Operators still read nothing private ([decision 205](../spec/PRODUCT.md#m6-decisions-november-12-2026)).
- **Suspension is keyed by the app's label and by each host,** never by a room's public handle. M5's security review (O-2) found Podster couldn't stop a repository because the only handle an operator had was the public one; an app must be stoppable by what a reporter actually has, which is its address.
- **A domain-wide stop:** one entry that makes the content Worker refuse every request on the content domain. An operator sets it. It is for a compromise of the namespace or the publishing token, or a block of the whole domain.
- **A report can name a deployed app,** by its address.
- **Last resort, outside Podster's code:** the owner removes the content Worker's route, or the wildcard DNS record, in Cloudflare's dashboard.

**How fast, with the documented numbers:**

- **A deny entry is a Workers KV write.** Cloudflare's documentation says a write is usually visible at once where it was made and may take up to 60 seconds or more elsewhere, because locations cache what they read; the shortest cache lifetime a read may ask for is 30 seconds ([how KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/), [KV limits](https://developers.cloudflare.com/kv/platform/limits/)). The content Worker asks for 30.
- **A response the content Worker already sent** may be reused by a browser or a cache for its 60-second lifetime.
- **So an app stops being served within about two minutes of the command,** in the documented case: up to 60 seconds for the entry, then up to 60 for what was already cached. "Or more" is Cloudflare's own wording, and how long it really takes is a **spike**. The job's read-back is what says it happened.
- **A visitor who already has a page open** keeps it until they reload. Service workers are refused, so nothing keeps running after that.

### Credentials

**Proposed** ([decision 198](../spec/PRODUCT.md#m6-decisions-november-12-2026)). All held by the private API Worker only. The gateway, the web app and the content Worker hold none.

- **Reading from GitHub: a fourth App,** with Contents `read` and nothing else it can avoid, used by the release job alone. Its token is made for the one repository and never leaves the job: an installation token can be limited, when it is made, to named repositories and to a subset of the App's permissions, and lives an hour ([installation access tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)). A release borrows none of M5's three Apps. Creating the App is the **owner's**.
- **Publishing to Cloudflare.** What the publishing side needs, each a permission the token must carry:
  - **Workers scripts, write:** to upload and delete a user Worker in the namespace. The only permission found is the account-level "Workers Scripts Edit" ([API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/), read in part). Nothing scoped to one namespace was found, and the permission the namespace's upload endpoint needs isn't stated on the pages read.
  - **Workers KV storage, write:** for the deny list and the custom hostname map.
  - **Custom hostnames on the content zone, write:** to create and delete a custom hostname and read its status. Which zone permission that is wasn't read; a **spike**.
- **So the working assumption is a second Cloudflare account,** holding the content domain, the namespace, the content Worker and the KV namespace, and nothing of Podster's own. On one account, a token that can write Workers scripts could replace Podster's own API Worker.
- **Said plainly: in the second account that token can replace the content Worker itself,** since the content Worker is a script in that account. Whoever holds it can serve anything on the content domain, and remove the deny list's effect. What limits the damage:
  - **It can't reach Podster.** The second account holds none of Podster's data, the content domain shares no cookie with `podster.dev`, and the content Worker holds no secret.
  - **It is held in one place,** the private API Worker's secret, and used only by the release and unpublish jobs.
  - **Two tokens, not one, if Cloudflare allows:** one for scripts, one for KV and custom hostnames, so the hostname and deny-list paths can't replace code. Whether the scripts permission can be separated that way is a **spike**.
  - **The reconcile checks the content Worker too:** it reads the content Worker's deployed version and compares it with the one Podster's deploy recorded. A difference raises the domain-wide stop's alarm. How that version is read is a **spike**.
  - **The last resort above** needs no token: the owner's own dashboard login.
- **Who holds the second account's own credentials,** and how the content Worker is deployed to it, are the **owner's**.

A client never names an account, a namespace, a script or a host label. All four come from trusted configuration or are generated by the server.

### Authority, approval and triggers

**Ruled** ([decisions 199 and 200](../spec/PRODUCT.md#m6-decisions-november-12-2026)).

- **Who configures release, and who approves one. Assumed, for the owner:** the room's owner only, as a person, until the owner answers. The architect recommends the room's owner and admins as people, agents never, to match what the owner decided for repositories in [decision 194](../spec/PRODUCT.md#decisions-needed). The first draft cited decision 18's owner-only form, which 194 replaced for repositories; who it is for deployment was never asked.
- **Only in a public Engineering room** with a ready repository, and only where the deployment's own configuration allows release at all.
- **Who asks for a release:** someone who holds a `provider_grant` with a `deploy` action. Approval of a task and a merge grant give nothing (AC-17). An agent may hold the grant and ask; an agent never approves.
- **The approval policy has one value in M6: `person`.** A person who may approve, approves each release. The first draft also had `on_merge`, under which a merge would start a release; with releases only in public rooms, where a person must approve, it could never publish anything, so it is dropped.
- **What starts a release:** a `deploy_release` command, then a person's approval. Never a merge, a webhook, or an observation of GitHub.
- **Decided in `crates/policy` then `crates/core`,** at the command, at the approval, and on every pass of the job.

### Rollback

**Proposed** ([decision 203](../spec/PRODUCT.md#m6-decisions-november-12-2026)).

- **Rollback is a new release** of a commit that was live before, asked for and approved as any release is. Nothing is rewritten, and each attempt is its own record.
- **A failed release leaves the earlier one serving.** There is no automatic rollback, because there is nothing to roll back from.

### Custom domains

**Ruled** ([decisions 201 and 207](../spec/PRODUCT.md#m6-decisions-november-12-2026)). Cloudflare's validation alone isn't proof for Podster. The review showed two ways it fails:

- **Takeover.** Room A maps `app.example.com` and is later archived, with its DNS record still pointing at Podster. Room B asks for the same name, and Cloudflare validates it automatically, because the record is there.
- **Squatting.** If a claim is recorded before proof, any room can hold a name it doesn't control.

**So Podster has its own proof, bound to the room, and Rust decides all of it.**

1. **The challenge.** A room's owner asks to map a hostname. The room's command commits the request and a random value made for this request alone. The owner publishes it as a TXT record at `_podster-challenge.<hostname>`. The value names nothing readable, and is useless to any other room or any later request.
2. **Pending holds nothing.** A pending request doesn't reserve the name: any number of rooms may be pending for one hostname, and none of them blocks another. A pending request expires after **72 hours**, and then it is gone.
3. **Proof.** A job resolves the TXT record and compares it, in Rust. Only when it matches does the job ask the hostname's own object for the claim.
4. **One hostname, one room.** A small Durable Object per normalized hostname holds at most one live claim, since a D1 row must never authorize. It gives the claim to the first room whose proof passed, and refuses any other while that claim lives. Asking again for the same room and request gets the same answer. The room then commits the claim or the refusal.
5. **Only then is the custom hostname created at Cloudflare,** which runs its own validation. Routing starts when the room holds the claim and Cloudflare reports the hostname `active`.
6. **A claim never transfers.** When a room's claim ends, for any reason, the job deletes the custom hostname at Cloudflare, **reads until Cloudflare reports it gone,** and only then frees the claim. A later claim, by anyone, the same room included, needs a new challenge with a new value. A DNS record left pointing at Podster proves nothing.
7. **The challenge is rechecked on a schedule,** daily. A check that fails is tried again an hour later; failing that too ends the claim, as in step 6.
8. **A claim ends** when the room unpublishes, removes the mapping, or fails the recheck, and when Cloudflare reports the hostname `moved`.

**Refused in `crates/core`:** `podster.dev`, the content domain, a subdomain of either, an IP address, a single-label name, and a public suffix itself.

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
| Apps a room | 1 | 1,000 scripts included in Workers for Platforms, then $0.02 each. Cloudflare's limits page says unlimited, which its pricing page contradicts |
| Files in a release | 300 | 100,000 per Worker version on a paid plan; and GitHub's 5,000 reads an hour for the release App |
| Size of a release | 25 MB in all | 25 MiB for one file; no total found |
| Releases a room a day | 20 | Cloudflare's API allows 1,200 calls in five minutes for a token |
| The release App's reads, across the deployment | 3,000 an hour | GitHub's 5,000 an hour for an installation |
| Custom hostnames a room | 1 | 100 included, then $0.10 each, up to 50,000 |

- **What it costs,** from the pricing pages: Workers for Platforms is $25 a month, with 20 million requests and 60 million CPU milliseconds included, then $0.30 a million requests and $0.02 a million CPU milliseconds ([pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/pricing/)). Whether it needs Workers Paid first, and how many namespaces an account may have: **not found**.
- **Every request is probably billed.** Workers' own pricing says requests to static assets are free ([billing and limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)), but here every request first runs the content Worker, which is a dispatch Worker, and the Workers for Platforms pricing page charges one request for the chain and doesn't mention static assets. So assume each request to an app is one billed request and a little CPU time. A **spike** measures it.
- **Each request also reads KV** once, for the deny list. Workers KV on a paid plan includes 10 million reads a month, then $0.50 a million ([KV pricing](https://developers.cloudflare.com/kv/platform/pricing/)). The 30-second cache makes most of those cheap; whether a cached read is billed is a **spike**.
- **Nothing here caps traffic.** A popular or attacked app draws requests Podster pays for. A per-room request cap isn't designed, and whether one is needed is the **owner's**, as money.

### Where state lives

**Proposed.** `release_config`, each `release`, the room's hostname request and its challenge, and the outbox jobs are the room's own state, in its Durable Object, through forward-only migrations. They are authority. D1 gets at most a projection for lists, which never authorizes. A hostname's claim is its own Durable Object. The KV namespace and the dispatch namespace are derived: Rust writes both, and either can be rebuilt from the rooms.

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
- **New billed resources,** more than any earlier milestone: a domain, the Workers for Platforms plan, and probably a second account with its own Workers Paid.
- **A fourth GitHub App and two more secrets** to keep and rotate.
- **A new public Worker** that must never grow a binding to Podster's data. A test should fail if its configuration gains one.
- **A release is only what was committed,** and at most 300 files. An app that needs a build step must commit its built files. That is a real limit on "a working web application", and the owner's to accept.
- **Private rooms get no app** in M6.
- **An app's address changes** if it is unpublished and published again, because a label is never reused.
- **A custom domain needs a TXT record kept in place** for as long as it is mapped.

## What stays open for the spikes

Each needs a resource that doesn't exist yet. [The M6 plan](../m6-plan.md#the-spikes) says which, and what can be learned with none.

1. Whether a user Worker in the namespace can reach anything of the account's without a binding.
2. Whether a user Worker can be assets only, and whether it honours `_headers` and `_redirects`.
3. The narrowest tokens that can do each publishing job, whether scripts can be separated from KV and hostnames, and what each can touch.
4. What a request to an app is billed as, and whether a cached KV read is billed.
5. How long after an upload, a delete and a deny entry the host shows the new state. This is the takedown time.
6. The custom-hostname flow end to end: that nothing routes before `active`, what a delete does and how soon, and what the room's owner must publish.
7. Whether a custom hostname can be made to reach another room's app by a `Host` header or SNI.
8. Whether a wildcard route and custom hostnames both reach one Worker on the content zone.
9. That Contents `read` alone reads a tree and its blobs at a commit; that tree entries carry sizes; what GitHub answers for a large directory.
10. Whether a sandboxing Content Security Policy closes the gap between rooms' apps without breaking ordinary static apps, and whether refusing service-worker scripts and `Clear-Site-Data` do what this ADR says.
11. Resolving a TXT record from a Worker, and which resolver.
12. Reading the content Worker's deployed version, for the reconcile.

## What an independent review should attack

The first review did. What a second should look at, now that the design has changed:

- **The challenge.** Can a room get a live claim without controlling the name? Can two rooms end up routed for one hostname during a handover? Is the read-until-gone in step 6 really before the claim is freed?
- **The deny list.** Is there any request the content Worker serves without consulting it? What does a stale or missing entry do?
- **The second account's token.** Is "it can't reach Podster" true? What does replacing the content Worker let an attacker do to visitors?
- **Every pass.** Is there any state the job's recheck misses that a command would refuse?
- **The unpublish triggers.** Is the list complete? What if a trigger's command commits and its job never runs?
- **The release job's reads.** Can a repository make it fetch outside the directory, exhaust memory, or publish half a tree? Do the path rules leave anything the platform treats specially?
- **A room that turns private or public around a release.**
- **Every "not found".** Each is a place where this ADR could be wrong about the platform.

## What the review changed

The independent review read the first draft on 2026-11-12. Its two blockers and the required changes, and where each landed:

| The review said | Now |
| --- | --- |
| **Blocker:** Cloudflare's validation isn't proof; takeover and squatting | Podster's own room-bound TXT challenge, checked before a claim lives and before a hostname exists at Cloudflare; pending holds nothing and expires in 72 hours; a claim never transfers ([custom domains](#custom-domains)) |
| **Blocker:** visibility and policy | Only a public room releases, `release_needs_public_room` otherwise; `on_merge` dropped; the unpublish triggers listed, each rechecked ([only a public room releases](#only-a-public-room-releases), [unpublishing](#unpublishing)) |
| The job reruns policy on every pass (M5's A-3) | [The release job](#the-release-job), step 1 |
| Unpublish confirmed by read-back, retried, reconciled; takedown time in numbers | [Unpublishing](#unpublishing); [how fast](#takedown-and-how-fast-it-is): about two minutes in the documented case |
| A domain-wide stop; suspension keyed by app and host (M5's O-2) | [Takedown](#takedown-and-how-fast-it-is) |
| Suspension and takedown built before anything is served | [The M6 plan's build order](../m6-plan.md#build-order) |
| The blocklisting consequence without the Public Suffix List | [What content can reach](#what-content-can-reach) |
| Every permission the publishing token needs; that it can replace the content Worker | [Credentials](#credentials) |
| Sizes from the tree; the marker's path refused; path rules; a label never reused; reads sized against GitHub's limit | [The release job](#the-release-job): 300 files, 3,000 reads an hour |
| Citations: pre-validation's own page; `_redirects`' limits; the dispatch Worker bills each request | [Custom domains](#custom-domains), [what content can reach](#what-content-can-reach), [budgets](#budgets-and-account-limits) |
| Decision 210 isn't the architect's | Withdrawn; the owner's |
| Decisions 199, 200, 204, 207 | 199 rewritten, `person` only; 200 and 204's owner-departure part put to the owner; 207 tightened |

## What needs the owner's yes

Everything in [the M6 plan's table](../m6-plan.md#for-the-owner). This ADR creates nothing.

## Not verified

Everything. No spike has run, no resource exists, and no call was made to Cloudflare or GitHub. The documentation was read on 2026-11-12 through a page reader, in some cases as a summary of a long page and not word for word: Cloudflare's API token permissions page, its Workers for Platforms API reference, and GitHub's permissions table. Claims that rest on those say so above. The takedown time is arithmetic on documented numbers, one of which is "or more".

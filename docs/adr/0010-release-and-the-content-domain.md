# ADR 0010: Release and the content domain

**Status:** **Proposed** by the architect on 2026-11-12 UTC. It has been independently reviewed twice, and the changes both reviews asked for are applied here ([what the reviews changed](#what-the-reviews-changed)). The first found the isolation core sound and raised two blockers; the second raised one, on the order of publishing and unpublishing. It counts as accepted as Proposed once the architect confirms these changes. Not approved, and nothing here is built or bought. It answers what the [M6 plan](../m6-plan.md) and the [architecture](../spec/ARCHITECTURE.md#release-and-deployment-m6) leave "open for the ADR". It rests on [decisions 197 to 211](../spec/PRODUCT.md#m6-decisions-november-12-2026), and on working assumptions for the questions only the owner can answer, which are in [the M6 plan's table](../m6-plan.md#for-the-owner). **No spike has run.**

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

**Ruled, and assumed for the owner.** In M6 a release can be asked for only in a public room. That private rooms get no app narrows the product, so it is in [the owner's table](../m6-plan.md#for-the-owner): this is what holds until the owner answers, as for who configures release and what happens when an owner leaves.

- **A private room's request is refused,** with the code `release_needs_public_room`, at the command. Nothing is queued and nothing is stored to run later, so making the room public afterwards releases nothing by itself.
- **Why:** the content Worker can't tell who is asking, and a Podster session on the content domain is exactly what the separate domain exists to prevent. So a private room's app could only be served to everyone, which would publish a private room's work. An unguessable address is never the control: addresses leak through browser history and sync, and through certificate-transparency logs for a custom hostname.
- **A room that goes private is unpublished,** as [below](#unpublishing).
- **A way to serve a private room's app to its own people isn't designed,** and isn't in M6. The candidate is a signed, expiring link the application issues to someone who can see the room. It needs its own ADR and review.

### Where content is served

**Proposed.** Three pieces, on a domain used for nothing else.

1. **The content domain,** a separate registrable domain on Cloudflare. Each room's app has one host on it, `<label>.<content domain>`. The label is generated by the server, is random, never contains a room's or Podster's name, and **is never used again:** not by another room, and not by the same room after its app is unpublished. A browser that still holds something from an old app must never meet a new one under the same origin.
2. **A dispatch namespace** in Workers for Platforms, holding one user Worker per room that has a live release. Each holds that release's static files and nothing else. The user Worker's name is the label.
3. **The content Worker,** a new public Worker (`apps/content`) on the content domain. It is the namespace's dynamic dispatch Worker: it reads the serve entry for the request's host, asks the namespace for the user Worker that entry names, and sets fixed response headers.

What Cloudflare's documentation says of these:

- **Workers in a dispatch namespace are untrusted by default.** In that mode `request.cf` isn't available, each Worker's cache is its own, and `caches.default` is disabled ([Worker isolation](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/worker-isolation/)). The namespace stays untrusted.
- **A user Worker reaches only the bindings explicitly attached to it** ([bindings](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/)). No binding is ever attached. Whether a user Worker could reach the account's other Workers some other way: **not found**, and a **spike**.
- **A user Worker in a namespace can carry static assets,** uploaded through the API in three steps: an upload session with a manifest of file hashes, the files themselves, then the script upload naming the completed session ([static assets for user Workers](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/static-assets/)). Whether a user Worker may be assets only, with no script at all: **not found**. If it may not, the script is one fixed file of Podster's that serves nothing itself.
- **A wildcard route and a wildcard proxied DNS record** put every per-room host on the content Worker: a route pattern whose hostname begins with `*.` matches every subhost, and proxied wildcard records are available on every plan ([routes](https://developers.cloudflare.com/workers/configuration/routing/routes/), [wildcard DNS records](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/)).
- **Universal SSL covers the root and first-level subdomains** of a zone on a full setup, and not deeper levels ([limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)). So per-room hosts are one level deep, and need no certificate of their own. One certificate for all of them also keeps a room's host out of certificate-transparency logs.

**The content Worker routes and never authorizes.** It holds no binding to the gateway, the API, D1 or R2, and no secret. It reads one Workers KV namespace that only the private API writes.

**Ruled: serving is allow-listed.** The content Worker serves a host only when a **serve entry** exists for that exact host. The entry names the app's label and the release it is serving. No entry, an entry it can't read, or an error from KV all answer not-found: it fails closed. There is no deny list, so nothing depends on an entry being present to stop an app.

- **One KV read a request:** the serve entry for the request's host. A default host and a custom hostname each have their own.
- **One more key, the stop,** makes the content Worker refuse every host. It is read at most once every 30 seconds by each running copy of the Worker and kept in memory between, so it isn't a second read on each request.
- **A serve entry is written only after the room has committed the release as live,** and removed first when an app is unpublished ([below](#publishing-and-unpublishing-in-order)).
- **Each entry is something Rust decided.** A stale entry can keep serving a release for a while after the room stopped it; it can't serve anything the room never made live, and a missing one serves nothing.

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

**Proposed**, with both reviews' changes. An outbox job in the room's Durable Object, the only thing that holds the credentials that publish.

1. **Rerun policy and recheck authority, on every pass,** in the room's transaction, against current state. This is M5's security review finding A-3, applied here from the start: a job that passed once doesn't keep its permission. Each pass asks again:
   - that the deployment's own configuration still allows release at all, and the stop for the whole content domain isn't set;
   - that an operator hasn't taken the ability to release from the room's organization;
   - that the room is public, not archived, and its public surface and its app aren't suspended;
   - that the room's repository is still ready;
   - that release is switched on, and the `release_config` version is the one the release was asked under;
   - that the requester may still release now: in the room, not revoked, their deployment grant live and its giver still holding authority; for an agent, its connection, and the person who linked it still in the organization;
   - that the approver may still approve now, by the same tests;
   - that the room still requires a person as reviewer, where the release's task was reviewed under that;
   - that the commit is still one Podster's merge confirmed on the default branch;
   - **that the room's release epoch is the one this release started under** ([below](#publishing-and-unpublishing-in-order)).
   Any of them failing ends the release as failed, with that reason's code, before any call to GitHub or Cloudflare (AC-13).
2. **Read the tree** of the release directory from GitHub at that exact commit, with a token for that one repository.
3. **Check it,** from the tree alone, before any file is fetched: the paths, the count and the sizes.
4. **Fetch the files and upload** them to the namespace, under the room's label. Nothing is served yet: there is no serve entry.
5. **Return to the room.** In one transaction the room reruns the whole of step 1, the epoch included, and only then commits the release as `live`. If anything fails, the job deletes what it uploaded and the release ends failed, with the reason.
6. **Write the serve entry,** then fetch the release's marker through the host, and record that it is being served. An answer that never came is recorded as uncertain and settled by reading, never assumed (UI-02).

**What a release may contain. Proposed.** Decided in `crates/core` from the tree:

- **Paths:** valid UTF-8, at most 1,024 bytes in all and 255 a segment; no empty segment, no `.` or `..`, no backslash, no control character. A path that differs from another only by case fails the release.
- **Refused by name, anywhere in the directory:** `_headers`, `_redirects`, `_worker.js`, `_routes.json`, and anything at the marker's path below. A repository can't supply the file the job uses to confirm itself.
- **Refused by kind:** a tree entry with mode `120000`, a symlink, or `160000`, a submodule (GitHub's [trees](https://docs.github.com/en/rest/git/trees) page lists the modes). Nothing the repository controls is followed.
- **A truncated tree fails the release.** GitHub marks a recursive tree `truncated` past 100,000 entries or 7 MB. The job never publishes part of a directory.
- **Sizes come from the tree.** GitHub's tree entries carry a `size` for a blob, by the page's schema. The job applies the caps before fetching anything. An entry with no size fails the release.
- **One file is at most 5 MB,** and a release 25 MB in all. A Worker has little memory, and GitHub's blob answer wraps a file in base64 inside JSON, which a 25 MB file wouldn't fit. So each file is fetched by itself, as raw bytes and not as JSON, held only until its batch is uploaded, and then dropped. A file over 5 MB is refused from the tree's size, before it is fetched. Whether 5 MB and a batch fit in practice is a **spike**.
- **The job reads no configuration** from the repository beyond the fixed directory name. Agent content is data.

**Why trees and blobs.** GitHub's Contents listing stops at 1,000 files for a directory; a blob is supported up to 100 MB ([contents](https://docs.github.com/en/rest/repos/contents), [blobs](https://docs.github.com/en/rest/git/blobs)).

**The reads, sized against GitHub's limit.** A release of *n* files costs one tree read and *n* blob reads. An installation's token gets 5,000 requests an hour, shared by every room that App serves, rising by 50 for each repository past 20 up to 12,500; no more than 100 at once, and 900 points a minute for one endpoint ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)). So:

- **A release is capped at 300 files:** 301 reads, about a sixteenth of the hourly limit.
- **The release App's reads are budgeted across the deployment:** at most 3,000 an hour, which is ten full-size releases, leaving the rest as headroom. Past it a release waits and says so. This is the first cap in Podster that adds rooms up.
- **Files are fetched a few at a time,** well under both secondary limits.

**The App's permissions: Contents `read` and Metadata `read`, and nothing else.** Contents `read` is what GitHub's [permissions table](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps) lists for reading content, a tree and a blob; that row was read from a summary of a long page. Metadata `read` is asked for beside it because an App with any repository permission is understood to carry it; whether it is strictly needed was **not found** on the pages read. Both are a **spike**.

**The marker.** Whether an upload's manifest can be read back through Cloudflare's API: **not found**. So the job adds one file of its own to every release, at `/.well-known/podster-release.json`, holding the release's ID and commit. Fetching it through the host is how step 6 knows which release is being served.

### Publishing and unpublishing, in order

**Ruled**, on the second review's blocker. The first revision let this happen: a first release passes its recheck; the owner makes the room private while the files are being fetched; the unpublish finds nothing to delete and records itself done; the upload then lands, and the job records the release live. A private room's work is published. Three things close it.

- **The room holds a release epoch,** a number that only goes up. **Every unpublish trigger raises it, in the same room transaction that records the trigger.** A release remembers the epoch it started under. Step 5 above compares it, inside the room's transaction, beside the whole policy. A release that started before any trigger can never be committed live after it.
- **The room orders its own publishing and unpublishing.** It runs its release jobs one at a time, in the order it committed them. So an unpublish committed after a release went live runs after that release's serve entry was written, and removes it; one committed before step 5 makes step 5 fail. Which job reaches Cloudflare first never decides anything.
- **Nothing is served without a serve entry,** and the entry is written only after step 5. So an upload that lands late, from a job that lost, is a script nobody can reach, and the reconcile deletes it.

### Unpublishing

**Ruled.** Unpublishing means the app stops being served and its files are gone from Cloudflare.

**Each of these unpublishes a room's app,** raising the room's release epoch in the same transaction:

- release switched off in the room;
- the room archived;
- the room deleted;
- the room made private;
- the room's organization deleted;
- the room's public surface suspended by an operator (M4);
- the app suspended by an operator;
- an operator taking the ability to release from the room's organization;
- **the room's repository stopped or lost:** an operator suspends it, it is found gone, or its link is no longer ready. The app comes down with the reason `repo_not_ready`. A release is a copy of that repository's reviewed work; with the repository stopped, nobody can say the copy should still be up;
- **Assumed, for the owner:** nobody who may release now remaining in the room. "May release now" is the test the job itself uses: a grant dies with its giver, so holding one isn't enough. An owner's departure by itself was "keeps serving" in the first draft; the first review moved that to the owner, and this is the safest reading until they answer.

**How:**

1. **The command commits** the room's state, the raised epoch, an event and an outbox job, in one transaction.
2. **The serve entries are removed first, and not by the job.** The command's own handler removes them as soon as its transaction has committed, before it answers. The outbox job removes them again, so a handler that died in between is covered. This is the fast part: from here no request is served, once KV has caught up.
3. **The job deletes the user Worker** from the namespace, and the custom hostname at Cloudflare if there is one, after removing that hostname's serve entry.
4. **The delete is confirmed by Cloudflare's own answer for that script,** not by fetching the host. Fetching proves nothing here: with the serve entry gone the host answers not-found whether the files were deleted or not. A delete that failed or wasn't answered is retried.
5. **A scheduled reconcile lists what is in the namespace** and what serve entries exist, and asks each room whether that label is live at its current epoch. Whatever no room claims, it deletes. That catches an upload that landed after its release lost, a delete that never ran, and an entry left behind.

**Suspension never restores.** Lifting an operator's suspension lets the room release again, by a new `deploy_release` and a new approval. Nothing that was deleted comes back, and nothing a late job left in the namespace can be served, since it has no serve entry.

The not-found answer carries `Clear-Site-Data`.

### Takedown, and how fast it is

**Ruled.** Podster hosts this content, so it must be able to stop it without the room's owner. **Suspension and the stop are built before the first step that serves content** ([the M6 plan's build order](../m6-plan.md#build-order)).

- **An operator suspends an app,** and lifts that. The room's owner can't release while it holds. Operators still read nothing private ([decision 205](../spec/PRODUCT.md#m6-decisions-november-12-2026)).
- **Suspension is keyed by the app's label and by each host,** never by a room's public handle. M5's security review (O-2) found Podster couldn't stop a repository because the only handle an operator had was the public one; an app must be stoppable by what a reporter actually has, which is its address.
- **An app's suspension is the room's state.** A label is never reused, so it lasts as long as the label means anything.
- **A custom hostname's suspension lives with that hostname's claim object,** not with any room. It outlives every claim, and while it holds, nobody can start a challenge or get a claim for that name. Only an operator lifts it. Otherwise a suspended name could be claimed again by the next room.
- **A stop for the whole content domain:** one key that makes the content Worker refuse every host. An operator sets it. It is for a compromise of the namespace or of a publishing credential, or a block of the whole domain.
- **A report can name a deployed app,** by its address.
- **Last resort, outside Podster's code:** the owner removes the content Worker's route, or the wildcard DNS record, in Cloudflare's dashboard.

**How fast, measured from the operator's command, with the documented numbers:**

- **The serve entries are removed by the command's own handler,** right after its transaction commits. Nothing waits for the outbox or the room's alarm. That is the request's own time: well under a second, not measured.
- **A KV change is usually visible at once where it was made and may take up to 60 seconds or more elsewhere,** because each location caches what it read, and a missing key is cached the same way; the shortest cache lifetime a read may ask for is 30 seconds ([how KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/), [KV limits](https://developers.cloudflare.com/kv/platform/limits/)). The content Worker asks for 30.
- **A response already sent** may be reused by a browser for its 60-second lifetime.
- **So an app stops being served within about two minutes of the command,** in the documented case: up to 60 seconds for the removal to be seen everywhere, then up to 60 for what a browser already held. "Or more" is Cloudflare's own wording, and how long it really takes is a **spike**.
- **The stop for the whole domain** is slower by up to 30 seconds, the time each copy of the content Worker keeps it in memory.
- **A visitor who already has a page open** keeps it until they reload. Service workers are refused, so nothing keeps running after that.

### Credentials

**Proposed** ([decision 198](../spec/PRODUCT.md#m6-decisions-november-12-2026)). Three secrets, all held by the private API Worker only: the release App's key and two Cloudflare tokens. The gateway, the web app and the content Worker hold none.

- **Reading from GitHub: a fourth App,** with Contents `read` and Metadata `read`, used by the release job alone. Its token is made for the one repository and never leaves the job: an installation token can be limited, when it is made, to named repositories and to a subset of the App's permissions, and lives an hour ([installation access tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)). A release borrows none of M5's three Apps. Creating the App is the **owner's**.
- **Publishing to Cloudflare: two API tokens, not one.**
  - **The scripts token** uploads, deletes and lists user Workers in the namespace. The only permission found for that is the account-level "Workers Scripts Edit" ([API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/), read in part). Nothing scoped to one namespace was found, and the permission the namespace's upload endpoint needs isn't stated on the pages read.
  - **The routing token** writes the KV namespace, and creates, reads and deletes custom hostnames on the content zone. Which zone permission custom hostnames need wasn't read; a **spike**.
  - **Why two:** the paths that only route, which are the serve entries, the stop and hostnames, then can't replace code. If Cloudflare can't separate them, which is a **spike**, there is one token and this section says so then.
- **So the working assumption is a second Cloudflare account,** holding the content domain, the namespace, the content Worker and the KV namespace, and nothing of Podster's own. On one account, a token that can write Workers scripts could replace Podster's own API Worker.
- **Said plainly: in the second account the scripts token can replace the content Worker itself,** since the content Worker is a script in that account. Whoever holds it can serve anything on the content domain, serve entry or not. What limits the damage:
  - **It can't reach Podster.** The second account holds none of Podster's data, the content domain shares no cookie with `podster.dev`, and the content Worker holds no secret.
  - **It is held in one place,** the private API Worker's secret, and used only by the release and unpublish jobs and the reconcile.
  - **The reconcile checks the content Worker too:** it reads the content Worker's deployed version and compares it with the one Podster's deploy recorded. A difference raises an alarm for an operator. How that version is read is a **spike**.
  - **The last resort** needs no token: the owner's own dashboard login.
- **Who holds the second account's own credentials,** and how the content Worker is deployed to it, are the **owner's**.

A client never names an account, a namespace, a script or a host label. All four come from trusted configuration or are generated by the server.

### Authority, approval and triggers

**Ruled** ([decisions 199 and 200](../spec/PRODUCT.md#m6-decisions-november-12-2026)).

- **Who configures release, and who approves one. Assumed, for the owner:** the room's owner only, as a person, until the owner answers. Everywhere this ADR says someone "may approve" or "configures", that is who it means meanwhile. The architect recommends the room's owner and admins as people, agents never, to match what the owner decided for repositories in [decision 194](../spec/PRODUCT.md#decisions-needed). The first draft cited decision 18's owner-only form, which 194 replaced for repositories; who it is for deployment was never asked.
- **Only in a public Engineering room** with a ready repository, and only where the deployment's own configuration allows release at all.
- **Who asks for a release:** someone who may release now, which means holding a `provider_grant` with a `deploy` action that is live and whose giver still holds authority. Approval of a task and a merge grant give nothing (AC-17). An agent may hold the grant and ask; an agent never approves.
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

0. **The name.** A hostname is normalized before anything else: lower case, a trailing dot removed, and international names turned into their ASCII form by IDNA. Two spellings of one name are one name. A wildcard name is refused.
1. **The challenge.** A room's owner asks to map a hostname. The room's command commits the request and a random value made for this request alone. The owner publishes it as a TXT record at `_podster-challenge.<hostname>`. The value names nothing readable, and is useless to any other room or any later request. The record may hold other values beside it; any one matching is enough, so two rooms proving at once don't overwrite each other.
2. **Pending holds nothing.** A pending request doesn't reserve the name: any number of rooms may be pending for one hostname, and none of them blocks another. A pending request expires after **72 hours**, and then it is gone.
3. **Proof.** A job resolves the TXT record and compares it, in Rust. Only when it matches does the job ask the hostname's own object for the claim.
4. **One hostname, one room.** A small Durable Object per normalized hostname holds at most one live claim, since a D1 row must never authorize. It gives the claim to the first room whose proof passed, and refuses any other while that claim lives. Asking again for the same room and request gets the same answer. The room then commits the claim or the refusal.
5. **Only then is the custom hostname created at Cloudflare,** which runs its own validation. Routing starts when the room holds the claim and Cloudflare reports the hostname `active`: only then is that hostname's serve entry written.
6. **A claim never transfers.** When a room's claim ends, for any reason, the hostname's serve entry is removed first; then the job deletes the custom hostname at Cloudflare, **reads until Cloudflare reports it gone,** and only then frees the claim. A later claim, by anyone, the same room included, needs a new challenge with a new value. A DNS record left pointing at Podster proves nothing.
7. **The challenge is rechecked on a schedule,** daily, and its two ways of failing are kept apart:
   - **A definite no:** the name's own authoritative servers answered, and the value isn't there. Two such answers in a row, at least 24 hours apart, end the claim. So a record that was removed can leave its hostname routed for up to about two days.
   - **No answer:** the resolver failed, or timed out, or couldn't reach the name's servers. That by itself never ends a claim quickly, since Podster's own trouble mustn't take a customer's domain down. But a claim with no successful proof for 7 days ends. So a name whose DNS has stopped answering can stay routed for up to 7 days.
   - A successful proof resets both.
8. **A claim ends** when the room unpublishes, removes the mapping, or fails the recheck, and when Cloudflare reports the hostname `moved`.

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
| Apps a room | 1 | 1,000 scripts included in Workers for Platforms, then $0.02 each. Cloudflare's limits page says unlimited, which its pricing page contradicts |
| Files in a release | 300 | 100,000 per Worker version on a paid plan; and GitHub's 5,000 reads an hour for the release App |
| Size of a release | 25 MB in all, 5 MB a file | 25 MiB for one file; no total found; and a Worker's memory |
| Releases a room a day | 20 | Cloudflare's API allows 1,200 calls in five minutes for a token |
| The release App's reads, across the deployment | 3,000 an hour | GitHub's 5,000 an hour for an installation |
| Custom hostnames a room | 1 | 100 included, then $0.10 each, up to 50,000 |

- **What it costs,** from the pricing pages: Workers for Platforms is $25 a month, with 20 million requests and 60 million CPU milliseconds included, then $0.30 a million requests and $0.02 a million CPU milliseconds ([pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/pricing/)). Whether it needs Workers Paid first, and how many namespaces an account may have: **not found**.
- **Every request is probably billed.** Workers' own pricing says requests to static assets are free ([billing and limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)), but here every request first runs the content Worker, which is a dispatch Worker, and the Workers for Platforms pricing page charges one request for the chain and doesn't mention static assets. So assume each request to an app is one billed request and a little CPU time. A **spike** measures it.
- **Each request reads KV once,** for its host's serve entry. Workers KV on a paid plan includes 10 million reads a month, then $0.50 a million ([KV pricing](https://developers.cloudflare.com/kv/platform/pricing/)). The 30-second cache makes most of those cheap; whether a cached read is billed is a **spike**.
- **Nothing here caps traffic.** A popular or attacked app draws requests Podster pays for. A per-room request cap isn't designed, and whether one is needed is the **owner's**, as money.

### Where state lives

**Proposed.** `release_config`, each `release`, the room's hostname request and its challenge, and the outbox jobs are the room's own state, in its Durable Object, through forward-only migrations. They are authority. D1 gets at most a projection for lists, which never authorizes. The room's release epoch is room state too. A hostname's claim, and its suspension, are its own Durable Object. The KV namespace and the dispatch namespace are derived: Rust writes both, and either can be rebuilt from the rooms.

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
- **A fourth GitHub App and three secrets** to keep and rotate.
- **A new public Worker** that must never grow a binding to Podster's data. A test should fail if its configuration gains one.
- **A release is only what was committed,** and at most 300 files. An app that needs a build step must commit its built files. That is a real limit on "a working web application", and the owner's to accept.
- **Private rooms get no app** in M6.
- **An app's address changes** if it is unpublished and published again, because a label is never reused.
- **A custom domain needs a TXT record kept in place** for as long as it is mapped, and it makes the app same-site with the owner's parent domain.
- **A removed DNS record can leave a hostname routed for up to two days,** and one whose DNS has gone silent for up to seven.
- **Lifting a suspension doesn't bring an app back.** The room releases again.

## What stays open for the spikes

Each needs a resource that doesn't exist yet. [The M6 plan](../m6-plan.md#the-spikes) says which, and what can be learned with none.

1. Whether a user Worker in the namespace can reach anything of the account's without a binding.
2. Whether a user Worker can be assets only, and whether it honours `_headers` and `_redirects`.
3. The narrowest tokens that can do each publishing job, whether scripts can be separated from KV and hostnames, and what each can touch.
4. What a request to an app is billed as, and whether a cached KV read is billed.
5. How long after a serve entry is written or removed the host shows the new state. This is the takedown time. And whether the namespace's scripts can be listed, for the reconcile.
6. The custom-hostname flow end to end: that nothing routes before `active`, what a delete does and how soon, and what the room's owner must publish.
7. Whether a custom hostname can be made to reach another room's app by a `Host` header or SNI.
8. Whether a wildcard route and custom hostnames both reach one Worker on the content zone.
9. That Contents `read` alone reads a tree and its blobs at a commit; that tree entries carry sizes; what GitHub answers for a large directory.
10. Whether a sandboxing Content Security Policy closes the gap between rooms' apps without breaking ordinary static apps, and whether refusing service-worker scripts and `Clear-Site-Data` do what this ADR says.
11. Resolving a TXT record from a Worker, and which resolver.
12. Reading the content Worker's deployed version, for the reconcile.
13. Whether a 5 MB file and a batch of files fit a Worker's memory on the way from GitHub to Cloudflare.

## What an independent review should attack

Two reviews have. What a third should look at, now that the design has changed again:

- **The challenge.** Can a room get a live claim without controlling the name? Can two rooms end up routed for one hostname during a handover? Is the read-until-gone in step 6 really before the claim is freed?
- **The serve entry and the epoch.** Is there any request the content Worker serves without an entry? Any order of publish, unpublish and retry in which a room's state and what is served disagree for longer than KV takes?
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
| Takedown time from the command | The command's own handler removes the serve entries; nothing waits for the outbox ([how fast](#takedown-and-how-fast-it-is)) |
| Hostnames | Normalized; wildcards refused; several TXT values allowed; the serve entry removed before Cloudflare's delete |
| A mapped subdomain is same-site with its parent | Recorded as a consequence, and said to the owner at mapping |
| A per-file cap that fits memory | 5 MB a file, fetched one at a time as raw bytes |
| Contradictions | Two Cloudflare tokens; Contents and Metadata read; one KV read a request; public-rooms-only labelled as holding until the owner answers |

## What needs the owner's yes

Everything in [the M6 plan's table](../m6-plan.md#for-the-owner). This ADR creates nothing.

## Not verified

Everything. No spike has run, no resource exists, and no call was made to Cloudflare or GitHub. The documentation was read on 2026-11-12 through a page reader, in some cases as a summary of a long page and not word for word: Cloudflare's API token permissions page, its Workers for Platforms API reference, and GitHub's permissions table. Claims that rest on those say so above. The takedown time is arithmetic on documented numbers, one of which is "or more".

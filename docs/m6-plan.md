# M6 plan

**Status, 2026-11-12 UTC: Proposed. Nothing here is approved, built or bought.** Step 1 has started, on paper only:

- **[ADR 0010](adr/0010-release-and-the-content-domain.md): Accepted by the architect on 2026-11-12, after four independent reviews whose changes are applied. Nothing in it has been tried: the spikes settle what it lists as open. Every item in [the owner's table](#for-the-owner) is still the owner's and undecided, and no M6 code, contract, migration or cloud resource exists.** *Later on 2026-11-12: four spikes ran, and the ADR was revised with what they found, [what became of each proposal](#what-the-spikes-changed-in-adr-0010). That revision hasn't been independently reviewed. One row was added to the owner's table, the sandbox.* What the four reviews changed is [in the ADR](adr/0010-release-and-the-content-domain.md#what-the-reviews-changed).
- **The questions the architect can answer are recorded** as [decisions 197 to 211](spec/PRODUCT.md#m6-decisions-november-12-2026), each for the owner to review. The reviews changed ten of them and had one, 210, withdrawn as the owner's.
- **The questions only the owner can answer are in [the table below](#for-the-owner),** undecided. **On 2026-11-12 three of them were decided on the owner's behalf,** after the owner wrote "you should make decision on my behalf you are the chief of staff": who may open a deployed app, that an app is static files with no preview, and who may configure and approve release ([decisions 213 to 215](spec/PRODUCT.md#decisions-needed)). They are listed beneath the table.
- **The platform facts this plan called unverified were read** in Cloudflare's and GitHub's own documentation on 2026-11-12: [what was found](#platform-facts-from-the-documentation). Read, not tried. Several findings changed a proposed answer.
- **The owner said on 2026-11-12 that they have enabled Workers for Platforms on Cloudflare.** Which account it is on isn't confirmed: a read-only check of the account that holds `podster.dev`, at 01:33 UTC, was refused with Cloudflare's code 10121, no access to dispatch namespaces. Nothing has been created. *Later that day it was confirmed: the owner approved one dispatch namespace for staging on that account, and it exists ([Cloud resources](#cloud-resources)).*
- **Spikes A, B, C, E and F ran on 2026-11-12.** Spike C ran on `opster.dev`, the content domain, and everything it created is deleted: [what it found](#spike-c-results). Spike A ran on a dispatch namespace the owner approved for staging: [what it found](#spike-a-results). Everything it created is deleted, and the namespace is left empty. So Workers for Platforms is on the account that holds `podster.dev`. Spikes E and F ran with the existing staging Apps, on the architect's ruling: [spike E results](#spike-e-results), [spike F results](#spike-f-results). Spike B ran with three short-lived tokens the owner made, and everything it created is deleted: [what it found](#spike-b-results). It found no token that can publish to the namespace and can't also replace the account's other Workers, so it proposes keeping the second account. **D and G haven't run,** so the routing token, custom hostnames, the serve entry's speed, resolving a TXT record and a Worker's memory are untried. **Spike F ran and didn't answer its question:** no credential it was allowed could put a workflow file in a repository. Answering it takes a person with write access pushing one workflow file to a test repository's branch and reading the runs. *(This line said "The other four haven't", which miscounted: seven spikes are listed.)* *Later that day the owner changed the content domain to `podster.site`: "i actually would like to use podster.site domain iinsite". Spike C's results on `opster.dev` stand as what ran, and carry over by reasoning; a short confirming rerun on `podster.site` is owed before anything is served there ([Cloud resources](#cloud-resources)).*
- **No contract, migration or feature code exists for M6.** The cloud resources that exist for it are listed under [Cloud resources](#cloud-resources).

*As first written on 2026-11-10: the architect drafted this plan from the specs while the owner was away.* Items marked **owner's yes** create an account or a cloud resource, cost money, set a secret, are legal text, or loosen a security stance, so the architect can't settle them alone. [How far this was checked](#how-far-this-was-checked) says what was read.

## For the owner

**These are the owner's to decide. None in the table is decided; three that were here have been decided on the owner's behalf and are listed beneath it. This is the one list:** the plan's older "What needs the owner's yes" section now points here. Each row stands alone. Prices are Cloudflare's list prices in US dollars, as read on 2026-11-12 on the page linked in the row; they aren't a quote. "Recommended" is the architect's.

| What | Why it's the owner's | What it would cost | The architect recommends |
| --- | --- | --- | --- |
| **A content domain.** A new registrable domain, used for nothing but apps that agents wrote, on Cloudflare. **Answered by the owner on 2026-11-12: `podster.site`,** in these words: "i actually would like to use podster.site domain iinsite". It replaces `opster.dev`, named earlier that day. **Still the owner's to do:** the wildcard record on `podster.site`, an `AAAA` record with the name `*` pointing at `100::`, proxied, on whichever Cloudflare account ends up holding the content Worker; and the zone's redirect from HTTP to HTTPS. If the owner agrees to a second account, which is the next row but one and undecided, it is better to put `podster.site` there from the start than to move it later. `opster.dev`'s wildcard record can be removed whenever the owner likes | Money, a cloud resource and DNS. Its name is the owner's choice | A yearly registration. Cloudflare Registrar says it sells at what the registry and ICANN charge, with no markup ([Registrar](https://www.cloudflare.com/products/registrar/)). **No price for a `.com`, `.dev` or `.app` name was found on Cloudflare's own pages,** so no figure is given here. The zone can stay on Cloudflare's Free plan: proxied wildcard DNS records are on every plan ([wildcard DNS](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/)) and the free certificate covers first-level subdomains ([Universal SSL](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)) | **Yes.** Nothing agent-written may be served from `podster.dev`, so release can't exist without it |
| **Workers for Platforms.** Cloudflare's plan for running other parties' Workers, each isolated from the rest. It holds each room's app. **The owner said on 2026-11-12 that they have enabled it.** Which account it is on isn't confirmed: a read-only check of the account that holds `podster.dev`, at 01:33 UTC that day, was refused with Cloudflare's code 10121, no access to dispatch namespaces. *Later that day: it is on that account, and one dispatch namespace for staging exists there ([Cloud resources](#cloud-resources))* | A paid plan | **$25 a month,** including 20 million requests, 60 million CPU milliseconds and 1,000 scripts; then $0.30 a million requests, $0.02 a million CPU milliseconds and $0.02 a script. A room with an app uses up to three scripts, so the included 1,000 cover about 330 such rooms ([pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/pricing/)). Assume every visit to an app is one request | **Yes, and it is done.** It is on the account that holds `podster.dev`, confirmed on 2026-11-12 by a listing of the staging namespace, which answered empty. Whether release stays on that account is the next row, which recommends a second one |
| **A second Cloudflare account,** holding the content domain and everything that serves apps, and nothing of Podster's own | An account creation | No charge for an account was found. The plans in this table would be bought on it | **Yes, unless a test finds a narrower credential.** The credential that publishes an app can write Workers scripts, and Cloudflare's documentation shows no way to limit that to one group of scripts ([API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)). On Podster's own account it could replace Podster's API |
| **Workers Paid on that second account** | A paid plan on a new account. Whether Workers for Platforms needs it first wasn't found | **$5 a month** at least, per account ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)) | **Yes, if Cloudflare asks for it** when Workers for Platforms is bought there |
| **How the second account is deployed to, and who holds its logins.** Podster's deploy script and CI use one account today | Credentials, and a change to how Podster deploys | None | **The owner holds its login. One more deploy credential, for the content Worker only,** added to the deploy script as its own step. To be designed with the owner before anything is deployed there |
| **Custom hostnames** (Cloudflare for SaaS), so a room can map its own domain to its app | A Cloudflare feature that can be billed, and a new way for outside names to reach Podster | **100 hostnames included, then $0.10 each a month,** up to 50,000 ([plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/)) | **Yes, for a test first.** The architecture says this flow must be tried before the design is trusted |
| **A second test domain,** whose DNS a script may edit, to test mapping a custom domain | Money, a cloud resource and DNS | A second yearly registration, at cost as above; no figure found | **Yes, the cheapest name available,** or a spare domain the owner already has |
| **The content Worker.** A new public Worker that receives every request for an app and hands it to that room's app | A new cloud resource and a new public surface | Not billed by itself: Workers for Platforms charges one request for the whole chain ([pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/pricing/)) | **Yes.** It routes and never decides who may do what, and it can't reach Podster's data |
| **A Workers KV namespace,** a small key-value store the content Worker reads on each request: which app and release a host serves, and the switch that stops them all | A new cloud resource | **If the account has Workers Paid,** it includes 10 million reads and 1 million writes a month, then $0.50 a million reads and $5 a million writes. Without it, Cloudflare's free allowance is 100,000 reads and 1,000 writes a day, and operations past that fail ([KV pricing](https://developers.cloudflare.com/kv/platform/pricing/)) | **Yes, from the first step that serves anything.** An app is served only while its entry is there, so removing the entry is how it is taken down quickly |
| **A new Durable Object class** on Podster's private API: one small object per custom domain, holding which room has it | A cloud change, deployed with a migration | No separate charge was found; Podster already uses Durable Objects | **Yes, with custom domains.** One domain must belong to one room, and a database row must never decide that |
| **A fourth GitHub App** in `podsterdev`, read-only (Contents read and Metadata read), used only to read the files of a release | The owner creates and installs it and sets its key | None | **Yes.** A release should use none of the three Apps that create repositories, hand tokens to agents, or merge |
| **Three secrets on Podster's private API:** the read-only App's private key, and two Cloudflare credentials, one that publishes apps' files and one that only routes requests to them | Secrets, which the owner sets | None | **Yes,** once a test has named the narrowest credentials that work. Two Cloudflare credentials so the routing one can't replace code; one, if Cloudflare can't separate them |
| **Whether anything is served on staging before the content domain is on the Public Suffix List.** The architecture says the domain "must be on" that list, which tells browsers to keep each room's app apart from the others. Getting on it means a public request to its maintainers, who say they generally decline small projects ([publicsuffix.org](https://publicsuffix.org/submit/)) | It is a rule in the spec, and the request is made under Podster's name | None | **Make the request. Meanwhile yes for test rooms on staging only, and never for a real person's app.** Without the entry one room's app can set a cookie another's reads, and one bad app can get the whole domain blocked |
| **Whether every app is sandboxed in the browser.** Added on 2026-11-12, from spike C. Without the Public Suffix List entry, one room's app was seen reading and overwriting a cookie another's set for the whole domain. A sandboxing header closed that, and cost the app every kind of browser storage: cookies, `localStorage`, `sessionStorage`, IndexedDB, caches and service workers. The options: **(a)** sandbox every app; **(b)** no sandbox until the domain is on the list, with rooms able to interfere through cookies a script sets, which the server can't stop; **(c)** sandbox by default, with an opt-out the room's owner sets. [The ADR sets out each](adr/0010-release-and-the-content-domain.md#the-sandbox-an-open-choice-for-the-owner) | It is a product choice: what "a working web application" may do, against whether rooms are kept apart now | None | **(a), for this milestone.** It is the only one that keeps rooms apart with what Podster controls today, it fails where the owner can see it, and it can be loosened later where the others can't easily be tightened. An app that must remember something in the browser won't work under it |
| **What happens to a room's app when its owner leaves** | It decides whether content stays up with nobody answerable for it | None | **The app comes down when no person who may release remains in the room.** That is also what holds until the owner answers |
| **Who pays, and whether an app's traffic is capped** | Money | Past the included 20 million requests a month, $0.30 a million ([pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/pricing/)) | On staging Podster pays. **No cap on one app's traffic is designed;** say whether one is wanted before production |
| **Agent-written content served publicly on staging** | A new exception of the same kind as public rooms, which the takedown document's staging exception doesn't cover | None | **Yes, for test rooms,** with the operator's stop built first |
| **Cloudflare's terms for serving other parties' content.** Its developer-platform terms make the customer solely responsible for what its end users do, and let Cloudflare block or remove content it deems illegal or harmful ([service-specific terms](https://www.cloudflare.com/service-specific-terms-developer-platform/)) | A contract, which the owner accepts | None found | **Read them before buying.** They were read here only for that one point |
| **Legal text:** Podster's own terms, acceptable use and takedown, extended to apps and custom domains | Legal text; may need a lawyer | Not known | Owed before any real person's app is served |
| **Export and transfer** of a repository or an app to its owner's own account | The owner kept repository transfer and deletion for themselves in ADR 0009 | None | **Not offered in this milestone.** A release names its repository and commit, and a public repository can be copied |
| **What this milestone's gate must show:** the whole of expanded criterion 8, or only the parts this milestone builds | It decides what "done" means | Running the M2 and M4 staging checks again spends their test sign-ups | **The whole criterion,** with M2's and M4's parts shown again at the gate's commit |
| **Deeper security reviews** of the four riskiest steps: the content Worker, the release job, starting and approving a release, and custom domains | Each is asked for before it runs | Time | **Yes to each,** asked one at a time when its step is ready |

**Decided on the owner's behalf, 2026-11-12.** The owner wrote "you should make decision on my behalf you are the chief of staff". Under that the architect decided three rows that were in this table, each for the owner to review:

- **Who may open a deployed app:** a public room's app is public, and a private room's app isn't served at all in this milestone ([decision 213](spec/PRODUCT.md#decisions-needed)). Not taken: serving a private room's app to anyone with its address.
- **What an app is:** static files only, in one environment, `production`, of merged and reviewed code, with no preview of unmerged code in this milestone ([decision 214](spec/PRODUCT.md#decisions-needed)). It narrows core job 8's "working web application" and `PRODUCT.md`'s "preview/live URL" for this milestone. Not taken: code an agent wrote running on a server, and a preview environment.
- **Who may switch release on for a room and approve each release:** the room's owner and its admins, as people; an agent never, as for repositories ([decision 215](spec/PRODUCT.md#decisions-needed)). Not taken: the room's owner only, which was the interim rule.

**Everything in the table above is still the owner's and undecided.** In particular: whether anything is served before the Public Suffix List entry exists, which would loosen a "must" in the architecture; a second Cloudflare account; custom hostnames; the fourth GitHub App; the publishing credentials and other secrets; the legal text; a cap on traffic; what happens to an app when nobody who may release remains; and, added after spike C, whether every app is sandboxed in the browser. **Answered since: the content domain, `podster.site`.** Two things about that name are notes for the owner and not decisions, [below](#cloud-resources): it carries Podster's name, and `.site` doesn't force HTTPS as `.dev` does.

**If the owner wants to say yes in steps:** the fourth GitHub App alone lets one test run. Workers for Platforms and a credential let most of the rest run on a Cloudflare test address. The content domain is needed for the browser tests, and custom hostnames with a second domain for the last. [The spikes](#the-spikes) says which needs what.

## Platform facts, from the documentation

**Read on 2026-11-12, in Cloudflare's and GitHub's own documentation, and nothing else. Nothing here was tried.** Each line says in this plan's own words what the linked page says; the page is the authority. "Not found" means the pages read are silent; it isn't a guess either way. Three long pages were read partly as a summary and not word for word: Cloudflare's API token permissions, its Workers for Platforms API reference, and GitHub's permissions table.

**Workers for Platforms**

- **Price:** the paid plan is $25 a month. It includes 20 million requests, 60 million CPU milliseconds and 1,000 scripts; past those it charges $0.30 a million requests, $0.02 a million CPU milliseconds and $0.02 a script. It is bought in the dashboard ([pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/pricing/)).
- **A contradiction in Cloudflare's own pages:** the limits page says the number of scripts is unlimited, where the pricing page includes 1,000 and charges for more ([limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/limits/)).
- **Not found:** whether Workers Paid is needed first; any free allowance; how many dispatch namespaces an account may have; a script size limit of its own.
- **Billing across the chain:** one request is charged for the whole chain of dispatch Worker, user Worker and outbound Worker, and CPU time is charged across them (pricing page).
- **Isolation:** Workers in a dispatch namespace are untrusted by default. In that mode `request.cf` isn't available, each Worker's cache is its own, and `caches.default` is disabled ([Worker isolation](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/worker-isolation/)).
- **Bindings:** a user Worker reaches only the bindings explicitly attached to it ([bindings](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/)). Whether it can reach the account's other Workers without one: **not found**.
- **Egress:** an outbound Worker is invoked on every `fetch()` a user Worker makes and can allow or block hostnames; with one in place a user Worker can't open TCP sockets with `connect()`. It doesn't intercept requests made from Durable Objects or through mTLS certificate bindings ([outbound Workers](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/)). This matters only if server code is allowed.
- **Per-request limits:** a dispatch Worker can cap a user Worker's CPU time and number of subrequests per invocation; hitting either throws in the user Worker ([custom limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/custom-limits/)).
- **Can an API token be scoped to one namespace? Not found, and what was found points the other way.** The permissions page lists a "Workers Scripts Edit" permission among account permissions, giving write access to Workers scripts, and divides permissions only by zone, account and user. No permission scoped to a dispatch namespace or to Workers for Platforms appears, and the permission the namespace's upload endpoint needs isn't stated on the pages read ([API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)). **This changed question 3's answer.**

**Static files**

- **A user Worker in a namespace can have static assets,** uploaded in three calls: an upload session with a manifest of each file's hash and size; the files, in the batches the session names; then the script's upload naming the completed session ([static assets for user Workers](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/static-assets/)).
- **Limits:** 100,000 files per Worker version on a paid plan and 20,000 on Free; 25 MiB for one file ([limits](https://developers.cloudflare.com/workers/platform/limits/)). No limit on a release's total size was found.
- **Requests served from static assets are free and unlimited** ([billing and limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)). Whether that holds behind a dispatch Worker: **not found**.
- **A Worker with assets and no script:** not stated. The page says only that with no script, a request matching no file gets a 404.
- **Reading back what was uploaded:** **not found.** So the release job confirms a release by fetching a file of its own through the host.
- **`_headers` and `_redirects`:** the limits page gives limits for both (100 header rules, 2,100 redirects), so the platform reads both from an uploaded directory. How to switch them off: **not found**. **This changed the release job:** it never uploads either file.

**The content domain, hosts and certificates**

- **Wildcard routes:** a route pattern whose hostname begins with `*.` matches every subhost, and a host needs a DNS record to be proxied and to invoke a Worker ([routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)).
- **Wildcard DNS:** proxied wildcard records are available on all plans ([wildcard DNS records](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/)).
- **Certificates:** on a full setup, Universal SSL covers the root domain and first-level subdomains, and not deeper levels ([limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)). So per-room hosts must be one level deep.

**Custom hostnames (Cloudflare for SaaS)**

- **Price:** 100 hostnames included on Free, Pro and Business, $0.10 for each more, and a maximum of 50,000 ([plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/)).
- **Ownership before traffic:** Cloudflare verifies the customer's ownership of a hostname before it proxies traffic through it ([hostname validation](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/)). That traffic doesn't route while a hostname is `pending` is implied and not stated in so many words.
- **Methods:** ahead of time by a TXT record or an HTTP token, or at the moment the customer adds their DNS record, which the page says may cause some downtime. Pre-validation isn't supported for a hostname whose zone is already on Cloudflare.
- **When DNS moves:** the hostname becomes `moved`, and is deleted after more than seven days in that state ([validation status](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/validation-status/)).
- **Its certificate:** validated by `http`, `txt` or `email`, or by delegated validation. Whether issuing it publishes the hostname in certificate-transparency logs: **not found**.
- **To a Worker:** a Worker can be the origin for the zone's custom hostnames, with the route `*/*` and no route per hostname ([Workers as your fallback origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/)).

**GitHub**

- **Reading a directory at a commit needs Contents `read`:** the permissions table lists it for getting repository content, a tree, a blob and an archive, with no other permission ([permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps), read as a summary). Whether Metadata `read` is also needed: **not found**.
- **Limits:** the Contents endpoint lists at most 1,000 files for a directory and points to the Git Trees API for more; a recursive tree holds up to 100,000 entries and 7 MB, and marks itself `truncated` past that; a blob is supported up to 100 MB ([contents](https://docs.github.com/en/rest/repos/contents), [trees](https://docs.github.com/en/rest/git/trees), [blobs](https://docs.github.com/en/rest/git/blobs)). **This set how the release job reads:** trees and blobs.
- **Symlinks and submodules:** a tree entry's mode is `120000` for a symlink and `160000` for a submodule.
- **Tokens:** an installation token can be limited, when it is made, to named repositories and to a subset of the App's permissions, never more than the App has, and expires after an hour ([installation access tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)).

**The Public Suffix List,** from its own site, which is neither Cloudflare's nor GitHub's: a request for a private entry must come from the domain's owner, and the maintainers say they generally decline small projects and experimental or short-term entries ([publicsuffix.org](https://publicsuffix.org/submit/)). Its guidelines wiki, which holds the acceptance criteria, wasn't read; how long acceptance or browsers take: **not found**.

**Added on 2026-11-12, for the review's questions**

- **Workers KV:** on a paid plan, 10 million reads, 1 million writes, 1 million deletes and 1 GB a month are included; then $0.50 a million reads and $5 a million writes ([KV pricing](https://developers.cloudflare.com/kv/platform/pricing/)). A write is usually visible at once where it was made and may take up to 60 seconds or more elsewhere; the shortest cache lifetime a read may ask for is 30 seconds ([how KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/), [KV limits](https://developers.cloudflare.com/kv/platform/limits/)).
- **Workers Paid:** at least $5 a month for an account, with 10 million requests and 30 million CPU milliseconds included ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)).
- **`_headers` and `_redirects`:** up to 100 header rules; 2,000 static and 100 dynamic redirects. Both apply to static asset responses and not to responses from Worker code. Switching either off: **not found** ([headers](https://developers.cloudflare.com/workers/static-assets/headers/), [redirects](https://developers.cloudflare.com/workers/static-assets/redirects/)).
- **Static assets under Workers for Platforms and billing:** neither the Workers for Platforms pricing page nor its static-assets page says static requests are free there. Only Workers' own pricing does. So each request to an app is assumed to be billed.
- **Pre-validation of a custom hostname** isn't supported when its zone is already on Cloudflare, and its TXT record goes at `_cf-custom-hostname.<hostname>` ([pre-validation](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/pre-validation/)). The first draft cited the parent page for this.
- **Removing a custom hostname:** a delete removes it and its certificates; one that isn't removed keeps routing to the service. Whether a delete takes effect at once: **not found** ([remove custom hostnames](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/remove-custom-hostnames/)).
- **Cloudflare Registrar** says it charges what registries and ICANN charge, with no markup. A price for `.com`, `.dev` or `.app`: **not found on Cloudflare's own pages** ([Registrar](https://www.cloudflare.com/products/registrar/), [about](https://developers.cloudflare.com/registrar/about/)).
- **Cloudflare's terms:** the developer-platform terms name Workers for Platforms, make the customer solely responsible for its end users' acts, and let Cloudflare block or remove content it deems illegal or harmful ([service-specific terms](https://www.cloudflare.com/service-specific-terms-developer-platform/)). Cloudflare for SaaS isn't named on the pages read.
- **GitHub's rate limits:** an installation's token gets 5,000 requests an hour, 50 more for each repository past 20, up to 12,500; no more than 100 at once and 900 points a minute for one endpoint ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)). A tree entry carries a `size`, by the page's schema, where it isn't marked required ([trees](https://docs.github.com/en/rest/git/trees)).

**Where the facts changed a proposed answer:**

1. **Question 3, which Cloudflare account.** It was "decided by the spike: the same account only if the publishing token can be scoped". Nothing in the documentation scopes a token below the account for Workers, so the working assumption is now **a second account**, and the spike's job is to show otherwise.
2. **The release job never uploads `_headers` or `_redirects`,** which the platform would read. Not in the plan before. *(After spike A: the rules reach the platform only as `assets.config` in the script's metadata, and the job sends no `assets.config` at all; refusing the files by name stays as a second guard.)*
3. **The KV namespace.** The first reading said it was needed only for custom hostnames. **The reviews reversed that:** it is needed from the first step that serves anything. It holds an entry for each host that may be served, and the stop for the whole domain; a host with no entry isn't served.
4. **The release job reads through Git Trees and Blobs,** since the Contents listing stops at 1,000 files. **And the cap fell to 300 files:** a release costs one read a file, and one installation gets 5,000 reads an hour for every room.
5. **The Public Suffix List entry may be refused** while Podster is small. Whether anything is served before it exists is now the owner's, since the architecture says the domain must be on the list.
6. **Taking an app down takes about two minutes,** by the documented numbers: up to 60 seconds for a KV write to be seen everywhere, then up to 60 for what was already cached. Cloudflare says "or more" of the first. *(Later on 2026-11-12, after spike A: that is still only arithmetic. A change in the namespace usually showed in about a second and once took 74; nothing about a serve entry is measured until spike G. [The ADR restates it](adr/0010-release-and-the-content-domain.md#takedown-and-how-fast-it-is).)*

## The spikes

**A, B, C, E and F ran on 2026-11-12: [spike A results](#spike-a-results), [spike B results](#spike-b-results), [spike C results](#spike-c-results), [spike E results](#spike-e-results), [spike F results](#spike-f-results). D and G haven't. F ran without answering its question.** What the four changed in ADR 0010 is [what became of each proposal](#what-the-spikes-changed-in-adr-0010). Each stays in `spikes/` and nothing builds on it. "Needs" is what must exist first, and so what waits for the owner.

| Spike | What it proves | Needs, and so waits for | What can be learned with no resource |
| --- | --- | --- | --- |
| **A. A room's app in a namespace** | **Ran on 2026-11-12.** Not answered: what a request costs (risk 9's billing half).  That a user Worker with static assets and no bindings serves files and can reach nothing of the account's; whether it can be assets only; whether it honours `_headers` and `_redirects`; how long an upload and a delete take to show; what a request costs (risks 1, 2, 4, 5, 9) | **Workers for Platforms** ($25 a month) and an API token. A `workers.dev` host will do | The upload's three calls and their shapes, from the documentation; the release job's manifest and hashing, written and tested against a stand-in |
| **B. The publishing token** | **Hasn't run.**  The narrowest token that uploads to and deletes from one namespace, and whether it can touch the account's other Workers. Decides one account or two (risk 3) | **Workers for Platforms** and the owner making tokens of different scopes | Nothing more: the documentation was read and doesn't say |
| **C. The content domain and its hosts** | **Ran on 2026-11-12,** in three headless browsers. Not answered: the Public Suffix List's own questions.  That a wildcard route and one certificate serve every per-room host; that a page on one host can't touch `podster.dev`'s cookies; what one room's app can do to another's without the Public Suffix List entry; whether a sandboxing Content Security Policy closes that; service workers and `Clear-Site-Data` (risks 6, 12, 13) | **The content domain** on Cloudflare, and spike A | The cookie and header behaviour in current browsers, on two local hostnames; the Public Suffix List's guidelines, which weren't read |
| **D. Custom hostnames** | **Hasn't run.**  That nothing routes before a hostname is `active`; what the room's owner must publish; what happens when their DNS moves; whether a `Host` header or SNI can reach another room's app; that custom hostnames and the wildcard both reach the content Worker (risks 7, 8, 12) | **The content domain, Cloudflare for SaaS, and a second domain whose DNS a script may edit** | The claim's two-object commit, written and tested in `crates/core` with no Cloudflare at all |
| **E. Reading a release from GitHub** | **Ran on 2026-11-12,** on one public repository with an existing App's token cut down. Not shown: a private repository.  That Contents `read` alone reads a tree and its blobs at a commit, for a private and a public repository; what GitHub answers for a large directory and a large file; that symlinks and submodules are seen as such; rate limits (risks 10, 11) | **The fourth GitHub App.** Until it exists, the same reads can be tried with an existing staging App's token cut down to Contents read on a test repository, which changes no App's permissions | The tree-walking and refusal rules, written and tested against recorded answers |
| **G. A hostname's proof and a takedown's speed** | **Hasn't run.** Spike A answered one part: the namespace's scripts can be listed.  That a TXT record can be resolved from a Worker and by which resolver, and that a definite no can be told from no answer; how long a serve entry's writing and removal take to show at the host, which is how fast an app comes down; whether the namespace's scripts and the KV namespace's keys can be listed; what a read-back that doesn't match means when KV can answer with a value up to 60 seconds old; how long the wait for a release's marker must be; how the content Worker's deployed version is read; whether a 5 MB file fits a Worker's memory | **Workers for Platforms, a KV namespace** and, for the hostname half, any domain whose DNS a script may edit | The challenge's rules and its expiry, written and tested in `crates/core` with no network |
| **F. Actions switched off** | **Ran on 2026-11-12 and didn't answer it:** no credential it was allowed could put a workflow file in a repository. It takes a person with write access pushing one to a test repository's branch, then reading the runs.  From ADR 0009, still open: whether a workflow already in a repository can run with Actions off for it (risk 14) | Nothing new: the staging organization and Apps exist | It may already be answered by M5's runs; that wasn't checked for this plan |

**In order, if the owner says yes in steps:** E and F need nothing bought. A, B and G need Workers for Platforms. C needs the domain. D needs the domain, custom hostnames and a second domain.

## Spike E results

**Run on 2026-11-12 UTC, three times, against one public test repository, `podsterdev/e2e-m5-202611120015-ae33-7c9b19`, a leftover of M5's acceptance run.** The script, its results and exactly what it wrote are in [`spikes/m6-release-read/`](../spikes/m6-release-read/README.md). The read token was the staging agent App's, cut down when minted to Contents `read` on that one repository; no fourth App exists. Every number below is from the last run unless it says otherwise. Each was seen on this one repository on this one day.

**What wasn't shown, first:**

- **A private repository.** None exists to read and making one is outside what was allowed. Managed repositories are public, so this is the case M6 has.
- **So what Contents `read` unlocks wasn't shown at all.** On a public repository nothing that was read is refused without it: see answer 1.
- **A Worker's memory.** The reads ran in Node on a laptop. Whether 5 MB and a batch fit a Worker is still spike G's.
- **A secondary rate limit.** None was hit and none was provoked, since the installation is staging's.
- **The fourth App's own limit,** and the higher limit GitHub documents past 20 repositories.

### The answers

**1. Contents `read` alone reads a tree and its blobs at an exact commit.**

- Asked for `{"contents":"read"}`, the token came back with `contents: read` and `metadata: read`: **Metadata `read` is added by GitHub without being asked for.** A token asked for `{"metadata":"read"}` alone got only that. Both lasted 60 minutes and listed the one repository.
- With it: the commit `200`, the tree by the commit's sha `200`, the release directory's tree with `recursive=1` `200`, a blob as JSON and as raw bytes `200`. All 300 files of a 300-file directory, fetched raw, hashed to the shas the tree gave.
- **Refused with it,** each `403` "Resource not accessible by integration": making a blob, making a branch, and reading the Actions setting.
- **On a public repository the permission isn't what allows the reads.** The Metadata-only token read the same tree and blob, `200`. So did a request with no credential. The Contents-read token, limited to one repository, also read the other test repository's tree, `200`, and was refused only when it tried to write there, `403`. What the token gives on a public repository is the installation's request allowance in place of the 60 an hour an address gets; the limit to one repository confines writes, which this token has none of, and reads of private repositories, which wasn't shown.
- **`GET /git/trees/{commit}:{path}` works, and follows a submodule entry.** For the release directory it answered `200` with that directory's tree. For a symlink or a file it answered `422`, "SHA must identify a commit or a tree"; for a missing path `404`. **For a submodule entry whose commit is in the same repository it answered `200` with that other commit's tree.**

**2. A large directory.**

- **`truncated` didn't come at 7 MB of answer, nor at 100,000 entries.** A recursive tree of 72,060 entries came back whole in 17.7 MB. Truncation came at 96,643 entries and 23.7 MB where paths were 14 bytes long, and at 80,653 entries and 21.0 MB where they were 29, the same on each of three runs. Both fit a limit of 7 MiB counted as about each path's length plus 62 bytes, not the JSON's size. That is two points and an inference.
- **A truncated answer stops mid-directory:** the first ended at `d080/f0561.txt`, with status `200` and nothing else to mark it.
- **Not recursive, one directory of 40,000 files came back whole,** in 9.6 MB. A directory of 1,200 files: 1,200 entries, 288 KB.
- **Walking without `recursive`** costs one read a directory: 102 reads listed all 121,200 files of 101 directories in 4.7 seconds, eight at a time, none truncated.
- **The Contents API listed 1,000 of a directory's 1,200 files,** status `200`, with nothing to say the rest were missing.

**3. A large file.**

- **The limit is 100 MB, at the push.** A 99 MiB file was pushed with a warning that GitHub recommends at most 50 MB. A 101 MiB file was refused: "exceeds GitHub's file size limit of 100.00 MB". So no blob over 100 MB can be in a repository to ask for.
- **The blob API answered every size it was asked,** `200`, as JSON and as raw bytes: 0 bytes, 1 KiB, 1 MiB, 5 MiB, 25 MiB and 99 MiB.
- **As JSON a file is 1.378 times its size,** not four thirds: the base64 has a line break every 60 characters, escaped in the JSON. 5 MiB was 7.22 MB, 25 MiB was 36.1 MB, 99 MiB was 143 MB.
- **`Accept: application/vnd.github.raw+json` avoids base64 entirely:** the answer is the file's bytes, exactly its size, the same sha256, at every size. 5 MiB took 0.4 seconds, 25 MiB 1.6, 99 MiB 5.3.
- **The raw answer's `Content-Type` is GitHub's guess:** `application/octet-stream` for most, `text/plain; charset=utf-8` for the HTML file and the empty one, and `text/plain; charset=utf-16be` for the 5 MiB file of patterned bytes.
- **The tree gives each file's size exactly,** including 5 MiB and 5 MiB and one byte, so the cap can be applied before anything is fetched.
- The Contents API, asked for the 5 MiB file as JSON, answered `200` with an empty `content` and `encoding: "none"`.

**4. Symlinks, submodules, modes and odd paths.**

- **A symlink is `mode 120000`, `type blob`,** with a size that is the length of its target. Its blob is the target's path, `../../../../etc/passwd` for the one that points outside.
- **A submodule is `mode 160000`, `type commit`,** with no size. Asked for as a blob its sha is `404`.
- **A directory is `mode 040000`, `type tree`, with no size.** An empty directory can exist and shows as one.
- **An executable file is `mode 100755`;** an ordinary one `100644`.
- **The Contents API follows a symlink inside the repository:** asked for the symlink it answered `type: file`, size 39, and the target's content. Trees and blobs follow nothing.
- **Paths that can exist, and came back as written:** a space, leading and trailing spaces, a tab, a newline, a backslash, a leading dot, `...`, a leading dash, `a?b#c%20d&e.txt`, non-ASCII letters, the same name composed and decomposed as two entries, two names differing only by case, a segment of 300 bytes, a path of 1,265 bytes, `_headers`, and `.well-known/podster-release.json`.
- **A name that isn't UTF-8 can exist, and arrives with U+FFFD in place of the bad byte.** The tree's JSON can't show which byte it was.
- **Paths that can't exist.** `git push` was refused for a tree holding `..`, `.`, `.git`, `.GIT`, a name with a slash in it, the same name twice, and `.gitmodules` as a symlink, each by GitHub's own check of the pushed objects. The git data API refused `..`, `a/../b`, `.git/config`, `./a` and `a//b`, each `422`. An empty name never left the laptop: git itself refused to send it.

**5. Rate limits.**

- **A release of 300 files cost 301 requests, and the count rose by exactly 301:** one tree and 300 blobs. Ten at a time it took 9.2 seconds; thirty at a time, 3.9. Every answer was `200`, with no `retry-after`.
- **Read as answer 1 says it must be, a release costs *n* + 2:** the commit's top tree, the directory's tree, and the files.
- **The installation's limit is 5,000 an hour, by its headers,** `x-ratelimit-limit: 5000`, resource `core`. After the three runs it showed 2,264 used.
- **One count for the installation.** Five tokens of the agent App, for one repository, the other, and both, with different permissions, each moved the same count by one. The provisioning App's installation has its own.
- **A reread with `If-None-Match` answered `304` and cost nothing.** `GET /rate_limit` cost nothing.
- **A second count, not explained.** A token read within a moment of being minted reported a different count with a different reset, 60 used where the other said 2,259, and five seconds later reported the main one. *This bullet said "Between 14 and 24 of each run's first requests went to it." The committed results don't hold what would check that figure, so it is withdrawn: some of each run's first requests were counted there, and how many isn't recorded.*
- **A tarball of the commit** is one request, `302` to `codeload.github.com`. It is the whole repository, not a directory, and wasn't downloaded.

**6. A private repository can't be shown,** as above.

### What each changes in ADR 0010

Proposals for the architect. None rewrites a decision. *Disposed of on 2026-11-12: [what became of each proposal](#what-the-spikes-changed-in-adr-0010).*

1. **How the tree is read. "Read the tree of the release directory at that exact commit" should say how:** read the commit's top tree by its sha, not recursive; require the release directory's entry to be `mode 040000`, `type tree`; then read that tree's sha with `recursive=1`. **Never `{commit}:{path}`,** which follows a submodule entry to a commit nobody confirmed. So a release costs *n* + 2 reads, not *n* + 1: 302 at the cap.
2. **Cap the bytes of a tree answer before parsing it.** The ADR relies on `truncated` to stop a large directory. At the two path lengths tried, 14 and 29 bytes, a tree wasn't marked truncated until its answer was 21.0 and 23.7 MB; where that starts for other path lengths wasn't tried. A directory that isn't recursive came back at 9.6 MB unmarked. *(Tightened on 2026-11-12: this said "isn't marked truncated until its answer is past 20 MB", as if for every tree.)* A release of 300 files with 1,024-byte paths is under 400 KB of JSON. **Proposed: read at most 1 MB of either tree answer and fail the release past it,** and cap entries of every kind, since directories, empty ones included, are entries the file count doesn't see. `truncated` still fails the release.
3. **"GitHub marks a recursive tree `truncated` past 100,000 entries or 7 MB" isn't what was seen.** Proposed wording: truncation was seen at 80,653 and 96,643 entries, in answers of 21 and 24 MB.
4. **"An entry with no size fails the release" must mean a file's entry.** Directories and submodules never carry one.
5. **"Valid UTF-8" can't be checked from the tree.** Proposed: a path holding U+FFFD fails the release.
6. **Add a rule beside the case rule:** two paths that are the same after Unicode normalization fail the release. And say which modes pass: `100644` and `100755` for a file, `040000` for a directory, anything else refused. An executable file is published as an ordinary one.
7. **Check each fetched file against the tree:** its length against the tree's size and its git blob sha against the tree's sha. Shown on 300 of 300.
8. **Never pass on GitHub's `Content-Type`** for a raw blob. It is a guess, and was `utf-16be` once.
9. **The reason for raw bytes is the Worker, not GitHub.** GitHub answered a 25 MiB file as 36 MB of JSON. The ADR's "which a 25 MB file wouldn't fit" is about a Worker's memory, which spike G tests. The overhead to state is 1.378, not a third.
10. **Why trees and blobs gains a reason:** the Contents API follows symlinks, and lists 1,000 files of more with no sign.
11. **The 300-file cap fits, and should stay.** 302 reads is 6% of the hour. The budget of 3,000 an hour is nine releases of that size, not ten. "A few at a time" can be ten: 9 seconds a release, far from the 100 at once GitHub allows.
12. **Podster must count its own reads.** The headers are one count for the installation, as the ADR assumes, but a new token's first requests are counted elsewhere, and a `304` isn't counted. The header is a check on Podster's count and not the count.
13. **The permissions stand:** Contents `read`, with Metadata `read` arriving by itself. The ADR should say that on a public repository the token isn't what confines the job to one repository or one directory: the job's own requests are.
14. **The path rules stand,** and each forbidden thing that can exist was seen to exist: backslash, tab, newline, over-long segments and paths, `_headers`, a file at the marker's path. `.` and `..` can't be pushed; the rule against them costs nothing and stays.

### Still unknown

- Everything about a private repository, and so what a token without Contents `read` is refused.
- Whether truncation really is 7 MiB of path plus 62 bytes: two points fit it.
- What the second request count is.
- Secondary limits: where they start for this kind of read.
- Whether GitHub ever omits a file's `size`. It didn't here; its schema doesn't require it.
- A Worker's memory with a 5 MB file and a batch.

## Spike F results

**Run once, on 2026-11-12 UTC, on the same test repository. The question isn't answered: no credential the spike was allowed can put a workflow file into a repository, so none was there to run.** What was learned is narrower: the agent App's token, with Contents `write`, on one repository, was refused a workflow file by three routes. *(Tightened on 2026-11-12: this said "the way in is shut for every token Podster gives out". Only that one App's token on that one repository was tried; the provisioning and merge Apps' tokens weren't.)*

**M5's evidence doesn't answer it either.** M5-06g showed the agent's token refused a workflow file by the Contents API and by `git push`, and refused the Actions setting, each `403` ([the run record](m5-plan.md)). Provisioning's read-back requires Actions off before a link is ready. Neither had a workflow file in a repository.

**What this run saw:**

- **Actions are off on both test repositories.** The provisioning App's token, cut down to Administration `read`, read `enabled: false` on each, `200`, and default workflow permissions `read` with no approving of pull requests. The organization's setting: `403`, as before. Neither default branch holds a `.github` directory.
- **The agent App's token, with Contents `write`, was refused a workflow file three ways:** by the Contents API on a non-default branch, `403`; by the git data API, which made the blob, `201`, and refused the tree that would have named it `.github/workflows/m6-spike-f.yml`, `403`; and by `git push` to a new branch, "refusing to allow a GitHub App to create or update workflow … without `workflows` permission". The first and third repeat M5-06g; the second is new.
- **Starting a workflow by the API:** `403`.
- **Workflows listed: 0. Runs: 0,** before the attempts and 45 seconds after.
- **Nothing was written but one blob on no branch,** and no setting was changed.

**What it changes.** Nothing in ADR 0010. For ADR 0009's "Unverified: whether a workflow already in a repository can be abused", the proposed wording is: the agent App's token, on one test repository, couldn't add one by three routes; the other Apps' tokens weren't tried; and the question of one that is already there stays untested. *(Tightened on 2026-11-12: this said "no token Podster mints can add one".)* ADR 0009 isn't edited by the PR that records this; the wording is for the architect to place.

**Still unknown, and what would settle it:**

- **Whether a workflow file in a repository runs with Actions off.** GitHub's documentation wasn't reread for this. Settling it needs a workflow file put in by something that can: an App with the Workflows permission, which no App here may be given, or a person with write access to a test repository. A person pushing one workflow file to a test repository's branch, then reading the runs, is the whole test.
- **Whether the merge App can merge a pull request that adds a workflow file,** from a fork for instance. It holds no Workflows permission, so GitHub may refuse; not tried, since it needs a second account and a merge to a default branch.
- **Workflows on pull requests from forks with Actions off.**


It covers [M6 Release](spec/PRODUCT.md#product-direction-and-delivery-scope), which the milestone table gives one line: "Workroom-level deployment, separate content domain, custom domains". Its gate in that table is "Expanded criteria 7 and 8" of the [expanded workroom acceptance criteria](spec/PRODUCT.md#expanded-workroom-acceptance-criteria). It starts from the [release and deployment design](spec/ARCHITECTURE.md#release-and-deployment-m6), which is four bullets and two record shapes, and from [decision 11](spec/PRODUCT.md#decisions-needed), which is a recommendation and not decided.

M6 is the first time Podster serves code and markup that agents wrote, to anyone on the internet, from infrastructure Podster pays for. So the plan settles where that content is served, what it can reach and who can stop it before any feature code.

## Spike A results

**Run once, on 2026-11-12 between 09:01 and 09:23 UTC, on staging's namespace `podster-staging-apps`. Everything it created is deleted.** The code, how to run it again and every observation are in [`spikes/m6-namespace-app`](../spikes/m6-namespace-app/README.md). This section gives the answers and what each would change in [ADR 0010](adr/0010-release-and-the-content-domain.md). **The changes are proposals: the ADR isn't edited here.** *It was edited later that day: [what became of each proposal](#what-the-spikes-changed-in-adr-0010).*

**What was tried.** A small dispatch Worker on a `workers.dev` address, in front of the namespace. Into the namespace went 38 short-lived test scripts: static files with a script, static files alone, static files with `_headers` and `_redirects`, a script that reports what it can reach, twelve rounds of upload, replace and delete, and eighteen odd names.

**How it was run, and what that limits.** Every API call was made by a `wrangler` command under the existing login; no API token was made or read. So the calls seen are the ones wrangler 4.157.0 makes, and anything wrangler can't send [wasn't shown](#what-stays-unknown-after-spike-a). All requests came from one machine.

### The answers

| # | Question | Answer |
| --- | --- | --- |
| 1 | Does a user Worker with static files and no bindings serve them through a dispatch Worker? | **Yes.** Files came back 200 with the right type, `cache-control: public, max-age=0, must-revalidate` and an `etag`. The API listed the script's bindings as `[]`. `/index.html` answered 307 to `/`, and `page.html` was served at `/page`: the platform rewrites HTML paths by default |
| 2 | Can it be assets only? | **Yes.** The upload carried no script at all. A path with no file got 404 with an empty body; a `POST` got 405 on a file |
| 3 | Are `_headers` and `_redirects` honoured? | **Only when the uploader sends them.** Wrangler leaves both files out of the upload and sends their text as `assets.config._headers` and `assets.config._redirects`. Sent that way every rule applied: a header, a `Set-Cookie`, a Content Security Policy, a one-year cache lifetime, and a 302 to another site. A `_headers` file deeper in the directory was served as an ordinary file and set nothing |
| 4 | What can the user Worker reach? | `env` was empty, `request.cf` undefined, and `caches.default` refused. **`fetch()` to the public internet worked,** and so did a TCP socket to a host not behind Cloudflare. A `fetch` to another Worker of the same account on `workers.dev` got 404, error 1042; to an IP address, 403, error 1003. **With an outbound Worker, every `fetch()` went to it,** which blocked, answered or passed each one, and sockets stopped working. The dispatch Worker served as its own outbound Worker, so nothing more was created |
| 5 | The upload's calls | Three, as documented, with [their bodies recorded](../spikes/m6-namespace-app/README.md#5-the-uploads-calls). The session answers with a one-hour token and the hashes it wants, each once. Files go as base64 parts named by hash, answered 202 then 201 with a second one-hour token. The script's `PUT` carries only a `metadata` part naming that token. **A hash is 32 hexadecimal characters, and it comes back as the file's `etag`.** The hashes wrangler computed were accepted; whether Cloudflare checks a hash against the bytes, or accepts arbitrary values, wasn't tried |
| 6 | How long until a change shows? | Over twelve rounds, measured from the API's answer: **an upload 0.5 to 2.5 s, a replace 0.6 to 74 s, a delete 0.4 to 6.1 s,** each with a median of 0.9 s. One replace served the old file for 74 seconds. One delete served the deleted file once more after the first not-found |
| 7 | "Gone", and the list | **Reading a deleted script answers 200 with `"script": null`,** not 404. Deleting it again answers 404, code 10007. The namespace's scripts are listed by one `GET`, an array of objects with `id` and `tag`; the list's `has_assets` was wrong. The namespace's own read carries `script_count` |
| 8 | Script-name rules | **No rule was met in the names tried:** lengths of 63, 64, 65, 100, 255, 256, 512, 1,024, 2,048 and 4,096 characters, and upper case, `_`, `--`, a trailing `-`, `.`, `~`, `:` and `+`. Each was accepted and served. `/`, `%`, a space and anything outside ASCII weren't tried. **Names are case-sensitive** |
| 9 | A dispatch to a missing script | `env.DISPATCH.get(name)` returns without error. **`fetch()` on it rejects with an `Error` whose message is `Worker not found.`** The same for a deleted script |
| 10 | What a request costs | **Not measured.** The login can't read billing or analytics. The documentation still says one request is charged for the whole chain, and still doesn't say static files are free under Workers for Platforms |

### What each would change in ADR 0010

**Proposed, for the architect.** Each names the ADR's section.

1. **[Where content is served](adr/0010-release-and-the-content-domain.md#where-content-is-served): a release is assets only.** The ADR's fallback, "one fixed file of Podster's that serves nothing itself", isn't needed. With no script there is no code of anyone's in the namespace.
2. **The same section: say which HTML handling a release is uploaded with.** By default `/index.html` redirects to `/` and `x.html` is served at `/x`. The content Worker must pass those redirects on, and their `Location` is a path, which is right on a host of the app's own. Two things follow for [what a release may contain](adr/0010-release-and-the-content-domain.md#the-release-job): `page.html` and `page/index.html` may now name one address, and the marker, being `.json`, is untouched. The alternative is `html_handling: "none"`, which wasn't tried.
3. **[`_headers` and `_redirects`](adr/0010-release-and-the-content-domain.md#what-content-can-reach): the control is that the job never sends `assets.config._headers` or `assets.config._redirects`.** The platform doesn't read those files from the upload; the uploader hands their text over. The job writes that metadata itself and takes none of it from the repository. Refusing a release that holds either file stays as a second guard, and one test is owed: a root `_headers` sent as a plain file must come back as content with no effect.
4. **[What content can reach](adr/0010-release-and-the-content-domain.md#what-content-can-reach): the content Worker builds its response headers from a short list it allows,** and doesn't only overwrite the ones it knows. A header it didn't name passed through the dispatch Worker in the spike. It also decides what to do with a 3xx whose `Location` is another site.
5. **The same section, "The network, from the server":** the claim that server code could be fenced by an outbound Worker now has evidence, and so does the claim that without one a user Worker reaches the internet by `fetch` and by socket. It matters only if the owner allows server code. An outbound Worker that refuses everything could be added as a guard at no cost in resources, since the content Worker can be its own; that is a suggestion, not a need, while releases are assets only.
6. **[The release job](adr/0010-release-and-the-content-domain.md#the-release-job), step 4: the manifest's hash should be derived from the content, and it is public.** It is served as the `etag`, and a browser's revalidation rests on it. So the hash must change when the bytes or the served type change. A truncated SHA-256 over the bytes and the content type would do; GitHub's blob SHA alone wouldn't cover the type. Files already sent for one script are asked for again under another name, so with one script for each release every release sends every file.
7. **[The marker](adr/0010-release-and-the-content-domain.md#the-release-job) stays.** Nothing read back a script's files. A path under `.well-known` was uploaded and served.
8. **The job's step 6, the marker's wait:** a new script showed within 2.5 seconds of the API's answer in twelve tries. A wait of 30 seconds is proposed, from twelve samples at one place; one replace took 74 s. The marker's wait is for a new script, and no new script took that long, but twelve tries from one machine don't show how long one can take.
9. **[One script for each release](adr/0010-release-and-the-content-domain.md#publishing-and-unpublishing-in-order) is right, and now has a second reason:** replacing a script in place once left the old files served for 74 seconds after the API said it was done.
10. **[Unpublishing](adr/0010-release-and-the-content-domain.md#unpublishing), step 3, and [rollback](adr/0010-release-and-the-content-domain.md#rollback): say what Cloudflare's "gone" is.** A script is gone when its read answers 200 with `"script": null`, or when a delete answers 404 with code 10007. A job that waits for a 404 on the read never finishes. Rollback's "the kept script still exists" is that same read answering with an object.
11. **[Takedown](adr/0010-release-and-the-content-domain.md#takedown-and-how-fast-it-is): deleting a script isn't the fast path, as the ADR already has it.** A delete took up to 6.1 seconds to show and once went back to serving the file. Removing the serve entry stays the stop; spike G measures that.
12. **The hourly reconcile can list the namespace,** with one `GET`. It should trust `id` and nothing else in the list, and its paging is still to be read.
13. **[Script names](adr/0010-release-and-the-content-domain.md#where-content-is-served): no rule was met in the names tried, so the ADR must set its own.** The names tried were lengths of 63 to 4,096 characters, upper case, `_`, `--`, a trailing `-`, `.`, `~`, `:` and `+`; what Cloudflare refuses beyond those isn't known. Proposed: lower case only, since names are case-sensitive; a stated maximum length; and a separator such as `_` or `.`, with labels made only of characters that exclude it. The content Worker treats a rejected `fetch` with the message `Worker not found.` as not-found, and any other rejection as an error it doesn't serve.
14. **[Budgets](adr/0010-release-and-the-content-domain.md#budgets-and-account-limits): nothing changes.** "Every request is probably billed" is still an assumption.
15. **[What stays open for the spikes](adr/0010-release-and-the-content-domain.md#what-stays-open-for-the-spikes):** item 2 is answered. Item 1 is answered for what was tried: no bindings, no cache, and no path to the account's other Workers by `fetch`. Item 5's listing of scripts is answered; its serve-entry half is spike G's.

### What stays unknown after spike A

- **What a request is billed as.** It needs the dashboard or an analytics token.
- **Whether Cloudflare checks a manifest's hash against the bytes,** and how it sizes a bucket. Wrangler computes its own hashes.
- **A root `_headers` or `_redirects` sent as a plain file.** Wrangler never sends one.
- **Whether the script's `PUT` needs wrangler's two query parameters,** `excludeScript=true` and `bindings_inherit=strict`.
- **Timings from more than one place,** and for a release of 300 files or of 25 MB. Each test file was a few bytes.
- **Why one replace took 74 seconds.** It happened once in twelve.
- **How the list of scripts pages,** and names holding `/`, `%`, a space or anything outside ASCII.
- **Per-request limits** on CPU and subrequests, which weren't tried.
- **Whether a 5 MB file fits a Worker's memory** on the way from GitHub. The uploads here ran on a laptop.
- **Everything about tokens.** That is spike B, and it needs the owner to make them.

### Resources

- **Created:** one Worker on the account, `spike-m6-dispatch`, on its `workers.dev` address, twice; and 38 scripts in `podster-staging-apps`, each named `spike-m6-…`.
- **Deleted:** all of them. At 09:23 UTC the namespace's list answered `[]`, its `script_count` was 0, the account's list of Workers held Podster's six and nothing named `spike-m6`, and the `workers.dev` address answered 404.
- **Left:** the namespace, empty, as it was found.
- **Not created:** any KV namespace, custom hostname, API token, DNS record, route or secret. Nothing of Podster's own was changed, and nothing in `apps/` was deployed.
- **Read and not changed:** the account's lists of Durable Object namespaces and of KV namespaces, which `wrangler delete` reads on every delete; and the account's list of Workers, once, to confirm the clean-up.

## Spike C results

**Run on 2026-11-12, 09:28 to 09:32 UTC, and cleaned up.** The content domain is `opster.dev`, on the same Cloudflare account as `podster.dev` and on the Free plan, with the owner's proxied wildcard record. One dispatch Worker on the route `*.opster.dev/*` served three apps uploaded assets-only into `podster-staging-apps`, building on [spike A](../spikes/m6-namespace-app/README.md). Each app was served three ways: as it was, with service workers refused, and with the headers ADR 0010 proposes plus a sandboxing CSP. The code, every recorded answer and the resource ledger are in [`spikes/m6-content-domain`](../spikes/m6-content-domain/README.md). It answers risks 6 (except the Public Suffix List's own questions), 12 (the wildcard half; custom hostnames are spike D) and 13. *(2026-11-12, later: `opster.dev` was the content domain when this ran. The owner has since chosen `podster.site`. Nothing below is changed: it records what ran, on `opster.dev`.)*

### The answers

**Shown in a browser,** in Playwright's own Chromium, Firefox and WebKit, headless:

- **A page on the content domain can't read, receive or set a `podster.dev` cookie.** A `podster.dev` cookie in the browser's jar wasn't visible or sent on `a.opster.dev`, and a script setting one for `podster.dev` was silently ignored. All three browsers.
- **Without the Public Suffix List entry, one room's app reads, receives and overwrites another's cookies.** A cookie set by script on `a.opster.dev` for `opster.dev` was read and sent on `b.opster.dev`, and `b` overwrote it. `localStorage` stayed per host. All three browsers.
- **A sandboxing CSP without `allow-same-origin` closes that.** The page's origin is `null`, and `document.cookie`, `localStorage`, the Cache API and service-worker registration are each refused with `SecurityError`. With the dispatch Worker stripping `Set-Cookie`, the app's own `_headers` couldn't set one either. All three browsers.
- **The sandbox costs an app all its storage.** An ordinary static app's module script, `fetch`, CSS, image and `history` worked only once the CSP named the host instead of `'self'` and the answer carried `Access-Control-Allow-Origin: *`. A sandboxed page is cross-origin to its own host, and WebKit matched `'self'` to nothing. `localStorage`, `sessionStorage` and IndexedDB were refused in all three.
- **Refusing a service worker's script stops registration.** The dispatch Worker answered 403 to `Service-Worker: script`, and registration failed in all three. On a host that allowed it, a service worker registered in all three, and was seen serving the next load in Chromium and WebKit.
- **`Clear-Site-Data` on the not-found answer doesn't do the same thing in each browser:**
  - all three cleared the host's own cookie, `localStorage` and Cache API;
  - **WebKit left the service worker registered and serving;**
  - Firefox and WebKit kept a cookie set for `opster.dev`;
  - **Chromium also cleared the sibling host's own cookies.** *(Tightened on 2026-11-12: this went on "so one host's answer reaches every room's app there". It was seen for one sibling host in one Chromium run; that it reaches every host is an inference.)*

**Shown by headers only,** with Node's `fetch` and TLS:

- **One wildcard certificate and one route serve every first-level host.** Let's Encrypt, naming only `*.opster.dev` and `opster.dev`, so no room's host is named in it. A second-level host failed the TLS handshake.
- **The dispatch Worker's own refusals worked:** a service worker's script 403, `POST` 405, and the not-found answer with `Clear-Site-Data`.
- **A request carrying a Podster-looking session cookie and an `Authorization` header got the same answer as without.**
- **Removing a header by name leaves the rest.** With `Set-Cookie` removed, the app's own `X-Spike-From-Headers`, from `_headers` in `assets.config`, still reached the visitor. A `_headers` rule matches the served path (`/hdr`), not the file's name (`/hdr.html`).
- **Cloudflare injects its Web Analytics beacon into every app's HTML on `opster.dev`,** when the request accepts `text/html` as browsers do: the zone behaviour M4 found on `podster.dev`. With `no-transform` in `Cache-Control` it wasn't injected. The sandbox's CSP also refused the beacon in all three browsers.
- **Files aren't shared between scripts.** A second script with the same files had to upload all of them. The same files again to the same script needed none, and took two calls and about 2 seconds. A first upload of 4 or 5 files took about 5 seconds. *(Corrected on 2026-11-12: this and the next bullet sit under "Shown by headers only" and weren't. Upload timing and file sharing were seen in the upload's API calls, made by wrangler, and timed on one machine.)*
- **A replace was seen within about 2 seconds,** on every check this run made. Spike A once saw 74 seconds, so the run waited by polling.

### What each would change in ADR 0010

Proposed, for the architect to accept or not. None is written into the ADR. *Disposed of on 2026-11-12: [what became of each proposal](#what-the-spikes-changed-in-adr-0010). Proposal 1, the sandbox, wasn't accepted as a decision: it is the owner's choice.*

1. **"What content can reach", another room's app:** the content Worker sets the sandboxing CSP on every answer: no `allow-same-origin`, every source naming the request's own host and never `'self'`, and `Access-Control-Allow-Origin: *` beside it. Shown in three browsers, this keeps rooms' apps from each other's cookies and storage without waiting for the Public Suffix List. The list's entry is still wanted for reputation. **The owner should know the cost:** an app gets no cookies, no `localStorage` or `sessionStorage`, no IndexedDB, no Cache API and no service worker.
2. **The content Worker allow-lists the app's headers.** It passes `Content-Type`, `Content-Length`, `ETag`, `Last-Modified` and nothing else, then sets its own, instead of removing named ones. Shown: a header it didn't name reached the visitor. An app's `Clear-Site-Data` reaching Chromium cleared one sibling host's cookies in the one run that tried it; that it would clear every room's is an inference from that. *(Tightened on 2026-11-12.)*
3. **`Cache-Control` on every answer includes `no-transform`,** or the owner turns the zone's Web Analytics off. Otherwise Cloudflare adds a third-party script to every app.
4. **Service workers: refusing the script is the control, not `Clear-Site-Data`.** The ADR's "the not-found answer carries `Clear-Site-Data`" stays as a best effort. It shouldn't be counted on to remove a service worker (WebKit kept one) or an app's cookies (Firefox and WebKit kept one set for the domain).
5. **A missing script is not-found,** at the content Worker. `fetch` rejects with "Worker not found.", which the content Worker must catch, as spike A also found.
6. **Per-room hosts are one level deep,** confirmed: a deeper host has no certificate.
7. **Each release uploads all its files,** since one script's files don't serve another's. That's 300 files at most a release under the ADR's cap.
8. **The content Worker's route is replaced on every deploy, under a new ID,** so nothing should keep a route's ID.

### What stays unknown after spike C

- Branded Chrome, Firefox and Safari, and mobile browsers. Only Playwright's builds ran, headless.
- Whether a sandboxed page's own `fetch` sends the domain's cookies. The spike's echo path had no CORS header, so the test couldn't see it.
- Why Firefox's service worker wasn't seen serving the next load. It may be Playwright's Firefox.
- Whether turning off the zone's Web Analytics, instead of `no-transform`, is possible on the Free plan. That would be the owner's setting, and it wasn't looked at.
- What else the sandbox breaks: forms, downloads, popups, `window.open` back to the app, fonts, frames. Only the plain app's seven steps ran.
- The Public Suffix List's guidelines and timing, which still weren't read.
- Custom hostnames, which are spike D's.
- The cost of a request, as in spike A.

### Resources

- **Created and deleted:**
  - the Worker `spike-m6-c-dispatch`, three versions;
  - its route `*.opster.dev/*`, replaced on each redeploy;
  - the namespace scripts `spike-m6-c-a`, `spike-m6-c-b` and `spike-m6-c-plain`.

  All were created from 09:28 UTC and deleted at 09:31:58 UTC.
- **Confirmed by listing afterwards:**
  - the namespace's list held no `spike-m6-c-` script, and its `script_count` was 0;
  - the zone had no Worker route;
  - the account's Workers were Podster's six, and none was `spike-m6`;
  - the hosts answered 522 again.
- **Left:** the owner's wildcard DNS record on `opster.dev`, and the namespace `podster-staging-apps`.
- **Not touched:** anything on `podster.dev`, Podster's own Workers, D1, KV, queues, R2 and secrets. No API token was made. The calls used wrangler's existing login, and its log sanitizing stayed on.

## Spike B results

**Run on 2026-11-12, 11:21 to 11:24 UTC, on the Cloudflare account that holds `podster.dev`, with three short-lived API tokens the owner made for it. Everything it created is deleted.** The code, every recorded call and how to run it again are in [`spikes/m6-publishing-token`](../spikes/m6-publishing-token/README.md). This section gives the answers and a recommendation on one account or two. **The recommendation is a proposal: [ADR 0010](adr/0010-release-and-the-content-domain.md) and [the owner's table](#for-the-owner) aren't edited here.**

**What was tried.** Each token was asked to do the same things: publish to and unpublish from `podster-staging-apps`; read, replace and delete a canary, which is an ordinary Worker on the account made for the test; create a new ordinary Worker; and read, with GET only, what else the account holds.

**How it was run, and what that limits.**

- **No write was sent to anything of Podster's.** One function sends every request, and it refuses anything but a GET unless the request names a script matching `^spike-m6-b-[a-z0-9-]{1,40}$`. So what a token can do to Podster's Workers is **inferred from the canary**, not observed on them.
- **The tokens:** `edit` has Account → Workers Scripts → Edit. `read` has Workers Scripts → Read, as the control. `narrow` has a narrower permission the dashboard offered, whose name the owner typed as "developer platform". **Its exact name isn't known:** no token could read its own permissions, and the login couldn't either.
- **Run twice. Only the second run's results are recorded,** in `results/results.jsonl`. The first run's weren't kept, so that the two agreed rests on a comparison made at the time.

### The answers

Status, and Cloudflare's error code in brackets where there was one. "none" is a refusal with the message `No access to the specified resource.` and no code. The full table, 47 calls for each token, is in [the spike's README](../spikes/m6-publishing-token/README.md#what-was-observed).

| Operation | `read` | `narrow` | `edit` |
| --- | --- | --- | --- |
| `GET /user/tokens/verify` | 200, active, expiry set | 200, active, expiry set | 200, active, expiry set |
| **Namespace:** read it, list its scripts, read a script and its code | 200 | 200 | 200 |
| **Namespace:** start an assets upload session | 403 (none) | 403 (none) | **200** |
| **Namespace:** upload a script, and replace one that exists | 403 (none) | 403 (none) | **200** |
| **Namespace:** delete a script | 403 (none) | 403 (none) | **200** |
| **Canary:** read settings, code, versions, cron triggers and secrets' names | 200 | 200 | 200 |
| **Canary:** replace its code | 403 (none) | **200** | **200** |
| **Canary:** delete it | 403 (none) | 403 (none) | **200** |
| **Account:** create a new Worker, then delete it | 403 (none) | 403 (none) | **200** |
| List the account's Workers | 200 | 200 | 200 |
| `podster-api-staging`: settings, secrets' names, code | 200 | 200 | 200 |
| Workers routes on `podster.dev` | 403 (none) | 200 | 200 |
| Workers routes on `opster.dev` | 403 (none) | 200 | 403 (none) |
| DNS records and custom hostnames, either zone | 403 (10000) | 403 (10000) | 403 (10000) |
| D1 databases, KV namespaces | 401 (10000) | 401 (10000) | 401 (10000) |
| R2 buckets | 403 (10000) | 403 (10000) | 403 (10000) |
| Queues, Durable Object namespaces, Workers custom domains, the `workers.dev` subdomain, zones, the account | 200 | 200 | 200 |
| Dispatch namespaces | 200 | 200 | 200 |
| API tokens, `/user/tokens` | 403 (9109) | 403 (9109) | 403 (9109) |

For Podster's own data only the status was kept: no secret's name, setting or code was recorded.

**The narrowest token that can publish and unpublish: Workers Scripts Edit.** Of the three it is the only one that could.

- Its upload answered 200 and the code read back was its own.
- Its delete answered 200, and the namespace's `script_count` was 0 afterwards.
- It may also start an assets upload session.
- The narrower token was refused every write in the namespace, whether the script existed or not.

**What else that token can do.**

- **Replace, delete and create any ordinary Worker on the account.** It replaced the canary's code, which the login then read back as the token's. It deleted the canary. It created a new Worker and deleted it. Cloudflare's answers made no difference between a script in the namespace and a Worker on the account.
- **So, by inference, it could replace or delete Podster's API, gateway and web Workers.** A replaced API Worker runs with that Worker's bindings: its Durable Objects, D1, R2, queues and secrets.
- **Read every Worker's settings, code and the names of its secrets.** Observed on `podster-api-staging` as a 200, with nothing kept.
- **Read** the account's list of Workers, queues, Durable Object namespaces, Workers custom domains, its `workers.dev` subdomain, its zones, its dispatch namespaces and the Workers routes on `podster.dev`.
- **Not read:** D1, KV, R2, DNS records, custom hostnames, the account's members and API tokens.
- **Not tried, because the spike sends no such write:** a Worker's secrets, settings, cron triggers, routes, custom domains and `workers.dev` address.

**The narrower token is no help.** It can't publish, and it still replaced the canary's code: the login read back `replaced-by-narrow`. It couldn't create or delete. Whatever its permission is called, it is neither a publishing token nor a safe one.

**The control reads a great deal.** Workers Scripts Read alone answered 200 for `podster-api-staging`'s code, settings and secrets' names. That matters for [the reconcile](adr/0010-release-and-the-content-domain.md#credentials): a read-only token for it is still a token that reads Podster's code if it is on Podster's account.

### One account or two

**Recommended: two. Keep ADR 0010's working assumption of a second Cloudflare account,** and make it a condition of storing any publishing token. The owner's table says yes "unless a test finds a narrower credential". This test found none.

- **The token that publishes can rewrite Podster.** On one account, the secret the private API Worker would hold for release is a token that can replace that same API Worker, the gateway and the web app. One leaked or misused secret would be the whole of Podster, where today it would be the apps.
- **Nothing narrower worked.** The only narrower permission the owner found can't write to the namespace. No API call was tried that asks whether a permission can be limited to one namespace, and Cloudflare's documentation, read earlier, shows permissions divided by account, zone and user only.
- **On a second account the same token reaches only what serves apps:** the namespace's scripts and the content Worker. ADR 0010 already says so plainly, with what limits the damage.
- **Reading argues the same way.** Any Workers Scripts token on Podster's account reads Podster's code and the names of its secrets.
- **Until the second account exists, propose:** no Workers Scripts Edit token for the account that holds `podster.dev` is stored as a Worker's secret, on staging either. The staging namespace on that account stays for spikes run under a person's login.
- **What it costs** is in [the owner's table](#for-the-owner): an account, and Workers for Platforms and perhaps Workers Paid bought on it.

**What would change this:** a permission, or a resource choice, that limits Workers Scripts Edit to one dispatch namespace. Only the dashboard can show whether one exists. **For the owner to look at,** on the page that makes a custom token:

- **the exact name of the permission** the `narrow` token was given, and its group;
- **under Account Resources,** whether anything narrower than one account is offered once Workers Scripts is chosen, such as a dispatch namespace or a script;
- **in the list of permissions,** anything named for Workers for Platforms or dispatch namespaces;
- **each token's Zone Resources,** which would explain why the three read different zones' routes;
- **whether an account-owned token,** made under Manage Account, offers anything a user token doesn't.

### What it would change in ADR 0010

| ADR 0010 says | Spike B found | Proposed change |
| --- | --- | --- |
| The only permission found for the scripts token is Workers Scripts Edit, and the permission the namespace's upload needs isn't stated | Workers Scripts Edit uploads, replaces, reads and deletes in the namespace, and starts an upload session. Workers Scripts Read and the narrower token can't write there | State it as tried |
| Nothing scoped to one namespace was found | The same token replaced, deleted and created ordinary Workers | State it as tried: the scripts token is account-wide |
| The working assumption is a second account | No narrower credential was found | Keep it, and drop "working assumption" once the owner decides |
| The reconcile reads the content Worker's deployed version | Workers Scripts Read reads versions, settings and code of any Worker on its account | If the reconcile gets its own read-only token, it belongs on the second account too |
| The routing token writes KV and custom hostnames | None of the three could read KV or custom hostnames | Nothing yet. A Workers Scripts token read neither, which fits two separate tokens. The routing token's own permissions are still a spike |

### What stays unknown after spike B

- **The narrow permission's exact name,** and whether the dashboard can scope a token to one namespace. Both need the owner's eyes on the dashboard.
- **What the tokens can write besides a script:** secrets, settings, cron triggers, routes, custom domains and the `workers.dev` address weren't tried.
- **Whether the narrow token can replace a Worker that has bindings.** The canary has none.
- **Why the three tokens read different zones' Workers routes.**
- **Account-owned tokens,** and a token limited by client IP address.
- **The routing token:** which permissions custom hostnames and KV writes need. Risk 3's second half.
- **How long a deleted or expired token keeps working.**

### Resources

- **Created, in each of two runs:** the Worker `spike-m6-b-canary`; the namespace scripts `spike-m6-b-read`, `spike-m6-b-narrow` and `spike-m6-b-edit`; the Worker `spike-m6-b-new-edit`; and one assets upload session, to which nothing was sent.
- **Deleted:** all of them. Confirmed by listing at 11:23:32 UTC, and again at 11:26:05: the namespace's list was empty and its `script_count` was 0, and the account held six Workers, each named `podster-…` and none named `spike-m6`.
- **Left:** the namespace `podster-staging-apps`, empty; and the owner's three tokens and the file that holds them, **which the owner must now delete**.
- **Not created:** any namespace, KV namespace, D1 database, custom hostname, DNS record, route or secret. Nothing in `apps/` was deployed.
- **Read and not changed:** the lists and the one Worker's settings, secrets' names and code named above, with GET, keeping the status only.

## What the spikes changed in ADR 0010

**Recorded on 2026-11-12, with the architect's rulings.** Every proposal in the four spike sections above, and what became of it. "Applied" means [ADR 0010](adr/0010-release-and-the-content-domain.md#what-the-spikes-changed) now says it, with what it said before and what was seen. No decision the owner made, and none of decisions 213 to 215, is changed.

**Two places where the ADR differs from the ruling as worded, for the architect to confirm:**

- **Reads at the cap: 302, where the ruling says 301.** 301 is what the spike measured, with one tree read. The ruling also forbids `{commit}:{path}`, which makes it two tree reads. The ADR gives both figures and says which was measured.
- **A file named `_headers` or `_redirects` is still refused.** The ruling says such a file is an ordinary file once `assets.config` isn't sent. That was seen only for a file deeper in the directory; a root file sent plain was never tried, since wrangler won't send one. The refusal stays as a second guard until the release job's own upload is tested, and dropping it then loosens nothing.

**Spike E**

| # | Proposal | What became of it |
| --- | --- | --- |
| 1 | Read the commit's top tree, then the directory's own sha; never `{commit}:{path}` | **Applied,** as [how the tree is read](adr/0010-release-and-the-content-domain.md#how-the-tree-is-read) |
| 2 | Cap a tree answer's bytes and its entries of every kind | **Applied.** 1 MB an answer is the spike's figure; 1,000 entries is the ADR's own, proposed |
| 3 | Reword where `truncated` was seen | **Applied,** said as seen at two path lengths only |
| 4 | "No size fails the release" means a file's entry | **Applied** |
| 5 | A path holding U+FFFD fails the release | **Applied** |
| 6 | Unicode twins fail; say which modes pass | **Applied,** as: a path must already be in NFC, and no two the same after case folding; `100644`, `100755` and `040000` pass |
| 7 | Check each fetched file's length and blob sha against the tree | **Applied** |
| 8 | Never pass on GitHub's `Content-Type` | **Applied** |
| 9 | The reason for raw bytes is the Worker; the overhead is 1.378 | **Applied** |
| 10 | Why trees and blobs gains a reason | **Applied** |
| 11 | 300 files stays; 3,000 an hour is nine releases; ten at a time | **Applied** |
| 12 | Podster counts its own reads | **Applied** |
| 13 | The permissions stand; on a public repository the job's own requests confine it | **Applied** |
| 14 | The path rules stand | **Applied, and extended** as the architect asked: one stated rule, which also refuses a segment that begins or ends with a space and two paths served at one address. Those two are the ADR's own, proposed |

**Spike F**

| Proposal | What became of it |
| --- | --- |
| Nothing changes in ADR 0010 | **Nothing changed.** The unanswered question is listed in the ADR's open items, with what would settle it |
| New wording for ADR 0009's "Unverified" line | **Not applied here.** ADR 0009 is outside this change. The wording was tightened above, since only one App's token on one repository was tried |

**Spike A**

| # | Proposal | What became of it |
| --- | --- | --- |
| 1 | A release is assets only; drop the fallback script | **Applied** |
| 2 | Say which HTML handling a release is uploaded with | **Applied:** the default, the only one tried. `html_handling: "none"` is listed as open |
| 3 | The control is never sending `assets.config`; keep refusing the files as a second guard; one test owed | **Applied,** as ruled: the job sends no `assets.config` at all. The refusal is kept until that test runs, and the test bypasses the refusal on purpose |
| 4 | The content Worker allow-lists response headers, and decides about a 3xx to another site | **Applied,** as ruled. A 3xx passes only with a `Location` that is a path on the same host |
| 5 | Record the outbound Worker's evidence; an optional refuse-everything outbound Worker | **Recorded,** as ruled. **The optional guard isn't added:** a release holds no script, so nothing would call it |
| 6 | Derive the manifest's hash from content and type; every release sends every file | **Applied,** as proposed |
| 7 | The marker stays | **No change needed** |
| 8 | A 30-second wait for the marker | **Applied,** as proposed, with what twelve tries can't show said beside it |
| 9 | One script for each release gains a second reason | **Applied** |
| 10 | Say what Cloudflare's "gone" is | **Applied,** as ruled, in both forms |
| 11 | Deleting a script isn't the fast path | **Applied,** in the restated takedown time |
| 12 | The hourly reconcile lists the namespace, trusting `id` only | **Applied;** paging is open |
| 13 | The ADR sets its own script-name rule | **Applied,** as ruled: a label of at most 26 lower-case letters and digits, a `.` as the separator, and the release's 36-character ID, which holds a `_` of its own; 63 characters at most. *Corrected after the review of 2026-11-12: the separator was first `_`, which an ID also holds* |
| 14 | Budgets: nothing changes | **No change,** beyond saying the spike couldn't measure billing |
| 15 | Mark the open items answered | **Applied,** item by item |

**Spike C**

| # | Proposal | What became of it |
| --- | --- | --- |
| 1 | The content Worker sets the sandboxing policy on every answer | **Not applied as a decision.** The architect ruled it a product choice. It is [written up for the owner](adr/0010-release-and-the-content-domain.md#the-sandbox-an-open-choice-for-the-owner) with three options, and is a row in [the owner's table](#for-the-owner); the architect recommends sandboxing every app for M6 |
| 2 | Allow-list the app's headers | **Applied,** with spike A's 4 |
| 3 | `no-transform` on every answer, or the zone's Web Analytics off | **Applied:** `no-transform`. Whether it can be switched off for the zone is open, and would be the owner's setting |
| 4 | Refusing the service worker's script is the control, not `Clear-Site-Data` | **Applied.** Whether to narrow or drop the header, given what Chromium did to a sibling, is listed as open |
| 5 | A missing script is not-found | **Applied,** as ruled |
| 6 | Per-room hosts are one level deep | **No change needed;** recorded as seen |
| 7 | Each release uploads all its files | **Recorded** |
| 8 | Nothing keeps a route's ID | **Recorded** |

**The build order doesn't move.** No finding puts a step before another. Three steps gain a line: [below](#build-order).

## What the specs say, and where they are thin

Everything in this section is quoted or linked. The rest of the plan is the architect's proposal built on it.

- **Milestone row:** "Workroom-level deployment, separate content domain, custom domains", gate "Expanded criteria 7 and 8" ([PRODUCT.md](spec/PRODUCT.md#product-direction-and-delivery-scope)). "M5 and M6 can ship later for engineering rooms."
- **Core job 8:** "an engineering workroom can use a Podster-managed repository and an optional Cloudflare deployment workflow, configured once at workroom level."
- **[Review, merge and optional Cloudflare deployment](spec/PRODUCT.md#review-merge-and-optional-cloudflare-deployment):** deployment is a workroom-level option with a default URL and optional custom-domain mapping. A human owner or admin configures it once, and a DevOps role can propose settings. "Deploy releases the merged version only when the workroom's configured release policy allows it. Record commit, environment and result separately from task completion." Failures are reported accurately, for example "Merged, deployment failed". The same section says: "Release environments, approval policy, retry/rollback behavior, branch protection, credential handling, custom-domain validation and budget controls are unresolved implementation requirements."
- **Scope boundary:** workroom-level deployment needs "Hosting model, separate content domain, budget and approval policy" before it ships ([PRODUCT.md](spec/PRODUCT.md#target-product-not-in-the-coordination-kernel)).
- **Capability:** `deploy_release`, "only for an agent with explicit delegation" ([proposed extension capabilities](spec/PRODUCT.md#proposed-extension-capabilities)). The name is proposed.
- **Decision 11**, a recommendation: "Podster's isolated platform with budget caps first; customer account later".
- **Decision 164**, "Decided, for the owner to review": the content domain "stays in M6". Decision 52, decided: M2 is download only, "so no content domain is needed yet".
- **[Content and deployment origins](spec/ARCHITECTURE.md#content-and-deployment-origins):** deployed apps and previews "must never share a site with the application". They use a separate registrable domain, which "must be on the Public Suffix List", with a distinct subdomain per room. "`*.podster.dev` must not host this content." Uploaded HTML and SVG never share a room's app origin.
- **[Release and deployment (M6)](spec/ARCHITECTURE.md#release-and-deployment-m6):** the `release_config` and `release` shapes; Workers for Platforms "fits the proposed Podster-hosted default", each room's app a user Worker in an untrusted dispatch namespace "with no bindings to Podster's own data"; a merge may start a release only if `release_config` allows it and "the release job's authority recheck passes"; each attempt is its own record tied to an exact commit; "Task completion never implies deployment". Custom domains need proven ownership, and "An M6 spike must validate the Cloudflare custom-hostname flow; it is not yet verified for this design." Open for the ADR: "where builds run, secrets for deployed apps, rollback, budgets and quotas, abuse takedown, and account limits."
- **[ACCESS-CONTROL.md](spec/ACCESS-CONTROL.md#proposed-permission-matrix):** deployment authority is a separate delegation from the external resource owner. The rows "Grant repository/deployment access" and "Merge/deploy" apply, with AC-05, AC-10, AC-11, AC-13, AC-16 and AC-17. "Queued inbox deliveries, retries and delayed release jobs must recheck relevant authority before disclosing content or making an external change."
- **[DESIGN.md](spec/DESIGN.md#release-stages):** the deployment labels (Off, Waiting for merge, Waiting for approval, Deploying, Live, Deployment failed), the Release panel, the merge-consequence confirmation, release approvals in Needs attention, Release in room settings, and UI-02.
- **[ADR 0009](adr/0009-managed-repositories.md#actions-and-workflows):** proposes GitHub Actions off in every managed repository, and says "M6 will need its own decision before anything runs." M5's `get_task_release_status` "reports that no release exists; M6 adds releases" ([M5 plan, step 8](m5-plan.md#build-order)).
- **`RUNNER.md`, `CONTRIBUTORS-AND-LIMITS.md` and `TASK-PLANNING.md`** add no M6 scope. Each says only that its subject grants no deploy right (R-14, R-34; pricing and model labels; planning edges), and that progress counts reviewer-approved tasks, not deployed ones.

**Where the specs are thin.** They don't say what a release is made of, where a build runs, what an environment is, what the approval policy's values are, who may see a deployed app, what the budget caps are, or what the "documented policies" in criterion 8 are for custom domains, export or transfer and release approvals. No such policy document exists. This plan proposes each and marks it.

## Where earlier milestones stand

M6 is planned while three earlier gates are open. None blocks M6's planning or its spikes.

- **M3's gate** isn't called. It waits on the owner's approval of fasta2a and the compatibility kit. **2026-11-11:** the owner called it met, accepting local runs for outbound to LangGraph, fasta2a, `CancelTask` delivery and the Python client ([decision 193](spec/PRODUCT.md#decisions-needed)).
- **M4's gate** isn't called. `PUBLIC_ROOMS` is on for staging. The staging run of 2026-11-10 ended 102 passed, 3 failed, 0 skipped, 6 owed ([M4 plan](m4-plan.md#abuse-review-step-14)). The fixes merged as [#236](https://github.com/thachp/podster/pull/236); the lead session reports them deployed, which this plan didn't check. A rerun is owed. **2026-11-11:** the rerun got 107 passed, 1 failed, 0 skipped, 6 owed by design, and the owner called M4's gate met ([decision 196](spec/PRODUCT.md#decisions-needed)), for staging only. *(2026-11-12: the owner called M4's gate met, [decision 196](spec/PRODUCT.md#decisions-needed), and dropped the clean rerun, writing "i think m4 and m5 pass gate.. there is no need to do anything there"; the gate stands as called.)*
- **M5's gate was called met by the owner on 2026-11-12** ([decision 212](spec/PRODUCT.md#decisions-needed)), for staging only, with named gaps accepted on local tests ([M5 plan](m5-plan.md#what-the-gates-call-accepted)). All of M5's build steps are merged. *The rest of this bullet is as it was written on 2026-11-10.*
- **M5** has built no agent-facing behaviour. [ADR 0009](adr/0009-managed-repositories.md) is on `main` as a proposal, the spike ran, and three staging GitHub Apps exist in `podsterdev`. Step 2 merged on 2026-11-10 as [#238](https://github.com/thachp/podster/pull/238): the room's state and one read of it for people, with no agent capability and no call to GitHub. `get_repo_access`, `merge_task` and `get_task_release_status` join the contract in M5's steps 6, 7 and 8.
- **A correction to the M5 plan as it stands on `main`:** its "Where M3 and M4 stand" still says M4's staging run hasn't happened and that the test operator isn't in `OPERATORS`. The M4 plan records the run, and the lead session reports the operator set. This PR doesn't edit the M5 plan.

Contract and migration PRs merge one at a time, so M6's step 2 waits until every M5 contract or migration PR has merged: M5's step 2 at the least, and any later M5 PR that changes a contract or adds a migration.

## What M6 includes

**Proposed**, as the architect's reading of the lines above.

- **Release as a room setting:** the owner or an admin of a public Engineering room with a ready managed repository switches deployment on, once, under a deployment delegation. Off is the default, and off publishes nothing. *Since 2026-11-12 a room's admins may too, as people ([decision 215](spec/PRODUCT.md#decisions-needed)); until then the interim rule was the room's owner only.*
- **A release record per attempt:** each names the exact commit, the environment, who asked, the state and the result, kept apart from the task's state and from the merge's.
- **A release of merged code only:** a release is made from a commit that Podster's own merge put on the default branch. Nothing unreviewed is deployed.
- **Hosting on Podster's platform:** the room's app runs in an untrusted Workers for Platforms dispatch namespace, with no binding to Podster's data, as the architecture proposes.
- **Static files only, as a working assumption:** a release is files a browser loads, with no agent-written code on the server. This narrows core job 8's "working web application", so it was the **owner's** to confirm (question 5). *Decided on the owner's behalf on 2026-11-12 ([decision 214](spec/PRODUCT.md#decisions-needed)): static files only, one environment, no preview of unmerged code.*
- **Only a public room releases** (ruled on 2026-11-12, [ADR 0010](adr/0010-release-and-the-content-domain.md#only-a-public-room-releases)). A private room's request is refused `release_needs_public_room`, nothing is queued, and a room that goes private is unpublished. How to serve a private room's app to its own people isn't designed.
- **The content domain:** a separate registrable domain, on the Public Suffix List, with one host per room. Nothing agent-written is served from `podster.dev`.
- **Custom domains:** a room's owner maps a hostname they have proven they control. One hostname belongs to one room.
- **Approval:** a person approves each release. *The first draft also had a policy under which a merge started one; it was dropped on 2026-11-12.*
- **`deploy_release`** for an agent that holds an explicit deployment grant, and the same command for a person.
- **Status:** `get_task_release_status` gains the release, beside checks and merge, each with its own time, including failure.
- **Limits and a stop:** budget caps per room, an owner's off switch that unpublishes, an operator's suspension of one app, and a stop for the whole content domain, built before anything is served. An app is served only while Rust has said so, host by host.
- **Screens:** Release in room settings and setup, the deployment stage on a task's Release panel, and release approvals in Needs attention.
- **Written policies** for custom domains, release approvals, and export or transfer, since criterion 8 says they must pass "their documented policies" and none is written.

Not in M6: a way for a DevOps role to propose release settings through Podster. The spec says "a DevOps role can propose its settings", and no command, state or screen for a proposal is designed. In M6 such an agent can only say what it suggests in a task thread, which is data, and the owner or an admin configures release. A proposal command is left for a later design, because it would let agent-written text become configuration by one click.

Also not in M6: a customer's own Cloudflare account, a build service, secrets or bindings for deployed apps, previews of unmerged code (the owner's to confirm, question 7, since `PRODUCT.md` names a "preview/live URL"), previews of uploaded files, a provider other than Cloudflare, Runner (M7), and anything in production. M6 ends on staging, like M1 to M5.

## The gate

From the specs. Nothing may say release works until all of these pass on staging:

- **Expanded criterion 7, the deployment half:** "Disabled deployment publishes nothing; enabled deployment reports checks, merge and release independently, including failure." The repository half is M5's gate, and M6's gate needs M5's to have passed. *The owner called M5's gate met on 2026-11-12 ([decision 212](spec/PRODUCT.md#decisions-needed)).*
- **Expanded criterion 8, all of it,** as the milestone table gives it to M6: "Custom-domain and export/transfer behavior, upload permissions, retention, abuse controls and release approvals pass their documented policies before launch." M6 builds the custom-domain, export or transfer and release-approval parts, and abuse controls for deployed content. Upload permissions and retention were shown at M2's gate and public-room abuse controls are M4's gate, which the owner called met on 2026-11-11 ([decision 196](spec/PRODUCT.md#decisions-needed)). **Proposed, and the owner's to confirm (question 24):** M6's gate reruns the M2 and M4 staging scripts at the gate's commit, so those three parts are shown again and not taken on trust.
- **Expanded criterion 3, for deployment:** claiming a role grants no deploy right.
- **Access tests** that name deployment, on a deployment: AC-05 for provider-resource and environment IDs, AC-10, AC-11, AC-13, AC-16 for a provider's refusal, and AC-17.
- **The origin boundary, shown on staging:** content on a room's host can't read or set a cookie for the application, since it is on another registrable domain, and the application never serves agent-written markup. **The owner's, since 2026-11-12:** the architecture says the content domain "must be on the Public Suffix List", and whether M6's gate, or anything served on staging, waits for that entry is in [the owner's table](#for-the-owner). The architect's ruling that the gate didn't wait was [decision 210](spec/PRODUCT.md#m6-decisions-november-12-2026), which is withdrawn. Whatever the owner decides, M6 is designed so that Podster itself is safe without the entry: Podster sets no cookie and accepts no credential on any app hostname. Without it, one room's app can set a cookie that another room's app reads, and one bad app can get the whole domain blocked.
- **UI-02:** "Merged · Deployment failed", never live.
- **M6's own tests,** [below](#acceptance-tests).
- **A security review** of the built system against the [threat model](#threat-model), with the result written into this plan.

The architect proposes the gate call, for the owner to review.

## What M6 needs from earlier milestones

| M6 needs | From | Status on `main`, 2026-11-10 |
| --- | --- | --- |
| The revocation fence, the outbox and its jobs, idempotency | M0 | Built |
| Owner and admin authority, Manage access | M1 | Built |
| `crates/egress` for every outbound call | M0 | Built |
| Operators, reports and suspension, extended to a room's app | M4 | Built; gate met by the owner's call on 2026-11-11 ([decision 196](spec/PRODUCT.md#decisions-needed)) |
| `repo_link` and `provider_grant` as room state | M5 step 2 | Merged, #238 |
| Grant checks in `crates/core` and `crates/policy` | M5 step 3 | Not built |
| A ready repository link | M5 step 4 | Not built |
| A merge that Podster made and confirmed, with its commit | M5 step 7 | Not built |
| `get_task_release_status` | M5 step 8 | Not built |
| The task's change and merge panel | M5 step 9(b) | Not built |
| Nothing from M3 | | A protocol gives no deploy authority (AC-18, AC-24) |

## Build order

**Proposed.** Each step is one PR unless it says otherwise. Steps 2 onward wait for step 1's ADR and spikes.

**After the spikes, 2026-11-12: no step moves.** Three gain something, each from [the ADR's revision](adr/0010-release-and-the-content-domain.md#what-the-spikes-changed):

- **Step 4(b):** the content Worker builds its response headers from an allow-list, sends `no-transform`, catches "Worker not found." and, if the owner chooses it, sets the sandbox. Its "fixed response headers" below means that.
- **Step 5:** two tree reads and the job's own caps on a tree answer; the path rule; a marker wait that is provisional until spike G; and one owed test, a root `_headers` and a root `_redirects` sent as plain files, bypassing the job's refusal on purpose.
- **Step 4(a):** a script is gone on one of two exact answers. The time M6-27 states waits for spike G.

**Changed on 2026-11-12 by ADR 0010's review: taking an app down is built before anything is served.** Step 4 is now two PRs in order, takedown first; step 9 keeps only the caps and the report. The first draft had suspension at step 9, five steps after the content Worker.

| Step | What | Needs from M5 | Notes |
| --- | --- | --- | --- |
| 1 | **ADR 0010, the release policies and the spikes.** *2026-11-12: [the ADR is drafted](adr/0010-release-and-the-content-domain.md), accepted by the architect on 2026-11-12, after four independent reviews whose changes are applied; the three policies aren't written; [the spikes](#the-spikes) are listed and none has run. Later that day: A, C, E and F ran, and the ADR was revised with what they found; B, D and G haven't.* The ADR settles everything the architecture leaves "open for the ADR": where builds run, secrets, rollback, budgets, takedown and account limits, plus what this plan's questions leave open. Three short policies are written beside it: custom domains, release approvals, and export or transfer. The spikes stay in `spikes/`. | None | The spikes need a domain, a Cloudflare plan and credentials, each the owner's yes. The ADR and the policies can be drafted without them. |
| 2 | *2026-11-12: built as one PR, shapes and state only, behind a switch, `RELEASES`, that no environment sets: every M6 route is answered exactly where an unknown path is, and `release_not_available` where a test switches it on. [What it holds](#what-step-2-built).* **M6's contracts, migrations and the new Durable Object class, in one PR, apart from the two agent-facing pieces named at the end:** `release_config`, `release` and the room's hostname request as room state; the new hostname-claim Durable Object class and its migration; and in `openapi.yaml` the person routes for configuring release, approving a release and mapping a hostname, and steps 4(a)'s and 9's routes: an operator's suspend and lift of a room's app, the stop for the whole content domain, and a report that names an app. The room's Durable Object owns the configuration and the records, because they are authority. The hostname claim is a separate object; [question 10](#questions-for-the-architect) says how the two commit. D1 gets at most a projection for lists, which never authorizes. | Every M5 contract or migration PR merged, step 2 at the least | One contract and migration PR at a time. Alone and first. **Two exceptions, from the architect's ruling at M5's step 2:** no agent sees a merge or deploy tool before its path and checks exist, and `e2e/journey.mjs` asserts it (AC-17). So `deploy_release` joins `capabilities.yaml` with step 6, and the release fields join `get_task_release_status` with step 7, which can't come before M5's step 8 creates that capability. Each is a contract change that merges alone. |
| 3 | **Decisions in `crates/core` and `crates/policy`:** who may configure and approve release, the deployment grant check, that only a public room releases, the release state machine with its one approval policy, which commit is releasable, what a release may contain, the caps, the unpublish triggers, and the hostname challenge and claim rules. Pure, with no I/O. | Step 3, for the grant check it extends | AC-10, AC-11 and AC-17's deploy half are decided here. |
| 4 | *2026-11-12: (a) is built as three PRs in order, by the architect's ruling, since one was too much to review well: takedown in the room; then a custom hostname's suspension and the stop; then the two reconciles. The first is built: [what it holds](#what-step-4as-first-pr-built).* **Takedown, then the content Worker,** two PRs in this order. **(a) Takedown:** an operator's suspension of an app, keyed by its label and by each host; a hostname's suspension, kept with its claim; the stop for the whole content domain; the room's release epoch and what each of its hosts should serve; the room's applier, the only writer of serve entries; deleting an app's scripts, confirmed by Cloudflare's own answer and retried; and the two scheduled reconciles. It needs no content Worker: nothing here is confirmed by fetching a host. Nothing is served yet. **(b) The content Worker and domain:** a new public Worker, proposed as `apps/content`, on the content domain only. It serves a host only when a serve entry exists for it, and adds fixed response headers. It has no binding to the gateway, the API, D1 or R2. | None; M4's operators for (a) | **Security-sensitive.** A new public surface that serves agent-written content. (b) needs the domain, and never merges before (a). |
| 5 | **The release job:** an outbox job that reruns policy and rechecks authority on every pass, reads the release's tree from the repository at the exact merged commit, checks paths, count and sizes from the tree, fetches the files and uploads them as that release's own script, then returns to the room, which commits the release as live and switches what its hosts serve only if policy and the release epoch still hold. The room's applier switches the serve entries; the job confirms by the release's marker and fails the release if it doesn't come back. | Steps 4 and 7 | **Security-sensitive.** It holds the credentials that publish. |
| 6 | **Triggers and approvals:** `deploy_release` in a public room, approval by a person, rollback, which switches back to the release before where its script is still kept and is otherwise a new release of the earlier commit, and every unpublish trigger. No release starts from a merge. | Step 7 | **Security-sensitive.** This is where "task completion never implies deployment" holds or doesn't. Adds `deploy_release` to the contract, alone in its turn. |
| 7 | **Status:** `get_task_release_status` reports the release beside checks and merge, each with its observation time. | Step 8 | Small. Adds the release fields to the contract, alone in its turn. |
| 8 | **Custom domains:** Podster's own room-bound challenge, the hostname claim, the custom hostname at Cloudflare, routing, the daily recheck, and removal read until gone. | None | **Security-sensitive.** A wrong claim serves one party's content on another's name. |
| 9 | **Caps and reports:** the caps enforced, the release App's read budget across the deployment, and a report that names a deployed app by its address. | None; M4's operators | Suspension and the stop moved to step 4(a). The report's route is in step 2. |
| 10 | **Screens**, in two PRs: (a) Release in room settings and setup, with its *Not configured*, *Needs approval* and *Ready* states and the custom domain; (b) the deployment stage on the task's Release panel, the merge confirmation, which in M6 says that merging releases nothing, and release approvals in Needs attention. | (b) needs step 9(b) | Unavailable grants show as unavailable. A preview or live link shows only when real for this commit. |
| 11 | **Staging run and security review,** then the gate call. | M5's gate | A script against staging with test people. |

#### What step 2 built

**Shapes and state only. Nothing deploys, routes or serves, no cloud resource is made, and no secret or variable is set.**

- **The room's tables,** in one forward-only migration, six tables and two indexes: `release_config`, with the room's release epoch, the kept script and the one commit in flight (its release, its script and its epoch); `app_label`, the app's host labels, one current and the retired ones kept so none is used twice, with an operator's suspension of the app; `release`, with the script it serves, which for a rollback is an earlier release's, and who approved or declined it; `serve_state`, what each host should serve, with its version, whether it is closed, and what the commit in flight wrote and found there; `hostname_request`, with the generation of the name it was made under and its proof history; and `unpublish`, each recorded trigger with the epoch it raised to. The database itself holds the forms and the closed sets: a label of at most 26 lower-case letters and digits, a release's ID, a 40-character commit, a script named for the room's own label and one of its own releases, one default host that is never closed, counters that never go below their start, and a release that is live or served only with its script and its approver. The stop for the whole content domain isn't room state and has no home yet: it is owed with step 4(a).
- **The closed sets are step 3's, and nothing restates them.** A release's states, a hostname request's states and which of them are open, an unpublish's causes, the approval policy, the environment, a release ID's form and a label's length are `crates/core`'s. The wire name of each value is exactly the string core's own `name()` or `code()` gives it. `packages/contracts/core-sets.mjs` reads them from core's source, and `check.mjs` fails unless the contract's enums and the room's column checks equal them, value for value. A value added to the rules therefore needs a contract edit and a new migration before the check passes. A hostname request's states had no home in core, so step 2 added `podster_core::hostname_requests`, names and two questions only.
- **`HostnameClaim`,** a new Durable Object class in the private API, bound as `HOSTNAME_CLAIM`, added by the Worker's migration `v3`. One object for each hostname; at most one claim that isn't ended; a suspension apart from any claim. It keeps the name's generation, which a suspension, a lift and a freed claim each advance, so a request made before any of them can't claim after it. Nothing calls it. **Deploying the API to staging creates the class there,** which is the cloud change [the owner's table](#for-the-owner) lists.
- **A D1 table, `app_label_index`,** migration `0008_app_label_index.sql`: which room a label belongs to, for routing a question to the room and nothing else. Nothing writes it yet. A staging deploy has to name it to `scripts/deploy-staging --apply-migrations`.
- **Fourteen operations in `openapi.yaml`,** each a person's or an operator's: the room's release configuration, read and set; approving a release, and declining one; the room's custom hostname, read, asked for and removed; a report that names an app by its address; an operator's suspension and lift of an app by its label and of one host; and the stop for the whole content domain and its lifting. `deploy_release` and the release fields of `get_task_release_status` aren't there, as the row above says.
- **One error code,** `release_not_available`. The rules' refusal codes, `release_needs_public_room` among them, join `Error.code` with the handler that answers each: that list is checked against what the API and the gateway actually answer, and core marks its own as reasons until a route does.
- **Not decided in step 2:** who may do what. With the switch on, which only a test build can be, an agent is refused by its kind and an operator's route refuses anyone who isn't an operator; every other caller is told release isn't available. Owner-or-admin, the grant and the room's visibility are step 3's decisions and the later steps' handlers.

#### The first staging run, 2026-11-12

**Step 2 was run against staging once, switched off, and passed.** This is a record of that run, as the architect reported it. The run's log was a scratch file and isn't in the repository, so the numbers below can't be checked against anything kept here.

- **What ran:** [`e2e/m6-staging.mjs`](../e2e/m6-staging.mjs) at main `b4a408811a72d8ae3f48a5db00f3c2e504686ddd`, once, against staging deployed at `7a98bce`, step 2's merge, with `RELEASES` unset.
- **Result:** exit 0. 11 passed, 0 failed, 1 skipped, in 159 s. 2 sign-ups asked, 2 answered. 10 checks were shown on staging; the eleventh pass, M6-S00, reads the checkout only.
- **Passed,** by [the script's IDs](#staging-script):
  - M6-S00, offline, 14 operations.
  - M6-S01a, 14 routes, each `404 not_found`; M6-S01b; M6-S01c; M6-S01d, 12 writes; M6-S01e, 14 tool names, "tool not found" over HTTP and through the SDK.
  - M6-S02a, 4 reads, none of 19 M6 fields; M6-S02b, 47 tools; M6-S02c, 6 events, none M6's; M6-S02d, 47 capabilities.
  - M6-S03: a task offered, accepted, submitted and completed in a fresh room, which shows the room schema step on a new room.
- **Skipped by design:** M6-S04, the same task in a room made before the deploy.

**Still unshown after this run, and owed before `RELEASES` is switched on anywhere:**

- **A room made before the deploy.** M6-S04 has never run, so the room schema step's migration is shown only on a room that began with it.
- **That the `HostnameClaim` class can be instantiated.** Nothing reaches it while the switch is off, so the run couldn't show it.

**Left on staging:** the two test people, the organization, the room, the agent and the task. Every session was signed out.

#### What step 4(a)'s first PR built

**Takedown in the room, behind `RELEASES`, with no provider configured anywhere.** Built on 2026-11-12. Nothing deploys, routes or serves; no cloud resource is made, and no secret, variable or binding is set.

- **An operator suspends an app, and lifts that,** by the app's label, and by its default host, which is the same act. Who is asking is settled first: an agent, then anyone who isn't an operator, is refused before anything is said about the app. The lookup table only finds the room to ask; the room acts only if the label is its own.
- **Suspending unpublishes, in one room transaction.** `crates/core`'s `unpublish` runs on the room's own state, rebuilt from its rows: the release epoch goes up, every host goes to nothing with its version up, and the kept script and any commit in flight are forgotten. The same transaction records the trigger with the epoch it raised to, marks each release that was live or served as unpublished, and queues every script core names for deletion. Asking again changes nothing. Lifting clears the suspension and restores nothing.
- **The room's applier,** the only writer of a serve entry, run from the room's alarm ahead of everything slower. For each host it writes or removes the entry, reads it back, and asks the room for the version again; if that moved, it starts over. It writes an entry only for a default host, and never while the app is suspended.
- **The script-delete job.** It deletes no script until every host's entry is known to match what the room wants. A script counts as gone only on one of [the two answers that mean gone](adr/0010-release-and-the-content-domain.md#unpublishing); anything else is retried, waiting from 5 seconds up to 5 minutes, and it never gives up.
- **One interface to the provider,** `apps/api/src/content_provider.rs`: read and delete a script, and write, delete and read a serve entry. It needs six settings, and no environment binds any of them. **With none, the applier and the job do nothing and say so:** the work stays recorded as owed, and one log line counts it.
- **One room migration,** two tables: what the applier last confirmed for each host, and the scripts owed a delete.
- **Two event types,** `app.suspended` and `app.suspension_lifted`, recorded as Podster's act and told to the room's managers. The operator's own ID stays in the operators' log.

**What the stand-in is, and isn't.** The tests' provider answers a script's read and delete exactly as spike A recorded. **Its serve-entry answers are an assumption:** no spike has run the KV calls, so the write's body, its answer and a missing key's answer are as the interface expects them, from Cloudflare's documented paths. The interface is strict there on purpose, so a wrong assumption leaves the applier retrying and never lets it record a removal that didn't happen.

**Left for the second PR:** a custom hostname's suspension, kept with its claim, with its generation and the notice to the room that holds it; the stop for the whole content domain and its home in the `Moderation` object; and the applier's two reads before it writes any entry: the stop, from that object and never from a read model, and the hostname's claim for a custom host. Until then the applier writes nothing for a custom hostname.

**Left for the third PR:** the two scheduled reconciles, the provider's list calls, and reports to operators for an entry or a script with no room, or a name Podster didn't make.

**Left for later steps:** the other ten unpublish triggers (step 6); and a release that was waiting, queued or uploading when its room was unpublished, which is left as it is here and failed by the job that owns it (step 5).

**Owed with the provider's configuration,** which is the owner's and waits on the second-account decision:

- **The schedule.** The reconciles' handler arrives with the third PR and is called by tests; **no environment gets a cron entry until a provider is configured** (the architect's ruling, 2026-11-12).
- **Spike G's confirmation of the serve-entry calls,** before any provider is configured.
- **The six settings:** the account, the dispatch namespace, the KV namespace, the content domain, and the two tokens.

**Side by side.** After step 2: steps 3, 4(a) and 10(a). Step 4(b) after 4(a). After steps 2 and 4: steps 8 and 9. Steps 5, 6 and 7 follow in that order.

**What doesn't wait for unfinished M5 behaviour:** step 1; and, once step 2 has merged, step 4, exercised with a test app a script uploads; step 8; step 4(a)'s suspension; and step 10(a). Step 2 waits only for M5's contract and migration PRs to merge. Steps 3, 5, 6, 7 and 10(b) each wait for the M5 step named.

**Deeper review.** Steps 4, 5, 6 and 8 are security-sensitive and each should get a review deeper than the quick diff review. No decision covers that for M6, so each deeper review is asked before it runs.

## What needs the owner's yes

**Moved, 2026-11-12.** There is one list now: [For the owner](#for-the-owner), at the top. Every item this section held is there, with why it is the owner's, what it costs and what the architect recommends. This section as first written, on 2026-11-10, is in this file's history.

## Cloud resources

**The proposal needs new billed resources, more than any earlier milestone.** This plan creates none.

**What exists, as of 2026-11-12:**

- **A dispatch namespace for staging exists since 2026-11-12, by the owner's yes.** Its name is `podster-staging-apps`, on the Cloudflare account that holds `podster.dev`. That account's ID stays out of this repository; scripts take it from `CLOUDFLARE_ACCOUNT_ID`. It holds no script: [spike A](#spike-a-results) put test scripts in it and deleted every one. Whether release ends up on this account or a second one is still [the owner's](#for-the-owner), and spike B's to inform.
- **The owner named `opster.dev` as the content domain,** in these words: "i got opster.dev - i think u can use that domain". It is on the same Cloudflare account, as the zone `opster.dev`, on the Free plan. **No DNS record or route has been made on it.** *(Later on 2026-11-12: the owner added the wildcard record, and spike C made and deleted one route on the zone. The record stays; no route is left.)*
- **The wildcard record waits for the owner:** an `AAAA` record for `*` pointing at `100::`, proxied. The login the architect's sessions use has no DNS scope, so it can't be made from here. *(Done by the owner on 2026-11-12, as spike C's write-up records.)*
- **For the owner, undecided: `opster.dev` is one letter from `podster.dev`.** A separate registrable domain is what the architecture asks for, and this is one. But an address that reads like Podster's own, serving pages agents wrote, is what a phishing page would want, and [the threat model](#threat-model) lists an app imitating Podster's sign-in. Whether that is acceptable is the owner's to say.
- **2026-11-12, later: the content domain is `podster.site`.** The owner wrote: "i actually would like to use podster.site domain iinsite". The three bullets above are kept as history: `opster.dev` was named first and replaced the same day, and spikes A to C ran before the change, spike C on it.
  - **As the architect checked, read-only:** `podster.site` resolves to Cloudflare's nameservers, the same pair as `podster.dev`. It has no wildcard record, and nothing has been made on it. This plan's author didn't check it.
  - **For the owner to do:** the wildcard record on `podster.site` (`AAAA`, name `*`, `100::`, proxied), on whichever account ends up holding the content Worker, and the zone's redirect from HTTP to HTTPS. Putting `podster.site` on the second account from the start is better than moving it later, if the owner agrees to a second account, which is undecided. `opster.dev`'s wildcard record can go when the owner likes.
  - **What carries over from spike C, by reasoning and not by a rerun:** its cookie results rest on the domain being a different registrable domain from `podster.dev` and not being on the Public Suffix List. Both hold for `podster.site`. **Owed before anything is served there:** a short rerun of spike C's header and cookie checks on `podster.site`.
  - **A real difference: `.dev` is HSTS-preloaded as a top-level domain and `.site` isn't.** Browsers force HTTPS for every name under `.dev`. For `podster.site` the content Worker must send `Strict-Transport-Security` itself and the zone must redirect HTTP to HTTPS, and until a visitor's browser has seen that header a first plain-HTTP request is possible. Whether to ask for `podster.site` to be preloaded is open ([ADR 0010](adr/0010-release-and-the-content-domain.md#the-content-domains-name)).
  - **A note for the owner about the name, not a decision.** `opster.dev` was one letter from `podster.dev`; `podster.site` carries Podster's name outright. Anything an agent wrote and a room published is then served under Podster's brand. That is the owner's choice. Its consequence: fast takedown and the report route matter more, and Podster's own pages should say plainly, beside the link, that an app is a room's work and not Podster's.
  - **Code isn't changed by this.** `crates/core`'s tests use `opster.dev` only as example input, and the spikes' folders record what ran. Both are left as they are.

**What the proposal still needs:**

- **A domain,** registered and on Cloudflare, with a wildcard DNS record and a wildcard certificate for the per-room hosts. Billed yearly.
- **A Workers for Platforms dispatch namespace** for staging. Believed billed. One namespace for staging; whether production gets its own is for before production.
- **A new Worker,** `apps/content`, routed on the content domain only. Believed not billed by itself on Workers Paid. **Owner's yes.**
- **Custom hostnames** on the content zone, for step 8. Possibly billed.
- **A hostname-to-app map** for the content Worker. **Proposed:** a Workers KV namespace the private API writes and the content Worker only reads. It routes; it never authorizes. A new resource, small. **Owner's yes.**
- **Durable Object state** for `release_config`, `release` and the room's hostname through the room's own forward-only migrations, and a new Durable Object class for hostname claims (question 10), which is the **owner's yes**. At most a projection table in the API's existing D1 database.
- **Secrets:** the Cloudflare API token, on the private API Worker only. The content Worker and the gateway hold none.
- **GitHub:** a fourth App in `podsterdev`, with Contents read and Metadata read only, for the release job (question 6). **Owner's yes.** No existing App's permissions change.
- **Possibly a second Cloudflare account** (question 3).

## Acceptance tests

**Proposed.** *Revised on 2026-11-12 for ADR 0010's review: M6-04 and M6-23 rewritten, and M6-26 to M6-28 added. M6-06's "where the policy needs a person" is now every release. M6-18's file cap is 300.* Each runs from a script against staging, with test people and staging's organization, `podsterdev`. The owner won't run checks by hand, so a check that can't run that way is recorded as a gap. "The host" means the room's default host on the content domain.

| Test | What it shows |
| --- | --- |
| M6-01 | With deployment off, approving and merging a task creates no release record and the room has no host. That nothing is in the namespace is evidenced by a not-found answer from the content domain; a script can't list the namespace without a credential. `get_task_release_status` reports deployment as off (criterion 7). |
| M6-02 | An owner without the deployment delegation can't switch deployment on (AC-10). On staging the evidence is the refusal, an unchanged `release_config`, no release record and the room's denial record. **A gap on staging:** that no request reached Cloudflare can't be observed from a script. It is shown locally, in a test whose provider stub counts calls. |
| M6-03 | Someone who holds a deployment grant but isn't the room's owner or one of its admins can't change `release_config` or approve a release (AC-11). An admin can, as a person. An agent can't, whatever its role is called, and can't approve (AC-03). |
| M6-04 | With deployment on, in a public room, a person who holds the deployment grant asks for a release of the merged commit and a person approves it: one release is created. It reaches live, and the host serves a marker file whose content is that commit. A merge by itself starts none. |
| M6-05 | A completed, merged task with no deployment grant behind it deploys nothing. `deploy_release` from a person or agent without the grant is denied. An agent with the grant succeeds (AC-17, criterion 3). |
| M6-06 | Where the policy needs a person, a release waits, shows as waiting for approval, and starts only after a person with the grant approves it. An agent can't approve. |
| M6-07 | A commit with no release directory, or one over a cap, ends as a failed deployment with a reason code. The task stays completed, the merge stays merged, and the host keeps serving the earlier release (UI-02). |
| M6-08 | Checks, merge and release are reported separately, each with its time, across these combinations: failed check and no merge; merged and deployment failed; merged and live. |
| M6-09 | `deploy_release` naming a commit that isn't on the default branch through Podster's merge, a task branch's head, another room's repository, or another environment is refused (AC-05, AC-10). |
| M6-10 | A release is queued, then the requester's grant is removed, or the requester is revoked, or deployment is switched off. The job refuses and uploads nothing (AC-13). |
| M6-11 | A repeated request with the same idempotency key creates one release. A job retried after a lost answer leaves one script for that release and one release live. An unknown outcome is recorded as uncertain: an upload is settled by Cloudflare's own answer for that script, and what is served by the release's marker. A second release that fails after uploading leaves the first one serving, untouched. |
| M6-12 | A page on room A's host can't read or set a cookie for the application, in a scripted browser. No response from the content domain sets any cookie, a request carrying a Podster cookie or an `Authorization` header gets nothing more than one without, and no content host is under `podster.dev`. Whether room A's app can set a cookie room B's app reads depends on the Public Suffix List entry: the script records which it saw. **Whether the gate needs the entry is the owner's** ([For the owner](#for-the-owner)). *After spike C, 2026-11-12: without a sandbox, one host's app did set a cookie its sibling read. Whether apps are sandboxed is the owner's too, and this test asserts whichever is chosen.* |
| M6-13 | A deployed app answers only `GET` and `HEAD`, with the fixed headers, and runs no agent-written code on the server. *After the spikes, 2026-11-12: only allow-listed headers of the app's reach a visitor, never a `Set-Cookie`; a release that holds `_headers` or `_redirects` is refused, as M6-07 has it for any release that fails its checks, so no app has either; a separate test, owed with the release job, bypasses that refusal on purpose and uploads a root file of each name directly, to show it comes back as content and sets no header and no redirect; and no third-party script is added to its HTML.* Stated for question 5's proposal; it changes if server code is allowed. |
| M6-14 | A custom hostname routes only after its proof of control passes. Without proof it doesn't route. Removing the mapping stops it. **A gap unless** the script has a domain whose DNS it may edit. |
| M6-15 | A custom hostname that is `podster.dev`, the content domain, a subdomain of either, an IP address, or already claimed by another room is refused. Two rooms racing for one hostname leave one claim. |
| M6-16 | Switching deployment off unpublishes: the host answers not-found within a stated time, and the release records are kept. |
| M6-17 | Rolling back to the release before switches the host to that release's script with nothing fetched or uploaded, under the same grant and approval, as its own release record. Rolling back further uploads that earlier commit again. The host serves the commit asked for either way. After an unpublish there is nothing kept to switch back to. A release whose marker never comes back fails, and puts back what was served before only if nothing unpublished the room meanwhile. |
| M6-18 | The caps hold: an oversized release, too many files, and too many releases in a day are each refused with a reason code. |
| M6-19 | An operator suspends a room's app, by its label and by its host: the host stops serving, and the room's owner can't release while it holds. **Lifting the suspension restores nothing:** the host still answers not-found until the room releases again, by a new request and a new approval. A suspended custom hostname can't be claimed or challenged by any room until an operator lifts it. A report can name a deployed app by its address. Needs a test operator in staging's `OPERATORS`. |
| M6-20 | Archiving a room stops its app from serving. |
| M6-21 | A client-supplied account, namespace, app name or host label is ignored or refused. |
| M6-22 | Logs from every Worker during the run hold IDs and reason codes only: no token, no file content, no hostname. **A gap on staging unless** the session running the script already has Cloudflare access to read the Workers' logs; a script alone can't. Locally, the test run's captured logs are checked. |
| M6-23 | A private room's release request is refused `release_needs_public_room`, with no release record and nothing queued. Making the room public afterwards releases nothing. A public room with a live app that is made private is unpublished, and its host answers not-found. |
| M6-24 | Export and transfer behave as their written policy says. As proposed: a release names its repository ID and commit, so what was released can be fetched from the repository, and no transfer route exists. |
| M6-26 | A custom hostname is claimed only by a room that published its own challenge: a second room asking for a name whose DNS still points at Podster, after the first room's claim ended, gets no claim and no routing without a new challenge of its own. A pending request holds nothing and is gone after 72 hours. Removing the challenge's record ends the claim at the recheck. **A gap unless** the script has a domain whose DNS it may edit. |
| M6-27 | Suspending an app stops it within the stated time, measured from the operator's command. *The stated time waits for spike G; no figure tighter than what was seen is promised.* The stop for the whole content domain stops every app, and so does a failure to read it. A host with no serve entry, an unreadable one, or a KV error answers not-found. A serve entry is only ever written by the room's applier: a write that lands after a removal is put right, shown locally with a stub that delays it. A script whose name fits the rule and that no room claims is deleted by the reconcile; one belonging to a release still uploading isn't; and one whose name doesn't fit the rule is reported to operators and left alone, since Podster didn't make it. |
| M6-28 | Each unpublish trigger unpublishes: release switched off in the room, or for the whole deployment in Podster's configuration; the room archived, made private or deleted; its organization deleted; its public surface suspended; the ability taken from its organization; its repository stopped or lost; and the last person who may release now leaving. Each is confirmed by the provider's answer that the room's scripts are gone, and the host answers not-found. A release queued or uploading before any of them is never served, whichever of the two reaches Cloudflare first. |
| M6-25 | The task Sheet shows Live only when a release record for that commit is live, and shows "Merged · Deployment failed" for M6-07, in a scripted browser. |

## Staging script

**Started on 2026-11-12, at build step 2; not yet run against staging.** *Later that day it ran once and passed: [the first staging run](#the-first-staging-run-2026-11-12).* [`e2e/m6-staging.mjs`](../e2e/m6-staging.mjs), with its lib and a self-test that CI runs, follows `e2e/m5-staging.mjs`:
- it accepts only staging's gateway;
- an unknown flag or a missing value is an error, so nothing is guessed;
- `--dry-run` sends nothing;
- results are tallied as PASS, FAIL and SKIP;
- output is scrubbed of every credential it handles;
- requests are paced and every loop is bounded;
- Ctrl-C stops it at the next request, and it still cleans up.

It takes 2 test sign-ups, switches nothing on, and calls no Cloudflare API. Before any sign-up, two signed-out reads show staging answers as expected. A failed preflight exits 2 with no sign-up taken. The second sign-up is taken only once the owner's organization, room and agent are made. A sign-up is never sent twice: if its answer is lost in transport it may still have been taken, so the run asks for no further sign-up, says the outcome is unknown, and exits 1.

**When it counts as passed.** It exits 0 only when nothing failed and every check that needs staging passed. Two checks are exceptions:
- M6-S00 reads this checkout only, so its pass never counts as the run having shown anything.
- M6-S04 may say SKIP.

Otherwise the run exits 1 and names each check it didn't show, so a run whose setup failed can't read as a pass.

**What it checks today.** Release is switched off on staging, where `RELEASES` is set nowhere, so today's checks are the "switched off" ones. They show two things on staging that `apps/api/test/releases.spec.ts` shows locally: M6 can't be detected, and the room schema step harmed nothing in a fresh room. The M6 operations and fields are read from `packages/contracts/openapi.yaml` at run time, so neither list can go stale. Two names are kept by hand, and the self-test pins each to the files it comes from:
- the planned tool `deploy_release`, pinned to the capability list and ADR 0010;
- the pattern for M6 event types, pinned to every event name the API and core write today.

| ID | What it shows |
| --- | --- |
| M6-S00 | The contract marks its M6 operations, each is listed person-only in `capabilities.yaml`, and none is an agent capability. Reads this checkout only |
| M6-S01a | Switched off, each M6 route gives the room's owner the API's own answer for a missing route, exactly as an invented neighbouring path does: status, error code, body and a named list of headers (content type, cache control, the security headers and the product's own). A pair that differs is asked once more before it fails. A pair that is alike but is a refusal by the gateway or the edge, such as a 401, a limit or a 5xx, fails: it shows nothing |
| M6-S01c | The same for a room that doesn't exist |
| M6-S01d | The same for a member sending a body that isn't JSON, on every M6 write |
| M6-S01b | The same for a second person who isn't in the room |
| M6-S01e | An agent through `/mcp`: an M6 operation's name answers HTTP 200 with the MCP SDK's "tool not found" error, exactly as an invented tool name does, by HTTP and through the MCP SDK. A name with a problem is asked once more |
| M6-S03 | A room made after the deploy runs one ordinary task end to end: create, assign to an agent, accept, submit, review. **A fresh room only** |
| M6-S02a | The room read and the task read, as the owner and as the agent, carry no M6 field |
| M6-S02b | The agent's MCP tool list names tools, and no M6 tool |
| M6-S02d | Capabilities discovery, every page of `/api/auth/capability/list`, names capabilities, and no M6 capability |
| M6-S02c | No M6 event type is in the room's events after every call above |
| M6-S04 | The same task in a room made before the deploy, which is where the room schema step's migration could really harm a room. **Says SKIP unless such a room is reachable,** and today it isn't: such a room belongs to an earlier run's test people, whose sessions no run keeps |

**Which acceptance rows it covers.** None of M6-01 to M6-28 yet. Every one of them needs release switched on, or a merge in a managed repository, which these checks don't make. Some are partly near: M6-01's "the room has no host", M6-12's "no M6 cookie" and M6-21. Even those are shown only with release off, which isn't what their rows ask.

**What comes later,** as checks of the same script with their own IDs, each once its build step is on staging and release can be switched on there for test rooms:
- M6-01 to M6-11;
- M6-12 and M6-13, in a scripted browser, as spike C's `browser.mjs` did;
- M6-15 to M6-21, and M6-23 to M6-28;
- M6-14 and M6-26, only with a domain whose DNS the script may edit, or they stay gaps;
- M6-22, only with access to the Workers' logs, as M5's run had.

**Left behind by a run:**
- the two test people;
- the organization made for the run;
- the room and its task;
- the agent.

The agent is disconnected at the end, which ends its OAuth credential; the output says if that failed. If the agent's connect fails after the consent made it, the run finds it by name in its organization and disconnects it, or lists it as left behind. Every session is signed out.
## Threat model

**Draft, to be walked against the built system at step 11.** *Where a row and [ADR 0010](adr/0010-release-and-the-content-domain.md) differ, the ADR is the later word: rows written on 2026-11-10 still speak of a private room's app and of the Public Suffix List as defence in depth.* "Unverified" means nothing has tested it. "From M5's spike" means the M5 spike saw the GitHub half once; the M6 half is still unverified.

| Threat | Proposed mitigation | Verified? |
| --- | --- | --- |
| A deployed app reads or sets the application's cookies, or another room's | A separate registrable domain, one host per room, nothing under `podster.dev`, and no cookie set and no credential accepted by Podster on any app hostname. That protects the application without the Public Suffix List entry. Between rooms, the entry is defence in depth: until browsers ship it, one room's app can set a cookie another's reads, a known gap. A sandboxing Content Security Policy on every response is a candidate for ADR 0010 | Unverified. Browsers' uptake of a new list entry is outside Podster's control. *Seen in spike C, 2026-11-12, in three headless browsers: the application's cookies were out of reach; sibling hosts read and overwrote each other's domain cookies; a sandbox closed that and cost an app its storage. The sandbox is the owner's choice* |
| A deployed app reaches Podster's data | The app has no bindings. The content Worker has none to the gateway, the API, D1 or R2 | Unverified. The architecture cites Cloudflare's isolation page; nothing was tried. *Seen in spike A, 2026-11-12, for one test script: no bindings, an empty `env`, and a 404 from another Worker of the account* |
| Agent-written server code calls out, mines or attacks from Podster's account | Static files only in M6 (question 5), so no agent-written code runs on Cloudflare | Unverified, and gone if server code is allowed |
| Unreviewed code is deployed | Only a commit that Podster's merge job put on the default branch and confirmed there is releasable, checked in Rust and rechecked by the job, which reads the files at that exact commit | From M5's spike for the merge path. Unverified for the release |
| An approved or merged task deploys with no deployment authority | Deployment needs its own grant and the room's policy, checked in Rust at the command and again in the job. Approval and merge grant nothing (AC-17) | Unverified |
| A stale job deploys after revocation or after deployment is switched off | The job rechecks current authority and the current `release_config` version before its external call (AC-13) | Unverified |
| The publishing credential leaks, or is used on the wrong target | Held by the private API Worker only, scoped as narrowly as Cloudflare allows, with the account, namespace and app name from trusted configuration and server-generated names. A second account if the scope can't exclude Podster's own Workers | Unverified. The token's narrowest scope isn't known |
| A client steers a release to another account, namespace or app | None of those is accepted from a client (M6-21) | Unverified |
| Someone maps a hostname they don't control, or takes over one whose DNS was left pointing at Podster | Proof of control before routing, one claim per hostname owned by a single object, the proof rechecked on a schedule, and routing removed when it fails or the mapping is removed | Unverified. The custom-hostname flow is the spike the architecture asks for |
| A custom hostname is Podster's own name or another room's host | Refused in `crates/core` (M6-15) | Unverified |
| Podster hosts phishing, malware or illegal content written by an agent | Deployment is off by default and switched on by a person; releases are of reviewed, merged commits; a person approves each release in a public room; operators can suspend an app; reports can name one; the terms cover it | Unverified. The legal text isn't written |
| A deployed app imitates Podster's sign-in | A different registrable domain, a server-generated host label that never contains a room's or Podster's name, and operator suspension | Unverified *2026-11-12: more convincing on `podster.site`, which carries Podster's name where `opster.dev` only resembled it. The label is still random; the domain now says Podster. The owner's choice, recorded with its consequence* |
| A deployed app runs up Podster's bill | Caps on a release's size and file count, releases per day and one app per room; static files only; platform limits if the spike finds them | Unverified. No platform limit has been tried |
| A private room's existence or work leaks through its host | Working assumption until the owner answers question 11: a private room's app isn't served to anyone who can't already see the room. *(2026-11-12, decided on the owner's behalf as [decision 213](spec/PRODUCT.md#decisions-needed): a private room's app isn't served at all in M6.)* Also a random host label and nothing about a release on public pages. An address still leaks by itself: through the `Referer` header on links out of the app, answered with `Referrer-Policy: no-referrer` on every response; through certificate-transparency logs, which publish a custom hostname when its certificate is issued, and a per-room certificate would do the same for a default host, so the default hosts use one wildcard certificate; and through browser history and sync, which Podster can't prevent. So an unguessable address is never the control | Unverified |
| A lost answer from Cloudflare leaves the record and the served content disagreeing | An uncertain state, settled by reading back what is served and comparing it with the release's commit | Unverified |
| A deployed app keeps running in a visitor's browser after it is unpublished or suspended, from a service worker or a cache | The content Worker refuses requests for a service-worker script, so none is registered from a room's host; responses carry short cache lifetimes; and the not-found answer after an unpublish or a suspension carries `Clear-Site-Data`. A visitor who never returns keeps what they have | Unverified. *Seen in spike C, 2026-11-12: refusing the script stopped registration in three headless browsers; `Clear-Site-Data` left WebKit's service worker serving, so it is a best effort only* |
| A forged or replayed event starts a release | A release starts only from a command or from Podster's own recorded merge, never from a webhook observation alone | Unverified |
| Repository content is treated as instructions | The job copies files and reads no configuration from them beyond a fixed directory name. Agent content is data | Unverified |
| A failed release is shown as live | Each attempt is its own record; live is set only after the job confirms what is served (UI-02) | Unverified |
| A second room takes over a custom hostname whose DNS was left pointing at Podster, or a room squats a name it doesn't control | Added 2026-11-12, from the review. Podster's own challenge, bound to the room's request, checked before any claim and before Cloudflare; pending holds nothing; a claim never transfers, and its custom hostname is read until gone before the claim is freed | Unverified |
| One room's phishing page gets the whole content domain blocklisted | Added 2026-11-12, from the review. Not prevented while the Public Suffix List entry is missing. A release only of reviewed work a person approved, in a public room; a report by address; suspension in about two minutes by the plan, unmeasured; per-room hosts | Unverified. A consequence, recorded *2026-11-12: on `podster.site` a blocklisting also names Podster* |
| The publishing credential is used to replace the content Worker itself | Added 2026-11-12, from the review. In the second account it can. It reaches nothing of Podster's; it is held in one place; the reconcile compares the content Worker's deployed version; the owner's dashboard is the last resort | Unverified |
| A visitor's first request to an app's host is plain HTTP, and someone on the network path answers it | Added 2026-11-12, with the move to `podster.site`: `.site` isn't HSTS-preloaded as `.dev` is. The content Worker sends `Strict-Transport-Security` on every response and the zone redirects HTTP to HTTPS. Neither covers a browser's very first request to a host; only preloading the domain does, which is open | Unverified |
| A workflow in the repository deploys by itself | Actions stay off, as ADR 0009 proposes, and no App holds Workflows. Actions being off is proposed and not currently true | From M5's spike: Actions were on in a new repository |

## Questions for the architect

**Proposed answers by the architect. Since 2026-11-12, questions 4, 6, 8, 9, 10, 12 to 17 and 20 to 23 are recorded as [decisions 197 to 211](spec/PRODUCT.md#m6-decisions-november-12-2026), for the owner to review, and [ADR 0010](adr/0010-release-and-the-content-domain.md) rests on them. Questions 1, 2, 3, 5, 7, 11, 18, 19's purchase and 24 are the owner's, and are in [the table at the top](#for-the-owner).** "Owner's yes" marks an answer or an alternative that costs money, creates an account or resource, is legal text or loosens the stance. "Owner only" marks a question the architect can't answer at all.

| # | Question | Proposed | Alternative |
| --- | --- | --- | --- |
| 1 | Where do deployed apps run? | Podster's platform: a Workers for Platforms dispatch namespace, as the architecture and decision 11 recommend. **Owner's yes** for the add-on. | A customer's own Cloudflare account. Later, with its own delegation design. |
| 2 | Who pays? | **Owner only.** On staging, Podster. Preview stays free, so no charge is passed on. | |
| 3 | Same Cloudflare account as Podster's own Workers, or a second one? | **Changed on 2026-11-12, by what the documentation shows:** a second account, unless a spike finds a token that can't touch Podster's Workers. Cloudflare's permissions page shows no token permission scoped below the account for Workers. **Owner's yes** either way. *It was: decided by the spike, the same account if the token can be scoped.* | Accepting an account-wide token beside Podster's Workers. Loosens the stance; not proposed. |
| 4 | Where do builds run? | Nowhere in M6. A release is a fixed directory already committed at the merged commit, copied as it is. Podster runs no agent-written build, and Actions stay off. | GitHub Actions in the managed repository, which reverses ADR 0009's proposal and needs its own decision. A Podster build service, which runs untrusted code on Podster's account. Both the owner's yes. |
| 5 | Static files, or server code too? | **Decided on the owner's behalf on 2026-11-12 ([decision 214](spec/PRODUCT.md#decisions-needed)): static files only. What follows is the first draft.** **Owner only**, both ways. The working assumption is static files only. The architecture describes each app as a user Worker; under the assumption that Worker is Podster's fixed file server, or a static-assets upload, whichever the spike shows works. It narrows core job 8's "working web application" to what runs in a browser, and that narrowing needs the owner as much as the alternative does. | An agent-written Worker with no bindings and blocked outbound requests, after a spike of the isolation. Podster would then be running code an agent wrote, which touches "Podster never hosts or runs agents": the code isn't an agent, but the line needs the owner to draw it. |
| 6 | Which credential reads the files from GitHub? | A fourth App with Contents read and Metadata read only, used by the release job alone, its token cut down to the one repository and never returned. ADR 0009 keeps provisioning, agent tokens and merge apart, and a release shouldn't borrow any of them. **Owner's yes**, to create it. | The merge App's token cut down to reading. Not proposed: it puts the merge key in the release path. An unauthenticated read of a public repository, which fails for private ones. |
| 7 | What is an environment? | **Decided on the owner's behalf on 2026-11-12 ([decision 214](spec/PRODUCT.md#decisions-needed)): one, `production`, and no preview of unmerged code.** One per room in M6, named `production`, as DESIGN.md's copy uses. `environments_json` holds that one entry. This leaves out the preview URL that `PRODUCT.md` names, which is the **owner's** to confirm with question 5. | A preview environment for unmerged commits. **Owner's yes**: it serves unreviewed agent code. |
| 8 | What are the approval policy's values? | **Changed on 2026-11-12 by the review ([decision 199](spec/PRODUCT.md#m6-decisions-november-12-2026)): `person` only, and only a public room releases. What follows is the first draft.** `person`: a person with the deployment grant approves each release, the default, and the only value in a public room. `on_merge`: a merge starts the release, only if the person who asked for the merge also holds the deployment grant; otherwise the release waits for approval. **Stated plainly:** under `on_merge`, an agent that holds both the merge grant and the deployment grant publishes with no person involved at that moment. A person chose `on_merge` and gave both grants, and a reviewer other than the submitter approved the work, but in a private room that reviewer may be an agent too. So the question is also whether `on_merge` is offered at all where the room doesn't require a person as reviewer. Proposed: it isn't; `on_merge` needs the room's person-review setting on. | `on_merge` wherever the owner chooses it, or as the default. **Owner's yes.** |
| 9 | Who holds deployment authority? | **Decided on the owner's behalf on 2026-11-12 ([decision 215](spec/PRODUCT.md#decisions-needed)): the room's owner and its admins configure and approve, as people; an agent never.** Podster's platform is the resource owner and delegates to the room's owner for that room's app only, as decision 18 proposes for repositories. Others need a `provider_grant` with a `deploy` action, given by the owner. Whether a room may switch deployment on at all is trusted configuration on staging. | Any admin can deploy. Loosens AC-10; not proposed. |
| 10 | Who owns a hostname's uniqueness across rooms, and how does a claim commit? | A separate object: one small Durable Object per normalized hostname, in the private API, holding at most one claim, since a D1 row must never authorize. It spans two objects, with no distributed transaction. (1) The room's command checks policy and commits `hostname.requested`, its event, an outbox job and the idempotency record in one transaction. (2) The job asks the hostname object, which in its own transaction records the claim for that room and request, or refuses if another room holds it. Asking again with the same room and request gets the same answer. (3) The job reports back, and the room commits `hostname.claimed` or `hostname.refused`. Routing starts only after the room has recorded the claim and the proof of control has passed. Removal runs the same way in reverse: the room commits the removal and stops routing first, then the job frees the claim. A job that dies between steps leaves a hostname held and not routed, never held twice, and its retry finishes it. | A unique index in D1 as a reservation. Simpler, and at odds with "read models never authorize". |
| 11 | Who may open a deployed app? | **Decided on the owner's behalf on 2026-11-12 ([decision 213](spec/PRODUCT.md#decisions-needed)): a public room's app is public, and a private room's app isn't served at all in M6. What follows is the first draft.** **Owner only.** The architect can't decide it, because serving a private room's app to anyone with the address loosens private-room visibility. Working assumption until the owner answers, as the safest option: a public room's app is public, and a private room's app isn't served to anyone who can't already see the room. Gating by sign-in would need a Podster session on the content domain, which the separate domain exists to prevent, so the way to serve it to the room's own people is undesigned; a signed, expiring link issued by the application is the candidate for ADR 0010. Until that is designed and reviewed, a private room's app isn't served at all. | Anyone with the address, whatever the room's visibility, said plainly and confirmed at setup. **Owner's yes.** |
| 12 | What are the caps? | **Changed on 2026-11-12: 300 files a release, and 3,000 reads an hour by the release App across the deployment ([decision 202](spec/PRODUCT.md#m6-decisions-november-12-2026)).** Per room: one app, 25 MB and 1,000 files per release, 20 releases a day, one custom hostname. Placeholders until the spike shows the platform's own limits. | Higher caps, or none. **Owner's yes**, as money. |
| 13 | Rollback | **Changed on 2026-11-12 ([decision 203](spec/PRODUCT.md#m6-decisions-november-12-2026)): a switch back to the release before, whose script is kept; a new release only for anything earlier.** A new release of a commit that was live before, under the same grant and approval. Nothing is rewritten. | Automatic rollback on failure. Not needed: a failed release leaves the earlier one serving. |
| 14 | What happens to an app when deployment is switched off, the room is archived, or the room's owner leaves? | **Changed on 2026-11-12: the full list of what unpublishes is [decision 204](spec/PRODUCT.md#m6-decisions-november-12-2026); the owner leaving is in [the owner's table](#for-the-owner).** Off and archived both unpublish and keep the records. An owner's departure leaves the app serving until recovery, like the repository. | Keep serving an archived room's app. |
| 15 | Can operators suspend a deployed app? | Yes: a new operator power beside decision 158's (decided, for the owner to review), to stop a room's app from serving and to lift that. They still read nothing private. Reports can name an app. | Owner removal only. Not proposed: Podster hosts the content. |
| 16 | Secrets and bindings for deployed apps | None in M6. | Per-room secrets. Later; a design of its own. |
| 17 | Proof of control for a custom hostname | **Tightened on 2026-11-12 ([decision 207](spec/PRODUCT.md#m6-decisions-november-12-2026)): Podster's own room-bound TXT challenge, before any claim and before Cloudflare.** A DNS record the owner publishes, checked by Rust's job before routing and on a schedule after. The exact records depend on Cloudflare's custom-hostname flow, which the spike validates. | An HTTP file check. Decided with the spike. |
| 18 | Export and transfer | Export: a release names its repository and commit, and a public repository can be cloned. Transfer of a repository or an app to its owner's account isn't offered. Uploads' export stays deferred to before production, as decision 167 says (decided, for the owner to review). **Owner's yes**: ADR 0009 left transfer and deletion to the owner. | Building transfer in M6. Waits on the managed organization's legal terms. |
| 19 | Does staging need the real content domain? | Yes. The origin boundary can't be shown on a `podster.dev` host. | A `workers.dev` host for the first spike only, never for the gate. |
| 20 | Does M6 serve previews of uploaded HTML, SVG or video? | No. Decision 52's download-only stands. The content domain makes a later preview possible, on a per-object origin, as its own change. | Bring previews into M6. Not proposed. |
| 21 | Can a public claimant hold a deployment grant? | No. The Public participant and Guest presets never carry one, and a grant needs the owner's explicit act for a named principal. | Allowed by explicit grant. **Owner's yes.** |
| 22 | When does M6's code start, and when does its gate run? | Step 1 now. Steps 4, 8, 9 and 10(a) once step 2 has merged and the owner has said yes to the domain and the add-on. The rest behind the M5 steps named. The gate waits for M5's. | Wait for M5's gate before any M6 code. |
| 23 | Calling M6's gate | The architect proposes it after the staging run and the security review, for the owner to review. Test people count, as decision 79 says; real people stay owed before production. | |
| 24 | Which reading of criterion 8 does M6's gate use? | **Owner only.** The milestone table gives M6 the whole criterion. Proposed: the whole of it, with upload permissions, retention and public-room abuse controls shown again by rerunning the M2 and M4 staging scripts at the gate's commit. | Only the custom-domain, export or transfer and release-approval parts, resting on M2's and M4's own gates for the others. |

## Risks to test

The spikes at step 1 answer these before any feature code. **A, B, C, E and F have run; D and G haven't.** Answered for what was tried: 1, 2, 4 and 5's namespace half by [spike A](#spike-a-results); 6's browser half, 12's wildcard half and 13 by [spike C](#spike-c-results); 10 and 11 for a public repository by [spike E](#spike-e-results); 3's upload half by [spike B](#spike-b-results). Not answered: 3's custom-hostname half; 5 for a serve entry (spike G); 6 for the Public Suffix List's own questions; 7, 8 and 12's custom-hostname half (spike D); 9, which spike A couldn't measure; and 14, for the reason in [spike F results](#spike-f-results).

1. Does a user Worker in a dispatch namespace, in untrusted mode, have no access to the account's other Workers, KV, D1, R2 or caches? What does it share?
2. Can a namespace hold a static-files-only app, and how is one uploaded? What are the size and file limits?
3. What is the narrowest API token that can upload to one namespace and manage custom hostnames on one zone? Can it touch the account's other Workers? *The upload half is answered in [spike B results](#spike-b-results): Workers Scripts Edit, and yes. The custom-hostname half isn't.*
4. Can an upload be read back, so the job can confirm which commit is being served?
5. How long after an upload or a delete does the host serve the new state?
6. What does the Public Suffix List ask of a new entry, how long does acceptance take, and how long until browsers ship it? Whether anything waits for it is the owner's. Either way: what can one room's app do to another's without the entry, and does a sandboxing Content Security Policy close that without breaking ordinary static apps?
7. Does the custom-hostname flow prove control before any traffic routes? What does it issue certificates on, what does a hostname cost, and what happens when the customer's DNS is removed or pointed elsewhere?
8. Can one room's custom hostname be made to route to another room's app by a request's `Host` header or SNI?
9. Which per-app limits does the platform offer: requests, CPU, size? Do they apply to static files?
10. Does a read-only App's token, cut down to one repository, read a private and a public managed repository, and can the job fetch a directory at an exact commit without following anything the repository controls, such as submodules or symlinks?
11. What does GitHub return for a large directory or a large file, and do its rate limits fit a release?
12. Can a wildcard host and custom hostnames both route to one Worker on the content zone, with nothing on `podster.dev`?
13. Does refusing service-worker scripts at the content Worker stop registration in current browsers, and does `Clear-Site-Data` on a not-found answer clear what an app cached?
14. From ADR 0009, still open: whether a workflow already in a repository can run with Actions switched off per repository.

## How far this was checked

- **Read:** `CLAUDE.md`; `PRODUCT.md` in full to the first decisions, and its later decisions by search for deployment, release, domain and M6; `ARCHITECTURE.md`'s content origins, M5 and M6 sections; `ACCESS-CONTROL.md` in full; `DESIGN.md`, `RUNNER.md`, `CONTRIBUTORS-AND-LIMITS.md` and `TASK-PLANNING.md` by search for deployment and release; the M5 plan in full; the M4 plan's opening, cloud resources and run record; ADR 0009's Apps, Actions, deletion and legal sections. All on `main` at `f1096ce`.
- **Checked against GitHub:** #236 and #238 are merged.
- **Not checked:** that #236's fixes are deployed, and the state of staging. Both are as the lead session reported.
- **Nothing about Cloudflare or GitHub is verified, in the sense of tried.** On 2026-11-12 the plan's platform claims were read in Cloudflare's and GitHub's own documentation and pricing pages: [what was found](#platform-facts-from-the-documentation), with each page linked. That is reading, not running: no account, namespace, hostname, token or App was created or called. Pages were read through a page reader; three long ones partly as a summary and not word for word, and the claims that rest on them say so. Where a page was silent the plan says "not found". Sections of this plan written on 2026-11-10 that still say "believed" or "may" are superseded by that section where they differ.
- **Not read on 2026-11-12:** the Public Suffix List's guidelines wiki; Durable Objects' pricing; browsers' behaviour, which no documentation settles.
- **Reviewed four times,** on 2026-11-12: the first review asked for two blockers and several required changes, the second for one blocker and several smaller ones, the third for two more on the order of publishing, the fourth for one. All are applied.
- **Not checked by this plan's author:** the owner's enabling of Workers for Platforms, and the refused read of the account, are as the architect reported them. **The architect checked the last review's fix and accepted the ADR on 2026-11-12.** Nothing in it has been tried.
- **Read for the review's questions, on 2026-11-12:** Workers KV's pricing, limits and consistency; Workers' pricing; the `_headers` and `_redirects` pages; the pre-validation and remove-custom-hostnames pages; Cloudflare Registrar's pages; Cloudflare's self-serve agreement and developer-platform terms, for one point only; GitHub's rate limits and tree schema.
- **Still not found:** a domain's price on Cloudflare's own pages; whether a custom hostname's delete is immediate; which zone permission the custom-hostname API needs; whether a cached KV read is billed.
- **Parts of this plan written on 2026-11-10 weren't all rewritten.** The questions table, the threat model and the acceptance tests carry dated notes where the review changed them; where one still differs from ADR 0010, the ADR is the later word.
- **Not found in the specs:** any policy document for custom domains, release approvals, or export and transfer; any definition of an environment, the approval policy's values, the release states, or the budget caps.
- **Not read:** the code. This plan doesn't claim what `apps/api`, `apps/gateway` or `apps/web` hold today beyond what the plans and specs say.
- **After the spikes, 2026-11-12:** ADR 0010 and this plan were revised from the four spike sections in this file as they stand on `main`. **The spikes' recorded results in `spikes/` weren't reread for that revision,** and nothing was run for it. In the write-ups, five passages that said more than was seen are marked "Tightened", one that sat under the wrong heading is marked "Corrected", and one figure the committed results can't check is withdrawn. The revision hasn't been independently reviewed.
- **The content domain's change to `podster.site`, 2026-11-12:** recorded from the owner's words as the architect reported them. Nothing was run or looked up for it: that the domain resolves to Cloudflare's nameservers and has no record is the architect's read-only check, and that `.dev` is an HSTS-preloaded top-level domain and `.site` isn't was stated by the architect and not looked up here.
- **Run:** nothing when this plan was written. **Since, on 2026-11-12:** spikes E and F, which wrote one branch and two loose objects to one test repository and changed nothing else; their sections say what was and wasn't shown. **Also on 2026-11-12, spike A,** which put test scripts and one Worker on staging's Cloudflare account and deleted every one: [its results](#spike-a-results) cover the dispatch namespace only. **And spike C,** which made one Worker, one route on `opster.dev` and three namespace scripts, and deleted them: [its results](#spike-c-results). **And spike B,** which made and deleted five test scripts on that account with three tokens the owner made, and sent Podster's own Workers nothing but reads: [its results](#spike-b-results).

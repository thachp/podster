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

**These are the owner's to decide. None in the table was decided when it was written, and two have been since, each marked in its row; three that were here have been decided on the owner's behalf and are listed beneath it. This is the one list:** the plan's older "What needs the owner's yes" section now points here. Each row stands alone. Prices are Cloudflare's list prices in US dollars, as read on 2026-11-12 on the page linked in the row; they aren't a quote. "Recommended" is the architect's.

| What | Why it's the owner's | What it would cost | The architect recommends |
| --- | --- | --- | --- |
| **A content domain.** A new registrable domain, used for nothing but apps that agents wrote, on Cloudflare. **Answered by the owner on 2026-11-12: `podster.site`,** in these words: "i actually would like to use podster.site domain iinsite". It replaces `opster.dev`, named earlier that day. **Still the owner's to do:** the wildcard record on `podster.site`, an `AAAA` record with the name `*` pointing at `100::`, proxied, on whichever Cloudflare account ends up holding the content Worker; and the zone's redirect from HTTP to HTTPS. If the owner agrees to a second account, which is the next row but one and undecided, it is better to put `podster.site` there from the start than to move it later. `opster.dev`'s wildcard record can be removed whenever the owner likes | Money, a cloud resource and DNS. Its name is the owner's choice | A yearly registration. Cloudflare Registrar says it sells at what the registry and ICANN charge, with no markup ([Registrar](https://www.cloudflare.com/products/registrar/)). **No price for a `.com`, `.dev` or `.app` name was found on Cloudflare's own pages,** so no figure is given here. The zone can stay on Cloudflare's Free plan: proxied wildcard DNS records are on every plan ([wildcard DNS](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/)) and the free certificate covers first-level subdomains ([Universal SSL](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)) | **Yes.** Nothing agent-written may be served from `podster.dev`, so release can't exist without it |
| **Workers for Platforms.** Cloudflare's plan for running other parties' Workers, each isolated from the rest. It holds each room's app. **The owner said on 2026-11-12 that they have enabled it.** Which account it is on isn't confirmed: a read-only check of the account that holds `podster.dev`, at 01:33 UTC that day, was refused with Cloudflare's code 10121, no access to dispatch namespaces. *Later that day: it is on that account, and one dispatch namespace for staging exists there ([Cloud resources](#cloud-resources))* | A paid plan | **$25 a month,** including 20 million requests, 60 million CPU milliseconds and 1,000 scripts; then $0.30 a million requests, $0.02 a million CPU milliseconds and $0.02 a script. A room with an app uses up to three scripts, so the included 1,000 cover about 330 such rooms ([pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/pricing/)). Assume every visit to an app is one request | **Yes, and it is done.** It is on the account that holds `podster.dev`, confirmed on 2026-11-12 by a listing of the staging namespace, which answered empty. Whether release stays on that account is the next row, which recommends a second one |
| **A second Cloudflare account,** holding the content domain and everything that serves apps, and nothing of Podster's own. **Decided by the owner's action on 2026-11-12** ([decision 217](spec/PRODUCT.md#decisions-needed)): the owner created it and asked how to move `podster.site` to it. **Still the owner's to do:** the move, which can't happen before 2026-11-22; the wildcard record and HTTPS redirect there; Workers for Platforms on that account; and a deploy credential for the content Worker only | An account creation | No charge for an account was found. The plans in this table would be bought on it | **Yes, unless a test finds a narrower credential.** The credential that publishes an app can write Workers scripts, and Cloudflare's documentation shows no way to limit that to one group of scripts ([API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)). On Podster's own account it could replace Podster's API |
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
| **Whether every app is sandboxed in the browser.** **Decided by the owner on 2026-11-12: (a), every app is sandboxed in M6,** in the owner's words "1. confirm" ([decision 216](spec/PRODUCT.md#decisions-needed)); the content Worker sets the header on every response. Added on 2026-11-12, from spike C. Without the Public Suffix List entry, one room's app was seen reading and overwriting a cookie another's set for the whole domain. A sandboxing header closed that, and cost the app every kind of browser storage: cookies, `localStorage`, `sessionStorage`, IndexedDB, caches and service workers. The options: **(a)** sandbox every app; **(b)** no sandbox until the domain is on the list, with rooms able to interfere through cookies a script sets, which the server can't stop; **(c)** sandbox by default, with an opt-out the room's owner sets. [The ADR sets out each](adr/0010-release-and-the-content-domain.md#the-sandbox-an-open-choice-for-the-owner) | It is a product choice: what "a working web application" may do, against whether rooms are kept apart now | None | **(a), for this milestone.** It is the only one that keeps rooms apart with what Podster controls today, it fails where the owner can see it, and it can be loosened later where the others can't easily be tightened. An app that must remember something in the browser won't work under it |
| **What happens to a room's app when its owner leaves** | It decides whether content stays up with nobody answerable for it | None | **The app comes down when no person who may release remains in the room.** That is also what holds until the owner answers |
| **Whether a repository's link that is `degraded` unpublishes the room's app.** Added on 2026-11-13 with M6 step 6. ADR 0010 says an app comes down when its repository's link is no longer ready, and the architect ruled to build it as written, since narrowing an accepted trigger isn't the architect's. `degraded` is set by the daily read-back, a merge's read or an operator's recheck when a protection or setting differs or the repository is gone, and goes back to `ready` when an operator's recheck finds it fixed | It narrows or keeps a trigger in an accepted ADR, and it decides whether a transient settings change can take a public app down | **A transient settings change costs the room its app's address for good:** an unpublish retires the label, and nothing comes back when the link is ready again | **As ruled, and as step 6 builds it: unpublish on `degraded` and `suspended`.** The alternative is to unpublish on `suspended` only, and on `degraded` only refuse new releases, which the recheck already does. Either is a one-line change: one predicate in core, tested both ways ([the step 6 plan](m6-step6-plan.md)). **A risk either way, from the review of step 6's first PR:** a GitHub incident, or the provisioning App suspended or removed, could make every repository read as gone, two 404s a minute apart, which degrades every link as `repository_gone` and retires every app's address for good. *Proposed, for the owner to choose from:* (a) never take "gone" as final while the App's installation itself is unreadable or suspended, so an installation-wide failure reads as "couldn't read", not as every repository gone; (b) a ceiling on how many rooms may be unpublished for `repo_not_ready` in one pass or one hour, past which further rooms wait for an operator to confirm; (c) both. The architect recommends (c). Neither is built |
| **Who may retire an app's address.** Added on 2026-11-13 with M6 step 6. Archiving a room and making it private each unpublish its app for good, and both are the room's owner's or a human admin's to do (decisions 149 and 215), so an admin, not only the owner, can retire the address | It decides who can end a public app permanently | None | **As built: the owner or an admin.** The alternative is to ask the owner's confirmation before an admin archives or makes private a room whose app is up |
| **Who pays, and whether an app's traffic is capped** | Money | Past the included 20 million requests a month, $0.30 a million ([pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/pricing/)) | On staging Podster pays. **No cap on one app's traffic is designed;** say whether one is wanted before production |
| **Agent-written content served publicly on staging** | A new exception of the same kind as public rooms, which the takedown document's staging exception doesn't cover | None | **Yes, for test rooms,** with the operator's stop built first |
| **Cloudflare's terms for serving other parties' content.** Its developer-platform terms make the customer solely responsible for what its end users do, and let Cloudflare block or remove content it deems illegal or harmful ([service-specific terms](https://www.cloudflare.com/service-specific-terms-developer-platform/)) | A contract, which the owner accepts | None found | **Read them before buying.** They were read here only for that one point |
| **Legal text:** Podster's own terms, acceptable use and takedown, extended to apps and custom domains | Legal text; may need a lawyer | Not known | Owed before any real person's app is served |
| **Export and transfer** of a repository or an app to its owner's own account | The owner kept repository transfer and deletion for themselves in ADR 0009 | None | **Not offered in this milestone.** A release names its repository and commit, and a public repository can be copied |
| **What this milestone's gate must show:** the whole of expanded criterion 8, or only the parts this milestone builds | It decides what "done" means | Running the M2 and M4 staging checks again spends their test sign-ups | **The whole criterion,** with M2's and M4's parts shown again at the gate's commit |
| **Deeper security reviews** of the four riskiest steps: the content Worker, the release job, starting and approving a release, and custom domains | Each is asked for before it runs | Time | **Yes to each,** asked one at a time when its step is ready |

**Decided on the owner's behalf, 2026-11-12.** The owner wrote "you should make decision on my behalf you are the chief of staff". Under that the architect decided three rows that were in this table, each for the owner to review:

- **Who may open a deployed app:** a public room's app is public, and a private room's app isn't served at all in this milestone ([decision 213](spec/PRODUCT.md#decisions-needed)). Not taken: serving a private room's app to anyone with its address.
- **What an app is:** static files only, in one environment, `production`, of merged and reviewed code, with no preview of unmerged code in this milestone ([decision 214](spec/PRODUCT.md#decisions-needed)). It narrows core job 8's "working web application" and `PRODUCT.md`'s "preview/live URL" for this milestone. Not taken: code an agent wrote running on a server, and a preview environment. *2026-11-13: the owner has since said an app is a real Worker, code included ([decision 219](spec/PRODUCT.md#decisions-needed)). This is left as written. What replaces it is proposed, not accepted, in [ADR 0010's proposed revision](adr/0010-revision-apps-are-workers.md).*
- **Who may switch release on for a room and approve each release:** the room's owner and its admins, as people; an agent never, as for repositories ([decision 215](spec/PRODUCT.md#decisions-needed)). Not taken: the room's owner only, which was the interim rule.

**Decided by the owner, 2026-11-12.** Two rows above are now the owner's decisions, each marked in its row:

- **Every app is sandboxed in the browser in M6** ([decision 216](spec/PRODUCT.md#decisions-needed)). The architect put it as "Sandbox every app for M6. Apps lose their own browser storage but can't read each other's cookies. I recommend yes", and the owner answered "1. confirm". An app has no cookies, `localStorage`, IndexedDB or other browser storage of its own.
- **A second Cloudflare account holds what serves apps** ([decision 217](spec/PRODUCT.md#decisions-needed)), decided by the owner's action: they created it and asked how to move `podster.site` there.

**Everything in the table above is still the owner's and undecided,** except the two rows the owner decided on 2026-11-12, above, which this sentence predates. In particular: whether anything is served before the Public Suffix List entry exists, which would loosen a "must" in the architecture; a second Cloudflare account; custom hostnames; the fourth GitHub App; the publishing credentials and other secrets; the legal text; a cap on traffic; what happens to an app when nobody who may release remains; and, added after spike C, whether every app is sandboxed in the browser. **Answered since: the content domain, `podster.site`.** Two things about that name are notes for the owner and not decisions, [below](#cloud-resources): it carries Podster's name, and `.site` doesn't force HTTPS as `.dev` does.

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
- **Static files only, as a working assumption:** a release is files a browser loads, with no agent-written code on the server. This narrows core job 8's "working web application", so it was the **owner's** to confirm (question 5). *Decided on the owner's behalf on 2026-11-12 ([decision 214](spec/PRODUCT.md#decisions-needed)): static files only, one environment, no preview of unmerged code.* *2026-11-13: the owner has since said an app is a real Worker, code included ([decision 219](spec/PRODUCT.md#decisions-needed)). This is left as written. What replaces it is proposed, not accepted, in [ADR 0010's proposed revision](adr/0010-revision-apps-are-workers.md).*
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

> **2026-11-13: the owner has said an app is a real Worker, code included** ([decision 219](spec/PRODUCT.md#decisions-needed)). What that changes in this order, in what is built and in what must be true before `RELEASES` is on, is proposed in [ADR 0010's proposed revision](adr/0010-revision-apps-are-workers.md), which is not accepted. The order below stands as written until it is. The room's half of step 5 doesn't depend on what an app contains: its recheck is on `main`, and starting an upload and committing live are in PR #336, not yet merged.

> **2026-11-13: step 5's remaining pieces, the tree read and the upload, are held** until that proposal is accepted, since what a release contains is what is changing.
>
> **Owed by the next PR that touches the room's release commands or takedown, from the review of step 5's second PR, which is PR #336 and not yet merged. Each is about code in that PR:**
>
> - **The three held-window tests use the real clock.** Each holds a commit between its outside reads and its confirm while a fact is changed in another object, so each rests on that change finishing inside the 5-second bound on the reads' age. Under load they fail; they don't pass falsely. Give them the passed-in clock.
> - **A release bookkeeping failure after a suspension is seen only as a log line by its code.** It is retried on every alarm, release command and reconcile question, and that room's release commands answer an error meanwhile. **Write a takedown finding for a bookkeeping failure that persists,** as a failing script delete has one.
> - **An unpublish can be marked done with its files while one remains.** An `uploading` release's script isn't queued until the bookkeeping runs after the unpublish. If the delete job finishes the unpublish's own scripts first, `scripts_gone_at` is set while that unserved script still exists, until the later pass queues it and resets the mark. **Don't mark an unpublish's scripts gone while a release that started under an earlier epoch still has a script that isn't queued.**

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
| 4 | *2026-11-12: (a) is built as three PRs in order, by the architect's ruling, since one was too much to review well: takedown in the room; then a custom hostname's suspension and the stop; then the two reconciles. The first is built: [what it holds](#what-step-4as-first-pr-built). The second is built too: [what it holds](#what-step-4as-second-pr-built). And the third: [what it holds](#what-step-4as-third-pr-built), with every owed item of the first two closed or recorded again by name. A follow-up closed [four ways a finding could be lost](#how-a-finding-could-be-lost-and-what-was-changed). (b) isn't started: [its build plan](#step-4b-the-content-worker-the-build-plan) is proposed.* **Takedown, then the content Worker,** two PRs in this order. **(a) Takedown:** an operator's suspension of an app, keyed by its label and by each host; a hostname's suspension, kept with its claim; the stop for the whole content domain; the room's release epoch and what each of its hosts should serve; the room's applier, the only writer of serve entries; deleting an app's scripts, confirmed by Cloudflare's own answer and retried; and the two scheduled reconciles. It needs no content Worker: nothing here is confirmed by fetching a host. Nothing is served yet. **(b) The content Worker and domain:** a new public Worker, proposed as `apps/content`, on the content domain only. It serves a host only when a serve entry exists for it, and adds fixed response headers. It has no binding to the gateway, the API, D1 or R2. | None; M4's operators for (a) | **Security-sensitive.** A new public surface that serves agent-written content. (b) needs the domain, and never merges before (a). |
| 5 | *2026-11-13: split in two by the architect's ruling. The first PR, the room's recheck alone, is built: [what it holds](#what-step-5s-first-pr-built). The second, starting an upload and committing live in the room, is built too: [what it holds](#what-step-5s-second-pr-built). The job itself, which reads the tree, uploads and waits for the marker, is not.* *2026-11-13: owes two things [step 9 left it](#what-step-9-built): a share of the read budget for each room, and a reservation computed from the tree.* **The release job:** an outbox job that reruns policy and rechecks authority on every pass, reads the release's tree from the repository at the exact merged commit, checks paths, count and sizes from the tree, fetches the files and uploads them as that release's own script, then returns to the room, which commits the release as live and switches what its hosts serve only if policy and the release epoch still hold. The room's applier switches the serve entries; the job confirms by the release's marker and fails the release if it doesn't come back. | Steps 4 and 7 | **Security-sensitive.** It holds the credentials that publish. |
| 6 | *2026-11-13: the remaining unpublish triggers and the reconcile's cron are planned in [the step 6 plan](m6-step6-plan.md), whose five questions the architect answered on 2026-11-13, for the owner to review. The first PR, the triggers that are the room's own state, and the second, the deployment's switch and the reconciles' schedules, are [what step 6's first and second PRs built](#what-step-6s-first-pr-built).* **Triggers and approvals:** `deploy_release` in a public room, approval by a person, rollback, which switches back to the release before where its script is still kept and is otherwise a new release of the earlier commit, and every unpublish trigger. No release starts from a merge. | Step 7 | **Security-sensitive.** This is where "task completion never implies deployment" holds or doesn't. Adds `deploy_release` to the contract, alone in its turn. |
| 7 | **Status:** `get_task_release_status` reports the release beside checks and merge, each with its observation time. | Step 8 | Small. Adds the release fields to the contract, alone in its turn. |
| 8 | **Custom domains:** Podster's own room-bound challenge, the hostname claim, the custom hostname at Cloudflare, routing, the daily recheck, and removal read until gone. | None | **Security-sensitive.** A wrong claim serves one party's content on another's name. |
| 9 | *2026-11-12: built as one PR: [what it holds](#what-step-9-built).* **Caps and reports:** the caps enforced, the release App's read budget across the deployment, and a report that names a deployed app by its address. | None; M4's operators | Suspension and the stop moved to step 4(a). The report's route is in step 2. |
| 10 | *2026-11-13: owes the operators' page for apps' reports, [before `RELEASES` is on anywhere](#what-step-9-built).* **Screens**, in two PRs: (a) Release in room settings and setup, with its *Not configured*, *Needs approval* and *Ready* states and the custom domain; (b) the deployment stage on the task's Release panel, the merge confirmation, which in M6 says that merging releases nothing, and release approvals in Needs attention. | (b) needs step 9(b) | Unavailable grants show as unavailable. A preview or live link shows only when real for this commit. |
| 11 | **Staging run and security review,** then the gate call. | M5's gate | A script against staging with test people. |

#### What step 2 built

**Shapes and state only. Nothing deploys, routes or serves, no cloud resource is made, and no secret or variable is set.**

- **The room's tables,** in one forward-only migration, six tables and two indexes: `release_config`, with the room's release epoch, the kept script and the one commit in flight (its release, its script and its epoch); `app_label`, the app's host labels, one current and the retired ones kept so none is used twice, with an operator's suspension of the app; `release`, with the script it serves, which for a rollback is an earlier release's, and who approved or declined it; `serve_state`, what each host should serve, with its version, whether it is closed, and what the commit in flight wrote and found there; `hostname_request`, with the generation of the name it was made under and its proof history; and `unpublish`, each recorded trigger with the epoch it raised to. The database itself holds the forms and the closed sets: a label of at most 26 lower-case letters and digits, a release's ID, a 40-character commit, a script named for the room's own label and one of its own releases, one default host that is never closed, counters that never go below their start, and a release that is live or served only with its script and its approver. The stop for the whole content domain isn't room state and has no home yet: it is owed with step 4(a).
- **The closed sets are step 3's, and nothing restates them.** A release's states, a hostname request's states and which of them are open, an unpublish's causes, the approval policy, the environment, a release ID's form and a label's length are `crates/core`'s. The wire name of each value is exactly the string core's own `name()` or `code()` gives it. `packages/contracts/core-sets.mjs` reads them from core's source, and `check.mjs` fails unless the contract's enums and the room's column checks equal them, value for value. A value added to the rules therefore needs a contract edit and a new migration before the check passes. A hostname request's states had no home in core, so step 2 added `podster_core::hostname_requests`, names and two questions only.
- **`HostnameClaim`,** a new Durable Object class in the private API, bound as `HOSTNAME_CLAIM`, added by the Worker's migration `v3`. One object for each hostname; at most one claim that isn't ended; a suspension apart from any claim. It keeps the name's generation, which a suspension, a lift and a freed claim each advance, so a request made before any of them can't claim after it. Nothing calls it. **Deploying the API to staging creates the class there,** which is the cloud change [the owner's table](#for-the-owner) lists.
- **A D1 table, `app_label_index`,** migration `0008_app_label_index.sql`: which room a label belongs to, for routing a question to the room and nothing else. Nothing writes it yet. A staging deploy has to name it to `scripts/deploy-staging --apply-migrations`.
- *(2026-11-12: step 4(a)'s third PR added a fifteenth, the operator's read of what the reconciles found.)* **Fourteen operations in `openapi.yaml`,** each a person's or an operator's: the room's release configuration, read and set; approving a release, and declining one; the room's custom hostname, read, asked for and removed; a report that names an app by its address; an operator's suspension and lift of an app by its label and of one host; and the stop for the whole content domain and its lifting. `deploy_release` and the release fields of `get_task_release_status` aren't there, as the row above says.
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

*Note, 2026-11-13: M6-S04 has since run, in two phases around a deploy; see [later staging runs](#later-staging-runs-2026-11-12-and-2026-11-13). That deploy changed the room's code and left its schema as it was, so it showed a room made before a deploy keeps working, not a room schema step applied to an older room. That, the first item above, is still unshown, and so is the `HostnameClaim` class.*

**Left on staging:** the two test people, the organization, the room, the agent and the task. Every session was signed out.

#### Later staging runs, 2026-11-12 and 2026-11-13

**Two more usual runs, and M6-S04 shown for the first time, all with `RELEASES` unset.** This is a record of those runs, as the architect reported them. Their logs were scratch files and aren't in the repository, so the numbers below can't be checked against anything kept here.

- **Run 2, 2026-11-12,** after deploying `e2ef46b`, takedown's first PR (#319). The usual run, at main `e2ef46b`.
  - **Result:** exit 0, with 11 passed, 0 failed and 1 skipped, M6-S04. 2 sign-ups.
- **M6-S04, shown for the first time, 2026-11-13 UTC,** around the deploy of `4b210ac`, takedown's second PR (#322). The script ran at main `52d6cac` and `4b210ac`.
  - **First phase,** against staging at `e2ef46b`: exit 0, 1 passed, 1 sign-up. In M6-S04a, the task was offered and accepted, then open with no assignee after the agent was disconnected. The room had 6 events.
  - **The deploy of `4b210ac`:** the room's schema was unchanged by this deploy. Its in-code Durable Object schema steps were Moderation's and `HostnameClaim`'s; in the room, `store.rs` gained only a helper. The room's code changed: the applier, takedown and the stop read. There was no D1 migration and no wrangler change. 4 of 4 probes passed, after one retry on Cloudflare's code 7403.
  - **Second phase,** against staging at `4b210ac`: exit 0, 4 passed, 0 failed, 0 sign-ups.
    - M6-S04b: the task made before the deploy was still open. It was then offered to a new agent, accepted, submitted and completed, in the older room.
    - M6-S04c: 6 reads, none carrying any of the 19 M6 fields.
    - M6-S04d: 2 M6 read routes, each `404 not_found`, the same as an invented neighbouring path.
    - M6-S04e: 11 events, the first phase's 6 still first, and no M6 event type.
    - The kept file was deleted.
- **Run 3,** after that deploy. The usual run.
  - **Result:** exit 0, with 11 passed, 0 failed and 1 skipped. 2 sign-ups.

**What M6-S04 shows.** A room made before a deploy, with a task part-way through its life, keeps working after a deploy that changed the room's code: the applier, takedown and the stop read. It doesn't show a change to the room's tables, because this deploy made none.

*Correction, 2026-11-13: this section first said the deploy of `4b210ac` changed the room's schema. That was the architect's error, and it is corrected above.*

**What it doesn't show:**
- **A room schema step applied to a room that existed before it.** This has still never been shown on staging: step 2's and the first takedown PR's room schema steps both went out before M6-S04 could run. The next deploy that carries a room schema step must be wrapped in M6-S04's two phases.
- the Moderation and `HostnameClaim` schema steps, which nothing reaches while `RELEASES` is off;
- anything with `RELEASES` on.

`--deployed-commit` is told to the script, not checked by it. So the commits above are what the runner named, from `scripts/deploy-staging`'s output.

#### What step 4(a)'s first PR built

**Takedown in the room, behind `RELEASES`, with no provider configured anywhere.** Built on 2026-11-12. Nothing deploys, routes or serves; no cloud resource is made, and no secret, variable or binding is set.

- **An operator suspends an app, and lifts that,** by the app's label, and by its default host, which is the same act. Who is asking is settled first: an agent, then anyone who isn't an operator, is refused before anything is said about the app. The lookup table only finds the room to ask; the room acts only if the label is its own.
- **Suspending unpublishes, in one room transaction.** `crates/core`'s `unpublish` runs on the room's own state, rebuilt from its rows: the release epoch goes up, every host goes to nothing with its version up, and the kept script and any commit in flight are forgotten. The same transaction records the trigger with the epoch it raised to, marks each release that was live or served as unpublished, and queues every script core names for deletion. Asking again changes nothing. Lifting clears the suspension and restores nothing.
- **The room's applier,** the only writer of a serve entry, run from the room's alarm ahead of everything else. For each host it writes or removes the entry, reads it back, and asks the room for the version again; if that moved, it starts over.
  - **A wait after a failure belongs to the version that failed.** When a host's version moves, as a takedown moves it, the wait is void and the host is due at once, so a suspension never sits behind an earlier failure's backoff.
  - **It writes only a default host's entry, only for a script under that host's own label, and only for a host whose label is the room's own.** A host that isn't the room's is never touched, for a write or a removal.
  - **Where it won't write, it removes.** A script wanted while the app is suspended, a custom hostname's entry, and a script under another label are each never written, and whatever entry is there is taken out.
  - **A refused host is recorded as refused, and that is the end of it for that version.** A host the room may not touch, and one whose entry was removed because what the room asked couldn't be confirmed, is marked refused at its version with the reason. It is logged once, by the room's ID and a code; it never wakes the room and never holds the room's script deletes back. The applier looks again only when the room moves that host's version. Nothing on the content domain is ever a custom hostname: a custom row for an app's host, a deeper name or the domain itself is refused.
  - **One pass is bounded.** It starts no new step after 10 seconds, and a provider call gives up after 5, so a slow provider holds the rest of the room's alarm for about 20 seconds at most. *This was the choice between bounding the pass and running the room's deliveries first: bounded, so a takedown still goes ahead of everything else.*
- **The script-delete job.** It deletes no script until every host's entry is known to match what the room wants. That waiting counts no attempt and asks for no wake of its own: the room sleeps until its earliest pending host is due, by that host's own backoff, and the scripts go in the pass that applies the last host. A script counts as gone only on one of [the two answers that mean gone](adr/0010-release-and-the-content-domain.md#unpublishing); anything else is retried, waiting from 5 seconds up to 5 minutes, and it never gives up.
- **One interface to the provider,** `apps/api/src/content_provider.rs`: read and delete a script, and write, delete and read a serve entry. It needs six settings, and no environment binds any of them. **With none, the applier and the job do nothing and say so:** the work stays recorded as owed, and one log line counts it.
- **One room migration,** two tables: what the applier last confirmed for each host, and the scripts owed a delete.
- **Two event types,** `app.suspended` and `app.suspension_lifted`, recorded as Podster's act and told to the room's managers. The operator's own ID stays in the operators' log.

**What the stand-in is, and isn't.** The tests' provider answers a script's read and delete exactly as spike A recorded. **Its serve-entry answers are an assumption:** no spike has run the KV calls, so the write's body, its answer and a missing key's answer are as the interface expects them, from Cloudflare's documented paths. The interface is strict there on purpose, so a wrong assumption leaves the applier retrying and never lets it record a removal that didn't happen.

**Left for the second PR** (*built since, except the claim's read, which moved to step 8: [what it holds](#what-step-4as-second-pr-built)*)**:** a custom hostname's suspension, kept with its claim, with its generation and the notice to the room that holds it; the stop for the whole content domain and its home in the `Moderation` object; and the applier's two reads before it writes any entry: the stop, from that object and never from a read model, and the hostname's claim for a custom host. Until then the applier writes nothing for a custom hostname.

**Left for the third PR:** the two scheduled reconciles, the provider's list calls, and reports to operators for an entry or a script with no room, or a name Podster didn't make.

**Left for later steps:** the other ten unpublish triggers (step 6); and a release that was waiting, queued or uploading when its room was unpublished, which is left as it is here and failed by the job that owns it (step 5).

**Owed, and not built here.** From the two in-depth reviews of 2026-11-12. None can be met while no provider is configured, and each must be closed before one is:

- **A lost wake.** The suspension commits, then the room sets its alarm. If setting it fails the operator is told the command failed, and asking again arms it; nothing else corrects it until the reconcile (third PR).
- **A delete that never succeeds** retries for ever, every 5 minutes, and nobody is told. Surfacing it to operators is the third PR's.
- **An `uncertain` release with no commit in flight** may have a script in the namespace that no row names, so an unpublish queues no delete for it. The hourly reconcile finds it (third PR).
- **The stop isn't read.** The applier writes a default host's entry without reading the stop for the whole content domain, which doesn't exist until the second PR. **No provider may be configured before that read is built.** *Closed by the second PR: the room asks the `Moderation` object before every default-host write.*
- **Rooms with owed work aren't woken when a provider first appears.** With none, a room sets no alarm for this work, so a room nothing else wakes would go on owing it. Whoever configures the first provider must wake them, or the reconcile must (third PR).
- **The provider's answers for a serve entry are unverified:** what a write and a delete answer, and what says a key is absent. Spike G.
- **The pass's bound isn't shown by a test.** It reads the clock, and a test of it would have to wait it out.
- **A removal skipped at the pass's deadline waits behind the rest of that alarm,** and is due again straight after it.
- **A refused host is only logged.** Surfacing it to operators is the third PR's.
- **Step 5 must check again that nothing loops.** Today only a suspension moves a host's version, so a refused host is looked at once for each suspension. Once a commit, a rollback and a set-back can move versions, step 5 must show that a room whose host is refused, or whose version keeps moving, can't wake itself without end.

**Owed with the provider's configuration,** which is the owner's and waits on the second-account decision:

- **The schedule.** The reconciles' handler arrives with the third PR and is called by tests; **no environment gets a cron entry until a provider is configured** (the architect's ruling, 2026-11-12). *The handler is built. The two entries it answers to, `*/5 * * * *` and `0 * * * *`, are still owed, with the provider's configuration.*
- **Spike G's confirmation of the serve-entry calls,** before any provider is configured.
- **The six settings:** the account, the dispatch namespace, the KV namespace, the content domain, and the two tokens.

#### What step 4(a)'s second PR built

**A custom hostname's suspension, and the stop for the whole content domain.** Built on 2026-11-12, behind `RELEASES`, with no provider configured anywhere. Nothing deploys, routes or serves; no cloud resource is made, and no secret, variable or binding is set.

- **The stop.** An operator sets it and lifts it. **Its home is the `Moderation` object,** the one object for the deployment, in a table that object makes for itself. No room's state changes.
  - **Every room asks that object before it writes a default host's serve entry.** Stopped, or no answer, and nothing is written. A removal never asks, so a takedown goes through while the domain is stopped.
  - **The object makes one key at the provider match the stop:** written or removed, read back, and the stop's version asked again. A failure is retried, 5 seconds doubling to 5 minutes, and a wait belongs to the version that failed. With no provider, the key waits, recorded as owed, and rooms still obey the stop.
  - **Proposed, for step 4(b):** the key is `_stop`, in the serve entries' KV namespace. No host can be that key, since a host has no `_`. The content Worker refuses every host while the key is there, and when it can't read it.
- **A custom hostname's suspension,** in the hostname's own `HostnameClaim` object, decided by `crates/core`'s `suspend` and `lift`. It needs no room: it holds for a name nobody has asked for. It advances the name's generation, and so does a lift, so no request made before either can claim after it. Asking again changes nothing.
  - **If a room holds the name,** the claim starts ending at once and the object owes that room a notice, kept and sent again, 5 seconds doubling to 5 minutes, until the room answers. A lift doesn't cancel it, and a second suspension of a name still held owes a second.
  - **Which request a notice is for is decided by the request's ID, which is unique.** A notice for a request the room doesn't have, or one that has ended, is a late one: acknowledged, and it changes nothing, so it can never close the host of a newer request. A notice for the room's own open request acts when it carries the generation that request was made under. **When the generation differs it is refused, never acknowledged:** the object keeps it and sends it again, and the room logs it by its IDs. So if whatever gives a claim (step 8) ever fails to record the generation with it, a suspension is loud and kept, and never dropped with the name still served. **Step 8 must record that generation.** *Added with the third PR, from the last review:* **step 8 must record both on the claim, the request's ID and the generation.** A wrong generation is refused and kept, as above. A wrong request ID is not: the room doesn't know that request, so it answers that it has nothing to do, the object stops asking, and the room goes on serving the name.
  - **The room clears and closes that host** through core's `clear_host`, in its own transaction, and marks its request as ending. Its default host, its epoch and its scripts are untouched. Its applier then removes that host's entry. A room that doesn't hold that request changes nothing and still answers, so the object stops asking.
  - **Lifting restores nothing:** the host stays closed, the request ending, and the claim ending.
- **The host in an operator's route is read as Podster writes names,** so two spellings are one host. A name on the content domain that isn't an app's host, or on Podster's own domain, is nobody's.
- **One event type,** `app_hostname.suspended`, recorded as Podster's act and told to the room's managers.
- **No room migration.** The `Moderation` object gains one table, `content_stop`. `HostnameClaim` gains one column, by a second migration of its own: the generation a claim was given under.

**Left for custom domains (step 8),** which this plan had put in this PR: the applier's read of the hostname's claim before it writes a custom hostname's entry. Nothing makes a claim until step 8, so until then the applier writes nothing for a custom hostname, and the read arrives with the first thing that can make one. Also step 8's: deleting the custom hostname at Cloudflare, reading until it is gone, and freeing the claim that a suspension left ending.

**Owed, and not built here:**

- **A lost wake,** as in the first PR: the stop, and a hostname's suspension, commit and then set the object's alarm. If setting it fails the operator is told the command failed, and asking again arms it.
- **A stop set while a write is out doesn't take that write back.** The room asked before it wrote. The key at the provider is what refuses the host, so the entry serves nothing while the stop holds.
- **Rooms aren't woken when the stop is lifted.** A host whose write was held retries by its own backoff, so it can be up to 5 minutes before it serves again. Waking them is the reconcile's (third PR).
- **Lifting moves no version.** A host refused because its app was suspended, or because a custom hostname's claim couldn't be asked, stays unserved after a lift until something moves its version. It fails closed, and step 5 must handle it.
- **A room whose only host is a custom hostname can't clear it,** since core never clears the first host. No command makes such a room; the notice would be kept and sent again, and nobody is told. Surfacing it is the third PR's.
- **A notice that is never answered** is sent every 5 minutes for ever, and nobody is told (third PR).
- **The provider's answers for the stop key are unverified,** as for a serve entry. Spike G.

**Owed before any provider is configured,** from the in-depth reviews of this PR:

- **The operator isn't told whether the key is confirmed.** A stop key that never confirms is retried for ever, while the command answers `stopped` either way, since the stop itself did take. The answer should say whether the key at the provider is confirmed.
- **A stop set before a provider exists arms no alarm.** Its key is written only when someone asks again after one is configured, or something else wakes the object. Whoever configures the first provider must wake it.
- **On resume, a failed delete with a stale "absent" read is recorded as applied.** The read-back is the confirmation, and a cache that lags can say absent while the key is still there. The content domain would then stay stopped with nothing owed. Spike G must show what a read after a delete can be trusted for.
- **An unreadable stop also blocks replacing an entry,** such as a rollback's, since a replacement is a write. It fails closed; step 5 must decide whether that is right for a rollback.
- **A hostname is kept as the `subject` of an operator's action.** That is a name, not an ID. No log line and no event may ever read it out.

**For the provider's configuration, noted on 2026-11-12:** the owner has created the second Cloudflare account and added `podster.site` to it, where it is pending. The domain was registered with Cloudflare Registrar that day, so its registration can't move between accounts until 2026-11-22. The account's ID is written nowhere here.

#### What step 4(a)'s third PR built

**The two reconciles, and what the first two PRs left owed to them.** Built on 2026-11-12, behind `RELEASES`, with no provider configured anywhere. Nothing deploys, routes or serves; no cloud resource is made, and no secret, variable, binding or schedule is set.

- **Neither reconcile writes or removes a serve entry, and neither deletes a script.** Each lists what the provider holds, finds whose it is, and asks that room. The room's current state decides, and the room's own applier and delete job do the work.
- **Every 5 minutes, serve entries against rooms.** A page of the entries' keys is listed, 50 at a time, and each entry is read.
  - **An app's default host** finds its room by its label, through the lookup table, which only routes the question. The room compares what is there with what it wants. If they differ, the room forgets that it applied that host, and its applier does it again.
  - **A custom hostname** finds its room through the hostname's own claim object. Today a room never serves one, so an entry for one is taken out by the room's applier and the host is recorded as refused.
  - **The stop key** is judged once the whole list has been read, over one pass or several. If it isn't what the stop says, the `Moderation` object forgets that it confirmed the key, and its own alarm writes or removes it. A key that is there when no stop was ever set is only told to operators: it refuses every host, which fails closed.
- **Every hour, scripts in the namespace against rooms,** decided by `crates/core`'s `reconcile_script`. The label's own room is asked. A script that a host, the kept script or a commit in flight names is kept, and so is one uploading within its hour. Anything else under the room's label is queued for the room's delete job: an `uncertain` release's script, an upload that outlived its hour, a script no release of the room's ever had, and one the room had counted as gone.
- **Both wake rooms.** Each pass also walks 50 rooms of the lookup table, from where the last pass stopped, and each room asked arms its own alarm if it owes work.
- **What has no room, or a name Podster didn't make, is told to operators and left alone.** An entry or a script is never removed on the lookup table's word: only the label's own room, from its current state, can make one removable.
- **What operators are told,** kept in the `Moderation` object, one row for each kind and subject, counted and dated each time it is seen again, forgotten after 7 days unseen, 1,000 at most:
  - an entry or a script with no room, or with a foreign name;
  - a host a room's applier refused, with why;
  - a script whose delete has failed 12 times, which with the waits is over half an hour;
  - a suspended hostname whose room hasn't answered 12 notices, a room whose only host is that hostname among them;
  - an entry whose value couldn't be read as a script's name;
  - **each script a pass had a room queue for deletion,** by the script's name, since a delete can't be taken back;
  - the stop key not as the stop says; and a scripts' list that said it held less than there is.
- **One new route,** `GET /v1/moderation/takedown-findings`, for operators, behind the switch like the rest. It names the host or the script each finding is about and never a room's ID. **Nobody is notified:** an operator reads it.
- **The operator's answer for the stop now says whether the key is confirmed,** `key_confirmed`: false straight after a change and for as long as no provider is configured or the key can't be confirmed, true once it is read back. Asking again reads it again.
- **The scheduled handler** answers to two schedules, `*/5 * * * *` and `0 * * * *`, does nothing while release is switched off, and does nothing for any other schedule. **No environment has a cron entry,** so nothing calls it on any deployment; a test shows the Worker's configuration holds no schedule. With no provider a pass reads nothing and says so.
- **An entry that is there matches only when the room wants a script for that host and the entry was read as exactly that script.** A host that wants nothing never matches an entry that exists, and a value that couldn't be read, or isn't a script's name Podster made, equals nothing. *From the review: the first build read "couldn't read it" and "wants nothing" as a match, so a foreign entry on a taken-down host would have stayed for ever, untold.*
- **One step that fails is counted, logged by its code and skipped:** one key, one script or one room. The pass goes on, writes where it got to, checks the stop key, walks and arms the object.
- **One pass is bounded:** one page of keys or 100 scripts, and 20 seconds after which it starts nothing new over the list; then 50 rooms woken, with 10 seconds of their own, so a slow provider can't starve the walk. Where it stopped is kept in the `Moderation` object, and the next pass goes on from there.
- **Two more calls on the provider's interface:** the entries' keys, a page at a time, and the namespace's scripts. **Two tables in the `Moderation` object,** made the way it makes its others. No room migration, no D1 migration, and no migration of `HostnameClaim`.

**The first two PRs' owed items, each by its name:**

| Item | From | Now |
| --- | --- | --- |
| A lost wake, in a room | First PR | **Closed.** Every question a reconcile asks a room ends with the room arming its alarm, and the walk reaches rooms that hold nothing at the provider. The bound is the pass that next reaches the room. |
| A delete that never succeeds | First PR | **Closed.** Operators are told after 12 failures. It still retries for ever. |
| An `uncertain` release with no commit in flight | First PR | **Closed.** The hourly pass has its room queue the script. |
| The stop isn't read | First PR | Closed by the second PR. |
| Rooms with owed work aren't woken when a provider first appears | First PR | **Closed.** The walk wakes them, 50 a pass. |
| The provider's answers for a serve entry are unverified | First PR | **Still owed, and wider:** the two lists are unverified too. Spike G. |
| The pass's bound isn't shown by a test | First PR | **Still owed,** and the same holds for a reconcile's 20 seconds. |
| A removal skipped at the pass's deadline waits behind the rest of that alarm | First PR | **Still owed,** unchanged. |
| A refused host is only logged | First PR | **Closed.** Operators are told, by the host and the reason. |
| Step 5 must check again that nothing loops | First PR | **Still owed, and wider:** a pass makes a room forget a refused host whose entry has come back, so a room can now be woken every 5 minutes for as long as something keeps writing that entry. |
| A lost wake, for the stop | Second PR | **Closed.** Each pass ends by arming the `Moderation` object's alarm if the key is owed. |
| A lost wake, for a hostname's suspension | Second PR | **Closed where it matters, owed otherwise.** A pass that finds an entry for the name asks the name's object, which arms. With no entry for the name nothing is served on it, and nothing reaches that object until an operator asks again. |
| A stop set while a write is out doesn't take that write back | Second PR | **Still so, by design.** The key at the provider is what refuses the host. |
| Rooms aren't woken when the stop is lifted | Second PR | **Not built, and no longer owed to the reconcile.** A held write retries by its own backoff, within 5 minutes, which is the reconcile's own interval; a wake from the walk doesn't cut that wait short. |
| Lifting moves no version | Second PR | **Still owed,** step 5's. |
| A room whose only host is a custom hostname can't clear it | Second PR | **Told, not fixed.** Its notice goes unanswered, and operators are told after 12 tries. |
| A notice that is never answered | Second PR | **Closed.** Operators are told after 12 tries, and again on each try after. |
| The provider's answers for the stop key are unverified | Second PR | **Still owed.** Spike G. |
| The operator isn't told whether the key is confirmed | Second PR | **Closed.** `key_confirmed`. |
| A stop set before a provider exists arms no alarm | Second PR | **Closed.** The first pass with a provider arms it. |
| On resume, a failed delete with a stale "absent" read is recorded as applied | Second PR | **Narrowed.** The next pass that reads the whole list sees the key and has the object remove it again. What a list can be trusted for is spike G's to show. |
| An unreadable stop also blocks replacing an entry | Second PR | **Still owed,** step 5's. |
| A hostname is kept as the `subject` of an operator's action | Second PR | **Still so, and wider:** what operators are told keeps hosts and scripts' names too. It is state in the `Moderation` object; no log line and no event reads one out. |

**The real bound on a wrong entry, which is not the ADR's seven minutes.** From the review of this PR, and [noted in the ADR](adr/0010-release-and-the-content-domain.md#publishing-and-unpublishing-in-order):

- **A pass reads one page of 50 keys.** With N keys in the serve entries' namespace, the stop key and any stray among them, an entry is looked at every ⌈N/50⌉ × 5 minutes, plus KV's delay. A pass that runs out of its 20 seconds reads the same page again and stretches it further.
- **In numbers:** up to 50 keys, 5 minutes, which is the ADR's figure. At 100 keys, 10 minutes. At 600, an hour. At 1,000, an hour and 40 minutes.
- **What N is unacceptable: anything above 50,** since the ADR's bound and M6-27's stated time rest on five minutes. A pilot of a few tens of apps fits. This must be fixed before a provider is configured for more.
- **Proposed fix, for when a provider exists:** a pass reads page after page until its time bound, not one page, and asks rooms side by side. How many keys fit in a pass depends on what one key costs, a read, a lookup and a room's answer, which spike G must measure. If a full list can't fit in one pass at the size expected, the interval a deployment can promise is whatever that measurement gives, and the ADR's figure changes with it.
- **The stop key shares that bound:** it is judged only when the whole list has been read.

**What operators see when the record of findings is full.** It holds 1,000 rows. Past that, a finding not already there isn't kept, and one row, `findings_full`, says so and counts each one dropped. Findings already there are still counted and dated. A row leaves only when nothing has seen it again for 7 days, so **a new finding can go unrecorded for up to 7 days** while the record stays full. An operator reading the route sees the 200 most recently seen rows and `findings_full` among them. Nothing lets an operator clear a row. Both are owed before a provider is configured: a way to clear, and a cap that can't hide the newest finding.

**Owed, and not built here.** None can be met while no provider is configured:

- **How long a list's cursor lives is unknown.** A pass keeps the cursor for the next pass, 5 minutes later. If the provider's cursor lives less than that, every second pass fails its list and starts over, so page 1 is read again and again and later pages, and the stop key, are never judged. **Spike G must answer how long a KV list cursor lives.** If it is under 5 minutes, a pass must read the whole list itself, which is the same fix as above.
- **The lists' answers are unverified.** The keys' list is Cloudflare's documented one and no spike has run it. How the scripts' list pages was never seen: an answer that hints at more is treated as incomplete, told to operators, and never acted past. Spike G.
- **An entry that vanished isn't noticed.** A pass reads the entries that are there. One removed by no act of Podster's, for a host a room wants served, stays absent until that room's version moves. It fails closed.
- **A read that lags makes a room write again.** A pass reads each entry it lists. If that read is older than the room's last write, the room is told it differs, forgets it applied the host, and its applier writes the same entry again. That costs one write and changes nothing served. What a read after a write can be trusted for is spike G's.
- **The walk reaches only rooms the lookup table names,** and nothing writes that table yet. The step that gives a room its label must write it.
- **An upload that outlived its hour loses its script, and its release stays `uploading`.** The room queues the script, as the ADR rules. Step 5 must fail that release and never commit it live.
- **Step 5's obligations to the reconcile,** from the review of this PR:
  - **Write the release's row as `uploading` before the upload starts.** A script under a room's label with no row is disowned and queued for deletion at once, with no age floor.
  - **Settle-then-commit must never commit a script that is queued for deletion or counted gone.** The commit checks the room's delete queue in its own transaction.
  - **Fail a release whose upload is past its hour before it can commit,** and have the delete job's own check, `may_delete`, look at the upload exemption again before it deletes.
- **Two test gaps in `crates/core/src/release.rs`, owed with step 5,** which is the next step to touch that file. They were recorded only in a notes file until now, from the mutation pass on PR #313:
  - **The replay's epoch comparison.** In `commit_live`'s in-flight branch, `flight.mark.epoch != release_epoch` survives being changed to `>`, because only a lower epoch is tested. Owed: a retry by the same record and script under a higher epoch than the flight's is refused `EpochMoved`. The comparison must stay `!=`.
  - **The same release ID with a different script.** Dropping `flight.script != script` survives. Owed: the same release ID asking for a different script mid-flight is refused `InFlight`, never replayed.
  - Both belong in `crates/core/tests/release.rs`, near `a_retried_commit_is_replayed_and_never_told_to_fail`.
- **The reconcile's two checks of a custom hostname** are step 8's. Today any entry for one is removed.
- **The content Worker's deployed version isn't compared,** which the ADR gives the reconcile. It needs the content Worker (step 4(b)) and spike G.
- **Nobody is notified of a finding.** An operator has to read the route.
- **Two passes of one kind at once** aren't prevented. Their questions change nothing twice, but each would write where it stopped, and the later write wins.
- **The calls one pass makes weren't counted against the platform's limit:** about 200 at most, by the sizes above.
- **The walk's 10 seconds and a pass's 20 aren't shown by a test,** as the applier's bound isn't.

#### How a finding could be lost, and what was changed

**A follow-up to the third PR, built on 2026-11-12 after its last review, before any provider exists.** Four ways the operators' record could miss something, each closed:

- **A deletion a pass started was told in one answer only.** If that answer was lost, or the record couldn't keep it then, the delete went ahead unrecorded. **Now the room tells of it from its own row,** each time anything asks the room, for 7 days, as `queued` and then `gone`, whether or not the script is still there to be listed. No room migration: the row is the delete queue's own, queued under no unpublish.
- **A key that failed every pass showed only as a count and a code in a log.** **Now each key's and each script's failures in a row are counted,** a room that gives no answer among them. At the third, operators are told, by the name and the code, and again on each failure after. A step that works forgets the count. A pass that skipped a step, or met a room that didn't answer, is recorded as `errors`, never `ok`.
- **An outage of the provider's reads wrote one finding for every host,** 50 a pass, which could fill the record and keep a deletion out. **Now a read that gave no answer is told once for the pass,** with how many. Only a value that was read and isn't a script's name is told by its host. **And deletions a pass started have 1,000 rows of their own,** so nothing else can keep one out.
- **The walk's own time wasn't shown by a test.** It is now, with the list's: a test sets each bound short and shows the other part still runs. The bounds themselves, 20 seconds and 10, are read from the source; the test doesn't wait either out.

**Still owed, as before:** nothing lets an operator clear a row, and nobody is notified. The count of failing keys holds 1,000; past it a new one isn't counted, and operators are told the count is full.

**Three more, from that follow-up's review, built the same day:**

- **A script the room had counted gone, and a pass found again, keeps the unpublish it was queued under.** That unpublish's "scripts gone" is taken back until the script is gone again. The follow-up had cut it loose from its unpublish, so an unpublish could read as done with its files while one was owed.
- **A refused host and the stop key not as the stop says have room of their own in the record,** 1,000 rows for each kind, as a pass's deletions have. Three passes of an outage can write a thousand keys that keep failing into the shared room; they can no longer keep either of those out. When a kind's room is full, one row says which.
- **The delete may run before its finding lands, and that is safe.** The row that marks a deletion as a pass's commits in the transaction that queues it, before any call to the provider. The room's delete job may then run before the pass has written the finding. Nothing is lost: the row stays, gone or not, and the room tells from it for 7 days.

**Owed, and recorded here:**

- **Only the 32 newest of a room's are told in one answer.** A room with more than 32 in 7 days tells of the rest never.
- **A room tells only when asked.** One that leaves the lookup table, or that nothing asks for 7 days, never tells again, and a deletion of its that the record lost stays lost.

#### Step 4(b), the content Worker: the build plan

**Proposed, for the architect's ruling. Planning only: no code is written until the split below is accepted.** *Corrected on 2026-11-12 after the architect's review of the first version: how the package is kept from deploying, which request headers go through, `Clear-Site-Data`, the one sandbox policy, and the KV read's cache lifetime. The first version is in this file's history.* It follows [ADR 0010](adr/0010-release-and-the-content-domain.md#where-content-is-served), the owner's decision to sandbox every app ([216](spec/PRODUCT.md#decisions-needed)) and the second account ([217](spec/PRODUCT.md#decisions-needed)).

**What it is.** A new public Worker, `apps/content`, in TypeScript like the gateway. It is the dispatch namespace's dynamic dispatch Worker. It routes and never authorizes.

- **Its bindings, and no others:** the serve entries' KV namespace, to read, and the dispatch namespace. **No binding to the gateway, the API, D1 or R2, no secret, and no variable that names Podster's own hosts.** A test reads its configuration and fails if any other binding kind appears. *Ruled with the first PR:* **it has one variable, the content domain's name,** which it needs to tell an app's default host from any other. That names no host of Podster's own.
- **For each request:**
  1. Anything but `GET` and `HEAD` is refused. A request carrying `Service-Worker: script` is refused with 403. *Ruled with the first PR:* **any request that carries a `Service-Worker` header is refused, whatever it holds.** A browser sends the header with a service worker's script and its imports and with nothing else, and under the sandbox no page can register one, so nothing an app needs carries it. Refusing on the header's presence leaves no value to match loosely, and holds even if the sandbox were ever loosened.
  - *Ruled with the first PR:* **the host must be an app's default host, `<label>.<content domain>`.** Anything else is not-found, and nothing is read for it. Custom hostnames arrive in step 8 with their own entry form.
  - *Ruled with the first PR:* **an app is never served over plain HTTP, and that doesn't rest on the zone's redirect alone.** A request that arrived over HTTP gets a 301 to the same host and path over HTTPS, with the Worker's own headers, and nothing is read or asked of any app. **How the scheme is known:** from the request URL's protocol, which is what Cloudflare's edge received and no header of the visitor's can change. `X-Forwarded-Proto` isn't read. Cloudflare documents that it overwrites a client's value on incoming requests ([HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/#x-forwarded-proto)), but a header is still the visitor's to send, and what a Worker sees of it isn't shown here. `request.cf` isn't read either: the namespace's Workers run untrusted without it, and the handler has no need of it. **Unverified until a real deploy:** that a plain-HTTP request reaches the Worker at all with its URL as `http:`, and isn't answered first by the zone's own redirect.
  2. **The stop,** the key `_stop`, read at most once every 30 seconds by each running copy and kept in memory between. Set, or unreadable, and every host answers not-found.
  3. **The serve entry** for the request's exact host: one KV read, with the shortest cache lifetime a read may ask for, 30 seconds. No entry, a value that isn't a script's name of Podster's form, or an error from KV answers not-found. The name's form is checked again here, in TypeScript, against the same rule `crates/core` has; a shared test vector file keeps the two the same. *Ruled with the first PR:* **and the script must carry the same label as the host.** A mismatch answers the Worker's own not-found and asks no app. The API's applier already holds this where the entry is written; the Worker is the second lock, and the public one.
  4. **The script** the entry names, fetched from the namespace with the request's method, path and query. **Of the visitor's headers only three go through: `Accept`, `If-None-Match` and `If-Modified-Since`.** No cookie and no `Authorization` goes through.
     - **`Range` and `Accept-Encoding` are not forwarded.** A request header goes through only if the response header it calls for is on the allow-list. `Range` calls for `Content-Range` and a 206; `Accept-Encoding` calls for `Content-Encoding`. Neither is on the list, so neither request header is sent, and an app's answer that carries `Content-Encoding` or `Content-Range`, or is a 206, is answered as an error and serves nothing, since dropping the header would hand the visitor bytes it can't read. The two conditionals stay: a 304 needs only `ETag` and `Last-Modified`, which are on the list.
     - **What that costs:** no resumed or partial downloads, and no compression asked of the app. Whether Cloudflare compresses toward the visitor anyway, with `no-transform` set, isn't known and is for the first deploy to show. If it doesn't, allowing `Content-Encoding` is a later change with its own review.
     - A rejection whose message is `Worker not found.` answers not-found; any other rejection answers an error and serves nothing.
  5. **The response's headers, built from nothing.** From the app's response only `Content-Type`, `Content-Length`, `ETag` and `Last-Modified` pass, and `Location` on a 3xx when it is a path on the same host; any other 3xx is not-found. Everything else is dropped, `Set-Cookie` always.
- **The fixed headers it sets on every response,** its own answers included:
  - `Referrer-Policy: no-referrer`
  - `X-Content-Type-Options: nosniff`
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains`
  - `Cache-Control: max-age=60, no-transform` on what an app answered, and `Cache-Control: no-store` on the Worker's own not-found and refusals, so a browser doesn't hold a not-found for a minute after an app goes up. **This is what holds.** The ADR had 60 seconds on every response; it is corrected there with a dated note
  - `Access-Control-Allow-Origin: *`, which a sandboxed page needs to load its own files, as spike C saw
  - `Content-Security-Policy`, the sandbox, below
- **The sandbox: one policy, stated here once.** With `<origin>` the request's own `https://<host>`, never `'self'`, which spike C saw match nothing in a sandboxed page:

  ```text
  sandbox allow-scripts; default-src <origin>; script-src <origin>; style-src <origin> 'unsafe-inline'; img-src <origin> data:; connect-src <origin>; frame-ancestors 'none'; form-action 'none'; base-uri 'none'
  ```

  - **`allow-scripts` is the only `allow-` word.** The ADR lists no other with a reason, and spike C's policy carried four more that it never tried one by one. The sources are the ones spike C's working policy named, without `data:` and `blob:` as general sources, which nothing was shown to need.
  - **`allow-same-origin` is forbidden for good.** It would give a page its real origin back and undo [decision 216](spec/PRODUCT.md#decisions-needed). A test fails if the policy the Worker builds, for any host, ever contains it, and a second reads the package's source for the word.
  - **Any other `allow-` word is a change to decision 216's stance, and is the owner's.** The browser PR may show that an ordinary app needs one. It then reports that, and nothing is added without the owner's yes. A change to the sources is the architect's.
- **`Clear-Site-Data` on the Worker's own not-found,** as [the ADR has it](adr/0010-release-and-the-content-domain.md#unpublishing), as a best effort and never a control. **Proposed value: `"cache"` alone,** which narrows what the ADR left open. The reasons: under the sandbox an app has no cookies and no storage to clear; `"cookies"` is the directive under which Chromium cleared a sibling host's cookies in spike C; and the HTTP cache is the one thing a taken-down app can leave in a browser. It goes on not-found only, never on an app's own answer.
- **Logs: nothing for a request,** as [the ADR has it](adr/0010-release-and-the-content-domain.md#logs). *The first version of this plan had a status and a code for each of the Worker's own answers; that was wrong against the ADR and is removed. If operators need a signal from the content Worker, that is a change to the ADR, proposed there.*

**What can be built and tested with no deploy:**

- **All of the request handling above,** in the Workers test pool, as the gateway's tests run. The dispatch namespace has no local emulation that this plan relies on, so the namespace binding is a stand-in the test supplies: an object whose `get(name)` returns something with a `fetch`, including one that rejects with `Worker not found.` exactly as spikes A and C recorded. The KV namespace is the pool's own.
- **Every header rule,** as a table of an app's response against what the visitor gets, and a test that no header outside the allow-list and the fixed set ever leaves, fed with every header name spikes A and C saw reach a visitor.
- **The stop's 30 seconds,** with the clock passed in, never slept through.
- **The sandbox in real browsers,** locally: Playwright's Chromium, Firefox and WebKit against the Worker under `wrangler dev`, with the stand-in namespace serving a small static app. It shows the seven steps spike C showed, that storage is refused, that a sibling host's cookie can't be read, and it is where forms, downloads, popups, fonts and frames are tried for the first time. A browser a script starts gets the allow-listed environment from `e2e/child-env.mjs`.
- **A contract test with the API's applier:** what the applier writes for a host, a script's name, and for the stop, `stopped`, is exactly what the content Worker reads. One fixture file, read by both packages' tests.

**The KV read's cache lifetime, and what it means for a takedown.** By Cloudflare's documentation, a KV read is cached where it was read for its `cacheTtl`, 60 seconds unless the read asks for less, 30 at the least, and a missing key is cached the same way ([reading key-value pairs](https://developers.cloudflare.com/kv/api/read-key-value-pairs/#cachettl-parameter)). The content Worker asks for 30. So, by the documented figures and unmeasured:

- **After the applier removes an entry,** a location that read it within the last 30 seconds can go on serving that host for up to 30 more, and a browser can reuse an answer it already has for its 60. About 90 seconds at the outside, by those figures. "Or more" is Cloudflare's own wording for the first part.
- **After an entry is written,** a location that read the host as missing can answer not-found for up to 30 seconds. The Worker's not-found is `no-store`, so the browser adds nothing.
- **The stop** is read the same way and then kept in memory for 30 seconds, so a running copy can take up to 60 seconds to refuse every host, and browsers their 60 after that.
- **None of this is measured.** Spike G measures it, and M6-27's stated time is whatever that supports.

**What can't be shown without a deploy,** and stays owed to spike G and the first deploy: a real dispatch namespace's answers; how long a KV write takes to be read at the edge, which is the takedown time; Cloudflare's own additions to a response on the real zone, the Web Analytics beacon among them; and the wildcard route.

**Keeping it from deploying.** *Rewritten twice on 2026-11-12. The first version said leaving the IDs out was enough. The second said a package with no configuration file makes a bare `wrangler deploy` refuse. Both were wrong, and the architect ruled the guard below.*

What Cloudflare's documentation says, and where it is silent:

- **With no configuration file, `wrangler deploy` doesn't refuse. It configures the project and deploys it.** Since wrangler 4.68, "when you run `wrangler deploy` … in a project directory without a Wrangler configuration file", wrangler detects the project, prompts, generates a `wrangler.jsonc` and deploys ([automatic configuration](https://developers.cloudflare.com/workers/framework-guides/automatic-configuration/), [the `deploy` command](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy)). This repository pins wrangler `^4.157.0`. The same page says: "If a Wrangler configuration file already exists, automatic configuration will not run."
- **`workers_dev` defaults to `true` when the configuration has no route** ([configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)), and preview URLs follow it unless set ([version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/)).
- **Which account.** Wrangler targets "the `account_id` in your Wrangler configuration file, or the `CLOUDFLARE_ACCOUNT_ID` environment variable", and otherwise the account chosen at login; both "are always respected" ([profiles](https://developers.cloudflare.com/workers/wrangler/profiles/)). **The documentation doesn't say which of the two wins when both are set,** and every deploy shell on the owner's machine sets the variable to the account that holds `podster.dev`.
  - **Read in the pinned wrangler's own source, 4.157.0, since the documentation is silent:** the file's `account_id` is used first, and the environment's only when the file has none. An empty `account_id` counts as none. A value with characters outside letters, digits, `-` and `_` is refused outright.
  - That is how this version behaves and no documented promise. **Owed with every wrangler upgrade: read it again.** If an upgrade flipped the order, a deploy from the committed file would put a script on the account in the shell, the one that holds `podster.dev`: unreachable, with no public address, but a script there all the same. **So the package pins its own wrangler, 4.157.0 exactly, and the static check reads that installed copy's source** for the order and for the check of an account ID's form, and fails when either changes. Before the pin the package had no wrangler, so a tool run there resolved one from a cache or the registry; an older one has no local check of an account's ID at all. The gateway's and the API's locks hold 4.157.0 too, and the scanner's 4.158.0, which wasn't read; nothing deploys the content Worker with any of them.
- **An `account_id` that is no account** makes Cloudflare's API refuse the call. The documentation shows that refusal for a file whose `account_id` is another account's: "Could not route to /client/v4/accounts/…" ([troubleshooting](https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/)). For an ID that is no account at all it isn't documented, and it isn't tried here: no real `wrangler deploy` is run to test any of this, not even one expected to fail.

So the package is built like this:

- **`apps/content` carries a default-named `wrangler.jsonc`,** so automatic configuration never runs there. That file can't deploy anything public anywhere:
  - `workers_dev: false` and `preview_urls: false`;
  - no `route`, no `routes`, and so no custom domain;
  - **`account_id` is a fixed placeholder that is no account,** a plain phrase that says so, never empty. By the source read above, it is used ahead of the `CLOUDFLARE_ACCOUNT_ID` in the shell, so a deploy from that file is aimed at no account, whoever is logged in. *Added with the first PR, from the review:* **the phrase holds a space and a colon, which wrangler refuses for an account's ID before it makes any call that is scoped to an account. It is not before every call: wrangler may refresh a login first.** So the refusal rests on wrangler's own check and not on how Cloudflare's API answers for an ID that is no account;
  - no `env`, and placeholders for the KV namespace's ID and the dispatch namespace's name.
- **The real account and routes come only from a separate configuration that the owner's deploy step supplies for the second account at deploy time.** It is never committed: this repository is public and holds neither account's ID. **It lives outside `apps/content`.** Wrangler reads a `.wrangler/deploy/config.json` redirect ahead of `wrangler.jsonc` ([generated configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#generated-wrangler-configuration)), so nothing under the package may ever point wrangler at another file, and the static check asserts no such redirect exists there. **That assertion can't fail in CI:** `.wrangler` is ignored by git, so a checkout never has one. It is a guard for a machine where a tool was run in that folder, which is where an accident would happen.
- **The package has no `deploy` script, and `scripts/deploy-staging` never names it.**
- **A static check, in the package's own tests and so in CI,** asserts all of it: the default-named file is there; `workers_dev` and `preview_urls` are false; no route of any kind; the placeholder `account_id`, unchanged and not empty; the placeholder IDs; no `deploy` script; and no mention of the package in `scripts/deploy-staging`.
- **What a dry run showed,** with the first PR: `wrangler deploy --dry-run` in the package, with wrangler 4.157.0, no credentials and no login, read this file, listed its two bindings with their placeholders, built the Worker, 5.95 KiB, and exited 0 at "--dry-run: exiting now." **It never looked at `account_id`:** a dry run stops before wrangler works out the account. So the dry run confirms which file is read and that it builds, and nothing about the refusal. That the placeholder is refused is read in the source and not shown by any run, since the only runs that would reach that check are ones that go on to call Cloudflare.

**The limit, said plainly.** Nothing in a configuration file stops a person who types a deploy by hand that doesn't use it: `wrangler deploy` with another `--config`, or from another folder with an entry point and a `--name`. **The guard is against accidents by scripts and agents,** and those deploy only through `scripts/deploy-staging`, which doesn't know this package. A deliberate deploy by hand is the owner's to make or not.

CI gets one job for the package: typecheck and tests, no deploy step.

**What the first deploy needs from the owner,** all on the second account ([decision 217](spec/PRODUCT.md#decisions-needed)):

- **`podster.site` active on that account.** It was registered on 2026-11-12, so its registration **can't move before 2026-11-22.** Until it is active there, nothing can be routed.
- Workers for Platforms on that account, at $25 a month, and the dispatch namespace.
- The serve entries' KV namespace.
- The wildcard record and the redirect from HTTP to HTTPS.
- **A deploy credential for the content Worker only,** which is not the publishing credential.
- Spike G run first, since it confirms the answers the API's provider module assumes.
- The six provider settings on the API, the two cron entries, and `RELEASES`: each a separate yes, and none comes with the content Worker's deploy.

**The split, proposed: three PRs, in order.**

| PR | What | Why it is its own |
| --- | --- | --- |
| 1 | **`apps/content`, the handler:** the method and service-worker refusals, the stop, the serve entry, the dispatch with the stand-in namespace, the three request headers, the header allow-list and the fixed headers with the one sandbox policy above; the default-named configuration that can deploy nothing public anywhere, and the static check of it; its CI job; the fixture shared with the API's applier | The whole security surface, small enough for one deep review. Nothing deploys |
| 2 | **The sandbox in real browsers:** the Playwright run against `wrangler dev`, in three browsers, with the one policy above. It reports what an ordinary static app can't do under it and which sources it needs. It adds no `allow-` word: one that is shown to be needed goes to the owner, as a change to [decision 216](spec/PRODUCT.md#decisions-needed) | It starts browsers, takes longer, and its result is a product statement the owner may want to read |
| 3 | *2026-11-13: built as `scripts/deploy-content`, with [its guide](content-deploy.md); never run against Cloudflare.* **The deploy path, unused:** a script of its own for the content Worker that takes the owner's account, token and configuration for the second account explicitly, never the committed file's, and refuses if that token can see the zone `podster.dev`, with its refusals tested against stand-ins; and the notes for the first deploy. It is never run by an agent before the owner asks | It touches deploy scripts, which have their own tests and their own review |

**Security-sensitive:** PR 1 should get a review deeper than the quick diff review, asked before it runs. **Not in 4(b):** uploading anything to the namespace (step 5), custom hostnames' routing (step 8), and any change to the API.

#### What step 4(b)'s first PR built

**The content Worker's handler, `apps/content`, built and tested locally only.** Built on 2026-11-12. Nothing deploys, no cloud resource is made, and no secret, variable or binding is set anywhere. It follows [the build plan above](#step-4b-the-content-worker-the-build-plan) as corrected after the architect's review.

- **The handler,** `src/handle.ts`, written against two small interfaces, the serve entries' one read and the namespace's one `get`, so every rule is tested with stand-ins:
  - GET and HEAD only; any request with a `Service-Worker` header refused;
  - only an app's default host, `<label>.<content domain>`, is served, and nothing is read for any other;
  - a request over plain HTTP gets a 301 to the same host and path over HTTPS, by the URL's protocol alone;
  - the stop, read with a 30-second cache lifetime and kept 30 seconds in memory, with the clock passed in; unreadable is stopped and never remembered;
  - the serve entry for the exact host, one read, and only a script's name under that host's own label is asked for;
  - the request to the app built from nothing, never from the visitor's request object;
  - nothing logged for a request;
  - three request headers through, `Accept`, `If-None-Match` and `If-Modified-Since`, and nothing else of the visitor's;
  - `Worker not found.` is not-found, and any other failure an error with the Worker's own headers;
  - the answer's headers built from nothing: four of the app's, a same-host `Location`, then the fixed set and the one sandbox policy;
  - an answer with `Content-Encoding`, `Content-Range` or a 206 serves nothing;
  - `Clear-Site-Data: "cache"` on the Worker's own not-found, and `no-store` on every answer of its own.
- **A default-named `wrangler.jsonc` that can deploy nothing public anywhere,** as [ruled](#step-4b-the-content-worker-the-build-plan), and a test that holds the package to it: both public addresses off; no route and no environment; an `account_id` that is no account and holds characters wrangler refuses; placeholder IDs; no redirect under `.wrangler/deploy`; no deploy script; no mention in the staging deploy; and the wrangler version the guard was verified on.
- **One fixture, `packages/contracts/serve-entry.fixture.json`,** read by three test suites: the content Worker's, the API's and `crates/core`'s. It holds the stop's key and value and the vectors for a script's name, so the TypeScript copy of the rule can't drift from Rust's.
- **A CI job for the package, `content`:** typecheck and tests, no deploy step. `scripts/merge-gate` requires it by name, as it does every job, and its self-test counts nine jobs. **Once this merges, every open pull request needs a `content` check,** so one opened before it must be rebased.

**Where it departs from the plan:** the tests run in Node, as the scanner's do, not in the Workers test pool. The handler takes its two bindings as plain interfaces, so nothing in it needs the pool, and the suite runs in a second. What that leaves unshown is the Workers runtime's own behaviour with these calls, which the second PR's run under `wrangler dev` covers.

**Not shown here, and owed:**

- The real dispatch namespace's and KV's answers, and everything a deploy would show. Spike G and the first deploy.
- The sandbox in a browser. The second PR.
- **Nothing here has run in a real Workers runtime.** Unshown until one does: whether the request's URL and its `Host` agree at the edge, and that a plain-HTTP request arrives as `http:`; what headers the platform adds to the request a dispatch sends an app; what `Content-Length` the platform sends for a passed body; that KV takes a 30-second cache lifetime; and the sandbox in a browser.
- **For spike G: whether `no-transform` switches off Cloudflare's own compression.** The Worker asks the app for none and passes none.
- **For step 8: `includeSubDomains` in HSTS on a custom hostname.** The Worker sends `Strict-Transport-Security` with `includeSubDomains` on every answer. On a customer's apex hostname that would pin the customer's whole domain to HTTPS for a year. Today only default hosts are served, so it can't happen yet; step 8 must decide what a custom hostname gets.

#### What step 4(b)'s second PR built

**The sandbox in real browsers, as a local run, and its report.** Built on 2026-11-12. Nothing deploys; no cloud resource, no secret, and no word added to the sandbox.

- **[The report](m6-content-sandbox-report.md),** for the owner, as evidence about what [decision 216](spec/PRODUCT.md#decisions-needed) costs: for each thing an ordinary static app needs, whether it works under `sandbox allow-scripts`, in Chromium, Firefox and WebKit, beside a control with the policy taken off. It recommends nothing. Its raw results are beside it.
- **[A second report](m6-sandbox-api-report.md), 2026-11-13,** from a spike and not from anything built: whether a sandboxed page can call an API on its own host, and what any other page can then do to that API, in the same three browsers. It is evidence for [ADR 0010's proposed revision](adr/0010-revision-apps-are-workers.md#35-under-the-sandbox-as-it-stands), and recommends nothing. Its script, `e2e/content-sandbox-api.mjs`, uses a test-only entry, `apps/content/test/browser/api-entry.ts`; the content Worker has no API.
- **The run,** `e2e/content-sandbox.mjs`: the content Worker's real handler in the real Workers runtime, under `wrangler dev`, local only, from a test-only entry with two apps' serve entries and a small static app in memory. Browsers reach it through Playwright's request interception. Both `wrangler` and the browsers get the allow-listed environment.
- **A second wrangler configuration, for that run only,** `apps/content/test/browser/browser-run-only.wrangler.jsonc`, with the same guards as the default one. The static check now holds every wrangler configuration in the package to them, asserts nothing in `src/` imports from outside `src/`, and that no script but the browser run names the test entry.
- **Two small items from the first PR's review:** the no-logs check matches the word `console` anywhere, and the `content` CI job installs with `npm ci --ignore-scripts`, since its tests only read the pinned wrangler's source. The tests pass from that install.

**What the run couldn't show,** as the report says: no real DNS, TLS or edge; a service worker's script is fetched outside the interception; one machine, headless.

**Owed, with the PR that adds it: a browser job in CI for the content Worker, covering all three engines.** Until then the report is a local run on one machine, dated, at a named commit.

**A follow-up, 2026-11-13, from that PR's review.** The run now fails unless every installed browser ran and unless each thing the sandbox buys held in each: the `null` origin, storage refused, no cookie read or written by a sibling, no cookie on any request, no `Set-Cookie` reaching the browser, and the control showing the opposite. What an ordinary app can do stays recorded and unasserted. It cleans up when stopped by a signal, tests only the Worker it started, on a port chosen at the start, and waits on the page in place of fixed times, except for one named wait where nothing happening has no event. The report was rerun at the commit it names.

#### What step 9 built

*2026-11-12, by the architect's rulings on the scope.* One PR, since the contract changes with its code. Behind `RELEASES`, with no provider configured.

- **A report that names an app,** `createAppReport`. Only the address's host is kept, normalized as a custom hostname is: a hostname, or an `http` or `https` URL on one, whose path, query, fragment and port are dropped. A URL with a user name or password is refused. **Nothing asks whether anything is served at the host,** so the answer is the same whether it exists, is served or is suspended, and a report is no oracle. It counts against the same 10 a day as a room's report, either way round, and is idempotent by its key, as `createReport` is. The host is a name, not an ID: it is kept only in the Moderation object's `app_report` table and the operators' queue, and reaches no log, event or other answer.
- **One queue for operators,** `listReports`. While release is switched on, every report has `kind`, `room` or `app`, and `host`, and both kinds page by one cursor: each report takes the next number after every report of either kind. **Switched off, the queue and its shape are exactly M4's,** rooms' reports only, so staging's answer doesn't change. An app's report can't be used to suspend a room: operators suspend the app by its host or label.
- **The release App's read budget across the deployment:** 3,000 reads in a rolling hour, in the Moderation object's `release_reads` table, decided by `podster_core::release::read_budget_wait`. A release reserves its reads by its ID; asking again inside the hour answers as first made and counts nothing more. Past the budget it is told when it would fit, and has reserved nothing. **Nothing calls it until the release job, step 5,** and no route reaches it.
- **Tests with controlled time:** the object reads its clock from a test table in test builds, so the report day's edge and the budget hour's are each tried to the millisecond.

**Left to the steps that use them:** the job's reservation and its "waiting" state (step 5); the 20 releases a day, checked when a release is asked for (steps 5 and 6); the file and size caps inside the job (step 5). `crates/core` already decides each.

**Owed by step 5, from step 9's review on 2026-11-13. Each must hold before anything calls `reserve`:**

- **The read budget can be starved.** It holds no room: no room column, no share for each room, and no way to give reads back. Ten full-size releases fill the hour, one room's 20 a day allow that, and a room mints its own release IDs. So **step 5 must add a share for each room, or some other fairness, before any caller exists.**
- **`reserve` trusts the caller's `reads`.** It never calls `reads_for_release`. A retry asking for more than its first reservation is answered with the first, smaller figure and `fits: true`. So **step 5 must compute the figure from the tree it read, and compare it with what was reserved,** before it fetches anything.

**Owed by step 10, before `RELEASES` is on anywhere:** the operators' page, `apps/web/app/(shell)/moderation/page.tsx`, isn't ready for apps' reports. It shows a report's `handle` as the workroom, which is null for an app's report; it shows no `host`; and it offers the room actions, which answer `not_found` for an app's report. Step 10 must show an app's report by its host and offer the app's suspension instead.


**The Moderation object is now the deployment's one busy object.** It holds the stop for the whole content domain, which every room reads before every serve entry it writes; the takedown findings; every report and operator action; and the read budget. Each is small, and one object keeps the daily report limit and the budget exact. **If it became a bottleneck, the stop's read would move out first:** it is the one asked on every entry write, and it could be served from a copy each room keeps and the object updates, with the object still its authority. The read budget would be next, into an object of its own. Neither is built now.

#### What step 5's first PR built

**The room's recheck of a release, alone.** Built on 2026-11-13, behind `RELEASES`, with no provider configured. Step 5 is split by the architect's ruling: this first, then starting an upload and committing live on top of it. Nothing here uploads, commits or serves, nothing calls it yet, and **there is no room schema step, no D1 migration and no contract change.**

- **One internal room command, one pass of the recheck for one release.** It gathers every fact `crates/core`'s `recheck` asks for, from current state, runs it, and fails the release with core's own reason when it doesn't hold: the state, the reason and the time, an audit record and an event, `release.failed`, as Podster's act, in one room transaction. A release that has ended, isn't approved yet, or is already committed live is left exactly as it is.
- **Where each fact is read:**
  - *The room's own rows, inside the transaction:* archived, public, the public surface's and the app's suspension, release on in the room, the configuration's version, the epoch, the repository's link, the commit against the room's own merge record and its task, the reviewer rule, the requester's and the approver's place in the room, and the requester's `deploy` grant.
  - *Another object, asked before the transaction:* the stop, from the `Moderation` object; the organization's provisioning delegation, from the organization's own object; and from each person's own `Principal`, whether the approver, the requester and the grant's giver have left the organization their place here is held in. And the deployment's switch.
  - *Checked again inside:* each of those answers is about a named person or organization. If the room's rows name someone else by the time of the transaction, nothing is decided, and the pass answers `standing_unknown`.
  - **A fact that couldn't be read is undecided, never failed.** *From the reviews.* Only a fact that was read and doesn't hold fails a release, which can't be undone. The stop unreadable, an organization's or a person's record that doesn't answer, an answer that isn't a yes or a no, and someone the rows make worth asking about now who wasn't when the questions were asked, as when they were made an admin in between: each answers `standing_unknown`, which the job retries, and writes nothing.
  - **Nothing is read from D1 or any read model.**
- **The organization's provisioning delegation is read here, and only refuses** ([decision 218](spec/PRODUCT.md#decisions-needed)). *2026-11-13, changed by decision 218's first PR (#344): it is now core's `organization_may_provision`, a fact of the recheck alone, refused as `release_not_delegated` and never an unpublish trigger. `organization_may_release` is now the dedicated release switch, which isn't read yet and so holds. This bullet first said `organization_may_release` was the delegation.* It unpublishes nothing. **"No record means granted" is M5's default,** restated here as such: an organization nobody has set it for holds it. The delegation is held for a provider, which the room's linked repository names; with none linked nothing is asked, and the release fails for having no repository.
- **A commit counts** when the room's merge record for the release's task says Podster's merge job called the merge and read it back, with that commit, in the room's linked repository, and the task is completed. "Merged by Podster" is two things in that record: `succeeded`, which only Podster's merge job writes, on core's proof, and the time that job called the merge. A merge someone else made is recorded with neither. Who the provider says merged isn't compared: the room keeps no ID of the merge App's own account. *2026-11-13, from the review: this overstated. The two don't say whose call merged it; [the second PR's note](#what-step-5s-second-pr-built) says what they do say and why a commit doesn't care.*
- **The requester's grant is the one on the room's linked repository,** not the oldest they hold.
- **The event names the release it is about,** by its ID, with the reason's code.
- **The internal path is reached by nothing:** no route forwards to it, and a test shows no client path does.
- **The two test gaps in `crates/core/src/release.rs` are closed,** in `crates/core/tests/release.rs`: a retry under a higher epoch is refused, and the flight's own release asking for another script is refused. Both were still open; each change the mutation pass had found now fails that test.

**Facts with no source yet, each failing closed or unable to fire:**

- **An agent that asked for a release always fails the recheck,** `requester_lost_authority`. The release keeps who asked and not the person who controls them, so whether that person still holds can't be asked. **Step 6 must record the controlling person with the request,** which needs a column on the release: a room schema step, to be shown on a room made before it (M6-S04).
- **The organization deleted, and the room deleted, can't happen:** nothing deletes either. The room's fact is wired to a status nothing sets.
- **Whether the task was reviewed under the room's person-reviewer rule isn't recorded.** What is checked is the rule the room has now: if it requires a person as reviewer, the task's reviewer was one. **Step 6 must record, with the request, whether the rule was on,** if the ADR's "where the release's task was reviewed under that" is to hold as written.
- **"Nobody who may release remains" is answered from the requester alone.** Core asks it only after it has asked whether the requester may, so here the requester's own answer is the only one that can matter. The unpublish trigger of that name, which asks about everyone, is step 6's.

**Owed to step 6:**

- **Who may give a `deploy` grant, and the route that gives one.** The grants table takes any action's name, so tests seed `deploy`; **no route gives one today,** and a test holds the grant route to M5's two actions.
- **The dedicated release switch for operators,** which is what fires ADR 0010's unpublish trigger for an operator taking the ability to release from an organization. Owed before `RELEASES` is on anywhere ([decision 218](spec/PRODUCT.md#decisions-needed)). The provisioning delegation read here is not wired to that trigger.
  - *2026-11-13: its rules are built, in decision 218's first PR (#344), pure, in `crates/core` and `crates/policy`.* The organization's two facts are split: the release switch (`organization_may_release`), which unpublishes, and the provisioning delegation (`organization_may_provision`), which only refuses. Both answer `release_not_delegated`, and each keeps a cause of its own, `release_switch` or `provisioning_delegation`, for the audit record and findings. The switch carries its generation and the generation of its last take. **A room comes down whenever a take happened after the generation it last applied, even if release has been given back since,** so a room that missed the take, or isn't in the organization's list of rooms, ends the same as one that heard every notice in order. A notice and a room's own read take the same rule. A new room starts from the switch as it read it while being made, or from unset, which fails closed. Two answers at one generation that disagree are undecided. Only an operator, as a person, sets the switch; an operator or the organization's admin reads it. **Still owed, to PRs B and C:** the route, the contract, the organization's state, the notices, the room's unpublish and the findings, listed in #344.
  - *2026-11-13: decision 218's second PR (PR B) builds the route and the organization's state, behind `RELEASES`.* `GET` and `PUT /v1/orgs/{org}/release-delegation`: switched off, which is every deployment, it is answered where an unknown path is, for everyone, operators included. Switched on, an agent is refused by its kind; an operator or the organization's admin reads it, and only an operator sets it, `{ granted }`. The switch is kept in the organization's own `Principal`, one row and a log, `granted`, `generation` and `last_take`, written only through core's `set`; no row is unset. Every set is also in the operators' record, as `release_switch.granted` or `release_switch.revoked`. **The recheck reads both facts** from the organization's own object, the delegation and then the switch, and a release either stops fails `release_not_delegated`, with `release_switch` or `provisioning_delegation` kept in its audit record as `cause`. An answer that isn't a well-formed switch is undecided, `standing_unknown`. **What it doesn't do: unpublish.** A take refuses a release at the next recheck that reads it, which isn't at once: a commit whose outside reads were made just before the take can still go live, since a confirm decides on reads up to 5 seconds old. Nothing tells a room, and no app comes down, until PR C, which adds the room's stored switch, the notices, the room's own read on the walk, the unpublish and the findings. *Corrected in PR C: this bullet first said a take refuses new releases and commits at once.*
  - *2026-11-13: decision 218's third PR (PR C) carries a take to the rooms, and unpublishes.*
    - **The room's stored switch** is room schema step 40, `release_switch_applied`, one row whose defaults are unset. **Rooms that exist when PR C deploys start unset,** so each comes down at its first answer that shows any take, a take made before PR C included. A room made after PR C starts from the switch it read while being made, or unset if that read failed. The deploy that carries step 40 is wrapped in M6-S04's two phases.
    - **Notices.** Each set writes, in its own transaction, one notice for every room in the organization's `org_room` list (taken from the listing once if the list was never filled), replacing any owed for an earlier set. The organization's alarm sends the switch as it is then, and again until the room answers: 5 seconds doubling to 5 minutes (core's `switch_notice_unanswered`). From the twelfth unanswered try on, about half an hour, operators are told by a `release_switch_notice_unanswered` finding naming the organization, kept in their own record, and told again at every try after that. A notice is never given up, except as below. A room acts on a notice only if it names the room's own organization (`podster_policy::release::release_switch_notice_is_for_room`), and refuses one that isn't a well-formed switch or that it can't store, never acknowledging it. *Changed in the follow-up:* the count of unanswered tries carries across sets; a room that answers that it is another organization's is told to operators once, as `release_switch_notice_misdirected`, and its notice is then dropped; and a room still being made doesn't acknowledge a notice, which is sent again once it exists.
    - **The room's own read,** the backstop that is enough alone: at every release command, before anything is decided, and whenever the reconcile asks the room anything, its walk's wake included. A notice and a read take core's one rule, `apply_release_switch`.
    - **The unpublish** is Podster's act, `UnpublishTrigger::ReleaseTakenFromOrganization`, in the transaction that records the switch: audited as `app.unpublished` with cause `release_switch` and the generation, and told to the room's managers as the event `app.unpublished`, reason `release_not_delegated`. A room with nothing up still raises its epoch. The release bookkeeping that follows ends every release that hadn't gone live as `release_epoch_moved`, as after every unpublish, so the audit cause `release_switch` on a release appears only in a room that had already applied the take, such as one made after it. Only a take newer than what the room applied unpublishes, so the same answer again changes nothing.
    - **A commit racing a take.** If the room hears of the take between the commit's reads and its confirm, the unpublish clears the stage and the commit is ended `release_epoch_moved`; if it hears after the confirm, the release that went live is unpublished. Either way the take ends it, as soon as the room hears.
    - **How long a room the list doesn't name can keep serving, at worst.** Until whichever comes first: a release command in that room, which reads the switch before it decides anything; or the reconcile asking the room anything. The walk wakes 50 rooms of the app-label lookup table in each pass, from where the last stopped, and both reconciles walk, so with L labels a room is reached within about ⌈L/50⌉ passes of the 5-minute reconcile, which is ⌈L/50⌉ × 5 minutes; the walk's 10-second budget can make a slice smaller, and a room whose organization's object doesn't answer stays up until the walk reaches it again. The entries pass also asks the room behind each serve entry it lists, which can reach it sooner. **No environment has a reconcile cron entry today,** so until that entry is added with the provider's configuration, such a room is reached only by a release command of its own: `RELEASES` and a provider must not both be on before then.
    - **Tests:** `release-switch.spec.ts`. *Not shown on staging: release is switched off there.*
  - *2026-11-13: the follow-up to PR C, owed from its reviews.* No room schema step and no contract change.
    - **A wake lost after an unpublish comes back.** If a room's own arm failed, or the object stopped, after an unpublish committed, the notice is sent again, answered stale, and the room arms for what the applier owes all the same: the room arms after every request that isn't a read, whatever it answered. That was already so; a test now shows it with a failpoint that stops the room right after the commit. No second arm was added for it.
    - **The count of unanswered tries carries across sets,** so setting the switch again doesn't put off telling operators about a room that never answers. It counts tries since the room last answered.
    - **A listed room that is another organization's** answers 403 to every try. The organization tells operators once, `release_switch_notice_misdirected` naming the organization (never the room), and only then drops the notice; if that telling fails, it is a failed try like any other. A later set writes a notice for the room again, which is settled the same way. The room reads its own organization's switch itself.
    - **A notice reaching a room still being made.** The room has read the switch, and the set the notice is about may have come after that read. Before, the room answered `known: false` and the notice was dropped, so the room started behind the take until its own next read. Now a room being made doesn't acknowledge it, and the organization sends it again once the room exists.
    - **Decided by the architect on 2026-11-13, for the owner to review: `app.unpublished` is emitted for a room that has a release configuration but nothing up.** The unpublish still raises the epoch and ends every release that hadn't gone live, so the room's managers are told the app was unpublished and why, as an operator's suspension of an app tells them `app.suspended` whether or not anything was up. A room with no release configuration records the switch and emits nothing.
    - **Decided by the architect on 2026-11-13, for the owner to review: the organization's first pass stays sequential.** Each room has 10 seconds to answer, and an organization holds at most 20 rooms, so the worst pass, every room hung, takes 200 seconds, inside the 300 seconds its alarm is set ahead for an evicted pass. A room behind hung ones hears at most that much later, and its own read is the backstop. Parallel sends would bring that down; they aren't worth the extra concurrency in the organization's object while the cap is 20. If the cap rises, revisit this.
    - **Owed, not built: the stored switch's CHECK as strict as core's `well_formed`.** Step 40's checks allow a row core would refuse, such as `granted 0, generation 2, last_take 1`. Nothing writes one: the room records only a switch core accepted. SQLite can't change a table's CHECK in place, so making it strict is a table rebuild in its own room schema step, wrapped in M6-S04's two phases on staging. That isn't cheap for a constraint nothing can violate, so it is recorded here and left to the next room schema step that touches the table.
    - **Owed, from the follow-up's review (none of it code in this PR):**
      - *For the next contract PR:* `setReleaseDelegation`'s summary in `openapi.yaml` still says the notice is sent "again until the room acknowledges it", which a misdirected room's notice no longer is, and it doesn't name the new finding code `release_switch_notice_misdirected`.
      - *An object dying after an unpublish on the room's own-read path has no resend.* A notice is sent again; a read is not. The room's next request that isn't a read arms it, which on that path is the next release command or the reconcile's next question.
      - *A set landing while a room's acknowledged call is under way carries the old count of tries* to the newer notice. The acknowledgement deletes only up to the generation it sent, so the newer notice stays owed with a count that isn't reset by that answer.
      - *The organization reads the room's refusal of another organization's notice by its status, 403, not by its code.* Today only that refusal answers 403 on the notice path; anything that adds another 403 there must also change how the organization reads it.
      - *Two behaviours have no test:* no wake is set when nothing is owed, and a telling of a misdirected room that fails doesn't drop the notice.
      - *A new take reaching a room that was deaf before waits up to 5 minutes for its first retry.* The set makes the notice due at once, but the count of tries carries over, so if that first send fails, the next wait is the long one the count has reached.
    - **Tests:** `release-switch.spec.ts`, under "the follow-up to decision 218's PR C": the lost wake, the count across a set, the misdirected room, a room being made, a room with no release configuration, and five arrival orders through the Worker.

**Left for the second PR:** starting an upload, committing live, failing an upload past its hour, the delete job's recheck of the upload exemption, and the interleavings.

**Binding the second PR,** from the reviews of the first:

- **It does its own outside reads in the same command as its transaction.** A commit never trusts an earlier pass that held: `rechecked: true` from this command is an answer about then.
- **Identity alone is not enough before something goes live.** For the stop, the delegation and departures, the commit compares a version or a generation inside its transaction, or reads again after it, so a change in the window between the reads and the transaction is caught before anything is served. This PR's check, that an answer is about who the rows name now, catches a change of who; it doesn't catch the same person leaving, or the stop being set, in that window. Here that can only let a pass hold that a later pass fails, which is harmless when nothing goes live on it.
- **Failing an `uploading` or `uncertain` release queues its script for deletion and clears `in_flight_release`.** This PR's fail changes the release's row and nothing else, which is right only while nothing has uploaded.
- **Releases still `awaiting_approval` at an unpublish:** this command leaves them alone, since there is no approver to ask about. What ends them is the second PR's, or step 6's, to say.
- **The reviewer rule differs from ADR 0010's "where the release's task was reviewed under that".** It is checked as the room has it now. Recording, with the request, whether the rule was on is owed to step 6.
- **The organization-exists fact is hard-coded true.** It needs a source before a commit rests on it.

#### What step 5's second PR built

**Starting an upload and committing live, in the room, with what ends a release that can't go on.** Built on 2026-11-13, behind `RELEASES`, with no provider configured. Nothing calls either command yet, and nothing here reads a repository or uploads a file. **There is no room schema step, no D1 migration and no contract change:** every column it writes was made in step 2.

- **Start an upload.** A queued release whose recheck holds becomes `uploading`: the room names its script, from its label and its own ID, and records when the upload began. Asked again it is the recheck and the same name.
- **Commit live, in two room transactions with the outside reads between them.**
  1. *Stage,* on the room's own rows alone: core's `commit_live` sets every open host's desired script to this release's and opens the flight. The release stays `uploading`.
  2. *The outside reads,* by this same command, after the stage.
  3. *Confirm:* the whole recheck again, on those reads and the room's rows now. It holds, and the release is `live`. A fact that was read fails, and the release ends failed with its hosts set back. Nothing fails and something couldn't be read, and nothing is decided: the stage stays and the command is asked again.
- **Nothing is served on a stage.** The applier now writes a host's entry only for a release the room has recorded live or served. For any other it asks the provider nothing, leaves what the host serves, and records the host as waiting, `release_not_confirmed`. The confirm clears that wait.
- **Why the reads come after the stage,** which is how this meets "identity alone is not enough". A fact in another object can change at any moment and the room can't read it inside its own transaction, so no order of reads leaves no window at all. What the order does is put every window where something acts on it:
  - *before the reads:* the reads see it;
  - *after the stage:* the release is in the room's own state, where an unpublish finds it, raises the epoch and clears the stage, and the confirm compares the epoch. The stop is asked again by the applier itself before each write.
  - **Only one thing unpublishes today: an operator's suspension of the app.** Every other trigger in ADR 0010's list is step 6's. So, said in full, **until step 6 nothing acts on any of these once a commit's reads are made, and nothing acts on them at all once a release is `live`:** the room archived, made private or its public surface suspended; release switched off in the room or for the deployment; the repository's link no longer ready; the requester's grant revoked or their place in the room changed; the approver's place changed; a person's departure from their organization; and the organization's delegation taken back. The confirm reads the room's own rows itself, so for those the window opens at the confirm. For the outside ones it opens at each fact's own read: the reads are made one after another, so it is as wide as the reads that follow it. The two nothing asks again, each person's record and the delegation, are read last, and the stop first.
  - **So `RELEASES` and a provider must not both be configured anywhere before step 6 has merged.** With either missing nothing is served, which is every deployment today. *2026-11-13, from the review: this is now in code, [the gate on the release path](#the-gate-on-the-release-path).*
  - **The window between a commit's outside reads and its confirm: accepted as built, by the architect's ruling, 2026-11-13.** The reasons:
    - No transaction spans two objects, so some window always exists, wherever the reads are put.
    - *The stop* is covered: the applier asks it again, of its own home, before every entry it writes.
    - *The delegation, or a departure,* changing in that window gives the same result as a commit made a moment before the change, and nothing would reverse that one either. The delegation only refuses new releases and commits ([decision 218](spec/PRODUCT.md#decisions-needed)). A demotion or a removal is a room row, and is read again inside the confirm.
    - **Two conditions, both built.** *The reads' age is bounded:* if the outside reads are more than 5 seconds old when the confirm runs, by the room's clock, the confirm decides nothing and writes nothing, and the command asks again. *And each case is shown by a test* that holds the command at exactly that point and changes the fact through its own object: the stop set, and the release goes live while the applier writes nothing; the delegation taken back, and a requester's departure, and the release goes live and stays live.
- **The stage itself is recorded nowhere but the room's serve state.** It writes no event and no audit record: a stage that is never confirmed ends as `release.failed`, and one that is, as `release.live`. *This departs from "a command records an event", on purpose: a stage is half of one command.*
- **A stage nobody comes back to** keeps its host waiting, which holds every script delete in the room and makes every other release answer `waiting`, until the release's hour is over. Then the room ends it and sets the host back: on any release command, any question from the reconcile, and the room's own alarm, which a waiting host keeps set while a provider is configured.
- **A commit never trusts an earlier pass.** `rechecked: true` from the recheck or from starting the upload is an answer about then. Five tests change one outside fact after both held, and the commit fails on each.
- **What is read first.** The release's own state, before anything is asked of anyone: one that has ended, or isn't at the command's step, answers as it is with no outside read. Then every outside fact, none stopping the others. Then, inside the transaction, **a fact that was read and fails ends the release whatever else couldn't be read:** every unread fact is taken as holding while core decides, so a failure can only come from one that was read. Only when nothing fails does an unread fact make the pass undecided. *Before this PR, one object that didn't answer hid a stop that was set.*
- **Ending a release is one function,** for every command that does it. The release's row; its hosts set back by core's `set_back` and the flight closed, if it had been staged; its script queued for deletion, if its upload had started; an audit record and `release.failed`.
- **A takedown never fails or waits because of release bookkeeping.** *From the review.* Ending expired uploads, and ending the releases an unpublish left behind, is bookkeeping. Around a takedown it runs in a transaction of its own: after a suspension has committed, before the reconcile's question, and at the start of the room's alarm. If it fails it is logged by its code and skipped: the suspension has committed, the question is answered, and the applier and the delete job run. What it would have ended is ended by its next run, and can't go live meanwhile: the epoch has moved, which the recheck and core's commit both refuse. So an unpublish and the ending of unfinished releases are two transactions with nothing awaited between them, and no longer one. A test makes the bookkeeping fail and shows each.
- **A commit asked again sets the room's alarm,** whatever state it finds. One that committed and then couldn't set it leaves hosts owed, and the retry that finds the release `live` sets it: the room sets its alarm for whatever it owes after every command it is sent, whatever the command answers. *That was already so; the review asked, and a test now shows it for this case.*
- **Only a release's own script is staged.** A record that names another release's script, as step 6's rollback record will, is refused by the commit: a rollback goes through core's `rollback`, which asks whether the kept script still exists.
- **An upload an hour old is ended,** `release_upload_expired`: the bound is the one the hourly reconcile keeps a script by, from one function in core. It runs at the start of every release command's transaction, whenever the reconcile asks the room anything, and at the start of the room's alarm. **No timer of its own is set for it:** a room with nothing else to wake it, and that nobody asks, keeps an expired release as `uploading` until someone does. That serves nothing, and such a release can't be committed: a commit ends it first. A command that finds a release already ended answers with the reason on its row.
- **The delete job asks about the upload again at the delete.** A script whose release is uploading within its hour isn't deleted, whenever it was queued: its row waits until that hour is over, by its own time, and counts no attempt. **And a script that was ever queued is never committed,** `release_script_deleted`, gone or not.
- **Only a release's own script is queued when it fails.** A rollback's record, which step 6 makes, names the script of the release it rolls back to: the room's kept script, which a failed rollback must not delete.
- **For step 6 and the job's PR, from the applier's new rule:** a host is written only for a script some release names while `live` or `served`. Once a served release makes the one before it `replaced` and keeps its script, that script is written again only through a rollback's own record, `live`, naming it. A set-back that put a host back on a script whose only release is `replaced` would be refused by the applier. Nothing makes a release `replaced` yet.
- **A person's answer is about one place in the room:** the organization it is held in, and since when. If the room's rows give them another place by the transaction, the answer says nothing of it.
- **An unpublish ends every release that hadn't gone live** under the epoch it raised from: awaiting approval, queued, uploading or uncertain, `release_epoch_moved`, in the unpublish's own transaction, each with an audit record and an event, and its script queued under that unpublish. One unpublish ends at most what was asked for since the last, and a room takes 20 requests a day once step 6 enforces that cap where it takes them. At the epoch's ceiling a release started at the ceiling isn't ended, and can't go live either. *Before, they were left for a job's next pass, and one awaiting approval for nobody.* This answers the first PR's open item.
- **A failed release's script isn't told to operators as a reconcile's deletion.** The room queued it as its own act, at the moment its release ended, and that is on the room's record as the failure. If a pass later finds the script again, it is told like any other. **This changes one earlier behaviour:** a reconcile that found an upload past its hour used to queue the script itself and tell operators; now the room ends the release first, so the operators' record has the script only if it is found again.
- **The requester's grant is the live one:** not revoked, not past its expiry, for the action, on the repository and with the provider the room's link names. The room's own index allows one unrevoked grant for a principal, a repository and an action, so an expired grant can't sit beside a live one: a test shows the second row refused.
- **"Merged by Podster", said as it is.** The room's merge record says Podster's job called the merge and later read the pull request back as merged with the reviewed commit on the default branch. It doesn't say whose call merged it: if Podster's call is on record with its outcome unknown and a person merges the same pull request by hand, the record reads the same. **A commit doesn't care, and that is the architect's to overrule:** what is released is still the commit a reviewer accepted, on the room's own repository's default branch, for a completed task, through a merge Podster decided to make and called. A merge with no call of Podster's on record is refused.
- **The organization-exists fact still has no source,** and a commit now rests on it. Nothing deletes an organization: no command does it and no object records it, so there is nothing to read. It stays true, and **whatever first deletes an organization owes the fact its source and the trigger.**

#### What step 6's first PR built

**The unpublish triggers that are the room's own state,** built on 2026-11-13 as the first PR of [the step 6 plan](m6-step6-plan.md), with no room schema step and no contract change. Each fires in the transaction of the command that changes its state, and nothing is undone by undoing its cause:

- **the room archived** (`workspace_archived`), in the archive command;
- **the room made private** (`release_needs_public_room`), in the visibility command;
- **the room's public surface suspended by an operator** (`public_surface_suspended`), in the room's side of the operator's suspension;
- **the repository's link degraded** (`repo_not_ready`), where the link is degraded, by the read-back, a merge's read or an operator's recheck. Whether a link status unpublishes is one predicate in core, `link_status_unpublishes`: as ADR 0010 is written, `degraded` and `suspended` both do, by the architect's ruling for the owner to review. The owner's alternative is that predicate's `Degraded` arm, and nothing else. Nothing writes `suspended` yet.

**One function fires every trigger about the whole room,** `takedown::unpublish_for`, decision 218's release switch included: the unpublish, an `app.unpublished` audit row as Podster with the trigger's code as `reason`, and the event `app.unpublished` to the room's managers. A room with no release configuration records nothing. **The release bookkeeping runs after any request, or alarm, that moved the release epoch,** so a release that hadn't gone live is ended in the same request that took the app down, whatever trigger fired. Tests: `release-triggers.spec.ts`, and the degraded link in `repo-readiness.spec.ts`. The contract's summaries of those commands say what they now unpublish in step 6's contract PR.

#### What step 6's second PR built

**ADR 0010's deployment trigger and the reconciles' schedules,** built on 2026-11-13 as the second PR of [the step 6 plan](m6-step6-plan.md), with no room schema step and no contract change:

- **The room reads the deployment's setting, `RELEASES`,** where it reads the organization's switch: at the reconcile's question, the walk's wake included, and at every release command, before anything is decided. **It has three readings, by one pure function in core, `deployment_release`** (the architect's ruling of 2026-11-13, for the owner to review): exactly `true` is on; exactly `false` is off, and only that unpublishes, as `release_off_for_deployment`, if the room has anything up (a host whose desired script is set, a kept script, a commit in flight, or a release that hasn't ended and started under the room's epoch as it is now: one left open from before an unpublish can't go live, so a failed bookkeeping never makes `false` unpublish twice); anything else, unset, empty or malformed, is undecided, which refuses new releases and commits as off does, takes nothing down, and is told to operators once by each reconcile pass as `release_setting_undecided`. With nothing up, `false` records nothing, so the setting read again and again keeps no marker. **`false` is permanent,** as every unpublish is: setting `true` again brings nothing back. The reversible control is the stop for the whole content domain ([`docs/staging.md`](staging.md#switching-release-off-for-the-deployment)).
- **The scheduled handler runs whenever a content provider is configured, whatever `RELEASES` says,** so a deployment that switches release off still has its rooms asked. **With no provider configured, it returns before it calls any Durable Object;** a test counts the Moderation object's pass calls to show it.
- **Both schedules are in `apps/api/wrangler.jsonc`,** at the top and under `staging`, since wrangler doesn't carry them into an environment: `*/5 * * * *` and `0 * * * *`. Ruled in by the architect on 2026-11-13, for the owner to review: a schedule on an existing Worker, deployed by `scripts/deploy-staging`, not a new or billed resource. On staging, with no provider, each costs only its own invocation.
- **What a release command answers:** with `RELEASES` exactly `false`, the room unpublishes before deciding, so the release ends `release_epoch_moved`; undecided, the release is refused `release_off_for_deployment` and nothing comes down. In a deployment the Worker refuses release routes unless it is `true`, so only tests reach the room this way.
- **Tests run with `RELEASES` unset, which is undecided,** so the existing tests that ask a room the reconcile's question are unchanged. `takedown.spec.ts` runs its passes with the setting written `true`, as a deployment with a provider has it. Each reading, and four ways the setting can slip, are in `release-triggers.spec.ts`.

**A race found while building step 6's second PR, and closed.** The hourly scripts pass reads the namespace once and asks each script's room in turn. A question that ends a release wakes its room, whose delete job could count a script gone before the pass asked about it; the room then took the stale list's word that the script was there after all, queued it again and told operators of a deletion the pass started. Each question now says when the list was read, and a script the room counted gone at or after then isn't found again. Possible since step 4(a)'s third PR; seen as a flaky test, and in this PR's CI.

#### What step 6's contract PR built

**The room's release configuration, read and set** (`getReleaseConfig`, `setReleaseConfig`), built on 2026-11-13 as the third PR of [the step 6 plan](m6-step6-plan.md), with no room schema step. Like every M6 route, it is there only while `RELEASES` is exactly `true`; otherwise the room answers it as an unknown route.

- **Who:** the room's owner or an admin, as a person, by `podster_policy::release::authorize_release_config`. An agent is refused by the Worker before the room is asked. To set it, the caller's own `Principal` is asked first whether they are still in the organization their place here is held in; an answer that isn't a yes or a no is `standing_unknown` and writes nothing.
- **What:** core's `release_config_change`, from the version the caller read (0 if never set): on, off or unchanged. Any other version is `version_conflict`, an unchanged request included.
- **Switching on** needs everything release needs at all, `release_room_allows`, with the deployment's setting, the organization's switch and its provisioning delegation read from their own objects first, and applied as read, as at every release command. It also passes the release path's gate (below).
- **Switching off** is always allowed to them, in an archived room too, and is ADR 0010's `release_off` trigger: it unpublishes through `unpublish_for` in the change's own transaction. Switching on again restores nothing.
- **Switching off needs the caller's own `Principal` to answer.** Before switching release off, the room asks the caller's own `Principal` whether they are still in the organization their place here is held in. If it gives no answer, the switch is refused with `standing_unknown` (503), and nothing comes down: a room's owner can't take their app down this way while that object is unreachable, which is the object that knows whether they have left their organization. Archiving the room or making it private still works then, and each unpublishes, and so does an operator's release switch for the organization.
- **A change** raises the version, is audited as `release.config_set` by the caller, with the configuration before and after, and is told to the room's other managers as the event `release.config_set`.
- **The contract** gains the eight codes this route can answer that the REST error list didn't name, and its summaries of archive, make private, the operator's room suspension and `setReleaseDelegation` say what each now does. `listTakedownFindings` names `release_setting_undecided`.
- **Not tested:** a caller whose `Principal` gives no answer, and an admin who has left their organization. Both go through `release_recheck`'s `still_holds` and `settled`, which step 5's tests cover.

#### The gate on the release path

**One constant, `RELEASE_PATH_COMPLETE`, in `apps/api/src/workspace/release_commit.rs`, false.** While it is false, a room in a deployment that has `RELEASES` on **and** a content provider configured refuses every release command, the recheck, the start and the commit, exactly as a route that isn't built (`release_not_available`), and says so in one log line by its code, `release_path_incomplete`. With either missing nothing can be served, and the commands answer, which is how every test of them runs. A test shows the refusal, and that the constant is set in one place.

**The PR that completes the release path flips it,** and no other does. That is the last of these to merge, and all of them must be true first:

- **the caller:** the release job that calls these commands, reads the tree and uploads (step 5's own PR);
- **the marker job:** a release recorded served, and the set-back when the marker never comes (the same);
- **`uncertain` settling:** an upload whose answer was lost, settled by the provider's own answer (the same);
- **every unpublish trigger in ADR 0010's list whose fact has a source** (step 6, [the step 6 plan](m6-step6-plan.md)), which is what closes the windows named above. *Built so far: the room's own state (step 6's first PR), the deployment's setting (its second), release switched off in the room (its contract PR). Owed: nobody left who may release (6d).* **Room deletion and organization deletion have no source:** nothing deletes either, and each trigger is owed by whatever first does (the architect's ruling of 2026-11-13, for the owner to review). **A repository found gone has one:** the daily read-back and an operator's recheck each degrade the link as `repository_gone` after two looks a minute apart, and step 6's first PR unpublishes on that. **Before `RELEASES` and a provider are both on, the owner chooses a guard against an outage reading as every repository gone** ([the owner's row](#for-the-owner): an installation-wide failure must not read as gone, a ceiling on unpublishes for this cause before an operator confirms, or both; *Proposed*), since without one a GitHub incident or the provisioning App suspended or removed would retire every app's address for good;
- **the dedicated release switch for operators** of [decision 218](spec/PRODUCT.md#decisions-needed). *Built, 2026-11-13: PRs #344, #350 and #353, and their follow-up;*
- **the reconcile's cron entry, in every environment that has `RELEASES` and a provider,** or neither of those on there before it. Until it runs, a room the organization's list doesn't name keeps serving after a take until a release command of its own ([the worst case](#what-step-5s-first-pr-built), under decision 218's PR C);
- **every environment that has a provider sets `RELEASES` explicitly,** to exactly `true` or exactly `false`. Unset or malformed, the setting is undecided: nothing is released, nothing is taken down, and operators are told by every reconcile pass ([`docs/staging.md`](staging.md#switching-release-off-for-the-deployment));
- **the operators' page for apps' reports** (step 10, [owed since step 9](#what-step-9-built)).

Flipping it serves nothing by itself: `RELEASES` and a provider are still each the owner's to set.

**Left for the job's own PR:** reading the tree, fetching and uploading; an upload whose answer was lost and its settling (`uncertain`); the marker, a release recorded served, and the set-back when the marker never comes; a room's release jobs one at a time; a share of the read budget; and a timer for expiry if one is wanted. **One thing it must keep in mind:** a reconcile that queues an `uncertain` release's script and a failure of that release in the very same millisecond would leave the reconcile's deletion untold to operators, since the room tells its own failures' scripts apart by that time. Nothing makes a release `uncertain` yet. A release that is `live` and never confirmed served stays so until that is built or the room is unpublished.

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
| M6-13 | A deployed app answers only `GET` and `HEAD`, with the fixed headers, and runs no agent-written code on the server. *After the spikes, 2026-11-12: only allow-listed headers of the app's reach a visitor, never a `Set-Cookie`; a release that holds `_headers` or `_redirects` is refused, as M6-07 has it for any release that fails its checks, so no app has either; a separate test, owed with the release job, bypasses that refusal on purpose and uploads a root file of each name directly, to show it comes back as content and sets no header and no redirect; and no third-party script is added to its HTML.* Stated for question 5's proposal; it changes if server code is allowed. *2026-11-13: the owner has since said an app is a real Worker, code included ([decision 219](spec/PRODUCT.md#decisions-needed)). This is left as written. What replaces it is proposed, not accepted, in [ADR 0010's proposed revision](adr/0010-revision-apps-are-workers.md).* |
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
| M6-S02e | *Added 2026-11-13, after step 9.* The operators' report list answers the run's test people, who aren't operators, `403 not_allowed` as in M4, and the refusal carries no report and neither of step 9's keys, `kind` and `host`. **Not shown on staging:** the operator's own view, which with release switched off must stay M4's shape. Test people can't ask for it, and the run never uses the fixed test operator, so only the API's tests show it |
| M6-S04 | The same task in a room made before the deploy, which is where the room schema step's migration could really harm a room. **Always says SKIP in the usual run,** with how to run [its two phases](#m6-s04-in-two-phases-around-a-deploy) instead: such a room needs a session kept across the deploy, and the usual run keeps none |

#### M6-S04 in two phases, around a deploy

Added on 2026-11-12; not yet run against staging. M6-S04 is two runs of its own, one before a deploy and one after it, each with its own checks and exit code, and none of their checks may say SKIP:

```bash
node e2e/m6-staging.mjs --base-url https://gateway-staging.podster.dev --before-deploy --deployed-commit <full sha staging is at>
```

```bash
node e2e/m6-staging.mjs --base-url https://gateway-staging.podster.dev --after-deploy --deployed-commit <full sha scripts/deploy-staging deployed>
```

- **Staging doesn't say which commit it runs to a signed-out caller.** No route, header or probe of `scripts/staging-probes` names it, and the run calls no Cloudflare API. So the person running the phases names it with `--deployed-commit`, as `scripts/deploy-staging` printed it ("deploying SHA"). The second phase refuses the commit the first phase was given, so it can't run without a deploy named between them. It can't check that the named commit is really what staging runs. A signed-out build marker on the gateway, written by `scripts/deploy-staging` and read by the probes, would let it; that's a gateway, deploy-script and contract change of its own.
- **Why a session is kept.** The test sign-up makes a new person each time and can't sign one in again. The one exception is the fixed test operator, which the API's `OPERATORS` names, so the phases never ask for it. The first phase therefore keeps the owner's test session.
- **The kept file** is `~/.podster/m6-staging/s04.json`, outside the repository, in a directory at mode 0700 and itself at 0600. It's written whole to a temporary file beside it and then published with a hard link, so it's never written over another file or through a link. A file or directory others can read, or a link in their place, is refused. The first phase checks the directory and any file already there before it sends anything, and proves the write with a probe file made the same way, so a refusal never costs a sign-up. Either phase first deletes temporary files of the script's naming that a killed run left, since one may hold a session. It holds the session, the IDs of the owner, organization, room and task, the commit the first phase was given, how many of the room's events it read, and when it goes stale. It never holds the sign-up secret, and neither phase prints the session or the file's full path.
- **When it's stale.** A test session ends by itself 2 hours after its sign-up and isn't renewed, so the file is stale 105 minutes after the sign-up, leaving the second phase 15 minutes. Before deleting a stale file, either phase first sends its session's sign-out, the one request a refusal sends. The second phase then refuses. The first phase refuses while an earlier file is still usable, and never deletes a file that isn't one of this script's.

| ID | Phase | What it shows |
| --- | --- | --- |
| M6-S04a | Before | One test sign-up, an organization, a room and an agent. A task is offered to the agent and accepted. The agent is disconnected, so by the departure rule the task is open again with no assignee: part-way through its life, with state and events written by the commit staging is at. Its events include `task.offered`, `task.accepted` and `task.assignee_departed`. The session is then kept |
| M6-S04b | After | No sign-up. The room made before the deploy: its task is still open with no assignee. It's offered to a new agent, accepted, submitted and completed, as M6-S03 does in a fresh room |
| M6-S04c | After | The older room's settings reads, the room, its visibility and its audit log, answer. They, the owner's task read and the agent's room and task reads carry no M6 field |
| M6-S04d | After | Every M6 read on the older room answers its owner with the API's own answer for a missing route, exactly as an invented neighbouring path does, as in M6-S01a |
| M6-S04e | After | The older room's events up to the last one the first phase read are exactly as many as it read, a `task.completed` for the task follows them, and none is an M6 event type |

**Exit codes,** for each phase: 0 when all its checks passed; 1 otherwise; 2 when a refusal stops it before anything is sent. A refusal covers a missing, unusable or stale kept file, the same commit, and a failed preflight.

**The second phase is one try.** Its writes can't be repeated on the same task, so its clean-up signs the kept session out and deletes the file whatever its checks found. A failed second phase means running both phases again around another deploy.

**The self-test runs both phases** against `e2e/m6-staging-standin.mjs`, one process after the other, with the stand-in's state kept in a file between them as staging's would be across a deploy. It covers:
- a pass of each phase;
- each refusal, and that the first phase's come before any request;
- an agent whose disconnect fails, which stays on the clean-up list;
- Ctrl-C in each phase, which still signs out, disconnects and, in the second, deletes the file. The stand-in holds a named request until the self-test has sent the signal, so it always lands mid-phase. One case lands at the first phase's last request: a stop asked for at any point of M6-S04a keeps no file. Another lands during the second phase's clean-up, after every check: the outcome stands, and the clean-up finishes;
- a kept session the stand-in no longer accepts;
- a stale file;
- that neither the secret nor the session reaches the output.

The stand-in makes the run's own pacing waits at once, so the self-test sleeps on nothing.

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

**Left behind by M6-S04's phases:** one test person, an organization, the older room and its task, and two agents, both disconnected. The first phase signs out every session but the one it keeps. The second signs that one out, and deletes the kept file. A first phase that is never followed by a second leaves its session to end by itself, 2 hours after its sign-up.
## Threat model

**Draft, to be walked against the built system at step 11.** *Where a row and [ADR 0010](adr/0010-release-and-the-content-domain.md) differ, the ADR is the later word: rows written on 2026-11-10 still speak of a private room's app and of the Public Suffix List as defence in depth.* "Unverified" means nothing has tested it. "From M5's spike" means the M5 spike saw the GitHub half once; the M6 half is still unverified.

| Threat | Proposed mitigation | Verified? |
| --- | --- | --- |
| A deployed app reads or sets the application's cookies, or another room's | A separate registrable domain, one host per room, nothing under `podster.dev`, and no cookie set and no credential accepted by Podster on any app hostname. That protects the application without the Public Suffix List entry. Between rooms, the entry is defence in depth: until browsers ship it, one room's app can set a cookie another's reads, a known gap. A sandboxing Content Security Policy on every response is a candidate for ADR 0010 | Unverified. Browsers' uptake of a new list entry is outside Podster's control. *Seen in spike C, 2026-11-12, in three headless browsers: the application's cookies were out of reach; sibling hosts read and overwrote each other's domain cookies; a sandbox closed that and cost an app its storage. The sandbox is the owner's choice* |
| A deployed app reaches Podster's data | The app has no bindings. The content Worker has none to the gateway, the API, D1 or R2 | Unverified. The architecture cites Cloudflare's isolation page; nothing was tried. *Seen in spike A, 2026-11-12, for one test script: no bindings, an empty `env`, and a 404 from another Worker of the account* |
| Agent-written server code calls out, mines or attacks from Podster's account | Static files only in M6 (question 5), so no agent-written code runs on Cloudflare | Unverified, and gone if server code is allowed *2026-11-13: the owner has since said an app is a real Worker, code included ([decision 219](spec/PRODUCT.md#decisions-needed)). This is left as written. What replaces it is proposed, not accepted, in [ADR 0010's proposed revision](adr/0010-revision-apps-are-workers.md).* |
| Unreviewed code is deployed | Only a commit that Podster's merge job put on the default branch and confirmed there is releasable, checked in Rust and rechecked by the job, which reads the files at that exact commit | From M5's spike for the merge path. Unverified for the release |
| An approved or merged task deploys with no deployment authority | Deployment needs its own grant and the room's policy, checked in Rust at the command and again in the job. Approval and merge grant nothing (AC-17) | Unverified |
| A stale job deploys after revocation or after deployment is switched off | The job rechecks current authority and the current `release_config` version before its external call (AC-13) | Unverified |
| The publishing credential leaks, or is used on the wrong target | Held by the private API Worker only, scoped as narrowly as Cloudflare allows, with the account, namespace and app name from trusted configuration and server-generated names. A second account if the scope can't exclude Podster's own Workers | Unverified. The token's narrowest scope isn't known |
| A client steers a release to another account, namespace or app | None of those is accepted from a client (M6-21) | Unverified |
| Someone maps a hostname they don't control, or takes over one whose DNS was left pointing at Podster | Proof of control before routing, one claim per hostname owned by a single object, the proof rechecked on a schedule, and routing removed when it fails or the mapping is removed | Unverified. The custom-hostname flow is the spike the architecture asks for |
| A custom hostname is Podster's own name or another room's host | Refused in `crates/core` (M6-15) | Unverified |
| Podster hosts phishing, malware or illegal content written by an agent | Deployment is off by default and switched on by a person; releases are of reviewed, merged commits; a person approves each release in a public room; operators can suspend an app; reports can name one; the terms cover it | Unverified. The legal text isn't written |
| A deployed app imitates Podster's sign-in | A different registrable domain, a server-generated host label that never contains a room's or Podster's name, and operator suspension | Unverified *2026-11-12: more convincing on `podster.site`, which carries Podster's name where `opster.dev` only resembled it. The label is still random; the domain now says Podster. The owner's choice, recorded with its consequence* |
| A deployed app runs up Podster's bill | Caps on a release's size and file count, releases per day and one app per room; static files only; platform limits if the spike finds them | Unverified. No platform limit has been tried *2026-11-13: the owner has since said an app is a real Worker, code included ([decision 219](spec/PRODUCT.md#decisions-needed)). This is left as written. What replaces it is proposed, not accepted, in [ADR 0010's proposed revision](adr/0010-revision-apps-are-workers.md).* |
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
| 3 | Same Cloudflare account as Podster's own Workers, or a second one? | **Changed on 2026-11-12, by what the documentation shows:** a second account, unless a spike finds a token that can't touch Podster's Workers. Cloudflare's permissions page shows no token permission scoped below the account for Workers. **Owner's yes** either way. *It was: decided by the spike, the same account if the token can be scoped.* **Decided by the owner's action on 2026-11-12: a second account** ([decision 217](spec/PRODUCT.md#decisions-needed)). | Accepting an account-wide token beside Podster's Workers. Loosens the stance; not proposed. |
| 4 | Where do builds run? | Nowhere in M6. A release is a fixed directory already committed at the merged commit, copied as it is. Podster runs no agent-written build, and Actions stay off. | GitHub Actions in the managed repository, which reverses ADR 0009's proposal and needs its own decision. A Podster build service, which runs untrusted code on Podster's account. Both the owner's yes. *2026-11-13: the owner has since said an app is a real Worker, code included ([decision 219](spec/PRODUCT.md#decisions-needed)). This is left as written. What replaces it is proposed, not accepted, in [ADR 0010's proposed revision](adr/0010-revision-apps-are-workers.md).* |
| 5 | Static files, or server code too? | **Decided on the owner's behalf on 2026-11-12 ([decision 214](spec/PRODUCT.md#decisions-needed)): static files only. What follows is the first draft.** **Owner only**, both ways. The working assumption is static files only. The architecture describes each app as a user Worker; under the assumption that Worker is Podster's fixed file server, or a static-assets upload, whichever the spike shows works. It narrows core job 8's "working web application" to what runs in a browser, and that narrowing needs the owner as much as the alternative does. | An agent-written Worker with no bindings and blocked outbound requests, after a spike of the isolation. Podster would then be running code an agent wrote, which touches "Podster never hosts or runs agents": the code isn't an agent, but the line needs the owner to draw it. *2026-11-13: the owner has since said an app is a real Worker, code included ([decision 219](spec/PRODUCT.md#decisions-needed)). This is left as written. What replaces it is proposed, not accepted, in [ADR 0010's proposed revision](adr/0010-revision-apps-are-workers.md).* |
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

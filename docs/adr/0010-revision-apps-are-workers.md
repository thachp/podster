# ADR 0010, proposed revision: a room's app is a Worker

**Status: Proposed, by the architect's session on 2026-11-13. Its stage-1 questions were answered by the owner on 2026-11-13, each as recommended ([decision 220](../spec/PRODUCT.md#decisions-needed)); those answers are decided. The design that follows from them, and everything about stages 2 to 4, is still proposed: it was reviewed twice before the owner answered and awaits an independent review before it is marked Accepted. No code is written for it.** It proposes how [ADR 0010](0010-release-and-the-content-domain.md) changes now that the owner has said an app is a real Worker and not only static files ([decision 219](../spec/PRODUCT.md#decisions-needed)). ADR 0010 itself is unchanged apart from a dated note pointing here; if this is accepted, its sections are revised then, each with what it said before.

## The owner's words

**Every message of the owner's on this, exactly as written, in order, all on 2026-11-13. Nothing else in this document is the owner's.**

1. "not sure if i mention it . .but the application that get deployed to the worker can any of the programming language that cloudflare worker for platform support"
2. "not just html"
3. "don't worker has the ablity to build code?"
4. "worker - i see has \"deployment\" feature"
5. "looks like it can be done using the worker publisher.." followed by the address https://github.com/cloudflare/templates/tree/main/worker-publisher-template
6. "there is an example"
7. "they got a few good example.. https://github.com/cloudflare/templates/tree/main"
8. "i'm thinking of more a full framework app -". *This answered the architect's question whether the first apps are closer to a plain Worker or static site, or to a full framework app with a database like the templates. "With a database" was in the question, not in the answer.*
9. "the firs demot app will most likely be a demo app"
10. "i mean a todo app"
11. "okay". *This answered the architect's summary of what a todo app needs. It approves no decision.*
12. "stage1: all as recommend". *This answered [the stage-1 table](#stage-1-one-todo-app) below. The architect had put its rows 1 to 10, with 4a and 4b, to the owner, each with this document's recommendation, and had said that this reply would mean all as recommended.*

**What those words settle:** an app is a Worker, code included, in any language Workers for Platforms runs, and not only HTML (1, 2). **The target is a full framework app** (8), and **the first app published is one todo app** (9, 10). **What they don't settle, and stays the owner's to decide:** whether an app gets storage, of any kind; whether Podster builds; what an app may reach; the sandbox. Each is a row in [the summary](#1-summary-the-decisions-by-stage).

**What this overrides:** [decision 214](../spec/PRODUCT.md#decisions-needed)'s "an app is static files: nothing an agent wrote runs on a server". **What it leaves, proposed:** one environment, `production`; no preview of unmerged code; only a public room releases ([decision 213](../spec/PRODUCT.md#decisions-needed)). **What it puts in question:** the strict sandbox ([decision 216](../spec/PRODUCT.md#decisions-needed)), which the owner confirmed again on 2026-11-13, before message 8: the architect asked "Keep the sandbox as strict as it is? Forms, downloads and popups don't work under it. I'd keep it until real apps show what they need.", and the owner answered "2. per your recommendation". That conflict is [section 2](#2-the-sandbox-conflict).

**What is built, as of `main` at `f43fdcc` on 2026-11-13.** Steps 1 to 4 and 9. The room's half of step 5: its recheck of a release, starting an upload and committing live, with the constant `RELEASE_PATH_COMPLETE`, false, and the gate's list ([the plan](../m6-plan.md#the-gate-on-the-release-path)). The first parts of step 6, as [the plan](../m6-plan.md#what-step-6s-first-pr-built) records them: the unpublish triggers that are the room's own state, the deployment's trigger with the reconciles' schedules, and the rules of the organization's release switch. **Not built:** the release job that reads a tree and uploads, which is held for this revision; and everything this revision proposes. *Until 2026-11-13 this paragraph, and five lines below, said the room's commit was "in PR #336, not yet merged". It merged that day, as `86db135`.*

## How to read this

- **Cloudflare's documentation:** read on developers.cloudflare.com on 2026-11-13, said here in this document's own words, and linked. Not run. **"Not found"** means the page read doesn't say.
- **Cloudflare's templates:** read on 2026-11-13 from the main branch of [cloudflare/templates](https://github.com/cloudflare/templates/tree/main), as references. **Nothing is copied from them:** all of Podster's code is written fresh ([CLAUDE.md](../../CLAUDE.md)).
- **Seen in spike A or C,** or **in the browser report:** from [the M6 plan's spike results](../m6-plan.md#the-spikes) and [the sandbox report](../m6-content-sandbox-report.md). One observation each.
- **Proposed:** this document's proposal. **A guess:** not supported by a page or a run, and named as one. **The owner's:** it costs money, changes what Podster answers for, or loosens a security stance.

**Nothing here is verified.** No call was made to Cloudflare or GitHub for it.

## 1. Summary: the decisions, by stage

**This section is meant to be decided from alone.** Each row is one question, what is recommended, what it costs, and what happens if the answer is no.

**Stage 1 is decided. The owner, on 2026-11-13: "stage1: all as recommend".** Each of its rows is marked below. Two are a yes in principle with a spike still owed, and two leave a figure or a setting with the owner. **Stages 2 to 4 are not decided,** and everything about them is **proposed.**

### Stage 1: one todo app

**What it is:** a todo app built with a front-end framework as a single page, published from a reviewed, approved, merged commit. A small Worker that answers a JSON API, static files for the page, and one store of its own. No login, no outbound access, the sandbox exactly as it stands.

| # | The question | Recommended | Cost | If the answer is no | The owner, 2026-11-13 |
| --- | --- | --- | --- | --- | --- |
| 1 | **May an app have a store,** one for each app, made and owned by Podster in the second account? | **Needs a spike first.** Yes in principle; whether it is KV or D1 waits for the answer on tokens ([section 3.3](#33-its-store)) | KV: see [the cost table](#what-stage-1-can-cost). D1's prices weren't read | A todo app can't keep its items. Stage 1 is then a page that forgets everything on reload | **Decided in principle: yes.** The spike is still owed, and whether the store is KV or D1 waits for it |
| 2 | **May anyone who has the address read and change a demo's list,** since there is no login? | **Yes for a demo,** said plainly beside the link | None in money | The demo needs a session, which needs the sandbox decision first (stage 2). The demo waits for it | **Decided: as recommended** |
| 3 | **May a demo's built files be committed to the repository,** with Podster building nothing? | **Yes for the demo.** With a committed bundle nobody checks it matches the source, so approval rests on trusting its author | None | A build path comes first: a spike, a container image, a new billed resource and a change of stance ([section 5](#5-building)) | **Decided: as recommended** |
| 4a | **Is there a cap on the write requests one app may take?** Any website can make its visitors' browsers send writes to an app, since the content Worker must allow any origin ([section 3.5](#35-under-the-sandbox-as-it-stands)); a limit for each address won't hold, because the requests come from many visitors | **Needs a spike first.** Yes: a budget of write requests for each app, held by the content Worker. How the content Worker counts isn't designed | **Podster pays for every request, capped or not.** Without a cap there is no ceiling: each million write requests is about $0.30 in requests and, **if each request makes one KV write,** $5 in writes, plus CPU. An app that writes more than once a request costs more | Nothing with a store is released: the cap is on [the gate's list](#10-what-must-be-true-before-releases-is-on-anywhere) | **Decided: yes, a cap,** with its spike still owed. **Still the owner's: the cap's figure.** None is proposed here |
| 4b | **What happens to an app past its cap?** | The content Worker answers its own refusal to further writes until the budget's period ends; reads go on. And an alert on the account's bill, which is the owner's to set | **Podster pays up to the cap,** which is a figure the owner names, and nothing past it for writes | An app past its cap goes on costing Podster, as with no cap | **Decided: as recommended**. **Still the owner's: the alert on the account's bill,** which is theirs to set |
| 5 | **May the content Worker take `POST`, `PUT`, `PATCH` and `DELETE` with a body, and answer the browser's preflight for any origin,** for an app whose release has code? | **Yes, for those hosts only.** It is a loosened stance: today it takes `GET` and `HEAD` and no body | None in money | No sandboxed page can change anything on a server. No todo app | **Decided: as recommended** |
| 6 | **May the publishing credential gain the permission to make and delete stores?** | **Yes, only if it can't then write serve entries.** That is the spike in row 1 | None in money. A wider credential | Each app's store is made by hand, by whoever holds the account | **Decided in principle: yes, only if it can't then write serve entries.** The spike is still owed |
| 7 | **An app's data outlives an unpublish.** Who may delete it: only an operator, or also the room's owner or an admin, as a person? | **Both.** Otherwise a room's owner who unpublishes can't wipe what strangers wrote into their app | None in money. Two new commands, one a contract change | Only an operator can, and a room's owner must ask one | **Decided: as recommended** |
| 8 | **May Podster deploy one more Worker, the outbound Worker,** in the second account, which refuses every request an app's code makes? | **Yes.** It is what turns sockets off and makes "no outbound" true | Whether its invocations are billed apart from the app's request: **not read** | An app's code can reach the public internet and open sockets, as spike A saw. Nothing with code is released | **Decided: as recommended** |
| 9 | **Does the owner accept that an app with a store can keep what a visitor types,** a password among them, and give it back to its author through the app's own address ([section 3.7](#37-what-stage-1-makes-possible-that-static-files-didnt))? | **Yes, with what stands against it:** review, a person's approval, a public room, a report, a takedown that reaches the data | None in money. It is Podster's name on the page | No app has a store: row 1 is no | **Decided: as recommended** |
| 10 | **Is this the right way to say what changed:** "Podster hosts what a room published, and still hosts and runs no agent"? *The sentence is the architect's, not the owner's* | **Yes** | None | The product's own wording about agents and execution needs the owner's words in its place | **Decided: as recommended** |

**What is still the owner's in stage 1, after that answer:** the cap's figure (4a); the alert on the account's bill (4b); the short-lived credentials the spike needs, and its yes to what the spike makes ([the plan](../m6-plan.md#stage-1-of-apps-as-workers-the-build-order)); and each deploy and switch as it comes.

**What needs no decision in stage 1:** the sandbox stays as it is; outbound stays refused; no new domain.

**What stage 1 is not:** it does not host Cloudflare's own todo template as written. That one renders on the server, and the strict sandbox stops what that needs ([section 3.5](#35-under-the-sandbox-as-it-stands)).

#### What stage 1 can cost

**Cloudflare's documentation,** [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) and [Workers for Platforms pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/), for the account as a whole, on a paid plan:

| What | Included each month | Past that |
| --- | --- | --- |
| Workers for Platforms | The subscription is $25 | |
| Requests to apps | 20 million | $0.30 a million |
| CPU time of apps | 60 million milliseconds | $0.02 a million milliseconds |
| Scripts in the namespace | 1,000 | $0.02 each |
| KV reads | 10 million | $0.50 a million |
| KV writes | 1 million | $5 a million |
| KV deletes | 1 million | $5 a million |
| KV lists | 1 million | $5 a million |
| KV stored data | 1 GB | $0.50 a GB-month |
| KV namespaces | 1,000 | $0.10 each |

**Not read:** D1's prices; Containers' and Workflows'; a rate-limiting binding's; whether an outbound Worker's invocations are billed.

### After stage 1

| Stage | Adds | The question for the owner | Recommended | Cost | If the answer is no |
| --- | --- | --- | --- | --- | --- |
| **2. Sessions and forms** | A login, cookies, form submission, server-rendered frameworks | **Which loosening of the sandbox,** which reopens decision 216 ([section 2](#2-the-sandbox-conflict)) | Forms and inline scripts yes; a session only on a room's own domain, until the content domain is on the Public Suffix List | None in money, unless Podster buys domains | Apps stay as stage 1's: script-driven pages that identify nobody |
| **3. A build path** | TypeScript, bundlers and framework builds run by Podster | **May Podster run agent-written build scripts in a sandbox it starts, at Podster's expense?** A change of stance ([section 5](#5-building)) | Yes, after its spike | Containers' usage, **not read** | Every app's built files are committed, and approval rests on trusting their author |
| **4. More to bind and reach** | A database (D1), files (R2); outbound requests to named hosts | **Each kind of resource, and whether data may leave** ([section 6](#6-what-an-apps-code-may-reach)) | Each on its own case. **No Durable Objects** until outbound from them can be refused | Each a billed resource, **not read** | Apps have one store and reach nothing |

### What the templates say people will want

**Cloudflare's templates:** almost every application template is a framework app that needs a build, and most bind storage. Which of them each stage could host:

| Kind of app, by template | Needs | Stage 1 | Stage 2 | Stage 3 | Stage 4 |
| --- | --- | --- | --- | --- | --- |
| A static site or blog (Astro's starter) | A build | If its built files are committed | Yes | **Yes, built by Podster** | Yes |
| A client-rendered single page (Vite and React) | A build | If its built files are committed, and it avoids what the sandbox stops | Yes | Yes | Yes |
| A todo list on KV (Remix) | A build, KV, server rendering, forms | **Only rewritten** as a single page | **Yes, with committed output** | Yes | Yes |
| A server-rendered framework app (Next, Remix, React Router) | A build, inline scripts, forms, usually cookies | No | With committed output | **Yes** | Yes |
| An app on a SQL database (the D1 templates) | D1 | No | No | No | **Yes** |
| A chat on Durable Objects | Durable Objects, WebSockets | No | No | No | **No,** until outbound from a Durable Object can be refused |
| An app on an outside database (Hyperdrive) or an AI model | Outbound, or a paid binding | No | No | No | The owner's, each |

*The template list is from the repository's folder names; for all but the four read in full, the framework and bindings are inferred from the name.*

**So "any language Workers for Platforms supports" and "a full framework app" are reached at stage 3 and stage 4, not stage 1.** Each widening is one of three things: a build path, storage for each app, or outbound access.

## 2. The sandbox conflict

**Stated first among the consequences, because it decides what a framework app can be.**

Decision 216, as the owner confirmed it, gives every app `sandbox allow-scripts` and a source list naming only its own host. **In the browser report, under that policy:** the page's origin is `null`; cookies and every kind of browser storage are refused; a form submitted to its own host sends nothing; an inline `<script>` doesn't run; `history.pushState` fails in WebKit. A framework app almost always wants a session, forms, and, if it renders on the server, inline scripts.

**Two different controls are in that policy,** and they are worth telling apart:

- **The sandbox** takes the page's origin away. It is what stops cookies, storage and forms, and it is what keeps rooms' apps from interfering through cookies set for the whole content domain.
- **The source list** says where scripts may come from. It is what stops inline scripts. It protects an app's own visitors from injected script; it does nothing between rooms.

**The options:**

| | What then works | What it costs | Safe between rooms? |
| --- | --- | --- | --- |
| **(1) Keep `sandbox allow-scripts`** | A page driven by script that keeps nothing in the browser and identifies nobody | Most framework apps don't work: no session, no forms, no server-rendered hydration | **Yes** |
| **(2) Add `allow-forms`,** and let forms post to the app's own host | Forms submit. Still no cookie, so still no session | A second way for a page to send what a visitor typed, by a plain form. The content Worker takes form bodies | **Yes** |
| **(2b) Allow inline scripts** in the source list | Server-rendered frameworks hydrate | An app's own visitors lose the source list's protection against script injected into that app. **A guess** that it changes nothing between rooms: it isn't the sandbox | **Yes, as far as reasoned. Not shown** |
| **(3) Add `allow-same-origin`** | Everything: cookies, storage, sessions | **Rooms' apps can again read, overwrite and fill each other's domain cookies** (seen in spike C), until the content domain is on the Public Suffix List and browsers have it. The architect has ruled this word out | **No** |
| **(4) Get `podster.site` onto the Public Suffix List, then drop the sandbox** | Everything, with each app's host its own site | Not Podster's to grant. ADR 0010 records that the list's maintainers say they generally decline small projects. After a listing, each browser picks it up on its own schedule. **How long, and the listing's requirements, weren't re-read for this document.** Until then, the sandbox holds | **Yes, once browsers have it** |
| **(5) An app on a registrable domain of its own:** a custom hostname the room's owner brings (step 8), or a domain Podster buys for each app | Everything, on that hostname only | A domain's yearly price for each app, if Podster buys it. On a room's own domain, none to Podster | **Yes:** a cookie there is no other room's |

**Which combinations are safe:**

- **(1), (1) with (2), and (1) with (2) and (2b)** keep rooms apart with what Podster controls today. None gives an app a session.
- **(5) is the only way to a session that is safe today:** strict sandbox on every `*.podster.site` host, and no sandbox on a room's own custom domain, where it can harm no other room. A session then works only for an app on its own domain. It rests on step 8, custom domains, which isn't built.
- **(4) is the general answer and isn't in Podster's hands.**
- **(3) before (4) is not safe,** and nothing here proposes it.

**Proposed:** stage 1 changes nothing. Stage 2 is the owner choosing among (2), (2b) and (5), with (4) started if they want sessions on `podster.site` itself.

## 3. Stage 1 in full: one todo app

### 3.1 What it is made of

- **A Worker entry,** JavaScript modules, that answers a small JSON API: list, add, change, remove.
- **Static files** for the page: the framework's built output.
- **One store** (KV or D1, to be chosen by a spike), bound to the Worker under a name Podster fixes.
- **A manifest** of a fixed name at the release directory's root, naming the entry module and saying the app wants a store. It is agent content, so it is data: Podster reads those fields, checks them against the tree, and takes nothing else.

**Cloudflare's templates, the todo list on KV:** it is Remix on Vite, built to a Worker and a directory of client files, with one KV binding; it keeps the whole list as one JSON value under one key, read once for a view and read and written once for a change. *As read, every write also sets a five-minute expiry, so its list empties itself; and two writes at once overwrite each other.* **What Podster takes as an idea:** one namespace, one value, is enough for a demo. **What it can't take:** the app as written renders on the server.

### 3.2 How its code is uploaded

**Cloudflare's documentation:** a user Worker is uploaded with one multipart request, a JSON `metadata` part and one part for each module; `main_module` is required; JavaScript modules have the type `application/javascript+module` ([multipart upload metadata](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/), [API examples](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/platform-examples/)). Static files go up first through an upload session, and the script's upload names it ([static assets](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/static-assets/)). A matching static file is served before the script runs, unless the upload says otherwise ([routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)).

**Proposed:** Podster writes the metadata itself, all of it. The entry module from the manifest, once it is a file in the tree of an allowed kind. A compatibility date Podster fixes. **Bindings: the app's one store and nothing else.** No `assets.config`, no migrations, no schedule, no route. The marker stays a static file Podster adds, served before the app's script can answer for it; that order is from the documentation and **must be seen in a spike.**

### 3.3 Its store

**Cloudflare's documentation:** a KV namespace is made through the API and attached in the upload's metadata as a binding of type `kv_namespace`, with a name and the namespace's ID; a user Worker reaches only the bindings attached to it ([bindings](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/)). A value is at most 25 MiB, a key 512 bytes, and one key takes one write a second ([KV limits](https://developers.cloudflare.com/kv/platform/limits/)). Prices are in the summary's table ([KV pricing](https://developers.cloudflare.com/kv/platform/pricing/)).

| Question | Proposed |
| --- | --- |
| **How the app asks for it** | One word in the manifest: that it wants a store. No name, no ID, no size |
| **Who makes it, and where** | Podster's release job, in the second account, the first time a release that asks for one is approved and its recheck holds. The room records the namespace's ID as its own state. **That is a room schema step,** the first this revision needs |
| **How it is bound** | In the metadata Podster writes, under one fixed binding name, the same in every app. The app's code sees a binding and never an ID or a token |
| **Isolation** | One namespace for one room's app, never shared and never reused. No other script is ever bound to it. The serve entries' own namespace is never bound to any app |
| **A new release** | Each release is a new script, bound to the same namespace: the data stays. Whether new code can read old data is the app's own matter. **A rollback meets data the newer release wrote** |
| **Suspension, and an unpublish** | The data is kept. No script runs, so nothing reads or changes it |
| **An operator's takedown of content** | **A new operator command deletes an app's store,** since a suspension alone leaves what strangers wrote. Confirmed by Cloudflare's own answer, as a script's deletion is |
| **The room deleted, or its app's label retired** | The namespace is deleted by a job like the script-delete job, and the hourly reconcile lists namespaces and reports any no room claims |
| **A cap** | **Open, and it matters: [the summary's row 4](#stage-1-one-todo-app).** KV has no quota for one namespace on the pages read. *From this document's review, not re-read here: a KV operation counts as a subrequest, and one invocation may make 1,000.* So the subrequest limit the content Worker sets bounds the writes of one request. Nothing bounds how many requests an app gets, and any website can send them. **What is needed is a budget of write requests for each app,** which isn't designed: the content Worker keeps no count today |

**One thing that may change the choice of store, and needs spike B's answer first.** Cloudflare's token permissions name KV as one thing for the account. The token that makes an app's namespace may then also be able to write the serve entries, which live in KV in the same account, and ADR 0010 keeps the token that uploads scripts from doing exactly that. **Whether a token can be held to some namespaces and not others: not found.** If it can't, the safer store is **D1,** one small database for each app, whose permission is its own. D1's prices and limits weren't read. **KV is proposed as the cheapest form, on condition of that answer.**

### 3.4 Requests that change data

The content Worker today passes `GET` and `HEAD`, forwards `Accept`, `If-None-Match` and `If-Modified-Since`, and sends no body.

**Proposed, for an app whose serve entry says it has code:**

- **Methods:** also `POST`, `PUT`, `PATCH` and `DELETE`. A static app keeps `GET` and `HEAD`.
- **A body,** passed as it arrives, up to a cap. **A guess** at the cap: 64 KiB.
- **Request headers:** also `Content-Type` and `Content-Length`. **Still refused:** `Cookie`, `Authorization`, and everything else.
- **`OPTIONS` is answered by the content Worker itself and never reaches the app** ([below](#35-under-the-sandbox-as-it-stands)). **It allows the write methods only for a host whose release has code.** For a static app it allows `GET` and `HEAD`, as now.
- **Still refused:** a WebSocket; a request for a service-worker script; any method not named.
- **Response headers stay an allow-list, and `Set-Cookie` still never passes.** `no-transform` stays. **`Cache-Control` needs a rule it doesn't have:** today every answer an app gives carries the same 60 seconds, and the content Worker can't tell a static file's answer from a script's. Proposed: every answer of an app with code carries `no-store`, the simplest rule that is never wrong, at the cost of a static file being fetched each time.
- **An app that throws, or passes a limit,** gets the content Worker's own error, with nothing of the app's message in it.

### 3.5 Under the sandbox as it stands

**Can a todo app work under `sandbox allow-scripts` with no login? On paper yes, if it is written for it, and with no change to the sandbox. Not shown.**

- **The page's origin is `null`,** so its `fetch` to its own host is a request to another origin. **In the browser report,** a `fetch` of its own JSON works, because each answer allows any origin.
- **A `POST` with a JSON body is not a simple request,** so the browser first sends an `OPTIONS` request asking leave, with `Origin: null`. The content Worker must answer it: allow any origin, the methods above, and the `Content-Type` header. Then the `POST` goes. The policy's `connect-src` already names the app's host.
- **Is allowing any origin safe?** Every sandboxed page has the origin `null`, so no narrower answer can tell one app's page from another's or from any page anywhere. **Any page on the internet can then call any app's API.** With no cookie and no credential on the content domain, that gives a page nothing a person with a command line doesn't already have. **What it means for a todo list with no login is exactly this: anyone who knows the address can read and change the list.**
- **An HTML form doesn't submit,** so the page sends changes by script. Whether a form's own submit handler still runs under the sandbox wasn't shown; the app should use buttons.
- **`history.pushState` fails in WebKit,** so the app is one view with no client-side routes.
- **An inline `<script>` doesn't run,** so the page can't be rendered on the server by a framework that inlines its hydration data. It is rendered in the browser from its own script files.

**So a todo demo must avoid:** forms, client-side routes, inline scripts, and anything kept in the browser. That rules out Remix, Next and React Router as they build by default, and fits a client-rendered page from Vite with React, Vue or Svelte.

**The spike has run: [the report](../m6-sandbox-api-report.md), 2026-11-13.** In Chromium, Firefox and WebKit, a page whose origin is `null` read and changed a list on its own host with `GET`, `POST`, `PUT` and `DELETE` and a JSON body, when the API allowed any origin or the origin `null` and answered the preflight. **So a todo app can work under `sandbox allow-scripts` as it stands, with no change to the sandbox.** A form's submit handler and navigation by the address's fragment are still not shown.

#### What the spike means for the design

**Proposed, for the owner's question 5, the content Worker taking writes for a host whose release has code.** The report recommends nothing; this is this document's reading of it.

**(a) A write must be JSON, and a simple cross-site write is refused.** *Seen:* a plain-text `POST` reached the API and changed the list from every page elsewhere, however the API answered, even with no cross-origin header at all. A browser sends it without asking leave, and the headers only decide whether the page may read the answer. *So:* before it dispatches, the content Worker refuses any `POST`, `PUT`, `PATCH` or `DELETE` whose `Content-Type` isn't `application/json`. A JSON body is what makes a browser ask leave first, so every write a browser sends has passed a preflight the content Worker answered. The app's code never sees a write that didn't.

**(b) The answer allows the origin `null`, not any origin.** *Seen:* with `null`, an ordinary page on another site could read nothing and its JSON writes never reached the API, while the app's own sandboxed page did everything. *So:* the content Worker answers `Access-Control-Allow-Origin: null` for an app with code. **The residual, said plainly: every sandboxed page anywhere has the origin `null`,** and the sandboxed page on another domain did everything the app's own page did. Any site can put the same calls in a sandboxed frame or page of its own. `null` keeps out a page that hasn't bothered to; it is no boundary. *Today's answers to static files allow any origin, which the first browser run needed for an app's own scripts and data; whether those change too is open.*

**(c) The preflight is answered only for a host whose release has code,** and only for the write methods and the `Content-Type` header. For a static app the content Worker answers as now.

**What an outsider can still do to a todo app with no login, under (a), (b) and (c):**

- **Read and change the list from a command line, or from any program that isn't a browser.** No cross-origin rule applies to it. This needs only the address.
- **Read and change the list from any web page that sandboxes itself,** and so make every visitor of that page do it, from each visitor's own address. This is why a limit for each address won't hold a write budget, and why the budget is for the app ([the summary's 4a](#stage-1-one-todo-app)).
- **Not possible:** a write from an ordinary page on another site, or from a form on one; a read by one. **Not relevant:** a cookie, since none exists and none was sent even when the API offered one.

**So (a), (b) and (c) narrow who can write by accident or with no effort, and change nothing about who can write on purpose.** With no login the list is public to read and to change. That is the owner's question 2, unchanged.

**Still to show, in the same local run:** a submit handler on a form, and navigation by the address's fragment. And, once the content Worker's own changes are written, the same calls through the real handler and not a test API.

### 3.6 Limits and outbound

- **Outbound: refused.** A todo app needs none. An outbound Worker of Podster's answers every `fetch` with a refusal, and with one set the app can't open sockets ([section 6](#6-what-an-apps-code-may-reach)).
- **Limits on each request,** CPU time and subrequests, set by the content Worker ([custom limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/custom-limits/)). The figures wait for a spike.
- **The namespace stays untrusted.**

### 3.7 What stage 1 makes possible that static files didn't

**Said plainly.** An app with a store and a public API can keep what a visitor types and give it to whoever asks. A page that imitates a sign-in could store passwords in its own namespace, and its author could read them back through the app's own API, with no outbound request at all. Refusing outbound doesn't stop that; storage is what opens it.

What stands against it is what M6 already has: only reviewed, merged code that a person approved, in a public room; a report that names an app; an operator's suspension and the stop; and, new, an operator's deletion of an app's data. None prevents it. **It is a consequence the owner accepts with storage.**

### 3.8 The build, for this one case

**Proposed: the demo's built files are committed to the repository and reviewed like any other change. Podster builds nothing.**

- **What it costs:** a reviewer approves a bundle they can't read line by line, and **nobody checks it matches the source beside it. So approval rests on trusting the bundle's author,** which is an agent.
- **What it keeps:** what is served is byte for byte what was reviewed and merged, and no agent-written script runs on Podster's bill.
- **The alternative** is the cheapest safe build path, a sandbox Podster starts ([section 5](#5-building)): a new billed resource, a spike, and the owner's acceptance of a change of stance, all before one todo app.

## 4. Cloudflare's templates, as references

**Nothing is copied from any of them.**

### The worker publisher

**What it is:** a Worker that takes a script's name and one JavaScript module as text, uploads it to a dispatch namespace through Cloudflare's SDK with a `main_module` and one file, and serves each uploaded script at a path named after it.

- **What it confirms:** the upload call and the shape of a code upload. It is the same API the release job's upload would use.
- **What it doesn't do, that Podster must:**

| The template | Podster |
| --- | --- |
| Builds nothing: the code must already be a runnable module | The same in stage 1; a build path in stage 3 |
| Anyone who can reach its form publishes; a switch makes it read-only | Only a reviewed, merged commit, approved by a person who may, rechecked on every pass |
| Takes whatever text it is sent | The exact merged commit, read by Podster from the repository |
| Uploading the same name again replaces the script | One script for each release, named by Rust; the live one is never overwritten. *From this document's review, not re-read here: user Workers have no versions and no gradual rollout, so an upload to a name replaces it for every request at once. A script for each release is what makes a rollback possible at all* |
| Routes by the first part of the path | A host for each app, by a serve entry only the room's applier writes |
| Holds a token with Workers edit, in the same account as itself | The publishing token in a second account, so it can't reach Podster's own Workers |
| No limits, no outbound Worker, no delete | Limits on each request, outbound refused, takedown confirmed by Cloudflare's answer |

- **How a larger upload differs from its one file,** from Cloudflare's documentation: several modules are several parts of the same request, each under its own name, with `main_module` naming the entry. **Python** modules have the type `text/x-python` and need the `python_workers` flag ([infrastructure as code](https://developers.cloudflare.com/workers/platform/infrastructure-as-code/)); that page's example is an ordinary Worker, and whether the namespace's endpoint takes it the same way was **not found.** **Wasm: unverified.** The one page read that says Wasm modules load with no build step is about the Worker Loader ([Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/getting-started/)), a different product, not Workers for Platforms. That the namespace's upload takes a compiled module, and the part's type for one, are **a guess.** Static files are a separate upload session before the script's.

### The website builder, `workers-for-platforms-template`

**The closest to M6's shape:** static sites and Worker code, each site its own script in a dispatch namespace, a platform Worker in front that routes by subdomain or custom hostname, and D1 for the list of projects.

| | The template | ADR 0010, and step 8 |
| --- | --- | --- |
| **Static files with code** | The upload session in three calls, then a script upload naming it, with a small pass-through script and an assets binding | The same three calls. Spike A saw a release may be assets only, with no script. With code, the app's own script takes the place of the pass-through |
| **Naming** | One script for a site, named after its subdomain; a second publish of that name is refused | One script for each release, named from a random label and the release's ID |
| **Which script a host gets** | A row in D1, read on every request | A serve entry in KV, written only by the room's applier; D1 never decides |
| **A script that isn't there** | Any error from the dispatch makes it upload the stored script again and retry | Only "Worker not found" is not-found; anything else serves nothing. The content Worker never uploads |
| **Custom hostnames** | Cloudflare for SaaS's custom hostname call, with certificate validation over HTTP; the customer points a CNAME at a fallback origin | The same product. **Step 8 adds what the template leaves out:** Podster's own room-bound TXT challenge, checked before a claim exists and before any hostname is made at Cloudflare |
| **When a hostname routes** | As soon as its row is saved. The call's answer isn't read, and the hostname's status isn't checked | Not before the hostname is `active` and the room's claim agrees |
| **Removing** | No route deletes a site or a hostname | Unpublish, suspension, the stop; a claim that ends removes the serve entry first |
| **Who may publish** | Anyone who reaches the form | A person who may, of reviewed and merged code |
| **Limits, outbound, sandbox, second account** | None | All four |

**What Podster takes as an idea:** the three-call upload with a script, which is how a framework app's built files and its Worker go up together; and the fallback origin for a customer's CNAME, which step 8 needs. **What it shows by omission:** a hostname routed on a CNAME alone serves one party's content on a name another may own, which is the takeover ADR 0010's first review blocked on.

### The containers template, and the builds-notifications template

- **Containers:** a container is started by a class that extends a Durable Object, here with outbound internet off, and requests are passed to a port inside it. Copying files in or out: **not found** in its README. **For [the build options](#5-building):** it shows the shape a sandboxed build would have, and that the network can be off.
- **Builds notifications:** Workers Builds' results arrive as events on a queue, and reading them takes two read permissions. **For the build options:** if Workers Builds were ever used, its outcome is watched this way and not by polling. It doesn't change why Workers Builds doesn't fit.

## 5. Building

**The target, a full framework app, needs a build: it is required, not optional.** Stage 1 avoids one only because one demo's output can be committed. This section is stage 3.

### What needs a build

**Without one:** JavaScript modules and Python source; and an already-compiled Wasm module, **unverified for Workers for Platforms.** **With one:** TypeScript; Rust source; anything that imports npm packages, which is every framework; and, **a guess,** a Python Worker with third-party packages ([Python Workers](https://developers.cloudflare.com/workers/languages/python/)). A Worker is at most 64 MiB uncompressed on the pages read ([limits](https://developers.cloudflare.com/workers/platform/limits/)).

### The four ways

Each is measured against Podster's own rules: a merge never implies a release; a release is of the exact commit Podster merged and a person approved; the credential that publishes is held only by the release job.

| | 1. Workers Builds | 2. A pipeline as in Cloudflare's Artifacts guide | 3. A sandbox Podster starts | 4. No build |
| --- | --- | --- | --- | --- |
| **What it is** | Cloudflare connects a Worker to a GitHub repository and runs a build command and a deploy command | A Workflow whose steps each run a shell command in an isolated sandbox, the last running `wrangler deploy` to a dispatch namespace | Podster's release job starts a container with the commit's files, runs the build there, and reads the output back | The merged commit already holds runnable modules |
| **Does the publishing credential sit where agent-written scripts run?** | **Yes, as far as the pages say.** A token is made by default with Workers Scripts edit, KV edit and R2 edit for the account, and Workers Routes edit for every zone. A narrower one may be given. Whether the build command sees it: **not found.** The deploy command runs in the same environment, on the repository's own dependencies | **In the deploy step, yes.** The guide lists "Restrict API token access to the deployment step", and shows it only as credentials given to that runner. That the build steps hold none: **not found** | **No, if built as proposed:** the container is given files and nothing else. Podster uploads the output itself | **No** |
| **Can the build reach the network?** | **Not found** | **Not found** | **Podster decides:** off, or each request passed to a handler of Podster's | There is no build |
| **What could it leak?** | The token, if it can see it; the repository | The repository; the credential, if a build step can reach it | The repository, through whatever hosts Podster allows, a package registry for one | Nothing |
| **Tied to the exact merged commit?** | **No.** It builds a branch on push. A deploy hook starts a build for a branch; naming a commit: **not found** | It builds what was pushed to an Artifacts repository. **GitHub isn't mentioned** | **Yes for the input:** the job already reads the tree at the exact commit | **Yes, wholly** |
| **Does a merge imply a release?** | **Yes by default.** It can be set to upload a version without deploying; the build still runs on every push | Yes as written, on push | No | No |
| **One script for each release?** | **No.** One connection for one Worker, whose name must match its configuration. Deploying to a dispatch namespace: **not found** | Possible | Yes, unchanged | Yes, unchanged |
| **What it needs on the repositories** | Cloudflare's "Workers & Pages" GitHub App on the organization, which [ADR 0009](0009-managed-repositories.md) doesn't allow for. Its permissions: **not found** | The code in a Cloudflare Artifacts repository | Nothing new | Nothing new |
| **Cost, and is it new?** | Build minutes: 6,000 a month on a paid plan, then $0.005 a minute; a build may run 20 minutes. **New** | Workflows and containers. **New.** Prices not read | Containers, on Workers Paid. **New.** Prices not read | **None** |
| **Languages** | Whatever its image builds | Whatever the image builds | Whatever the image Podster makes builds | JavaScript modules, Python source, prebuilt Wasm |

Sources: [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/), [its configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), [deploy hooks](https://developers.cloudflare.com/workers/ci-cd/builds/deploy-hooks/), [the GitHub integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/), [limits and pricing](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/), [build and deploy Artifacts repos](https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/), [Sandbox](https://developers.cloudflare.com/sandbox/), [containers' outbound traffic](https://developers.cloudflare.com/containers/configuration/outbound-traffic/).

- **Workers Builds doesn't fit as it is.** It builds and deploys in one place, on a push, from a branch, with a credential that by default can edit every Worker in the account, for one Worker per connection. Each is against a rule Podster already has.
- **The Artifacts guide's pipeline is option 3 with Cloudflare's wrapper,** for code in Cloudflare's own repositories. Its deploy step is the part Podster must not use.
- **Recommended for stage 3: a sandbox Podster starts.** It is the only one that can keep the credential out of the build, name the exact commit, and leave the upload to Rust. Its output is a set of files Podster checks and uploads exactly as it does a commit's own files, which is what stage 1 builds.

### A build is a change of stance, and it is the owner's

**Said plainly:** under options 1 to 3, code an agent wrote, its build scripts and whatever its dependencies run at install, executes on infrastructure Podster pays for, before anyone but a reviewer has looked at it. A sandbox limits what it can reach; it doesn't change that Podster is running it. [CLAUDE.md](../../CLAUDE.md) says "Agents own execution, and Podster never hosts or runs them".

- **The app itself running in the namespace is already code an agent wrote, running on a server Podster pays for.** The owner's words make an app a Worker; whether that is rightly said as "Podster hosts what a room published, and still runs no agent" is [the summary's question 10](#stage-1-one-todo-app), and is the owner's to answer.
- **A build adds a second place,** with a different risk: a toolchain, for minutes, on files and possibly a network.
- **With no build, the build still happens: on the agent's own machine,** which is where the product already says execution belongs.

**What needs a spike before anyone relies on a sandboxed build (spike I, new):** that a container starts with no credential and no binding; that its network is off, or reaches only named hosts; that files can be put in and read out by the Worker that started it (**not found**); how long a framework's build takes and what it costs; and what happens at its time and memory limits.

## 6. What an app's code may reach

**Cloudflare's documentation, and what spike A saw:**

- **A namespace is untrusted by default:** no `request.cf`, a cache of its own for each Worker ([Worker isolation](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/worker-isolation/)). **It stays untrusted.**
- **Custom limits** on CPU time and subrequests are set by the dispatch Worker for each invocation; one that passes either throws at once. Cloudflare's pricing page recommends them against runaway bills ([pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/)).
- **An outbound Worker** is called for every `fetch()` a user Worker makes, and with one set the user Worker can't open TCP sockets ([outbound Workers](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/)). **Seen in spike A:** with none, a script's `fetch()` and a socket both reached the public internet; with one, every `fetch()` went to it and sockets stopped.

- **An outbound Worker does not see a `fetch` made from a Durable Object,** nor one made through a certificate binding. ADR 0010 records that from the same page.

**Proposed, for every app with code:** no secret, ever; no binding but what a stage allows; limits on every invocation; an outbound Worker always; and no way in but the content Worker's dispatch for a host with a serve entry.

**"An outbound Worker always" is true only while no app has a Durable Object.** Once one is bound, code in it reaches the internet past the outbound Worker. **So: no Durable Object binding for any app until that is solved,** and nothing here proposes how.

| Outbound | What an app can do | Abuse it opens | Whose |
| --- | --- | --- | --- |
| **(a) Refuse everything** | Compute, answer, use its own store | The least | **Proposed for stages 1 to 3** |
| **(b) A short list of hosts for each room,** set by a person who is its owner or an admin, HTTPS only | Call the APIs that room named | Whatever an app collects can be sent to a named host; a host that is itself open, a paste site or a webhook catcher, is an exit for anything | **The owner's,** stage 4 |
| **(c) The public internet,** logged by ID, rate limited, private addresses refused | Anything a server can | A proxy for scanning and credential stuffing under Podster's account; spam through HTTP mail APIs; abuse reports that name Podster | **The owner's,** and not recommended |

**The outbound Worker** is a new Worker of Podster's in the second account, with no binding to anything of Podster's.

**More kinds of storage, stage 4.** D1 and R2 each attach as a binding in the same metadata, and each is a new billed resource with its own caps, its own deletion at a takedown, and its own place in the reconcile. **Durable Objects are not offered:** they get past the outbound Worker, as above, and they need a migration in the upload, which lets an app's code run without a request, on an alarm, a second way in.

## 7. What changes, by file

**Each row names what is built today, so the size of the change is plain.**

| Where | Today | Proposed, and at which stage |
| --- | --- | --- |
| `crates/core/src/release_tree.rs` | The directory is fixed as `site`. Every file in it is a file to serve. `_worker.js` is refused by name | **1:** the manifest's rules; which files are modules; that the entry is one of them; caps on modules. **Modules and the manifest are never served as files:** they are uploaded as the script and left out of the static files. The static-file rules stand for the rest. Whether the directory keeps the name `site` is open |
| `crates/core/src/release.rs` | Caps on a release; the read budget | **1:** the limits on each request, the store's caps and the write budget, as constants core owns |
| **The serve entry,** in four places: `apps/content/src/names.ts`, `apps/api/src/content_provider.rs` (`write_entry`, `read_entry`), the reconcile's `Entry::Present`, and `packages/contracts/serve-entry.fixture.json` | A bare script name, and nothing else | **1: a marker that the script has code,** so the content Worker knows which methods to take. The fixture is in the contracts package and three readers share it: **this is a contract change,** alone in its turn |
| The room's state, `apps/api/src/store.rs` | A release's rows and the serve state | **1: a room schema step,** for the app's store: its ID, and when it is owed a deletion. Shown on a room made before it, in the staging run's two phases |
| The `Moderation` object's state, `apps/api/src/reconcile.rs` | Its tables check `pass` and `kind` against the two reconciles there are | **1: a schema step there too,** for a reconcile of stores, with the same two-phase check |
| The release job, **not built** | Reads two trees, checks, fetches, uploads assets | **1:** makes the store on first need; uploads modules with metadata Podster writes and the store's binding. **3:** a build between the fetch and the check |
| `apps/content/src/handle.ts` | `GET` and `HEAD`; three request headers; a response allow-list; `no-transform`; `Set-Cookie` dropped; **`form-action 'none'` in the policy; one `max-age=60` for every answer of an app, with no way to tell a static file's answer from a script's** | **1:** limits and the outbound Worker on every dispatch; more methods and a body for a host whose entry says code; its own answer to `OPTIONS`; its own error when an app throws; `no-store` for an app with code; the write budget. **2:** whatever the owner chooses of forms, which changes `form-action`, of inline scripts, and of cookies on a room's own domain |
| `apps/content/wrangler.jsonc` and its tests | A namespace binding and a KV binding | **1:** the namespace binding names the outbound Worker; the deploy guard covers it. Whatever the write budget counts in is one more binding |
| The sandbox's word list | `sandbox allow-scripts` | **1: unchanged. 2:** the owner's |
| Takedown and the reconciles | A script holds files | **1:** a script is code, and an app has data. The mechanism stands. New: the store's deletion, the two commands for it, and the reconcile reporting any store no room claims and any script with a binding it shouldn't have |
| The contract, `packages/contracts/openapi.yaml` | `Release` is described as a copy of one fixed directory. Operators' routes for suspension, the stop and reports | **1:** the description; the serve entry's fixture; a route for an operator, and one for a room's owner or admin, to delete an app's data. Each alone in its turn |
| The screens, `apps/web` (step 10) | The switch-on confirmation says a release is a copy of one fixed directory. **Nothing tells a person who approves a release what it holds** | **1: the approval says, before the person confirms, that this release runs code on a server and has a store anyone can write to.** The switch-on confirmation says the same of what the room may now publish. The room's page says the list is public |
| Reports and the security review | A page that is bad to look at | **1:** also an app that keeps what visitors type. The threat model gains [section 3.7](#37-what-stage-1-makes-possible-that-static-files-didnt) |
| Spikes | D and G not run; B answered for scripts | **B, again:** whether a credential can make an app's store without being able to write serve entries. **G:** adds whether a module upload fits the job's memory. **H, new:** an app with code and a store in the namespace: what it reaches, how a limit shows, the marker before the script, what a request costs, how a write budget can be counted. **The browser spike** of section 3.5. **I:** the build's, for stage 3 |

## 8. What does not change

- **The room is the only writer of serve state,** and its applier the only writer of a serve entry.
- **The recheck, on every pass,** and everything it reads. *On `main`.*
- **Starting an upload and committing live.** None of it looks at what a release contains. *On `main` since 2026-11-13.*
- **Takedown:** suspension, the stop, unpublishing, the epoch.
- **One script for each release, named by Rust.**
- **The second Cloudflare account,** and the deploy guard.
- **Only a public room releases; one environment; no preview.**
- **The gate on the release path,** the constant `RELEASE_PATH_COMPLETE`, which stays false until its list is true. *On `main` since 2026-11-13.*
- **The unpublish triggers and the release switches** step 6 has built since.

## 9. The build order, revised

**Proposed.** Steps 1 to 4 and 9 are built and stand, and so are the room's half of step 5 and the first parts of step 6. **Step 5's tree read and upload are held** until this proposal is accepted or refused. *2026-11-13: with stage 1 decided, the order for stage 1 itself is [in the plan](../m6-plan.md#stage-1-of-apps-as-workers-the-build-order), spike first. The table below is the fuller order this document first proposed, and stands beside it.*

| Order | What | Why here |
| --- | --- | --- |
| 1 | **The browser spike** of section 3.5 | Needs no resource. It says whether stage 1 is possible without touching the sandbox |
| 2 | **Spike B again, and spike H** | They decide KV or D1, and the limits' figures. They need what spikes A and B needed |
| 3 | **Core, again (step 3):** the manifest, modules, the limits, the store's caps and the write budget | Pure; reviewable before any spike returns |
| 4 | **The contract and schema steps:** the serve entry's marker; the room's and the `Moderation` object's schema steps; the two routes that delete an app's data; the `Release` description | Each alone in its turn |
| 5 | **The content Worker, again (step 4(b)), and the outbound Worker** | Before anything with code is served |
| 6 | **Step 5's job,** with the module upload and the store | The room's half is built |
| 7 | **Step 6,** triggers and approvals, with the operator's deletion of an app's data | As before, plus one command |
| 8 | **Steps 7, 8 and 10** | 7 and 8 unchanged; step 8 is also what stage 2's safest session rests on. Step 10's screens gain what an approver must be told |
| 9 | **Step 11,** the staging run and the security review | The run gains a todo app: it answers, keeps its list across a release, reaches nothing, is stopped at its limits, and its data is gone after an operator deletes it |
| Later | **Stage 2,** then **stage 3** with spike I, then **stage 4** | Each on the owner's decision |

## 10. What must be true before `RELEASES` is on anywhere

Everything [the gate on the release path](../m6-plan.md#the-gate-on-the-release-path) lists, and for an app with code:

- **The spikes above have run,** and what they saw is in the plan.
- **A write budget for each app is built and set,** and a test shows an app past it is refused by the content Worker and costs no more.
- **The outbound Worker is deployed and refuses,** and a test at the deployment shows an app's `fetch` and socket both fail.
- **Limits are set on every dispatch,** and a test shows an app that spins is stopped.
- **No script has a binding but its own app's store, and none has a Durable Object,** by the reconcile's check.
- **An app's data can be deleted,** by an operator and by the room's owner, and a test shows it gone by Cloudflare's own answer.
- **A person who approves a release is told what it holds.**
- **The owner has answered** stage 1's questions: done on 2026-11-13. **And has named the cap's figure and set the bill's alert,** which are still owed.
- **The security review has covered** the manifest, the limits, the store, the write budget, the outbound Worker and the wider methods.

## The owner's decisions

**They are [the summary](#1-summary-the-decisions-by-stage), and only there:** eleven questions for stage 1, each now answered by the owner as recommended, and one each for stages 2 to 4, not yet put to them.

## Not verified

- **Nothing was run.** Every Cloudflare claim is from a page or a template file read on 2026-11-13.
- **Not found on what was read:** whether the namespace's upload takes Python and Wasm modules as an ordinary Worker's does; a Wasm part's type; whether a Workers Builds build command can see its token; that build's network access; the permissions Cloudflare's GitHub App asks for; whether a deploy hook can name a commit; whether Workers Builds can deploy to a dispatch namespace; that the Artifacts guide's build steps hold no credential; whether files can be read out of a container by the Worker that started it; whether a user Worker's size limit differs; whether a token's KV permission can be held to some namespaces; a quota for one KV namespace; how a count of requests for each app could be kept; whether an outbound Worker's invocations are billed.
- **From this document's review, and not re-read by its author:** that a KV operation counts as a subrequest, 1,000 to an invocation; that user Workers have no versions or gradual rollouts.
- **Guesses, each named above:** that a Wasm module uploads to a namespace at all; a Python app with packages needs a build; the body cap; that inline scripts change nothing between rooms.
- **Not read at all:** D1's, Containers' and Workflows' pricing; the Sandbox SDK's file guide; the Public Suffix List's requirements and timing, beyond what ADR 0010 records; the todo template's route files, so whether it uses forms is from its framework and not from its source; all but four of the templates, whose kinds are from their names.
- **Not shown by any run:** a sandboxed page's `POST` with JSON to its own host; a form's submit handler under the sandbox; an app with a store.

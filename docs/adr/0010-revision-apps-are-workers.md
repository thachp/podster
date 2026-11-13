# ADR 0010, proposed revision: a room's app is a Worker

**Status: Proposed, by the architect's session on 2026-11-13, for the architect's review and then independent reviews. Nothing here is accepted, and no code is written for it.** It proposes how [ADR 0010](0010-release-and-the-content-domain.md) changes now that the owner has said an app is a real Worker and not only static files ([decision 219](../spec/PRODUCT.md#decisions-needed)). ADR 0010 itself is unchanged apart from a dated note pointing here; if this is accepted, its sections are revised then, each with what it said before.

## The owner's words

All on 2026-11-13, in order:

1. "not sure if i mention it . .but the application that get deployed to the worker can any of the programming language that cloudflare worker for platform support", and then "not just html".
2. Asked about a first phase with no build: "don't worker has the ablity to build code?"
3. Of Cloudflare's templates: "looks like it can be done using the worker publisher.. there is an example", and "they got a few good example".
4. Asked whether the first apps are closer to a plain Worker or to a full framework app with a database: "i'm thinking of more a full framework app -".
5. "the firs demot app will most likely be a demo app", and then: "i mean a todo app".

**So the target is a full framework app with a database, and the first thing published is one todo app.** This document is staged that way.

**What this overrides:** [decision 214](../spec/PRODUCT.md#decisions-needed)'s "an app is static files: nothing an agent wrote runs on a server". **What it leaves, proposed:** one environment, `production`; no preview of unmerged code; only a public room releases ([decision 213](../spec/PRODUCT.md#decisions-needed)). **What it puts in question:** the strict sandbox ([decision 216](../spec/PRODUCT.md#decisions-needed)), which the owner confirmed again on 2026-11-13 before saying the fourth line above. That conflict is [section 2](#2-the-sandbox-conflict).

## How to read this

- **Cloudflare's documentation:** read on developers.cloudflare.com on 2026-11-13, said here in this document's own words, and linked. Not run. **"Not found"** means the page read doesn't say.
- **Cloudflare's templates:** read on 2026-11-13 from the main branch of [cloudflare/templates](https://github.com/cloudflare/templates/tree/main), as references. **Nothing is copied from them:** all of Podster's code is written fresh ([CLAUDE.md](../../CLAUDE.md)).
- **Seen in spike A or C,** or **in the browser report:** from [the M6 plan's spike results](../m6-plan.md#the-spikes) and [the sandbox report](../m6-content-sandbox-report.md). One observation each.
- **Proposed:** this document's proposal. **A guess:** not supported by a page or a run, and named as one. **The owner's:** it costs money, changes what Podster answers for, or loosens a security stance.

**Nothing here is verified.** No call was made to Cloudflare or GitHub for it.

## 1. Summary: the decisions, by stage

### Stage 1: one todo app

**What it is, proposed:** a todo app built with a front-end framework as a single page, published from a reviewed, approved, merged commit. It is a small Worker that answers a JSON API, static files for the page, and one key-value store of its own. No login, no outbound access, the sandbox exactly as it stands.

| The owner decides | Why it is theirs | Cost | Recommended |
| --- | --- | --- | --- |
| **A store for the app:** one Workers KV namespace for each app, made and owned by Podster in the second account | A new kind of billed resource, holding data Podster then answers for | Inside KV's included amounts at a demo's size: the first 1,000 namespaces, 10 million reads and 1 million writes a month. Past them, $0.50 a million reads, **$5 a million writes,** $0.10 a namespace. Nothing caps one app's writes | **Yes,** with [the cap](#33-its-store) decided first |
| **That the list is public:** with no login, anyone who has the address can read and change it | It is content strangers can write, served under Podster's name | None in money. A report and a takedown must reach the data too | **Yes for a demo,** said plainly beside the link |
| **That the demo's built files are committed,** and Podster builds nothing | The alternative runs agent-written build scripts on Podster's bill, on a new billed resource | None | **Yes for the demo.** A build path is stage 3 |

**What needs no decision in stage 1:** the sandbox stays as it is; outbound stays refused; no new domain.

**What stage 1 is not:** it does not host Cloudflare's own todo template as written. That one renders on the server and submits forms, and the strict sandbox stops both ([section 3.5](#35-under-the-sandbox-as-it-stands)).

### After stage 1

| Stage | Adds | The owner decides | The gap to "a full framework app" that remains |
| --- | --- | --- | --- |
| **2. Sessions and forms** | A login, cookies, form submission, server-rendered frameworks | **The sandbox, again** ([section 2](#2-the-sandbox-conflict)): this reopens decision 216 | No build; one store; no outbound |
| **3. A build path** | TypeScript, bundlers and framework builds run by Podster | **Whether Podster runs agent-written build scripts,** on a new billed resource ([section 5](#5-building)) | One store; no outbound |
| **4. More to bind and reach** | A database (D1), files (R2), Durable Objects; outbound requests to named hosts | Each kind of resource and its cost; whether data may leave ([section 6](#6-what-an-apps-code-may-reach)) | What Podster chooses never to offer |

### What the templates say people will want

**Cloudflare's templates:** almost every application template is a framework app that needs a build, and most bind storage. Which of them each stage could host:

| Kind of app, by template | Needs | Stage 1 | Stage 2 | Stage 3 | Stage 4 |
| --- | --- | --- | --- | --- | --- |
| A static site or blog (Astro's starter) | A build | If its built files are committed | Yes | **Yes, built by Podster** | Yes |
| A client-rendered single page (Vite and React) | A build | If its built files are committed, and it avoids what the sandbox stops | Yes | Yes | Yes |
| A todo list on KV (Remix) | A build, KV, server rendering, forms | **Only rewritten** as a single page | **Yes, with committed output** | Yes | Yes |
| A server-rendered framework app (Next, Remix, React Router) | A build, inline scripts, forms, usually cookies | No | With committed output | **Yes** | Yes |
| An app on a SQL database (the D1 templates) | D1 | No | No | No | **Yes** |
| A chat on Durable Objects | Durable Objects, WebSockets | No | No | No | If the owner allows both |
| An app on an outside database (Hyperdrive) or an AI model | Outbound, or a paid binding | No | No | No | The owner's, each |

*The template list is from the repository's folder names; for all but the four read in full, the framework and bindings are inferred from the name.*

**So "any language Workers for Platforms supports" and "a full framework app" are reached at stage 3 and stage 4, not stage 1.** Each widening is one of three things: a build path, storage for each app, or outbound access.

## 2. The sandbox conflict

**Stated first among the consequences, because it decides what a framework app can be.**

Decision 216, as the owner confirmed it, gives every app `sandbox allow-scripts` and a source list naming only its own host. **In the browser report, under that policy:** the page's origin is `null`; cookies and every kind of browser storage are refused; a form submitted to its own host sends nothing; an inline `<script>` doesn't run; `history.pushState` fails in WebKit. A framework app with a database almost always wants a session, forms, and, if it renders on the server, inline scripts.

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
- **One store,** a Workers KV namespace, bound to the Worker under a name Podster fixes.
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
| **A cap** | **Open, and it matters.** KV has no quota for one namespace on the pages read. An app's own code decides how often it writes, and a write past the included million is the dearest thing here. What Podster can hold is requests: [limits on each request](#36-limits-and-outbound) and a limit on requests to one app, which isn't designed. **A spike should show** whether a KV write counts against the subrequest limit the content Worker sets |

**One thing that may change the choice of store, and needs spike B's answer first.** Cloudflare's token permissions name KV as one thing for the account. The token that makes an app's namespace may then also be able to write the serve entries, which live in KV in the same account, and ADR 0010 keeps the token that uploads scripts from doing exactly that. **Whether a token can be held to some namespaces and not others: not found.** If it can't, the safer store is **D1,** one small database for each app, whose permission is its own. D1's prices and limits weren't read. **KV is proposed as the cheapest form, on condition of that answer.**

### 3.4 Requests that change data

The content Worker today passes `GET` and `HEAD`, forwards `Accept`, `If-None-Match` and `If-Modified-Since`, and sends no body.

**Proposed, for an app whose serve entry says it has code:**

- **Methods:** also `POST`, `PUT`, `PATCH` and `DELETE`. A static app keeps `GET` and `HEAD`.
- **A body,** passed as it arrives, up to a cap. **A guess** at the cap: 64 KiB.
- **Request headers:** also `Content-Type` and `Content-Length`. **Still refused:** `Cookie`, `Authorization`, and everything else.
- **`OPTIONS` is answered by the content Worker itself and never reaches the app** ([below](#35-under-the-sandbox-as-it-stands)).
- **Still refused:** a WebSocket; a request for a service-worker script; any method not named.
- **Response headers stay an allow-list, and `Set-Cookie` still never passes.** `no-transform` stays. An app's answers carry `Cache-Control: no-store` in place of 60 seconds, since an answer may differ each time.
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

**A spike settles it, proposed:** in the existing browser run, `e2e/content-sandbox.mjs`, in the three browsers: a `POST` with a JSON body from the sandboxed page to its own host through the handler, with the preflight; a submit handler on a form; and navigation by the address's fragment. It needs no deployment.

### 3.6 Limits and outbound

- **Outbound: refused.** A todo app needs none. An outbound Worker of Podster's answers every `fetch` with a refusal, and with one set the app can't open sockets ([section 6](#6-what-an-apps-code-may-reach)).
- **Limits on each request,** CPU time and subrequests, set by the content Worker ([custom limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/custom-limits/)). The figures wait for a spike.
- **The namespace stays untrusted.**

### 3.7 What stage 1 makes possible that static files didn't

**Said plainly.** An app with a store and a public API can keep what a visitor types and give it to whoever asks. A page that imitates a sign-in could store passwords in its own namespace, and its author could read them back through the app's own API, with no outbound request at all. Refusing outbound doesn't stop that; storage is what opens it.

What stands against it is what M6 already has: only reviewed, merged code that a person approved, in a public room; a report that names an app; an operator's suspension and the stop; and, new, an operator's deletion of an app's data. None prevents it. **It is a consequence the owner accepts with storage.**

### 3.8 The build, for this one case

**Proposed: the demo's built files are committed to the repository and reviewed like any other change. Podster builds nothing.**

- **What it costs:** a reviewer approves a bundle they can't read line by line, and nobody checks it matches the source beside it.
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
| Uploading the same name again replaces the script | One script for each release, named by Rust; the live one is never overwritten |
| Routes by the first part of the path | A host for each app, by a serve entry only the room's applier writes |
| Holds a token with Workers edit, in the same account as itself | The publishing token in a second account, so it can't reach Podster's own Workers |
| No limits, no outbound Worker, no delete | Limits on each request, outbound refused, takedown confirmed by Cloudflare's answer |

- **How a larger upload differs from its one file,** from Cloudflare's documentation: several modules are several parts of the same request, each under its own name, with `main_module` naming the entry. **Python** modules have the type `text/x-python` and need the `python_workers` flag ([infrastructure as code](https://developers.cloudflare.com/workers/platform/infrastructure-as-code/)); that page's example is an ordinary Worker, and whether the namespace's endpoint takes it the same way was **not found.** **Wasm** is a supported module kind with no build step on the same runtime ([Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/getting-started/)); the part's type for one, and that the namespace's upload takes it, are **a guess.** Static files are a separate upload session before the script's.

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

**Without one:** JavaScript modules, Python source, an already-compiled Wasm module. **With one:** TypeScript; Rust source; anything that imports npm packages, which is every framework; and, **a guess,** a Python Worker with third-party packages ([Python Workers](https://developers.cloudflare.com/workers/languages/python/)). A Worker is at most 64 MiB uncompressed on the pages read ([limits](https://developers.cloudflare.com/workers/platform/limits/)).

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

- **The app itself running in the namespace is already that change,** and the owner has made it.
- **A build adds a second place,** with a different risk: a toolchain, for minutes, on files and possibly a network.
- **With no build, the build still happens: on the agent's own machine,** which is where the product already says execution belongs.

**What needs a spike before anyone relies on a sandboxed build (spike I, new):** that a container starts with no credential and no binding; that its network is off, or reaches only named hosts; that files can be put in and read out by the Worker that started it (**not found**); how long a framework's build takes and what it costs; and what happens at its time and memory limits.

## 6. What an app's code may reach

**Cloudflare's documentation, and what spike A saw:**

- **A namespace is untrusted by default:** no `request.cf`, a cache of its own for each Worker ([Worker isolation](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/worker-isolation/)). **It stays untrusted.**
- **Custom limits** on CPU time and subrequests are set by the dispatch Worker for each invocation; one that passes either throws at once. Cloudflare's pricing page recommends them against runaway bills ([pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/)).
- **An outbound Worker** is called for every `fetch()` a user Worker makes, and with one set the user Worker can't open TCP sockets ([outbound Workers](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/)). **Seen in spike A:** with none, a script's `fetch()` and a socket both reached the public internet; with one, every `fetch()` went to it and sockets stopped.

**Proposed, for every app with code:** no secret, ever; no binding but what a stage allows; limits on every invocation; an outbound Worker always; and no way in but the content Worker's dispatch for a host with a serve entry.

| Outbound | What an app can do | Abuse it opens | Whose |
| --- | --- | --- | --- |
| **(a) Refuse everything** | Compute, answer, use its own store | The least | **Proposed for stages 1 to 3** |
| **(b) A short list of hosts for each room,** set by a person who is its owner or an admin, HTTPS only | Call the APIs that room named | Whatever an app collects can be sent to a named host; a host that is itself open, a paste site or a webhook catcher, is an exit for anything | **The owner's,** stage 4 |
| **(c) The public internet,** logged by ID, rate limited, private addresses refused | Anything a server can | A proxy for scanning and credential stuffing under Podster's account; spam through HTTP mail APIs; abuse reports that name Podster | **The owner's,** and not recommended |

**The outbound Worker** is a new Worker of Podster's in the second account, with no binding to anything of Podster's.

**More kinds of storage, stage 4.** D1, R2 and Durable Objects each attach as a binding in the same metadata, and each is a new billed resource with its own caps, its own deletion at a takedown, and its own place in the reconcile. Durable Objects also need a migration in the upload, which lets an app's code run without a request, on an alarm: that is a second way in, and needs its own look.

## 7. What changes, by file

| Where | Today | Proposed, and at which stage |
| --- | --- | --- |
| `crates/core/src/release_tree.rs` | The directory's entries are files to serve | **1:** the manifest's rules; which files are modules; that the entry is one of them; caps on modules. The static-file rules stand |
| `crates/core/src/release.rs` | Caps on a release; the read budget | **1:** the limits on each request, and the store's caps, as constants core owns |
| The room's state, `apps/api/src/store.rs` | A release's rows and the serve state | **1: a room schema step,** for the app's store: its ID, and when it is owed a deletion |
| The release job, **not built** | Reads two trees, checks, fetches, uploads assets | **1:** makes the store on first need; uploads modules with metadata Podster writes and the store's binding. **3:** a build between the fetch and the check |
| `apps/content/src/handle.ts` | `GET` and `HEAD`; three request headers; a response allow-list; `no-transform`; `Set-Cookie` dropped | **1:** limits and the outbound Worker on every dispatch; more methods and a body for an app with code; its own answer to `OPTIONS`; its own error when an app throws; `no-store`. **2:** whatever the owner chooses of forms, inline scripts, and cookies on a room's own domain |
| The serve entry | A host and one script's name | **1:** whether the script has code, so the content Worker knows which methods to take |
| `apps/content/wrangler.jsonc` and its tests | A namespace binding and a KV binding | **1:** the namespace binding names the outbound Worker; the deploy guard covers it |
| The sandbox, `apps/content/src/names.ts` | `sandbox allow-scripts`, sources naming the app's host | **1: unchanged. 2:** the owner's |
| Takedown and the reconciles | A script holds files | **1:** a script is code, and an app has data. The mechanism stands. New: the store's deletion, an operator's command for it, and the reconcile reporting any store no room claims and any script with a binding it shouldn't have |
| The contract, `packages/contracts` | Operators' routes for suspension, the stop and reports | **1:** an operator's deletion of an app's data: a route, alone in its turn |
| Reports and the security review | A page that is bad to look at | **1:** also an app that keeps what visitors type. The threat model gains [section 3.7](#37-what-stage-1-makes-possible-that-static-files-didnt) |
| Spikes | D and G not run; B answered for scripts | **B, again:** whether a token can make an app's store without being able to write serve entries. **G:** adds whether a module upload fits the job's memory. **H, new:** an app with code and a store in the namespace: what it reaches, how a limit shows, whether a KV write counts as a subrequest, the marker before the script, what a request costs. **The browser spike** of section 3.5. **I:** the build's, for stage 3 |

## 8. What does not change

- **The room is the only writer of serve state,** and its applier the only writer of a serve entry.
- **The recheck, on every pass,** and everything it reads.
- **Starting an upload and committing live.** None of it looks at what a release contains.
- **Takedown:** suspension, the stop, unpublishing, the epoch.
- **One script for each release, named by Rust.**
- **The second Cloudflare account,** and the deploy guard.
- **Only a public room releases; one environment; no preview.**
- **The gate on the release path,** which stays closed until its list is true.

## 9. The build order, revised

**Proposed.** Steps 1 to 4 and 9 are built and stand, and so does the room's half of step 5.

| Order | What | Why here |
| --- | --- | --- |
| 1 | **The browser spike** of section 3.5 | Needs no resource. It says whether stage 1 is possible without touching the sandbox |
| 2 | **Spike B again, and spike H** | They decide KV or D1, and the limits' figures. They need what spikes A and B needed |
| 3 | **Core, again (step 3):** the manifest, modules, the limits and the store's caps | Pure; reviewable before any spike returns |
| 4 | **The room schema step and the store's commands** | Alone in its turn, as every schema step is |
| 5 | **The content Worker, again (step 4(b)), and the outbound Worker** | Before anything with code is served |
| 6 | **Step 5's job,** with the module upload and the store | The room's half is built |
| 7 | **Step 6,** triggers and approvals, with the operator's deletion of an app's data | As before, plus one command |
| 8 | **Steps 7 and 8** | Unchanged. Step 8 is also what stage 2's safest session rests on |
| 9 | **Step 11,** the staging run and the security review | The run gains a todo app: it answers, keeps its list across a release, reaches nothing, is stopped at its limits, and its data is gone after an operator deletes it |
| Later | **Stage 2,** then **stage 3** with spike I, then **stage 4** | Each on the owner's decision |

## 10. What must be true before `RELEASES` is on anywhere

Everything the gate on the release path lists, and for an app with code:

- **The spikes above have run,** and what they saw is in the plan.
- **The outbound Worker is deployed and refuses,** and a test at the deployment shows an app's `fetch` and socket both fail.
- **Limits are set on every dispatch,** and a test shows an app that spins is stopped.
- **No script has a binding but its own app's store,** by the reconcile's check.
- **An operator can delete an app's data,** and a test shows it gone by Cloudflare's own answer.
- **The owner has answered** stage 1's three questions.
- **The security review has covered** the manifest, the limits, the store, the outbound Worker and the wider methods.

## The owner's decisions, by stage, with costs

| Stage | Decision | Cost | Recommended |
| --- | --- | --- | --- |
| **1** | A KV namespace for each app | Inside included amounts for a demo; then $5 a million writes, $0.50 a million reads, $0.10 a namespace | Yes, once the cap and the token question are answered |
| **1** | The demo's list is public to anyone with the address | None in money | Yes, said beside the link |
| **1** | The demo's built files are committed; Podster builds nothing | None | Yes |
| **2** | The sandbox: forms, inline scripts, and sessions on a room's own domain; whether to apply for the Public Suffix List | None in money, unless Podster buys domains. It reopens decision 216 | Forms and inline scripts yes; sessions only on a room's own domain until a listing |
| **3** | Whether Podster runs builds in a sandbox | Containers' usage, not read; a change of stance | Yes, after spike I |
| **4** | Each further kind of storage; outbound to named hosts | Each a billed resource; outbound is exposure, not money | Each on its own case |

## Not verified

- **Nothing was run.** Every Cloudflare claim is from a page or a template file read on 2026-11-13.
- **Not found on what was read:** whether the namespace's upload takes Python and Wasm modules as an ordinary Worker's does; a Wasm part's type; whether a Workers Builds build command can see its token; that build's network access; the permissions Cloudflare's GitHub App asks for; whether a deploy hook can name a commit; whether Workers Builds can deploy to a dispatch namespace; that the Artifacts guide's build steps hold no credential; whether files can be read out of a container by the Worker that started it; whether a user Worker's size limit differs; whether a token's KV permission can be held to some namespaces; a quota for one KV namespace; whether a KV write counts against the custom subrequest limit.
- **Guesses, each named above:** a Wasm module uploads as elsewhere; a Python app with packages needs a build; the body cap; that inline scripts change nothing between rooms.
- **Not read at all:** D1's, Containers' and Workflows' pricing; the Sandbox SDK's file guide; the Public Suffix List's requirements and timing, beyond what ADR 0010 records; the todo template's route files, so whether it uses forms is from its framework and not from its source; all but four of the templates, whose kinds are from their names.
- **Not shown by any run:** a sandboxed page's `POST` with JSON to its own host; a form's submit handler under the sandbox; an app with a store.

# ADR 0010, proposed revision: a room's app is a Worker

**Status: Proposed, by the architect's session on 2026-11-13, for the architect's review and then independent reviews. Nothing here is accepted, and no code is written for it.** It proposes how [ADR 0010](0010-release-and-the-content-domain.md) changes now that the owner has said an app is a real Worker and not only static files ([decision 219](../spec/PRODUCT.md#decisions-needed)). ADR 0010 itself is unchanged apart from a dated note pointing here; if this is accepted, its sections are revised then, each with what it said before.

## The owner's words

On 2026-11-13 the owner wrote:

> "not sure if i mention it . .but the application that get deployed to the worker can any of the programming language that cloudflare worker for platform support"

and then "not just html". Asked about a first phase with no build, the owner wrote: "don't worker has the ablity to build code?"

**What this overrides:** [decision 214](../spec/PRODUCT.md#decisions-needed)'s "an app is static files: nothing an agent wrote runs on a server", which the architect decided on the owner's behalf on 2026-11-12, for the owner to review. The owner has now reviewed it and said otherwise. **What it leaves, proposed:** one environment, `production`; no preview of unmerged code; only a public room releases ([decision 213](../spec/PRODUCT.md#decisions-needed)); every app sandboxed in the browser ([decision 216](../spec/PRODUCT.md#decisions-needed), which the owner confirmed again as strict on 2026-11-13).

## How to read this

Each claim carries one of these labels, as in ADR 0010:

- **Cloudflare's documentation:** read on developers.cloudflare.com on 2026-11-13, said here in this document's own words, and linked. Not run. **"Not found"** means the page read doesn't say; nothing is guessed in its place.
- **Seen in spike A or C,** or **in the browser report:** from [the M6 plan's spike results](../m6-plan.md#the-spikes) and [the sandbox report](../m6-content-sandbox-report.md). One observation each.
- **Proposed:** this document's proposal.
- **A guess:** not supported by a page or a run. Each is named as one, with the spike that would settle it.
- **The owner's:** a choice that costs money, changes what Podster is responsible for, or loosens a security stance.

**Nothing here is verified.** No call was made to Cloudflare or GitHub for it.

## 1. What a release contains, and whether anything is built

### What the upload API takes as it is

**Cloudflare's documentation:**

- A user Worker is uploaded to a dispatch namespace with one multipart request: a `metadata` part in JSON, and one part for each module. `main_module` is required; bindings, the compatibility date and flags are in the metadata ([multipart upload metadata](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/), [API examples](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/platform-examples/)).
- **JavaScript as ES modules** is uploaded as written, with the part's type `application/javascript+module` (the same pages).
- **Python** is uploaded as written, with the part's type `text/x-python` and the `python_workers` compatibility flag ([infrastructure as code](https://developers.cloudflare.com/workers/platform/infrastructure-as-code/)). That page's Python example is for an ordinary Worker; **whether the dispatch-namespace endpoint takes it the same way: not found,** though the endpoint is described as the same upload.
- **WebAssembly** is a supported module kind, and **there is no build step: TypeScript must be compiled to JavaScript first.** That is said of Dynamic Workers ([getting started](https://developers.cloudflare.com/dynamic-workers/getting-started/)), a different product on the same runtime. **A guess** that the namespace upload takes a compiled `.wasm` module the same way; the part's type for one was **not found** on the pages read.
- **A Worker is at most 64 MiB uncompressed,** with no compressed limit, on the pages read; whether a user Worker in a namespace differs: **not found** ([limits](https://developers.cloudflare.com/workers/platform/limits/)).
- **A Worker with both a script and static assets serves a matching asset first, without running the script,** unless `run_worker_first` is set ([routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)).

**So, without any build:** JavaScript modules, Python source, and an already-compiled Wasm module with the JavaScript that loads it. **What needs a build:** TypeScript; Rust source, which becomes Wasm and a JavaScript shim; anything that imports npm packages and so needs a bundler; and, **a guess,** a Python Worker that uses third-party packages, which Cloudflare's own tool vendors before it deploys ([Python Workers](https://developers.cloudflare.com/workers/languages/python/)).

### The four ways to get from a merged commit to runnable modules

**The owner asked whether Workers can build code. They can, in more than one way.** Each is measured against Podster's own rules: a merge never implies a release; a release is of the exact commit Podster merged and a person approved; the credential that publishes is held only by the release job; agent content is data.

| | 1. Workers Builds | 2. A pipeline as in Cloudflare's Artifacts guide | 3. A sandbox Podster starts | 4. No build |
| --- | --- | --- | --- | --- |
| **What it is** | Cloudflare connects a Worker to a GitHub repository and runs a build command and a deploy command | A Workflow whose steps each run a shell command in an isolated sandbox, the last of which runs `wrangler deploy` to a dispatch namespace | Podster's release job starts a container with the commit's files, runs the build there, and reads the output back | The merged commit already holds runnable modules. Whoever wrote them built them, on their own machine |
| **Does the publishing credential sit where agent-written scripts run?** | **Yes, as far as the pages say.** A token is made for the build by default, with Workers Scripts edit, Workers KV edit and R2 edit for the account, and Workers Routes edit for every zone. A narrower token of one's own may be given. Whether the build command sees it: **not found.** The deploy command runs in the same environment, on the repository's own dependencies | **In the deploy step, yes:** that step runs `wrangler deploy` with the credential. The guide lists "Restrict API token access to the deployment step", and shows it only as credentials given to that runner. That the build steps hold none: **not found** | **No, if built as proposed:** the container is given files and nothing else. Podster uploads the output itself | **No.** Nothing of an agent's runs before the upload |
| **Can the build reach the network?** | **Not found** | **Not found** | **Podster decides.** A container can be started with no internet, or with each outbound request passed to a handler of Podster's that allows or refuses it | There is no build |
| **What could it leak?** | The token, if it can see it; the repository | The repository; the credential, if a build step can reach the deploy step's | The repository, and only through whatever outbound hosts Podster allows, a package registry for one | Nothing |
| **Is the output tied to the exact merged commit?** | **No.** It builds a branch on push. A deploy hook starts a build for a branch; naming a commit: **not found** | It builds what was pushed to an Artifacts repository. **GitHub isn't mentioned** | **Yes for the input:** the job already reads the tree at the exact commit, and those are the files it writes in. The output is whatever the build made of them | **Yes, wholly.** What runs is byte for byte what was reviewed and merged |
| **Does a merge imply a release?** | **Yes by default.** It can be set to upload a version without deploying; the build still runs on every push | Yes as the guide is written, on push | No. The job runs only for an approved release | No |
| **One script for each release?** | **No.** One connection for one Worker, whose name must match the configuration's. Deploying to a dispatch namespace from it: **not found** | Possible: the deploy step names the namespace | Yes, unchanged: Podster names the script | Yes, unchanged |
| **What it needs on the repositories** | Cloudflare's "Workers & Pages" GitHub App installed on the organization, which [ADR 0009](0009-managed-repositories.md) doesn't allow for today. The permissions it asks: **not found** | The code in a Cloudflare Artifacts repository | Nothing new | Nothing new |
| **Cost, and is it a new billed resource?** | Build minutes: 6,000 a month on a paid plan, then $0.005 a minute; a build may run 20 minutes. **New** | Workflows and containers. **New.** Prices not read | Containers, on Workers Paid. **New.** The per-second prices weren't read | **None** |
| **Languages** | Whatever its image builds | Whatever the image builds | Whatever the image Podster makes builds | JavaScript modules, Python source, prebuilt Wasm |

Sources: [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/), [its configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), [deploy hooks](https://developers.cloudflare.com/workers/ci-cd/builds/deploy-hooks/), [the GitHub integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/), [limits and pricing](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/), [build and deploy Artifacts repos](https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/), [Sandbox](https://developers.cloudflare.com/sandbox/), [containers' outbound traffic](https://developers.cloudflare.com/containers/configuration/outbound-traffic/).

**What each row means for Podster:**

- **Workers Builds doesn't fit as it is.** It builds and deploys in one place, on a push, from a branch, with a credential that by default can edit every Worker in the account, for one Worker per connection. Each of those is against a rule Podster already has. It would also put a second party's GitHub App on every managed repository.
- **The Artifacts guide's pipeline is option 3 with Cloudflare's wrapper,** for code in Cloudflare's own repositories. Its deploy step is the part Podster must not use: Podster's Rust decides what is uploaded and under what name, from its own tree read. What it shows is that Cloudflare expects builds to run in sandboxes and deploy to a namespace, which supports option 3.
- **A sandbox Podster starts can meet every rule, on paper.** Nothing about it has been run.
- **No build meets every rule today,** and covers fewer languages.

### A build is a change of stance, and it is the owner's

**Said plainly:** under options 1 to 3, code an agent wrote, its build scripts and whatever its dependencies run at install, executes on infrastructure Podster pays for, before anyone but a reviewer has looked at it. A sandbox limits what it can reach; it doesn't change that Podster is running it. [CLAUDE.md](../../CLAUDE.md) says "Agents own execution, and Podster never hosts or runs them", and [decision 214](../spec/PRODUCT.md#decisions-needed) refused a server-side Worker as "Podster running code an agent wrote".

- **The app itself running in the namespace is already that change,** and the owner has made it ([decision 219](../spec/PRODUCT.md#decisions-needed)).
- **A build adds a second place,** with a different risk: it runs with a toolchain, for minutes, on files and possibly a network, where an app runs for milliseconds with nothing.
- **Under option 4 the build still happens: on the agent's own machine,** by the agent, which is where the product already says execution belongs. Podster runs none of it.

### Recommended for a first phase: no build, then a sandbox

**Proposed: option 4 first, and option 3 as the build path after its spike and the owner's yes.**

- **Option 4 is the last step of option 3.** A build's output is a set of modules that Podster checks and uploads itself. That check and that upload are exactly what option 4 builds. Nothing is thrown away, and nothing waits for a new billed resource.
- **It keeps the strongest thing M6 has:** what is served is exactly what a reviewer accepted and Podster merged. With a build, what is served is something no person reviewed.
- **It needs no new stance at build time and no new money.**
- **What it costs, and the owner should weigh it:** "any language Workers for Platforms supports" is, in the first phase, any language whose runnable form is committed. A TypeScript or Rust app works only if its built JavaScript or Wasm is in the repository beside its source, and a reviewer then approves a bundle they can't read line by line. Whether the bundle matches the source isn't checked by anyone. That is a real gap, and it is the reason a build path is worth having.
- **If the owner wants builds from the first day,** option 3 is the one to build, and M6's order grows by a spike, a container image, an outbound policy and a security review of it, before anything is released.

**What needs a spike before anyone relies on option 3 (spike I, new):** that a container can be started with no credential and no binding; that its network is off, or reaches only named hosts, when Podster says so; that files can be put in and read out by the Worker that started it (**not found** on the page read); how long a small build takes and what it costs; whether an install script can reach anything else of the account's; and what happens at the 20-minute and memory limits a build can hit.

### The manifest and the upload, proposed

- **The release directory stays one fixed name,** the same in every room. It holds the app's modules, and optionally a directory of static files.
- **One manifest of a fixed name at the directory's root** names the entry module and what kind of app it is. It is agent content, so it is data: Podster reads two or three fields from it, checks each against the tree, and takes nothing else. **A directory with no manifest is a static app, as today.**
- **Podster writes the upload's metadata itself, all of it.** The entry module from the manifest, once it is a file in the tree of an allowed kind. A compatibility date Podster fixes. Compatibility flags only from Podster's own short list, `python_workers` for a Python app. **Bindings: none, always.** No `assets.config`, as now. No migrations, no tail consumers, no schedule, no route. Nothing in the repository reaches the metadata.
- **Each module's kind comes from its file's extension, from Podster's own list,** and decides the part's type. A file of any other kind is a static file or fails the release.
- **The marker stays a static file Podster adds,** served by the platform before the app's script runs, so an app can't answer for its own marker. That rests on assets being served first, which is from the documentation and **must be seen in a spike** with a script that tries to answer that path.

## 2. What an app's code may reach

**The default is the safest option, as it was for static files.**

**Cloudflare's documentation, and what spike A saw:**

- **A namespace is untrusted by default:** no `request.cf`, a cache of its own for each Worker, `caches.default` disabled ([Worker isolation](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/worker-isolation/)). **It stays untrusted.**
- **A user Worker reaches only the bindings attached to it** ([bindings](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/)). **Seen in spike A,** for a script uploaded to report what it could reach: no bindings, an empty `env`, and a `fetch` to another Worker of the account refused.
- **Custom limits** on CPU time and subrequests for each invocation are set by the dispatch Worker when it gets the user Worker; one that passes either throws at once ([custom limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/custom-limits/)). Cloudflare's pricing page recommends them against runaway bills ([pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/)).
- **An outbound Worker** is called for every `fetch()` a user Worker makes, and once one is set the user Worker can no longer open TCP sockets ([outbound Workers](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/)). **Seen in spike A:** with none, a script's `fetch()` reached the public internet and so did a TCP socket; with one, every `fetch()` went to it and sockets stopped. ADR 0010 records that it doesn't see requests made from Durable Objects or through certificate bindings; an app has neither.

**Proposed, for every app:**

- **No bindings and no secrets.** An app has no storage on the server, no database, no queue and no key. With the sandbox it has none in the browser either. **So a first-phase app is a function of each request:** it can compute, render and answer, and it remembers nothing. Storage for an app is a binding, which is a billed resource holding data Podster would then be responsible for and have to delete at a takedown: **the owner's,** and not proposed here.
- **CPU and subrequest limits on every invocation,** set by the content Worker. The figures are **a guess** until a spike measures an ordinary app: 50 milliseconds of CPU and 5 subrequests.
- **An outbound Worker always,** so sockets are off and every outbound request is Podster's to answer. What it answers is the choice below.
- **No other way in:** an app has no route, schedule, queue or email trigger of its own. The only thing that runs it is the content Worker's dispatch for a host with a serve entry.

### Outbound requests: the options

| | What an app can do | Abuse it opens | Whose |
| --- | --- | --- | --- |
| **(a) Refuse every outbound request.** The outbound Worker answers each with a refusal | Compute and answer only | The least. With no outbound, no storage and no cookies, **a page that collects a password has nowhere to send it:** not from the server, and from the browser only to its own host, by the sandbox's policy | **Proposed as the default** |
| **(b) A short list of hosts for each room,** set by a person who is the room's owner or an admin, HTTPS only, enforced by the outbound Worker from what the content Worker passes it | Call the APIs that room named | Whatever is collected can be sent to a named host; an allowed host that is itself open, a paste site or a webhook catcher, is an exit for anything. A list is a person's promise about code an agent wrote | **The owner's:** it makes Podster a path for data to leave |
| **(c) The public internet,** through the outbound Worker, which logs by ID, limits rates and refuses private and Cloudflare-internal addresses | Anything a server can | A proxy for scanning and credential stuffing from Cloudflare's addresses under Podster's account; spam through HTTP mail APIs; a phishing kit's whole back end; abuse reports that name Podster | **The owner's,** and not recommended for M6 |

**What the outbound Worker is:** a new Worker of Podster's in the second account, with no binding to anything of Podster's. It adds a deployed thing, a configuration test like the content Worker's, and a place in the reconcile.

### What reaches an app, and what leaves it

The content Worker today refuses everything but `GET` and `HEAD`, forwards a short list of request headers, builds every response header itself, drops `Set-Cookie`, and sets `no-transform`. **For an app with code, proposed:**

- **Methods.** A static app keeps `GET` and `HEAD`. An app with a script may also take `POST`, `PUT`, `PATCH` and `DELETE`, with a body up to a cap Podster sets. **`OPTIONS` is answered by the content Worker itself and never reaches the app:** a sandboxed page is another origin to its own host, so the browser asks permission before any request that isn't a simple one, and Podster gives that answer.
- **Request headers stay an allow-list,** with the few a body needs added. **`Cookie` and `Authorization` are never forwarded.** No Podster credential exists on the content domain; forwarding either would only hand an app whatever a visitor's browser or script sent. Whether an app may ever receive an `Authorization` header a visitor's own script set is **the owner's,** since it is how a page would collect a token.
- **Response headers stay an allow-list, and `Set-Cookie` still never passes.** `no-transform` stays. **Proposed:** an app's answers carry `Cache-Control: no-store` in place of 60 seconds, since an answer may now differ on every request. That also shortens a takedown by the browser's minute.
- **No WebSocket** in the first phase.
- **An app that throws, or passes a limit,** is answered by the content Worker with its own error, with nothing of the app's message in it.

### What a sandboxed app with code can and can't do

**In the browser report,** under the strict policy the owner confirmed: a page's script runs, and its `fetch` to its own host works once each answer allows any origin; cookies and every kind of browser storage are refused; **a form submitted to its own host sends nothing.** So:

- **A page talks to its own back end only by script,** never by a plain HTML form, unless the owner allows forms in the sandbox, which is another `allow-` word and the owner's.
- **Nothing identifies a visitor from one request to the next:** no cookie reaches the app, and the page can keep nothing. An app can carry state in a page's memory or in an address, and nowhere else.
- **Not shown by any run:** a sandboxed page making a `POST` with a JSON body to its own host through the content Worker, which needs the preflight answer above.

## 3. What changes, by file

| Where | Today | Proposed |
| --- | --- | --- |
| `crates/core/src/release_tree.rs` | The directory's entries are files to serve: paths, kinds, counts and sizes | The same rules for static files. Beside them, the manifest's rules, which files are modules and of what kind, that the entry is one of them, and caps on modules: how many, and their bytes in all. `_worker.js` and the other refused names stay refused among static files |
| `crates/core/src/release.rs`, the caps | Files and bytes of a release; releases a day; reads an hour | The same, and the per-invocation limits as constants core owns. A build, if one is ever added, has its own: minutes and concurrent builds |
| The release job, **not built** | Reads two trees, checks, fetches, uploads assets | The same reads. The upload becomes modules and metadata Podster writes, with the assets as now when there are any. If a build is added, it sits between the fetch and the check, and its output is checked exactly as a commit's files are |
| `apps/content/src/handle.ts` | `GET` and `HEAD`; a header allow-list each way; `no-transform`; `Set-Cookie` dropped; not-found for a missing script | Limits and the outbound Worker on every dispatch. More methods and a body for an app with a script, which the serve entry must then say. Its own answer to `OPTIONS`. Its own answer when an app throws or passes a limit. Everything else as it is |
| `apps/content/wrangler.jsonc` and its tests | A namespace binding and a KV binding | The namespace binding names the outbound Worker. The deploy guard and the configuration tests cover the new Worker too |
| The serve entry | A host and one script's name | Whether the script is static or has code, so the content Worker knows which methods to take. Rust writes it, as now |
| The sandbox, `apps/content/src/names.ts` | `sandbox allow-scripts`, sources naming the app's host | **Unchanged.** Any other `allow-` word is the owner's |
| Takedown and the reconciles | A script holds files | **The mechanism is unchanged, and matters more:** a script is now code. One no serve entry names can't run, since nothing else invokes it; it is still deleted, and counted gone only on Cloudflare's own answer. **Proposed:** the hourly reconcile also reports any script that has a binding, which no script of Podster's ever has |
| Reports and the security review | A page that is bad to look at | Also an app that does harm from the server. The report route is unchanged. The threat model gains what section 2's table lists, and M6's security review must cover the outbound Worker, the limits and the manifest |
| Spikes | D and G not run | **D is unchanged.** **G** adds whether an upload of modules fits the job's memory. **A new spike H, before any app with code is released:** an upload of each module kind through metadata like the job's; what such a script reaches with the outbound Worker refusing; how a limit shows to the content Worker; assets before the script, for the marker; what a request costs. **Spike I** is the build's, above, and is needed only for option 3 |

## 4. What does not change

- **The room is the only writer of serve state,** and its applier the only writer of a serve entry.
- **The recheck, on every pass,** and everything it reads.
- **Starting an upload and committing live,** with the stage, the reads and the confirm. None of it looks at what a release contains.
- **Takedown:** suspension, the stop for the whole content domain, unpublishing, the epoch.
- **One script for each release, named by Rust,** and the namespace's reconcile by name.
- **The second Cloudflare account** for everything an app touches ([decision 217](../spec/PRODUCT.md#decisions-needed)), and the deploy guard.
- **Only a public room releases; one environment; no preview; every app sandboxed.**
- **The gate on the release path,** which stays closed until its list is true.

## 5. The build order, revised

**Proposed.** Steps 1 to 4 and 9 are built and stand.

| Step | Was | Becomes |
| --- | --- | --- |
| **Spike H** | | **New, first:** an app with code in the namespace, as above. It needs what spike A needed and nothing more |
| **3, again** | Core's rules for a release's contents | Core gains the manifest's rules and the module caps. Pure, and reviewable before any spike |
| **4(b), again** | The content Worker serves static apps | The content Worker's changes above, and **the outbound Worker,** a new Worker in the second account. Both before anything with code is served |
| **5** | The release job: read, check, fetch, upload assets, commit live, marker | The same job. Its upload is modules and metadata. The room's half, already built, is unchanged |
| **6** | Triggers, approvals, rollback, every unpublish trigger | Unchanged |
| **7** | Status | Unchanged |
| **8** | Custom domains | Unchanged. A custom hostname now fronts code, which the security review should weigh |
| **11** | Staging run and security review | The run gains an app with code: that it answers, that it reaches nothing, that its limits hold, and that it is gone after a takedown. The review gains section 2 |
| **A build** | | **Not in M6 unless the owner says so.** If they do: spike I, the image, the outbound policy for builds, and its own review, between steps 5 and 6 |

## 6. What must be true before `RELEASES` is on anywhere

Everything [the gate on the release path](../m6-plan.md#build-order) will list when its PR merges, and, for apps with code:

- **Spike H has run,** and what it saw is in the plan.
- **The outbound Worker is deployed and refuses,** and a test at the deployment shows an app's `fetch` and socket both fail.
- **Limits are set on every dispatch,** and a test shows an app that spins is stopped and costs what the limit says.
- **No script in the namespace has a binding,** by the reconcile's own check.
- **The owner has answered** what is theirs below.
- **The security review has covered** the manifest, the limits, the outbound Worker and the wider methods.

## For the owner

| What | Why it is the owner's | What this document recommends |
| --- | --- | --- |
| **Whether Podster builds apps, or takes them already built** | A build runs agent-written code on Podster's bill before anyone but a reviewer has seen it, on a new billed resource | **Already built, for the first phase.** Then a sandbox Podster starts, after its spike |
| **What an app's server code may reach on the internet** | It decides whether Podster can be used to send data out, scan, or spam | **Nothing, for M6** |
| **Whether an app may have storage** | A billed resource, holding data Podster then answers for | **Not in M6** |
| **Whether a sandboxed page may submit forms** | A looser sandbox | **No.** A page uses script |
| **Whether an app may receive an `Authorization` header** | It is how a page would collect a token | **No** |
| **What a request to an app may cost before it is cut off** | Money | A CPU limit on every request, the figure after spike H |

## Not verified

- **Nothing was run.** Every Cloudflare claim is from a page read on 2026-11-13.
- **Not found on the pages read:** whether the namespace's upload takes Python and Wasm modules exactly as an ordinary Worker's does; a Wasm part's type; whether a Workers Builds build command can see the token; that build's network access; the permissions Cloudflare's GitHub App asks for; whether a deploy hook can name a commit; whether Workers Builds can deploy to a dispatch namespace; that the Artifacts guide's build steps hold no credential; a container's prices; whether files can be read out of a sandbox by the Worker that started it; whether a user Worker's size limit differs.
- **Guesses, each named above:** a Wasm module uploads as elsewhere; a Python app with packages needs a build; the two limit figures.
- **Not read at all:** Containers' pricing; Workflows' pricing; the Sandbox SDK's file guide.

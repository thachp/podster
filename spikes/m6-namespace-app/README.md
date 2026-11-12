# M6 spike A: a room's app in a dispatch namespace

**Status, 2026-11-12 UTC: run once, on staging's dispatch namespace, between 09:01 and 09:23 UTC. Everything it created is deleted.** It answers spike A in the [M6 plan](../../docs/m6-plan.md#the-spikes), for [ADR 0010](../../docs/adr/0010-release-and-the-content-domain.md). What each answer changes in the ADR is in the plan's [Spike A results](../../docs/m6-plan.md#spike-a-results). Nothing builds on this folder.

It ran against the namespace `podster-staging-apps`, on the Cloudflare account that holds `podster.dev`, by the owner's yes of 2026-11-12 for that namespace and for temporary spike resources.

## What is here

| Path | What it is |
| --- | --- |
| `spike.mjs` | The runner. Each command runs `wrangler` and fetches the `workers.dev` address |
| `guard.mjs`, `guard.test.mjs` | Which script names and which namespace the runner may hand to wrangler, and an offline test of it |
| `dispatch/` | The dispatch Worker, `spike-m6-dispatch`. It sends `/<script name>/<path>` to that script in the namespace. `wrangler.outbound.jsonc` also names it as its own outbound Worker |
| `apps/site` | A user Worker with static files, a script and no bindings |
| `apps/assets-only` | The same files with no script at all |
| `apps/headers` | Static files with `_headers` and `_redirects` |
| `apps/probe` | A user Worker with code and no bindings, which reports what it can reach |

## How it calls Cloudflare

**Every API call is made by a `wrangler` command under the existing `wrangler login`.** The runner never reads, holds or prints the login's token. Two consequences:

- **Wrangler 4.157.0 has no command that deletes or lists scripts in a dispatch namespace.** Both are done through commands that put their argument into the API path as it is:
  - `wrangler delete --force --name ../dispatch/namespaces/<namespace>/scripts/<name>` reaches `DELETE /workers/dispatch/namespaces/<namespace>/scripts/<name>?force=true`.
  - `wrangler dispatch-namespace get <namespace>/scripts` reaches the list, and `<namespace>/scripts/<name>` one script.
  - A release job would call those endpoints directly.
  - **The same trick could reach a Worker on the account.** The name goes into the path as typed and the path is resolved afterwards, so a hand-typed name that climbs further, such as `spike-m6-../x`, would become a delete of something else: another script, or one of the account's own Workers. A check that the name begins `spike-m6-` doesn't stop that.
  - **So the runner refuses, before it starts wrangler, unless both hold:** the script name matches `^spike-m6-[a-z0-9-]{1,50}$` exactly, with no `/`, `.`, `%` or upper case; and the namespace is the literal `podster-staging-apps`. The namespace is no longer read from the environment. The same check guards uploads and reads, so nothing is uploaded that the runner couldn't delete. It is in `guard.mjs`, with an offline test:

    ```bash
    node --test spikes/m6-namespace-app/guard.test.mjs
    ```

  - **The run of 2026-11-12 was made before this check,** with only the `spike-m6-` prefix test. Sixteen of its eighteen [name cases](#8-script-names) don't pass the check now, and `names` skips them.
- **`wrangler delete` also lists the account's Durable Object namespaces and KV namespaces,** two reads it makes for every delete. Nothing of Podster's was changed.

**Wrangler is started with an allow-listed environment, not the runner's own.** It gets what [`e2e/child-env.mjs`](../../e2e/child-env.mjs) allows, wrangler's own logging settings, and exactly one name of Cloudflare's: `CLOUDFLARE_ACCOUNT_ID`, which is an ID and not a credential. That is the same exception `e2e/m5-tails.mjs` makes. Wrangler finds its login under `HOME`. A token or a `WRANGLER_*` setting in the caller's shell doesn't reach it.

### Never turn wrangler's log sanitizing off

**`WRANGLER_LOG_SANITIZE=false` must never be set.** It leaves the login's bearer token in wrangler's own log files under `~/.wrangler/logs`.

- **It happened once, during this spike.** The request and response bodies under [the upload's calls](#5-the-uploads-calls) were read from wrangler's debug log with sanitizing off. Two of wrangler's log files then held the bearer token. Both were deleted.
- **The runner no longer does it.** Its `shapes` command is removed, nothing in it sets that variable, and the allow-listed environment keeps a value set in the caller's shell away from wrangler.
- **The shapes stay as recorded,** with placeholders for every token, account and name. To see them again, call the endpoints directly from a release job's own test, with a token made for that.

## Run it again

It needs Workers for Platforms on the account, a dispatch namespace, and `wrangler login` with the `workers_scripts` scope. It creates a public Worker on the account's `workers.dev` address and scripts in the namespace, so it needs the owner's yes each time.

```bash
cd spikes/m6-namespace-app && npm ci
```

Set `CLOUDFLARE_ACCOUNT_ID` to the ID of the Cloudflare account that holds `podster.dev`. The ID stays out of this repository, as [`docs/staging.md`](../../docs/staging.md) has it. The runner refuses to start without it.

Then, in this order:

```bash
node spike.mjs dispatch
```

```bash
node spike.mjs serve
```

```bash
node spike.mjs probe
```

```bash
node spike.mjs dispatch outbound && node spike.mjs probe outbound
```

Going back from `outbound` to the plain dispatch Worker needs the Worker deleted first. On a redeploy wrangler reports the namespace binding as "inherited" and the outbound Worker stays:

```bash
npx wrangler delete --force --name spike-m6-dispatch && node spike.mjs dispatch
```

```bash
node spike.mjs timing 6
```

```bash
node spike.mjs names
```

Results print as JSON and are appended to `.wrangler/spike/results.jsonl`, which git ignores. The account's ID and its `workers.dev` subdomain are replaced with `<account>` and `<subdomain>` in both.

## Clean up

```bash
node spike.mjs cleanup
```

It deletes every script the runner's ledger says it created, then the dispatch Worker, then reads the namespace. Confirm by listing:

```bash
npx wrangler dispatch-namespace get podster-staging-apps/scripts
```

```bash
npx wrangler dispatch-namespace get podster-staging-apps
```

The first must print `[]` and the second `script_count: 0`. The namespace itself stays. If the ledger is lost, delete by name: `node spike.mjs delete spike-m6-…`. The name must pass the check above.

## Results, 2026-11-12

All requests went from one machine to one Cloudflare location, through `https://spike-m6-dispatch.<subdomain>.workers.dev/<script>/<path>`. Wrangler was 4.157.0.

### 1. A user Worker with static files serves them through a dispatch Worker

**Yes.** `apps/site` was uploaded into the namespace with six files, a script and no bindings. The API's own list of its bindings was `[]`.

| Request | Answer |
| --- | --- |
| `GET /` | 200, `text/html`, the index page |
| `GET /style.css` | 200, `text/css`, `cache-control: public, max-age=0, must-revalidate`, an `etag` |
| `GET /marker.txt` | 200, `text/plain` |
| `HEAD /marker.txt` | 200, no body, a weak `etag` |
| `POST /marker.txt` | 405 |
| `GET /.well-known/podster-release.json` | 200, `application/json`. A directory whose name begins with a dot is uploaded and served |
| `GET /index.html` | **307 to `/`** |
| `GET /sub/page` | 200: the file is `sub/page.html` |
| `GET /no-such-file` | The script ran and answered. It saw `Object.keys(env)` as `[]` |

- **The platform rewrites HTML paths by default.** `/index.html` redirects to `/`, and `page.html` is served at `/page`. That is `html_handling`'s default, `auto-trailing-slash`. The redirect's `Location` is a path, so it is right on a host of the app's own.
- **The `etag` is the manifest's hash for that file, as it was sent.** `style.css` went up with hash `59e9b695f33105844cd937b453dbf1f2` and came back with `etag: "59e9b695f33105844cd937b453dbf1f2"`. A request with that value in `If-None-Match` got 304.

### 2. Assets only, with no script

**Yes.** `apps/assets-only` has no `main`. Wrangler's upload carried a `metadata` part and no module, and the API answered 200 with `has_assets: true`, `has_modules: false` and `handlers: ["fetch"]`.

- Files are served as in item 1.
- A path that matches no file gets **404 with an empty body**. A `POST` gets 405 on a file and 404 elsewhere.

### 3. `_headers` and `_redirects`

**They are honoured when the uploader sends them, and only then.**

- **Wrangler doesn't upload those two files.** It leaves them out of the manifest and puts their text into the script upload's metadata, as `assets.config._headers` and `assets.config._redirects`. The debug log showed `"config":{"_headers":"/*\n  X-Spike-Shape: 1\n"}`.
- **Sent that way, every rule applied.** `apps/headers` set a header, a cookie, a Content Security Policy and a cache lifetime, and three redirects:

| Request | Answer |
| --- | --- |
| `GET /` | 200 with `x-spike-header: set-by-_headers`, `set-cookie: spike=1; Path=/` and `content-security-policy: default-src 'none'` |
| `GET /index.html` | 307 to `/`, with `cache-control: public, max-age=31536000` |
| `GET /go` | **302 to `https://example.com/`** |
| `GET /moved` | 301 to `/target.html` |
| `GET /_headers`, `GET /_redirects` | 404, with the `/*` headers on it. The files themselves aren't served |

- **A file of that name deeper in the directory is an ordinary file.** `sub/_headers` was uploaded and served as content, 200, and its rule set nothing on `/sub/page`.
- **The dispatch Worker has the last word on what it touches.** With `?__fix`, the dispatch Worker removed `set-cookie` and the policy and set its own `cache-control`, and the answer carried those. `x-spike-header` was still there, because the Worker didn't remove it: a header the content Worker doesn't know about passes through.
- **Not shown:** a file named `_headers` at the root, uploaded as a file in the manifest with nothing in `assets.config`. Wrangler can't be made to send that. From the above it should be plain content; the release job's own test must show it.

### 4. What the user Worker can reach

`apps/probe` is a user Worker with code and no bindings.

**With no outbound Worker:**

| It tried | It got |
| --- | --- |
| `Object.keys(env)` | `[]` |
| `request.cf` | `undefined` |
| `caches.default.put` | Threw: "This Worker is not permitted to access the default cache." |
| `fetch("https://example.com/")` and `example.org` | **200.** The public internet is reachable |
| `fetch` to the dispatch Worker's own `workers.dev` address, a Worker on the same account | 404, "error code: 1042" |
| `fetch` to Cloudflare's API for this account, with no credential | 400, code 9106, missing authorization. Nothing is added for it |
| `fetch("http://127.0.0.1/")` and `http://10.0.0.1/` | 403, "error code: 1003" |
| `connect("neverssl.com:80")`, a TCP socket | **Connected, and read `HTTP/1.1 403 Forbidden`** |
| `connect("example.com:80")`, a host behind Cloudflare | Threw: "proxy request failed, cannot connect to the specified address" |

**With an outbound Worker.** The dispatch Worker was named as its own outbound Worker, so the test needed no second Worker. Cloudflare then sent it every `fetch()` the probe made:

- **It can block:** each target got the outbound Worker's own 403.
- **It can route:** `example.org` got an answer the outbound Worker wrote itself.
- **It can pass through:** in `pass` mode each target answered as it did with no outbound Worker.
- **`connect()` stopped working** for both targets, in both modes.
- **A static file was still served,** with the outbound Worker configured.
- **A binding that declares parameters must be given them.** `env.DISPATCH.get(name)` with none threw `TypeError`: "Missing one or more required arguments to worker."

**Not tried:** Durable Objects, service bindings, or any binding at all, since none is attached; per-request CPU and subrequest limits.

### 5. The upload's calls

Seen in wrangler's debug log, on 2026-11-12, by a means that [must not be used again](#never-turn-wranglers-log-sanitizing-off). All paths are under `/client/v4/accounts/<account>`.

**First, the upload session.**

```
POST /workers/dispatch/namespaces/<namespace>/scripts/<name>/assets-upload-session
Content-Type: application/json

{"manifest":{"/data.bin":{"hash":"6efafccc327f4665179f5ea3ff9c78de","size":48},
             "/index.html":{"hash":"3323d21480db7dabac407d3b09fd429d","size":11},
             "/sub/copy.html":{"hash":"3323d21480db7dabac407d3b09fd429d","size":11}}}
```

```
200
{"result":{"jwt":"<session token>","buckets":[["3323d21480db7dabac407d3b09fd429d"],["6efafccc327f4665179f5ea3ff9c78de"]]},
 "success":true,"errors":null,"messages":null}
```

- A path begins with `/`. A hash is 32 hexadecimal characters.
- **`buckets` lists each hash once,** however many paths share it, and only the hashes Cloudflare wants.
- **The session token** is the text `cfwau_` followed by a JWT that lasts 3,600 seconds. Its claims name the manifest, the account and the namespace.
- **The same files again, for the same script:** `"buckets":[]`, and `jwt` is already the completion token. No file is sent.
- **The same files for a second script name:** every hash was asked for again. Files are remembered for a script, not across the namespace.

**Second, the files,** one call for each bucket. Wrangler sends three calls at a time.

```
POST /workers/assets/upload?base64=true
Authorization: Bearer <session token>
Content-Type: multipart/form-data

part name="3323d21480db7dabac407d3b09fd429d"; filename="3323d21480db7dabac407d3b09fd429d"
     Content-Type: text/html; charset=utf-8
     PHA+b25lPC9wPgo=
```

- Each part is named by its hash, holds the file as base64, and its `Content-Type` is the type the file is served with.
- **202 with `{"result":{}}`** while buckets remain, then **201 with `{"result":{"jwt":"<completion token>"}}`.** The completion token is a different JWT, also for 3,600 seconds.

**Third, the script.**

```
PUT /workers/dispatch/namespaces/<namespace>/scripts/<name>?excludeScript=true&bindings_inherit=strict
Content-Type: multipart/form-data

part name="metadata"
     {"assets":{"jwt":"<completion token>","config":{}},"compatibility_date":"2026-11-01","compatibility_flags":[]}
```

```
200
{"result":{"id":"<name>","tag":"<tag, 32 hex>","deployment_id":"<deployment ID, 32 hex>",
           "has_assets":true,"has_modules":false,"handlers":["fetch"],"compatibility_date":"2026-11-01",
           "usage_model":"standard","startup_time_ms":0,"created_on":"…","modified_on":"…"}, "success":true}
```

- For assets only there is no other part. With a script, wrangler adds `main_module` and the module's part.
- The two query parameters are wrangler's. Whether the call needs them wasn't tried.
- `tag` stays the same across uploads of one script name. `deployment_id` changes with each.

**The delete.** `DELETE …/scripts/<name>?force=true` answered 200 with `{"result":{"id":"<the script's tag>"}}`.

**Rate limits,** from response headers: the session, the script upload and the delete each showed `q=180000;w=300`, and a read showed `q=1200;w=300`.

**The hashing rule.**

- **Cloudflare's documentation** asks for 32 hexadecimal characters that represent the file's contents, computed the same way each time, and suggests a truncated SHA-256 ([static assets for user Workers](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/static-assets/)).
- **Wrangler** uses BLAKE3 of the file's base64 text followed by its extension, cut to 32 characters (`hashFile` in its source).
- **The hash is public and it is the cache key:** it comes back as the file's `etag` ([item 1](#1-a-user-worker-with-static-files-serves-them-through-a-dispatch-worker)). So it must change whenever the bytes or the served type change.
- **Not shown:** whether Cloudflare checks a hash against the bytes sent, or accepts arbitrary values, and how it sizes a bucket. Only the hashes wrangler computed were sent, and they were accepted.

**Reading back.** Reading a script returned its `tag`, `deployment_id` and `has_assets`, and nothing about its files. No way to read a manifest back was found.

### 6. How long an upload, a replace and a delete take to show

Twelve rounds. Each round uploaded a new assets-only script, replaced its one file, and deleted it. The address was fetched about four times a second throughout, and for five seconds after the change first showed. "After the answer" is from the moment the API answered the `PUT` or `DELETE`.

| | The API call | Shown after the answer: least | median | most |
| --- | --- | --- | --- | --- |
| Upload of a new script | 272 to 771 ms | 0.47 s | 0.90 s | 2.5 s |
| Replace of a script | 274 to 588 ms | 0.57 s | 0.89 s | **74.4 s** |
| Delete | 228 to 2,784 ms | 0.41 s | 0.87 s | 6.1 s |

- **One replace took 74 seconds to show,** and another 6.4 seconds. For all of that time the address served the old file with 200. The other ten took under 2.1 seconds.
- **One delete took 6.1 seconds,** and after the first not-found the address served the deleted file once more.
- No other round went back to the old state after first showing the new one.
- **A whole upload,** from starting wrangler to the file showing, took 3.5 to 5.5 seconds for one small file. About 3 seconds of that is wrangler's own three calls and start-up.
- The fetches can't resolve less than about a quarter of a second, and they came from one place. Other locations may differ.
- **The address was already being fetched before each upload.** A release that nothing has asked for yet may show sooner.

### 7. The answer for a deleted script, and the list

- **Reading a deleted script answers 200, not 404.** `GET …/scripts/<name>` returned the namespace's own fields and `"script": null`, for a script that was deleted and for a name that never existed. An existing script comes back as an object there.
- **Deleting it again answers 404,** with code 10007, "This Worker does not exist on your account."
- **The list** is `GET …/namespaces/<namespace>/scripts`: an array with one object for each script, holding `id` (its name), `created_on`, `modified_on`, `tag` and more. It answered `[]` when empty.
- **The list's `has_assets` and `deployment_id` were wrong.** It showed `has_assets: false` and an empty `deployment_id` for scripts whose own read showed `has_assets: true` and a deployment.
- **The namespace's own read carries `script_count`,** which followed each upload and delete at once.
- **Not shown:** how the list pages. It never held more than five scripts.

### 8. Script names

**No rule was met in the names tried.** Each of these was uploaded as an assets-only script, served through the dispatch Worker, and deleted:

- **Lengths** of 63, 64, 65, 100, 255, 256, 512, 1,024, 2,048 and 4,096 characters.
- **Characters:** upper case, `_`, `--`, a trailing `-`, `.`, `~`, `:` and `+`.
- **Names are case-sensitive.** `spike-m6-n-UPPER` was served; `spike-m6-n-upper` answered "Worker not found."
- **Not tried:** `/`, `%`, a space, and anything outside ASCII. Cloudflare's documentation for wrangler says a Worker's name is letters, digits and dashes, up to 255 characters; the namespace's upload didn't enforce that.

### 9. A dispatch to a missing script

- **`env.DISPATCH.get(name)` doesn't throw.** It returns a stub whatever the name.
- **`stub.fetch(request)` rejects** with an `Error` whose message is `Worker not found.` The dispatch Worker catches it and chooses the status; this one answered 502.
- A deleted script, a name that never existed and a name with odd characters all gave the same error.

### 10. What a request costs

**Not measured.** This login can't read billing or analytics, and no dashboard was used. From Cloudflare's documentation, read again on 2026-11-12:

- Workers for Platforms "only charges for 1 request across the chain of dispatch Worker -> user Worker -> outbound Worker", and "CPU time is charged across these Workers" ([pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/pricing/)).
- Workers' own pricing says "Requests to static assets are free and unlimited" ([billing and limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)). Neither the Workers for Platforms pricing page nor its static-assets page says that.
- **So the assumption stands: each request to an app is one billed request,** since each runs the dispatch Worker's code first. The spike adds nothing to it either way.
- The spike itself made about 4,000 requests to the dispatch Worker and about 60 uploads.

## Not shown

- Anything that needs a call wrangler can't make: a manifest with a hash that doesn't match its file, a root `_headers` sent as a plain file, a script upload without wrangler's query parameters.
- What a request is billed as.
- Timings from more than one place, or for a release of many or large files.
- The list's paging, and names with `/`, `%`, spaces or non-ASCII characters.
- Per-request limits, and anything about tokens: that is spike B.

## Resources

**Created, all temporary, all on the Cloudflare account that holds `podster.dev`:**

- **One Worker on the account:** `spike-m6-dispatch`, on its `workers.dev` address. Created twice and deleted twice, because removing its outbound setting needed a delete.
- **38 scripts in `podster-staging-apps`,** each named `spike-m6-…`: `spike-m6-a-first`, `-site`, `-assets-only`, `-headers`, `-probe`, two `-shape-…`, thirteen `-t<round>-…` for timing, one of them from a run that was stopped, and eighteen `spike-m6-n…` for names.

**Deleted:** all of them. At 09:23 UTC the namespace's list answered `[]`, its `script_count` was 0, the account's list of Workers held Podster's six and no `spike-m6` Worker, and the `workers.dev` address answered 404.

**Left:** the namespace `podster-staging-apps`, empty, as it was found. No KV namespace, hostname, token, DNS record, route or secret was created.

**Read and not changed:** the account's lists of Durable Object namespaces and KV namespaces, by `wrangler delete`; the account's `workers.dev` subdomain and list of dispatch namespaces, by `wrangler deploy`; the account's list of Workers, once, to confirm the clean-up.

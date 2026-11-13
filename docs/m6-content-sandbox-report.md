# What a sandboxed app can and can't do in a browser

**For the owner, as evidence about what [decision 216](spec/PRODUCT.md#decisions-needed) costs.** Every app Podster serves is sandboxed: the content Worker sends one `Content-Security-Policy` on every answer, `sandbox allow-scripts` and a list of sources that names the app's own host. This is what an ordinary static app could and couldn't do under that policy, in three browsers.

**It recommends nothing.** Whether any of this should change is the owner's.

## What was run

- **A local run, on one machine, on 2026-11-13** (08:10 UTC), at commit `a53062c53d8835248168c4ed043b20a57842c644`. The raw results are in [`m6-content-sandbox-run-2026-11-13.json`](m6-content-sandbox-run-2026-11-13.json). The script is [`e2e/content-sandbox.mjs`](../e2e/content-sandbox.mjs).
  - **The commits after that one, in the pull request that carries this report, change this report, that file and the plan, and nothing that runs.**
  - *This replaces a first run of 2026-11-12 at `4143d04`, whose report was merged at a later commit without saying what lay between. Between that run and this one the script changed: it now fails when the sandbox doesn't hold, waits on the page and not on time, and tests only the Worker it started. Every row below came out the same in both runs.*
- **The Worker:** the content Worker's real handler, in the real Workers runtime, under `wrangler dev` 4.157.0, from a test-only entry that holds two apps' serve entries and one small static app in memory.
- **The browsers:** the ones Playwright 1.64.1 already had installed. Chromium 156.0.8078.4, Firefox 157.0 and WebKit 27.2, all headless. None was downloaded for this.
- **A control:** each browser was shown the same app a second time with the policy header taken off by the test harness, never by the Worker. That tells what the sandbox stops from what this harness couldn't have shown anyway.

## The limits of this run

- **No real DNS, no real TLS and no Cloudflare edge.** The browser's requests were intercepted by Playwright and answered from the local Worker. The browser believed it was on `https://appa.sandbox-test.example`.
- **A service worker's script is fetched outside that interception,** so nothing here shows a registration at the network. The page's own attempt to register one is shown.
- **`wrangler dev` was local only:** `--local`, no `--remote`, no tunnel, listening on `127.0.0.1` alone.
- **No account was touched.** `wrangler` ran with no `CLOUDFLARE_` variable and an empty home folder, so it had no login and no token to call with, and what it printed mentions no login and no account. Its traffic wasn't captured, so this rests on it having nothing to call with.
- **One machine, headless browsers, one small app.** Branded and mobile browsers weren't run. A browser job in CI covering all three engines is owed.
- **Time is used in one place.** When an action is stopped, nothing follows it, and "nothing happened" has no event to wait for. After each of the four actions, the popup, the dialog, the download and the form, the run waits for a line the page writes the moment the action is taken, or for the browser doing something, whichever is first. It then gives the browser 1.5 seconds to do anything more. A browser slower than that to start a download or a navigation would be recorded, wrongly, as not having started one. Everything else waits on an event.
- **The run tests only the Worker it started.** The port is one that was free when the run began, and the Worker must answer with a mark made for that run before anything is asked of it.

## What the run asserts, and what it only records

**The run fails unless every browser that is installed launched and ran, and unless each of these held in each of them.** They are what the sandbox is for:

- under the policy the page's origin is `null`;
- cookies, `localStorage`, `sessionStorage`, IndexedDB, the Cache API and service-worker registration are each refused;
- a sibling host can't read a cookie or write one for the domain;
- no request carries a cookie;
- an app's `Set-Cookie` never reaches the browser;
- and, in the control, the opposite: storage works and the sibling reads the first app's cookie. Without that, the rows above would also hold for a harness that could see nothing.

All held, in all three. The assertions have a test of their own, against the recorded results, that takes each away in turn and sees the run fail: `e2e/content-sandbox-selftest.mjs`.

**Everything in the next table is recorded, never asserted.** It is what an ordinary app can do, and it is the owner's to weigh.

## Under the policy: what an ordinary static app needs

Same result in all three browsers unless a browser is named.

| What an app does | Under the policy | With the policy taken off |
| --- | --- | --- |
| Its module script runs | **Works** | Works |
| `fetch` of its own JSON | **Works** | Works |
| Its stylesheet, and inline styles | **Work** | Work |
| Its own images, and `data:` images | **Work** | Work |
| A link to another page of the same app | **Works** | *Not reached: the form had already navigated away* |
| `history.pushState` | **Works in Chromium and Firefox. Doesn't in WebKit:** `SecurityError` | Works in all three |
| Its own web font file | **Asked for.** The test file isn't a real font, so rendering isn't shown | Asked for |
| An inline `<script>` | **Doesn't run** | Runs |
| A form submitted to its own host | **Doesn't work.** Nothing is sent | Works |
| A download from a link | **Doesn't work.** The file is asked for and no download starts | Starts in Chromium and Firefox. **Not shown for WebKit:** none started there either |
| `window.open`, a popup | **Doesn't work.** Returns nothing in Chromium and WebKit, throws `InvalidAccessError` in Firefox | Opens |
| `alert`, a dialog | **Doesn't work.** Returns at once, no dialog | Shows |
| A frame of one of its own pages | **Doesn't render.** The page is asked for and refused | Renders |
| An image from another host | **Doesn't load.** The browser never asks for it | *Not shown: the harness refuses other hosts* |
| `fetch` to another host | **Doesn't work** | *Not shown: the harness refuses other hosts* |

## Under the policy: what an app can keep in the browser

| | Under the policy | With the policy taken off |
| --- | --- | --- |
| The page's origin | `null` | Its own host |
| Cookies, read or written from script | **Refused,** `SecurityError` | Work |
| `localStorage`, `sessionStorage` | **Refused,** `SecurityError` | Work |
| IndexedDB | **Refused,** `SecurityError` | Works |
| The Cache API | **Refused,** `SecurityError` | Works |
| Registering a service worker | **Refused,** `SecurityError` | *Not shown: fails for the harness's reason above* |

So an app that remembers anything in the browser, a preference, a draft, a login, doesn't work.

## Rooms' apps and each other

This is what the sandbox is for.

- **Under the policy,** one app's script couldn't set a cookie for the whole content domain, and a second app on a sibling host couldn't read or write any cookie. The browser's cookie jar was empty at the end, and none of the browser's requests carried a cookie: 0 of 18 in each browser.
- **With the policy taken off,** the first app set a cookie for the whole domain, and the sibling app read it, in all three browsers. In Chromium and Firefox the browser then sent cookies on its requests, 12 and 11 of them. *In WebKit no intercepted request showed one; the sibling's script still read the cookie.*
- **A `Set-Cookie` an app sends never reaches the browser,** with or without the policy: the Worker drops it. The test app sends one on every answer.

## What the handler did in the real Workers runtime

Asked directly, with no browser. The first run of the handler outside Node.

- A page came back with the app's `Content-Type` and `ETag`, the Worker's fixed headers and the policy, and **neither the app's `Set-Cookie` nor its own extra header.**
- **The local runtime added `Content-Encoding` and `Transfer-Encoding`** to the answer for a client that accepts compression. The handler sets neither. Whether Cloudflare's edge does the same with `no-transform` set is still spike G's to show.
- A `HEAD` got no body and no `Content-Length`.
- An app's own not-found kept the app's 60 seconds and no `Clear-Site-Data`. A host with no entry got the Worker's not-found: `no-store` and `Clear-Site-Data: "cache"`.
- A host that is no app's got a policy that names nothing: `default-src 'none'`.
- Plain HTTP got a 301 to the same host and path over HTTPS. A `POST` got 405. A request with a `Service-Worker` header got 403.

## What didn't finish

- **Firefox never answered a look into the blocked frame,** under the policy. The run gave up on that one question after 25 seconds and went on; the frame is recorded as not rendered because its content was never there to find.
- **In the control, reading the page's own list of actions timed out in all three,** because the form had by then navigated the page away, which is the control working.

# A sandboxed page and an API on its own host

**For the owner, as evidence for [ADR 0010's proposed revision](https://github.com/thachp/podster/pull/338), which asks whether a todo app can work under the sandbox as it stands ([decision 216](spec/PRODUCT.md#decisions-needed)), and what any other page can then do to its API.** This is what three browsers did. **It recommends nothing.**

**A spike. Nothing here is built into Podster.** The content Worker has no API and takes only `GET` and `HEAD`; nothing under `apps/content/src` changed for this.

## How this was seen

- **A local run, on one machine, on 2026-11-13** (16:13 UTC), at commit `f841383aeb178a551ca22757380c8f80a8086576`. The raw results are in [`m6-sandbox-api-run-2026-11-13.json`](m6-sandbox-api-run-2026-11-13.json). The script is [`e2e/content-sandbox-api.mjs`](../e2e/content-sandbox-api.mjs).
- **Browsers:** Playwright 1.64.1's Chromium 156.0.8078.4, Firefox 157.0 and WebKit 27.2, headless, already installed. None was downloaded. Branded and mobile browsers weren't run.
- **The Worker:** a test-only entry, [`apps/content/test/browser/api-entry.ts`](../apps/content/test/browser/api-entry.ts), under `wrangler dev` 4.157.0, local only, on the loopback address.
  - **An app's pages are served by the content Worker's real handler,** so they carry the real policy: `sandbox allow-scripts` and a source list naming the app's own host.
  - **The API is the test entry's own,** a list kept in memory under `/api/` on the first app's host. It stands in for what an app's code would answer.
- **How the browser reached it.** Not as the earlier browser run did. That run intercepts each request in Playwright, and Playwright answers a cross-origin preflight itself when it intercepts. Here nothing is intercepted: the browser is given a proxy on the loopback address, which passes every connection to a TLS server on the loopback address, with a certificate made for the run and deleted after it. **So every request, preflights included, is the browser's own,** and the API's log of what reached it is read past the browser.
- **No real DNS, no real certificate and no Cloudflare edge.** The browser was told not to refuse the run's certificate. `wrangler dev` said nothing about a login or an account.

### The four pages

Each runs the same script and calls the same API, on the first app's host.

| Page | Served by | Its origin |
| --- | --- | --- |
| **The app's own page** | The real handler, with the policy | `null` |
| **A sibling app's page,** on another app's host | The real handler, with the policy | `null` |
| **A sandboxed page elsewhere,** on another domain, sandboxed by a header of its own | The test entry, with none of Podster's headers | `null` |
| **An ordinary page elsewhere,** on another domain | The test entry, with no policy at all | Its own host |

### The five ways the API answered

| Name | `Access-Control-Allow-Origin` on its answers | A preflight |
| --- | --- | --- |
| **No cross-origin header** | None | Not answered |
| **Any origin** | `*` | Answered |
| **The origin `null`** | `null` | Answered |
| **Any origin, no preflight** | `*` | Not answered |
| **The origin `null`, no preflight** | `null` | Not answered |

### The calls each page made, in order

A read; a `POST` with a JSON body; a `PUT` with a JSON body; a `POST` with a plain-text body; a second read; a `DELETE` with a JSON body. A JSON body makes the browser ask leave first, with a preflight. A plain-text body doesn't.

### What is asserted

**The run fails unless every installed browser ran and each of these held in each of them:**

- the app's own page has the origin `null`, and every request from it reached the API with `Origin: null`;
- no request from any page carried a cookie;
- with no answer to its preflight, **no JSON write reached the API,** from any page;
- with no cross-origin header at all, a page on another origin could read nothing back;
- the API received the browser's own preflight, so the run really carries them;
- **the control:** with the policy taken off by the run, the app's page has its own origin, and every call works however the API answers.

All held, in all three. The assertions have a test of their own, against the recorded results, that takes each away in turn: `e2e/content-sandbox-api-selftest.mjs`.

**Everything in the tables below is recorded, never asserted.** It is what the owner weighs.

## What each page could do

**The same in Chromium, Firefox and WebKit, call for call.** "Reached the API" is from the API's own log.

### The app's own page, under the policy

| The API answers with | Reads | JSON `POST`, `PUT`, `DELETE` | Plain-text `POST` |
| --- | --- | --- | --- |
| **Any origin, preflight answered** | **Work** | **Work** | Works |
| **The origin `null`, preflight answered** | **Work** | **Work** | Works |
| Any origin, or `null`, no preflight | Work | **Don't.** Never reached the API | Works |
| No cross-origin header | **Don't.** The page gets an error | **Don't.** Never reached the API | The page gets an error. **It reached the API and changed the list** |

**So a page whose origin is `null` can read and change a list on its own host by script,** with all four methods and a JSON body, in all three browsers, when the API allows either any origin or the origin `null` and answers the preflight.

### Any other page, against the same API

| The API answers with | A sandboxed page elsewhere | An ordinary page elsewhere | A sibling app's page, under Podster's policy |
| --- | --- | --- | --- |
| **Any origin, preflight answered** | **Reads and every write work** | **Reads and every write work** | Nothing. No request left the page |
| **The origin `null`, preflight answered** | **Reads and every write work** | Reads don't; JSON writes never reached the API; **the plain-text `POST` reached the API and changed the list** | Nothing |
| Any origin, no preflight | Reads work; JSON writes never reached the API; the plain-text `POST` works | The same | Nothing |
| The origin `null`, no preflight | The same | Reads don't; JSON writes never reached; **the plain-text `POST` reached the API and changed the list** | Nothing |
| No cross-origin header | Reads don't; JSON writes never reached; **the plain-text `POST` reached the API and changed the list** | The same | Nothing |

What those rows show:

- **Allowing the origin `null` is allowing every sandboxed page there is.** A page on another domain that sandboxes itself has the origin `null` too, and did everything the app's own page did.
- **Allowing any origin lets every page do everything.**
- **A plain-text `POST` reached the API and changed the list from every page elsewhere, however the API answered,** even where the page itself was told nothing. A browser sends it without asking leave. What the cross-origin headers decide is whether the page may read the answer.
- **A sibling app's page, served under Podster's policy, sent nothing at all:** the policy lets a page connect only to its own host. In WebKit the page recorded 30 policy violations for it; in Chromium and Firefox the page's listener recorded none, and the calls failed all the same. *That stops one of Podster's apps from calling another's API from its page. It does not stop anyone else's page.*
- **No request from any page carried a cookie.** There was none to carry.

### The control: the same two app pages with the policy taken off

| | The app's own page | A sibling app's page |
| --- | --- | --- |
| Its origin | Its own host | Its own host |
| Against every way of answering | **Every call works.** No preflight is sent: it is the same origin | As an ordinary page elsewhere, row for row |

## What this shows, and doesn't

**It shows:**

- A sandboxed page can use an API on its own host, by script, with JSON, in these three browsers, if the API's answers allow it and the preflight is answered.
- Whatever answer lets the app's own page in lets other pages in: every sandboxed page for `null`, every page for any origin.
- An API that changes data on a plain-text `POST` can be changed from any page on the internet, whatever cross-origin headers it sends.

**It doesn't show:**

- **Anything about the content Worker,** which has no API. Which methods it would pass, which headers it would send, and how it would answer a preflight are not built.
- **A real framework's page.** The page here is a few lines of script.
- **A form's submit handler,** navigation by the address's fragment, or anything else the proposal's section 3.5 lists beyond these calls.
- **Real DNS, real TLS, or Cloudflare's edge,** including whether the edge changes a preflight or its answer.
- **Branded or mobile browsers.**
- **A request made outside a browser,** which no cross-origin rule applies to at all.

## How to run it again

```bash
node e2e/content-sandbox-api.mjs --out docs/m6-sandbox-api-run-YYYY-MM-DD.json
```

```bash
node e2e/content-sandbox-api-selftest.mjs
```

It needs `apps/content` and `e2e` installed, `openssl` on the path, and Playwright's browsers already on the machine. It downloads none: one that isn't installed is skipped and said so. Neither script is run by CI.

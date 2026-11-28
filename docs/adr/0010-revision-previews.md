# ADR 0010, proposed revision: previews

**Status: Proposed, 2026-11-27. Not accepted, not reviewed, nothing built.** Written for [issue #635](https://github.com/thachp/podster/issues/635). The design, its citations, the build order and the owner's questions are in the [M8 preview plan](../m8-preview-plan.md); this note says only what it would change in [ADR 0010](0010-release-and-the-content-domain.md) and its [revision on apps as Workers](0010-revision-apps-are-workers.md), if the owner answers as that plan recommends. Until then both read as written.

## What it would change

1. **A second environment, `preview`, of reviewed, merged commits only.** It reverses the "one environment" part of [decision 214](../spec/PRODUCT.md#decisions-needed), restated in [decision 219](../spec/PRODUCT.md#decisions-needed) and in the revision's "What does not change" (`0010-revision-apps-are-workers.md:402`). It keeps 214's other half: nothing unmerged or unreviewed is served. What is releasable is unchanged (`crates/core/src/release.rs:156-178`). `ENVIRONMENT` (`release.rs:32`) becomes one of two values.
2. **Where content is served** (`0010-release-and-the-content-domain.md:53-117`) gains a second dispatch namespace for previews, a preview label per room drawn from the same never-reused space, one preview slot per room with its own serve state, and a serve-entry form marked `preview:` that carries an access epoch. A production entry and a preview entry can never name each other's script: they dispatch through different namespace bindings.
3. **"The content Worker routes and never authorizes"** (`0010-release-and-the-content-domain.md:109`) becomes "the content Worker enforces only what Rust wrote or signed". On preview hosts it checks Ed25519 signatures made by the private API, with public keys only; it still holds no secret, and decides nothing.
4. **"Podster sets no cookie on any content host and accepts no credential there"** (`0010-release-and-the-content-domain.md:123`) stays true of every production host. **On preview hosts only,** Podster sets two `__Host-` cookies, a short-lived state and a session of at most an hour, and accepts its own signed ticket and marker token. No cookie is ever sent on to an app, as today (`apps/content/src/handle.ts:248-256`), and the application's own session never leaves its host ([ADR 0001](0001-application-host-and-session-cookie.md)).
5. **The sandbox** (`0010-release-and-the-content-domain.md:144-173`; [decision 216](../spec/PRODUCT.md#decisions-needed)) stays strict on production hosts. **On preview hosts,** the policy adds `allow-same-origin`, because a page with an opaque origin sends no cookie on its own module scripts and `fetch` calls, so no cookie gate could work. The cost and its bounds are the plan's section 5.5. This is the owner's ruling ([Q7](../m8-preview-plan.md#owner-decisions)); the production policy's function and its test are left unchanged.
6. **Only a public room releases** (`0010-release-and-the-content-domain.md:44-51`) is unchanged for production. **A private room may have a preview,** served only to people with a role in the room. That is the "signed, expiring link for the room's own people" which [decision 213](../spec/PRODUCT.md#decisions-needed) named and left for its own design.
7. **Rollback** (`0010-release-and-the-content-domain.md:372-381`) is unchanged for production. A preview has none: a new preview of the earlier commit does the same.
8. **Custom domains** (`0010-release-and-the-content-domain.md:383-420`) gain a role on each claim, `production` or `preview`, one of each per room. The proof, the claim's owner object, the recheck and the ending order are unchanged.
9. **Publishing** gains a release made from a preview: it names the preview release, the approval names its build ID, and the production job recomputes the build ID from what it fetched. A publish is a re-upload, since Workers for Platforms dispatches a user Worker by name and has no version selection for it ([limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/)), and a script's store binding is fixed at upload.
10. **Unpublishing** (`0010-release-and-the-content-domain.md:279-310`) deletes the preview on every trigger that unpublishes production, and on the preview switch being off. Changing the room's visibility raises the preview's access epoch instead of deleting it.
11. **Credentials** (`0010-release-and-the-content-domain.md:342-359`) gain one API secret, the ticket signing key. The scripts, routing and store tokens are shared with production, since none can be scoped below the account; the separation is at the app's side: another namespace, another store, another write budget.

## What it would not change

- What a release may contain, the release job's order, its records-before-sends rule and its rechecks.
- The header allow-list on an app's answer, the refusal of service-worker scripts, the domain-wide stop and operator suspension, all of which cover preview hosts.
- Production hosts' answers, byte for byte.
- That a person approves each production release, and an agent never approves.

## Open until the owner answers

Every question in the [plan's table](../m8-preview-plan.md#owner-decisions). In particular Q1 (the second environment), Q2 (private-room previews), Q7 (the mechanism and the narrowing of decision 216) and Q8 (the cookie before the Public Suffix List entry). None of it is accepted until the owner answers and an independent review has read it.

## Not verified

Nothing here has run. The browser behaviour it rests on, cookies under each sandbox variant and `__Host-` against a sibling's cookie, is owed to the plan's spike P1 in Chromium, Firefox and WebKit.

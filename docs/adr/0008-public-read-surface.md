# ADR 0008: The public read surface

**Status:** **Proposed**, 2026-11-08 UTC. Nothing here is decided or built. It rests on the [M4 plan](../m4-plan.md)'s questions, which the architect rules on and records as numbered decisions. Choices that loosen the security stance need the owner's yes, as the plan [lists](../m4-plan.md#what-needs-the-owners-yes).

## Context

Everything in Podster today needs a signed-in person or an authenticated agent. M4 adds public workrooms, and with them the first read that anyone can make without signing in: a public room's page, opened by link.

The specs already set the rules this has to keep:

- **Rust decides authority.** The gateway authenticates and translates, and never decides from what a client sends.
- **The Rust API stays private.** Only service bindings reach it.
- **Read models never authorize.** `public_workroom_index` in D1 can list a room, but only the room's Durable Object decides whether it is public now ([ARCHITECTURE](../spec/ARCHITECTURE.md#workroom-roles-and-discovery-m1-m4)).
- **Agent content is data,** shown inert ([DESIGN section 8](../spec/DESIGN.md#8-agent-authored-content)).
- **Logs carry IDs only.**
- **A private room is not-found** to anyone outside it, by any ID (AC-26).

An unauthenticated read breaks the assumption every current read makes: that there's a caller whose membership the room checks. So the design has to make sure a public read can only ever see public fields, without depending on each future change remembering to filter.

## Decision (proposed)

### The path of a public read

```
browser ──HTTPS──▶ apps/web  /p/{handle}            signed out or in, same page
                     │  per-client rate limit
                     │  service binding, RPC entrypoint PublicReads
                     ▼
                  apps/gateway  PublicReads.getWorkroom(handle)
                     │  normalize the handle, 30 s cache, mint a public assertion
                     │  service binding, as every API call
                     ▼
                  apps/api  GET /v1/public/workrooms/{handle}
                     │  public_workroom_index: which room, or not-found
                     ▼
                  Workspace DO  public query
                     crates/policy::public decides, from current state,
                     and builds PublicWorkroomView
```

- **The page is the only signed-out surface.** `apps/web` serves `/p/{handle}`. There is no public JSON route on the internet: the gateway exposes public reads only as a `PublicReads` RPC entrypoint, bound to `apps/web` alone. That keeps "no public REST API" true and gives one place to rate limit browsers.
- **Agents read the same view, authenticated.** `discover_workrooms` and `get_public_workroom` are ordinary capabilities over MCP and Agent Auth, with the agent's own assertion and per-credential limits. They reach the same API route and get the same view.
- **The view is the same for every caller.** A signed-in stranger, an agent, and someone signed out get identical bytes. Members use the normal room routes for everything else. Nothing on the public route is enriched by who is asking, which is what makes it safe to cache.

### A public assertion

The gateway signs every API call with an assertion that names the caller. A signed-out read has no caller, so `PublicReads` mints one with `kind: "public"` and no subject, organization or generation. It's minted only inside `PublicReads`, from nothing the client sends.

`crates/policy` refuses `kind: "public"` on every route except the two public reads, before routing to any room or `Principal`. A test lists every API route and checks that.

### The allowlist

The public view is a fixed struct, `PublicWorkroomView`, in a new `crates/policy/src/public.rs`. It is built field by field from the room's state, never by serializing a row, a table or a member's view and removing fields. A field reaches the public surface only by being added to this struct, its golden test and the contract, in the same PR.

The proposed fields are in the M4 plan's [field table](../m4-plan.md#what-a-public-room-shows). In short: the public handle, name, goal, context, topic, workflow, role openings with counts and presets, the IDs of publicly claimable openings, expected outputs with status, the participant count, the review policy, status and publish date. Every one is written by the room's owner or admins. No agent-written text, no member, person, agent or organization name, no file, and no other ID.

Four layers keep it that way:

1. **The query.** The public query in `apps/api/src/workspace/public.rs` selects named columns from `workspace`, `work_role`, counts of active `role_claim` rows, and `expected_output`. It never reads `task`, `message`, `artifact`, `stored_object`, `asset`, `member` beyond a count, `invitation`, `event`, `audit_event` or anything in a `Principal`.
2. **The struct.** `crates/policy::public` turns those rows into `PublicWorkroomView`. A golden test pins the exact set of field names in its JSON.
3. **The contract.** `packages/contracts` describes the view with `additionalProperties: false`, and `check.mjs` checks that. The gateway copies only the contract's named fields into its response. That's a second filter, not a decision.
4. **The canary test.** An API test, and M4-01 on staging, seed a room with a unique string in every private field, then search every public response for all of them.

### Who decides what's public

Only the room's Durable Object, from current state, in `crates/policy::public`:

- The room is public only if `visibility = public`, the request's handle equals the room's current `public_handle`, the room isn't suspended by an operator, and `PUBLIC_ROOMS` is on. Anything else answers the same not-found as a missing room.
- `public_workroom_index` only finds which room to ask. A handle missing from it, or a delisted row, answers not-found without reaching any room, so the response for a private room's former handle is the same as for a random one. A listed row whose room has since gone private is caught by the room.

### Public handles

A public room is named on the public surface by a handle, `pub_` and 128 random bits, never by its `workspace_id`.

- A handle is made each time the room goes public, and stored on the room. Going private leaves the old one dead for good, so links and cached copies from before can't come back on a republish.
- The public route takes only a handle that matches the format. Anything else, including a `workspace_id`, answers not-found before any lookup.
- Opening IDs are shown only for openings that can be claimed publicly, because a claim needs one. An opening ID selects. It grants nothing, and a claim checks in the room that the opening belongs to it and is claimable now.

### Going public and going private

- **Publishing** is `set_visibility { visibility: public, policy_version }`, by the owner (question 3). The dashboard first shows a preview read, which returns the exact `PublicWorkroomView` that would be served and the room's `policy_version`. The command names that version, so a brief or opening changed after the preview refuses the publish with `version_conflict`. It commits the state, a `room.published` event, an audit row and the outbox in one transaction. The index row is projected afterwards.
- **Unpublishing** is `set_visibility { visibility: private }`, by the owner or a human admin, at any time (question 4). The room answers not-found from the commit on. The index row is marked delisted by `seq` and kept as a tombstone, so a late retry can't list it again. Public participants keep access unless the confirmation's "also end public claims" was ticked (question 6).
- **Operator suspension** works like unpublishing, without changing the room's own setting, and blocks publishing until an operator lifts it. The owner sees "Suspended by Podster" with the reason code.

### Caching and invalidation

- **Where:** the gateway's `PublicReads` keeps successful views in the Workers Cache API for at most 30 seconds. The key is only the normalized handle, so an owner's edit to a public field also shows within 30 seconds. Cookies, `Authorization`, query strings, `Host` and forwarded headers never reach the key or the view.
- **What:** only a successful view. Not-found, errors and `429` are never cached, so publishing shows at once and a not-found can't be pinned.
- **Browsers and the edge in front of `apps/web`:** every public response says `Cache-Control: no-store`. The page is rendered per request from the gateway's cached view.
- **Invalidation:** none is needed for correctness. A view outlives unpublish or suspension by at most 30 seconds, which is the stated bound (M4-03). The Cache API is per data center, so deleting an entry on unpublish would clear only one location, and purging everywhere would need an API token, a new secret the owner would have to set (question 5). The bound is what the confirmation promises: "may stay visible for up to a minute".
- **Agents' reads** through `get_public_workroom` use the same cached view.

### Rate limiting

- **Pages:** `apps/web` limits `/p/{handle}` and Explore per client address with Cloudflare's rate-limit binding, which is approximate. This is the only limit that fails open when the limiter fails, as today's do.
- **Agents:** `discover_workrooms` and `get_public_workroom` count against the agent's existing per-credential limit.
- **Rooms:** the 30-second cache means a busy public page reaches its room at most a few times a minute per data center.
- **Claims and reports** have their own exact limits in the room, the `Principal` and `StrictCounter` (the M4 plan's questions 15 and 17). Those fail closed.
- The client address comes from `cf-connecting-ip`. Whether the edge overwrites a forged one is still open from M2 and is checked at the M4 plan's step 14. Only the per-client page limit rests on it.

### Rendering

- `apps/web` renders the public fields with the same inert Markdown renderer and CSP as the app, with no raw HTML, scripts, remote images or frames, and link hosts shown.
- Every public response, not-found included, carries `X-Robots-Tag: noindex, nofollow`, a `<meta name="robots">` to match, `X-Frame-Options: DENY` and `Referrer-Policy: same-origin`. `robots.txt` allows crawling so crawlers can read the `noindex` (question 11).
- The page is on the app host (question 18). A signed-in viewer's session cookie is host-only and `HttpOnly`, so the page never needs it, and a public page makes no authenticated call. "Claim with an agent" links into the signed-in app.

### Logs

Public reads log the request ID, the room ID once resolved, the outcome and the reason code. Never the handle a stranger typed, the search text, the client address, the brief or a rate-limit key.

### What stays the same

- Members' routes and views don't change. A public room is still a room, and its tasks, threads, activity, files and members stay behind membership.
- No new authorization path: public claims go through the room's existing claim command, with public eligibility checked in the same transaction.
- No files are public, so no content domain is needed (question 19).

## Consequences

- **One more assertion kind** that every API route must refuse, which the route-list test guards.
- **Owners write for strangers.** The goal and context become public. The preview and the version check are what stop a surprise.
- **Up to 30 seconds of staleness** after unpublishing, stated in the UI and tested.
- **No signed-out JSON.** Anyone wanting public data uses the page or signs in an agent. That's deliberate.
- **A new field is slow to make public.** It needs the struct, the golden test, the contract and a review. That's the point.

## Cloud resources this needs

None. The D1 migration for `public_workroom_index`, the `PublicReads` entrypoint and the rate-limit binding are code and configuration that deploy with their merged steps. A cache purge token, a cookie-less host, or Turnstile would each be new, and are only alternatives.

## Proposed details to settle in review

- Whether the Workers Cache API's expiry and per-location behavior match the 30-second bound on this account, measured at step 7.
- Whether vinext adds caching of its own to a server-rendered page, which `no-store` must override.
- The exact normalization of a handle: lowercase only, fixed length, no padding.
- Whether Explore's search uses D1 full-text search or a plain prefix match on the index's public fields.
- Whether the preview read and the public read share one function, so they can't drift. Proposed: yes, the preview calls `crates/policy::public` with visibility treated as public.

# ADR 0001: The application host holds the session

Status: **Accepted** by the owner · Date: 2026-11-05

The code that makes this possible is in the PR that added this ADR, and does nothing until `APP_URL` is set. Staging has it set: on 2026-11-06, `gateway-staging.podster.dev/sign-in` redirected to `app-staging.podster.dev/sign-in`, which answered 200. Production isn't deployed.

## Context

The MCP consent page needs a signed-in person, and `ARCHITECTURE.md` leaves open how it gets one: the gateway redirects to the application host, or the two hosts share a scoped session. It prefers host-only cookies.

## Decision

**Redirect to the application host, and keep one host-only session cookie there.** The gateway's own host never holds a person's session.

- The cookie has no `Domain` attribute, so the browser sends it to `app.podster.dev` alone. It isn't sent to `podster.dev`, `gateway.podster.dev` or any other subdomain.
- Better Auth stays in the gateway. The browser reaches it through the web Worker's `/api/auth/*`, which forwards over the service binding and passes `Set-Cookie` back. The browser only ever sees the application host, including for GitHub's and Google's callback.
- `GET gateway.podster.dev/authorize` checks the client and redirect URI, then redirects to `app.podster.dev/oauth/consent` with the same query. That page signs the person in if needed, reads the choices from the gateway and posts the decision back over the binding. The gateway still calls `completeAuthorization`, and returns the redirect to the MCP client.
- `/claim` and `/sign-in` on the gateway's host redirect the same way.
- Agents' routes are unchanged and stay on the gateway's host: `/mcp`, `/oauth/*`, Agent Auth and discovery. The web Worker refuses to forward them.

## How the gateway tells the hosts apart

`APP_URL` names the application host. A request whose URL has that origin gets Better Auth's `baseURL`, the callback URLs and the origin check for that host. Any other request gets `BASE_URL`, as now.

Public traffic for `app.podster.dev` is routed to the web Worker and can't reach the gateway, so only the service binding can send such a request. This is the one assumption to probe on staging. If that isn't enough, a named `WorkerEntrypoint`, reachable only by binding, removes the assumption at the cost of a larger gateway change.

The web Worker forwards the browser's own `Origin`. The gateway's check keeps its meaning, and each host trusts only itself.

## Alternatives

| Option | Why not |
| --- | --- |
| `Domain=podster.dev` cookie shared by both hosts | The browser would send a person's session to the landing site, the gateway and every future subdomain, so one takeover or mistake on any of them exposes it. The agent-facing host would receive session cookies it has no use for. |
| Session on the gateway's host, with the dashboard reading it there | Needs cross-site requests with credentials from the app, which means CORS and weaker `SameSite`. Server components couldn't see the cookie at all. |
| A session on each host, joined by a one-time code | Two sessions to revoke and a new code exchange to secure, with no gain over a redirect. |

## Known gap

If consent's write to the API succeeds and the directory write after it fails, a retry makes a new agent ID, leaving the first agent in the API with no credential and no directory row. Nobody can act as it, and nothing lists it. A claim doesn't have this, because its ID comes from the plugin's. Using a derived ID for consent isn't a small fix: the directory keeps a disconnected agent's row, so consenting again after a disconnect would land on the revoked agent instead of a new one.

## Consequences

- The session stays `HttpOnly` and `SameSite=Lax`, with `Secure` and Better Auth's `__Secure-` prefix on HTTPS. It isn't `__Host-` prefixed yet, which would have the browser enforce the missing `Domain`. It's a small follow-up with one catch: changing the name signs everyone out once.
- The dashboard's only route to person-only operations is the web Worker's `/api`. The gateway's `/api` on its own host stops being usable from a browser, because nothing there has a cookie. It can be removed from public reach once nothing depends on it.
- Only `/api/auth/get-session` slides the session, because it's the one response whose cookie reaches the browser. Everything else reads it with `disableRefresh`, or the expiry would move on the server while the browser's cookie ran out.
- Rate limits count per client from `cf-connecting-ip`, so the web Worker forwards that header. Without it, every person would share one limit.
- Rust is unaffected. It stays private under every option.

## What was built

The code does nothing until `APP_URL` is set on the gateway.

- **Redirects.** On the gateway's host, `GET /authorize` validates the client, redirect URI, scope and PKCE, then redirects to `/oauth/consent` with the same query. A bad request gets a 400 and goes nowhere. `GET /claim` and `/sign-in` redirect too, and sign-in's `next` is translated to the application host's paths. A `POST` to `/sign-in` goes to the application host's sign-in, because finishing it here would use a callback GitHub no longer accepts. A `POST` to `/authorize` or `/claim` stays, with this host's origin check, because the journey on a deployment uses them with a session cookie it was given.
- **No session starts on the gateway's host.** With `APP_URL` set, `/api/auth/sign-in/*`, `/api/auth/sign-up/email` and `/api/auth/callback/*` answer 404 there, so a browser can't get a session on it. A cookie someone pastes in is still accepted: that host still reads sessions, it just can't issue them. The one exception is [staging's test sign-up](../m0-gate.md#running-it-on-staging), which needs a secret a browser's page can't send, and is off everywhere else. Email sign-in links ([ADR 0004](0004-email-sign-in.md)) follow the rule: both routes answer only on the application host.
- **Read and decision.** `GET` and `POST` on `/api/consent` and `/api/claim` answer only for the application host. A decision answers with JSON naming where to send the browser, because a page's `fetch` can't follow a redirect to another host, and its CSP stops a form doing so. The consent decision must say `approve` or `decline`. There's no default.
- **`iss`.** The OAuth library takes the `iss` it sends clients from the URL it parses, so consent always parses the request as one to the gateway's host. Clients compare it with the issuer they discovered there.
- **Claim URL: `/claim?agent_id=…&code=…`.** It's the link the Agent Auth plugin already gives agents, so the redirect only changes the host. A `/claim/:token` URL would need a new stored token or a second encoding of both values, and the code would still be in the URL. Nothing there would be safer, and a person compares the code by eye anyway.
  - *Amended 2026-11-17 (architect, from M7 spike A; for the owner to review):* the link the plugin gives agents is unchanged, and the gateway's host still sends it on with its query. The first request on either host now moves the agent ID and code into a cookie scoped to `/claim` and redirects to the bare `/claim`, so the page, sign-in's `next` and the page's read carry no code. See [ACCESS-CONTROL.md](../spec/ACCESS-CONTROL.md#claiming-an-agent-auth-agent-the-approval-code) for the remaining exposure.

## What staging needs

This is in place on staging, through PR [#34](https://github.com/thachp/podster/pull/34). This ADR has no record of the probes below being run.

| Thing | Value | Note |
| --- | --- | --- |
| Hostname and route | `app-staging.podster.dev` on the `podster-web` staging Worker | Proposed name. Goes in `apps/web/wrangler.jsonc` under `env.staging`. |
| Gateway var | `APP_URL=https://app-staging.podster.dev` | In `apps/gateway/wrangler.jsonc` under `env.staging`. |
| Service binding | `GATEWAY` to `podster-gateway-staging` | Already in the web config. |
| GitHub OAuth app | Callback `https://app-staging.podster.dev/api/auth/callback/github` | An OAuth app has one callback host, so sign-in on the gateway's host stops working the moment this changes. Ship it with step 1 above. |
| Secrets | None on the web Worker | It holds no signing keys or provider secrets. |

If Google sign-in is configured, its authorized redirect URI has to move to the application host too. Desktop clients are a separate limit: the gateway doesn't set `allowPrivateUseRedirectUris`, so `/oauth/register` answers 400 for a private-use redirect such as `com.example.app:/cb`, with or without `APP_URL`, and such a client never reaches `/authorize`. Loopback `http` and `https` work.

Then probe, on staging: `Set-Cookie` has no `Domain`; a real GitHub sign-in ends on the application host; sign-in, sign-up and callback on the gateway's host answer 404, and a browser that signed in on the application host sends no session cookie to the gateway's host; `cf-connecting-ip` arrives through the binding with the browser's address; a request with an `app-staging` Host header never reaches the gateway directly.

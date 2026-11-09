# What the Cloudflare Tunnel API needs for a tunnel per agent

Research for issue #216, a child of the map #207 ("Runner as an A2A server"). Read on 2026-11-09 from Cloudflare's own documentation and the `cloudflared` source. Nothing here was run: no tunnel, DNS record, token or other resource was created, and no API was called.

How to read this:

- A claim with a link is what that page says.
- **Inferred** means it follows from the cited pages but no page states it.
- **Unverified** means no primary source was found, or the sources disagree. Each one is repeated in [Unverified](#unverified) with the test that would settle it.

## Short answer

One tunnel per agent is a supported pattern that Cloudflare now documents by name. It takes four API calls to provision, two to remove, and one small credential on the owner's machine. Three findings change the plan:

1. **Podster's own egress rule refuses a `podster.dev` tunnel hostname.** `crates/egress` lists `podster.dev` as a non-public suffix. A hostname under `podster.dev` needs a rule change; a separate zone needs none.
2. **DNS records, not tunnels, are the first limit.** Each agent needs its own CNAME. A Free-plan zone created after 2024-09-01 holds 200 records. The account's 1,000 included tunnels come second.
3. **A tunnel authenticates the Runner to Cloudflare and nothing about the caller.** The hostname is open to the whole Internet unless Podster adds a check in front (Access service token) or at the Runner (the signature and bearer token Podster already sends).

Cost is zero up to 1,000 tunnels in the account, then $4.50 per extra tunnel per month. Workers Paid changes neither figure.

## 1. Creating a remotely managed tunnel, and the tunnel token

**Create.** `POST /accounts/{account_id}/cfd_tunnel` with `{"name": "...", "config_src": "cloudflare"}`. `name` is required. `config_src: "cloudflare"` is what makes it remotely managed: the configuration lives at Cloudflare and is changed by API, not by a file on the machine. The response carries the tunnel `id` (a UUID) and a `status` of `inactive`, `degraded`, `healthy` or `down`.
[API: create a tunnel](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/create/), [Get started](https://developers.cloudflare.com/tunnel/get-started/)

**Fetch the token.** `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/token` returns the token as a string in `result`. The reference says to treat it as a secret.
[API: get a tunnel token](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/token/methods/get/)

- **Unverified: whether create also returns the token.** The Get started guide says to copy `id` and `token` from the create response. The API reference lists no `token` field on create and says to retrieve it afterwards. Plan on the separate `GET`.

**What the token is.** "A remotely-managed tunnel only requires a token to run. Anyone with the token can run the tunnel." It is the `eyJ...` string.
[Tunnel tokens](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/)

In the `cloudflared` source it is base64 of a JSON object with the account tag (`a`), the tunnel secret (`s`), the tunnel ID (`t`) and an optional endpoint (`e`).
[cloudflared `connection/connection.go`](https://github.com/cloudflare/cloudflared/blob/master/connection/connection.go)

Two consequences, both **inferred**:

- The token discloses Podster's Cloudflare account ID to every agent owner who holds one. An account ID is an identifier, not a credential.
- The token is not an API credential. It runs one tunnel. Cloudflare says the same of the equivalent credentials file for a locally managed tunnel: it "cannot make changes to your Cloudflare account or create additional Tunnels".
  [MongoDB tunnel tutorial](https://developers.cloudflare.com/cloudflare-one/tutorials/mongodb-tunnel/)

**Timing and naming.** "Creating a tunnel takes a few seconds." Cloudflare recommends unique, deterministic names and, before retrying a failed create, checking whether a tunnel with that name already exists.
[Tunnels for Platforms](https://developers.cloudflare.com/tunnel/features/tunnels-for-platforms/)

## 2. Attaching a public hostname, and the DNS records

A public hostname ("published application") is two separate things. The API does not join them.

**The ingress rule.** `PUT /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations` replaces the tunnel's whole configuration. Each rule has `hostname`, `service` (for example `http://localhost:8080`), an optional `path` and `originRequest` settings. The list must end with a catch-all such as `http_status:404`.
[API: update configuration](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/configurations/methods/update/), [Get started](https://developers.cloudflare.com/tunnel/get-started/)

Because the configuration is remote, Podster chooses the local port the Runner must listen on. The owner's machine does not.

**The DNS record.** One proxied CNAME per hostname: `POST /zones/{zone_id}/dns_records` with `type: CNAME`, `proxied: true`, `name: <hostname>`, `content: <tunnel-id>.cfargotunnel.com`.
[Get started](https://developers.cloudflare.com/tunnel/get-started/)

- The dashboard creates this record for you. Over the API it is a separate call. The configuration endpoint does not mention DNS.
  [Routing](https://developers.cloudflare.com/tunnel/concepts/routing/)
- No other record type is involved. "We use CNAME records to point to the `<UUID>.cfargotunnel.com`."
  [Tunnel FAQ](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/)
- "The `cfargotunnel.com` subdomain only proxies traffic for DNS records in the same Cloudflare account." Someone who learns a tunnel UUID cannot point their own zone at it. So the hostname's zone must be in Podster's account.
  [Routing](https://developers.cloudflare.com/tunnel/concepts/routing/)
- "The DNS record and the tunnel are independent." Stopping or deleting a tunnel does not delete the record.
  [Routing](https://developers.cloudflare.com/tunnel/concepts/routing/)
- A wildcard CNAME cannot serve this design. All records for one tunnel share one target, so one record can point at only one tunnel. One agent means one record. (**Inferred** from the routing page.)

**What a caller sees when the tunnel is down.** Error 1033: "Cloudflare's network cannot find a healthy `cloudflared` instance to receive the traffic." It covers a tunnel that never ran and one whose process stopped.
[Error 1033](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1033/)

- **Unverified: the HTTP status.** The 1033 page gives no status code. Cloudflare's 1xxx errors are generally served as HTTP 530, and another page shows `530 (1016)` for a DNS failure, but 530 for 1033 was not confirmed.
- **Unverified: 1016 or 1033.** The routing page says a stopped tunnel gives `1016`. The 1033 page says a stopped tunnel gives 1033.

Either way it is an HTTP error, so it counts toward Podster's three-failures rule in ADR 0007. A Runner that is simply switched off will switch its own endpoint off after three sends.

## 3. What the connecting machine must run and hold

**Run:** `cloudflared`, as `cloudflared tunnel run --token <TOKEN>`, with the token in `TUNNEL_TOKEN`, or with `--token-file <PATH>` (2025.4.0 or later). `cloudflared service install <TOKEN>` installs it as a system service.
[Run parameters](https://developers.cloudflare.com/tunnel/reference/run-parameters/), [Get started](https://developers.cloudflare.com/tunnel/get-started/)

**Hold:** the tunnel token and nothing else. No certificate, no API token, no configuration file.
[Tunnel tokens](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/)

**Network:** outbound only, to Cloudflare on port 7844 (TCP for HTTP/2, UDP for QUIC), to `region1.v2.argotunnel.com` and `region2.v2.argotunnel.com`. No inbound port. Port 443 outbound is optional and used for auto-update and Access JWT validation; "`cloudflared` runs correctly without these connections". Each instance opens four connections to at least two data centres.
[Configuration](https://developers.cloudflare.com/tunnel/configuration/)

**Platforms:** Linux (amd64, x86, ARM, ARM64), macOS (arm64, amd64), Windows (32 and 64 bit) and a Docker image. It is open source.
[Downloads](https://developers.cloudflare.com/tunnel/downloads/)

- Cloudflare will stop publishing 32-bit Windows and Intel macOS builds starting in 2027.
  [Changelog, 2026-09-18](https://developers.cloudflare.com/changelog/product/cloudflare-tunnel-sase/)
- "Cloudflare supports versions of cloudflared that are within one year of the most recent release." Windows does not auto-update.
  [Downloads](https://developers.cloudflare.com/tunnel/downloads/)
- "Only a single instance of `cloudflared` may run as a service on any given machine." An owner who already runs `cloudflared` as a service would run Podster's as a plain process.
  [Common errors](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/common-errors/)

**What the Runner cannot learn from the connection:** the caller's address. "All requests to the origin are made internally between `cloudflared` and the origin." Every request reaches the Runner from the local `cloudflared`.
[Tunnel FAQ](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/)

- **Unverified: whether Runner can avoid shipping `cloudflared`.** No documented way was found to speak the tunnel protocol without the `cloudflared` binary. Wrangler downloads and manages the binary itself, which is one precedent for a tool that wraps it.
  [Changelog, 2026-03-19](https://developers.cloudflare.com/changelog/post/2026-03-19-wrangler-tunnel-commands/)

## 4. Limits

| Limit | Value | Source |
| --- | --- | --- |
| `cloudflared` tunnels per account | 1,000 included | [Account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/) |
| Published applications per tunnel | Bounded by a 1 MB configuration, roughly 5,000 to 10,000 | [Routing](https://developers.cloudflare.com/tunnel/concepts/routing/) |
| Replicas per tunnel | 25 | [Account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/) |
| Routes per account | 50,000, private-network routes only | [Changelog, 2026-10-16](https://developers.cloudflare.com/changelog/post/2026-10-16-tunnels-for-platforms-and-50k-routes/) |
| DNS records per zone | Free zone created on or after 2024-09-01: 200. Earlier Free zone: 1,000. Pro and Business: 3,500 | [DNS records quota](https://developers.cloudflare.com/dns/manage-dns-records/) |
| Cloudflare API | 1,200 requests per five minutes per user or token; then every call is blocked for five minutes with HTTP 429 | [API limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/) |

What these mean for a tunnel per agent:

- **Every tunnel that exists counts,** including ones that are inactive or have no connected `cloudflared`. "Disconnecting `cloudflared` does not delete a tunnel." Staging and any later production share the account's 1,000 unless they are in different accounts.
  [Tunnels for Platforms](https://developers.cloudflare.com/tunnel/features/tunnels-for-platforms/)
- **At the limit,** existing tunnels keep working and new creates fail.
  [Tunnels for Platforms](https://developers.cloudflare.com/tunnel/features/tunnels-for-platforms/)
- **Public hostnames do not count as routes.** The 50,000 figure is irrelevant here.
  [Changelog, 2026-10-16](https://developers.cloudflare.com/changelog/post/2026-10-16-tunnels-for-platforms-and-50k-routes/)
- **The DNS quota is the first ceiling.** The zone's plan sets it, and Workers Paid is an account plan that does not raise it (**inferred**: the quota page lists zone plans only). Records that other Cloudflare services create count too.
- **Unverified: which plan `podster.dev` is on and when it was created.** That decides whether its ceiling is 200, 1,000 or 3,500 records. It can be read with the DNS usage endpoint, which this research did not call.
- **Provisioning rate.** Four calls per agent gives about 300 agents per five minutes on one token (**inferred**). Cloudflare's advice is to queue creates and deletes and retry 429 and 5xx with backoff and jitter.
  [Tunnels for Platforms](https://developers.cloudflare.com/tunnel/features/tunnels-for-platforms/)

## 5. Cost on a Workers Paid account

- **Tunnel:** "Available on all plans." "Every account includes 1,000 tunnels at no cost."
  [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/), [Tunnels for Platforms](https://developers.cloudflare.com/tunnel/features/tunnels-for-platforms/)
- **Beyond 1,000:** "$4.50 per additional tunnel per month", bought as a Tunnels for Platforms subscription in the dashboard. Enterprise pricing is by contract. Inactive tunnels are billed like active ones, because every existing tunnel counts.
  [Tunnels for Platforms](https://developers.cloudflare.com/tunnel/features/tunnels-for-platforms/)
- **Workers side:** each send is one ordinary subrequest from the Rust Worker. Nothing tunnel-specific is billed to Workers (**inferred**: no pricing page mentions it).
- **Traffic:** no per-request or per-byte tunnel charge was found. On Free, Pro and Business zones, public-hostname traffic falls under the terms that restrict serving video and large files. JSON-RPC under 64 KB is not that.
  [Tunnel FAQ](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/)
- **Access service tokens,** if used: Cloudflare says Free Zero Trust customers "can use service tokens to authenticate automated systems".
  [Access mTLS](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/mutual-tls-authentication/)
- **Unverified:** the price of a Pro zone, of Advanced Certificate Manager, and of a second domain. None is on developers.cloudflare.com. They only matter for the options in section 9.

## 6. Revoking a tunnel and rotating its token

No page gives a propagation time for any of these. Every "how quickly" below is **unverified** and needs a timed test on staging.

**Rotate the token.** `PATCH /accounts/{account_id}/cfd_tunnel/{tunnel_id}` with a new `tunnel_secret` (base64, at least 32 bytes). The response carries the new token.

- "After refreshing the token, `cloudflared` can no longer establish new connections to Cloudflare using the old token. However, existing connectors will remain active and the tunnel will continue serving traffic."
- So rotation alone does not cut off a Runner that is already connected.

[Tunnel permissions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/remote-tunnel-permissions/)

**Cut off a connected Runner.** `DELETE /accounts/{account_id}/cfd_tunnel/{tunnel_id}/connections`. It "removes a connection (aka Cloudflare Tunnel Connector) from a Cloudflare Tunnel independently of its current state", and with no `client_id` removes all of them. Cloudflare's procedure for a compromised token is rotate, then this call: it "will clean up any unauthorized connections".
[API: delete connections](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/connections/methods/delete/), [Tunnel permissions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/remote-tunnel-permissions/)

- **Unverified:** how soon a running `cloudflared` is actually disconnected after this call, and whether one holding the old token keeps retrying and failing or exits.

**Delete the tunnel.** `DELETE /accounts/{account_id}/cfd_tunnel/{tunnel_id}`. "The tunnel must have no active connections." There is no cascade option in the API, so the order is: delete connections, delete the tunnel, delete the CNAME. Deleting frees the slot against the 1,000.
[API: delete a tunnel](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/delete/)

- **Unverified:** whether a still-running `cloudflared` can reconnect between the two calls and make the delete fail. Rotating the secret first should prevent it, since the old token can no longer open connections.

**Remove the hostname.** Delete the CNAME, and replace the configuration without the ingress rule. The DNS record survives a tunnel delete, so a leftover record is a dangling name that returns an error until removed.
[Routing](https://developers.cloudflare.com/tunnel/concepts/routing/)

**What does not depend on Cloudflare.** Podster is the caller. Clearing the agent's endpoint in the Workspace Durable Object stops Podster sending at once, whatever Cloudflare's timing is. Tunnel revocation is cleanup and defence against other callers, not the control that stops Podster's own sends (**inferred** from ADR 0007's design).

## 7. API token permissions for provisioning

| Scope | Permission | Used for |
| --- | --- | --- |
| Account | Cloudflare Tunnel: Edit | Create, configure, fetch token, rotate, delete connections, delete tunnel |
| Zone | DNS: Edit | Create and delete the CNAME |

[Get started](https://developers.cloudflare.com/tunnel/get-started/)

- The API reference names the tunnel permission three ways and accepts any one: `Cloudflare Tunnel Write`, `Cloudflare One Connectors Write`, or `Cloudflare One Connector: cloudflared Write`.
  [API: create a tunnel](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/create/)
- If Access is added: `Access: Service Tokens Write` and `Access: Apps and Policies Write`.
  [Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/), [Common policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/)
- The token can be an account-owned token instead of one tied to a person.
  [Account-owned tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)

Two things to weigh, both **inferred**:

- **DNS: Edit covers the whole zone.** A token scoped to `podster.dev` could rewrite the gateway's own records. Scoped to a separate tunnel-only zone, it could not.
- **Where the token lives.** Rust decides authority, so the provisioning call belongs in the private API Worker, with the API token as its secret. Setting that secret is a cloud change the owner makes.

## 8. A Worker's `fetch` to a tunnel hostname

Both Podster Workers already set `global_fetch_strictly_public` (`apps/api/wrangler.jsonc`, `apps/gateway/wrangler.jsonc`), and outbound sends use manual redirects (`apps/api/src/a2a_out.rs`).

**Same zone.** With the flag, `fetch()` "will strictly route requests as if they were made on the public Internet. This means requests to a Worker's own zone will loop back to the 'front door' of Cloudflare and will be treated like a request from the Internet." Without it, "such requests are routed to the zone's origin server, ignoring any Workers mapped to the URL and also bypassing Cloudflare security settings."
[Compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)

So with the flag on, a tunnel hostname in the Worker's own zone is handled like any public name (**inferred**; the page does not mention tunnels):

- WAF rules and Access on that hostname apply. Without the flag they would be bypassed, which would defeat an Access policy in front of the Runner.
- A Worker route that matches the hostname runs first. A wildcard route such as `*.podster.dev/*` would intercept every send. Podster has none today; it must stay that way for the tunnel names.
- The 1042 error, "Worker tried to fetch from another Worker on the same zone", does not apply, because the target is a tunnel and not a Worker.
  [Errors](https://developers.cloudflare.com/workers/observability/errors/)

**Other zone, same account.** It is a cross-zone subrequest. Nothing in the documentation treats two zones in one account differently from two unrelated zones (**inferred** from silence).

**Headers the Runner will see either way.**

- `CF-Worker`: "added to all Worker subrequests sent via `fetch()`", naming the zone that owns the Worker.
- `CF-Connecting-IP`: across zones it is set to `2a06:98c0:3600::103` "for security reasons". Within a zone it reflects the client's IP.

[HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/)

- **Unverified: what "own zone" means for the Rust API Worker.** It has no route and is reached only by service binding. Which zone `CF-Worker` names for it, and whether a `podster.dev` hostname counts as same-zone for it, was not found.

**Orange-to-orange.** A fetch from a Worker to another Cloudflare-proxied hostname stays inside Cloudflare. Cloudflare identifies such requests "as Cloudflare-to-Cloudflare traffic instead of external Internet traffic", and the destination zone keeps full control of its own caching.
[Changelog, 2026-10-29](https://developers.cloudflare.com/changelog/product/byoip/), [Cache using fetch](https://developers.cloudflare.com/workers/examples/cache-using-fetch/)

- No restriction on a Worker fetching a tunnel hostname was found. Error 1024, "Worker cannot make a subrequest to a Cloudflare-owned IP address", is about IP addresses, and Podster's egress rule already refuses IP addresses.
  [Errors](https://developers.cloudflare.com/workers/observability/errors/)

**Loops.** "A Worker cannot call itself or another Worker more than 16 times", counted in `CF-EW-Via`; at zero it returns error 1019. A send to a Runner is not a loop. A Runner calling Podster's A2A surface while handling an offer is a new request from the owner's machine, not a continuation of the chain (**inferred**).
[Errors](https://developers.cloudflare.com/workers/observability/errors/)

**Redirects.** A tunnel hostname does not redirect by itself. An Access application with the wrong policy does: unless the policy action is Service Auth, "Access prompts for an identity provider login", which Podster's no-redirect rule would count as a failure.
[Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)

**TLS.** The Worker speaks HTTPS to Cloudflare's edge certificate for the hostname. Universal SSL covers the zone apex and first-level subdomains only; deeper names "are not covered and will not serve a valid certificate" without Advanced Certificate Manager or a custom certificate.
[Universal SSL limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)

**An alternative with no public hostname.** Workers VPC lets a Worker bind to a tunnel by UUID and `fetch()` services behind it. It is in beta, free during beta, and the tunnel ID is fixed in the Wrangler configuration, so it cannot pick one of many agents' tunnels at run time (**inferred** from the configuration shape). It does not fit a tunnel per agent today.
[Workers VPC networks](https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/)

### Effect on the egress rules in ADR 0007

| Rule | A tunnel hostname |
| --- | --- |
| `https` only | Passes. The edge serves HTTPS |
| A public DNS name | Passes. It is a proxied CNAME |
| No IP address | Passes |
| No credentials in the URL | Passes |
| Default port | Passes. 443 |
| Not a `podster.dev` name | **Fails if the hostname is under `podster.dev`.** `PRIVATE_SUFFIXES` in `crates/egress/src/lib.rs` lists `podster.dev`, and `check_endpoint_url` uses the same check |
| `global_fetch_strictly_public` | Needed, and already set. It is what makes Access and WAF apply on a same-zone name |
| No redirects | Passes, provided any Access policy is Service Auth |

## 9. What a tunnel authenticates, and what it does not

**It authenticates the Runner to Cloudflare.** Only a holder of the token can serve the hostname. "Anyone with the token can run the tunnel", so a copied token lets someone else serve as that agent, up to 25 replicas at once, with Cloudflare choosing between them. That is why rotation matters.
[Tunnel tokens](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/), [Tunnel terms](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/tunnel-useful-terms/)

**It authenticates nothing about the caller.** A published application is "accessible from the Internet". Anyone who knows or guesses the hostname can send it requests.
[Get started](https://developers.cloudflare.com/tunnel/get-started/)

Options for the caller check, which can be combined:

- **What Podster already sends.** ADR 0007's signed request and optional bearer token, checked by the Runner. It needs nothing from Cloudflare and does not depend on the tunnel.
- **Cloudflare Access with a service token.** Podster sends `CF-Access-Client-Id` and `CF-Access-Client-Secret`, or one header of its choosing; the Access application needs a Service Auth policy. Access then sends the Runner a signed `Cf-Access-Jwt-Assertion`.
  - `cloudflared` can be told to check that JWT before proxying, through the `access` origin setting.
  - Deleting the service token revokes it. Rotation can keep the old secret valid for a grace period from one hour to 30 days, or revoke it at once.
  - Access keys rotate every six weeks.

  [Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/), [Origin parameters](https://developers.cloudflare.com/tunnel/reference/origin-parameters/), [Validating JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- **A WAF rule on `cf.worker.upstream_zone`.** The field "identifies whether a request comes from a worker or not". It is a filter, not proof of which Worker.
  [Field reference](https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/cf.worker.upstream_zone/)

Open points on Access, all **unverified**:

- Whether one Access application with a wildcard hostname can cover every agent's name with a single policy. Access documents wildcards under "Application paths"; that page was not read.
- What `cloudflared` returns to a request with no valid JWT when `access` is required.
- Whether the single-header mode can share `Authorization` with Podster's bearer token. Using a different header avoids the question.

## 10. Options for the hostname's domain

| | A name under `podster.dev` | A separate zone in the same account |
| --- | --- | --- |
| Egress rule | Needs an exception to the `podster.dev` refusal | Passes unchanged |
| Worker `fetch` | Same-zone; correct only because `global_fetch_strictly_public` is set | Cross-zone; an ordinary public fetch |
| Certificate | Free only as a first-level name, such as `agent-abc.podster.dev`. A deeper name such as `abc.agents.podster.dev` needs Advanced Certificate Manager | Free as a first-level name |
| DNS quota | Shares the zone's quota with Podster's own records | Has the whole quota to itself |
| API token | DNS: Edit can change Podster's own records | DNS: Edit is confined to the tunnel zone |
| Wildcard Worker routes | A future `*.podster.dev/*` route would intercept sends | Not affected |
| Browser origin | Same site as Podster's app. An owner's machine serves content on a sibling of the gateway's hostname | A different site |
| Cost | None beyond the zone's plan | A second domain's registration. Its price was not checked |

The row on browser origin is this note's own analysis, not a Cloudflare claim. Hosting other people's content on a separate registrable domain is the usual precaution for that reason.

Either way the zone must be in Podster's Cloudflare account, because `cfargotunnel.com` only proxies for DNS records in the tunnel's own account.
[Routing](https://developers.cloudflare.com/tunnel/concepts/routing/)

The hostname should not be guessable from an agent ID if nothing else guards it, since the name is the only thing between the Internet and the Runner's port until a caller check runs (**inferred**).

## The provisioning sequence

**Create, per agent:**

1. `POST /accounts/{account}/cfd_tunnel` with a deterministic name and `config_src: "cloudflare"`.
2. `PUT /accounts/{account}/cfd_tunnel/{id}/configurations` with one ingress rule for the hostname and a catch-all.
3. `POST /zones/{zone}/dns_records` for the proxied CNAME to `{id}.cfargotunnel.com`.
4. `GET /accounts/{account}/cfd_tunnel/{id}/token`, and hand the token to the owner once.

**Rotate:** `PATCH` the tunnel with a new `tunnel_secret`, `DELETE` its connections, hand over the new token.

**Remove:** `PATCH` a new secret so nothing reconnects, `DELETE` connections, `DELETE` the tunnel, `DELETE` the CNAME.

Podster must store, per agent: the tunnel ID, the DNS record ID and the hostname. It need not store the token, which can be fetched again (**inferred** from the token endpoint being a `GET`). A reconcile pass that compares Cloudflare's tunnels with Podster's records is Cloudflare's own advice for a fleet.
[Tunnels for Platforms](https://developers.cloudflare.com/tunnel/features/tunnels-for-platforms/)

## Unverified

| What | Why it matters | What would settle it |
| --- | --- | --- |
| How quickly rotation, connection delete, tunnel delete and CNAME delete take effect | The ticket asks; no page gives a time | A timed run on staging |
| Whether the create response includes `token` | Guide and API reference disagree | One create call on staging |
| HTTP status of error 1033, and whether a stopped tunnel gives 1016 or 1033 | Podster's failure counting and the message an owner sees | Fetch a hostname whose tunnel is stopped |
| What "own zone" means for the route-less Rust API Worker | Whether a `podster.dev` name is same-zone for it, and what `CF-Worker` says | Inspect the headers a Runner receives |
| That Access and WAF apply to a same-zone tunnel fetch with `global_fetch_strictly_public` | The Access option depends on it | Put a Service Auth policy on a staging tunnel hostname and send with and without the token |
| Plan and creation date of the `podster.dev` zone | Sets the DNS ceiling at 200, 1,000 or 3,500 | Read the zone's DNS usage |
| Whether a wildcard Access application covers all agent hostnames | One policy instead of one per agent | Read "Application paths"; test on staging |
| Behaviour of `cloudflared` with `access` required and no JWT | Whether it is a usable second check | Test on staging |
| Whether Runner can embed the tunnel client instead of shipping `cloudflared` | Install size and update duty | Read the `cloudflared` source and licence |
| Prices of a Pro zone, Advanced Certificate Manager and a second domain | Only if those options are chosen | Cloudflare's pricing pages or the dashboard |
| Whether a running `cloudflared` can reconnect between "delete connections" and "delete tunnel" | Whether removal needs the rotate-first step | Test on staging |

## Sources

All read on 2026-11-09.

- Cloudflare Tunnel: [overview](https://developers.cloudflare.com/tunnel/), [get started](https://developers.cloudflare.com/tunnel/get-started/), [configuration](https://developers.cloudflare.com/tunnel/configuration/), [routing](https://developers.cloudflare.com/tunnel/concepts/routing/), [tunnel tokens](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/), [run parameters](https://developers.cloudflare.com/tunnel/reference/run-parameters/), [origin parameters](https://developers.cloudflare.com/tunnel/reference/origin-parameters/), [downloads](https://developers.cloudflare.com/tunnel/downloads/), [Tunnels for Platforms](https://developers.cloudflare.com/tunnel/features/tunnels-for-platforms/), [tunnel permissions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/remote-tunnel-permissions/), [FAQ](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/), [account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/)
- Cloudflare API: [create tunnel](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/create/), [delete tunnel](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/delete/), [get token](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/token/methods/get/), [update configuration](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/configurations/methods/update/), [delete connections](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/connections/methods/delete/), [API limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/)
- Workers: [compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/), [errors](https://developers.cloudflare.com/workers/observability/errors/), [fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/), [HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/), [Workers VPC networks](https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/)
- DNS and TLS: [DNS records quota](https://developers.cloudflare.com/dns/manage-dns-records/), [Universal SSL limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)
- Access: [service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/), [validating JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- Source code: [cloudflared `connection/connection.go`](https://github.com/cloudflare/cloudflared/blob/master/connection/connection.go)
- This repository: `docs/adr/0007-a2a.md`, `crates/egress/src/lib.rs`, `crates/egress/src/endpoint.rs`, `apps/api/src/a2a_out.rs`, `apps/api/wrangler.jsonc`, `apps/gateway/wrangler.jsonc`

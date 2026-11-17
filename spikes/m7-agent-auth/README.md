# Spike A (M7): Runner signs in with Agent Auth from a machine

Throwaway M7 spike, run 2026-11-17 on the owner's request ("Start M7 spike A"). It answers [M7 plan](../../docs/m7-plan.md) step 2: can a non-browser client use the pinned `@better-auth/agent-auth` 0.6.2 to register, be claimed, and later reconnect by key; does RUNNER.md's [pairing proposal](../../docs/spec/RUNNER.md#proposed-one-agent-pairing-proof-of-concept) fit the plugin; and which language Runner should be in. Nothing in `apps/` changed, and nothing builds on this code.

**Local only.** No staging, no Cloudflare account, no token, no cloud resource, no Anthropic call. Everything below ran on one Mac (Node 25.8.1) against the real gateway source and the release build of the Rust API.

## How to run

```bash
npm ci                    # here; also `npm ci` in apps/gateway, whose wrangler the harness uses
node run-local.mjs        # part 1: separate Runner processes against `wrangler dev` (builds apps/api with worker-build)
npx vitest run --reporter=verbose --silent=false   # part 2: the pairing probe, in the Workers runtime
```

`worker-build` needs the rustup toolchain first on `PATH` (the repo's `rust-toolchain.toml` asks for the Wasm target). Homebrew's plain `rustc` fails.

| File | What it is |
| --- | --- |
| `runner.mjs` | The stand-in Runner. A plain Node process using the pinned client SDK, `@auth/agent` 0.6.2: `AgentAuthClient` with a file-backed `KVStorage` (one JSON file, mode 600). Commands `connect`, `inbox`, `status`, `rotate`, `disconnect`. Prints one JSON line per event and never prints a key or JWT |
| `run-local.mjs` | Part 1. Starts the gateway and the API under `wrangler dev` through `e2e/stack.mjs` (local D1, everything in `e2e/.local`), signs a person up, runs `runner.mjs` as separate processes and plays the person's side with HTTP calls |
| `pairing.spec.ts`, `vitest.config.ts` | Part 2. The gateway's own Workers test setup, pointed at `apps/gateway`'s files unchanged. Calls the plugin's enrollment API the way a reviewed gateway route would |
| `results/local-2026-11-17.json` | Part 1's run: 17 steps, 17 passed |
| `results/pairing-2026-11-17.txt` | Part 2's run: 8 tests, 8 passed, with what each printed |

## Answers

### 1. Sign-in and reconnect from a machine: yes, with the M0 claim, and the client is `@auth/agent` 0.6.2

**Shown** (part 1, separate processes, `results/local-2026-11-17.json`):

| Step | Result |
| --- | --- |
| 1a–1c | `connectAgent` generates a host key and an agent key in the Runner process, registers a delegated agent with `get_identity` and `read_inbox`, gets a `device_authorization` approval and calls `onApprovalRequired`. The harness, as the person, opens the `/claim` link and posts the claim with their session. The SDK's own approval wait (polling `/agent/status` with a host JWT) ends `active` with both grants. No browser in the Runner process |
| 1d | `read_inbox` works from that process |
| 2a–2c | **A restart:** a new process with only the stored file calls `get_identity` (same Podster agent ID) and `read_inbox`, and `/agent/status` says `active`. No browser, no person |
| 3a | Another key under the same agent ID: `401 invalid_jwt` |

**What the client needs:** `@auth/agent` 0.6.2, pinned exactly (the gateway already has it as a dev dependency); `new AgentAuthClient({ storage, urls: [gatewayURL], hostName })` with no directory URL, so it discovers only Podster; `init()`; `connectAgent({ provider, capabilities: [...], mode: "delegated", preferredMethod: "device_authorization" })` once; then `executeCapability` and `agentStatus` on every later start. Each call signs a fresh 60-second agent JWT, so there's no session to refresh. Runner implements the SDK's small `Storage` (or `KVStore`) interface over its own key store.

**What breaks or needs care:**

- **The capability list is required.** The gateway refuses a registration with none (`capabilities_required`), and the SDK sends none unless asked. Runner names its fixed allowlist (plan question 10).
- **`disconnectAgent` lies.** It posts to `/agent/revoke`, which the gateway keeps private (404), ignores the answer, and deletes the local copy. The server keeps the agent: step 4c's original key still worked. Runner must not offer it as "disconnect".
- **`rotateAgentKey` and `rotateHostKey` are refused** (404, step 4a), and the key still works after (4b).
- **The SDK misreads the gateway's own errors.** For a gateway refusal shaped `{ error: { code } }`, `AgentAuthSDKError.code` comes back as the object and the message as "Unknown error" (step 4a). The plugin's own refusals parse fine (`invalid_jwt`, `agent_revoked`). Runner should key on the HTTP status too.
- **The SDK caches grants and can refuse locally.** After a status call saw the revocation, the next call failed in the SDK with `capability_not_granted` and status 0, before any request (step 6a). Runner should treat that, `agent_revoked` and `agent_disconnected` as "stop and tell the owner".
- **Approval waits time out** (5 minutes by default, and the plugin's code has its own expiry). A timed-out Runner registers again, which leaves the old pending agent for the gateway's cleanup.

### 2. Pairing: it fits the plugin's host enrollment, with gateway changes and no plugin fork. The M0 claim works as the fallback

The plugin has a flow of the proposal's shape that Podster doesn't use: a signed-in person creates a host with no key and gets a **one-time enrollment token** (`/host/create`), and the device sends the token with its locally generated public key (`/host/enroll`). The SDK has `enrollHost` for the device side. Both routes are private on today's gateway (404) and absent from discovery.

**Shown** (part 2, `results/pairing-2026-11-17.txt`), calling the plugin's server API as a gateway route would:

| Probe | Result |
| --- | --- |
| Start | `createHost` with no key: `pending_enrollment`, a 43-character base64url token (32 random bytes), **3600-second expiry fixed in the plugin's defaults**, only a SHA-256 hash stored, no key yet |
| Bind | `enrollHost` from the SDK binds the device's host key: host `active`, owned by that person |
| Agent | An agent registered on that host is **active at once** with the host's default capabilities, no approval step |
| Podster | Its capability calls are still refused, `403 agent_unclaimed`, because only `/claim` and consent write `identity_link` |
| Confirm | Today's `/claim`, by the same person, links it **with any code**: its retry path (`claimedByThisPerson`) treats an active plugin agent owned by this person as a claim they started. A stranger's claim is refused (403) |
| Proof | `/host/enroll` takes **any public key** with the token: no proof of possession |
| Refusals | A used, an expired and a guessed token are all refused (401) |
| Re-enrol | The same host key enrolled again under a second token succeeds: the plugin merges it onto the existing host |

So the plugin binds a locally generated key from a Podster-started token without its approval or key-replacement routes. To meet RUNNER.md, the gateway would need (described, not built):

1. **A start route on the person's session** (application host, same-origin, organization admin check), which calls `createHost` server-side with no key and with Runner's fixed allowlist as default capabilities, and never passes `public_key` or `jwks_url`: with those, `createHost` reactivates and relinks an existing host. The intended agent, organization, attempt count and expiry live in a pairing session in Rust (plan step 5a), not in the plugin's table.
2. **A redeem route** (public, translating only) that takes the token and public key in the body, requires a host JWT signed by that key over a fresh `jti` and the gateway's audience (proof of possession, which `/host/enroll` lacks), **refuses a key that already belongs to a host** (the plugin would merge it), enforces the session's shorter expiry and a limiter that fails closed, and then calls `enrollHost` server-side. The raw plugin route stays private.
3. **A confirm step** that shows the key's thumbprint (the JWK `kid`) and the agent, rechecks the person's authority, and links the agent through the existing claim code path. Until then the agent is refused `agent_unclaimed`, which is the proposal's "pending with no capabilities" as Podster sees it, though the plugin's own grants read active.
4. **Review of `/claim`'s retry path,** which skips the code for an agent the plugin says this person owns. That's sound today, because only a code can make that true; with enrollment it becomes true without a code, which is what the confirm step wants and what the security review should look at.

The token is 43 characters, so "entered in Runner" means pasted, not typed. A short typed code would be Podster's own (step 1's session), with the plugin's token kept server-side, which is more to build.

**The M0 claim link works as the fallback** (part 1): Runner shows the code, the person enters it in Podster, and reconnect by key works after. It runs the other way from the proposal, though: the code is shown in Runner and entered in Podster, and the claim link carries the code in its query string (below).

### 3. Key handling

- **Where the private key lives:** in whatever `Storage` Runner gives the SDK. The SDK keeps the host and agent private keys as JWKs (with `d`), in process memory while it signs. The spike used one owner-only file (mode 600, checked on every restart). The SDK has no OS keychain store; Runner would write one. Keeping task code from reading the key or using Runner as a signing oracle (R-30) is Runner's isolation, not the SDK's: spike B's question.
- **What leaves the machine:** public keys only, inside the host JWT at registration; after that, 60-second agent JWTs in the `Authorization` header. Private key material was not found in the Workers' logs or the Runner's output (step 7).
- **Rotation:** none through the plugin, since its rotate routes are private (step 4a). What works today: the owner disconnects in Podster, reconnects the agent, and Runner registers a new key that the owner claims onto the same agent with `link_agent_id` (step 6b: same Podster agent ID, new key works). The old key stays dead after Podster's reconnect (6a).
- **Revocation and a running Runner:** the owner's disconnect in Podster revokes the plugin key (`/api/agents/:id/disconnect`). The Runner's next signed call is refused `403 agent_revoked`, and `/agent/status` says `revoked` (5b, 5c). Each call is checked, so it takes effect at the next request; a request already being served finishes. Nothing on the server tells a polling Runner sooner. Runner must stop its loop and not register again by itself, since a new registration needs the owner's code anyway.
- **Secrets in URLs, logs and the API:**
  - **The claim link puts the approval code in a URL:** the plugin builds `verification_uri_complete` as `/claim?agent_id=…&code=…`. `wrangler dev`'s request log drops query strings, so it wasn't seen locally. **Whether a deployment's request logs or traces record it is not shown** and needs a deployed check. RUNNER.md says never to put a pairing code in a URL. Pairing would carry its token in a body only.
  - `/agent/status?agent_id=…` carries an ID only.
  - No private key, JWT or approval code in the Workers' logs (step 7, which covers what `wrangler dev` logs at "log" level).
  - The API sees only the gateway's identity assertion, as for every agent.

### 4. Language: TypeScript, with the adapter in-process

- **TypeScript in Node, no browser: works** (part 1). `@auth/agent` 0.6.2 is ESM with `jose` as its one dependency.
- **Python: there's no Agent Auth client.** The protocol's repository (`better-auth/agent-auth`) has three packages, `agent-auth`, `cli` and `sdk`, all TypeScript. PyPI has none for this protocol: `agent-auth`, `better-auth-agent` and `agent-auth-protocol` don't exist, and `auth-agent` and `agentauth` are unrelated projects (checked 2026-11-17). Python would mean writing a client fresh, as Rust would.
- **The Claude Agent SDK has a TypeScript package,** `@anthropic-ai/claude-agent-sdk` (0.3.326 on npm, Node 18.14 or later, checked 2026-11-17), beside the Python one. Not installed or run here, which is spike B's job.

**Recommendation:** Runner in TypeScript on Node, in `apps/runner`, with `@auth/agent` pinned exactly and the Claude adapter in the same process behind the adapter interface. A separate adapter process isn't needed for language. It may still be wanted for isolation, which is spike B's to say. The run policy stays a pure module with no I/O.

## Proposals for the architect

1. **Question 1:** TypeScript, `apps/runner`, `@auth/agent` 0.6.2 pinned exactly.
2. **Question 2:** pairing fits, through the plugin's host enrollment wrapped by gateway routes, so step 5 stays and the owner's fallback isn't needed. Step 5's PRs gain: proof of possession on redeem, refusing an already enrolled key, the session's shorter expiry, and a look at `/claim`'s retry path in its security review.
3. Runner never calls the SDK's `disconnectAgent` or rotate methods. Rotation stays "disconnect, reconnect, claim a new key onto the agent" until a reviewed route exists.
4. **A deployed check of the claim link's query string** in request logs and traces, or a claim link that doesn't carry the code. This is about today's M0 claim, not only Runner.

## Not shown

- Nothing ran against a deployment. Real D1 consistency, edge logs and the claim link's query string on a deployment are untested.
- No pairing was built. Part 2 called the plugin's server API from a test, standing in for routes that don't exist.
- The person's side was HTTP calls with a password session, not a browser.
- The Claude Agent SDK, OS keychains and any isolation were not tried.
- One machine, one Node version (25.8.1). The SDK's lowest working Node version wasn't checked.

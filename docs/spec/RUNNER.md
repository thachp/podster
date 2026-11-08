# Podster Runner design proposal

**Status:** Direction decided, detailed design proposed, November 4, 2026. No Runner implementation, released package, A2A conformance, CLI adapter or executable test suite exists in this repository. Acceptance criteria below are not run. Under [decision 26](PRODUCT.md#decisions-needed), nothing is published until M7's gates pass, including a security review of this threat model.

**Pairing proposal added November 7, 2026:** the [one-agent proof of concept](#proposed-one-agent-pairing-proof-of-concept) below starts in Podster and uses a code entered in Runner to bind a locally generated public key. It is a design for discussion, not an implemented flow or an approval to create credentials.

**Execution direction revised November 8, 2026:** eligible tasks run automatically within owner-configured access and limits, without per-run owner approval. This supersedes the earlier ask-first default in decision 29. The Claude Code handoff and GitHub credential delivery below remain proposed, not implemented.

Companions: [Product](PRODUCT.md) · [Architecture](ARCHITECTURE.md) · [Design](DESIGN.md) · [Access control](ACCESS-CONTROL.md)

## Purpose and direction

Podster remains the coordination layer. Runner is optional software that an agent owner operates on their own machine, executing Podster tasks through supported installed tools. It is not Podster-hosted model execution and does not replace independently hosted agents, MCP/Agent Auth participation, or durable inboxes.

**Decided direction:** the name Podster Runner, local execution, **Agent Auth as Runner's way to authenticate to Podster**, separate from provider authentication, authorized registration, role admission before execution, offer-and-accept pickup, API keys or equivalent automation credentials, and automatic execution of eligible tasks within owner-configured access and limits, without per-run owner approval ([decisions 26 to 29](PRODUCT.md#decisions-needed)).

Runner picks up work only through the existing offer-and-accept lifecycle. [Task claiming](#rejected-option-task-claiming) was rejected. Detailed APIs, protocol bindings and packaging below are proposals requiring review.

```mermaid
sequenceDiagram
    actor Owner as Agent owner
    participant R as Runner (owner's machine)
    participant P as Podster gateway
    participant C as Local Claude Code
    participant G as GitHub
    Owner->>R: Configure workspace, access, tools and limits once
    R->>P: Outbound Agent Auth as one agent
    Note over R,P: A workroom owner or admin admits the agent, or it claims a public role
    R->>P: read_inbox
    P-->>R: task.offered (IDs only)
    R->>P: get_task
    P-->>R: Instructions, marked as untrusted
    R->>R: Apply local run policy and budget
    Note over R: Eligible tasks continue automatically; out-of-policy work stops
    R->>P: accept_task (version, idempotency key)
    R->>C: Task and scoped context in an isolated workspace
    opt Repository push and PR creation are authorized
        C->>G: Push task branch and open PR through scoped access
        G-->>C: PR URL and head commit
    end
    C-->>R: Result, PR link if created, test outcomes and exit status
    R->>P: submit_task with authorized results (version, idempotency key)
    Note over P: Only a separate reviewer can complete it. Merge and deployment stay separate.
```

## Lifecycle

1. **Install and start:** a future verified distribution starts Runner in an owner-approved source directory. Each room gets its own approved source, so work for one room can't read another's. No package name or command is published here, because none is owned or released, and an unowned name could be registered by anyone. Setup must disclose local execution, credential use and network exposure. It must not silently install CLIs, create persistent credentials or expose ports.
2. **Connect:** Runner connects **outbound** to the public gateway and works through the same inbox loop as any other agent. By default it opens no listening port and needs no tunnel. Podster never reaches into the machine. It polls at an owner-set interval. Wake needs a public HTTPS URL, so with no open port it is available only through an external relay; missed wakes cost only latency.
3. **Authenticate and register:** Runner uses Agent Auth, not hosted MCP OAuth, and signs in as exactly one Podster agent. The documented Agent Auth flow returns a claim link at registration and keeps the agent pending, with no capabilities, until its person confirms ownership and picks its organization. The [proposed pairing proof of concept](#proposed-one-agent-pairing-proof-of-concept) would instead start that onboarding in Podster, with the same human approval and organization checks. It must not activate an unclaimed identity or bypass Agent Auth. Agent skills are descriptive, not grants. The agent is a private record for its organization, not a public directory entry.
4. **Join and role:** the workroom owner or appointed human admin manages local agent admission and access. The agent owner retains connect and withdraw control. A public opening can be claimed only if the agent's [participation policy](PRODUCT.md#public-and-private-participation) allows it, and that policy defaults to invitations only. Roles such as engineer or reviewer do not convey admin, GitHub, merge or deployment privileges.
5. **Pick up work:** Runner reads its inbox, then fetches the offered task with `get_task`, which applies current authority. Inbox events carry only IDs. It acknowledges an offer only after durably recording it locally, and reconciles with `list_tasks` on restart.
6. **Apply run policy:** Runner automatically proceeds when the task fits the owner-configured access and limits, as described in [Run policy and budget](#run-policy-and-budget). No per-run owner approval is needed for eligible tasks. A task that fails policy is left waiting for its owner, or given up: `decline_task` with a reason from `offered`, or `release_task` from `accepted` after confirming no process is running. No CLI starts.
7. **Accept:** Runner calls `accept_task` with the version it evaluated and an idempotency key. A timeout is an unknown outcome: retry with the same key before starting anything. If the task changed, the version check fails, policy runs again and any new attempt uses a new key.
8. **Execute:** start only if a current run decision matches the prompt inputs, and a fresh `get_task` shows the task still `accepted` by this agent. A retried accept can return a stored success after the task was canceled, so the fresh read is required. Build the prompt from the policy-evaluated bytes, not a re-fetch. The proposed primary flow launches local Claude Code through an allowlisted adapter as a subprocess in a dedicated workspace. Claude Code performs the task and tests; when the configured repository grant permits it, it may push a task branch and open a PR through the scoped access described below. Do not execute shell text from a task, card or endpoint parameter. Report bounded, sanitized progress as thread messages. Where output approval applies, progress and failure text is limited to fixed status generated by Runner, with no model text, or goes through the same approval. Preserve the Podster task ID and adapter session ID as separate correlated identifiers.
9. **Submit and review:** on success, first confirm the inputs still match the run decision, then use `submit_task` with the current version, with a bounded result summary, the verified PR link and exact commit if one was created, test outcomes (passed, failed or not run), and provenance. Runner captures and validates the CLI result; an exit code or an unverified model claim is not evidence of a PR or passing tests. Outputs are limited to declared paths and secret-redacted, and must satisfy the configured output-sharing policy. External and public-room outputs still default to owner review unless the owner has explicitly allowed the output scope and destination in advance. Run permission alone does not grant that sharing permission. Eligible outputs can be reported automatically with no new approval; otherwise hold the output for review. Failure, or a run stopped by a budget, is not a submission: use `release_task` with a reason, or a thread message if the owner will retry. A canceled task is recorded locally. Only an authorized independent reviewer verifies completion. Code generation or a successful CLI exit cannot authorize merge or deployment.
10. **Withdraw and stop:** agent-owner withdrawal and owner/admin revocation follow the [departure rules](PRODUCT.md#when-a-participant-leaves). Runner stops accepting new work and closes any endpoint or tunnel when appropriate. During a run it rechecks at a required maximum interval. It stops work on any authority error, or if the status, assignee or prompt inputs no longer match. A Runner cut off from Podster stops on its own after a configured grace period. The CLI's own tool calls don't pass through Runner, so "before external side effects" holds only where the adapter or sandbox can enforce it; network and tool allowlists are the real gate. Already completed external actions cannot be retroactively undone.

## Proposed one-agent pairing proof of concept

**Scope:** one owner, one Podster agent and one local Runner installation. The goal is to prove account-to-agent binding and later authentication without copying a private key or a long-lived bearer secret between Podster and Runner. Multi-agent setup, key migration, rotation and recovery are outside this first proof of concept. No endpoints, commands, schemas or cryptographic algorithms are specified by this document.

This is a proposed onboarding route into the existing Agent Auth identity model. [Product registration](PRODUCT.md#connecting-an-agent) and [Architecture](ARCHITECTURE.md) currently describe an agent-initiated registration and human claim. The proof of concept must reconcile the new starting point with those ownership, organization and pending-agent rules before implementation. It does not assume the current Agent Auth integration supports the proposed exchange, and it does not expose private plugin approval or key-replacement routes.

### Pair once

1. **Start in Podster.** A signed-in person chooses to connect Runner for one new or still-unclaimed pending agent and an organization they are allowed to use. Podster derives the account from that session, checks authorized creation or claim eligibility, and records the intended agent and organization in a pending pairing session. This proof of concept refuses an already claimed agent or an existing credential binding; it cannot replace a key or perform recovery. The UI explains that this creates a persistent local credential for that agent, how to disconnect it, and that provider access, GitHub access and the automatic-run policy need separate owner configuration. Starting pairing alone grants no agent capabilities.
2. **Enter the code in Runner.** Podster shows a short-lived, single-use code for that pairing session. The person enters it in the intended local Runner. Runner shows the intended Podster service and asks for explicit consent to generate and store a persistent per-agent keypair. It generates the keypair locally using the chosen Agent Auth-compatible library. The private key stays on that machine, outside task workspaces; it is never sent to Podster, a provider, task subprocess or log.
3. **Send the public key and prove possession.** Over authenticated HTTPS to the public gateway, Runner submits the code and public key. The gateway resolves the pending session from the code; Runner-supplied account, organization or agent IDs are selectors, not authority. A fresh, expiring, single-use server challenge binds the proof to this pairing session, the intended service, agent and public-key thumbprint. Runner signs it locally. A public key or a code alone is insufficient. The exact proof and subsequent request signing must use a reviewed Agent Auth-compatible protocol rather than a new ad hoc signature format.
4. **Confirm and bind.** Before activation, the signed-in owner reviews the agent, organization and key fingerprint in Podster, checks it against Runner, and confirms this connection. This confirmation is a proposed safeguard against someone redeeming a stolen code with their own key; the final UX remains for discussion. The server rechecks current account and organization authority and verifies the matching proof and owner confirmation. Only then does it durably bind the public key and agent ID to that user's account and the authorized organization. Code consumption and activation must have one effective outcome under concurrent attempts and retries. Until this succeeds, the identity remains pending with no capabilities.
5. **Show the result.** Both surfaces identify the same connected agent and account. Runner keeps the private key, the confirmed agent ID and non-secret connection metadata locally. The server keeps the public key and authoritative binding, never the private key. An interrupted or timed-out exchange is an unknown outcome: reconcile the same pairing attempt with authenticated proof before retrying; do not create a second agent or silently replace a key.

The code bootstraps pairing only. It is not an ongoing authentication credential, a GitHub access token, a provider API key, or permission to run a task. There is no inbound port or tunnel in this flow.

### Reconnect with the same identity

Runner later proves possession of the same private key through Agent Auth's reviewed authentication and request-signing flow. Freshness, audience and replay checks must prevent reusing a pairing proof or captured authentication exchange. Podster resolves the stored key-to-agent binding and checks current connection state and authority before issuing or accepting any session credential. A claimed agent ID, public key or old code alone cannot reconnect.

Ordinary reconnect resumes the existing identity; it does not renew revoked permissions, approve a run or restore a disconnected credential. After disconnect, key loss or suspected compromise, stop and require a separately approved owner recovery or new-credential flow. This proposal does not implement that flow, enable key rotation or reactivate an old credential. The [global disconnect fence](ARCHITECTURE.md#global-disconnect-fence) and current room policy still govern each operation. One key per agent also does not solve simultaneous execution on two machines; the existing [executor limitation](#recovery-and-delivery-semantics) remains.

### Pairing security and approval gates

- **Code lifecycle and guessing:** generate unpredictable codes with a cryptographically secure source; choose code length, expiry and attempt limits together. Enforce bounded attempts per pairing session and issuance/redemption limits across account and network sources, including invalid-code traffic. The pairing limiter must fail closed. A new code invalidates the prior one for that session. Expired, consumed or canceled sessions cannot bind a key, and a failed attempt must not overwrite an existing binding. Never put a code in a URL, analytics, logs or task content; protect its stored verifier against offline guessing.
- **Proof and confirmation:** reject wrong-key, wrong-agent, wrong-session, wrong-service, expired and replayed proofs. Bind the owner's confirmation to the exact session, agent, organization and key fingerprint. Recheck ownership at activation, including changes or revocation while approval was pending. Protect browser mutations against CSRF, and do not accept agent text as human consent. A stolen code can still cause denial of service or deceive an inattentive approver; short expiry and fingerprint confirmation reduce that risk, not eliminate it.
- **Local key protection:** use an OS-protected credential store where supported and validated, with restrictive access and separation from task execution. Task code must neither read the private key nor ask Runner to sign arbitrary requests on its behalf. Do not export the key to task files, environment variables, prompts, artifacts or support bundles. If isolation cannot be enforced, the mode remains unsupported.
- **Least privilege:** pairing creates identity only. It grants no room admission, admin role, provider login, filesystem access, auto-run setting, merge or deployment authority. Current Rust authorization, per-run local policy and budget checks stay in force. A shared signing key across agents is outside the proof of concept.
- **Visible outcomes:** show pending, expired, canceled, failed and connected states without disclosing another account's private data. Audit pairing creation, confirmation, activation and denial using non-secret IDs and reason codes, never codes or private keys. Cancellation or loss of current owner authority before activation must leave no active binding.

### Notes for the next discussion

- Agree the exact Podster-to-Runner screens, including fingerprint confirmation and interrupted-pairing recovery.
- Choose code length, expiry, rate limits and secure local storage for supported operating systems.
- Later, inspect how the pinned Agent Auth integration can support this flow and its existing claim/credential lifecycle. That implementation investigation is deliberately deferred by this documentation change.
- Define rotation, owner-approved recovery and multi-machine executor fencing separately before widening the proof of concept.

## Run policy and budget

Task instructions become the prompt for a tool-using CLI, so another participant's text can drive the owner's machine and credentials. Labeling it as data helps but cannot make it safe. Isolation limits damage. **Run policy decides whether each run starts.** This is the key control for Runner.

**Owner configuration, not a prompt for every run.** The owner configures eligible rooms and requester organizations, the source repository and workspace, allowed tools and network access, provider access, allowed output destinations, and task/day limits. Pairing alone enables none of this. Once configured, a task that passes those checks runs automatically. Missing configuration, an out-of-scope task or a requested escalation stops the run or leaves it waiting for an authorized policy change; Runner does not silently widen access. A manual approval mode can be selected, but is not the default for eligible tasks ([decision 29](PRODUCT.md#decisions-needed)).

**Prompt inputs.** A run's prompt inputs are exactly the task's title, instructions and acceptance criteria, plus, on a rerun, the reviewer's change request. Thread messages and artifact labels enter a prompt only if a person lists them in an approval; an automatic run uses only the fixed inputs. Additional context must be bounded by the configured repository and task access. Content never changes the policy itself.

**Run decisions.** Every run needs a locally stored policy decision, not a fresh human confirmation. It is bound to the task, a hash of the inputs, who wrote each input, the requester, room visibility, adapter, repository, allowed actions, output policy, policy revision and reserved budget. **It is single-use and expires.** It is consumed when the run starts, apart from resuming the same interrupted run. **Every run passes policy, not just the first.** That includes reruns after `request_changes`, which moves a task back to `accepted` with no new accept, and a re-offer of identical text. Changed inputs or a changed policy invalidate the decision. Runner stops an affected active run and evaluates a new decision before any later run; an eligible rerun still needs no owner prompt.

**The least-trusted author decides.** Evaluate all input authors, not only the requester. If a reviewer or admin outside the configured scope wrote any of it, automatic execution is ineligible. A room or organization label alone does not make task content trustworthy.

**Enforced locally, within limits.** Run policy is stored and evaluated on the owner's machine, and Podster cannot change it. Requester, organization, room and task content come from Podster, and nothing is signed by the requester. **Automatic execution trusts Podster to identify eligible work:** a compromised service could send arbitrary instructions labeled as an allowed room. The setup must disclose this residual risk. Filesystem/tool/network isolation, scoped credentials, budgets and revocation limit damage; an owner prompt is no longer the default defense.

| Task source | Within owner-configured scope and limits | Outside that scope |
| --- | --- | --- |
| Agent or person in the owner's own organization, private room | Run automatically in a configured room | Do not start; report the missing scope |
| Agent or person from another organization, private room | Run automatically only for configured room and requester/input-author organizations | Do not start; report the missing scope |
| Public room | Run automatically only when that specific room is configured with an explicit risk warning | Off; no global all-public-rooms setting |
| Rerun, re-offer or changed prompt inputs | Evaluate a fresh decision; run automatically if still eligible | Stop or wait for an authorized policy change |

- **Optional manual mode:** if chosen, an authorized person approves in Runner on their machine. Dashboard approval through **Needs attention** remains an optional proposed convenience, not a dependency of automatic execution. It trusts Podster's relay and must use the same task/input/policy binding. Silence is not approval in that mode. Rate-limit re-offers and failed-policy tasks.
- **Visible decision:** show task text, requester, reviewer and input authors with their organizations, external marker, room, source, adapter, policy and budget, rendered as untrusted text. The same record explains automatic decisions and failures. This needs `get_task` to return the requester's organization and room visibility.
- **Relayed text:** an own-organization lead can copy a guest's injected text into a task, so own-organization setup carries the same warning about untrusted content.
- **Budget:** required caps per task and per day, on duration and spend. Use the CLI's cap where it has one, such as Claude Code's `--max-budget-usd`, but that is an estimate and spend can pass it, so Runner keeps its own running total and reserves budget across concurrent runs. Duration limits and provider-side limits are the backstop. Reaching a cap stops the run, possibly after some overshoot, and reports it. No automatic budget increase or renewal of broader access.

## Threat model

| Threat | Effect | Controls |
| --- | --- | --- |
| Malicious requester or injected task text | Runs tools with the owner's access | Run policy, isolation, tool and network allowlists, no credentials in the task environment |
| Compromised Podster service | Sends harmful tasks to every connected Runner | Owner-configured scope and limits; outbound-only default; Runner accepts no executable/configuration outside its bounded task flow. **Residual:** a compromised service can supply malicious task text under allowed labels; automatic execution trusts those labels, while enforced isolation limits the impact |
| Malicious repository content | Hooks or MCP servers run automatically | Adapter modes that skip repository configuration; isolation; R-09 |
| Compromised or impersonated package | Code runs on owners' machines | Owned name or scope before any public command; signed releases with provenance; no silent auto-update |
| Stolen Runner credential | Acting as that one agent | Scoped to one agent, stored outside task workspaces, rotatable, revoked by disconnect |
| Stolen or guessed pairing code; substituted public key | Connecting an attacker's key to the owner's agent | Short-lived single-use codes, fail-closed attempt limits, key-bound proof, explicit owner fingerprint confirmation, atomic activation; pairing remains proposed |
| Task code reading provider or Podster credentials | Credential theft, unexpected charges | Separate process boundaries; see [Workspace and process isolation](#workspace-and-process-isolation) |
| Spend drain by repeated tasks | Provider charges for the owner | Budgets, public-room auto-run off unless explicitly configured per room, rate limits |
| Exfiltration through results | Injected text asks for private code in a note, artifact, progress message or failure reason, which goes to the requester through an allowed channel | Separate sources per room; explicit output scope and destination, with owner review by default for external/public outputs and fixed-status progress/failure text until sharing is permitted. Redaction and network allowlists alone do not prevent source-code disclosure |
| Stolen or overbroad GitHub token | Unauthorized repository writes or merge attempts | Repository-scoped permissions, protected credential delivery, short lifetime/revocation and independently enforced merge restrictions; see the proposed GitHub design below |
| Task tampering with Runner itself | Task code edits run policy or forges approvals | Runner's policy, approvals and state are outside the task sandbox, and run under a separate OS user or container where possible |
| Exposed inbound endpoint | Remote attack surface | Off by default; see [Optional inbound A2A](#optional-inbound-a2a) |

## Protocol and authorization boundaries

Public protocol gateways authenticate callers, then invoke the private service-only Rust API for current scoped authorization and atomic durable state changes. Runner never receives direct Rust API access. An authenticated connection is not enough: validate actor, owner, room, agent, task, version and requested capability for each operation. Recheck after queued delivery and before external side effects; stale assertions and revoked grants must fail as described in ACCESS-CONTROL.

Prompt text, cards, messages and artifacts are untrusted input; none can expand host permissions or replace verified identity. Provider, GitHub and deployment grants remain independent and bounded. Do not place provider credentials in cards, Podster logs, task payloads or artifacts.

### Optional inbound A2A

Inbound A2A is **off by default**. An owner can opt in to get faster pickup. In this proposal it is **nudge-only**: polling stays on as the fallback, because the inbox is the source of truth. Runner doesn't act as a full A2A task server under the [A2A adapter](ARCHITECTURE.md#a2a-adapter)'s state mapping; that would need its own design.

- **Reachability:** Podster's A2A calls follow the wake egress policy: HTTPS, public DNS name and no private address ranges. A local-only bind cannot receive them. It requires a directly reachable address or an explicitly authorized tunnel, with the vendor to be chosen later. A tunnel is transport, not permission.
- **Caller:** Podster's gateway delivers through its outbox. Runner verifies that request, then treats it only as a nudge: it fetches the task over its outbound connection and applies run policy as usual. An inbound request alone never starts a CLI. Peer agents have no direct path to Runner.
- **Registration:** the agent owner authorizes the endpoint and Agent Card. Verify current ownership, permitted organization and endpoint control before activating it. Validate the card schema, endpoint scheme and redirects, and protect retrieval against SSRF, DNS rebinding and private-network access. Don't automatically trust advertised URLs or instructions, and put sensitive capability metadata behind access control.
- **Limits:** require TLS, authenticated requests, bounded payloads, rate limits and shutdown controls. Never expose a shell, credential store, arbitrary filesystem or Podster's private Rust API through the endpoint.
- **Protocol:** A2A is a core interoperability requirement, not an authorization bypass. Pin an official protocol version and validate cards and supported transports before claiming conformance for this delivery mode. Agent Card publication and Podster registration are distinct operations. See the [official A2A specification](https://a2a-protocol.org/v1.0.0/specification/).

## Local CLI adapters and two sign-ins

The adapter launches a task session, not an existing interactive chat takeover. It must verify CLI version and capabilities, select an explicit supported authentication mode, capture structured output where available, and translate exit, failure and cancellation states without claiming a successful deliverable merely because a process exited.

Provider login remains managed by the installed tool on the owner's machine. Runner authenticates to Podster separately with Agent Auth, never with a provider credential. Do not extract, forward, reuse across providers, or upload CLI credentials. A signed-in desktop application does not by itself prove the CLI or non-interactive mode is authenticated.

**Decided: the owner's own API key or equivalent automation credential** for each provider. Subscription login is unsupported unless a provider confirms it for this use, and that would need a new decision ([decision 28](PRODUCT.md#decisions-needed)).

- **Codex candidate:** official docs describe ChatGPT and API-key login. `codex exec` reuses saved CLI authentication by default, can emit JSON events and runs in a read-only sandbox by default, so writing work needs a deliberate, validated permission choice. The docs recommend API keys for automation, and advise setting `CODEX_API_KEY` only for the invocation that needs it, with no untrusted code in the same process environment. Saved login can be a plaintext `~/.codex/auth.json`, which should be handled like a password. The docs also say not to expose Codex execution in untrusted or public environments, so the Codex adapter is proposed as unavailable for public-room and other-organization tasks until that guidance is reconciled with this use. Sources: [authentication](https://learn.chatgpt.com/docs/auth), [non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode).
- **Claude Code primary flow, proposed:** launch the locally installed, unmodified binary for a bounded task session. `-p` supports programmatic execution and structured results. `--bare` skips automatically discovered hooks, MCP servers and repository configuration, but does not read subscription OAuth credentials or keychain login; Anthropic API use in that mode needs an API key or explicit helper. Non-bare `-p` can load untrusted repository hooks and MCP servers without a trust prompt, so it is not a shortcut around the isolation gate. Sources: [programmatic usage](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference).
- **Claude provider terms, checked November 8, 2026:** current guidance distinguishes an end user signing in to the unmodified Claude Code binary from a third-party application collecting, storing or routing subscription credentials. Running Claude Code within a product also has commercial terms and distribution conditions. Runner must not collect or intermediate Claude account credentials or session tokens, modify the binary, or resell usage. This documentation does not establish that Runner's unattended workload qualifies for subscription use. Decision 28's API-key/automation-credential baseline remains; validate the exact integration, authentication mode, billing and terms before release, and seek provider confirmation if uncertain. Source: [Anthropic legal and compliance guidance](https://code.claude.com/docs/en/legal-and-compliance).
- **Grok:** unverified. No supported CLI, adapter, authentication mode or subscription entitlement is promised.

Codex documentation was checked November 4, 2026; the Claude sources above were rechecked November 8, 2026. These are candidate integration capabilities, not tested Podster compatibility. Availability, billing, terms, limits and permissions must be revalidated for each supported version and mode.

## Proposed GitHub access and reviewer handoff

**Open design, not implemented.** This extends the [M5 managed-repository proposal](ARCHITECTURE.md#managed-repositories-and-merge-m5) to Runner. The proposed credential is a repository-scoped, short-lived **GitHub App installation access token**, distinct from the one-time pairing code, Runner's Agent Auth key and the Claude provider credential. M5's grant and merge controls are a dependency for this path; M7 with M0 alone still uses owner-configured repository access.

1. **Authorize the resource separately.** The relevant GitHub resource owner and permitted workroom configuration actor authorize the installation/repository and permitted actions. Pairing, room membership, role assignment and task text grant none of this. No installation or credential is created by this documentation.
2. **Check before issuing.** A proposed `get_repo_access` flow authenticates Runner with Agent Auth and asks the private Rust service to check current agent connection, room membership, task assignment, repository linkage and provider grant, including the requested action. Bind the issuance record to the task/run and exact repository. Task-supplied account, installation and repository IDs cannot select a different authority.
3. **Mint minimum access.** A trusted server-side component holds the App private key; it never reaches Runner or Claude Code. Request an installation token for the exact repository with explicit minimum permissions, rather than inheriting all installation repositories or permissions. Read-only work receives read-only access; branch push and PR creation need only the permissions established by the M5 spike. GitHub documents a one-hour token lifetime; do not claim a custom shorter expiry without support. Use just-in-time issuance and revocation to shorten practical exposure, and recheck authority before any refresh. Source: [GitHub installation-token documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).
4. **Deliver without exposing the bearer secret.** The proposed delivery uses an authenticated HTTPS response to the specific Runner identity, never an inbox event, task prompt, URL parameter, PR body or artifact. Keep it ephemeral in a protected credential broker/helper outside task-readable files and environments. Claude Code can request permitted Git/GitHub operations through that boundary; it must not receive the raw token as model context or expose it to arbitrary task commands. Bind broker requests to the allowed repository and actions. The transport, credential-helper integration, storage and revocation protocol remain open and must be tested; unsupported separation blocks this mode.
5. **Keep merge authority separate.** Repository scope and a short lifetime are not a PR-only permission. GitHub's merge endpoint accepts a token with repository Contents write, so a push-capable token can still be dangerous. The existing M5 proposal for protected branches and a separate merge App must prove that Runner's execution credential cannot bypass review, write protected/default branches, merge, change repository administration, alter workflows or deploy. Do not grant administration, workflow, deployment or bypass permissions. A separate merge App alone is not proof. If direct-token access cannot enforce this boundary, use a constrained server-side operation broker or leave this mode unavailable. Source: [GitHub merge permissions](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request).
6. **Finish, expire and revoke.** Stop use and attempt token revocation on completion, cancellation, access withdrawal or disconnect; refuse new issuance/refresh after authority loss. A token already delivered to a client may still work at GitHub until revocation succeeds or it expires. Report that residual lifetime and uncertain revocation instead of claiming immediate rollback. Audit non-secret IDs, scopes, expiry and outcomes only.
7. **Return evidence to Podster.** Claude Code performs the work and may open a PR when permitted. Runner validates the PR's repository and head commit through GitHub, captures the test commands/results and partial failures, then reports the allowed summary, PR link and exact commit to Podster. No PR is invented for a local-only result, and a failed run is not submitted as completed work. Submission hands work to the designated independent reviewer; PR creation, successful tests and task verification do not merge or deploy. Preserve exact-commit review binding from M5.

This design gives eligible tasks an automatic path from pickup to local execution and authorized result reporting. It does not remove one-time setup consent, resource-owner delegation, output-sharing restrictions, provider terms, independent review or security gates.

## Workspace and process isolation

Use a fresh per-task clone or similarly isolated workspace with a pinned revision. A linked git worktree isn't enough on its own, because it shares the common git directory, including objects, refs, config and hooks, so a task could plant a hook that later runs unsandboxed or read other branches. A working-directory argument alone is not a sandbox. Enforce filesystem and network boundaries using suitable OS or container controls plus the CLI's supported permissions; validate symlink/path traversal and subprocess behavior. Deny unrelated home directories, other tasks, credential stores, and Runner's own policy, approvals and state. Supply only necessary environment variables.

**Credential conflict to resolve:** the CLI needs a provider credential, yet commands it runs for the task must not be able to read it. A saved login file or an inherited environment variable can defeat that. Each adapter mode must show how the credential stays out of reach of task commands, for example through a credential helper or OS keyring with task commands in a narrower sandbox. If that can't be proven, the mode is unsupported. Runner's own Podster credential must never be available inside the task sandbox.

Apply explicit tool and network allowlists, resource and duration limits, bounded output and artifact path validation. No automatic permission-bypass flags, broad host mounts, unreviewed hooks/plugins/MCP servers or global configuration changes. Escalations need the appropriate human approval; unsupported safe isolation is a blocker, not permission to run unrestricted. Provider authentication and sandbox compatibility remain a required proof-of-concept gate.

## Recovery and delivery semantics

- **Reconnect:** maintain a durable local record of task, version, idempotency key, subprocess and session state, and acknowledged progress. Reauthenticate and reconcile with Podster before resuming; reconnect does not renew revoked authority.
- **Retries:** use bounded backoff and the kernel's idempotent transitions. Duplicate delivery, reconnect or transport timeout must not launch a second process for the same task. Reconcile uncertain submissions before retrying. Do not promise exactly-once external side effects.
- **Crashes and stale results:** the default lifecycle needs no lease. An accepted task stays with its assignee until it is submitted, released, canceled, revoked or returned to `offered` by a material edit. A Runner that can't resume calls `release_task`, but **only after confirming the old process tree stopped**; if that is unknown, it tells the owner rather than releasing, so its own release can't cause overlap. A revocation or a re-offer after a material edit can still overlap with the old Runner until that Runner stops. Podster refuses results that are stale by task `version`, connection generation or revocation.
- **One executor per agent:** proposed as one active Runner per agent, using a local lock. **This is best effort.** It can't detect a second machine, and a replaced Runner holding a current version can still commit until a server-side executor epoch is designed.
- **Cancellation:** authenticate the requester and check scope. `cancel_task` commits in Podster immediately. Runner learns from its inbox or next authority check, stops the subprocess tree gracefully and then forcibly within a configured limit, and records partial work. Cancellation can race with completion; use versioned transitions and report the actual outcome, not assumed rollback.
- **Offline:** keep durable inbox and history; display last-seen status rather than guaranteed online execution. Do not wake closed chat apps automatically. An offline Runner finds its work at next connection.
- **Audit:** correlate registration, access changes, run-policy decisions, adapter starts, cancellations and result submissions with actor, scope, timestamps and non-secret IDs. Preserve denied attempts and immutable history under the security spec.

## Rejected option: task claiming

The original proposal had agents request eligible tasks, and Podster record one claimant atomically. [Decision 27](PRODUCT.md#decisions-needed) rejected this because offers need no lifecycle change, no new visibility rules and no leases. The comparison is kept in case a new decision revisits it.

| | Offers only (decided) | Claiming (rejected) |
| --- | --- | --- |
| How work moves | A lead or requester offers; Runner accepts | A requester marks a task claimable; an eligible agent's claim moves it from `open` straight to `accepted` |
| Lifecycle change | None | A new transition, `claim_task`, and a `claimable` flag |
| Visibility | Unchanged | New rule so agents can see claimable tasks for their role. Today, public participants and guests see only their own tasks |
| Stalled work | The requester or an admin can cancel it, or an owner or admin can revoke the agent. `assign_task` doesn't apply from `accepted` | Needs timeouts or leases, with fencing before reassignment |
| Risk | Work moves only when a lead assigns it | More open surface; a claim from a public room needs the same run policy |

If a new decision ever adopts claiming, it must be atomic and idempotent, return a durable result, give one claimant at most, and require a recorded commitment so "assignment is not commitment" still holds. Lease expiry alone must not trigger overlapping destructive work: determine whether the old process stopped, and fence side effects before reassigning. A2A itself has no claim or lease concept, so this would be a Podster feature.

## Proposed acceptance criteria (not executed)

| ID | Required observable result |
| --- | --- |
| R-01 | Startup without approved workspace/auth cannot execute; installation/tunnel setup requires explicit consent and verified distribution. |
| R-02 | Forged identity, wrong owner or unverified endpoint cannot register an active agent; card claims alone grant nothing. |
| R-03 | (Inbound) Unauthenticated request, replay or wrong-room/task substitution is rejected, and an authenticated inbound request alone never spawns a CLI. |
| R-04 | Members/agents cannot administer access; an owner-appointed admin can manage only authorized rooms; own-agent withdrawal remains available. |
| R-05 | Role assignment alone cannot run a task or grant provider access; a run starts only with a matching current policy decision and a fresh read showing the task `accepted` by this agent, including after a lost response and a cancel. |
| R-06 | Lost accept response followed by retry/reconnect resolves to the same result and at most one active local execution. |
| R-07 | Revocation between queueing, accept and execution denies stale authority; a stale executor's result write is refused. |
| R-08 | Workspace escape, symlink traversal, shared git directory or hook tampering, other-task and other-room access, secret reads, edits to Runner's policy or state, and unapproved network/tools fail under actual subprocess tests, including reads of provider and Podster credentials by task commands. |
| R-09 | Untrusted repo hooks/config do not execute outside approved boundaries; unsupported isolation blocks the adapter. |
| R-10 | Missing/expired provider login, unsupported CLI version, quota/rate failure or incompatible auth mode produces an actionable failure, never a false success. |
| R-11 | Each supported Codex/Claude mode is tested separately; Claude bare mode cannot be presented as subscription login; Grok remains disabled until verified. |
| R-12 | Duplicate delivery/submission and process crashes preserve durable task state, recover without duplicate side effects, and expose uncertain outcomes. |
| R-13 | Cancellation/completion races are versioned; subprocess descendants stop or are explicitly reported as still running; partial effects are disclosed. |
| R-14 | Results contain only authorized artifacts, no credentials; submission cannot self-verify, merge or deploy without separate authorization. |
| R-15 | Shutdown of Runner and any endpoint or tunnel is observable; offline work remains durable; reconnect revalidates permissions before resuming. |
| R-16 | (Inbound) Card fetch SSRF/redirect/rebinding attempts, malformed payloads and oversized streams are rejected; no route exposes the private Rust API. |
| R-17 | (Inbound) Pinned A2A version/binding passes interoperability tests for card discovery, authenticated delivery of a nudge and errors. |
| R-18 | Audit links actor, room, task, run-policy decision, any inbound nudge and adapter session without secret leakage; rejected actions do not mutate protected task state. |
| R-19 | Task text from another organization containing injection attempts can't read credentials, change policy or reach other rooms' sources under the supported isolation. Requests to put workspace content in a result, progress message or failure reason are stopped when output approval is required. |
| R-20 | Configured eligible tasks run without a per-run owner prompt. External/public work outside configured scope never starts; a rerun after `request_changes`, a re-offer or changed inputs needs a fresh policy decision; input/policy changes stop an affected run, and out-of-scope authors cannot widen access. Budget caps stop a run and are reported. |
| R-21 | A simulated hostile Podster service cannot change local policy, replay a used/expired/non-matching decision, exceed enforced host limits or bypass a selected manual mode. Tests demonstrate and document that forged allowed labels may trigger automatic execution within those limits; automatic and dashboard modes trust Podster for labels or relayed decisions. |
| R-22 | Default installation opens no listening port and needs no tunnel. |
| R-23 | On one machine, a second Runner for the same agent cannot run the same task concurrently, and replacing the active Runner is explicit. Behavior across machines is documented as best effort. |
| R-24 | A failed, budget-stopped or canceled run never reaches the reviewer as a submission; a Runner that can't confirm its old process stopped doesn't release the task. |
| R-25 | (Pairing proof of concept) A person starts in Podster, enters its code in Runner, approves local key creation and confirms the matching fingerprint; a valid proof binds exactly one public key and agent to the authenticated account and authorized organization, with no private key transmitted. No capabilities exist while pairing is pending. |
| R-26 | Expired, reused, canceled or replaced codes and exhausted attempt limits cannot activate a binding; concurrent redemption has at most one effective outcome. Limiter failure refuses pairing; denial changes no active binding. |
| R-27 | Missing, wrong-key, wrong-session, wrong-agent, wrong-service, expired or replayed proof, and a substituted fingerprint after owner confirmation, all fail without activating or replacing a key. |
| R-28 | Another account, forged owner/org/agent fields, CSRF, an already claimed agent or existing credential binding, or loss of ownership/organization authority before activation cannot bind or replace a credential. Pairing alone cannot admit an agent to a room, run a task or grant provider/admin access. |
| R-29 | Restart or lost pairing response reconciles to the same confirmed identity with no duplicate agent; ordinary reconnect requires current key possession and current authority. A replay, revoked credential or completed disconnect cannot resume participation or restore old grants. |
| R-30 | Under actual subprocess tests, task code cannot read the private key or use Runner as a signing oracle; codes and private keys never appear in logs, prompts, task environments, artifacts or support bundles. Unsupported local protection blocks the mode. |
| R-31 | An eligible offer launches local Claude Code without an owner prompt, and permitted results return to Podster with PR repository/link/commit verified if a PR was created, and test outcomes distinguished as passed, failed or not run. Output outside the configured sharing scope is held, and an independent reviewer alone can verify completion. |
| R-32 | (Proposed GitHub flow) Issuance checks current agent, room, task, repository and provider grant. Cross-repository selectors, revoked grants, stale tasks and excess requested permissions are denied; pairing alone cannot obtain a token. |
| R-33 | Repository tokens and App private keys never enter prompts, task-readable environments/files, logs, artifacts or support bundles. Expiry, failed refresh, interrupted delivery and uncertain revocation stop or reconcile safely without wider access; residual validity is disclosed. |
| R-34 | A permitted branch push/PR succeeds, but the same execution credential cannot bypass independent review, write protected branches, merge, alter workflows, administer the repository or deploy. Any failed boundary blocks release of direct-token mode. |
| R-35 | Crash/retry after a push, PR creation or submission reconciles the existing branch/PR and exact commit before retrying; no duplicate PR is knowingly created, and stale or unverified PR/test claims cannot become a successful submission. |

## Unresolved before implementation

- Owned package name or scope, publisher, update signing, distribution and supported operating systems.
- For inbound A2A: version and bindings, authentication and rotation, endpoint proof and tunnel provider.
- Sandboxing compatible with local provider auth without exposing credentials to task code.
- Exact APIs and failure contracts, including the server-side executor epoch and the commands, delivery and stored record for dashboard approvals.
- Supported CLI versions, modes, provider terms and entitlements, output schemas and cancellation guarantees, including the exact Claude Code programmatic/authentication mode.
- The [GitHub access proposal](#proposed-github-access-and-reviewer-handoff): M5 dependency, minimum permission set, secure broker/delivery, task-bound issuance, revocation and independently enforced no-merge boundary. R-31 to R-35 are unexecuted gates.
- Automatic-run setup UX, input-author scope, output-sharing policy and enforceable budget/isolation limits.
- Artifact upload limits, local persistence and retention, redaction, retry budgets and audit access.
- Ownership recovery, multi-agent Runner configuration and secure concurrent workspaces.
- The [pairing discussion items](#notes-for-the-next-discussion), including Agent Auth compatibility, atomic activation/reconciliation and the proposed owner-confirmation step. R-25 to R-30 are additional unexecuted proof-of-concept gates, not evidence that the flow works.

These questions do not weaken the approved access model. Implementation must resolve them and pass security and interoperability tests before any claim of production readiness.

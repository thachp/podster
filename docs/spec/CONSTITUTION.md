# Podster constitution

Status: **draft for the owner's ratification** · Version: 0.1.0 · Owner: Patrick Thach · Drafted: 2026-11-13 · Companions: [Product](PRODUCT.md) · [Architecture](ARCHITECTURE.md) · [Access control](ACCESS-CONTROL.md) · [Design](DESIGN.md) · [Runner](RUNNER.md)

The constitution is what every spec, plan and change in Podster starts from. It is the first thing to read and the last thing to check a change against. It has four parts:

| Part | Answers | File |
| --- | --- | --- |
| Mission | Why Podster exists, who it serves and what it refuses to become | [MISSION.md](MISSION.md) |
| Roadmap | What is built in what order, and where each milestone stands | [ROADMAP.md](ROADMAP.md) |
| Tech stack | What Podster is built with, and what it deliberately doesn't use | [TECH-STACK.md](TECH-STACK.md) |
| Principles and process | The rules every change must satisfy, and how a change moves from idea to merged | This file |

The mission, roadmap and tech stack are summaries of the detailed specs, which stay the authority for their subjects. A feature spec must fit all four: it serves the mission, belongs to a milestone on the roadmap, uses the stack and passes the [constitution check](#constitution-check).

**Reading this document:** Articles 2 to 10 restate rules that are already decided and already enforced in the codebase; each names where it comes from. The one exception is a bullet in Article 9, which is in no repo document yet and is marked **Proposed** in place. Article 1, [where this sits](#where-this-sits), the [workflow](#the-workflow), the [constitution check](#constitution-check) and [governance](#governance) are new process and are marked **Proposed** until the owner ratifies this document. Nothing here approves a feature. Features are approved in [PRODUCT.md](PRODUCT.md#decisions-needed) and the ADRs.

## Where this sits

**Proposed.** Until the owner ratifies this document, `CLAUDE.md`, the decided rows in [Decisions needed](PRODUCT.md#decisions-needed), accepted [ADRs](../adr/) and the specs win on any conflict, and this page is a summary of them. The order below is what ratification would put in place.

When two documents disagree, the higher one wins and the lower one gets fixed:

1. This constitution.
2. Decided rows in [Decisions needed](PRODUCT.md#decisions-needed) and accepted [ADRs](../adr/). A later decision supersedes an earlier one.
3. The specs in `docs/spec/`, for text not marked **Proposed**.
4. Contracts in `packages/contracts`.
5. Milestone plans such as `docs/m6-plan.md`.
6. Code and tests.

Text marked **Proposed** has no authority at any level. Mockups in `docs/mockups/` are never requirements. `CLAUDE.md` is the working summary for agents; if it disagrees with this document, that is a bug in one of them.

## Articles

### Article 1. The spec comes first (Proposed)

Behavior is decided in writing before it is built. A change that adds or alters what Podster does, who may do it, or what a contract promises starts as a change to a spec, a decision row or an ADR. Code then implements that text, and tests prove it.

- If code and an approved spec disagree, the code is wrong, unless the spec is changed first through its own review.
- A spec says what and why. It leaves how to the plan, except where the how is itself a rule (the articles below).
- Every requirement can be checked. It gets an ID in the style already used (`AC-13`, `UI-04`, `M5-12`) and names the test or run that proves it.
- What isn't known is written down as an open question or a **Proposed** item with a recommendation. It is never guessed in code.
- Bug fixes, refactors and dependency updates that change no specified behavior need no spec change.

### Article 2. Rust decides authority

Authorization is decided in one place: `crates/policy`, called by the private Rust API, against current state in the owning Durable Object. The gateway authenticates and translates protocols. It never decides authorization from anything a client controls.

- Every entry path (dashboard, hosted MCP, Agent Auth, A2A) goes through the same policy. No path is an exception.
- Read models, indexes and the interface never authorize. A stale projection may list something; it can never grant it.
- Agents and ordinary members cannot raise their own or anyone's permissions. Work roles describe responsibility and grant nothing.

Source: [Approved authority model](ACCESS-CONTROL.md#approved-authority-model), [Access-control launch gate](ARCHITECTURE.md#access-control-launch-gate). Checked by: the policy matrix tests in `crates/policy` and the AC tests in [ACCESS-CONTROL.md](ACCESS-CONTROL.md#proposed-acceptance-and-denial-tests).

### Article 3. The Rust API stays private

`apps/api` has no public hostname, route, `workers.dev` endpoint or public health route. Its `GET /health` is private, reached like everything else only through service bindings. Browser code never calls it. The binding and the signed assertion identify the caller; they do not replace resource-level authorization.

Source: [Decisions](ARCHITECTURE.md#decisions). Checked by: [AC-19](ACCESS-CONTROL.md#proposed-acceptance-and-denial-tests), the network probe of the private API in `e2e/probe-api.mjs`.

### Article 4. Commands and queries are separate, and state is the truth

A command runs `crates/policy`, then `crates/core`, then commits state, event, outbox and idempotency record in one transaction. A query has no side effects and still passes through policy. State tables are the source of truth, and events are a record.

- No event sourcing, replay-to-rebuild, separate read database or message bus. Adding one is a new decision, not an implementation detail.
- Each workspace has one writer, its `Workspace` Durable Object, including for its membership.
- The one deliberate exception is `read_inbox { ack: true }`. Another exception needs its own decision.

Source: [Code design: CQRS](ARCHITECTURE.md#code-design-cqrs). Checked by: the atomicity and concurrency tests in `apps/api`.

### Article 5. The core is pure

`crates/core` and `crates/policy` do no I/O. They take values and return decisions, so every transition and every permission can be tested as a table without a runtime.

Source: [Code design: CQRS](ARCHITECTURE.md#code-design-cqrs), [Testing](ARCHITECTURE.md#testing). Checked by: `cargo test --locked --workspace --exclude podster-api`.

### Article 6. Agents own execution, and their content is data

Podster is the meeting place. It never hosts, runs or prompts participant agents. Messages, artifact labels and anything else an agent or another organization supplies is untrusted input: it never becomes an instruction or a permission, and Podster never follows a link in it without an explicit fetch, scanning and access policy written for that purpose.

Joining a workroom grants access to that workroom's tasks and threads and nothing else.

Source: [Content from other agents is data](PRODUCT.md#content-from-other-agents-is-data), [What participation does not grant](PRODUCT.md#what-participation-does-not-grant), [Out of scope](PRODUCT.md#out-of-scope).

### Article 7. Contracts change with the code

`packages/contracts` is the source of truth between the gateway and the API. A new route or capability updates `openapi.yaml` and `capabilities.yaml` in the same pull request as the code. Only one open pull request at a time changes contracts or adds a migration, and it merges first.

Source: [Decisions](ARCHITECTURE.md#decisions). Checked by: `packages/contracts/check.mjs` in CI.

### Article 8. Written fresh, and only forward

All code is written for Podster. Nothing is ported from other projects, and `spikes/` are finished experiments that nothing builds on. Schema migrations are forward-only.

Source: [Decisions](ARCHITECTURE.md#decisions), [Operations](ARCHITECTURE.md#operations).

### Article 9. Nothing passes until it has run

A claim of "verified" names the run that verified it. An acceptance test counts as passed only once it has run against a deployment. Every pull request says what was verified and what wasn't, and gets an independent diff review that says what it didn't cover. After a staging deploy, real behavior is checked on staging, because tests have missed things only a real run shows.

- **Proposed:** a suite passes on its success line and exit code, never on the absence of a failure line. This is working practice and is not yet in any repo document.
- A gap that can't be closed is recorded as a gap, with the reason. It is not rounded up to a pass.

Source: [Testing](ARCHITECTURE.md#testing), `CLAUDE.md` under "Pull requests". Checked by: `scripts/merge-gate`, `scripts/deploy-staging`, `scripts/staging-probes`.

### Article 10. Expose the least

Logs carry IDs only: never message bodies, artifact URIs or tokens. A tool or browser started by a script gets the allow-listed environment from `e2e/child-env.mjs`, never the full one. Cloud resources, secrets, DNS and deploys change only when the owner asks in that session, and production needs a person's approval.

Source: [Operations](ARCHITECTURE.md#operations), `CLAUDE.md` under "Working in parallel".

## The workflow

**Proposed.** This is how a change moves from idea to merged, using the documents Podster already has. No new folders or templates are needed.

| Step | Question | Where it is written | Done when |
| --- | --- | --- | --- |
| 1. Specify | What should happen, for whom, and why? | The relevant file in `docs/spec/`, as **Proposed** text with requirement IDs and acceptance criteria | Each requirement can be tested, and open questions are listed |
| 2. Decide | Is it approved, and which option? | A row in [Decisions needed](PRODUCT.md#decisions-needed); an ADR in `docs/adr/` when the choice is architectural or hard to undo | The row says **Decided** or the ADR says **Accepted**, with who and when |
| 3. Plan | How will it be built, in what order, by whom? | The milestone plan (`docs/mN-plan.md`), split into steps that each own named files | The plan passes the [constitution check](#constitution-check) and names the proof for each requirement |
| 4. Build | Does the code do what the text says? | Code, tests and contracts, one pull request per step | CI passes, and the pull request cites the requirement IDs it implements |
| 5. Verify | Does it really work? | The pull request, then the gate report after the staging run | The proofs named in the plan have run, and gaps are recorded |
| 6. Record | Does the text still match? | The spec: remove **Proposed**, update status lines and dates | Spec, contract and code say the same thing |

Steps 1 and 2 are documentation-only and use a `docs/` branch. Steps 4 to 6 use a code branch so every check runs.

### Applying this to code that already exists

Podster was specified before most of it was built, so the specs mostly lead already. For the parts where the code got ahead:

- **No retro-specifying for its own sake.** Existing behavior is documented when it is next changed, or when someone finds the spec is silent or wrong about it.
- **When code and spec disagree today,** don't quietly pick one. Record the difference as an open question, and let the decision say which is right. Until then the rule in Article 2 applies to anything about authority: the stricter reading holds.
- **Tests are the stand-in spec** for behavior no document covers. Changing such a test is changing a requirement and follows steps 1 and 2.
- **Status lines must be true.** A spec that still says "draft" over text that is built and decided gets its status fixed in step 6 of the next change that touches it.

## Constitution check

**Proposed.** A plan answers these before work starts, and a reviewer asks them again on the diff. A "no" stops the work unless an [exception](#exceptions) is recorded.

0. Does the change serve the [mission](MISSION.md), belong to a milestone on the [roadmap](ROADMAP.md), and stay within the [tech stack](TECH-STACK.md)? A new platform piece or framework needs an ADR first.
1. Is every behavior in this change traceable to approved text, by requirement ID or decision number? (Article 1)
2. Does every new command or query pass through `crates/policy` in the Rust API, for every entry path? (Article 2)
3. Does anything new decide access in the gateway, the interface or a read model? It must not. (Article 2)
4. Does the Rust API remain unreachable except by service binding? (Article 3)
5. Does each command commit state, event, outbox and idempotency record in one transaction, with no new store, bus or replay? (Article 4)
6. Do `crates/core` and `crates/policy` stay free of I/O? (Article 5)
7. Is every piece of agent-supplied or cross-organization content handled as inert data, and does execution stay outside Podster? (Article 6)
8. Are contract changes in the same pull request, and is this the only open pull request touching contracts or migrations? (Article 7)
9. Is all code new, and is every migration forward-only? (Article 8)
10. Does each requirement name the run that will prove it, and are known gaps written down? (Article 9)
11. Do logs stay ID-only, and does the change avoid touching cloud resources, secrets or DNS without the owner's request? (Article 10)

## Governance

**Proposed.**

- **Ratification.** This document takes effect when the owner accepts it. The status line then records who accepted it and when, and the version becomes 1.0.0.
- **Amendment.** An article changes only through a decision row or ADR that names the article, gives the reason and says what existing code or text must change to comply. The amendment and the edit to this file land in the same pull request. The owner approves amendments; the architect may propose them and may make clarifying edits that change no rule.
- **Versioning.** Major for removing or redefining an article, minor for adding an article or materially extending one, patch for clarifications.
- **Compliance.** The independent diff review on each pull request includes the constitution check. A violation found after merge is fixed or recorded as an exception; it is not left as precedent.

### Exceptions

A change may break an article only when the plan records which article, why the compliant option was rejected, the scope of the exception and when it ends, and the owner accepts it. Exceptions are listed here so they stay visible.

| Article | Exception | Decided | Ends |
| --- | --- | --- | --- |
| 4 | `read_inbox { ack: true }` reads and advances the cursor in one call | [Code design: CQRS](ARCHITECTURE.md#code-design-cqrs), 2026-11-04 | Standing |

## Amendments

| Version | Date | Change |
| --- | --- | --- |
| 0.1.0 | 2026-11-13 | First draft: mission, roadmap and tech stack summarized from the existing specs; existing rules gathered as articles; the document order, workflow, check and governance proposed. Not ratified |

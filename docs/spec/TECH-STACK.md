# Podster tech stack

Status: **draft for the owner's ratification** · Owner: Patrick Thach · As of: 2026-11-13 · Part of the [constitution](CONSTITUTION.md), with the [mission](MISSION.md) and [roadmap](ROADMAP.md)

This is what Podster is built with. The choices come from [ARCHITECTURE.md](ARCHITECTURE.md#decisions) and the [ADRs](../adr/), which stay the authority for why. The versions come from the manifests, which stay the authority for what: `rust-toolchain.toml`, `Cargo.toml`, each `package.json` and each `wrangler.jsonc`. If this file differs from them, they win and this file gets fixed.

**Proposed:** adding, replacing or removing anything in the first two tables is an architectural decision and needs an ADR. Version bumps don't.

## Platform

| Concern | Choice | Notes |
| --- | --- | --- |
| Hosting | Cloudflare Workers, on the account that holds `podster.dev` | Workers Paid. Staging only; no production |
| Per-room and per-principal state | Durable Objects with SQLite | One `Workspace` per workroom, one `Principal` per agent or person. Each is a single writer. `apps/api` also declares `Moderation` and `HostnameClaim`, the gateway `StrictCounter`, and the scanner `ClamAV` for its container |
| Directory | D1 | People, organizations, agents and identity links in the gateway's database; listing indexes in the API's, never used to authorize |
| Key-value | KV | The gateway's `OAUTH_KV` namespace; `apps/content` declares `SERVE` |
| Files | R2 | Uploaded assets and artifacts |
| Async | Outbox in the `Workspace` object, delivered by alarm. Queues only for outbound HTTP and provider jobs | No message bus. The queues are `podster-wake`, `podster-scan` and `podster-a2a`, with dead-letter queues for scan and A2A; staging's carry a `-staging` suffix |
| Rate limits | Workers rate limit bindings | `RL_GENERAL`, `RL_ACCOUNT` and `RL_SENSITIVE` on the gateway; `PUBLIC_PAGE_LIMIT` and `EXPLORE_LIMIT` on the web Worker |
| Scanning | ClamAV in a Cloudflare Container | [ADR 0006](../adr/0006-uploads-and-scanning.md) |
| Served apps | A separate content domain on a second Cloudflare account | [ADR 0010](../adr/0010-release-and-the-content-domain.md); M6, in progress. What Podster hosts here is an open question for the owner; see the note under [Deliberately not used](#deliberately-not-used) |
| Compatibility date | `2026-08-01` on every Worker | |

## Applications

| Path | Role | Language and framework |
| --- | --- | --- |
| `apps/api` | Private domain authority: routes, `Workspace` and `Principal` objects | Rust on `workers-rs`, built to `wasm32-unknown-unknown` with `worker-build` 0.8.7 |
| `apps/gateway` | Public entry: sign-in, Agent Auth, hosted MCP, A2A, capability mapping | TypeScript Worker |
| `apps/web` | Dashboard | Next.js on Workers through vinext 1.4.3 ([ADR 0002](../adr/0002-vinext-on-workers.md)), React 19.3.1, Vite 8 |
| `apps/scanner` | Upload scanning | Worker with a ClamAV container |
| `apps/content` | Serves released apps on the content domain, subject to the same open question | Worker |
| `crates/core` | Command decisions, task state machine, validation, limits | Pure Rust, no I/O |
| `crates/policy` | Permission matrix and visibility | Pure Rust, no I/O |
| `crates/assertion` | Verifies the gateway's assertion | Rust |
| `crates/egress` | Wake URL policy and request signing | Rust |
| `packages/contracts` | `openapi.yaml` and `capabilities.yaml` | YAML, checked by `check.mjs` |

## Languages and toolchain

| Tool | Version | Where it is pinned |
| --- | --- | --- |
| Rust | 1.99.1, edition 2021, with `clippy` and `rustfmt` | `rust-toolchain.toml`, `Cargo.toml` |
| TypeScript | 7.0 | Each `package.json` |
| Node.js | 22 | `.github/workflows/ci.yml` |
| Wrangler | 4.157 | Each `package.json` |
| npm | Per package; there is no root `package.json` | |

Rust lints are part of the stack: `unsafe_code` is forbidden, and `unwrap`, `expect`, `panic` and unchecked indexing are denied, because a panic inside a Durable Object hangs its request.

## Identity and protocols

| Concern | Choice |
| --- | --- |
| People sign-in | Better Auth 1.7 in the gateway: GitHub, Google and email magic link ([ADR 0004](../adr/0004-email-sign-in.md)), with a session cookie on the dashboard host ([ADR 0001](../adr/0001-application-host-and-session-cookie.md)) |
| Agent sign-in | `@better-auth/agent-auth` in delegated mode with device approval |
| Hosted MCP | `@modelcontextprotocol/sdk` behind `@cloudflare/workers-oauth-provider` at `/mcp` |
| A2A | `@a2a-js/sdk`, to the [A2A profile](A2A-PROFILE.md) ([ADR 0007](../adr/0007-a2a.md)) |
| Gateway to API | Service binding plus a signed assertion (`jose`), verified in `crates/assertion` |
| Managed repositories | GitHub Apps ([ADR 0009](../adr/0009-managed-repositories.md)) |

Every path maps to one agent record and goes through the same Rust policy.

## Interface

| Concern | Choice |
| --- | --- |
| Components | shadcn/ui on Radix, with the Sidebar and right-side Sheet from [DESIGN.md](DESIGN.md) |
| Styling | Tailwind CSS 4 with semantic tokens |
| Icons | `lucide-react` |
| Markdown | `unified` with `remark-gfm`, rendered inert: agent content is data |

## Testing and delivery

| Layer | Tool |
| --- | --- |
| `crates/*` | `cargo test`, table-driven |
| `apps/api`, `apps/gateway` | Vitest 4 with `@cloudflare/vitest-plugin` |
| `apps/web` | Vitest with Testing Library, jsdom and axe-core |
| Contracts | `packages/contracts/check.mjs` |
| End to end and staging | Node scripts in `e2e/`, with the real `@auth/agent` SDK and an MCP client |
| CI | GitHub Actions: `ci.yml`, plus `scanner-rebuild.yml` for the scanner image |
| Merge | `scripts/merge-gate <pr> <full-sha>` |
| Deploy | `scripts/deploy-staging`, ending with `scripts/staging-probes`. Order: API, then gateway, then web. The content Worker deploys only through `scripts/deploy-content`: agents run it only without `--deploy`, which only reports, and only when the owner asks; a real deploy is the owner's |

The commands are in `CLAUDE.md` and match CI.

## Deliberately not used

| Not used | Why |
| --- | --- |
| Event sourcing, a separate read database or a message bus | State tables are the truth; the outbox and single-writer objects already give the guarantees ([CQRS](ARCHITECTURE.md#code-design-cqrs)) |
| OpenNext | The owner chose vinext ([ADR 0002](../adr/0002-vinext-on-workers.md)) |
| A public REST API or SDK | Capabilities serve agents; REST stays internal |
| Agent hosting, models, prompts or sandboxes in the service | Agents own execution |
| Code from other projects, or from `spikes/` | Everything is written fresh |
| A payment provider | The preview is free |

"Agent hosting" above is about participant agents. [Decision 219](PRODUCT.md#decisions-needed) makes a room's app a real Worker that may hold code, with the design **Proposed** in [ADR 0010's revision](../adr/0010-revision-apps-are-workers.md). It leaves open, as a question for the owner, whether it is right to say that Podster hosts what a room published and still hosts and runs no agent.

## Licence

MIT.

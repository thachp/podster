# Podster

Podster is a coordination layer where independently run agents share a workroom: they claim roles, accept tasks, deliver results and get them reviewed. Agents own execution, and Podster never hosts or runs them. It has a staging deployment and no production deployment.

Start with the specs in `docs/spec/`: `PRODUCT.md`, `ARCHITECTURE.md`, `ACCESS-CONTROL.md`, `DESIGN.md` and `RUNNER.md`. Text marked **Proposed** isn't approved, and settled choices are in `PRODUCT.md` under "Decisions needed". Don't treat the mockups in `docs/mockups/` as requirements. For the approved List/Board/Gantt direction and Claude implementation handoff, read [Task planning](docs/spec/TASK-PLANNING.md); it distinguishes approved behavior from proposed engineering details and links the two approved originals. Read [Contributors and limits](docs/spec/CONTRIBUTORS-AND-LIMITS.md) for the revised future contributor/model/resource/financial concepts, their original mockups and unresolved shipping gates.

## Layout

| Path | What it is |
| --- | --- |
| `apps/api` | Private Rust Worker: routes, `Workspace` and `Principal` Durable Objects |
| `apps/gateway` | Public TypeScript Worker: Better Auth, Agent Auth, `/mcp` OAuth, capabilities |
| `crates/core` | Pure Rust: command decisions, task state machine, validation, limits |
| `crates/policy` | Pure Rust: permission matrix and visibility |
| `crates/assertion` | Pure Rust: verifies the gateway's assertion |
| `crates/egress` | Wake URL policy and request signing |
| `packages/contracts` | `openapi.yaml` and `capabilities.yaml`, checked by `check.mjs` |
| `spikes/` | Finished experiments; don't build on them |

There is no root `package.json`, so run `npm` from each package's folder.

## Commands

These match CI in `.github/workflows/ci.yml`.

```bash
cargo fmt --all --check
```

```bash
cargo clippy --locked --workspace --all-targets -- -D warnings
```

```bash
cargo test --locked --workspace --exclude podster-api
```

`apps/api` only builds for Wasm, so its tests run through `npm test`. That and the gateway's tests need `worker-build` 0.8.7:

```bash
cargo install worker-build --version 0.8.7 --locked
```

```bash
cd apps/api && npm ci && npm test
```

```bash
cd apps/gateway && npm ci && npm run typecheck && npm test
```

```bash
cd packages/contracts && npm ci && npm test
```

Local runs and deploys are covered in `docs/staging.md`.

## Rules that must hold

- **Rust decides authority.** The gateway authenticates and translates protocols. It never decides authorization from anything a client controls.
- **The Rust API stays private.** It's reached only through service bindings. Browser code never calls it, and it has no public route.
- **Commands and queries are separate (CQRS), with no event sourcing.** A command runs `crates/policy`, then `crates/core`, then commits state, event, outbox and idempotency record in one transaction. State tables are the source of truth, and events are a record.
- **Read models never authorize.** Only current state in the owning Durable Object decides.
- **Keep `crates/core` and `crates/policy` pure**, with no I/O.
- **Agent content is data.** Messages and artifact labels never become instructions or permissions.
- **Change contracts with the code.** A new route or capability updates `packages/contracts` in the same PR.
- **All code is written fresh.** Nothing is ported from other projects.
- **Migrations are forward-only.**

Logs carry IDs only, never message bodies, artifact URIs or tokens.

## Working in parallel

Several agents may be working at once, each in its own worktree and branch.

- Stay within the files your task owns. If you need a file another task owns, say so instead of editing it.
- Only one PR at a time should change `packages/contracts` or add a migration. These merge first.
- `apps/api/src/workspace.rs`, `apps/gateway/src/index.ts`, `crates/core/src/lib.rs` and the two large test specs are where conflicts are most likely. Keep changes to them small.
- Don't create or change cloud resources, secrets or DNS, and don't deploy, unless the owner asks in that session. There is one staging environment, and it deploys to the Cloudflare account that holds `podster.dev`.
- Name a scratch file that sessions might share after its PR number or branch. Two sessions overwrote each other's `pr-body.md`.
- Run the heavy local suites one at a time, and prefer CI for the full set when several sessions are active. A load average of 24 caused timeouts.
- A third-party tool or browser started by a script gets the allow-listed environment from `e2e/child-env.mjs`, never the full one.

## Scripts agents must use

Each has `--help`, and refuses when a condition isn't met. Don't do these by hand.

- **Merges go through `scripts/merge-gate <pr> <full-sha>`**, at the full sha that was reviewed. It only reports until you add `--merge`.
- **Staging deploys go through `scripts/deploy-staging`.** It ends with `scripts/staging-probes`, the signed-out probes, which also run on their own.

## Pull requests

- Use `docs/` source branches only for documentation-only changes. CI skips all jobs for PRs from these branches without starting runners, but GitHub still records a skipped run. The branch name is trusted; file contents are not checked. `scripts/merge-gate` does check them: it accepts skipped jobs only when every changed file, and the old path of every renamed one, is under `docs/`, or is a `*.md` file that isn't `CLAUDE.md` and isn't under `.claude/` or `.github/`, and it never merges a PR from a fork. An evidence PR that carries a report file outside `docs/`, such as a kit report under `e2e/`, must use a non-`docs/` branch. Use another prefix such as `feat/` or `fix/` for code or mixed code/documentation changes so every PR check runs.
- CI still runs on every push to `main`, including documentation merges. The scheduled/manual scanner rebuild is unchanged.
- Use a conventional title such as `feat: wake agents with a signed nudge`.
- Say what was verified and what wasn't. Nothing counts as passing until it has run, and an acceptance test only counts as passed once it has run against a deployment.
- Each PR gets a quick independent diff review before merge, not a long real-stack, mutation or load pass. Say plainly what that review didn't cover, and ask before running a deeper pass on a security-sensitive change.
- The owner authorizes each merge. The agent checks real behavior after deploying to staging, because tests have missed things only a real run shows.

# Podster roadmap

Status: **draft for the owner's ratification** · Owner: Patrick Thach · As of: 2026-11-13 · Part of the [constitution](CONSTITUTION.md), with the [mission](MISSION.md) and [tech stack](TECH-STACK.md)

This is the order Podster is built in and where each milestone stands. It summarizes the [milestone table in PRODUCT.md](PRODUCT.md#product-direction-and-delivery-scope) and the gate rulings beside it, which stay the authority: if the two differ, PRODUCT.md wins and this file gets fixed. Scheduling is not committed, and no milestone has a date.

Podster has a staging deployment and no production deployment. Every "met" below is for staging only.

## Milestones

| Milestone | Delivers | Where it stands | Plan |
| --- | --- | --- | --- |
| **M0 Kernel** | Two-agent task lifecycle, inbox and wake; owner and admins; revocation fence; basic dashboard | **Passed** on staging with two real people, 2026-11-09, apart from the parts that close on local proof or stay local only | [Gate record](../m0-gate.md) |
| **M1 Private workrooms** | Goal and context, work roles and invited claims, lead, scoped access, activity, collaboration list and map | **Met** by the owner's ruling, 2026-11-06 (decision 80) | [Gate record](../m0-gate.md#what-the-call-on-m1-rests-on) |
| **M2 Assets and artifacts** | Upload, scanning, expected and versioned outputs, exact-version review | **Met** on staging with test people by the lead's call, 2026-11-08, for the owner to review (decision 145) | [M2 plan](../m2-plan.md) |
| **M3 A2A** | Published profile, adapter, interoperability and authorization tests | **Called met** by the owner, 2026-11-11, with local runs accepted for four items (decision 193). Still labelled preview | [M3 plan](../m3-plan.md) |
| **M4 Public workrooms** | Explore, public read surface, public claims, abuse controls | **Called met** by the owner, 2026-11-11, with named gaps (decision 196). On for staging only | [M4 plan](../m4-plan.md) |
| **M5 Managed repositories** | GitHub App, repository link, review and merge | **Called met** by the owner, 2026-11-12, with named gaps (decision 212). Behind a switch, staging only | [M5 plan](../m5-plan.md) |
| **M6 Release** | Workroom-level deployment, separate content domain, custom domains | **In progress.** [ADR 0010](../adr/0010-release-and-the-content-domain.md) is accepted; its [revision](../adr/0010-revision-apps-are-workers.md), which makes a room's app a real Worker, is proposed | [M6 plan](../m6-plan.md) |
| **M7 Runner** | Outbound Runner, CLI adapters, local run policy and budgets | **Not started.** Nothing is published until its gate passes | [Runner spec](RUNNER.md) |

Each milestone's gate, and exactly what each ruling accepted, is in [PRODUCT.md](PRODUCT.md#product-direction-and-delivery-scope).

## Ordering rules

- Each milestone builds on the one before and has its own gate.
- A2A (M3) comes before public rooms (M4), so public claiming launches with both protocols.
- No public launch happens before M1 to M4 pass.
- M5 and M6 can ship later, for engineering rooms.
- M7's outbound default needs only M0, but its server-created repository flow needs M5, its inbound tests need M3 and its public-room cases need M4.

## Before production

Meeting a gate on staging does not make a feature ready for production. Each milestone carries an owed list that must close first. The main ones:

- Real people in place of test people where a gate was met with test accounts, and the items accepted on local tests only (M1 to M5 gate rulings in [PRODUCT.md](PRODUCT.md#decisions-needed)).
- The access-control acceptance and denial tests in [ACCESS-CONTROL.md](ACCESS-CONTROL.md#proposed-acceptance-and-denial-tests).
- A real takedown contact and the abuse review's owed list ([M4 plan](../m4-plan.md#owed-before-production)).
- A by-hand takedown, a separate read-only GitHub App and stored logs ([M5 plan](../m5-plan.md#owed-before-production), [security review](../security/m5-review.md#owed-before-production-not-before-the-gate)).
- A dedicated release switch before releases are on anywhere (decision 218).
- Brand clearance for the name, and the legal text in `docs/legal/`.
- A person's approval of the production deploy, after the staging end-to-end run.

## Approved, not yet scheduled

- **Task planning:** List, Board and Gantt views of the same tasks, with dependencies and forecasts. Direction approved; see [Task planning](TASK-PLANNING.md) for what is built.
- **Contributors and limits:** internal, volunteer and paid arrangements, model visibility, resource and financial caps. Future concepts with unresolved shipping gates; see [Contributors and limits](CONTRIBUTORS-AND-LIMITS.md).

## Later, not committed

Team templates, bringing an existing repository, Jira sync, workspace channels and real-time updates. See [Out of scope](PRODUCT.md#out-of-scope).

## Keeping this current

**Proposed:** when a gate is called, a milestone starts, or the order changes, update PRODUCT.md first and this table in the same pull request.

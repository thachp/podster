# Release policies

Status: **written 2026-11-26 to close the M6 security review's F-8.** Expanded criterion 8 in [PRODUCT.md](PRODUCT.md#expanded-workroom-acceptance-criteria) says custom-domain, export/transfer and release-approval behavior must "pass their documented policies before launch". Until now no such policy existed.

These three policies **describe M6 as built and tested on `main` at `505ab312`.** They add no behavior. Each rule cites:

- the code that enforces it, as `file:line`;
- the decision or ADR that set it: [ADR 0010](../adr/0010-release-and-the-content-domain.md), [its proposed revision](../adr/0010-revision-apps-are-workers.md) and the [decisions in PRODUCT.md](PRODUCT.md#decisions-needed);
- the staging run that showed it, as the [M6 plan](../m6-plan.md#the-gate) records it.

How to read the labels:

- **Accepted** means the owner decided it, or the owner's gate call covered it.
- **Decided, for the owner to review** means the architect decided it under the owner's delegation, as PRODUCT.md records it.
- **Proposed** means the wording goes beyond a decision. Usually it's guidance to customers, or a figure the code itself marks Proposed.
- **Not built** means nothing in the code does it.

Everything here applies to staging only. `RELEASES` and a provider in production are still the owner's to switch on. **The terms and acceptable-use drafts in `docs/legal/` don't cover hosted apps, custom domains or app data yet.** F-8 also asks for that addition. It isn't made here. It is owed before production (before any real person's app is served), not for the staging gate, and it needs the owner's approval.

## 1. Custom domains

### Who may ask for a name

- **Only the room's owner or one of its admins, as a person, while that authority holds. An agent never can,** whatever role is stored for it.
  - Code: `crates/policy/src/release.rs:295-307` (`authorize_custom_hostname`), through `authorize_release_config` (`:259-283`) and `holds_release_authority` (`:105-107`). The room's command calls it at `apps/api/src/workspace/hostname.rs:117-125` and `:324-335`.
  - Decided, for the owner to review: [decision 215](PRODUCT.md#decisions-needed) and ADR 0010's [custom domains](../adr/0010-release-and-the-content-domain.md#custom-domains).
- **Asking needs everything a release needs.** The checks, in `release_room_allows` (`crates/policy/src/release.rs:177-202`):
  - the deployment allows release;
  - the organization may release;
  - the room is public, not archived, not deleted and not suspended;
  - its repository is ready;
  - release is switched on in the room.
- **Removing a name, or dropping a pending request, is always allowed to those same people,** an archived room included, because it only takes down (`:295-307`, `HostnameChange::Remove`).
- **A room has at most one custom hostname,** pending or claimed: `hostname_limit` (`crates/core/src/hostnames.rs:46`, `:396-398`).
- **The proof job checks the room again before every DNS lookup and every ask** (`crates/policy/src/release.rs:369-390`, `hostname_proof_room`). If a fact fails, the request ends. If a fact can't be read, the job waits and decides nothing.
- Staging: X15-1 and X14-1 ([custom domains run](../m6-plan.md#the-owners-call-2026-11-26-custom-domains-for-staging)).

### Names that are refused

Each refusal comes from `crates/core/src/hostnames.rs`. Decided, for the owner to review: [decision 207](PRODUCT.md#decisions-needed). The Public Suffix List amendment is the architect's of 2026-11-25.

- **First the name is normalized** (`:92-133`):
  - lower case, with one trailing dot removed;
  - an international name is turned into its ASCII form by IDNA (UTS 46);
  - labels are 1 to 63 characters, and the whole name at most 253.
  - Default-ignorable code points are refused, so two spellings can't read as one name.
- **Refused, each with its code** (`:51-90`, `:363-400`):
  - a wildcard (`hostname_wildcard`);
  - an IP address (`hostname_ip_address`);
  - a single label (`hostname_single_label`);
  - anything else that isn't a hostname (`hostname_invalid`).
- **Reserved names (`hostname_reserved`):**
  - `podster.dev`, `podster.site`, the deployment's configured content domain, and every name under one (`:25-30`, `:380-386`).
  - **Accepted:** `opster.dev` is no longer reserved, by the owner's ruling of 2026-11-25 (`:26-29`). It's the test customer domain for staging.
- **A public suffix itself (`hostname_public_suffix`),** judged by the whole Public Suffix List, ICANN and private sections both (`:217-230`, `:390-392`).
  - So a shared apex such as `github.io` is refused, and a name under it isn't.
  - The list is a dated snapshot compiled into the API (`apps/api/src/workspace/hostname.rs:78`, `third_party/public-suffix-list/`). `scripts/deploy-staging` refuses a snapshot older than 90 days.
- **Missing or unreadable configuration fails closed** (`hostname_unavailable`): no content domain, no suffix rules, or a top-level label no rule covers (`:69-70`).
- **A name an operator suspended (`hostname_suspended`)** stays refused until an operator lifts the suspension (`:393-395`).
- Staging: X15-1 refused 12 names and 2 bodies with their codes, and left no request behind.

### The proof, and how claims are decided

Podster's own challenge is the proof. Cloudflare's validation also runs, but it isn't the proof. Decided, for the owner to review: decisions [201 and 207](PRODUCT.md#decisions-needed), and ADR 0010's [custom domains](../adr/0010-release-and-the-content-domain.md#custom-domains), steps 0 to 6.

1. **The challenge.** The room's command commits the request with a value made for that request alone: 32 random bytes as lower-case hex, naming nothing readable (`hostnames.rs:419-421`). The owner publishes it as a TXT record at `_podster-challenge.<hostname>` (`:32`, `:407-409`).
2. **Pending holds nothing.**
   - Any number of rooms may be pending for one name.
   - A pending request expires 72 hours after it was asked for (`:38`, `:431-448`).
3. **Looking for the proof.** The job looks at once, then every minute for the first hour, then every 15 minutes until expiry (`:450-468`; the intervals are marked **Proposed** in the code).
   - It reads TXT through one DNS-over-HTTPS resolver, `cloudflare-dns.com` (`apps/api/src/hostname_proof.rs:41-47`). That one resolver is the review's nit F-7.
   - Any one value in the record equal to the request's value is a match (`hostnames.rs:426-428`). So two rooms proving at once don't overwrite each other.
   - **Check now** (the owner's request of 2026-11-27): whoever may ask for the name, where asking may happen, can make the job look at once (`checkAppHostname`, `POST …/app-hostname/check`; `podster_policy::release::HostnameChange::Check`). Here it applies to a `pending` request; it also reads Cloudflare for a claimed one waiting for it (see [Where the customer points the name](#where-the-customer-points-the-name)). Otherwise it is `hostname_not_pending` (409). It is the job's own look, by the same match rule, so a proven request comes back `claimed` or `refused` in the answer. People only: no agent capability reaches it.
     - **At most once every 30 seconds a request**, counted from its last look, the job's or a check's (`hostname_requests.rs`, `check_now`, `CHECK_NOW_INTERVAL_MS`, **Proposed**). Sooner is `hostname_check_too_soon` (429) with `Retry-After`.
     - The room's answer shows when it last looked (`checked_at`) and when the job next will (`next_check_at`). Workroom Settings shows both, a **Check now** button, and what the check found.
4. **One hostname, one room.** Once the proof matches, the room asks the hostname's own Durable Object for the claim (`apps/api/src/hostname_claim.rs`). The object decides by `decide_ask` and `decide_claim` (`hostnames.rs:652-726`):
   - **Suspended** comes first: `hostname_suspended`.
   - **A live claim held by another room or request:** `hostname_claimed`. Asking again for the same room and request gets `granted` again.
   - **A claim that is ending** is never granted again, not even to its own room: `hostname_claim_ending`.
   - **An expired request:** `hostname_request_expired`.
   - **A challenge made before the last claim was freed,** or under an older generation: `hostname_challenge_stale`. A later claim always needs a new challenge.
   - **No matching proof:** `hostname_unproven`.
   - **A request the room withdrew:** `hostname_request_withdrawn`, whichever reached the object first.
   - **Otherwise:** `granted`, to the first room whose proof passed.
5. **Races.** Rooms race only at the claim object, which takes one ask at a time. The first proven ask wins and every other gets `hostname_claimed`. No D1 row decides a claim.
   - Staging, X15-2: rooms B and C raced for one name. One was claimed, and the other was refused `hostname_claimed` 148 s after both challenges were published.
   - Staging, X26-1: another room's value didn't claim the name during the hold. The room's own value claimed it 31.3 s after it was published.

### Where the customer points the name

- **A `CNAME` to `fallback.<content domain>`,** which is `fallback.podster.site` on staging. The deployment's own content domain fixes it. Nothing a caller sends changes it (`hostnames.rs:36`, `:413-415`).
- **Only after the claim is the custom hostname created at Cloudflare,** and only for a claim the room committed (`apps/api/src/workspace/custom_hostname.rs:437`).
- **Routing starts only when the room holds the claim and Cloudflare reads the hostname `active`** (`hostnames.rs:926-928`, `routing_may_start`).
- **Check now on "Waiting for DNS"** (extended on 2026-11-27): while the room holds the claim and Cloudflare hasn't read the hostname `active` (`setup_status` `provider_pending`), the same `checkAppHostname` runs the committed claim's own step at once (`claimed_upkeep` in `apps/api/src/workspace/custom_hostname.rs`). It reads the custom hostname at Cloudflare through the same client (`apps/api/src/custom_hostnames.rs`) and records the read as the job does.
  - The answer is `active`; still `provider_pending`, with Cloudflare's status in `provider_status`, one of a fixed set or `unknown`; or `ending` with `end_reason` when the read ends the claim (`hostname_moved`, or `hostname_gone_at_provider` after two reads of gone). Only Cloudflare's status code is shown, never its message text or IDs.
  - The same people and the same 30 seconds as the proof step, counted from the request's `checked_at`, which the job's reads already write. `hostname_not_pending` (409) now means waiting for neither the proof nor Cloudflare. No Durable Object schema step.
  - A create not yet made is made, and a daily recheck that is due runs instead of the read, as on the job's own turn. With no provider for custom hostnames configured, nothing is read and only the try is recorded.
  - Workroom Settings shows "Last checked", "Next check" and **Check now** on "Waiting for DNS" too, and says what Cloudflare reported.
- **A custom host serves only while both of these hold** (`hostnames.rs:735-745`):
  - the room's desired state names a script for it;
  - the claim object says that room holds a live claim that isn't suspended or ending.
- **The content Worker also checks the entry** (`apps/content/src/names.ts:45-50`). It serves the entry only when the entry names that exact host.
- **Mapping a subdomain makes the app same-site with its parent domain.** ADR 0010 calls this a consequence, and it is said at mapping. **Proposed** as customer guidance: use a domain that is used for nothing else.

### Certificates

- **Cloudflare issues the custom hostname's certificate by HTTP validation.** The validation paths never reach an app. There are three locks (N1 in the review):
  1. **The zone's routes run no Worker** on `*/.well-known/acme-challenge/*` and `*/.well-known/pki-validation/*`. `scripts/deploy-content` creates them before either Worker deploys, and checks them after (`scripts/deploy-content:119-122`, `:579-580`).
  2. **The content Worker answers its own not-found on those paths,** on every host and method, before anything else (`apps/content/src/handle.ts:65-71`, `:449`).
  3. **A release can't hold files there** (`crates/core/src/release_tree.rs:36-40`).
- **Accepted:** the owner accepted the custom-domains gate for staging on 2026-11-26, with this item owed before production. The [`war3.org` run](../m6-plan.md#war3-run-2026-11-26) closed it the same day: X14-4 passed in run 45852797247.
  - The name served its own certificate, issued by Cloudflare's CA and trusted by Node.
  - `war3.org`'s DNS is off Cloudflare, so the certificate could only have come from HTTP validation with all three locks in place.
- **What a customer sees: Proposed.**
  - A name whose own DNS is on Cloudflare is served with that zone's certificate, whatever the `CNAME`'s proxy setting. That is Cloudflare's behavior, seen in the `opster.dev` runs.
  - Issuing a certificate is assumed to publish the name in certificate-transparency logs.

### The hold, expiry and the daily recheck

Decided, for the owner to review: [decision 207](PRODUCT.md#decisions-needed), and ADR 0010's step 7 with its 2026-11-18 amendment.

- **A pending request expires after 72 hours** (`hostnames.rs:38`, `:431-448`). After that it's gone, and asking again makes a new challenge.
- **A live claim's challenge is rechecked every 24 hours** (`:40`, `:883-885`; the job is `apps/api/src/workspace/hostname_recheck.rs`). The rules are in `recheck_claim`, `:890-915`:
  - **A match** resets both clocks.
  - **A definite no** is `NXDOMAIN`, or `NOERROR` with no record holding the value. Two definite noes at least 24 hours apart, with no match between, end the claim as `hostname_challenge_removed` (`:42`). So a removed record can keep its name routed for up to about two days.
  - **A resolver error never ends a claim by itself,** because Podster's own trouble mustn't take a customer's domain down.
  - **Seven days with no successful proof end the claim,** whatever the resolver said, as `hostname_proof_lapsed` (`:44`). So a name whose DNS stops answering can stay routed for up to 7 days.
- **When Cloudflare reads the hostname `moved`,** the claim ends at once as `hostname_moved` (`:919-921`). Podster doesn't wait for Cloudflare's own deletion.
- **Not shown on a deployment:** X26-2 (the 72-hour expiry) and X26-3 (the daily recheck). Staging has no test clock. `crates/core`'s tests check them, and so do the API's `hostname-recheck.spec.ts` and `custom-hostname.spec.ts`.

### Removal and ending

- **What ends a claim** (`ClaimEnd`, `hostnames.rs:849-878`):
  - the room removes the mapping;
  - the room's app is unpublished;
  - the recheck fails, either way above;
  - Cloudflare reads the hostname `moved`, or gone when Podster didn't delete it;
  - an operator suspends the name.
- **A claim never transfers.** Every end runs the same steps:
  1. The room clears and closes that host first, so its entry is removed (`crates/core/src/release.rs:1056`, `clear_host`). From then the claim serves nothing.
  2. The custom hostname is deleted at Cloudflare, and read until Cloudflare reports it gone.
  3. Only then is the claim freed (`hostnames.rs:728-730`, `may_free_claim`; `:785-804`; `apps/api/src/workspace/custom_hostname.rs:525`).
  - Freeing advances the name's generation. Any later claim, by anyone, the same room included, needs a new challenge. A DNS record left pointing at Podster proves nothing.
- **A suspension outlives every claim** (`hostnames.rs:973-1001`). Lifting it restores nothing, and only a request made after the lift counts.
- **Staging:**
  - X14-5: after removal the request went `ending`, and the name stopped serving within 46.4 s, and within 36.9 s in the `war3.org` run.
  - **Not shown on a deployment:** X14-6, reaching `ended`. It takes at least 20 minutes after the delete, so the API's tests check it.

### What a customer should expect

**Proposed**, as guidance built from the staging runs' timings:

- **Setup takes minutes when the TXT record is published before asking.**
  - The claim comes within about a minute of the record being visible.
  - Cloudflare reads the hostname `active` about two minutes after the claim: 119.1 s and 120.1 s in the X14-2 runs.
  - The app answers on the name within seconds after that: 10.4 s in the `war3.org` run.
- **Publishing the TXT after asking can add up to about 30 minutes.** The proof job may have looked already, and its resolver can cache "no such record" for the zone's negative-caching time. That was 300 s for the staging zones, and some DNS hosts set it longer. After the first hour, the job also looks only every 15 minutes.
  - **Check now** doesn't get past that cache. When it doesn't find the record, Workroom Settings says: "DNS can take up to about 30 minutes to show a new record if it was added after you asked." (**Proposed** wording, 2026-11-27.)
  - The first custom-domains run's X15-2 timed out exactly this way, and PR #607 fixed the run.
- **Keep the TXT record in place.** The daily recheck needs it, as above.
- **Expect the hostname in certificate-transparency logs.** Mapping a subdomain makes the app same-site with its parent domain.

## 2. Release approvals

### Who may switch release on

- **The room's owner or one of its admins, as a person, while that authority holds. An agent never can** (`crates/policy/src/release.rs:259-283`, `authorize_release_config`; `:105-107`).
  - Decided, for the owner to review: [decision 215](PRODUCT.md#decisions-needed); ADR 0010's [authority, approval and triggers](../adr/0010-release-and-the-content-domain.md#authority-approval-and-triggers).
- **Switching on needs everything in `release_room_allows`** (`:177-202`):
  - the deployment allows release;
  - an operator hasn't taken release from the organization ([decision 218](PRODUCT.md#decisions-needed));
  - the room is public, not archived, not suspended, and its app isn't suspended;
  - its managed repository is ready.
- **Switching off is always allowed to those people,** and it unpublishes.
- **Off is the default,** and off publishes nothing.
- Staging: M6-R01 (release off publishes nothing), M6-R02 (an operator's take-back refuses the switch), M6-R03 (a member can't read or set the configuration) and M6-R16 (switching off unpublishes and keeps the records).

### Only merged commits are released

- **A release names exactly the commit Podster's own merge put on the room's repository's default branch.** Podster must have confirmed it there, and the task must be completed. The only environment is `production` (`crates/core/src/release.rs:32`, `:156-178`, `releasable_commit`).
  - Checked at the request (`crates/core/src/release_request.rs:93-106`), at the approval, and on every pass of the job (`apps/api/src/workspace/release_recheck.rs`).
  - Decided, for the owner to review: [decision 214](PRODUCT.md#decisions-needed), with the environment standing under [decision 219](PRODUCT.md#decisions-needed).
- **Nothing starts a release but a request and a person's approval.** A merge, a webhook or an observation of GitHub never does.
- **A room may ask at most 20 times in a rolling day,** declined and failed requests included (`crates/core/src/release.rs:14`, `:1684-1691`).
- Staging:
  - M6-R05: another room's task, another commit, another environment, and a named repository, host or label were all refused, with no release recorded.
  - M6-R06: the marker names the merged commit.
- **Recorded, not decided:** a reverted commit stays releasable ([M6 step 6 plan](../m6-step6-plan.md)).

### Who asks, and who approves each release

- **Who asks:** someone who may release now (`may_release_now`, `crates/policy/src/release.rs:505-533`; `authorize_release_request`, `:575-590`). That means:
  - a current participant, not in the room through a public claim, and not a person from another organization;
  - holding a live `deploy` grant on exactly the room's repository;
  - whose grant's giver still holds release authority (`:449-470`).
  - Only the room's owner or an admin, as a person, gives a grant, and only in a public room (`:611-624`).
- **An agent may ask with its own grant,** through `deploy_release`. Its controlling person must still be in the organization, and the controlling link must be the one recorded at the request (`:561-566`, `controller_unchanged`).
- **Approving a task, a merge grant, or claiming a role gives no deploy right** (AC-17).
  - Staging, M6-R04: an agent that claimed a DevOps opening was refused `grant_required`.
- **The approval policy has one value, `person`.** A person who may approve approves each release (`crates/core/src/release.rs:38-56`; `on_merge` was dropped).
  - Who may approve: the room's owner or an admin, as a person, while authority holds, where release may happen now (`crates/policy/src/release.rs:396-402`, `authorize_approval`). The grant isn't needed, and an agent never approves.
  - Called at `apps/api/src/workspace/release_approval.rs:114` and `:132`.
- **Self-approval is allowed.**
  - A person who may approve may approve their own request: decided by the architect on the review of PR #309.
  - **Accepted:** they may also approve a release that their own agent asked for. The owner decided this on 2026-11-16 ("Yes, allow it"), as recorded in the [M6 step 6 plan](../m6-step6-plan.md) and in the code's header (`crates/policy/src/release.rs:11`, `:392-395`).
  - This is a one-person release. The merge's own independent review under [decision 195](PRODUCT.md#decisions-needed) is unchanged, except a self-reviewed merge under [decision 186](PRODUCT.md#decisions-needed): in a private room, and since 2026-11-27 in a public room by its owner alone with the public-repository acknowledgement (`public_repository_acknowledged`). That merge approves no release: the release still needs its own request and a person's approval, as above.
  - Shown by `apps/api/test/release-agent.spec.ts` ("may be approved by the person who controls the agent"). **Not shown on staging:** M6-R10's agent request was declined, not approved.
- **Declining** is open to the same people wherever the room still exists (`:408-427`).
- **A rollback is asked for by a person only** (`:627-635`), and approved like any release.
- **Every pass of the job checks again** (`apps/api/src/workspace/release_recheck.rs`):
  - the grant and its giver;
  - the requester's and the approver's standing;
  - the agent's controlling link;
  - the room's epoch and configuration version.
  - A fact that couldn't be read is never a pass.
  - Staging, M6-R13: a grant taken back between request and approval failed the release `requester_lost_authority`.

### Only public rooms release

- **A private room's request is refused `release_needs_public_room`,** and nothing is queued (`crates/policy/src/release.rs:639-645`; `release_room_allows`, `:177-202`).
  - Decided, for the owner to review: [decision 213](PRODUCT.md#decisions-needed); ADR 0010's [only a public room releases](../adr/0010-release-and-the-content-domain.md#only-a-public-room-releases).
- **A room made private is unpublished.** A deploy grant is given only in a public room.
- **Managed repositories are public:** a request for a private one is refused `private_unavailable` (`apps/api/src/workspace/provisioning.rs:273-276`). That rests on [decision 181](PRODUCT.md#decisions-needed), which the owner confirmed on 2026-11-11.
- Staging: M6-R01 and M6-R17 (made private again, the host answers not-found).

### Unpublishing, the label and the app's data

- **What unpublishes the app** ([decision 204](PRODUCT.md#decisions-needed), decided for the owner to review; ADR 0010's [unpublishing](../adr/0010-release-and-the-content-domain.md#unpublishing)):
  - release switched off, in the room or for the deployment;
  - the room archived, deleted or made private;
  - its public surface suspended;
  - release taken from its organization;
  - its repository stopped or lost;
  - nobody left who may release, once the hold window ends.
- **What an unpublish does,** in one transaction:
  - it raises the room's release epoch;
  - it sets every host to serve nothing;
  - it forgets the kept script, so there is nothing to roll back to;
  - it queues every script for deletion (`crates/core/src/release.rs:1020-1050`; `apps/api/src/workspace/takedown.rs:226`, `:327`).
- **An unpublish for good also retires the app's label** (`takedown.rs:441-471`, `retire_current_label`). In the same transaction it records the store's deletion as owed, with the cause `label_retired` (`crates/core/src/app_store.rs:586-611`).
  - The next request draws a new label and host, so an old link never meets a later release.
  - A retired label is never drawn again.
  - Shown by `apps/api/test/unpublish-retires-label.spec.ts`.
- **What doesn't retire the label:**
  - **An operator's suspension** keeps the label and its store, so a mistaken suspension can be lifted with the data intact (the architect's ruling of 2026-11-16). The operator deletes data with its own command.
  - **A reversible hold.**
  - **The stop for the whole content domain.**
- **Deleting the store** (`apps/api/src/workspace/store_delete.rs`):
  - It waits until nothing can reach the store.
  - It counts the store gone only on D1's own not-found, read twice at least ten minutes apart.
  - The room's owner or an admin, as a person, may also delete the app's data (`crates/policy/src/release.rs:316-330`). That was **accepted** in [decision 220](PRODUCT.md#decisions-needed) (7).
  - Once true, the answer says exactly the owner's words of 2026-11-17 (`crates/core/src/app_store.rs:581`).
- **Not shown on a deployment:** that the store was deleted after an unpublish (CX1). A test person sees no signal of it, so the 2026-11-25 run couldn't show it. It's the review's F-5, owed before production.

## 3. Export and transfer

**What exists today. Most of it is not built.**

- **What a room can take with it: its managed repository.**
  - Every managed repository is public (`apps/api/src/workspace/provisioning.rs:273-276`; [decision 181](PRODUCT.md#decisions-needed), confirmed by the owner on 2026-11-11 as "okay with public repo, MIT project").
  - Anyone can clone or fork it.
  - Each release names its repository and exact commit (`openapi.yaml`'s `TaskRelease.commit_sha`). So what was released can always be fetched from the repository.
  - **The owner's "MIT project" means Podster's own code.** It doesn't license what rooms put in their repositories ([ADR 0009](../adr/0009-managed-repositories.md), lines 23-28 and 319). Which license a managed repository carries, and who owns its contents, are **not decided**. They wait on the managed organization's legal terms.
- **Release records:** the room's owner and admins can read the release configuration and every release (`ReleaseView::Full`, `crates/policy/src/release.rs:649-660`). That's a read, not an export.
- **Not built:**
  - **Moving a managed repository to the room owner's own GitHub account.** ADR 0009 leaves repository transfer and deletion to the owner's yes ("Deletion, export and transfer"). The M6 plan's question 18 proposed not building it in M6. No route exists.
  - **Moving an app, its label, its hosts or its custom hostname to another room or account.** A custom hostname claim never transfers, by design (section 1).
  - **Exporting an app's data from its store.** No route exists. The only data action is deletion (section 2).
  - **Exporting uploaded files.** It's deferred until before production by [decision 167](PRODUCT.md#decisions-needed), which replaced decision 59.
  - **Deleting a repository.** Nothing in Podster deletes one. A removed or archived room leaves its repository in place.
- **Staging:** M6-24 ("Export and transfer behave as their written policy says") wasn't run on staging ([staging.md](../staging.md#m6s-release-on-staging-run) lists it as not covered). As built, no transfer or export route exists in `packages/contracts/openapi.yaml`. The only transfer there is the room's ownership (`transferOwner`), which is M0's and unrelated.
- **Proposed:** until the owner rules on transfer, Podster offers what's above and nothing more, and says so plainly to anyone who asks.

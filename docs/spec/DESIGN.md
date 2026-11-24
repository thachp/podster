# Podster — Product Design Spec

Status: **proposed for review**, except the visual direction and interaction patterns the owner chose on 2026-11-22 and 2026-11-23, which are marked as owner-approved where they appear ([section 5](#5-interaction-patterns), [section 10](#10-visual-foundation)). Behavior the demo shows but no spec settles is marked **Proposed**. · Owner: Patrick Thach · Last updated: 2026-11-24

Companions: [Product](PRODUCT.md) · [Architecture](ARCHITECTURE.md) · [Access control](ACCESS-CONTROL.md) · [Demo](../../apps/demo/README.md) · [Concept mockups](../mockups/README.md) · [Task planning handoff](TASK-PLANNING.md) · [Contributors and limits](CONTRIBUTORS-AND-LIMITS.md)

Nothing here is built. This document turns the concept mockups into one consistent interface specification: navigation, vocabulary, states, screens, patterns and tokens. When sources disagree on authority, permissions, visibility, data or security, ACCESS-CONTROL.md, PRODUCT.md and ARCHITECTURE.md win. On layout, visuals, interaction flow, navigation and on-screen wording, the demo wins over this document, as the note below says, and this document wins over the images. The images are historical concepts; [section 11](#11-mockup-reconciliation) lists where each one must change.

> **2026-11-24:** Screens and visuals now follow [`apps/demo`](../../apps/demo/README.md) (demo.podster.dev), the UI/UX source of truth. Where this document and the demo differ on layout, visuals, interaction flow, navigation or on-screen wording, the demo wins and this document is to be brought in line. Authority, permissions, visibility, data and security still follow ACCESS-CONTROL.md, PRODUCT.md and ARCHITECTURE.md.

## 1. Design principles

1. **Show who is accountable.** Every task, approval and release names the person or agent responsible and what they committed to.
2. **State the truth, not the hopeful version.** Submitted is not completed, merged is not live, and connected is not available. Use the labels in [section 4](#4-status-vocabulary) everywhere.
3. **Authority is visible, never implied.** Show who can do something and why a control is unavailable. A lead, reviewer or DevOps label never looks like an administrator grant. The interface explains authority; only the Rust API enforces it.
4. **Agent content is data.** Text from agents is visibly attributed, and content from another organization is marked. It is never styled as Podster's own guidance ([section 8](#8-agent-authored-content)).
5. **Calm by default.** People visit to decide, not to watch. Lead with what needs a decision, keep history one step away, and avoid real-time theater.

## 2. Information architecture

### Application shell

**Approved reference (2026-11-24).** The shell and screens follow the [demo](../../apps/demo/README.md) at demo.podster.dev (`apps/demo/index.html`). On 2026-11-23 the owner judged its clickable prototype "closer" than every canvas mockup and asked to extend it. On 2026-11-24 the owner made it the UI/UX source of truth (note above). The demo's shell:

| Part | Design | Decided |
| --- | --- | --- |
| Sidebar, creator | Podster mark; a **workroom card** naming the current workroom, which links to **Your workrooms**; then **Today, Brief, Board, Ship, History, Team, Rules** | Owner, 2026-11-23: keep the card as a link. A dropdown was tried and reverted |
| Sidebar, contributor | Podster mark; **Today, Your agents, Spend, Track record, Explore**. No workroom card | Demo, 2026-11-24. Spend and Track record are **Proposed** and deferred: Runner keeps budgets local, and track record is a gated future concept in [Contributors and limits](CONTRIBUTORS-AND-LIMITS.md) |
| Counts | A count beside a nav item only when something there needs the viewer | Demo, 2026-11-24 |
| Collapse | The sidebar collapses to icons | Owner, 2026-11-23 |
| Account menu | Bottom left, slides out shadcn-style: Account, Organization, Notifications, Connect your chat, Keyboard shortcuts, Sign out. The demo's "see it as" persona switch is demo-only | Owner, 2026-11-23 |
| Main area | Full width, one working column per page ([section 10](#10-visual-foundation)) | Owner, 2026-11-23 |
| Footer | A small GitHub-style footer | Owner, 2026-11-23 |
| Phone | Not a design goal. The owner doesn't care about a phone view (2026-11-23); the 375 px rules in [section 9](#9-accessibility-and-responsive-behavior) still hold | Owner, 2026-11-23 |

The workroom card is a link, not a selector, so it doesn't bring back the in-place target switch that AC-21 guards against.

The rest of this subsection is the 2026-11-04 shell. Where it differs from the demo, the demo wins.

Use a shadcn/ui **Sidebar** on every signed-in screen. It holds the Podster mark and these primary items:

| Item | Purpose |
| --- | --- |
| **Needs attention** | The signed-in person's decisions across workrooms, with an unread count |
| **Workrooms** | My workrooms and Explore |
| **Agents** | Agents the person's organizations own |
| **Settings** | Profile, organization and notification preferences |

The **profile button is anchored at the bottom left**. Its menu contains the current organization and organization switcher, Account, Notifications and Log out. Show Billing only when billing exists; preview users have nothing to manage. The workroom is never a Sidebar selector: the workroom page and its tabs carry that context.

### Routes

Route names are proposed; final routing depends on the host decision in [ARCHITECTURE.md](ARCHITECTURE.md#public-surfaces).

*2026-11-24:* the demo calls the person's decision screen **Today**; this table, PRODUCT.md ("shown as **Needs attention**") and the staging route still say Needs attention and `/attention`. Whether to rename the label and route is [open question 7](#13-open-design-questions).

| Route | Screen |
| --- | --- |
| `/attention` | Needs attention |
| `/workrooms`, `/workrooms/explore` | Directory |
| `/workrooms/new` | Create a workroom |
| `/w/:id/overview` | Goal and context, with input assets and expected outputs from M2 |
| `/w/:id/tasks` | Task list; `?task=:taskId` opens the task Sheet |
| `/w/:id/team` | Role openings and participants; `?agent=:agentId` opens the access Sheet |
| `/w/:id/collaboration` | Collaboration map and its list equivalent |
| `/w/:id/activity` | Permission-filtered room history |
| `/w/:id/artifacts` | Versioned outputs |
| `/w/:id/settings` | Visibility, repository, release and ownership settings; owner and admins only |
| `/agents` | Connected identities; `?agent=:agentId` opens the agent Sheet |
| `/agents/connect` | **Add an agent** Sheet over the Agents list: Runner pairing first, connecting an agent you already run second |
| `/settings/{profile,organization,notifications}` | Account-level settings |
| `/invitations/:token`, `/claim?agent_id=…&code=…`, `/oauth/consent` | Focused, shell-free person approval pages |
| `/pairing/new`, `/pairing/:agent` | Focused pages to start a Runner pairing, which shows its code once, and to confirm one by the key fingerprint Runner sent, which never shows the code (M7 step 5(c)) |

A private room the viewer cannot access renders the same **not-found** page as a room that does not exist.

## 3. Vocabulary

| Use | Do not use | Why |
| --- | --- | --- |
| Workroom | Workspace | `workspace` is internal only. |
| Role opening; "2 of 3 filled" | Agent slot, seat | A role is a responsibility, not a launched agent. |
| **Claim a role** | Claim a task | Only role openings are claimed. Tasks are offered and accepted. |
| **Confirm ownership** | Claim an agent | Avoids a second meaning of "claim" in Agent Auth onboarding. |
| Accept / Decline | Start, Take | Acceptance is a commitment and the kernel has no "start". |
| Submitted; Awaiting review | Completed by agent, Marked complete | Only review completes work. |
| Approve (the verify action) | Complete, Sign off | One reviewer action, one label. |
| Input asset | Spec, Attachment | Inputs follow the [upload policy](UPLOAD-POLICY.md); the upload control reads **Asset upload**. |
| Artifact | Deliverable, Result file | Versioned output; can include files and a preview URL. |
| Skills (self-described) | Capabilities | "Capabilities" is the API surface, and self-description is not a grant. |
| Workroom access | Permissions (alone) | Always names the boundary. |
| Connected services | Integrations (for grants) | Marks authority held outside Podster. |
| Last active 5 min ago | Online, Idle | Podster cannot know an agent's availability. |

## 4. Status vocabulary

Each status uses a text label plus an icon. Color is never the only signal. Tones map to the tokens in [section 10](#10-visual-foundation).

### Task

| Kernel state | Label | Tone | Who needs to act |
| --- | --- | --- | --- |
| `open` | Open | Neutral | Requester or admin assigns |
| `offered` | Awaiting acceptance | Amber | Offered agent, not the person viewing |
| `accepted` | Accepted | Blue | Assignee |
| `submitted` | Awaiting review | Violet | Named reviewer |
| `completed` | Completed | Green | Nobody |
| `canceled` | Canceled | Neutral | Nobody |

Task activity uses matching verbs: *offered, accepted, declined, released, submitted, requested changes, approved, canceled*.

### Release stages

Checks, merge and deployment always show separately and never collapse into one success state.

| Stage | Labels |
| --- | --- |
| Checks | Not started · Running · Passed · Failed |
| Merge | Not requested · Waiting for review · Merging · Merged · Merge failed · Commit changed |
| Deployment | Off · Waiting for merge · Waiting for approval · Deploying · Live · Deployment failed. **Proposed (2026-11-16, M6 step 10(b), for the owner to review):** also Unavailable · Declined · Replaced · Unpublished · Not live · Not shown to you · Couldn't check |

**Proposed (2026-11-16):** *Unavailable*, release isn't available on this Podster deployment, so nothing is published. *Declined*, a person declined the release, so nothing was uploaded. *Replaced*, a later release is served in its place. *Unpublished*, the app was taken down. *Not live*, the release was once confirmed served but isn't served now. *Not shown to you*, the viewer's access shows the merge and not the release. *Couldn't check*, the release couldn't be read or its answer didn't match the task's merged commit, which is never shown as Off or Live. Only *Live* says an app is served, and only while Podster says this commit is served.

Show a compound result when needed, such as **Approved · Merge failed** or **Merged · Deployment failed**. Show the commit and time observed with every external state. If provider data is stale, say **Last updated 12 min ago**.

### Other objects

| Object | Labels |
| --- | --- |
| Agent connection | Awaiting ownership confirmation · Connected · Disconnecting · Disconnected |
| Workroom participation | Invited · Active · Withdrawn by agent owner · Access revoked |
| Wake | Off · On · Off after repeated failures |
| Input asset / file | Uploading · Scanning · Ready · Blocked · Scan failed. Ready may add "No known malware found"; never say a file is safe |
| Connected service | Not connected · Connected · Unavailable to you · Connection failed |
| Expected output | Not started · In review · Ready (an approved artifact version is linked) |

## 5. Interaction patterns

### Patterns from the approved demo

These come from the [demo](../../apps/demo/README.md). "Owner" means the owner chose it on that date; "Demo" means it is in the demo the owner made the UI source of truth on 2026-11-24 (#575, #576, #577).

| Pattern | Rule | Decided |
| --- | --- | --- |
| Detail and review open as a wide right-side Sheet | Task detail and reviewing Planner's plan open as a wide Sheet on the right. Both a full page and a centered dialog were rejected for plan review. Task detail has content on the left, a properties column on the right and one combined activity stream. A full task page with the same layout stays available | Owner, 2026-11-23 |
| Sheet widths | Task about 1,080 px, plan about 860 px, permission request about 620 px, others about 520 px; all leave a margin and take full width on narrow screens. These replace the `md` and `lg` widths below | Demo, 2026-11-24 |
| Centered modals | Short, self-contained forms and lists (New task, Keyboard shortcuts, What can go wrong) are centered. A tall modal scrolls inside itself and never runs off the window | Demo, 2026-11-24 (#577) |
| ⌘K palette | Opens near the top, like other command menus. It jumps to anything or runs a typed command. Commands that approve, release or allow only link to the real confirm screen; they never act on their own | Owner, 2026-11-23 |
| No Podster-run chatbot | Instead of a chat assistant, ⌘K commands plus **Connect your chat**, which connects the person's own chat (Claude, ChatGPT, Grok) over MCP | Owner, 2026-11-23 |
| Inline editing | Click text, such as a brief or a task's instructions, to edit it in place. GitHub-flavored Markdown works. ⌘↵ saves and Esc cancels. The rendered result follows [section 8](#8-agent-authored-content)'s allowlist | Demo, 2026-11-24 |
| Agent content is inert | Agent Markdown renders as text formatting only. Its links show the address and aren't clickable. Task-list boxes are disabled | Demo, 2026-11-24; stricter than section 8, which shows the host |
| Review panel over the preview | On review, the checklist and actions float over the right side of the live preview. **Hide** (or `]`) hides the panel to show the whole app; a chip shows progress, such as "2 of 4 checked · Show review", and brings it back | Demo, 2026-11-24 |
| One send button | **Post** sends a message. **Assign to…** hands over work. Never two "send" buttons with different meanings | Owner, 2026-11-23 |
| Keyboard | `?` lists shortcuts. `J` goes to the next thing that needs you | Demo, 2026-11-24 |
| Lists | The last row of a list or table has no divider below it | Demo, 2026-11-24 |
| Settings rows | Label left, with a short description under it; the control or value right. One column below 900 px | Demo, 2026-11-24 |

The rest of section 5 is from 2026-11-04 and still holds where the table above doesn't replace it.

### Right-side Sheet

The **Sheet** (`side="right"`) is the default for task, agent, connection and access details.

- **Fixed target.** The title names the object and the description names its workroom. A Sheet never contains a selector that changes its target; to change target, close it and open another. This removes the failure in AC-21.
- **Deep-linkable.** The route query opens the same Sheet on reload. Unauthorized or missing targets close to a not-found message that reveals nothing.
- **One at a time.** No Sheet opens another Sheet. Dialogs may open above a Sheet only for confirmation.
- **Focus.** Focus moves to the title on open, stays trapped while open, and returns to the launching control on close. Escape and the close button behave like Cancel.
- **Unsaved edits.** Show *Unsaved changes*, and ask before discarding them. Cancel never saves.
- **Width.** `md` (about 480 px) for access and agent details; `lg` (about 720 px) for tasks. Full width below 640 px. *Superseded 2026-11-24 by the demo's wider Sheets, in the table above.*
- **Full page.** A task Sheet may offer **Open full page**, using the same component and data, for long reviews with release detail. It is an expansion of the Sheet, not a different design.

### Dialogs and confirmations

Use an AlertDialog only to confirm a consequence: revoke access, disconnect an agent, cancel a task, or merge when merging triggers deployment. The confirmation names the target and effect. "Revoke *Code Agent* from *Developer Platform*?" is acceptable; "Are you sure?" is not. Do not use Dialog for detail views, and do not use Drawer.

### Saving and conflicts

- Lifecycle and access changes are **never optimistic**. Show pending, then the server's result.
- Every edit carries the version it was read at. On `version_conflict`, keep the person's input, show what changed and offer **Review latest**. Never overwrite silently.
- Bind every pending request to its original target. A late response must not update a different selection.
- Provider actions report their real result. Show a queued state rather than success until the provider confirms it.

### Empty, loading and error states

| State | Rule |
| --- | --- |
| Empty | Say what belongs here and the next action available to this viewer. Never suggest an action they cannot take. |
| Loading | Use skeletons shaped like the content. Prefer no spinner under 300 ms. |
| Read failure | Keep prior data visible with **Couldn't refresh · Try again**; do not blank the screen. |
| Denied | Controls were already unavailable, so explain simply. For hidden resources use the generic not-found page. |
| Offline agent | Normal. "*Code Agent* will see this at its next session." Do not treat it as an error. |

### Key copy

| Moment | Copy |
| --- | --- |
| After offering a task | Offered to *Architect*. It will see this at its next session or wake. |
| Wake turned off | Wake turned off after 3 failed attempts. Work still reaches *Architect*'s inbox. **Review wake URL** |
| Version conflict | This task changed while you were editing. Your changes aren't saved. **Review latest** |
| Merge consequence | Merging will start the workroom's deployment to *production*. |
| Partial result | Approved, but the merge failed: the pull request has new commits. **Create follow-up task** |
| Access save footer | Saving workroom access doesn't grant GitHub, merge or deployment access. |
| Connect footer | Connecting doesn't create, run or wake an agent. Workroom access is set separately. |

## 6. Screens

*2026-11-24:* the [demo](../../apps/demo/README.md) is the approved reference for every screen's layout and wording; its README lists them. The subsections below describe the screens the demo added or renamed. Where a screen's behavior isn't in PRODUCT.md, the design is described and the behavior is marked **Proposed**. [docs/staging-demo-gap-map.md](../staging-demo-gap-map.md) maps each demo step to what staging runs.

### Sign in

A focused page without the Sidebar: **Continue with** buttons for each provider, then **Email me a link**. There's no password, and signing in and signing up are the same page. The demo shows Google, GitHub and X; staging offers GitHub and email only. If X shares no email address, the next page asks for one and confirms it with a link. **Proposed:** Google and X, and adding an email after X ([open question 9](#13-open-design-questions)).

### Role choice after sign-in

**Proposed (behavior):** shown once, after a new person's first sign-in. It asks "What do you want to do first?" with two cards, each with a small preview, three steps and what they'll need:

- **Get something built**: start a workroom. You don't need an agent of your own.
- **Bring your coding agent**: pair it with Runner, then claim open roles.

The continue button names the path ("Start a workroom" or "Pair my agent"). A quiet link offers "Just looking? Browse public workrooms". The choice only picks where the person starts. It grants nothing and doesn't limit what they can do later. PRODUCT.md has no first-run step, so this needs a ruling there (gap map C3, slice S2).

### Today

The demo's name for [Needs attention](#needs-attention); the owner uses "Today" (2026-11-23). Renaming the label and the `/attention` route is [open question 7](#13-open-design-questions). Layout:

- One decision card per item, newest first. The card says what kind of decision it is with an orange dot and plain words, then the title, one sentence of context and one primary action. Only cards that wait on the viewer are orange.
- A creator's cards: ready for review (with a thumbnail of the app), an agent's question with answer buttons, a plan proposal, a permission request, and approved-not-live.
- A contributor's cards: allowing a run, and a role invitation for their agent.
- Below the cards, quiet secondary content in sentences, not number tiles.

**Proposed (behavior):** an agent's question that pauses a task, Planner plan proposals, egress permission requests, a person allowing a run from the dashboard, and a person accepting a role invitation for their agent. None of these is in PRODUCT.md, and two contradict it ([open questions 11–13](#13-open-design-questions)).

### Your workrooms

Replaces the directory's **My workrooms** tab. Workrooms are grouped by the organization that owns them: **Personal** first (the person's personal organization, [decision 23](PRODUCT.md#decisions-needed)), then each team organization, labeled with the viewer's role there, such as "Team · you're an admin", with a **Settings** link for admins. Each row shows the workroom, one line of status and a count when something needs the viewer. An empty group says what goes there and offers **Start one**. The header has **Create an organization** and **Start a workroom**. Explore moved to the contributor's Sidebar.

### Create an organization

A short form for a team, a business or a client. A summary panel says the creator becomes its first admin and that it owns the workrooms and agents made in it, as PRODUCT.md's Organization entry says. **Proposed:** the web address, website and logo fields ([open question 10](#13-open-design-questions)).

### Organization settings

Label-left rows ([section 5](#patterns-from-the-approved-demo)), in sections: **Profile** (name, web address, website, logo), **People**, **Workrooms**, **Agents it runs**, **What happened** and **Delete organization**. Read mode shows values; **Edit** turns the profile into a form. Members who aren't admins see it read-only, with a note on what they can't change. **Proposed:** web address, website and logo, because the gateway stores only the name ([open question 10](#13-open-design-questions)).

### Rules

A workroom's rules in label-left rows: **Joining** (who can join, accept proven agents automatically), **What agents may do** (take tasks sent to them, push to their own branches but never to main, post in discussions, suggest new tasks), **Websites agents can reach**, and review and run limits such as the longest run accepted and whether approvers may approve their own agents' work. Members who can't change rules see them read-only. **Proposed (behavior):** each switch maps onto existing access presets, grants and rules only where ACCESS-CONTROL.md defines one; the rest need rulings. The websites list is Runner's egress allowlist, which RUNNER.md keeps on the agent owner's machine.

### App settings

Under Ship. Label-left rows: **Environment variables**, plain and secret, which the app reads by name, and **Domains**. Secrets never appear in code, the repository, logs or anything an agent receives. **Proposed (behavior):** M6 apps are static files ([decision 214](PRODUCT.md#decisions-needed)), so runtime variables need a ruling before this ships.

### Needs attention

*2026-11-24:* the demo shows this screen as [Today](#today). The text below is from 2026-11-04 and still describes what may appear there.

Items that need **this person** to decide, grouped by type and then newest first: reviews assigned to them, role invitations awaiting them, wake or connection problems on agents they own, release approvals and, once [Runner](RUNNER.md) ships and if the owner opted in, requests to run a task, which are the owner's decision to let their agent's machine run it. Row actions open the relevant Sheet. Agent-owned work, such as a task awaiting an agent's acceptance, is not an item here; the concept dashboard's "Awaiting acceptance" and "Completed" groups move to the Tasks tab. Items clear when the decision is made. Acknowledging affects only this person's queue.

### Workroom directory

Two tabs: **My workrooms** and **Explore**. Cards show the goal, up to three role capacity summaries and, from M2, "*n* of *m* outputs ready". The count always covers all roles, and role titles sit on their own labelled line, for example "6 of 10 roles filled", then "Roles: Researchers 3 of 5". **Proposed:** cards also show visibility once public rooms arrive in M4, which the owner hasn't ruled on. Explore searches public metadata only and filters by topic and available role.

**View workroom** opens the public read surface defined in PRODUCT.md. A signed-in person who owns eligible agents sees **Claim with an agent**, which selects an agent and confirms the role, its responsibilities and its access preset. Agents can claim directly without this screen.

### Create a workroom

A single page with three main sections and a settings column. It creates nothing until the final action. There are no drafts yet, so leaving the page loses what's typed. Drafts may come later.

1. **Goal and context:** name, goal, context and **Asset upload**. State "Files stay private unless you share them" only if the visibility rules make it true.
2. **Roles:** title, responsibilities, opening count, access preset and public-claim toggle. Mark exactly one role opening as **Lead coordinator**. Additional project managers are ordinary roles.
3. **Outputs and review:** expected outputs, from M2. There's no room-wide default reviewer in M1, because a task's reviewer is set on the task ([PRODUCT.md decision 48](PRODUCT.md#decisions-needed)).

The settings column has **Visibility**, **Workflow** (General or Engineering) and, for Engineering only, repository and deployment settings. Each shows one of *Not configured*, *Needs approval* or *Ready* and never assumes success. The final footer states "Agents connect later; this doesn't launch agents." Public visibility shows exactly what becomes public before creation.

### Workroom page

Tabs, in order: **Overview, Tasks, Team, Collaboration, Activity, Artifacts, Settings**. The header shows name, visibility, the viewer's relationship such as *Owner*, *Admin* or *Your agent: Architect*, and any primary action. Hide Settings from everyone except the owner and admins.

- **Overview:** goal, context and the current lead, plus input assets and expected outputs with status from M2.
- **Tasks:** synchronized List / Board / Gantt views, preserving authorized scope, filters and the existing task Sheet. The approved November 5 direction and proposed implementation details are in [Task planning](TASK-PLANNING.md). Use canonical status columns, scoped progress and qualified forecasts; estimates and dependencies need new contracts before implementation. Rows show title, state, assignee, reviewer and age only where data exists; filters likewise require actual data. Do not use row checkboxes until a bulk action exists. Long lists load more automatically near the bottom, with a visible **Load more** button that does the same thing ([decision 61](PRODUCT.md#decisions-needed)).
- **Team:** role openings first, including vacant ones, then participants with organization, access preset and external marker. **Manage access** appears here for the owner and admins.
- **Activity:** permission-filtered event history with actor, verb, object and time, filterable by task or participant. It has no read/unread behavior and never acknowledges an inbox.
- **Artifacts:** one row per output with current approved version, version history, reviewer, source task, submitted commit, and download where allowed, with no previews in M2 ([decision 52](PRODUCT.md#decisions-needed)). An external link says "External link, may change since approval". A newer unreviewed version never replaces the approved badge. **Proposed (2026-11-21):** in a room with a linked repository the tab has two views, **Deliverables** (all of the above, unchanged) and **Builds**, GitHub Actions runs and their artifacts, downloaded from GitHub, as [Build artifacts from GitHub CI](BUILDS.md#the-builds-view) describes. Builds never shows an approved badge.

### Task Sheet

Header: title, status, requester, assignee, reviewer, and task and submission numbers.

Tabs: **Details** (instructions, acceptance criteria, linked assets, and submission with its version), **Discussion** and **Activity**. Acceptance criteria display as a read-only list unless an accountable review model is specified; checkmarks must not imply someone has verified them.

**Plan** sits above the tabs and loads when asked, because its read covers the room: the estimate in working days or **Not estimated**, and the tasks this one comes after, with a canceled one marked unresolved. A requester or human admin who sees the whole room can edit it there, and a refusal says why without naming a task. Someone limited to their own tasks sees only those, with a note saying so.

The action footer shows only what the viewer may do now: **Approve** and **Request changes** for the reviewer, **Cancel task** for the requester and admins. Approve identifies the exact version: "Approve submission 2". Once approved, that submission's row shows an **Approved** label with a check icon, so color isn't the only signal. Someone who can't see that row sees no mark.

For Engineering tasks, add a **Release** panel with the pull request, branch and commit, the three stages from section 4, and **Approve and merge** only for a viewer holding both authorities. If merging deploys, show the consequence next to the action in the warning style and confirm it. If the commit changes after review, disable approval of the old commit and show **Commit changed**. Auto-deploy and preview links appear only when real for this commit.

Future task resource/usage presentation follows [Contributors and limits](CONTRIBUTORS-AND-LIMITS.md). Reuse this Task Sheet and its optional full-page expansion. Keep resource caps, paid financial caps and execution indicators separate from kernel status; reconcile the mockup's **End this task** to an authorized named lifecycle action with confirmation. Recording a pause is not proof an independent agent stopped. No paid controls ship until the documented gates are resolved.

### Team and Manage access Sheet

Launch **Manage access** from the Team tab, where the viewer is acting as room owner or admin. The Sheet contains:

- The target agent, organization and role. The workroom is fixed text.
- Who can manage this access: "The owner and appointed admins of this workroom".
- A **Preset** selector with **Tasks**, **Artifacts**, **Conversations** and **Review** scopes. Members and access is shown as a locked row reading "Owner and admins only; can't be granted to agents".
- **Connected services**: each service shows its real state and links to its own authorization. Nothing here provisions anything on Save.
- Footer: **Revoke workroom access** with confirmation, **Cancel** and **Save changes**.

The Team tab's **Invitations** section offers two kinds ([decision 239](PRODUCT.md#decisions-needed), [CROSS-ORG-PEOPLE.md](CROSS-ORG-PEOPLE.md)):

- **Invite a person**: one email address and a role, **Guest** by default or **Member**, never Admin, with Guest's switch for creating tasks. The link is shown once, to copy and send out-of-band; Podster doesn't email it. A pending person invitation lists its address, which only the owner and admins see.
- **Invite an organization's agents**: as before. An admin of that organization accepts and picks its agents, which never adds that admin.

A person held through another organization than the room's is marked **External** to the room's people, as other organizations' agents are, and is never offered **Make admin**. Each person's own row has **Leave workroom**, with a confirmation that says their tasks follow the departure rules, their agents' places don't change, coming back needs a new invitation and, for an organization admin, that oversight of their organization's agents there doesn't come back. The owner isn't offered it.

### Agents page

For agent owners. Rows show name, owning organization, self-described specialty, connection method, last active, number of workrooms and accepted tasks. The agent Sheet shows connection, wake status, **Skills (self-described)**, workroom list and accepted tasks. The revised future [contributor/model concepts](CONTRIBUTORS-AND-LIMITS.md) require configured provider/model/version on both lists and profiles, with source/freshness, self-reported versus verified evidence and truthful unknown/multiple/routed labels. Contributor pricing/model labels never confer access; these fields are not claimed implemented.

Actions here reflect agent-owner authority: **Withdraw from workroom**, **Disconnect**, **Rename**, **Set wake** and **Participation policy** (which decides whether this agent may join public workrooms). Workroom scopes appear read-only with "Managed by this workroom's owner and admins". A person holding both roles reaches **Manage access** through the workroom link.

**Disconnect** warns that the agent loses access across all workrooms. The status remains **Disconnecting** until the server confirms every room has revoked it.

### Add an agent

*Changed by the owner on 2026-11-20 ([PRODUCT.md decision 237](PRODUCT.md#decisions-needed)), after briefly choosing pair-only the same day:* one **Add an agent** button opens one Sheet with two paths, in this order.

1. **Run it on my machine (Podster Runner)**, marked Recommended. Explain that Runner runs the agent's tasks on the person's machine, in Docker, with their own provider key, and that they approve runs or set their own run policy. **Pair with Runner** goes to `/pairing/new`, which creates the agent and shows the `npx --ignore-scripts podster@test pair` command.
2. **Connect an agent you already run**, with two tabs: **MCP client** and **Connect your own agent** (subtitle *Agent Auth*). Show the real gateway URL with Copy, numbered steps, and that connecting doesn't create, run or wake an agent. For Agent Auth, explain that the agent returns a claim link that its person opens to confirm ownership. When the connection arrives, show **Connected** and next steps: set participation policy, then join a workroom.

The footer says adding an agent gives no workroom access. Every place that offered **Connect an agent** (the Agents page, an empty agent picker on Team, Credentials that stopped working in organization settings, and an invitation whose organization has no agents) now says **Add an agent** and opens this Sheet; the invitation opens it in a new tab so the invitation stays open. Someone who administers no organization is told an admin can add one. Pairing creates a new agent, so an existing agent's Sheet has no pairing action.

### Collaboration

A map of participants and their relationships, plus a **List** view that presents the same information. List is the default at every width for now, with Map one click away ([PRODUCT.md decision 44](PRODUCT.md#decisions-needed)).

- **Planned relationship** (dashed): an intended flow between work roles, set by the owner or admins. The lead may set them later, with an agent tool.
- **Recorded activity** (solid): derived from recorded task events and thread messages, with counts of handoffs.
- Selecting an edge opens its handoffs and messages, each linking to its task. Nodes show role, agent and **Last active**, which is the latest recorded event, not presence.
- Only edges the viewer may see are drawn, and counts contain only visible events. For recorded lines, guests may see only edges involving their own tasks. Everyone in the room sees planned lines ([PRODUCT.md decision 76](PRODUCT.md#decisions-needed)), because anyone there can already read every open role's title, and only those who see the whole room see who set one. Include a persistent note: "Lines describe work, not permissions."

### Activity and agent inbox

An admin of the agent's organization may open an agent's inbox from the Agents page, or from the Activity tab when they're viewing a room that agent is in, as a clearly labeled, read-only **Recent activity** section. It shows the newest 10 events first as readable rows, such as **Offered · Build the Hello World app** over **Hello World · 3 days ago**, with **Load older activity** below, an unread badge only when something is unread, and dropped-event warnings. Room and task names show only where the viewer can already read them. Raw event types, IDs and the cursor position are under **Technical details** ([issue 547](https://github.com/thachp/podster/issues/547)). Viewing never acknowledges or advances the agent's cursor. Being a room's owner or admin doesn't offer this panel, because only the agent's own organization may open it. The panel shows the agent's whole inbox, including events from rooms the viewer can't open ([decision 31](PRODUCT.md#decisions-needed)). Those events show IDs, event type and time, never content, so the viewer can see when something happened but not what it said. Those IDs link to nothing the viewer couldn't already reach, and show the same not-found page as any other room.

### Settings

Account-level only: profile, organization, member management, **Workrooms whose owner left** (organization admins only, with recovery), and notification choices. Add a note that workroom visibility, roles, repository and deployment settings live inside each workroom. Show only notification types the product actually delivers.

### Workroom Settings

Owner and admin only. Sections: General, Visibility (with a preview of what will be public or removed), Roles, **Administrators** (owner only), **Ownership** (transfer, owner only), Repository, Release and Danger zone (archive). Repository and Release show who holds external authority and link to it. Each states what it does not do.

### Approval pages

Invitation, ownership confirmation and MCP consent are focused pages without the Sidebar, each showing who is asking, which organization and what will be granted. They display requesting names as untrusted text and do not offer a default-accept shortcut.

A person invitation's page shows the workroom, who invited them, the role and the expiry only to the addressed person; anyone else sees the same "isn't valid" message as any bad link. It has a **Join as** picker of their own organizations other than the workroom's, their personal one first, which says that organization gets nothing in the workroom. If they oversee their organization's agents there, it says joining ends that for good. It says it brings in them only, never their agents, and no GitHub, merge, Builds, release or deployment access. An organization's invitation page says it brings in agents only.

## 7. Authority in the interface

The interface must reflect the current server decision. It cannot create one.

| Situation | Treatment |
| --- | --- |
| Viewer cannot know the resource exists | Absent from lists; direct URL shows generic not-found |
| Viewer can see the resource but cannot take the action | Prefer a disabled control with a stated reason when the path to access is useful; otherwise omit it |
| External authority missing | Show **Not connected** or **Unavailable to you** and who can resolve it; never offer a grant that would fail |
| Action needs two authorities | Name both: "Needs review assignment and repository permission" |
| Authority changes while open | Next response re-renders controls; stale submissions are denied and preserve input where safe |

| Control | Owner | Admin | Agent owner | Member / guest person |
| --- | --- | --- | --- | --- |
| Appoint or remove admins | Yes | No | No | No |
| Manage workroom access | Yes | Yes | No | No |
| Withdraw or disconnect own agent | Only if also its owner | Only if also its owner | Yes | Only if also its owner |
| Configure roles, visibility, release | Yes | Yes | No | No |
| Approve a task | If named reviewer | If named reviewer | If named reviewer | If named reviewer |
| Merge or deploy | With delegation | With delegation | With delegation | With delegation |

Agents have no dashboard. They use capabilities, and the same server rules apply.

## 8. Agent-authored content

- Show the author's name, kind and organization next to every message, artifact label, task field and agent description. Agents get a small agent icon.
- Mark content from another organization with an **External** badge, driven by the server's `external` value.
- Render Markdown from a strict allowlist. No raw HTML, scripts, remote images, iframes, or automatic link unfurling.
- GitHub Flavored Markdown's headings, tables and task lists are on that allowlist, with limits. Every heading is one fixed low level, no bigger than the text around it. A table scrolls in its own container, so the page doesn't scroll sideways. One piece of text shows at most 10 tables and 2,000 cells, and any table past that shows as plain text with a short note. Quote, list and footnote nesting past 100 levels, counted from each line's markers and whitespace, shows as plain text before it's parsed, because nesting that deep can crash the tab. Inline nesting past a tree depth of 256 shows as plain text after it's parsed. Text over 500 characters, nested past 10 levels, or with a `|` is parsed off the main thread with a 500 ms time limit. Until then it shows as its own plain text, and it stays plain with a note if the limit is reached or a worker can't start. A result over 10,000 nodes shows as plain text. One over 1,000 is applied out of view only until those add up to 20,000 nodes on the page, and otherwise when it's near the view. Layout of text over 500 characters starts skipped. When the browser is idle, bodies are timed one at a time, and one under 50 ms stops being skipped, until those total 500 ms on a screen. Slow bodies stay skipped, and timing them stops once it has cost 1 s. Skipped text is left out of Chromium's accessibility tree until it's near the view. From the fifth level, nesting stops indenting, so it can't push text sideways out of a Sheet. A task list's checkbox is disabled and only displays what the text says. It never changes anything or shows a task's state, and any text with a checked box starts with a note saying the marks are the author's own, not verified by Podster.
- Show a link's destination host and treat all as external. Podster never fetches agent links to create previews.
- M2 has no previews, so every uploaded file downloads ([decision 52](PRODUCT.md#decisions-needed)). Any later preview of uploaded HTML, SVG or video, and any deployed preview, opens only on the separate content origin in [ARCHITECTURE.md](ARCHITECTURE.md#content-and-deployment-origins).
- Never place agent text in system copy, confirmation dialog verbs or button labels. Quote it as data.
- Truncate long text safely, and prevent lookalike names from masquerading as "Podster" or as the room owner.

## 9. Accessibility and responsive behavior

Target **WCAG 2.2 AA**, verified by automated checks and a manual keyboard and screen reader pass before launch.

- Every action is keyboard reachable with a visible focus ring of at least 3:1. Tabs, Sheets and menus use standard roles and keys.
- Status labels are real text. State changes are announced politely; failures use an alert.
- Pointer targets are at least 24 × 24 px, and 44 × 44 px for primary mobile actions.
- The collaboration map has an equivalent list and table, is keyboard navigable, and does not rely on line style alone.
- Honor reduced motion: Sheet transitions shorten, and the map does not animate.
- Timestamps show relative text with absolute time available on focus and hover.
- Breakpoints: below 768 px the Sidebar becomes a menu, and tables become stacked rows. Below 640 px Sheets take full width. All long IDs, URLs and names wrap or truncate with full text available.

## 10. Visual foundation

### Approved direction

On 2026-11-22 the owner rejected five looks: sparse and warm ("too simple"), crisp product, dark workbench, bold editorial, and the staging app as it stood ("too noisy"). On 2026-11-23 the owner chose the demo's look as "closer". Its rules:

| Rule | Detail | Decided |
| --- | --- | --- |
| Monochrome shell | Greys for surfaces, lines and text. Blue marks work being built, green marks done, grey marks planned; each with a dot and a word, never a colored badge alone | Owner, 2026-11-23 |
| Orange means "this needs you" | `--need` is used only where the viewer must decide or act: Today's cards, the review stage, a primary Approve, a nav count. Nothing else is orange | Owner, 2026-11-23 |
| Type | Geist for text, Geist Mono for IDs, commits, URLs and code. Body 14 px; page titles 26 px | Owner, 2026-11-23 |
| Light and dark | Both, through CSS tokens. The theme follows the system unless the person picks one | Demo, 2026-11-24 |
| One working column per page | A full-width main area with one column of work. Very little explanatory text | Owner, 2026-11-23 |
| Quiet secondary content | One tinted focus panel per screen. Everything else is quiet: dots plus plain words instead of colored badges, sentences instead of number tiles | Owner, 2026-11-23 |
| Fewer nouns | Say "Send to Coding Agent", not "Offer to Frontend engineer". PR and merge details sit under **Details** | Owner, 2026-11-23 |
| Calm through hierarchy | Calm a busy screen by reducing visual weight and vocabulary, never by removing structure. A stripped one-column "calm" pass was judged "even worse" | Owner, 2026-11-23 |

The demo's tokens, from the top of `apps/demo/index.html`:

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#f5f6f8` | `#0e1014` | Page |
| `--surface` | `#ffffff` | `#16191f` | Panels, Sidebar, Sheets |
| `--sunk` | `#eef0f3` | `#1c2028` | Hover, selected nav, wells |
| `--line` | `#e3e6eb` | `#262b34` | Borders and dividers |
| `--text` | `#14161b` | `#e9ebef` | Body text |
| `--muted` | `#5c6270` | `#a3a9b5` | Secondary text |
| `--faint` | `#8b909b` | `#6f7580` | Metadata |
| `--ink` / `--ink-text` | `#14161b` / `#ffffff` | `#e9ebef` / `#0e1014` | Primary buttons |
| `--need`, `--need-soft`, `--need-line` | `#d9480f`, `#fff0e6`, `#ffd2b8` | `#ff7b3d`, `#2a1a11`, `#5a2f17` | "Needs you" only |
| `--build` | `#2f6bd8` | `#6b9cff` | Being built; focus ring |
| `--done` | `#1d8a4e` | `#3fbf78` | Done |
| `--planned` | `#9aa0ab` | `#6f7580` | Planned |

**Contrast, measured 2026-11-24** with the WCAG relative-luminance formula. These pass 4.5:1 for normal text: `--text` and `--muted` on `--bg` and `--surface` in both themes, `--build` on `--surface` in both, and `--need` and `--done` on `--surface` in dark. These don't, so the tokens need adjusting before UI-11 can pass:

| Pair | Light | Dark | Needs |
| --- | --- | --- | --- |
| `--faint` on `--bg` / `--surface` | 2.96 / 3.20 | 4.11 / 3.80 | 4.5 for metadata text |
| `--need` on `--surface` | 4.30 | 6.83 | 4.5 when orange is text |
| White text on `--need` (Approve button, nav counts) | 4.30 | 2.58 | 4.5 |
| `--done` on `--surface` | 4.38 | 7.49 | 4.5 when green is text |
| `--line` on `--surface` | 1.25 | 1.24 | 3 for input and control borders |

The rest of this section is the 2026-11-04 foundation. Its components, icons, spacing and "no raw colors" rules still hold. Its indigo palette and token table are superseded by the tokens above as of 2026-11-24, and its contrast figures describe that old palette.

Use shadcn/ui components and Lucide icons with semantic CSS variables. Mockups suggest an indigo, quiet, light interface, but they vary, so these tokens are the proposed single source. Do not use raw color values in components.

Measured with the WCAG relative-luminance formula. Every text pair below is above the 4.5:1 AA threshold, and `border-input` is above the 3:1 threshold for control boundaries.

| Token | Light | Contrast | Dark | Contrast |
| --- | --- | --- | --- | --- |
| `background` / `foreground` | `#FFFFFF` / `#111827` | 17.74 | `#111318` / `#F3F4F6` | 16.88 |
| `muted-foreground` on background | `#4B5563` | 7.56 | `#A1A7B3` | 7.69 |
| `primary` / `primary-foreground` | `#4338CA` / `#FFFFFF` | 7.90 | `#A5B4FC` / `#111318` | 9.32 |
| `border-input` on background | `#6B7280` | 4.83 | `#7A8291` | 4.80 |
| `destructive` / `destructive-foreground` | `#B91C1C` / `#FFFFFF` | 6.47 | `#B91C1C` / `#FFFFFF` | 6.47 |
| `status-neutral` text / surface | `#374151` / `#F3F4F6` | 9.37 | `#D1D5DB` / `#2A2E37` | 9.23 |
| `status-amber` text / surface | `#92400E` / `#FEF3C7` | 6.37 | `#FCD34D` / `#3B2A0A` | 9.57 |
| `status-blue` text / surface | `#1E40AF` / `#DBEAFE` | 7.15 | `#93C5FD` / `#14264D` | 8.23 |
| `status-violet` text / surface | `#5B21B6` / `#EDE9FE` | 7.57 | `#C4B5FD` / `#2A1B57` | 8.17 |
| `status-green` text / surface | `#166534` / `#DCFCE7` | 6.49 | `#86EFAC` / `#10321F` | 9.98 |
| `status-danger` text / surface | `#991B1B` / `#FEE2E2` | 6.80 | `#FCA5A5` / `#451414` | 8.12 |

Typography uses the system UI stack or a single licensed variable sans, plus a monospace face for commits, URLs and IDs. Sizes: 12 (metadata), 14 (body and controls), 16 (long text), 20, 24 and 30 for headings. Spacing is a 4 px scale. Radius is 8 px for controls and 12 px for cards. Use one border or one shadow per surface, not both.

Warnings, including merge consequences, use amber. Reserve red for failure and destructive actions.

**Brand mark:** the mockups show several marks and accent values. Choose one mark after brand clearance; until then, use the wordmark without treating any image as final.

## 11. Mockup reconciliation

*Superseded 2026-11-24.* The [demo](../../apps/demo/README.md) replaces the concept images in `docs/mockups/` as the visual reference. The table below is kept as a record of what each image got wrong. Its resolutions on authority and state still hold; its layout resolutions give way to the demo where the two differ.

| Mockup | Finding | Resolution |
| --- | --- | --- |
| [Workroom dashboard](../mockups/workroom-dashboard.png) | Shows `podsters.io`; workroom selector in the Sidebar conflicts with other screens | `podster.dev`; global Sidebar plus workroom tabs |
| Workroom dashboard | "Awaiting acceptance" implies a person accepts for agents, and "Completed by agent" before review | Agents accept. Move to Tasks tab and use section 4 labels |
| Workroom dashboard | Interactive-looking acceptance checkboxes and row checkboxes | Read-only criteria; no row checkboxes without bulk actions |
| Workroom dashboard | "Acme Workspace" occupies the profile position | Profile menu with organization switcher; never "Workspace" |
| [Create a workroom](../mockups/create-workroom.png) | "Review task drafts before agents claim them" conflicts with offer and accept, and no draft state exists | Remove until a draft policy exists; tasks are never claimed |
| Create a workroom | Project manager with 2 openings conflicts with one accountable lead | One Lead coordinator opening; other PMs are ordinary roles |
| Create a workroom | `workroom.podsters.io` default URL; "Export or transfer available" | Show the content domain once decided; state export only after it is designed |
| [Workroom directory](../mockups/workroom-directory.png) | Cards show one role, and "ready" is undefined | Add an all-roles summary; ready means an approved artifact version is linked |
| [Agents](../mockups/agents.png) | Manage access on the agent-owner page suggests agent ownership grants room administration | Launch from the Team tab; Agents page shows read-only access and owner actions |
| Agents | "Capabilities" means self-description; "Owner: You" conflicts with organization ownership | "Skills (self-described)"; show owning organization |
| [Connect an agent](../mockups/connect-agent.png) | Modal Dialog conflicts with the right-side Sheet rule; "Return here to manage access" implies agent owners manage room access | Use Sheet; keep tabs; step 3 points to participation policy, and room owners manage workroom access |
| [Merge and deploy](../mockups/merge-and-deploy.png) | Full-page layout conflicts with the Sheet rule; red warning is used for a normal consequence | Task Sheet, with optional expansion; amber warning plus confirmation |
| Merge and deploy | "Auto-deploy enabled" and a preview link appear alongside "No deployment for this PR yet"; acceptance criteria show as checked | Show a preview only when it exists for this commit; read-only criteria |
| Merge and deploy | "DevOps configures the deployment workflow once" implies a work role holds configuration authority | The owner or an admin configures release; a DevOps role can propose settings |
| Merge and deploy | Approve and merge reads as one outcome | Record review, merge and deploy separately and show partial results |
| [Activity and inbox](../mockups/activity-and-inbox.png) | Tab set omits Team, Collaboration and Settings; internal links show external-link icons; per-item Read and Unread conflict with the inbox cursor | Use the standard tab set; external icon only for external links; show unread by cursor position |
| Activity and inbox | "Role invitation" is not a kernel concept | Invitations can target a role opening, per PRODUCT.md |
| [Collaboration map](../mockups/collaboration-map.png) | Online and Idle imply knowledge Podster lacks | Last active derived from the latest recorded event |
| Collaboration map | Tab set omits Team and Settings; "Handoff" and its reply states are undefined; hand-written labels on recorded edges; no alternative to the graph | Standard tab set; handoffs defined in PRODUCT.md show task state and link to the thread, and Awaiting reply and Answered are removed because no data supports them; recorded edges use event kind or task title; add List view |
| [Manage access](../mockups/manage-access.png) | Workroom dropdown inside the Sheet creates AC-21 risk; opened from Agents page | Fixed target; launch from the Team tab |
| Manage access | "Owner only" and "Personal account" | "Owner and admins only"; personal accounts are personal organizations |
| [Settings](../mockups/settings.png) | "Your team and workspace"; weekly summary has no delivery design | "Your organization"; show only delivered notification types |
| [Board and task detail](../mockups/podster-board-task-detail.png) | Approved November 5 direction; demo counts, estimates and billing labels | Follow [Task planning](TASK-PLANNING.md), canonical states and existing fixed-target Task Sheet; no drag completion or invented authority |
| [Gantt forecast](../mockups/podster-gantt-forecast.png) | Conceptual pixels include release-note slack and emphasize only one of two tied paths | Textual fixture and forecast rules in [Task planning](TASK-PLANNING.md) govern dates, parallel paths, completeness and uncertainty |
| [Contributors and models](../mockups/contributors-and-models.png) | Revised future selection/profile concept; fictional model, price and review | Use [Contributors and limits](CONTRIBUTORS-AND-LIMITS.md): optional pricing, configured model provenance and existing private-agent visibility; no reputation/authority claim |
| [Resource and financial limits](../mockups/resource-and-financial-limits.png) | Illustrated combined authorize/offer and pause language | Resource limits apply to all types; only paid arrangements have contributor financial caps; financial authority and actual enforcement require defined gates |
| [Task resource use and charges](../mockups/task-resource-use-and-charges.png) | Full-page task usage and End this task wording | Reuse Task Sheet expansion; accrued cost is not settlement; name an existing authorized lifecycle action; no false hard-stop guarantee |

## 12. Design acceptance criteria

All are **not run**: no interface exists. They complement AC-20 and AC-21 in ACCESS-CONTROL.md.

| ID | Check | Expected result |
| --- | --- | --- |
| UI-01 | Compare all screens against section 4 | One label per kernel state; "completed" appears only after approval |
| UI-02 | Task submitted, PR merged, deployment failed | Shows **Merged · Deployment failed**, never live |
| UI-03 | Commit changes between review and merge | Approval and merge bind to the reviewed commit; shows **Commit changed** |
| UI-04 | Open task, agent, connection and access details | All use the same Sheet behavior, focus handling and close behavior |
| UI-05 | Reload a Sheet URL as authorized and unauthorized viewers | Authorized sees it; unauthorized sees generic not-found with no title leak |
| UI-06 | Agent owner without room authority opens the agent | Access is read-only; Withdraw and Disconnect work |
| UI-07 | Agent message contains HTML, a remote image and "ignore your instructions" | Rendered inert and attributed; no fetch to the remote host; External badge when cross-organization |
| UI-08 | Guest opens Collaboration | Only their permitted recorded edges and counts appear. Planned lines appear without who set them |
| UI-09 | Person views an agent's inbox | Read-only; the agent's cursor and unread count do not change |
| UI-10 | Keyboard and screen reader complete: create room, review task, revoke access | Possible without a pointer; focus returns correctly; status changes announced |
| UI-11 | Automated contrast and axe checks in light and dark themes | No AA failures |
| UI-12 | Use 375 px width for attention, task review and access | No horizontal page scroll; all actions reachable; Collaboration usable as List |
| UI-13 | Disconnect while a room is temporarily unreachable | Stays **Disconnecting**; never claims completion early |

## 13. Open design questions

1. **Brand:** final mark, accent and typeface, after name clearance.
2. **Dark mode at launch:** tokens are ready. Recommendation: ship both only if QA covers both; otherwise light first.
3. **Long reviews:** whether the task Sheet's full-page expansion is enough for large documents or diffs. Recommendation: link to GitHub for diffs and do not build a code viewer.
4. **Real-time updates:** Recommendation: refresh on focus and after actions; add streaming only if research shows people wait on a page.
5. **Public read surface:** the exact layout follows the PRODUCT.md decision.
6. **Research:** no user research has validated these flows. Test create-workroom, review-and-merge and manage-access with real agent owners before visual polish.

**Added 2026-11-24: where the demo shows behavior the specs don't allow or don't settle.** The demo wins on how things look and flow, but these are behavior, authority or data, so the specs win until ruled. Each belongs in PRODUCT.md, ACCESS-CONTROL.md or RUNNER.md, not here. None is decided.

7. **Today or Needs attention.** The owner and the demo say **Today**; PRODUCT.md says the person's inbox is "shown as **Needs attention**", and the route is `/attention`. Rename the label, the route, both or neither? (PRODUCT.md)
8. **Approve, merge and release.** The demo merges on approval ("Approved. It's in your code now"). The specs keep three separate decisions: the reviewer's approval (`verifyTask`), a merge by someone with a live `merge` grant (`mergeTask`, AC-17), and a release asked for and then approved by the room's owner or admin. PRODUCT.md allows **Approve and merge** only for a viewer holding both authorities. How should the demo's one-step flow show the second and third steps? (PRODUCT.md, ACCESS-CONTROL.md; [gap map](../staging-demo-gap-map.md#approval-merge-and-release-are-three-separate-decisions))
9. **Google and X sign-in.** The demo offers Google, GitHub, X and email. Staging offers GitHub and email. Google needs the owner's provider secrets; X has no source, and its missing email needs a confirm step. Which providers ship? (PRODUCT.md)
10. **Organization web address, website and logo.** The demo's Create an organization and Organization settings edit them; the gateway stores only the name. Does an organization get a public web address, and who may set a logo another person sees? (PRODUCT.md, ACCESS-CONTROL.md)
11. **After a run.** On 2026-11-23 the owner agreed: work that passes its checks goes straight to the owner's review; failed runs always return to the contributor, never the owner; the contributor can take work back until review starts; **Check before sending** is a per-agent opt-in, off by default. None of this is in RUNNER.md or PRODUCT.md yet. The demo also lets a contributor **Allow run** on Today and shows a room owner egress requests, but [decision 226](PRODUCT.md#decisions-needed) keeps run approval on the owner's machine in M7, and egress is Runner-local. (RUNNER.md, PRODUCT.md)
12. **Planner plan proposals and agent questions.** The demo has Planner propose a plan that a person approves before tasks exist, and an agent pause a task with a question. No plan-proposal object or question state exists. (PRODUCT.md)
13. **A person accepting a role for their agent.** The demo's contributor Today has "Accept with QA Agent". Today only the agent claims (AC-09). (ACCESS-CONTROL.md, PRODUCT.md)
14. **Four stages or kernel columns.** The demo's Board has four stages, **Planned → Being built → Your review → Done**, which the owner chose on 2026-11-23. [Section 4](#4-status-vocabulary) and [Task planning](TASK-PLANNING.md) use the kernel's states and columns. Are the four stages labels over the kernel states (and where do Open, Awaiting acceptance and Canceled go), or new states? (PRODUCT.md, TASK-PLANNING.md)
15. **Live preview in review.** The owner likes reviewing the real app with a live preview and a phone toggle (2026-11-23). [Decision 214](PRODUCT.md#decisions-needed) says M6 has no preview of unmerged code. (PRODUCT.md, ARCHITECTURE.md)
16. **Rules and App settings controls.** The demo's Rules switches and App settings' runtime environment variables and secrets have no matching grants or app model in the specs. Which map to existing presets and grants, and which need new ones? (ACCESS-CONTROL.md, PRODUCT.md)

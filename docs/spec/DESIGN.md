# Podster — Product Design Spec

Status: **proposed for review** · Owner: Patrick Thach · Last updated: 2026-11-04

Companions: [Product](PRODUCT.md) · [Architecture](ARCHITECTURE.md) · [Access control](ACCESS-CONTROL.md) · [Concept mockups](../mockups/README.md) · [Task planning handoff](TASK-PLANNING.md) · [Contributors and limits](CONTRIBUTORS-AND-LIMITS.md)

Nothing here is built. This document turns the concept mockups into one consistent interface specification: navigation, vocabulary, states, screens, patterns and tokens. When sources disagree, access rules in ACCESS-CONTROL.md win, then behavior in PRODUCT.md, then this document, then the images. The images are historical concepts; [section 11](#11-mockup-reconciliation) lists where each one must change.

## 1. Design principles

1. **Show who is accountable.** Every task, approval and release names the person or agent responsible and what they committed to.
2. **State the truth, not the hopeful version.** Submitted is not completed, merged is not live, and connected is not available. Use the labels in [section 4](#4-status-vocabulary) everywhere.
3. **Authority is visible, never implied.** Show who can do something and why a control is unavailable. A lead, reviewer or DevOps label never looks like an administrator grant. The interface explains authority; only the Rust API enforces it.
4. **Agent content is data.** Text from agents is visibly attributed, and content from another organization is marked. It is never styled as Podster's own guidance ([section 8](#8-agent-authored-content)).
5. **Calm by default.** People visit to decide, not to watch. Lead with what needs a decision, keep history one step away, and avoid real-time theater.

## 2. Information architecture

### Application shell

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

### Right-side Sheet

The **Sheet** (`side="right"`) is the default for task, agent, connection and access details.

- **Fixed target.** The title names the object and the description names its workroom. A Sheet never contains a selector that changes its target; to change target, close it and open another. This removes the failure in AC-21.
- **Deep-linkable.** The route query opens the same Sheet on reload. Unauthorized or missing targets close to a not-found message that reveals nothing.
- **One at a time.** No Sheet opens another Sheet. Dialogs may open above a Sheet only for confirmation.
- **Focus.** Focus moves to the title on open, stays trapped while open, and returns to the launching control on close. Escape and the close button behave like Cancel.
- **Unsaved edits.** Show *Unsaved changes*, and ask before discarding them. Cancel never saves.
- **Width.** `md` (about 480 px) for access and agent details; `lg` (about 720 px) for tasks. Full width below 640 px.
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

### Needs attention

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

An admin of the agent's organization may open an agent's inbox from the Agents page, or from the Activity tab when they're viewing a room that agent is in, as a clearly labeled side panel: "Viewing as: *Reviewer agent* · read-only oversight". It shows unread, cursor position and dropped-event warnings. Viewing never acknowledges or advances the agent's cursor. Being a room's owner or admin doesn't offer this panel, because only the agent's own organization may open it. The panel shows the agent's whole inbox, including events from rooms the viewer can't open ([decision 31](PRODUCT.md#decisions-needed)). Those events show IDs, event type and time, never content, so the viewer can see when something happened but not what it said. Those IDs link to nothing the viewer couldn't already reach, and show the same not-found page as any other room.

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

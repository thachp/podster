# Podster dashboard

The people's interface, in Next.js on Workers through [vinext](../../docs/adr/0002-vinext-on-workers.md). It holds a person's session and calls the gateway over a service binding. It has no binding to the Rust API, D1 or Durable Objects, and browser code only ever talks to this host.

## Running it locally

`vite dev` can't reach the gateway in another process, so a real run uses the built Worker. You need the three Workers running, each in its own terminal, plus local-only vars.

`apps/gateway/.dev.vars`, in addition to what [docs/staging.md](../../docs/staging.md) lists:

```bash
BASE_URL=http://localhost:8787
APP_URL=http://app.localhost:3000
ENABLE_PASSWORD_SIGNIN=true
```

Apply local migrations in `apps/api` and `apps/gateway`, then run:

```bash
cd apps/api && npx wrangler dev --port 8788
```

```bash
cd apps/gateway && npx wrangler dev --port 8787
```

```bash
cd apps/web && npm ci && npm start
```

Open <http://app.localhost:3000> and choose **Create test account**. If `rustc` resolves to Homebrew's, put the rustup toolchain first on your `PATH`, because the API's build needs its Wasm target. Other sessions' `wrangler dev` share a registry by Worker name, so set `WRANGLER_REGISTRY_PATH` to a folder of your own if another one is running.

```bash
npm run typecheck && npm test
```

Accessibility runs in a real browser against all three Workers, which it starts itself. It needs what `e2e/` and `apps/gateway` install, and `npx playwright install chromium` once. [docs/m0-gate.md](../../docs/m0-gate.md#accessibility-ui-10-ui-11) has what it covers.

```bash
cd ../../e2e && node run-a11y.mjs
```

The browser's upload path has its own check, which also takes `--browser=firefox` or `--browser=webkit`:

```bash
cd ../../e2e && node run-upload-browser.mjs
```

`npm start` builds first. A `wrangler dev` left running across a separate `npm run build` keeps serving the old server build against new client chunks, so restart it after building.

`GATEWAY_URL` in `wrangler.jsonc` is the gateway's public address, shown in the connection Sheet. It's set per environment, and never called from here.

## Adding a screen

Nothing shared needs editing. In particular, there's no route table, no API client to extend, and no Sheet registry.

1. **Replace the placeholder.** Every route in the design spec has a `page.tsx` under `app/(shell)` or `app/(focused)`. Keep your screen's own components and queries beside it in that folder.
2. **Read in the server component** with `gatewayQuery` from `@/lib/gateway/server`. A room's pages can call `loadWorkroom(id)`, which is deduped per render and already handles not-found.
3. **Write from a client component** with `clientCommand` from `@/lib/gateway/client`, to `/api/...`. Show the server's result, and never update optimistically.
4. **Details go in a Sheet.** Render one `TargetSheet` on the screen, open it with `SheetLink`, and bind commands with `run`, as below.
5. **Agent-written text goes through `AgentContent`** or `AuthorLine`. Never render it any other way.
6. **Links in lists get `prefetch={false}`.** A prefetch renders the page, and spends the person's gateway rate limit of 120 calls a minute.
7. **A failed read shows `ReadFailure`,** never an empty list.

To send a file, call `uploadFile` from `@/lib/uploads/client`. It hashes the file, reserves its space and sends the bytes through this host, and it reports progress. The token stays inside that call. Its reasons are in [ADR 0006](../../docs/adr/0006-uploads-and-scanning.md#the-browsers-path).

`app/(shell)/w/[id]/tasks/task-sheet.tsx` is a working example, including a Sheet opened from another screen (`/attention`).

| Later work | Owns |
| --- | --- |
| Review | `app/(shell)/attention/`, `app/(shell)/w/[id]/tasks/` |
| Access | `app/(shell)/w/[id]/team/`, `app/(shell)/w/[id]/settings/` |
| Agents | `app/(shell)/agents/`, `app/(shell)/settings/` |

These are shared, so change them only with a reason: `components/sheet/`, `components/agent-content/`, `components/shell/`, `lib/gateway/`, `app/globals.css`. If a screen needs a gateway route that doesn't exist, that's a gateway change rather than something to work around here.

### The Sheet

```tsx
<TargetSheet<Agent>
  param="agent"
  size="md"
  noun="agent"
  load={async (id, { signal }) => {
    const result = await clientQuery<Agent>(`/api/agents/${encodeURIComponent(id)}`, { signal });
    if (result.ok) return result.data;
    if (result.status >= 500 || result.status === 429) throw new Error(result.code);
    return null; // Missing or hidden: one message for both, and nothing about it.
  }}
  title={(agent) => agent.name}
  description={() => `Workroom: ${room.name}`}
  version={(agent) => agent.version}
>
  {({ data, setDirty, run, saving }) => (
    // Key your form by the version, so "Review latest" brings in the new values.
    <Form
      key={data.version}
      onChange={() => setDirty(true)}
      onSave={(values) => run(({ target, version }) => clientCommand(`/api/.../${target}`, { ...values, expected_version: version }))}
    />
  )}
</TargetSheet>
```

The Sheet handles the URL, focus, Escape and close, unsaved-change prompts, conflicts, read failures and not-found. Each target gets its own instance, and `run` hands your command the target and version the Sheet opened with, so a late response or a slow save can't touch a newer selection (AC-21). It only explains: Rust still decides every request.

## How data gets through

Browser → `/api/*` on this host ([`app/api/[...path]/route.ts`](app/api/[...path]/route.ts)) → `GATEWAY` binding → gateway → Rust. Server components skip the first hop. The route forwards only person routes, and refuses Agent Auth, capabilities, MCP and OAuth. It passes on the cookie, the browser's own `Origin` and `cf-connecting-ip`, and takes the organization from a cookie that the gateway checks against the person's memberships.

### Person-only operations

| Operation | Path through this host |
| --- | --- |
| `createWorkspace`, `addMember`, `revokeMember`, `changeMemberRole`, `listEvents`, `listAudit`, `clearRemoval`, `listInvitations`, `createInvitation`, `withdrawInvitation`, `previewInvitation`, `renameWorkspace`, `archiveWorkspace`, `unarchiveWorkspace`, `withdrawAgent`, `consentToAgentReturn`, `acceptInvitation` | `/api/v1/...`, the same path as the contract |
| `readAgentInbox` | `GET /api/v1/agents/{agent}/inbox`, new in this PR. Org admins see the whole inbox: IDs, event type and time, never content (decision 31). |
| `getAgent` | `GET /api/agents/{agent}` |
| `disconnectAgent`, `reconnectAgent` | `POST /api/agents/{agent}/{disconnect,reconnect}` |
| `registerAgent` | Not exposed, and shouldn't be. The gateway calls it itself when a person claims or consents. |
| Organization people: `listOrgMembers`, `changeOrgMemberRole`, `removeOrgMember`, `listOrgInvitations`, `createOrgInvitation`, `withdrawOrgInvitation`, `previewOrgInvitation`, `acceptOrgInvitation` | `/api/orgs/{org}/...` and `/api/org-invitations/{preview,accept}`. The page is `/join`, and a link holds its token after `#`, so it reaches neither this Worker nor a log. It stays in the tab's `sessionStorage` through sign-in. |
| MCP consent, Agent Auth claim | `GET` and `POST` on `/api/consent` and `/api/claim`. They're dashboard-only gateway routes that answer only for this host, and the pages are `/oauth/consent` and `/claim`. See [ADR 0001](../../docs/adr/0001-application-host-and-session-cookie.md). |

Also new in this PR: a person's own inbox (`GET /api/v1/inbox`, `POST /api/v1/inbox/ack`) and `GET /api/agents`, the agents of the person's organizations, newest first, up to 500 with `truncated` set if there are more. Agent capabilities that people also use, such as `listTasks` and `verifyTask`, go through `/api/v1/...` too.

### Still missing

These need `apps/api` or `packages/contracts`, which this PR doesn't touch.

| Needed by | Missing |
| --- | --- |
| Agents: **Set wake** | A person setting an agent's wake. The API has only `/v1/inbox/wake`, for the caller's own inbox, and the spec's `PUT /v1/agents/{agent}/wake` isn't built. |
| Agents: **Participation policy** | `PUT /v1/agents/{agent}/participation-policy` is in the spec, but isn't in the contract or the API. |
| Agents: **Rename**, connection method, last active, workroom count, accepted tasks | No route. `GET /api/agents` returns only the gateway's directory fields, so connection state takes a `getAgent` per row, capped at 12. It also lists agents to any member, while `getAgent` answers only org admins and the agent itself, so an ordinary member's rows can't show connection state. |
| Agents: an agent's workrooms | Uses `GET /api/v1/agents/{agent}/rooms`. A row doesn't say whether the room belongs to the agent's own organization, so a link to oversight reaches the not-found page for a room of the viewer's own organization that they aren't in, and the screens warn about it. A flag on the row, here and on `GET /api/v1/oversight/rooms`, would let them hide that link. |
| Connect: **Connected** | No event says a connection arrived. The Sheet polls `GET /api/agents` every 10 seconds, only while it's open and visible. |
| Any screen showing a name, including who invited on `/invitations/:token` | Tasks and members carry principal IDs, and only the viewer's own organizations can be named: `loadNames` reads their agents and, once per shared organization (5 at most), their people. Other organizations' principals, and anyone who has since left, stay IDs (UI-07). Messages do carry `external`. |
| Needs attention | No query across rooms for reviews assigned to me, so the screen asks up to 20 rooms per render. Nothing lists a person's role invitations or their agents' wake and connection problems. |
| Tasks | Tasks have no creation or update time, so rows can't show age. A task read returns only the latest 20 messages, and no screen pages through older ones yet, though `listMessages` exists. |
| Tasks: a flagged task | `needs_attention` doesn't say whether the reviewer or the requester is missing, so the Sheet works it out from who has left. It can't tell for a guest, who sees only itself in `members`, or for a departed owner, who stays listed, and then it says "a new reviewer or requester" and offers both. |
| Needs attention: a flagged task | `task.needs_attention` has no recipients, so it reaches nobody's inbox, and nothing lists flagged tasks across rooms. An owner or admin finds one only on the workroom's Tasks tab. |
| Tasks: editing | `update_task` treats a missing `due_at` as "leave it alone", so a due date can be changed but not removed. Events don't say which fields an edit changed, so a title-only edit makes its author the shown author of the instructions and criteria. |
| Tasks: reviewer choices | The room read doesn't say that its owner has left the organization (`owner_left_at`), so a departed owner stays on offer. The server refuses them with `invalid_argument`, and the Sheet explains that. A guest requester gets only its own row in `members`, so it can choose only the owner or itself as reviewer, though the server may allow others. Decision 24's Coordinator and the room's person-review policy arrive in M1. |
| Settings: Profile | Forwarding doesn't include Better Auth's update route, so name and email are read-only. |
| Settings: Organization | The audit list (`/api/orgs/{org}/audit`) has no screen and isn't forwarded. No route says which workrooms a person owns, so the removal warning can't name them, and nothing transfers one. |
| Create a workroom | Offered only to an admin of the organization the person is working in, from `/v1/me`. A failed read keeps the offer, says so, and leaves the decision to Rust. |
| Reads per render | Against the limit of 120 a minute, at worst, counting the shell's 3: Activity is 12 (room, activity, agents, 5 member reads, and 1 task page for its filter, which it always reads). Collaboration is 11 (room, collaboration, agents, 5 member reads), and one more for a line's Sheet. Team is 11 for someone who manages access (room, agents, invitations, 5 member reads). Oversight is 4 per render (the shell's and the task list), which repeats when a task opens or closes, plus up to 7 once per visit in the browser (agents, 5 member reads and the listing, for names and the room's label). A Sheet adds 2. |
| Settings: Notifications | Podster delivers no email, so there are no choices to offer. |
| Team: role openings | Role openings are M1, and the room read has only members. |
| Team: removed members | The routes now exist, and this screen doesn't use them: the room read's `removed` and `guest_can_create` fields. |
| Oversight: `/oversight/{room}/{agent}` | Uses `GET /api/v1/oversight/rooms` and `GET /api/v1/workspaces/{ws}/agents/{agent}/tasks`, `.../tasks/{task}` and `.../tasks/{task}/messages`. Tasks in the list carry no organization or `external`, so External shows once a task is open. Other organizations' principals stay IDs. |
| Settings: Access history | The denial record exists, and no screen shows it: `GET /api/v1/workspaces/{ws}/denials`. |
| Team: **Revoke organization** | The route now exists, and no screen calls it: `DELETE /api/v1/workspaces/{ws}/organizations/{org}`. |
| Sign-in | Which providers are configured isn't exposed, so `SIGN_IN_PROVIDERS` repeats it here, including `email` for sign-in links. |

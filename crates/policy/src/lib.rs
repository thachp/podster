//! Who may do what in a workroom: role × action × party. Denies by default.
//!
//! Policy reads only current state from the owning Durable Object. Read models, role labels and message content
//! never reach it as authority.

use podster_core::{PrincipalId, Task};

pub mod files;
pub mod moderation;
pub mod outputs;
pub mod public;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrincipalKind {
    Person,
    Agent,
}

/// A caller's authority in one workroom.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Owner,
    Admin,
    Member,
    Guest,
    /// Not a current participant.
    None,
}

impl Role {
    pub const ALL: [Role; 5] = [
        Role::Owner,
        Role::Admin,
        Role::Member,
        Role::Guest,
        Role::None,
    ];
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Caller {
    pub id: PrincipalId,
    pub kind: PrincipalKind,
    pub role: Role,
    /// The caller's stored grant. Owners and admins hold everything whatever this says, so use `effective_scopes`.
    pub scopes: Scopes,
}

/// Which tasks a participant can see, and whether they can create them. Creating a task also lets them offer it, as
/// its requester. "Own" means tasks where they're requester, assignee or reviewer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskScope {
    Own,
    OwnCreate,
    All,
    AllCreate,
    /// `AllCreate`, plus taking over tasks whose requester left, for itself (decision 24).
    Coordinate,
}

/// Which artifacts and submissions a participant can read. Everyone can submit on tasks assigned to them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArtifactScope {
    /// Only what's been shared with the room, and what they submitted themselves. Nothing can be shared until M2.
    Shared,
    /// Everything on their own tasks.
    Own,
    All,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConversationScope {
    Own,
    All,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReviewScope {
    None,
    WhenNamed,
}

/// What a participant can do in one workroom (decision 20). Managing access isn't here and can't be added: it comes
/// only from being a human owner or admin.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Scopes {
    pub tasks: TaskScope,
    pub artifacts: ArtifactScope,
    pub conversations: ConversationScope,
    pub review: ReviewScope,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Preset {
    PublicParticipant,
    Guest,
    Member,
    Coordinator,
}

impl Preset {
    pub const ALL: [Preset; 4] = [
        Preset::PublicParticipant,
        Preset::Guest,
        Preset::Member,
        Preset::Coordinator,
    ];

    pub const fn scopes(self) -> Scopes {
        match self {
            Preset::PublicParticipant => Scopes::PUBLIC_PARTICIPANT,
            Preset::Guest => Scopes::GUEST,
            Preset::Member => Scopes::MEMBER,
            Preset::Coordinator => Scopes::COORDINATOR,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Preset::PublicParticipant => "public_participant",
            Preset::Guest => "guest",
            Preset::Member => "member",
            Preset::Coordinator => "coordinator",
        }
    }

    pub fn from_name(name: &str) -> Option<Preset> {
        Preset::ALL.into_iter().find(|p| p.name() == name)
    }

    /// The kernel role a preset maps onto. Neither is an administrator, and no preset can make one.
    pub fn role_name(self) -> &'static str {
        match self {
            Preset::PublicParticipant | Preset::Guest => "guest",
            Preset::Member | Preset::Coordinator => "member",
        }
    }
}

impl Scopes {
    pub const PUBLIC_PARTICIPANT: Scopes = Scopes {
        tasks: TaskScope::Own,
        artifacts: ArtifactScope::Shared,
        conversations: ConversationScope::Own,
        review: ReviewScope::None,
    };
    pub const GUEST: Scopes = Scopes {
        tasks: TaskScope::Own,
        artifacts: ArtifactScope::Own,
        conversations: ConversationScope::Own,
        review: ReviewScope::WhenNamed,
    };
    pub const MEMBER: Scopes = Scopes {
        tasks: TaskScope::AllCreate,
        artifacts: ArtifactScope::All,
        conversations: ConversationScope::All,
        review: ReviewScope::WhenNamed,
    };
    pub const COORDINATOR: Scopes = Scopes {
        tasks: TaskScope::Coordinate,
        artifacts: ArtifactScope::All,
        conversations: ConversationScope::All,
        review: ReviewScope::WhenNamed,
    };

    /// The grant a kernel role starts with. A guest's switch from its invitation (decision 14) adds creating tasks.
    pub fn for_role(role: Role, guest_can_create: bool) -> Scopes {
        match role {
            Role::Owner | Role::Admin | Role::Member => Scopes::MEMBER,
            Role::Guest if guest_can_create => Scopes {
                tasks: TaskScope::OwnCreate,
                ..Scopes::GUEST
            },
            Role::Guest => Scopes::GUEST,
            Role::None => Scopes::PUBLIC_PARTICIPANT,
        }
    }

    /// The preset these scopes match, or `None` once they've been adjusted away from all four.
    pub fn preset(self) -> Option<Preset> {
        Preset::ALL.into_iter().find(|p| p.scopes() == self)
    }

    /// The most these two together allow, scope by scope. Used where someone without room authority brings a participant
    /// back, so they can't undo what the room narrowed.
    pub fn narrower(self, other: Scopes) -> Scopes {
        let sees_all = self.tasks.sees_all() && other.tasks.sees_all();
        let creates = self.tasks.can_create() && other.tasks.can_create();
        Scopes {
            tasks: match (sees_all, creates) {
                (true, true) if self.tasks == other.tasks => self.tasks,
                (true, true) => TaskScope::AllCreate,
                (true, false) => TaskScope::All,
                (false, true) => TaskScope::OwnCreate,
                (false, false) => TaskScope::Own,
            },
            artifacts: match (self.artifacts, other.artifacts) {
                (ArtifactScope::All, ArtifactScope::All) => ArtifactScope::All,
                (ArtifactScope::Shared, _) | (_, ArtifactScope::Shared) => ArtifactScope::Shared,
                _ => ArtifactScope::Own,
            },
            conversations: if self.conversations == ConversationScope::All
                && other.conversations == ConversationScope::All
            {
                ConversationScope::All
            } else {
                ConversationScope::Own
            },
            review: if self.review == ReviewScope::WhenNamed
                && other.review == ReviewScope::WhenNamed
            {
                ReviewScope::WhenNamed
            } else {
                ReviewScope::None
            },
        }
    }

    /// Whether these scopes let someone review: they must be able to read the work on tasks they're named on.
    pub fn reviews(self) -> bool {
        self.review == ReviewScope::WhenNamed && self.artifacts != ArtifactScope::Shared
    }

    /// Whether these scopes can be granted. Reviewing work you can't read isn't a review, so that pair is refused.
    pub fn is_grantable(self) -> bool {
        self.review == ReviewScope::None || self.reviews()
    }

    /// What an organization's admin sees when overseeing its agent: never more than the agent sees, and only its own tasks.
    pub fn for_oversight(self) -> Scopes {
        Scopes {
            tasks: TaskScope::Own,
            artifacts: match self.artifacts {
                ArtifactScope::Shared => ArtifactScope::Shared,
                ArtifactScope::Own | ArtifactScope::All => ArtifactScope::Own,
            },
            conversations: ConversationScope::Own,
            review: ReviewScope::None,
        }
    }
}

impl TaskScope {
    pub const ALL: [TaskScope; 5] = [
        TaskScope::Own,
        TaskScope::OwnCreate,
        TaskScope::All,
        TaskScope::AllCreate,
        TaskScope::Coordinate,
    ];

    pub fn name(self) -> &'static str {
        match self {
            TaskScope::Own => "own",
            TaskScope::OwnCreate => "own_create",
            TaskScope::All => "all",
            TaskScope::AllCreate => "all_create",
            TaskScope::Coordinate => "coordinate",
        }
    }

    pub fn from_name(name: &str) -> Option<TaskScope> {
        TaskScope::ALL.into_iter().find(|s| s.name() == name)
    }

    pub fn sees_all(self) -> bool {
        !matches!(self, TaskScope::Own | TaskScope::OwnCreate)
    }

    pub fn can_create(self) -> bool {
        !matches!(self, TaskScope::Own | TaskScope::All)
    }
}

impl ArtifactScope {
    pub const ALL: [ArtifactScope; 3] = [
        ArtifactScope::Shared,
        ArtifactScope::Own,
        ArtifactScope::All,
    ];

    pub fn name(self) -> &'static str {
        match self {
            ArtifactScope::Shared => "shared",
            ArtifactScope::Own => "own",
            ArtifactScope::All => "all",
        }
    }

    pub fn from_name(name: &str) -> Option<ArtifactScope> {
        ArtifactScope::ALL.into_iter().find(|s| s.name() == name)
    }
}

impl ConversationScope {
    pub const ALL: [ConversationScope; 2] = [ConversationScope::Own, ConversationScope::All];

    pub fn name(self) -> &'static str {
        match self {
            ConversationScope::Own => "own",
            ConversationScope::All => "all",
        }
    }

    pub fn from_name(name: &str) -> Option<ConversationScope> {
        ConversationScope::ALL
            .into_iter()
            .find(|s| s.name() == name)
    }
}

impl ReviewScope {
    pub const ALL: [ReviewScope; 2] = [ReviewScope::None, ReviewScope::WhenNamed];

    pub fn name(self) -> &'static str {
        match self {
            ReviewScope::None => "none",
            ReviewScope::WhenNamed => "when_named",
        }
    }

    pub fn from_name(name: &str) -> Option<ReviewScope> {
        ReviewScope::ALL.into_iter().find(|s| s.name() == name)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkroomAction {
    CreateTask,
    AppointAdmin,
    ManageAccess,
    ReadAuditLog,
    /// Renaming or archiving a room.
    ManageRoom,
    /// Naming a new owner, from the current one.
    TransferOwner,
    /// Adding or removing a planned line between work roles. No agent yet, the lead included (decision 45).
    PlanRelationship,
    /// The room's planning start date and timezone (decision 70).
    SetPlanStart,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskAction {
    Read,
    PostMessage,
    Update,
    SetReviewer,
    SetRequester,
    Assign,
    Accept,
    Decline,
    Release,
    Submit,
    RequestChanges,
    Verify,
    Cancel,
    /// A task's duration and predecessors.
    SetPlan,
}

impl TaskAction {
    pub const ALL: [TaskAction; 14] = [
        TaskAction::Read,
        TaskAction::PostMessage,
        TaskAction::Update,
        TaskAction::SetReviewer,
        TaskAction::SetRequester,
        TaskAction::Assign,
        TaskAction::Accept,
        TaskAction::Decline,
        TaskAction::Release,
        TaskAction::Submit,
        TaskAction::RequestChanges,
        TaskAction::Verify,
        TaskAction::Cancel,
        TaskAction::SetPlan,
    ];
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    /// `not_allowed`: the caller can see the task but may not do this.
    Forbidden,
    /// `task_not_found`: the caller may not know the task exists.
    Hidden,
    /// `not_a_participant`
    NotParticipant,
}

/// A stable name for a change someone tried, from a route's method and segments after the room. It's built only from
/// this fixed list, so nothing the caller wrote ends up in a record. `None` is a route that isn't a change.
pub fn denied_change_name(method: &str, route: &[&str]) -> Option<&'static str> {
    Some(match (method, route) {
        ("POST", ["tasks"]) => "task.create",
        ("POST", ["tasks", _, "messages"]) => "task.message",
        ("POST", ["tasks", _, "accept"]) => "task.accept",
        ("POST", ["tasks", _, "decline"]) => "task.decline",
        ("POST", ["tasks", _, "release"]) => "task.release",
        ("POST", ["tasks", _, "submit"]) => "task.submit",
        ("POST", ["tasks", _, "request-changes"]) => "task.request_changes",
        ("POST", ["tasks", _, "verify"]) => "task.verify",
        ("POST", ["tasks", _, "cancel"]) => "task.cancel",
        ("POST", ["tasks", _, "merge"]) => "task.merge",
        ("POST", ["tasks", _, "repo-access"]) => "task.repo_access",
        ("POST", ["tasks", _, "assign"]) => "task.assign",
        ("POST", ["tasks", _, "update"]) => "task.update",
        ("POST", ["tasks", _, "set-reviewer"]) => "task.set_reviewer",
        ("POST", ["tasks", _, "set-requester"]) => "task.set_requester",
        ("PUT", ["tasks", _, "plan"]) => "task.set_plan",
        ("PUT", ["tasks", _, "expected-output"]) => "task.set_output",
        ("POST", ["outputs"]) => "output.define",
        ("PUT", ["outputs", _]) => "output.update",
        ("DELETE", ["outputs", _]) => "output.remove",
        ("PUT", ["plan", "start"]) => "room.set_plan_start",
        ("POST", ["uploads"]) => "upload.create",
        ("POST", ["members"]) => "member.add",
        ("POST", ["members", _, "role"]) => "member.change_role",
        ("POST", ["members", _, "clear-removal"]) => "member.clear_removal",
        ("POST", ["members", _, "withdraw"]) => "member.withdraw",
        ("POST", ["members", _, "owner-consent"]) => "member.owner_consent",
        ("DELETE", ["members", _]) => "member.revoke",
        ("DELETE", ["organizations", _]) => "organization.revoke",
        ("POST", ["invitations"]) => "invitation.create",
        ("DELETE", ["invitations", _]) => "invitation.withdraw",
        ("PUT", ["members", _, "access"]) => "member.change_access",
        ("POST", ["roles"]) => "role.create",
        ("PUT", ["roles", _]) => "role.update",
        ("DELETE", ["roles", _]) => "role.close",
        ("POST", ["roles", _, "invites"]) => "role.invite",
        ("DELETE", ["roles", _, "invites", _]) => "role.withdraw_invite",
        ("POST", ["roles", _, "claim"]) => "role.claim",
        ("POST", ["roles", _, "release"]) => "role.release",
        ("DELETE", ["roles", _, "claims", _]) => "role.end_claim",
        ("POST", ["collaboration", "planned"]) => "relationship.plan",
        ("DELETE", ["collaboration", "planned", _]) => "relationship.remove",
        ("PUT", ["name"]) => "room.rename",
        ("PUT", ["brief"]) => "room.change_brief",
        ("PUT", ["review-policy"]) => "room.change_review_policy",
        ("PUT", ["visibility"]) => "room.set_visibility",
        ("PUT", ["topic"]) => "room.set_topic",
        ("PUT", ["public-claims"]) => "room.pause_public_claims",
        ("PUT" | "DELETE", ["public-claims", "blocked-orgs", _]) => "room.block_public_claims",
        ("POST", ["archive"]) => "room.archive",
        ("POST", ["unarchive"]) => "room.unarchive",
        ("POST", ["owner", "transfer"]) => "owner.transfer",
        ("POST", ["owner", "recover"]) => "owner.recover",
        _ => return None,
    })
}

/// Whether a refusal means someone lacked the authority for this change. A malformed request or a stale form doesn't,
/// and neither does naming someone outside the organization, because that caller has the authority and the request is
/// wrong. An agent's owner routes answer `not_found` to someone in the room with no authority over the agent.
pub fn is_authority_refusal(action: &str, code: &str) -> bool {
    match code {
        "not_allowed"
        | "access_revoked"
        | "agent_disconnected"
        | "workspace_not_found"
        | "task_not_found"
        | "self_sign_off"
        | "invitation_required"
        | "invitation_not_found" => true,
        "not_found" => matches!(action, "member.withdraw" | "member.owner_consent"),
        _ => false,
    }
}

/// Whether leaving an organization at `left_at` ends something in a room: a role or invitation in that organization
/// that began by then. Anything later belongs to a newer membership, so a delayed retry can't undo a rejoin.
pub fn org_departure_ends(held_org: &str, departed_org: &str, began_at: i64, left_at: i64) -> bool {
    held_org == departed_org && began_at <= left_at
}

/// Whether the recorded owner holds owner authority now. They don't once the room records that they left, or if their
/// current membership began after the one they became owner under, because rejoining doesn't restore it. A delayed
/// departure therefore doesn't matter. An assertion with no start time for the room's organization has nothing to
/// compare, as with a member's role. A room with no recorded start refuses.
pub fn owner_authority_holds(
    owner_left_at: Option<i64>,
    owner_since: Option<i64>,
    current_membership: Option<i64>,
) -> bool {
    owner_left_at.is_none()
        && current_membership.is_none_or(|began| owner_since.is_some_and(|since| began <= since))
}

/// Who can run ownership recovery: a person who administers the room's organization, with or without a place in the room.
pub fn may_recover_ownership(kind: PrincipalKind, administers_room_org: bool) -> bool {
    kind == PrincipalKind::Person && administers_room_org
}

/// Admin authority is for people only, even if a stored role says otherwise.
fn is_human_admin(caller: &Caller) -> bool {
    caller.kind == PrincipalKind::Person && matches!(caller.role, Role::Owner | Role::Admin)
}

/// What someone can actually do. Only `crates/policy` applies this, so a stored row can't give an agent admin authority
/// or take anything from a human admin. An agent stored with an admin role counts as a plain guest.
pub fn effective_scopes(kind: PrincipalKind, role: Role, stored: Scopes) -> Scopes {
    match (role, kind) {
        (Role::Owner | Role::Admin, PrincipalKind::Person) => Scopes::COORDINATOR,
        (Role::Owner | Role::Admin, PrincipalKind::Agent) => Scopes::GUEST,
        (Role::Member | Role::Guest, _) => stored,
        (Role::None, _) => Scopes::PUBLIC_PARTICIPANT,
    }
}

impl Caller {
    pub fn effective_scopes(&self) -> Scopes {
        effective_scopes(self.kind, self.role, self.scopes)
    }
}

pub fn authorize_workroom(caller: &Caller, action: WorkroomAction) -> Verdict {
    if caller.role == Role::None {
        return Verdict::NotParticipant;
    }
    let allowed = match action {
        WorkroomAction::CreateTask => caller.effective_scopes().tasks.can_create(),
        WorkroomAction::AppointAdmin | WorkroomAction::TransferOwner => {
            caller.kind == PrincipalKind::Person && caller.role == Role::Owner
        }
        WorkroomAction::ManageAccess
        | WorkroomAction::ReadAuditLog
        | WorkroomAction::ManageRoom
        | WorkroomAction::PlanRelationship
        | WorkroomAction::SetPlanStart => is_human_admin(caller),
    };
    if allowed {
        Verdict::Allow
    } else {
        Verdict::Forbidden
    }
}

fn is_party(caller: &Caller, task: &Task) -> bool {
    caller.id == task.requester
        || caller.id == task.reviewer
        || task.assignee.as_deref() == Some(caller.id.as_str())
}

/// Who can see a task: those whose scope covers all tasks, and otherwise only its parties.
pub fn can_see_task(caller: &Caller, task: &Task) -> bool {
    caller.role != Role::None
        && (caller.effective_scopes().tasks.sees_all() || is_party(caller, task))
}

/// Whether the caller sees the whole room's tasks and participants, or only their own.
pub fn sees_whole_room(caller: &Caller) -> bool {
    caller.role != Role::None && caller.effective_scopes().tasks.sees_all()
}

/// Whether the caller sees the room's planned lines. Anyone in the room can already read every open role's title, and a
/// line adds only what was published as a plan. Who wrote one is another matter: see `sees_who_planned`.
pub fn sees_planned_relationships(caller: &Caller) -> bool {
    caller.role != Role::None
}

/// Whether a plan read is complete for this caller. Anyone else gets only their own tasks and the edges between those, with
/// nothing that moves with the rest of the room's plan.
pub fn sees_whole_plan(caller: &Caller) -> bool {
    sees_whole_room(caller)
}

/// Whether the caller gets a forecast, and the start date it runs from. Someone who can't see the whole plan could otherwise learn
/// a hidden task's existence or length from a finish date, and a guest gets none even if their access was widened. Everyone else
/// is told the same thing, whatever the room holds.
pub fn sees_plan_forecast(caller: &Caller) -> bool {
    sees_whole_plan(caller) && caller.role != Role::Guest
}

/// Whether the caller sees who set a planned line. It can name someone who isn't otherwise visible to a viewer limited to
/// their own tasks.
pub fn sees_who_planned(caller: &Caller) -> bool {
    sees_whole_room(caller)
}

/// Whether the caller reads every thread, so a message count on someone else's task tells them nothing new.
pub fn reads_every_thread(caller: &Caller) -> bool {
    caller.role != Role::None && caller.effective_scopes().conversations == ConversationScope::All
}

/// How much of a submission's work the caller can read on a task they can see.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArtifactView {
    /// Only what the caller submitted.
    OwnSubmissions,
    All,
}

/// What the caller can read on a task, beyond the task itself. Call this only for a task they may read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TaskView {
    pub artifacts: ArtifactView,
    /// The thread, and the reasons people gave in the task's history.
    pub conversation: bool,
}

pub fn task_view(caller: &Caller, task: &Task) -> TaskView {
    let scopes = caller.effective_scopes();
    let party = is_party(caller, task);
    TaskView {
        artifacts: match scopes.artifacts {
            ArtifactScope::All => ArtifactView::All,
            ArtifactScope::Own if party => ArtifactView::All,
            ArtifactScope::Own | ArtifactScope::Shared => ArtifactView::OwnSubmissions,
        },
        conversation: scopes.conversations == ConversationScope::All || party,
    }
}

pub fn authorize_task(caller: &Caller, task: &Task, action: TaskAction) -> Verdict {
    if caller.role == Role::None {
        return Verdict::NotParticipant;
    }
    if !can_see_task(caller, task) {
        return Verdict::Hidden;
    }
    let is_requester = caller.id == task.requester;
    let is_assignee = task.assignee.as_deref() == Some(caller.id.as_str());
    let is_reviewer = caller.id == task.reviewer;
    let admin = is_human_admin(caller);
    let allowed = match action {
        TaskAction::Read => true,
        TaskAction::PostMessage => task_view(caller, task).conversation,
        TaskAction::Update | TaskAction::Assign | TaskAction::SetReviewer | TaskAction::Cancel => {
            is_requester || admin
        }
        TaskAction::SetRequester => admin,
        // Refusing a loop could reveal a hidden link, so this needs the whole room as well as authority over the task.
        TaskAction::SetPlan => (is_requester || admin) && sees_whole_room(caller),
        TaskAction::Accept | TaskAction::Decline | TaskAction::Release | TaskAction::Submit => {
            is_assignee
        }
        TaskAction::RequestChanges | TaskAction::Verify => {
            is_reviewer && !is_assignee && caller.effective_scopes().reviews()
        }
    };
    if allowed {
        Verdict::Allow
    } else {
        Verdict::Forbidden
    }
}

/// Who can change a task's requester: an owner or admin, or someone with the Coordinator's scope taking over for itself a
/// task whose requester left. The flag can outlast someone coming back, so `requester_is_here` says who's in the room now.
pub fn authorize_requester_change(
    caller: &Caller,
    task: &Task,
    requester: &str,
    requester_is_here: bool,
) -> Verdict {
    match authorize_task(caller, task, TaskAction::SetRequester) {
        Verdict::Forbidden
            if caller.effective_scopes().tasks == TaskScope::Coordinate
                && task.needs_requester
                && !requester_is_here
                && requester == caller.id =>
        {
            Verdict::Allow
        }
        verdict => verdict,
    }
}

/// Only agents claim role openings, unless the owner rules otherwise.
pub fn may_claim_role(kind: PrincipalKind) -> bool {
    kind == PrincipalKind::Agent
}

/// What someone keeps when a claim ends: what they had if nobody touched their grant meanwhile, and otherwise the narrower
/// of the two. `untouched` must come from the grant's version, not its values, because a room can lock someone at the same
/// values they already hold. Ending a claim never undoes a room's decision.
pub fn scopes_after_claim(prior: Scopes, current: Scopes, untouched: bool) -> Scopes {
    if untouched {
        prior
    } else {
        prior.narrower(current)
    }
}

/// Extra checks when a requester changes the reviewer of a submitted task: only an owner or admin may.
pub fn authorize_reviewer_change(caller: &Caller, task: &Task) -> Verdict {
    match authorize_task(caller, task, TaskAction::SetReviewer) {
        Verdict::Allow
            if task.status == podster_core::TaskStatus::Submitted && !is_human_admin(caller) =>
        {
            Verdict::Forbidden
        }
        verdict => verdict,
    }
}

/// Where a room requires a person to review (decision 5), an agent can't approve or send back work, even if it was named
/// before the setting changed.
pub fn may_decide_review(kind: PrincipalKind, room_requires_person: bool) -> bool {
    !room_requires_person || kind == PrincipalKind::Person
}

/// Room events anyone in the room can see, whatever their scope: what they can already read in the room's brief and
/// openings. Everything else about the room, such as who joined or left, follows what they can see of its participants.
pub const EVENTS_FOR_EVERYONE: [&str; 14] = [
    "workspace.created",
    "workspace.archived",
    "workspace.unarchived",
    "workspace.brief_changed",
    "workspace.review_policy_changed",
    // Everyone in a room should know when what it says becomes public, or stops being (ADR 0008). IDs only.
    "room.published",
    "room.unpublished",
    "workspace.topic_changed",
    "role.created",
    "role.updated",
    "role.closed",
    // Every participant sees expected outputs (decision 54), and these carry only the output's ID.
    "output.defined",
    "output.updated",
    "output.removed",
];

/// A task's event only someone who sees the whole room gets. A plan edit can be about a task they can't see, so a party to the
/// successor would otherwise learn a hidden edge had changed.
pub const TASK_PLAN_CHANGED: &str = "task.plan_changed";

/// Room events an agent limited to its own tasks sees when they're about it, as its inbox already tells it. Only these, and
/// only about itself: someone else's would show who else is in the room.
pub const NOTICES_ABOUT_SUBJECT: [&str; 3] = ["member.added", "role.invited", "role.claim_ended"];

/// Whether this caller gets those notices. The ruling is about agents, so a limited person doesn't, for now.
pub fn sees_notices_about_itself(caller: &Caller) -> bool {
    caller.kind == PrincipalKind::Agent
}

/// Whether someone can see one event in a room's activity. A task's events follow the task, as it stands now, apart from
/// plan edits. A room's own events follow the member list, apart from the ones above, notices to an agent about itself and
/// what the viewer did themselves. `subject` is who the event says it's about, and old events have none. Denies by default.
pub fn can_see_event(
    caller: &Caller,
    kind: &str,
    actor: &str,
    task: Option<&Task>,
    subject: Option<&str>,
) -> bool {
    if caller.role == Role::None {
        return false;
    }
    match task {
        Some(_) if kind == TASK_PLAN_CHANGED => sees_whole_room(caller),
        Some(task) => can_see_task(caller, task),
        None => {
            is_human_admin(caller)
                || sees_whole_room(caller)
                || actor == caller.id
                || EVENTS_FOR_EVERYONE.contains(&kind)
                || (sees_notices_about_itself(caller)
                    && NOTICES_ABOUT_SUBJECT.contains(&kind)
                    && subject == Some(caller.id.as_str()))
        }
    }
}

/// Whether a principal can be a task's reviewer: a current participant whose scope allows it, and a person if the room
/// requires one.
pub fn can_review(
    kind: PrincipalKind,
    role: Role,
    stored: Scopes,
    room_requires_person: bool,
) -> bool {
    role != Role::None
        && effective_scopes(kind, role, stored).reviews()
        && (!room_requires_person || kind == PrincipalKind::Person)
}

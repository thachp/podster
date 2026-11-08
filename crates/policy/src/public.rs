//! The public read surface and public claims: M4 step 2. No I/O. Denies by default.
//!
//! [ADR 0008](../../../docs/adr/0008-public-read-surface.md) and decisions 146 to 171. Nothing here is wired to a route yet.
//!
//! - **What's public** is [`PublicWorkroomView`], built field by field from the room's rows. Nothing is serialized from a
//!   row, and the JSON is written by hand from the view, so a field reaches the public surface only by being added here,
//!   to the golden test in `tests/public.rs`, and to the contract. The rows passed in may carry everything the room holds;
//!   only the fields in decision 146's table come out.
//! - **Who decides** is the room, from current state: [`room_page`] answers `None`, which a route turns into the same
//!   not-found as a missing room, unless the room is public now under this exact handle.
//! - **The public caller** is its own type, [`PublicCaller`], not a sentinel [`Caller`]. Only [`room_page`] takes it, through
//!   [`RoomPageReader`]. Explore needs sign-in (decision 155), so [`explore_entry`] takes only a [`SignedInReader`].
//! - **Publishing** names the hash of the exact content the owner previewed ([`content_hash`]), and is refused if the room's
//!   current content hashes differently.
//!
//! Every public field is written by the room's owner or admins. It's still text for reading, never instructions.

use podster_core::PrincipalId;
use sha2::{Digest, Sha256};

use crate::{is_human_admin, Caller, Preset, PrincipalKind, Role, Verdict};

/// `pub_` and 128 random bits as 32 lowercase hex digits. Made each time a room goes public, never reused.
pub const PUBLIC_HANDLE_PREFIX: &str = "pub_";
const PUBLIC_HANDLE_HEX: usize = 32;

/// Whether `s` is exactly a public handle: the prefix and 32 lowercase hex digits. Nothing is trimmed or lowercased, so a
/// route answers not-found for anything else, including a `workspace_id`, before any lookup.
pub fn is_public_handle(s: &str) -> bool {
    s.strip_prefix(PUBLIC_HANDLE_PREFIX).is_some_and(|hex| {
        hex.len() == PUBLIC_HANDLE_HEX
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

// ---------------------------------------------------------------------------------------------------------------------
// Callers

/// A read with nobody signed in. It names no one, so there's nothing in it to authorize, and no function that takes a
/// [`Caller`] can be handed one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicCaller {
    _private: (),
}

impl PublicCaller {
    /// For the API's public route only, from the gateway's `kind: "public"` assertion, which carries no subject.
    pub fn from_public_assertion() -> PublicCaller {
        PublicCaller { _private: () }
    }
}

/// A signed-in person or agent reading the public surface. Who they are doesn't change what they see.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedInReader {
    pub id: PrincipalId,
    pub kind: PrincipalKind,
}

/// Who may read a room's public page: anyone, signed in or not.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RoomPageReader {
    Public(PublicCaller),
    SignedIn(SignedInReader),
}

// ---------------------------------------------------------------------------------------------------------------------
// The room's rows, as passed in

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Visibility {
    Private,
    Public,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Workflow {
    General,
    Engineering,
}

impl Workflow {
    pub fn name(self) -> &'static str {
        match self {
            Workflow::General => "general",
            Workflow::Engineering => "engineering",
        }
    }
}

/// A public room's topic, from a fixed list so search can't be stuffed (decision 146). **Proposed** list: the kinds of
/// work PRODUCT.md names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Topic {
    Engineering,
    Research,
    Business,
    Marketing,
    Film,
    Other,
}

impl Topic {
    pub const ALL: [Topic; 6] = [
        Topic::Engineering,
        Topic::Research,
        Topic::Business,
        Topic::Marketing,
        Topic::Film,
        Topic::Other,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Topic::Engineering => "engineering",
            Topic::Research => "research",
            Topic::Business => "business",
            Topic::Marketing => "marketing",
            Topic::Film => "film",
            Topic::Other => "other",
        }
    }

    pub fn from_name(name: &str) -> Option<Topic> {
        Topic::ALL.into_iter().find(|t| t.name() == name)
    }
}

/// The room's own row. Most of it is never public; it's here so a test can show that.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoomRow {
    pub workspace_id: String,
    pub name: String,
    pub goal: Option<String>,
    pub context: Option<String>,
    pub brief_by: Option<PrincipalId>,
    pub owner_org_id: String,
    pub owner_person_id: PrincipalId,
    pub policy_version: u64,
    pub created_at: i64,
    pub archived: bool,
    pub workflow: Workflow,
    pub topic: Option<Topic>,
    pub require_person_review: bool,
    pub visibility: Visibility,
    pub public_handle: Option<String>,
    /// When the room last went public, in seconds. Only the day is shown.
    pub published_at: Option<i64>,
    /// Set by a Podster operator. A suspended room answers not-found publicly and can't be published.
    pub suspended: bool,
    pub public_claims_paused: bool,
}

/// One work role opening, closed ones included.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpeningRow {
    pub id: String,
    pub title: String,
    pub responsibilities: String,
    pub capacity: u32,
    pub preset: Preset,
    pub is_lead: bool,
    pub publicly_claimable: bool,
    pub created_by: PrincipalId,
    pub created_at: i64,
    pub version: u64,
    pub closed_at: Option<i64>,
    /// Who holds it now. Only the count is public.
    pub active_holders: Vec<PrincipalId>,
}

/// One expected output, removed ones included (decision 136 keeps their rows).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputRow {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub ready: bool,
    pub created_by: PrincipalId,
    pub removed_at: Option<i64>,
    /// The task whose approved submission is the current version. Never public.
    pub current_task_id: Option<String>,
    pub current_submission_no: Option<u32>,
}

/// One participant row. Only the count of current ones is public.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemberRow {
    pub principal_id: PrincipalId,
    pub kind: PrincipalKind,
    pub org_id: String,
    pub revoked_at: Option<i64>,
}

/// Everything the room passes in to answer a public read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoomState {
    pub room: RoomRow,
    pub openings: Vec<OpeningRow>,
    pub outputs: Vec<OutputRow>,
    pub members: Vec<MemberRow>,
}

// ---------------------------------------------------------------------------------------------------------------------
// The view

/// The whole public view of a room: decision 146's table, and nothing else.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicWorkroomView {
    pub handle: String,
    /// The day the room last went public, `YYYY-MM-DD` in UTC.
    pub published_on: String,
    pub content: PublicContent,
}

/// What the owner previews and publishing hashes. The handle and the day are made at publish, so they aren't in it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicContent {
    pub name: String,
    pub goal: Option<String>,
    pub context: Option<String>,
    pub topic: Option<Topic>,
    pub workflow: Workflow,
    pub openings: Vec<PublicOpening>,
    pub outputs: Vec<PublicOutput>,
    pub participant_count: u32,
    pub person_review: bool,
    pub archived: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicOpening {
    /// Only for an opening that can be claimed publicly now, because a claim needs it.
    pub id: Option<String>,
    pub title: String,
    pub responsibilities: String,
    pub capacity: u32,
    pub filled: u32,
    pub preset: Preset,
    pub lead: bool,
    pub publicly_claimable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicOutput {
    pub title: String,
    pub description: Option<String>,
    pub ready: bool,
}

/// Whether an opening's setting can take effect: never the lead (decision 153), and only the Public participant or Guest
/// preset (decision 154).
pub fn opening_publicly_claimable(opening: &OpeningRow) -> bool {
    opening.publicly_claimable
        && !opening.is_lead
        && opening.closed_at.is_none()
        && matches!(opening.preset, Preset::PublicParticipant | Preset::Guest)
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// The public content of a room, field by field, as if it were public. The preview and the served page both come from
/// here, so they can't drift. Closed openings and removed outputs are left out.
pub fn public_content(state: &RoomState) -> PublicContent {
    let room = &state.room;
    let takes_claims = !room.archived;
    PublicContent {
        name: room.name.clone(),
        goal: room.goal.clone(),
        context: room.context.clone(),
        topic: room.topic,
        workflow: room.workflow,
        openings: state
            .openings
            .iter()
            .filter(|o| o.closed_at.is_none())
            .map(|o| {
                let claimable = opening_publicly_claimable(o);
                PublicOpening {
                    id: (claimable && takes_claims).then(|| o.id.clone()),
                    title: o.title.clone(),
                    responsibilities: o.responsibilities.clone(),
                    capacity: o.capacity,
                    filled: count(o.active_holders.len()),
                    preset: o.preset,
                    lead: o.is_lead,
                    publicly_claimable: claimable,
                }
            })
            .collect(),
        outputs: state
            .outputs
            .iter()
            .filter(|o| o.removed_at.is_none())
            .map(|o| PublicOutput {
                title: o.title.clone(),
                description: o.description.clone(),
                ready: o.ready,
            })
            .collect(),
        participant_count: count(
            state
                .members
                .iter()
                .filter(|m| m.revoked_at.is_none())
                .count(),
        ),
        person_review: room.require_person_review,
        archived: room.archived,
    }
}

/// The room's public view under `handle`, or `None` for the same not-found as a missing room. It's public only if the
/// feature is on, the room is public under exactly this handle with a publish time, and no operator suspended it. Who's
/// reading doesn't change the answer, so a cached copy suits everyone.
pub fn room_page(
    _reader: &RoomPageReader,
    public_rooms_enabled: bool,
    state: &RoomState,
    handle: &str,
) -> Option<PublicWorkroomView> {
    let room = &state.room;
    let current = room.public_handle.as_deref()?;
    if !public_rooms_enabled
        || room.visibility != Visibility::Public
        || room.suspended
        || !is_public_handle(handle)
        || current != handle
    {
        return None;
    }
    let published_on = utc_day(room.published_at?);
    Some(PublicWorkroomView {
        handle: current.to_owned(),
        published_on,
        content: public_content(state),
    })
}

/// One Explore result, confirmed with its room. The index only offers candidates: anything this doesn't confirm is
/// dropped, and every field comes from the room now.
pub fn explore_entry(
    _reader: &SignedInReader,
    public_rooms_enabled: bool,
    state: &RoomState,
    handle: &str,
) -> Option<PublicWorkroomView> {
    let reader = RoomPageReader::Public(PublicCaller::from_public_assertion());
    room_page(&reader, public_rooms_enabled, state, handle)
}

// ---------------------------------------------------------------------------------------------------------------------
// Canonical JSON and the hash

impl PublicWorkroomView {
    /// The view's JSON: keys sorted, no whitespace, strings escaped as RFC 8785 does, integers only.
    pub fn to_json(&self) -> String {
        let mut out = String::new();
        out.push('{');
        out.push_str("\"content\":");
        self.content.write_json(&mut out);
        out.push_str(",\"handle\":");
        write_str(&mut out, &self.handle);
        out.push_str(",\"published_on\":");
        write_str(&mut out, &self.published_on);
        out.push('}');
        out
    }
}

impl PublicContent {
    pub fn to_json(&self) -> String {
        let mut out = String::new();
        self.write_json(&mut out);
        out
    }

    fn write_json(&self, out: &mut String) {
        out.push_str("{\"archived\":");
        write_bool(out, self.archived);
        out.push_str(",\"context\":");
        write_opt_str(out, self.context.as_deref());
        out.push_str(",\"goal\":");
        write_opt_str(out, self.goal.as_deref());
        out.push_str(",\"name\":");
        write_str(out, &self.name);
        out.push_str(",\"openings\":[");
        for (i, o) in self.openings.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            o.write_json(out);
        }
        out.push_str("],\"outputs\":[");
        for (i, o) in self.outputs.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            o.write_json(out);
        }
        out.push_str("],\"participant_count\":");
        out.push_str(&self.participant_count.to_string());
        out.push_str(",\"person_review\":");
        write_bool(out, self.person_review);
        out.push_str(",\"topic\":");
        write_opt_str(out, self.topic.map(Topic::name));
        out.push_str(",\"workflow\":");
        write_str(out, self.workflow.name());
        out.push('}');
    }
}

impl PublicOpening {
    fn write_json(&self, out: &mut String) {
        out.push_str("{\"capacity\":");
        out.push_str(&self.capacity.to_string());
        out.push_str(",\"filled\":");
        out.push_str(&self.filled.to_string());
        out.push_str(",\"id\":");
        write_opt_str(out, self.id.as_deref());
        out.push_str(",\"lead\":");
        write_bool(out, self.lead);
        out.push_str(",\"preset\":");
        write_str(out, self.preset.name());
        out.push_str(",\"publicly_claimable\":");
        write_bool(out, self.publicly_claimable);
        out.push_str(",\"responsibilities\":");
        write_str(out, &self.responsibilities);
        out.push_str(",\"title\":");
        write_str(out, &self.title);
        out.push('}');
    }
}

impl PublicOutput {
    fn write_json(&self, out: &mut String) {
        out.push_str("{\"description\":");
        write_opt_str(out, self.description.as_deref());
        out.push_str(",\"ready\":");
        write_bool(out, self.ready);
        out.push_str(",\"title\":");
        write_str(out, &self.title);
        out.push('}');
    }
}

fn write_bool(out: &mut String, b: bool) {
    out.push_str(if b { "true" } else { "false" });
}

fn write_opt_str(out: &mut String, s: Option<&str>) {
    match s {
        Some(s) => write_str(out, s),
        None => out.push_str("null"),
    }
}

fn write_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if u32::from(c) < 0x20 => out.push_str(&format!("\\u{:04x}", u32::from(c))),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// The SHA-256 of the content's canonical JSON, as 64 lowercase hex digits. Publishing names it.
pub fn content_hash(content: &PublicContent) -> String {
    Sha256::digest(content.to_json().as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `YYYY-MM-DD` in UTC for a time in seconds.
pub fn utc_day(at: i64) -> String {
    let (y, m, d) = civil_from_days(at.div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

// Howard Hinnant's days-to-civil, for the proleptic Gregorian calendar.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

// ---------------------------------------------------------------------------------------------------------------------
// Publishing and unpublishing

/// Who may change a room's visibility. Going public adds exposure, so only the human owner may (decision 148). Going
/// private only reduces it, so the owner or a human admin may, at any time (decision 149). An agent never may, whatever
/// role is stored.
pub fn authorize_set_visibility(caller: &Caller, to: Visibility) -> Verdict {
    if caller.role == Role::None {
        return Verdict::NotParticipant;
    }
    let allowed = match to {
        Visibility::Public => caller.kind == PrincipalKind::Person && caller.role == Role::Owner,
        Visibility::Private => is_human_admin(caller),
    };
    if allowed {
        Verdict::Allow
    } else {
        Verdict::Forbidden
    }
}

/// Why a publish was refused, once the caller may publish. No content or IDs, so it's safe to log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublishRefusal {
    /// `PUBLIC_ROOMS` is off.
    Disabled,
    Archived,
    /// An operator suspended the room's public surface, and only an operator can lift it.
    Suspended,
    /// What the owner previewed isn't what would be shown now.
    StalePreview,
}

impl PublishRefusal {
    pub fn code(self) -> &'static str {
        match self {
            PublishRefusal::Disabled => "not_allowed",
            PublishRefusal::Archived => "workspace_archived",
            PublishRefusal::Suspended => "room_suspended",
            PublishRefusal::StalePreview => "version_conflict",
        }
    }
}

/// What publishing does, once the caller may.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublishOutcome {
    /// Make a new handle, record the time, and go public.
    Publish,
    /// Already public: nothing changes, and the handle stays.
    AlreadyPublic,
}

/// Whether a publish naming `previewed_hash` goes ahead. The hash must equal the room's current content's, so anything
/// public that changed since the preview, from anyone, stops it.
pub fn decide_publish(
    public_rooms_enabled: bool,
    state: &RoomState,
    previewed_hash: &str,
) -> Result<PublishOutcome, PublishRefusal> {
    let room = &state.room;
    if !public_rooms_enabled {
        return Err(PublishRefusal::Disabled);
    }
    if room.archived {
        return Err(PublishRefusal::Archived);
    }
    if room.suspended {
        return Err(PublishRefusal::Suspended);
    }
    if content_hash(&public_content(state)) != previewed_hash {
        return Err(PublishRefusal::StalePreview);
    }
    if room.visibility == Visibility::Public && room.public_handle.is_some() {
        return Ok(PublishOutcome::AlreadyPublic);
    }
    Ok(PublishOutcome::Publish)
}

/// What unpublishing does: the handle is dropped for good whenever the room is public, and a private room is left as it
/// is. It's allowed while archived or suspended, since it only reduces exposure. `end_public_claims` is the owner's tick
/// in the confirmation (decision 151); otherwise public participants keep their access.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnpublishOutcome {
    Unpublish { end_public_claims: bool },
    AlreadyPrivate,
}

pub fn decide_unpublish(state: &RoomState, end_public_claims: bool) -> UnpublishOutcome {
    if state.room.visibility == Visibility::Public || state.room.public_handle.is_some() {
        UnpublishOutcome::Unpublish { end_public_claims }
    } else {
        UnpublishOutcome::AlreadyPrivate
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Public claims

/// The agent's standing in this room, from its member row if it has one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoomStanding {
    /// Never in the room, or left in a way that needs nothing more.
    Outside,
    /// In the room now. Its claims go through the room's own claim path.
    Member,
    /// The room removed it, and no owner or admin has cleared that.
    Removed,
    /// Its owner withdrew or disconnected it, and hasn't consented again since.
    AwaitingOwnerConsent,
}

/// What a public claim needs to know about the agent, from its `Principal` and the room.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PublicClaimant {
    pub kind: PrincipalKind,
    /// The agent's participation policy allows public claims. The default is invitations only (decision 2).
    pub allows_public_claims: bool,
    /// A Podster operator suspended this agent's public claims.
    pub public_claims_suspended: bool,
    pub standing: RoomStanding,
}

/// Why a public claim was refused before limits and capacity. No content or IDs, so it's safe to log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublicClaimRefusal {
    /// The room isn't public under this handle now, or the feature is off. The same answer as a missing room.
    RoomHidden,
    /// The opening doesn't exist here, is closed, isn't publicly claimable, is the lead, or has a preset a stranger can't
    /// get. All the same answer, since only claimable openings' IDs are public.
    OpeningHidden,
    Archived,
    Paused,
    /// Only agents claim openings.
    NotAnAgent,
    /// The agent's owner hasn't allowed public claims.
    PolicyRefuses,
    OperatorSuspended,
    AlreadyMember,
    Removed,
    AwaitingOwnerConsent,
    Full,
}

impl PublicClaimRefusal {
    pub fn code(self) -> &'static str {
        match self {
            PublicClaimRefusal::RoomHidden => "workspace_not_found",
            PublicClaimRefusal::OpeningHidden => "role_not_found",
            PublicClaimRefusal::Archived => "workspace_archived",
            PublicClaimRefusal::Paused => "public_claims_paused",
            PublicClaimRefusal::NotAnAgent => "not_allowed",
            PublicClaimRefusal::PolicyRefuses => "public_claims_not_allowed",
            PublicClaimRefusal::OperatorSuspended => "public_claims_suspended",
            PublicClaimRefusal::AlreadyMember => "already_member",
            PublicClaimRefusal::Removed | PublicClaimRefusal::AwaitingOwnerConsent => {
                "access_revoked"
            }
            PublicClaimRefusal::Full => "role_full",
        }
    }
}

/// Whether an agent may publicly claim `opening_id` in the room under `handle`, and with which preset. The room runs
/// this in the claim's own transaction, so a room that went private meanwhile refuses. Limits are
/// `podster_core::public_claims`, checked after this. The request never supplies scopes: the opening's preset is what's
/// granted, and it's only ever Public participant or Guest.
pub fn decide_public_claim(
    public_rooms_enabled: bool,
    state: &RoomState,
    handle: &str,
    opening_id: &str,
    claimant: PublicClaimant,
) -> Result<Preset, PublicClaimRefusal> {
    let room = &state.room;
    let reader = RoomPageReader::Public(PublicCaller::from_public_assertion());
    if room_page(&reader, public_rooms_enabled, state, handle).is_none() {
        return Err(PublicClaimRefusal::RoomHidden);
    }
    let opening = state
        .openings
        .iter()
        .find(|o| o.id == opening_id && opening_publicly_claimable(o))
        .ok_or(PublicClaimRefusal::OpeningHidden)?;
    if room.archived {
        return Err(PublicClaimRefusal::Archived);
    }
    if room.public_claims_paused {
        return Err(PublicClaimRefusal::Paused);
    }
    if claimant.kind != PrincipalKind::Agent {
        return Err(PublicClaimRefusal::NotAnAgent);
    }
    if claimant.public_claims_suspended {
        return Err(PublicClaimRefusal::OperatorSuspended);
    }
    if !claimant.allows_public_claims {
        return Err(PublicClaimRefusal::PolicyRefuses);
    }
    match claimant.standing {
        RoomStanding::Outside => {}
        RoomStanding::Member => return Err(PublicClaimRefusal::AlreadyMember),
        RoomStanding::Removed => return Err(PublicClaimRefusal::Removed),
        RoomStanding::AwaitingOwnerConsent => return Err(PublicClaimRefusal::AwaitingOwnerConsent),
    }
    if count(opening.active_holders.len()) >= opening.capacity {
        return Err(PublicClaimRefusal::Full);
    }
    Ok(opening.preset)
}

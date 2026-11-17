//! A room's app store (M6 stage 1; ADR 0010's revision, section 3.3; the architect's ruling on the store,
//! 2026-11-16). Pure: what a store's name and ID look like, what the room's record of its store allows, and what an
//! answer from the provider means. The API's client sends the calls and the room keeps the record; neither decides.
//!
//! **The store is D1** (the ruling, item 1). A room's record holds **a kind and an ID** (item 4), and the name
//! Podster gave the store when it asked for it, which is random and says nothing of the room or its app: a name is
//! looked up only to settle a create whose answer was lost.
//!
//! **Rule 3(a):** an app's script is bound to a store only from the room's own record of it, never from anything in a
//! release's files. [`binding`] is the one rule that turns a record into a binding, and it fails closed: a record that
//! isn't wholly well-formed binds nothing.
//!
//! **Every answer read here is strict.** A create counts only when the provider said, in so many words, that it made
//! exactly the database asked for. A store is gone only on a `404` whose one error is D1's own "not found" code, as the
//! store spike recorded it (`spikes/m6-store`, table 5). Anything else is [`StoreRead::Unknown`], which a caller retries
//! and never reads as either present or gone (review standard 3).

/// The kinds of store a room's record may hold. Stage 1 has one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StoreKind {
    D1,
}

impl StoreKind {
    pub fn as_str(self) -> &'static str {
        match self {
            StoreKind::D1 => "d1",
        }
    }

    /// The kind a record names, or `None` for anything else, a case twin included.
    pub fn parse(kind: &str) -> Option<StoreKind> {
        match kind {
            "d1" => Some(StoreKind::D1),
            _ => None,
        }
    }
}

/// Every kind, as the room's column holds it.
pub const STORE_KINDS: &[&str] = &["d1"];

/// What every store's name starts with. The rest is 32 lower-case hexadecimal digits Podster chose at random.
pub const STORE_NAME_PREFIX: &str = "podster-store-";
/// The part of a store's name after its prefix, in hexadecimal digits: the 128 bits the room drew, written out.
pub const STORE_NAME_SUFFIX_DIGITS: usize = 32;

/// D1's error code for a database that isn't there, as the store spike recorded it for a read and a second delete of
/// a deleted database (404, 7404).
pub const D1_NOT_FOUND: i64 = 7404;

/// **Proposed.** D1 databases asked for in one page of the list. The spike listed with this size.
pub const LIST_PAGE: usize = 100;
/// **Proposed.** Pages read for one list, at most. A longer list is no answer.
pub const MAX_LIST_PAGES: usize = 20;

fn lower_hex(value: &str) -> bool {
    value
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A store's name from the 128 bits the caller drew at random: `podster-store-` and those bits as 32 lower-case
/// hexadecimal digits, leading zeros kept. It is a name, not a secret: it only has to be unlikely to meet another, so
/// that a lost create can be found by it. Every value gives a name [`is_store_name`] accepts.
pub fn store_name(suffix: u128) -> String {
    format!("{STORE_NAME_PREFIX}{suffix:032x}")
}

/// Whether a name is one Podster gives a store. Anything else in the account is never Podster's store.
pub fn is_store_name(name: &str) -> bool {
    name.strip_prefix(STORE_NAME_PREFIX)
        .is_some_and(|suffix| suffix.len() == STORE_NAME_SUFFIX_DIGITS && lower_hex(suffix))
}

/// A D1 database's ID as the room keeps it: a UUID in lower case, `8-4-4-4-12`.
pub fn d1_id_form(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(at, b)| match at {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(b),
        })
}

/// Whether an ID has the form its kind's IDs have.
pub fn store_id_form(kind: StoreKind, id: &str) -> bool {
    match kind {
        StoreKind::D1 => d1_id_form(id),
    }
}

/// The room's record of its app's store, as read from its row. Every field is as the row holds it; nothing here is
/// trusted until [`binding`] has checked it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StoreRecord<'a> {
    pub kind: Option<&'a str>,
    pub name: Option<&'a str>,
    pub id: Option<&'a str>,
    pub made_at: Option<i64>,
    pub delete_owed_at: Option<i64>,
    pub gone_at: Option<i64>,
}

/// What a script may be bound to: the one store of its app, by kind and ID.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    pub kind: StoreKind,
    pub id: String,
}

/// Why a record binds nothing. Each is a code a log line may carry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoBinding {
    /// The room holds no record of a store for this app.
    NoStore,
    /// A store was asked for and isn't known to be made.
    NotMade,
    /// The store is owed a deletion, or is gone. Nothing new is bound to it.
    DeleteOwed,
    /// The record isn't of the form the room writes. Nothing is bound from it.
    Malformed,
}

impl NoBinding {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            NoBinding::NoStore => "store_none",
            NoBinding::NotMade => "store_not_made",
            NoBinding::DeleteOwed => "store_delete_owed",
            NoBinding::Malformed => "store_record_malformed",
        }
    }
}

/// **Rule 3(a).** The binding an app's script gets, from the room's own record and nothing else. `None` for the
/// record means the room holds no row for the app.
///
/// It binds only a record whose kind is known, whose name is a store's name, whose ID is of its kind's form and was
/// recorded made, and which is owed no deletion and isn't gone. A record that says it was made with no ID, or holds an
/// ID it never recorded made, is malformed and binds nothing.
pub fn binding(record: Option<&StoreRecord<'_>>) -> Result<Binding, NoBinding> {
    let record = record.ok_or(NoBinding::NoStore)?;
    let kind = record
        .kind
        .and_then(StoreKind::parse)
        .ok_or(NoBinding::Malformed)?;
    if !record.name.is_some_and(is_store_name) {
        return Err(NoBinding::Malformed);
    }
    if record.gone_at.is_some() && record.delete_owed_at.is_none() {
        return Err(NoBinding::Malformed);
    }
    if record.id.is_some() != record.made_at.is_some() {
        return Err(NoBinding::Malformed);
    }
    if record.id.is_some_and(|id| !store_id_form(kind, id)) {
        return Err(NoBinding::Malformed);
    }
    if record.delete_owed_at.is_some() {
        return Err(NoBinding::DeleteOwed);
    }
    let id = record.id.ok_or(NoBinding::NotMade)?;
    Ok(Binding {
        kind,
        id: id.to_owned(),
    })
}

/// The type Cloudflare's upload metadata names a D1 binding by, as the store spike bound one (`spikes/m6-store`).
pub const D1_BINDING_TYPE: &str = "d1";

/// **Rule 3(a), at the upload (S3 of the store plan).** What an app's script is bound to, given whether its release's
/// manifest asks for its store (`crate::app_code::CodeRelease::wants_store`) and the room's record of its label's
/// store. A release that asks for none is bound to nothing, whatever the record holds: a store kept from an earlier
/// release stays unbound (S2's question 3). A release that asks is bound exactly to what [`binding`] gives from the
/// record, or fails by that refusal's code: nothing in a release's files can name a store.
pub fn script_binding(
    wants_store: bool,
    record: Option<&StoreRecord<'_>>,
) -> Result<Option<Binding>, NoBinding> {
    if !wants_store {
        return Ok(None);
    }
    binding(record).map(Some)
}

/// The upload metadata's `bindings`, written out: `[]` for a script bound to nothing, and otherwise exactly one
/// binding, `{"type":"d1","name":"STORE","id":…}`, under the one fixed name every app's store has
/// (`crate::app_code::STORE_BINDING_NAME`). **Nothing else is ever a binding:** no outbound Worker (named on the
/// dispatch, not the script), no secret, variable, service or Durable Object. `None` when the binding's ID isn't of its
/// kind's form, so nothing that isn't an ID goes into the bytes.
pub fn bindings_json(binding: Option<&Binding>) -> Option<String> {
    let Some(binding) = binding else {
        return Some("[]".to_owned());
    };
    if !store_id_form(binding.kind, &binding.id) {
        return None;
    }
    let kind = match binding.kind {
        StoreKind::D1 => D1_BINDING_TYPE,
    };
    Some(format!(
        r#"[{{"type":"{kind}","name":"{}","id":"{}"}}]"#,
        crate::app_code::STORE_BINDING_NAME,
        binding.id
    ))
}

/// What the provider's envelope said, as the client read it from the body. `success` is `None` unless the field is a
/// boolean; `errors` is `None` unless the field is an array whose every entry has an integer `code`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Envelope {
    pub status: u16,
    pub success: Option<bool>,
    pub errors: Option<Vec<i64>>,
}

impl Envelope {
    fn succeeded(&self) -> bool {
        self.status == 200 && self.success == Some(true)
    }

    /// D1's own "not found", and nothing else: a `404`, `"success": false`, and exactly one error, [`D1_NOT_FOUND`].
    fn not_found(&self) -> bool {
        self.status == 404
            && self.success == Some(false)
            && self.errors.as_deref() == Some(&[D1_NOT_FOUND][..])
    }
}

/// A database as the provider described it: its `uuid` and `name`, each `None` unless a string.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Described<'a> {
    pub id: Option<&'a str>,
    pub name: Option<&'a str>,
}

/// The ID of the database a create made, when the provider said in so many words that it made exactly the one asked
/// for: `200`, `"success": true`, the name asked for and an ID of D1's form. `None` for anything else, which may or may
/// not have made it, and which only a list by name settles.
pub fn created(envelope: &Envelope, result: &Described<'_>, asked: &str) -> Option<String> {
    if !envelope.succeeded() || !is_store_name(asked) || result.name != Some(asked) {
        return None;
    }
    result.id.filter(|id| d1_id_form(id)).map(str::to_owned)
}

/// What a create's answer says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CreateAnswer {
    /// Made, exactly as [`created`] counts it: its ID.
    Made(String),
    /// Refused in so many words: nothing was made by this create. The release fails by [`STORE_CREATE_REFUSED`].
    Refused,
    /// Anything else, which may or may not have made it: only a list by name settles it.
    Unknown,
}

/// **Proposed, until the second account's repeat of the spike records D1's own answer to a create of a name it holds.**
/// The error codes read as "a database of this name exists". Only the stand-in's assumption, `7502`, is known. Such an
/// answer may be an earlier create of this very name that landed and that a list didn't show yet, so it is never a
/// refusal: the list settles it (the deep review of PR #416, item 4).
pub const D1_NAME_TAKEN: &[i64] = &[7502];

/// A create's answer, read strictly. Made only as [`created`] allows. **Refused** only on a `4xx` that says it failed
/// (`"success": false`) and why (at least one error code, none of them [`D1_NAME_TAKEN`]), and never on `408`, `409`
/// or `429`: a timeout or a limit may still be followed by the database, and a conflict or a name taken may be an
/// earlier create of this very name that landed, so each is settled by the list. Everything else is
/// [`CreateAnswer::Unknown`].
pub fn create_answer(envelope: &Envelope, result: &Described<'_>, asked: &str) -> CreateAnswer {
    if let Some(id) = created(envelope, result, asked) {
        return CreateAnswer::Made(id);
    }
    let refused = is_store_name(asked)
        && (400..500).contains(&envelope.status)
        && !matches!(envelope.status, 408 | 409 | 429)
        && envelope.success == Some(false)
        && envelope.errors.as_ref().is_some_and(|codes| {
            !codes.is_empty() && !codes.iter().any(|code| D1_NAME_TAKEN.contains(code))
        });
    if refused {
        CreateAnswer::Refused
    } else {
        CreateAnswer::Unknown
    }
}

/// What a read of one store found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StoreRead {
    /// The provider described exactly this database, by its ID and the name the room recorded.
    Present,
    /// The provider said, in so many words, that no database has this ID.
    Gone,
    /// Anything else. Never read as either.
    Unknown,
}

/// What a read by ID means. Present only on `200`, `"success": true` and a description naming this ID and the name
/// the room recorded; gone only on D1's own "not found"; anything else is unknown.
pub fn read(envelope: &Envelope, result: &Described<'_>, id: &str, name: &str) -> StoreRead {
    if !d1_id_form(id) || !is_store_name(name) {
        return StoreRead::Unknown;
    }
    if envelope.succeeded() && result.id == Some(id) && result.name == Some(name) {
        return StoreRead::Present;
    }
    if envelope.not_found() {
        return StoreRead::Gone;
    }
    StoreRead::Unknown
}

/// What one page of the list adds, as the client read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListPage<'a> {
    pub envelope: Envelope,
    /// Each entry, or `None` if `result` isn't an array.
    pub entries: Option<Vec<Described<'a>>>,
    /// `result_info.total_count`, or `None` unless a non-negative integer.
    pub total: Option<u64>,
}

/// Where a list stands after a page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ListStep {
    /// Read the next page.
    More,
    /// The list is whole: every database in the account, by ID and name.
    Done,
    /// No answer: the page wasn't of the expected shape, or the list changed while it was read, or it is longer than
    /// [`MAX_LIST_PAGES`] pages.
    Unknown,
}

/// The state of a list being read, page by page.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ListRead {
    pub found: Vec<(String, String)>,
    total: Option<u64>,
    pages: usize,
    /// Set once the list is whole or is no list. Nothing taken after that counts.
    ended: bool,
    /// Every ID and every name taken so far, so one seen twice is caught.
    ids: std::collections::BTreeSet<String>,
    names: std::collections::BTreeSet<String>,
}

impl ListRead {
    /// Takes one page. A page counts only on `200` with `"success": true`, `result` an array whose every entry has an ID
    /// of D1's form and a name, and a total that is the same on every page; the pages must add up to it exactly, each
    /// full but the last; and no ID or name may appear twice, on one page or across pages. The list is read by offset,
    /// so a delete and a create between two pages keep the total, repeat one entry and skip another: a repeat is the
    /// only sign of it. Anything else is [`ListStep::Unknown`], and the list read so far is no list: every page taken
    /// after an unknown one, or after the list was whole, is unknown too.
    pub fn take(&mut self, page: &ListPage<'_>) -> ListStep {
        if self.ended {
            return ListStep::Unknown;
        }
        let step = self.step(page);
        self.ended = step != ListStep::More;
        step
    }

    fn step(&mut self, page: &ListPage<'_>) -> ListStep {
        self.pages += 1;
        if !page.envelope.succeeded() {
            return ListStep::Unknown;
        }
        let Some(entries) = page.entries.as_ref() else {
            return ListStep::Unknown;
        };
        let Some(said) = page.total else {
            return ListStep::Unknown;
        };
        if self.total.is_some_and(|total| total != said) || entries.len() > LIST_PAGE {
            return ListStep::Unknown;
        }
        self.total = Some(said);
        let mut more = Vec::with_capacity(entries.len());
        for entry in entries {
            match (entry.id, entry.name) {
                (Some(id), Some(name)) if d1_id_form(id) => {
                    if !self.ids.insert(id.to_owned()) || !self.names.insert(name.to_owned()) {
                        return ListStep::Unknown;
                    }
                    more.push((id.to_owned(), name.to_owned()))
                }
                _ => return ListStep::Unknown,
            }
        }
        let left = said.saturating_sub(self.found.len() as u64);
        let got = more.len() as u64;
        // A page longer than what is left, or short of a full page before the end: the list changed, or isn't whole.
        if got > left || (more.len() < LIST_PAGE && got < left) {
            return ListStep::Unknown;
        }
        self.found.extend(more);
        if self.found.len() as u64 == said {
            return ListStep::Done;
        }
        if self.pages == MAX_LIST_PAGES {
            return ListStep::Unknown;
        }
        ListStep::More
    }
}

// --- Making a store (S2 of the store plan) ---------------------------------------------------------------------------
//
// The release job makes its app's store, for a release whose manifest asks for one, once its recheck holds and before
// its upload. The room records the name it drew and when it sent the create (`create_sent_at`) in its own transaction
// before it sends it, so **a create is outstanding from the moment it may have been sent,** and while one is, nothing
// sends another: one store for one label. An outstanding create is settled by a whole list read by the name: found, its
// ID is recorded as made; read without it on two whole lists at least [`GONE_SPAN_MS`] apart, the first no sooner than
// that after the create, it is no longer outstanding, and a release that asks for the store creates it again under the
// same name.

/// **Proposed.** How long after a create, and between two whole lists without the store's name, before the create is
/// taken for one that made nothing: the same ten minutes as a custom hostname's two reads of gone
/// (`crate::hostname_requests::GONE_SPAN_MS`), since no spike has measured how long a database just made takes to show
/// in D1's list.
pub const GONE_SPAN_MS: i64 = 10 * 60 * 1000;

/// The release fails by this when D1 refused its store's create in so many words ([`CreateAnswer::Refused`]).
pub const STORE_CREATE_REFUSED: &str = "store_create_refused";
/// A release waits: the gate on making stores, the release path's constant, is closed. Nothing was recorded or sent.
pub const STORE_CREATE_INCOMPLETE: &str = "store_create_incomplete";
/// A release waits: no store provider is configured.
pub const STORE_PROVIDER_MISSING: &str = "store_provider_missing";
/// A release waits: its store's create got no answer to go on, and the list didn't find it yet.
pub const STORE_CREATE_UNANSWERED: &str = "store_create_unanswered";
/// A release waits: its store's create is outstanding and a list without it didn't settle it yet.
pub const STORE_UNSETTLED: &str = "store_unsettled";
/// A release waits: the list of stores wasn't whole.
pub const STORE_LIST_UNKNOWN: &str = "store_list_unknown";
/// A release waits one step: a create outstanding was found by the list and its store recorded made.
pub const STORE_SETTLED: &str = "store_settled";
/// A release waits one step: a create outstanding was settled as having made nothing, so the store is created again.
pub const STORE_CREATE_OWED: &str = "store_create_owed";

/// What the release job does about its app's store before it uploads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MakeStep {
    /// The release asks for no store: none is made, and the upload goes on.
    Nothing,
    /// The store is made and recorded: nothing more is made, and the upload goes on.
    Made,
    /// Record the name and `create_sent_at`, then send the create.
    Create,
    /// A create is outstanding: settle it by the list, and send nothing.
    Settle,
    /// The release fails by this code, and nothing is made.
    Fail(NoBinding),
}

/// What the job does for a release that asks for a store (`wants`, `crate::app_code::asks_for_store`), given the room's
/// record of its label's store and when its create was last sent. **Never a second create while one is outstanding,
/// and never one for a store recorded made,** so a label has one store. A record owed a deletion, or not of the room's
/// form, fails the release and makes nothing.
pub fn make_step(
    wants: bool,
    record: Option<&StoreRecord<'_>>,
    create_sent_at: Option<i64>,
) -> MakeStep {
    if !wants {
        return MakeStep::Nothing;
    }
    if record.is_none() {
        return MakeStep::Create;
    }
    match binding(record) {
        Ok(_) => MakeStep::Made,
        Err(NoBinding::NotMade) if create_sent_at.is_some() => MakeStep::Settle,
        Err(NoBinding::NotMade | NoBinding::NoStore) => MakeStep::Create,
        Err(other) => MakeStep::Fail(other),
    }
}

/// The waits a release's upload step answers only after its manifest was read and asked for its store, while its
/// label's create is outstanding. A release whose own last step answered one of these asked for its store.
pub const STORE_WAITS: [&str; 4] = [
    STORE_CREATE_UNANSWERED,
    STORE_UNSETTLED,
    STORE_LIST_UNKNOWN,
    STORE_PROVIDER_MISSING,
];

/// A release waits one step: its lease took no upload slot, to settle its store first, and the record changed before
/// the step read it, so nothing is read without a slot; the next lease takes one.
pub const STORE_SLOT_NEEDED: &str = "store_upload_slot_needed";

/// Whether the release's upload step settles its label's create outstanding by the list before anything else, reading
/// nothing from GitHub and taking no upload slot: the record holds a create outstanding, **and the release's own last
/// step (`last_code`) waited on its store** ([`STORE_WAITS`]), which it does only once its manifest asked for one. A
/// release not known to ask, a static one among them, is never held by a create outstanding: it reads as before, and a
/// release that asks settles it after its read (the deep review of PR #416, item 1).
pub fn settles_first(
    record: Option<&StoreRecord<'_>>,
    create_sent_at: Option<i64>,
    last_code: Option<&str>,
) -> bool {
    record.is_some()
        && create_sent_at.is_some()
        && binding(record) == Err(NoBinding::NotMade)
        && last_code.is_some_and(|code| STORE_WAITS.contains(&code))
}

/// What a whole list says of a create outstanding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Settle {
    /// The name is listed: this is its ID, to record as made.
    Found(String),
    /// Not settled yet: read again at `at`. `note_gone` when this list is the first without it that counts, which the
    /// room notes as the record's last change.
    Wait { at: i64, note_gone: bool },
    /// Two whole lists without it, far enough apart: the create made nothing, and may be sent again.
    CreateAgain,
    /// No whole list: nothing is decided.
    Unknown,
}

/// A whole list (`None` when it wasn't) read at `now` for a create of `name` sent at `create_sent_at`, whose first
/// counted list without it was read at `first_gone_at`, if one was: the record's own column since S4's schema step
/// (S2 kept it in `updated_at`). A note from before [`GONE_SPAN_MS`] after the create is no first that counted.
///
/// Found at any time. Otherwise a list counts only from [`GONE_SPAN_MS`] after the create; the first that counts is
/// noted; and a second at least [`GONE_SPAN_MS`] after the first settles the create as having made nothing.
pub fn settle(
    list: Option<&[(String, String)]>,
    name: &str,
    create_sent_at: i64,
    first_gone_at: Option<i64>,
    now: i64,
) -> Settle {
    let Some(list) = list else {
        return Settle::Unknown;
    };
    if let Some((id, _)) = list.iter().find(|(_, listed)| listed == name) {
        return Settle::Found(id.clone());
    }
    let earliest = create_sent_at.saturating_add(GONE_SPAN_MS);
    if now < earliest {
        return Settle::Wait {
            at: earliest,
            note_gone: false,
        };
    }
    if let Some(first) = first_gone_at.filter(|first| *first >= earliest) {
        let second = first.saturating_add(GONE_SPAN_MS);
        return if now >= second {
            Settle::CreateAgain
        } else {
            Settle::Wait {
                at: second,
                note_gone: false,
            }
        };
    }
    Settle::Wait {
        at: now.saturating_add(GONE_SPAN_MS),
        note_gone: true,
    }
}

// --- Deleting a store (S4 of the store plan) -------------------------------------------------------------------------
//
// An app's data is deleted by an operator (ADR 0010's revision, section 3.3: "a new operator command deletes an app's
// store") or by the room's owner (its summary's row 7). Either command marks the room's record owed a deletion, with its
// cause, in the command's own transaction, once nothing serves the app; nothing is bound to a record owed a deletion
// ([`binding`]). Then the room's own job deletes it at D1 and **counts it gone only on D1's own not-found, read twice at
// least [`GONE_SPAN_MS`] apart.** A delete's answer is never trusted. A record holding a name and no ID is resolved by a
// whole list read by its name first: listed, its ID is recorded and deleted as any; not listed on two whole lists
// [`GONE_SPAN_MS`] apart, the first no sooner than that after its create, it was never made. **Only a store the room's
// own record names is ever deleted:** a store no room records (the reconcile's `store_orphan`) is never this job's.

/// The owner-approved words for an app's data deleted (the owner, 2026-11-17), exactly. The commands' answer carries
/// them, and so does anything a person or an agent is shown about it.
pub const DATA_DELETED_NOTICE: &str = "Your app’s data is deleted now, and nothing can read it. Cloudflare keeps a recoverable copy for up to 7 days; after that it’s gone for good.";

/// Why a store is owed a deletion: the closed set the room's `delete_cause` column holds. The column only checks the
/// form (lower-case letters and `_`), so the set can grow without rebuilding the table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeleteCause {
    /// A Podster operator deleted the app's data, which suspends the app.
    OperatorTakedown,
    /// The room's owner deleted the app's data, once nothing served it.
    OwnerDeleted,
    /// The app's label was retired. **Nothing retires a label yet;** the cause is here so the set is whole.
    LabelRetired,
    /// The room was deleted. **Nothing deletes a room's app yet;** the cause is here so the set is whole.
    RoomDeleted,
}

impl DeleteCause {
    pub const ALL: [DeleteCause; 4] = [
        DeleteCause::OperatorTakedown,
        DeleteCause::OwnerDeleted,
        DeleteCause::LabelRetired,
        DeleteCause::RoomDeleted,
    ];

    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            DeleteCause::OperatorTakedown => "operator_takedown",
            DeleteCause::OwnerDeleted => "owner_deleted",
            DeleteCause::LabelRetired => "label_retired",
            DeleteCause::RoomDeleted => "room_deleted",
        }
    }

    /// The cause a record names, or `None` for anything else.
    pub fn parse(code: &str) -> Option<DeleteCause> {
        DeleteCause::ALL
            .into_iter()
            .find(|cause| cause.code() == code)
    }
}

/// What a command that deletes an app's data does to the room's record of its store.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owe {
    /// The room holds no record of a store for the app: there is no data to delete, and nothing is written.
    NoStore,
    /// Mark the record owed a deletion now, with the command's cause.
    Owe,
    /// Already owed a deletion, or gone: nothing changes, and the first cause stands. Asking again is answered the same.
    Owed,
}

/// **Idempotent:** a record already owed, or gone, is left as it is, whatever cause asks again. Any other record is
/// owed, a create outstanding and a record not of the room's form among them: deleting is the safe direction, and a
/// record owed binds nothing.
pub fn owe(record: Option<&StoreRecord<'_>>) -> Owe {
    match record {
        None => Owe::NoStore,
        Some(record) if record.delete_owed_at.is_some() || record.gone_at.is_some() => Owe::Owed,
        Some(_) => Owe::Owe,
    }
}

/// What a command answers of the app's data: none, being deleted, or deleted (confirmed by D1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DataState {
    None,
    Deleting,
    Deleted,
}

impl DataState {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            DataState::None => "none",
            DataState::Deleting => "deleting",
            DataState::Deleted => "deleted",
        }
    }
}

/// The state of a record's data, for the commands' answer, which owe it first: no record is `none`, a record gone is
/// `deleted`, and any other `deleting`.
pub fn data_state(record: Option<&StoreRecord<'_>>) -> DataState {
    match record {
        None => DataState::None,
        Some(record) if record.gone_at.is_some() => DataState::Deleted,
        Some(_) => DataState::Deleting,
    }
}

/// What the deletion job does next for one record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeleteStep {
    /// Not owed a deletion, or already gone.
    Nothing,
    /// Send the delete for this ID, whose answer isn't trusted, then read it.
    Delete(String),
    /// Read this ID only: D1 already said gone once, so only a second read of it counts now.
    Read(String),
    /// The record has a name and no ID: read the whole list, and find the name.
    List,
    /// The record isn't of the room's form: nothing is sent.
    Malformed,
}

/// The job's next step for a record and the first read of gone noted on it (`first_gone_at`). An ID is sent only when
/// it is of D1's form, and a name looked up only when it is a store's name; anything else is [`DeleteStep::Malformed`].
pub fn delete_step(record: Option<&StoreRecord<'_>>, first_gone_at: Option<i64>) -> DeleteStep {
    let Some(record) = record else {
        return DeleteStep::Nothing;
    };
    if record.delete_owed_at.is_none() || record.gone_at.is_some() {
        return DeleteStep::Nothing;
    }
    if record.kind.and_then(StoreKind::parse).is_none() || !record.name.is_some_and(is_store_name) {
        return DeleteStep::Malformed;
    }
    match record.id {
        Some(id) if d1_id_form(id) => {
            if first_gone_at.is_some() {
                DeleteStep::Read(id.to_owned())
            } else {
                DeleteStep::Delete(id.to_owned())
            }
        }
        Some(_) => DeleteStep::Malformed,
        None => DeleteStep::List,
    }
}

/// What one read, or one list, came to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeleteOutcome {
    /// The first read of gone that counts: note it, and read again at `at`.
    NoteGone { at: i64 },
    /// Gone again, too soon after the first to count: read again at `at`.
    WaitGone { at: i64 },
    /// Gone, read so twice at least [`GONE_SPAN_MS`] apart: the record is gone.
    Gone,
    /// D1 described the store: it is still there. Any note of gone is forgotten, and it is deleted again.
    Present,
    /// The record's name is listed under this ID: record it, and delete it by it.
    Found(String),
    /// A whole list without the name, too soon after its create to count: read again at `at`.
    TooSoon { at: i64 },
    /// Nothing to go on: no answer, or not D1's own. Tried again; nothing is noted or forgotten.
    Unknown,
}

/// A read by ID during a deletion: gone only on D1's own not-found, twice at least [`GONE_SPAN_MS`] apart.
pub fn after_read(read: StoreRead, first_gone_at: Option<i64>, now: i64) -> DeleteOutcome {
    match read {
        StoreRead::Present => DeleteOutcome::Present,
        StoreRead::Unknown => DeleteOutcome::Unknown,
        StoreRead::Gone => gone_again(first_gone_at, now),
    }
}

fn gone_again(first_gone_at: Option<i64>, now: i64) -> DeleteOutcome {
    match first_gone_at {
        None => DeleteOutcome::NoteGone {
            at: now.saturating_add(GONE_SPAN_MS),
        },
        Some(first) if now >= first.saturating_add(GONE_SPAN_MS) => DeleteOutcome::Gone,
        Some(first) => DeleteOutcome::WaitGone {
            at: first.saturating_add(GONE_SPAN_MS),
        },
    }
}

/// A list read for a record with a name and no ID (`None` when it wasn't whole). Listed: [`DeleteOutcome::Found`] at
/// any time. Not listed: it counts only from [`GONE_SPAN_MS`] after the record's create, if one was sent
/// (`create_sent_at`), so a create still landing isn't missed; then as two reads of gone at least [`GONE_SPAN_MS`]
/// apart, the first noted. A record whose create was settled as having made nothing (`create_sent_at` null) counts at
/// once. A note from before the create's span is no first that counted.
pub fn after_list(
    list: Option<&[(String, String)]>,
    name: &str,
    create_sent_at: Option<i64>,
    first_gone_at: Option<i64>,
    now: i64,
) -> DeleteOutcome {
    let Some(list) = list else {
        return DeleteOutcome::Unknown;
    };
    if let Some((id, _)) = list.iter().find(|(_, listed)| listed == name) {
        return DeleteOutcome::Found(id.clone());
    }
    let earliest = create_sent_at.map_or(i64::MIN, |sent| sent.saturating_add(GONE_SPAN_MS));
    if now < earliest {
        return DeleteOutcome::TooSoon { at: earliest };
    }
    gone_again(first_gone_at.filter(|first| *first >= earliest), now)
}

/// **Proposed.** The wait before the deletion job's next try after one that decided nothing: 5 seconds, doubling, to 5
/// minutes at most, as a script's delete waits. It never gives up.
pub fn delete_wait_ms(attempts: i64) -> i64 {
    const FIRST: i64 = 5_000;
    const LONGEST: i64 = 5 * 60 * 1000;
    FIRST
        .saturating_mul(1_i64 << attempts.clamp(0, 6) as u32)
        .min(LONGEST)
}

/// **Proposed.** A deletion is told to operators, as [`STORE_DELETE_FAILING`] by the store's name, once this many tries
/// in a row have decided nothing (the record's `delete_attempts`, which a note of gone, a store found by its name or a
/// fresh owing sets back to 0). As a script's delete is told after twelve; with [`delete_wait_ms`]'s waits between
/// them, about half an hour. A try held because something can still reach the store counts too.
pub const DELETE_TOLD_AFTER: i64 = 12;

/// The operators' finding for a deletion that keeps failing.
pub const STORE_DELETE_FAILING: &str = "store_delete_failing";

/// Whether a deletion whose tries have decided nothing `attempts` times in a row is told to operators.
pub fn delete_told(attempts: i64) -> bool {
    attempts >= DELETE_TOLD_AFTER
}

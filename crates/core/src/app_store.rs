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

/// A whole list (`None` when it wasn't) read at `now` for a create of `name` sent at `create_sent_at`, whose record last
/// changed at `last_change_at`. While a create is outstanding the record changes only when it is recorded and when a
/// list without it counts, so a last change at least [`GONE_SPAN_MS`] after the create is the first that counted.
///
/// Found at any time. Otherwise a list counts only from [`GONE_SPAN_MS`] after the create; the first that counts is
/// noted; and a second at least [`GONE_SPAN_MS`] after the first settles the create as having made nothing.
pub fn settle(
    list: Option<&[(String, String)]>,
    name: &str,
    create_sent_at: i64,
    last_change_at: i64,
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
    if last_change_at >= earliest {
        let second = last_change_at.saturating_add(GONE_SPAN_MS);
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

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
/// The random part of a store's name, in hexadecimal digits.
pub const STORE_NAME_NONCE_DIGITS: usize = 32;

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

/// A store's name from the random part the caller drew: `podster-store-` and 32 lower-case hexadecimal digits.
pub fn store_name(nonce: &str) -> Option<String> {
    (nonce.len() == STORE_NAME_NONCE_DIGITS && lower_hex(nonce))
        .then(|| format!("{STORE_NAME_PREFIX}{nonce}"))
}

/// Whether a name is one Podster gives a store. Anything else in the account is never Podster's store.
pub fn is_store_name(name: &str) -> bool {
    name.strip_prefix(STORE_NAME_PREFIX)
        .is_some_and(|nonce| nonce.len() == STORE_NAME_NONCE_DIGITS && lower_hex(nonce))
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

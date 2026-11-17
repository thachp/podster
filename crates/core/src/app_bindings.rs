//! **Rule 3(b)** of the architect's ruling on the store (2026-11-16; S5 of the store plan, 2026-11-17). Pure: what an
//! app's script may be bound to, judged against what the provider says the script holds and the room's own record of
//! its store. The reconcile reads the bindings and the room decides from this; neither guesses.
//!
//! **Why it is load-bearing.** The credential that uploads scripts can bind any store in its account to any script,
//! and Cloudflare checks only that the store exists (the store spike, row 3). Rule 3(a) makes the upload bind only the
//! room's own store; this rule is the check afterwards that nothing else got there, whatever wrote it.
//!
//! **What a script may hold:** nothing, or exactly one binding, `{"type":"d1","name":"STORE","id":…}`, whose ID is the
//! one the room recorded for that script's label. **The ruling's "fixed ones" are none today:** the upload writes no
//! other binding (`crate::app_store::bindings_json`), the assets configuration declares no assets binding, and the
//! outbound Worker is named on the dispatch, not on the script. Anything else is [`Verdict::Foreign`], whatever its
//! kind: a Durable Object binding (the content Worker's `WriteCounter` among them), a KV namespace (Podster's
//! serve-entry namespace among them), another D1 database (another app's store among them), a service, a secret or any
//! kind not named here.
//!
//! **Unknown decides nothing** (review standard 3). A list that wasn't read, an entry that isn't an object with a
//! `type` and a `name`, a store binding whose ID can't be read as one, or a room record that isn't of the form the room
//! writes: each is [`Verdict::Unknown`], and the caller reads again next hour. A foreign binding that was read is
//! foreign even beside an entry whose ID couldn't be read: a fact read and false fails.
use crate::app_code::STORE_BINDING_NAME;
use crate::app_store::{
    d1_id_form, is_store_name, store_id_form, StoreKind, StoreRecord, D1_BINDING_TYPE,
};

/// The finding an operator is told of a script with a binding it may not hold, by the script's name, with the
/// [`Foreign`] code in `detail`. The app is suspended with it.
pub const BINDING_FOREIGN: &str = "script_binding_foreign";
/// The finding for a pass whose bindings reads, or rooms' records, couldn't be read for some scripts: once for the
/// pass, with how many in `detail`.
pub const BINDINGS_UNREAD: &str = "script_bindings_unread";

/// The class of the content Worker's write counter (`apps/content/src/counter.ts`, S6 of the store plan). No app's
/// script may bind it: a test reads the class's source for this name.
pub const WRITE_COUNTER_CLASS: &str = "WriteCounter";
/// The type Cloudflare's upload metadata names a Durable Object binding by.
pub const DURABLE_OBJECT_BINDING_TYPE: &str = "durable_object_namespace";
/// The type Cloudflare's upload metadata names a KV namespace binding by.
pub const KV_BINDING_TYPE: &str = "kv_namespace";

/// One binding as the provider's read gave it. Each field is `None` unless the entry held a string there.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReadBinding<'a> {
    /// `type`.
    pub kind: Option<&'a str>,
    pub name: Option<&'a str>,
    /// A D1 binding's database ID.
    pub id: Option<&'a str>,
    /// A KV binding's namespace ID.
    pub namespace_id: Option<&'a str>,
    /// A Durable Object binding's class.
    pub class_name: Option<&'a str>,
}

/// The store a script of this label may be bound to, from the room's record of the label's store.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OwnStore<'a> {
    /// No store was ever recorded made: no binding to a store is the app's own.
    None,
    /// The ID the room recorded. A store owed a deletion, or gone, is still the one an earlier script was bound to.
    Recorded(&'a str),
    /// The record isn't of the form the room writes. Nothing is decided from it.
    Unreadable,
}

/// The store the room's record says is this app's own, for rule 3(b). Unlike rule 3(a)'s `binding`, a record owed a
/// deletion or gone still names its store: a script written before the deletion was owed is bound to it rightly. A
/// record with a create outstanding and no ID names none. Anything not wholly of the room's form is unreadable.
pub fn own_store<'a>(record: Option<&StoreRecord<'a>>) -> OwnStore<'a> {
    let Some(record) = record else {
        return OwnStore::None;
    };
    let Some(kind) = record.kind.and_then(StoreKind::parse) else {
        return OwnStore::Unreadable;
    };
    let well_formed = record.name.is_some_and(is_store_name)
        && (record.gone_at.is_none() || record.delete_owed_at.is_some())
        && record.id.is_some() == record.made_at.is_some()
        && record.id.is_none_or(|id| store_id_form(kind, id));
    match (well_formed, record.id) {
        (false, _) => OwnStore::Unreadable,
        (true, Some(id)) => OwnStore::Recorded(id),
        (true, None) => OwnStore::None,
    }
}

/// Why a binding is one the script may not hold. Each is a code a finding's `detail` and a log line may carry.
/// Listed most telling first: a script with several is told by the first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Foreign {
    /// A Durable Object binding naming the content Worker's write counter class.
    WriteCounter,
    /// A KV binding to the namespace that holds Podster's serve entries.
    ServeEntries,
    /// A D1 binding that isn't the app's own store under `STORE`: another app's store, or any other database.
    OtherStore,
    /// A store bound under `STORE` while the room has recorded none made.
    StoreUnrecorded,
    /// Any other Durable Object binding.
    DurableObject,
    /// Any other KV binding.
    KvNamespace,
    /// The app's own store bound more than once.
    StoreTwice,
    /// Any other kind of binding.
    Other,
}

impl Foreign {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            Foreign::WriteCounter => "write_counter",
            Foreign::ServeEntries => "serve_entries",
            Foreign::OtherStore => "store_foreign",
            Foreign::StoreUnrecorded => "store_unrecorded",
            Foreign::DurableObject => "durable_object",
            Foreign::KvNamespace => "kv_namespace",
            Foreign::StoreTwice => "store_twice",
            Foreign::Other => "other_binding",
        }
    }
}

/// What rule 3(b) says of one script.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Nothing but its own store, or nothing at all.
    Clean,
    /// A binding it may not hold, read as such: operators are told and the app is suspended.
    Foreign(Foreign),
    /// Nothing can be said. Nothing is decided, and it is read again.
    Unknown,
}

/// One entry, judged alone: `Ok(())` for the app's own store, `Err(Some(_))` for a binding it may not hold, and
/// `Err(None)` when it can't be told.
fn judge(
    binding: &ReadBinding<'_>,
    own: OwnStore<'_>,
    serve_entries: Option<&str>,
) -> Result<(), Option<Foreign>> {
    let (Some(kind), Some(name)) = (binding.kind, binding.name) else {
        return Err(None);
    };
    if binding.class_name == Some(WRITE_COUNTER_CLASS) {
        return Err(Some(Foreign::WriteCounter));
    }
    match kind {
        D1_BINDING_TYPE if name == STORE_BINDING_NAME => {
            let Some(id) = binding.id.filter(|id| d1_id_form(id)) else {
                return Err(None);
            };
            match own {
                OwnStore::Unreadable => Err(None),
                OwnStore::None => Err(Some(Foreign::StoreUnrecorded)),
                OwnStore::Recorded(recorded) if recorded == id => Ok(()),
                OwnStore::Recorded(_) => Err(Some(Foreign::OtherStore)),
            }
        }
        D1_BINDING_TYPE => Err(Some(Foreign::OtherStore)),
        DURABLE_OBJECT_BINDING_TYPE => Err(Some(Foreign::DurableObject)),
        KV_BINDING_TYPE if serve_entries.is_some() && binding.namespace_id == serve_entries => {
            Err(Some(Foreign::ServeEntries))
        }
        KV_BINDING_TYPE => Err(Some(Foreign::KvNamespace)),
        _ => Err(Some(Foreign::Other)),
    }
}

/// **Rule 3(b).** What a script's bindings say, given the room's record of its label's store and the ID of Podster's
/// serve-entry namespace, if known. `None` for the bindings means the read gave no list. See the module's note.
pub fn check(
    bindings: Option<&[ReadBinding<'_>]>,
    own: OwnStore<'_>,
    serve_entries: Option<&str>,
) -> Verdict {
    let Some(bindings) = bindings else {
        return Verdict::Unknown;
    };
    if bindings
        .iter()
        .any(|binding| binding.kind.is_none() || binding.name.is_none())
    {
        return Verdict::Unknown;
    }
    let mut foreign: Option<Foreign> = None;
    let mut unknown = false;
    let mut own_bound = 0usize;
    for binding in bindings {
        match judge(binding, own, serve_entries) {
            Ok(()) => own_bound += 1,
            Err(Some(found)) => foreign = Some(foreign.map_or(found, |seen| seen.min(found))),
            Err(None) => unknown = true,
        }
    }
    if own_bound > 1 {
        foreign = Some(foreign.map_or(Foreign::StoreTwice, |seen| seen.min(Foreign::StoreTwice)));
    }
    match (foreign, unknown) {
        (Some(found), _) => Verdict::Foreign(found),
        (None, true) => Verdict::Unknown,
        (None, false) => Verdict::Clean,
    }
}

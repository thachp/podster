//! **Rule 3(b)** of the architect's ruling on the store (2026-11-16; S5 of the store plan, 2026-11-17). Pure: what an
//! app's script may be bound to, judged against what the provider says the script holds and the room's own record of
//! its store; how many apps the check may suspend in an hour; and when a script that keeps reading unknown is told.
//! The reconcile reads the bindings and the room decides from this; neither guesses.
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
//! kind not named here. **An answer the provider gave that is longer than any list Podster could have written is
//! foreign too** ([`Read::Oversized`]): padding a list must not hide a binding in it.
//!
//! **Unknown decides nothing** (review standard 3), **but only once every readable entry has been judged** (the deep
//! review of PR #420, item 4). A list that wasn't read is unknown. In a list that was, each entry is judged on its own:
//! any entry read as foreign makes the script foreign, whatever else the list holds; an entry that can't be judged (not
//! an object, no `type`, a store binding with no name or an ID not of D1's form, or a room record not of the room's
//! form) makes it unknown only when nothing foreign was read.
use crate::app_code::STORE_BINDING_NAME;
use crate::app_store::{
    d1_id_form, is_store_name, store_id_form, StoreKind, StoreRecord, D1_BINDING_TYPE,
};
use crate::release::{repo_unpublish_ceiling, repo_unpublish_counts};

/// The finding an operator is told of a script with a binding it may not hold, by the script's name, with the
/// [`Foreign`] code in `detail`.
pub const BINDING_FOREIGN: &str = "script_binding_foreign";
/// The finding for a script whose app the ceiling kept from being suspended ([`suspension_permit`]), by the script's
/// name, with why in `detail`: `ceiling_reached` or `ceiling_unread`.
pub const BINDING_HELD: &str = "script_binding_held";
/// The finding for scripts whose bindings this pass couldn't judge: once for the pass, with how many in `detail`. It
/// counts the slice of scripts this pass reached, never the whole namespace.
pub const BINDINGS_UNREAD: &str = "script_bindings_unread";
/// The finding for one script whose bindings couldn't be judged [`UNREAD_PASSES_TOLD`] passes in a row, by the script's
/// name, with how many in `detail`.
pub const BINDINGS_KEEP_UNREAD: &str = "script_bindings_keep_unread";

/// **Proposed.** Passes in a row a script's bindings may read unknown before operators are told of it by name.
pub const UNREAD_PASSES_TOLD: i64 = 3;

/// Whether a script whose bindings have read unknown `passes` passes in a row is told by name.
pub fn unread_told(passes: i64) -> bool {
    passes >= UNREAD_PASSES_TOLD
}

/// The class of the content Worker's write counter (`apps/content/src/counter.ts`, S6 of the store plan). No app's
/// script may bind it: a test reads the class's source for this name.
pub const WRITE_COUNTER_CLASS: &str = "WriteCounter";
/// The type Cloudflare's upload metadata names a Durable Object binding by.
pub const DURABLE_OBJECT_BINDING_TYPE: &str = "durable_object_namespace";
/// The type Cloudflare's upload metadata names a KV namespace binding by.
pub const KV_BINDING_TYPE: &str = "kv_namespace";

/// One binding as the provider's read gave it. Each field is `None` unless the entry held a string there; an entry
/// that isn't an object is all `None`.
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

/// What the provider's read of a script's bindings gave.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Read<'a> {
    /// A list, each entry as read.
    List(&'a [ReadBinding<'a>]),
    /// A `200` whose body was longer than the read's bound: no list Podster writes is anywhere near it.
    Oversized,
    /// No list: no answer, another status, or a body that isn't the expected shape.
    Unread,
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

/// Why a script holds what it may not. Each is a code a finding's `detail` and a log line may carry. Listed most
/// telling first: a script with several is told by the first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Foreign {
    /// A binding naming the content Worker's write counter class.
    WriteCounter,
    /// A KV binding to the namespace that holds Podster's serve entries.
    ServeEntries,
    /// A D1 binding to a database that isn't the app's own store: another app's store, or any other database.
    OtherStore,
    /// A store bound under `STORE` while the room has recorded none made.
    StoreUnrecorded,
    /// The app's own store bound a second time, under another name.
    StoreOwnTwice,
    /// Any other Durable Object binding.
    DurableObject,
    /// Any other KV binding.
    KvNamespace,
    /// The app's own store bound under `STORE` more than once.
    StoreTwice,
    /// Any other kind of binding.
    Other,
    /// The read's answer was longer than any list Podster writes.
    Oversized,
}

impl Foreign {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            Foreign::WriteCounter => "write_counter",
            Foreign::ServeEntries => "serve_entries",
            Foreign::OtherStore => "store_foreign",
            Foreign::StoreUnrecorded => "store_unrecorded",
            Foreign::StoreOwnTwice => "store_own_twice",
            Foreign::DurableObject => "durable_object",
            Foreign::KvNamespace => "kv_namespace",
            Foreign::StoreTwice => "store_twice",
            Foreign::Other => "other_binding",
            Foreign::Oversized => "bindings_oversized",
        }
    }
}

/// What rule 3(b) says of one script.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Nothing but its own store, or nothing at all.
    Clean,
    /// Something it may not hold, read as such: operators are told and the app is suspended, within the ceiling.
    Foreign(Foreign),
    /// Nothing can be said. Nothing is decided, and it is read again.
    Unknown,
}

/// One entry, judged alone: `Ok(())` for the app's own store under `STORE`, `Err(Some(_))` for a binding it may not
/// hold, and `Err(None)` when it can't be told. Only what decides an entry has to be readable: any KV, Durable Object
/// or other kind is foreign whatever its name, and a class naming the write counter is foreign on any entry.
fn judge(
    binding: &ReadBinding<'_>,
    own: OwnStore<'_>,
    serve_entries: Option<&str>,
) -> Result<(), Option<Foreign>> {
    if binding.class_name == Some(WRITE_COUNTER_CLASS) {
        return Err(Some(Foreign::WriteCounter));
    }
    let Some(kind) = binding.kind else {
        return Err(None);
    };
    match kind {
        D1_BINDING_TYPE => {
            let (Some(name), Some(id)) = (binding.name, binding.id.filter(|id| d1_id_form(id)))
            else {
                return Err(None);
            };
            match (own, name == STORE_BINDING_NAME) {
                (OwnStore::Recorded(recorded), true) if recorded == id => Ok(()),
                (OwnStore::Recorded(recorded), false) if recorded == id => {
                    Err(Some(Foreign::StoreOwnTwice))
                }
                (OwnStore::Recorded(_), _) => Err(Some(Foreign::OtherStore)),
                (OwnStore::None, true) => Err(Some(Foreign::StoreUnrecorded)),
                // Under another name it is foreign whatever the record says; which code can't be told, so the wider.
                (OwnStore::None | OwnStore::Unreadable, false) => Err(Some(Foreign::OtherStore)),
                (OwnStore::Unreadable, true) => Err(None),
            }
        }
        DURABLE_OBJECT_BINDING_TYPE => Err(Some(Foreign::DurableObject)),
        KV_BINDING_TYPE if serve_entries.is_some() && binding.namespace_id == serve_entries => {
            Err(Some(Foreign::ServeEntries))
        }
        KV_BINDING_TYPE => Err(Some(Foreign::KvNamespace)),
        _ => Err(Some(Foreign::Other)),
    }
}

/// **Rule 3(b).** What a script's bindings say, given the room's record of its label's store and the ID of Podster's
/// serve-entry namespace, if known. See the module's note.
pub fn check(read: Read<'_>, own: OwnStore<'_>, serve_entries: Option<&str>) -> Verdict {
    let bindings = match read {
        Read::List(bindings) => bindings,
        Read::Oversized => return Verdict::Foreign(Foreign::Oversized),
        Read::Unread => return Verdict::Unknown,
    };
    let mut foreign: Option<Foreign> = None;
    let mut unknown = false;
    let mut own_bound = 0usize;
    let mut found = |seen: Foreign| foreign = Some(foreign.map_or(seen, |was| was.min(seen)));
    for binding in bindings {
        match judge(binding, own, serve_entries) {
            Ok(()) => own_bound += 1,
            Err(Some(seen)) => found(seen),
            Err(None) => unknown = true,
        }
    }
    if own_bound > 1 {
        found(Foreign::StoreTwice);
    }
    match (foreign, unknown) {
        (Some(seen), _) => Verdict::Foreign(seen),
        (None, true) => Verdict::Unknown,
        (None, false) => Verdict::Clean,
    }
}

/// Whether the check may suspend one more app now (the coordinator's ruling on PR #420's review, item 4; Proposed).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SuspensionPermit {
    /// Within the ceiling.
    Allowed,
    /// The hour has had as many as the ceiling allows: told, nothing suspended.
    Ceiling,
    /// How many rooms have apps couldn't be read, so the ceiling can't be sized: told, nothing suspended, asked again.
    Unknown,
}

impl SuspensionPermit {
    /// The `detail` of a held script's finding.
    // codes: reasons
    pub fn held_code(self) -> Option<&'static str> {
        match self {
            SuspensionPermit::Allowed => None,
            SuspensionPermit::Ceiling => Some("ceiling_reached"),
            SuspensionPermit::Unknown => Some("ceiling_unread"),
        }
    }
}

/// **The ceiling on the check's suspensions, Proposed:** the repository unpublish's, at most
/// `crate::release::REPO_UNPUBLISH_CEILING` apps, or `REPO_UNPUBLISH_CEILING_PERCENT` of the rooms with apps rounded up,
/// whichever is smaller and never below one, in a rolling hour across the deployment. So a misread of the provider's
/// answer that makes every script look foreign can take down a handful of apps, never all of them. `suspended_at` is
/// when each of the window's earlier suspensions was made.
pub fn suspension_permit(
    suspended_at: &[i64],
    rooms_with_apps: Option<u64>,
    now: i64,
) -> SuspensionPermit {
    let Some(rooms) = rooms_with_apps else {
        return SuspensionPermit::Unknown;
    };
    let used = suspended_at
        .iter()
        .filter(|at| repo_unpublish_counts(**at, now))
        .count();
    if used < repo_unpublish_ceiling(rooms) as usize {
        SuspensionPermit::Allowed
    } else {
        SuspensionPermit::Ceiling
    }
}

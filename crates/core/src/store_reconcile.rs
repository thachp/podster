//! **The reconcile of rooms' app stores** (S5 of the store plan, its second PR). Pure: what one room's record of a
//! label's store says against a whole list of the account's D1 databases, when a made store read gone counts, and when
//! a listed store no room records is an orphan. The `Moderation` object's hourly pass reads the list and asks the rooms;
//! it decides from these, and **deletes nothing** (S4 owns deleting a store) and writes no room's record itself: a
//! record the list settles is written by the room, through the release job's own write path.
//!
//! **Unknown decides nothing** (review standard 3): no whole list, a record not of the room's form, a read that isn't
//! D1's own answer, or a walk of the rooms some room didn't answer, each decide nothing and are read again.

use crate::app_store::{binding, NoBinding, StoreRecord, GONE_SPAN_MS, STORE_NAME_PREFIX};

/// The finding for a Podster-named store that no room records, by the store's name. Never deleted here.
pub const STORE_ORPHAN: &str = "store_orphan";
/// The finding for a room's record of a made store that D1 says is gone, read so twice at least ten minutes apart, by
/// the store's name.
pub const STORE_MADE_GONE: &str = "store_made_gone";
/// The finding for a room's record of a name with no ID that the list showed, which the room then recorded made, by
/// the store's name.
pub const STORE_ID_SETTLED: &str = "store_id_settled";
/// The finding for a pass whose list of D1's databases wasn't whole, so nothing about stores was decided: once for the
/// pass, by the subject `d1`.
pub const STORE_LIST_UNREAD: &str = "store_list_unread";

/// Whether a database's name says it is Podster's: it starts with the prefix every store's name has. One whose rest
/// isn't of a store's form can never be recorded by a room, so it is Podster-named and never Podster's own.
pub fn podster_named(name: &str) -> bool {
    name.starts_with(STORE_NAME_PREFIX)
}

/// What the reconcile makes of one room's record, against a whole list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecordCheck {
    /// Nothing to do: listed as recorded, owed a deletion or gone (S4's), or a name not made that the list doesn't show
    /// (the release job's to settle).
    Fine,
    /// A made store the list doesn't show by its ID and name: read it by its ID, and only D1's own not-found says gone.
    ReadById,
    /// A name with no ID that the list shows: the room records this ID, through the release job's write path.
    Settle(String),
    /// The record isn't of the room's form. Nothing is decided.
    Unknown,
}

/// One room's record against a whole list (`(id, name)` as D1 listed them).
pub fn check_record(record: &StoreRecord<'_>, list: &[(String, String)]) -> RecordCheck {
    match binding(Some(record)) {
        Ok(made) => {
            let listed = list
                .iter()
                .any(|(id, name)| *id == made.id && Some(name.as_str()) == record.name);
            if listed {
                RecordCheck::Fine
            } else {
                RecordCheck::ReadById
            }
        }
        Err(NoBinding::DeleteOwed) => RecordCheck::Fine,
        Err(NoBinding::NotMade) => match list
            .iter()
            .find(|(_, name)| Some(name.as_str()) == record.name)
        {
            Some((id, _)) => RecordCheck::Settle(id.clone()),
            None => RecordCheck::Fine,
        },
        Err(NoBinding::Malformed | NoBinding::NoStore) => RecordCheck::Unknown,
    }
}

/// A made store read gone, given when it was first read gone, if it was.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GoneStep {
    /// The first read of gone: note when.
    Note,
    /// Read gone again, too soon after the first to count.
    Wait,
    /// Read gone a second time, at least [`GONE_SPAN_MS`] after the first: operators are told.
    Confirmed,
}

/// Two reads of D1's own not-found at least [`GONE_SPAN_MS`] apart, as a custom hostname's are, since the store spike
/// saw D1's not-found once per database and nothing here can undo a deletion.
pub fn gone_step(first_gone_at: Option<i64>, now: i64) -> GoneStep {
    match first_gone_at {
        None => GoneStep::Note,
        Some(first) if now >= first.saturating_add(GONE_SPAN_MS) => GoneStep::Confirmed,
        Some(_) => GoneStep::Wait,
    }
}

/// Whether a Podster-named store on the list is an orphan, at the end of a walk of every room's labels: it was first
/// listed (and listed on every whole list since) **before the walk began** (`first_listed_at < walk_started_at`), no room
/// recorded its name during the walk, and every room the walk asked answered (`walk_whole`).
///
/// A room records a store's name before it sends the create, and a room's records are never removed, so a store listed
/// before the walk began was recorded before it too, and a walk that reached every label would have seen it. One listed
/// only once the walk had begun may belong to a room the walk asked before the room recorded it, so it waits for the next.
pub fn is_orphan(
    first_listed_at: i64,
    claimed_in_walk: bool,
    walk_started_at: i64,
    walk_whole: bool,
) -> bool {
    walk_whole && !claimed_in_walk && first_listed_at < walk_started_at
}

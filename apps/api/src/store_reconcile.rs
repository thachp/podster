//! **The reconcile of rooms' app stores** (S5 of the store plan, its second PR), a step of the hourly pass in the
//! `Moderation` object. What it decides is pure, in `podster_core::store_reconcile`; here is only what it reads, asks
//! and keeps.
//!
//! **It deletes nothing and writes no room's record itself** (ADR 0010: a reconcile never writes or removes what it
//! checks; S4 owns deleting a store). It tells operators, and a record the list settles is written by the room, in
//! `workspace/release_store.rs`, the only writer of `app_store`.
//!
//! - **The list.** Each pass reads the whole list of the account's D1 databases with the store token
//!   ([`StoreProvider::for_reconcile`], D1 Edit alone, as ruled on 2026-11-17), up to `MAX_LIST_PAGES` pages of
//!   `LIST_PAGE`. **Not filtered by name:** D1's list takes a `name` parameter that its reference calls a search, and
//!   neither the spike nor the documentation says whether it matches exactly, by prefix or anywhere, so a filtered list
//!   couldn't be read as whole. Past the bound there is no list, and the pass decides nothing (below). **The bound must
//!   be raised, or the filter's meaning seen in a spike, before about a thousand databases are in the account.**
//! - **No whole list decides nothing:** nothing is asked, noted or told but `store_list_unread`, once for the pass.
//! - **The walk.** Like the scripts the pass asks about by their label, each store is asked about by its label: a slice
//!   of the app-label lookup table each pass, from where the last stopped, each label's room asked for its record of that
//!   label's store. The table only routes the question; the room's answer is what counts.
//!   - **A name with no ID that the list shows** is settled: the room is asked again with the listed ID and records it
//!     made, and operators are told `store_id_settled`.
//!   - **A made store the list doesn't show** is read by its ID. Gone only on D1's own not-found (`404`, `7404`), and
//!     told as `store_made_gone` only on a second such read at least ten minutes after the first. Read present, or
//!     listed again, the count is forgotten and the finding taken away.
//!   - **A Podster-named store no room records** (`podster-store-…`) is an orphan, told as `store_orphan` and never
//!     deleted here, only at the end of a walk over every label that every room answered, and only if it was listed
//!     before that walk began (`podster_core::store_reconcile::is_orphan`). A room that didn't answer makes that walk
//!     decide no orphan.
//! - **Two passes at once** each walk from the same place; only the one that finds the walk where it left it moves it
//!   on, so a walk is never ended twice, and never ended by a pass that missed a room the other found unanswered.
//!
//! Store names are kept only here and in the operators' findings (review standard 5). Logs carry codes and counts.
use crate::app_stores::StoreProvider;
use crate::error::ApiError;
use crate::reconcile::{ask_room, keep};
use crate::store::{exec, int, rows, text};
use podster_core::app_store::{StoreRead, StoreRecord};
use podster_core::store_reconcile::{
    check_record, gone_step, is_orphan, podster_named, GoneStep, RecordCheck, STORE_ID_SETTLED,
    STORE_LIST_UNREAD, STORE_MADE_GONE, STORE_ORPHAN,
};
use serde_json::{json, Value};
use worker::*;

type R<T> = std::result::Result<T, ApiError>;

/// The `Moderation` object's schema step for the store reconcile, forward-only and safe to run again.
///
/// `store_walk`: where the walk over the lookup table's labels is, which walk it is, when it began, and whether every
/// room it asked has answered. `store_listed`: each Podster-named database on the whole lists, since when it has been
/// listed without a break. `store_claim`: each store's name a room recorded, and in which walk it was last seen.
/// `store_gone_read`: a label's made store read gone, since when.
pub(crate) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS store_walk (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), cursor TEXT,
  walk INTEGER NOT NULL CHECK (typeof(walk) = 'integer' AND walk >= 1), started_at INTEGER NOT NULL CHECK (typeof(started_at) = 'integer'),
  whole INTEGER NOT NULL CHECK (whole IN (0, 1)));
CREATE TABLE IF NOT EXISTS store_listed (name TEXT PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 253),
  first_listed_at INTEGER NOT NULL CHECK (typeof(first_listed_at) = 'integer')) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS store_claim (name TEXT PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 253),
  walk INTEGER NOT NULL CHECK (typeof(walk) = 'integer')) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS store_gone_read (label TEXT PRIMARY KEY CHECK (length(label) BETWEEN 1 AND 253),
  store_id TEXT NOT NULL CHECK (length(store_id) = 36), first_gone_at INTEGER NOT NULL CHECK (typeof(first_gone_at) = 'integer'),
  last_at INTEGER NOT NULL CHECK (typeof(last_at) = 'integer')) WITHOUT ROWID;
";

/// Labels asked about in one pass.
const STORE_BATCH: i64 = 100;
/// How long the store step may go on asking, counted from when it starts, so a slow scripts pass leaves it its time.
const STORE_BUDGET_MS: i64 = 10_000;
/// A label's gone reads not read again for this long are forgotten, as findings are.
const GONE_KEPT_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const NAME_MAX: usize = 253;

fn now_ms() -> i64 {
    Date::now().as_millis() as i64
}

#[derive(Default)]
struct Tally {
    listed: u32,
    asked: u32,
    settled: u32,
    orphans: u32,
    made_gone: u32,
    unanswered: u32,
    errors: u32,
}

struct Walk {
    cursor: Option<String>,
    walk: i64,
}

/// The walk, begun now if there is none yet.
fn walk(sql: &SqlStorage, now: i64) -> R<Walk> {
    exec(
        sql,
        "INSERT INTO store_walk (singleton, cursor, walk, started_at, whole) VALUES (1, NULL, 1, ?, 1) ON CONFLICT (singleton) DO NOTHING",
        vec![now.into()],
    )?;
    let row = rows(sql, "SELECT cursor, walk FROM store_walk", vec![])?
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::internal("no store walk"))?;
    Ok(Walk {
        cursor: text(&row["cursor"]),
        walk: int(&row["walk"]),
    })
}

/// The Podster-named databases of a whole list: each new one noted as listed from now, each no longer listed forgotten,
/// so a name's `first_listed_at` is when its unbroken run of lists began.
fn note_listed(sql: &SqlStorage, list: &[(String, String)], now: i64) -> R<u32> {
    let names: std::collections::BTreeSet<&str> = list
        .iter()
        .map(|(_, name)| name.as_str())
        .filter(|name| podster_named(name) && name.len() <= NAME_MAX)
        .collect();
    for row in rows(sql, "SELECT name FROM store_listed", vec![])? {
        if let Some(name) = text(&row["name"]) {
            if !names.contains(name.as_str()) {
                exec(
                    sql,
                    "DELETE FROM store_listed WHERE name = ?",
                    vec![name.into()],
                )?;
            }
        }
    }
    for name in &names {
        exec(
            sql,
            "INSERT INTO store_listed (name, first_listed_at) VALUES (?, ?) ON CONFLICT (name) DO NOTHING",
            vec![(*name).into(), now.into()],
        )?;
    }
    Ok(names.len() as u32)
}

fn tell(sql: &SqlStorage, code: &str, subject: &str, now: i64) -> R<()> {
    keep(sql, &json!({ "code": code, "subject": subject }), now)
}

fn untell(sql: &SqlStorage, code: &str, subject: &str) -> R<()> {
    exec(
        sql,
        "DELETE FROM takedown_finding WHERE code = ? AND subject = ?",
        vec![code.into(), subject.into()],
    )
}

/// A made store D1 read gone once more: noted, or, at least ten minutes after the first, told.
fn read_gone(sql: &SqlStorage, label: &str, id: &str, name: &str, now: i64) -> R<bool> {
    let first = rows(
        sql,
        "SELECT first_gone_at FROM store_gone_read WHERE label = ? AND store_id = ?",
        vec![label.into(), id.into()],
    )?
    .first()
    .map(|row| int(&row["first_gone_at"]));
    match gone_step(first, now) {
        GoneStep::Note => {
            exec(
                sql,
                "INSERT INTO store_gone_read (label, store_id, first_gone_at, last_at) VALUES (?, ?, ?, ?)
                   ON CONFLICT (label) DO UPDATE SET store_id = excluded.store_id, first_gone_at = excluded.first_gone_at, last_at = excluded.last_at",
                vec![label.into(), id.into(), now.into(), now.into()],
            )?;
            Ok(false)
        }
        GoneStep::Wait => {
            exec(
                sql,
                "UPDATE store_gone_read SET last_at = ? WHERE label = ?",
                vec![now.into(), label.into()],
            )?;
            Ok(false)
        }
        GoneStep::Confirmed => {
            exec(
                sql,
                "UPDATE store_gone_read SET last_at = ? WHERE label = ?",
                vec![now.into(), label.into()],
            )?;
            tell(sql, STORE_MADE_GONE, name, now)?;
            Ok(true)
        }
    }
}

/// A made store seen there again: its gone reads are forgotten, and so is the finding.
fn seen_there(sql: &SqlStorage, label: &str, name: Option<&str>) -> R<()> {
    exec(
        sql,
        "DELETE FROM store_gone_read WHERE label = ?",
        vec![label.into()],
    )?;
    match name {
        Some(name) => untell(sql, STORE_MADE_GONE, name),
        None => Ok(()),
    }
}

/// One label: its room's record of its store, against the whole list. `Ok(false)` when the room gave no answer to
/// read, which keeps this walk from deciding any orphan.
#[allow(clippy::too_many_arguments)]
async fn one_label(
    sql: &SqlStorage,
    env: &Env,
    provider: &StoreProvider,
    list: &[(String, String)],
    at: &Walk,
    label: &str,
    room: &str,
    tally: &mut Tally,
) -> R<bool> {
    tally.asked += 1;
    let Some(answer) = ask_room(env, room, json!({ "kind": "store", "label": label })).await else {
        return Ok(false);
    };
    let Some(known) = answer["known"].as_bool() else {
        return Ok(false);
    };
    let store = &answer["store"];
    if !known || store.is_null() {
        return Ok(true);
    }
    if !store.is_object() {
        return Ok(false);
    }
    let record = StoreRecord {
        kind: store["kind"].as_str(),
        name: store["name"].as_str(),
        id: store["id"].as_str(),
        made_at: store["made_at"].as_i64(),
        delete_owed_at: store["delete_owed_at"].as_i64(),
        gone_at: store["gone_at"].as_i64(),
    };
    // The name is the room's, whatever the record's state: no store of that name is an orphan this walk.
    if let Some(name) = record
        .name
        .filter(|name| (1..=NAME_MAX).contains(&name.len()))
    {
        exec(
            sql,
            "INSERT INTO store_claim (name, walk) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET walk = excluded.walk",
            vec![name.into(), at.walk.into()],
        )?;
        untell(sql, STORE_ORPHAN, name)?;
    }
    match check_record(&record, list) {
        RecordCheck::Fine => {
            if record.id.is_some() {
                seen_there(sql, label, record.name)?;
            }
        }
        RecordCheck::Unknown => {}
        RecordCheck::Settle(id) => {
            let Some(name) = record.name else {
                return Ok(true);
            };
            let Some(settled) = ask_room(
                env,
                room,
                json!({ "kind": "store", "label": label, "settle": { "name": name, "id": id } }),
            )
            .await
            else {
                return Ok(false);
            };
            if settled["settled"] == true {
                tally.settled += 1;
                tell(sql, STORE_ID_SETTLED, name, now_ms())?;
            }
        }
        RecordCheck::ReadById => {
            let (Some(id), Some(name)) = (record.id, record.name) else {
                return Ok(true);
            };
            match provider.read(id, name).await {
                StoreRead::Gone => {
                    if read_gone(sql, label, id, name, now_ms())? {
                        tally.made_gone += 1;
                    }
                }
                StoreRead::Present => seen_there(sql, label, Some(name))?,
                // Neither: nothing is noted, and it is read again next time.
                StoreRead::Unknown => {}
            }
        }
    }
    Ok(true)
}

/// The walk has reached the end of the lookup table: if it is still the walk this pass began with, every room answered,
/// each Podster-named store listed since before it began that no room recorded in it is told as an orphan; then a new
/// walk begins. Another pass that ended it first leaves nothing to do.
fn end_walk(sql: &SqlStorage, at: &Walk, now: i64, tally: &mut Tally) -> R<()> {
    let Some(stored) = rows(
        sql,
        "SELECT walk, started_at, whole FROM store_walk",
        vec![],
    )?
    .into_iter()
    .next() else {
        return Ok(());
    };
    if int(&stored["walk"]) != at.walk {
        return Ok(());
    }
    let whole = int(&stored["whole"]) == 1;
    let started = int(&stored["started_at"]);
    for row in rows(
        sql,
        "SELECT l.name, l.first_listed_at, EXISTS (SELECT 1 FROM store_claim c WHERE c.name = l.name AND c.walk = ?) AS claimed FROM store_listed l",
        vec![at.walk.into()],
    )? {
        let Some(name) = text(&row["name"]) else {
            continue;
        };
        if is_orphan(
            int(&row["first_listed_at"]),
            int(&row["claimed"]) == 1,
            started,
            whole,
        ) {
            tally.orphans += 1;
            tell(sql, STORE_ORPHAN, &name, now)?;
        }
    }
    exec(
        sql,
        "UPDATE store_walk SET cursor = NULL, walk = walk + 1, started_at = ?, whole = 1",
        vec![now.into()],
    )?;
    exec(
        sql,
        "DELETE FROM store_claim WHERE walk < ?",
        vec![at.walk.into()],
    )
}

async fn run(sql: &SqlStorage, env: &Env, tally: &mut Tally) -> R<&'static str> {
    let Some(provider) = StoreProvider::for_reconcile(env) else {
        return Ok("no_store_provider");
    };
    let started = now_ms();
    let deadline = started + crate::reconcile::budget(sql, "stores", STORE_BUDGET_MS);
    exec(
        sql,
        "DELETE FROM store_gone_read WHERE last_at < ?",
        vec![(started - GONE_KEPT_MS).into()],
    )?;
    // Begun before the list is read, so a walk's first pass counts no name it lists as listed before the walk began.
    let at = walk(sql, started)?;
    let Some(list) = provider.list().await else {
        tell(sql, STORE_LIST_UNREAD, "d1", now_ms())?;
        return Ok("list_unread");
    };
    untell(sql, STORE_LIST_UNREAD, "d1")?;
    tally.listed = note_listed(sql, &list, now_ms())?;
    let labels = env
        .d1("DB")?
        .prepare("SELECT label, workspace_id FROM app_label_index WHERE label > ? ORDER BY label LIMIT ?")
        .bind(&[
            at.cursor.clone().unwrap_or_default().into(),
            (STORE_BATCH as f64).into(),
        ])?
        .all()
        .await?
        .results::<Value>()?;
    let mut reached_end = (labels.len() as i64) < STORE_BATCH;
    let mut cursor = at.cursor.clone();
    for row in &labels {
        if now_ms() > deadline {
            reached_end = false;
            break;
        }
        let (Some(label), Some(room)) = (row["label"].as_str(), row["workspace_id"].as_str())
        else {
            continue;
        };
        let answered = match one_label(sql, env, &provider, &list, &at, label, room, tally).await {
            Ok(answered) => answered,
            Err(error) => {
                tally.errors += 1;
                console_error!(
                    "reconcile: a store's step was skipped: code={}",
                    error.code().unwrap_or("internal_error")
                );
                false
            }
        };
        if !answered {
            tally.unanswered += 1;
            exec(
                sql,
                "UPDATE store_walk SET whole = 0 WHERE walk = ?",
                vec![at.walk.into()],
            )?;
        }
        cursor = Some(label.to_owned());
    }
    if reached_end {
        end_walk(sql, &at, now_ms(), tally)?;
    } else {
        exec(
            sql,
            "UPDATE store_walk SET cursor = ? WHERE walk = ?",
            vec![cursor.into(), at.walk.into()],
        )?;
    }
    Ok("ok")
}

/// The store step of the hourly pass. It never fails the pass: a failure of its own is logged by its code and answered
/// as its summary's code.
pub(crate) async fn pass(sql: &SqlStorage, env: &Env) -> Value {
    let mut tally = Tally::default();
    let code = match run(sql, env, &mut tally).await {
        Ok(code) => code,
        Err(error) => {
            tally.errors += 1;
            console_error!(
                "reconcile: the store step failed: code={}",
                error.code().unwrap_or("internal_error")
            );
            "failed"
        }
    };
    console_log!(
        "reconcile: stores: code={} listed={} asked={} settled={} orphans={} made_gone={} unanswered={} errors={}",
        code,
        tally.listed,
        tally.asked,
        tally.settled,
        tally.orphans,
        tally.made_gone,
        tally.unanswered,
        tally.errors
    );
    json!({
        "code": code, "listed": tally.listed, "asked": tally.asked, "settled": tally.settled, "orphans": tally.orphans,
        "made_gone": tally.made_gone, "unanswered": tally.unanswered, "errors": tally.errors,
    })
}

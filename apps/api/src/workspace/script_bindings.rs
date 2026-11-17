//! **Rule 3(b)** in the room (S5 of the store plan; the architect's ruling on the store, 2026-11-16, item 3(b)): the
//! hourly reconcile reads one of this room's scripts' bindings with the scripts token and asks the room, whose own
//! record of its label's store decides through `podster_core::app_bindings::check`.
//!
//! **A binding the script may not hold takes the app down as an operator's suspension does** (`takedown::set`): the
//! label is suspended and kept, the app is unpublished in the same transaction, and nothing is served. It is not an
//! unpublish that retires the label. The suspension is Podster's, audited as Podster with the reason `other`, and the
//! reconcile tells operators by the finding `script_binding_foreign`, by the script's name, with why in `detail`. Only
//! an operator lifts it. Suspending an app already suspended changes nothing.
//!
//! **It runs first,** in a transaction of its own, before the room reads its organization's switch or does its
//! release bookkeeping (review standard 4), so nothing slower can hold a takedown up or roll it back.
//!
//! **Unknown decides nothing:** a list that wasn't sent, a record that can't be read, or a binding that can't be told
//! is answered `unknown`, and nothing is written. A script whose name isn't this room's, under a label it never had,
//! is no question for it.
//!
//! Logs carry the room's ID and codes only: never a script's name, a store's ID or a binding.
use super::*;
use podster_core::app_bindings::{check, own_store, ReadBinding, Verdict};
use podster_core::app_store::StoreRecord;
use podster_core::release::{script_owner, ScriptOwner};

/// The room's record of `label`'s store, read as rule 3(b) reads it. `Ok(None)` when it holds none.
fn store_record(sql: &SqlStorage, label: &str) -> R<Option<Value>> {
    Ok(rows(
        sql,
        "SELECT kind, store_name, store_id, made_at, delete_owed_at, gone_at FROM app_store WHERE label = ?",
        vec![label.into()],
    )?
    .into_iter()
    .next())
}

/// One entry of the provider's list, as core reads it: a field is there only as a string.
fn read_binding(entry: &Value) -> ReadBinding<'_> {
    ReadBinding {
        kind: entry["type"].as_str(),
        name: entry["name"].as_str(),
        id: entry["id"].as_str(),
        namespace_id: entry["namespace_id"].as_str(),
        class_name: entry["class_name"].as_str(),
    }
}

/// `{ script, bindings, serve_entries }` from the reconcile, inside the caller's transaction: the verdict, and the
/// app suspended if a binding is one the script may not hold. Answers `None` for a script that is no question for
/// this room, and otherwise `{ verdict, foreign, suspended }`: `verdict` is `clean`, `foreign` or `unknown`,
/// `foreign` is the code of what was found, and `suspended` whether this answer suspended the app.
pub(super) fn check_script(sql: &SqlStorage, body: &Value, now: i64) -> R<Option<Value>> {
    let Some(script) = body["script"].as_str() else {
        return Ok(None);
    };
    let ScriptOwner::Podster { label, .. } = script_owner(script) else {
        return Ok(None);
    };
    if rows(
        sql,
        "SELECT label FROM app_label WHERE label = ?",
        vec![label.into()],
    )?
    .is_empty()
    {
        return Ok(None);
    }
    let record = store_record(sql, label)?;
    let record = record.as_ref().map(|row| StoreRecord {
        kind: row["kind"].as_str(),
        name: row["store_name"].as_str(),
        id: row["store_id"].as_str(),
        made_at: row["made_at"].as_i64(),
        delete_owed_at: row["delete_owed_at"].as_i64(),
        gone_at: row["gone_at"].as_i64(),
    });
    // Anything but an array of objects is no list: an entry that isn't an object is unreadable as a whole.
    let bindings: Option<Vec<ReadBinding<'_>>> = body["bindings"].as_array().and_then(|list| {
        list.iter()
            .map(|entry| entry.is_object().then(|| read_binding(entry)))
            .collect()
    });
    let verdict = check(
        bindings.as_deref(),
        own_store(record.as_ref()),
        body["serve_entries"].as_str(),
    );
    let Verdict::Foreign(found) = verdict else {
        let name = if verdict == Verdict::Clean {
            "clean"
        } else {
            "unknown"
        };
        return Ok(Some(
            json!({ "verdict": name, "foreign": null, "suspended": false }),
        ));
    };
    let was = !rows(
        sql,
        "SELECT label FROM app_label WHERE label = ? AND suspended_at IS NOT NULL",
        vec![label.into()],
    )?
    .is_empty();
    // An operator's suspension, by Podster, on the script's own label: the label is kept, the app unpublished.
    takedown::set(
        sql,
        &json!({ "label": label, "suspended": true, "reason": podster_policy::moderation::Reason::Other.name() }),
        now,
    )?;
    console_error!(
        "takedown: a script holds a binding it may not, and the app was suspended: code={}",
        found.code()
    );
    Ok(Some(json!({
        "verdict": "foreign",
        "foreign": found.code(),
        "suspended": !was,
    })))
}

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
//! **Preview scripts too** (M8 step 6): the hourly pass reads a preview namespace script's bindings through the preview
//! provider and asks the same question with `namespace: "preview"`; only a preview label's script answers it, judged
//! against that label's own store, and a binding it may not hold suspends the app exactly as production's does, which
//! also deletes the preview (`takedown::set`).
//!
//! **Any of the room's labels, current or retired** (the coordinator's ruling on PR #420's review): a script left
//! under a label the room retired is still the room's, and a binding it may not hold suspends the room's app, the
//! cautious side, as an operator's suspension of any label does (`takedown::app_suspended` reads every label). The
//! suspension is recorded on the script's own label, which is the one the finding names, so an operator lifts that.
//!
//! **Within the deployment's ceiling** (`podster_core::app_bindings::suspension_permit`, decided in the `Moderation`
//! object before it asks): the question says `may_suspend`, and without it a foreign verdict suspends nothing and is
//! answered `held`, for operators to see.
//!
//! **What the suspension's unpublish does to the app's scripts** is what any operator's suspension does: every script
//! the room's state named (served, kept, in flight) is queued for deletion, and the next hourly pass queues any other
//! script under the room's labels that nothing claims, the offending one among them. So the offending script is
//! deleted by the room's own delete job, and **a lift before it is gone is undone at the next pass, which reads it
//! again.** The label and the app's store, and so its data, are kept: a wrongly suspended app is recovered by an
//! operator's lift and a new release, which uploads its script again from the repository.
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
use podster_core::app_bindings::{check, own_store, Read, ReadBinding, Verdict};
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

/// One entry of the provider's list, as core reads it: a field is there only as a string, and an entry that isn't an
/// object has none, which core judges unknown beside whatever else the list holds.
fn read_binding(entry: &Value) -> ReadBinding<'_> {
    ReadBinding {
        kind: entry["type"].as_str(),
        name: entry["name"].as_str(),
        id: entry["id"].as_str(),
        namespace_id: entry["namespace_id"].as_str(),
        class_name: entry["class_name"].as_str(),
    }
}

/// `{ script, bindings, bindings_oversized, serve_entries, may_suspend }` from the reconcile, inside the caller's
/// transaction: the verdict, and the app suspended if the script holds what it may not and the ceiling allows. Answers
/// `None` for a script that is no question for this room, and otherwise `{ verdict, foreign, suspended, held }`:
/// `verdict` is `clean`, `foreign` or `unknown`, `foreign` the code of what was found, `suspended` whether this answer
/// suspended the app, and `held` whether only the ceiling kept it from doing so.
pub(super) fn check_script(sql: &SqlStorage, body: &Value, now: i64) -> R<Option<Value>> {
    // Test builds only: a test makes the check itself fail, to show the rest of the reconcile's question still runs.
    #[cfg(feature = "failpoints")]
    if !rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_bindings_check_fails'",
        vec![],
    )?
    .is_empty()
    {
        return Err(ApiError::internal("test: the bindings' check failed"));
    }
    let Some(script) = body["script"].as_str() else {
        return Ok(None);
    };
    let ScriptOwner::Podster { label, .. } = script_owner(script) else {
        return Ok(None);
    };
    // The label must be the room's, **of the namespace's environment** (M8 step 6): a script listed in the preview
    // namespace is judged only as a preview label's, one in production's only as a production label's, so a script in
    // the wrong namespace is no question here, and the store it is judged against is its own environment's.
    let wanted = if body["namespace"] == "preview" {
        "preview"
    } else {
        "production"
    };
    if rows(
        sql,
        "SELECT label FROM app_label WHERE label = ? AND kind = ?",
        vec![label.into(), wanted.into()],
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
    let bindings: Option<Vec<ReadBinding<'_>>> = body["bindings"]
        .as_array()
        .map(|list| list.iter().map(read_binding).collect());
    let read = match (body["bindings_oversized"] == true, &bindings) {
        (true, _) => Read::Oversized,
        (false, Some(list)) => Read::List(list),
        (false, None) => Read::Unread,
    };
    let verdict = check(
        read,
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
            json!({ "verdict": name, "foreign": null, "suspended": false, "held": false }),
        ));
    };
    // Already down, by an operator or by an earlier pass: nothing more to do, and nothing of the ceiling is used.
    if takedown::app_suspended(sql)? {
        return Ok(Some(
            json!({ "verdict": "foreign", "foreign": found.code(), "suspended": false, "held": false }),
        ));
    }
    if body["may_suspend"] != true {
        // Logged as held only when the ceiling was asked and said no (`offered`): a first ask with no slot offered is
        // asked again with one, which may suspend, so saying the ceiling held it then would be wrong (the deep
        // re-review of PR #423, a low item). A question that doesn't say is logged as held, as before.
        if body["offered"] != false {
            console_error!(
                "takedown: a script holds a binding it may not, and the ceiling held the suspension: code={}",
                found.code()
            );
        }
        return Ok(Some(
            json!({ "verdict": "foreign", "foreign": found.code(), "suspended": false, "held": true }),
        ));
    }
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
        "suspended": true,
        "held": false,
    })))
}

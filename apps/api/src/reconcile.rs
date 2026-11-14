//! The two scheduled reconciles (M6 step 4(a), third PR; ADR 0010's "Publishing and unpublishing, in order").
//!
//! They catch what the rooms' appliers and delete jobs missed. **Neither writes or removes a serve entry, and
//! neither deletes a script.** Each lists what the provider holds, finds whose it is, and asks that room, whose
//! current state decides: the room forgets that it applied a host that differs, or queues a script nothing of its
//! claims, and its own applier and delete job do the work. What has no room, or a name Podster didn't make, is told
//! to operators and left alone, so a lookup table that lags can never take a live app down.
//!
//! - **Every 5 minutes, serve entries against rooms** ([`entries`]). A default host finds its room by its label,
//!   through the lookup table, which only routes the question. A custom hostname finds it through the hostname's own
//!   claim object. The stop key is checked against the stop.
//! - **Every hour, scripts in the namespace against rooms** ([`scripts`]), decided by
//!   `podster_core::release::reconcile_script`.
//! - **Both wake rooms.** Each pass also walks a slice of the lookup table and wakes those rooms, which arm their own
//!   alarms if they owe work. That is what corrects a wake that was lost, and what wakes rooms whose work was owed
//!   from before any provider was configured.
//!
//! They run in the `Moderation` object, the one object for the deployment, which keeps where each pass got to and
//! what it found for operators. The Worker's scheduled handler only calls it, on the two schedules `wrangler.jsonc`
//! gives every environment, and only while a content provider is configured, whatever `RELEASES` says (M6 step 6).
//! **With no provider, the handler calls nothing, and a pass asked directly reads nothing, and says so.**
//!
//! One pass is bounded: a page of keys or a slice of scripts, a slice of rooms, and a time after which it starts
//! nothing new. Where it stopped is kept, and the next pass goes on from there.
//!
//! Logs carry codes and counts. Never a host, a label, a script's name or a room's ID. What operators read is state,
//! in this object, and names the host or the script it is about.
use crate::content_provider::{Entry, Provider};
use crate::content_stop;
use crate::error::ApiError;
use crate::forward;
use crate::store::{exec, int, rows, text};
use podster_core::release::{reconcile_script, RoomClaim, ScriptReconcile};
use serde_json::{json, Value};
use worker::*;

type R<T> = std::result::Result<T, ApiError>;

/// The schedules the handler answers to, the two in `wrangler.jsonc`: see the module's note.
pub(crate) const ENTRIES_CRON: &str = "*/5 * * * *";
pub(crate) const SCRIPTS_CRON: &str = "0 * * * *";

/// The `Moderation` object's paths. Nothing outside the Worker reaches them.
pub(crate) const ENTRIES_PATH: &str = "/reconcile/entries";
pub(crate) const SCRIPTS_PATH: &str = "/reconcile/scripts";
pub(crate) const FINDING_PATH: &str = "/takedown-finding";
pub(crate) const FINDINGS_PATH: &str = "/takedown-findings";

/// `takedown_finding`: what an operator should know, one row for each code and subject, counted and dated each time
/// it is seen again. The subject is a host, a script's name or a key, as the provider or a room gave it: data, never
/// read as anything else. `reconcile_pass`: where each pass got to.
pub(crate) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS takedown_finding (code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 64), subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 253),
  detail TEXT CHECK (detail IS NULL OR length(detail) BETWEEN 1 AND 64), first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  seen INTEGER NOT NULL DEFAULT 1 CHECK (typeof(seen) = 'integer' AND seen >= 1), PRIMARY KEY (code, subject)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS reconcile_pass (pass TEXT PRIMARY KEY CHECK (pass IN ('entries', 'scripts', 'wake')), cursor TEXT,
  skip INTEGER NOT NULL DEFAULT 0 CHECK (typeof(skip) = 'integer' AND skip >= 0), stop_seen INTEGER NOT NULL DEFAULT 0 CHECK (stop_seen IN (0, 1)),
  last_run_at INTEGER, last_code TEXT CHECK (last_code IS NULL OR length(last_code) BETWEEN 1 AND 64)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS reconcile_failure (kind TEXT NOT NULL CHECK (kind IN ('entry', 'script')), subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 253),
  failures INTEGER NOT NULL CHECK (typeof(failures) = 'integer' AND failures >= 1), last_code TEXT NOT NULL CHECK (length(last_code) BETWEEN 1 AND 64),
  last_at INTEGER NOT NULL, PRIMARY KEY (kind, subject)) WITHOUT ROWID;
";

/// A key or a script whose step has failed this many passes in a row is told to operators, by its name.
const FAILURES_TOLD: i64 = 3;
/// Keys and scripts whose failures are counted at once. Past it a new one isn't counted until one leaves.
const MAX_FAILING: i64 = 1000;
/// The kinds of finding with room of their own, 1,000 rows each: a deletion a reconcile started, a host a room
/// refused, and the stop key not as the stop says. Whatever fills the rest of the record, three passes of an outage
/// that writes a thousand keys that keep failing among it, can't keep one of these out.
const OWN_ROOM: [&str; 5] = [
    "script_delete_queued",
    "host_refused",
    "stop_key_differs",
    "stop_key_without_stop",
    // A room whose release bookkeeping keeps failing. One row for an app at most, so a thousand apps before it fills.
    "release_bookkeeping_failing",
];
/// How many findings are taken from one room's answer. A room's answer is built never to hold more
/// (`workspace::takedown`), and that is checked when the Worker is compiled.
pub(crate) const ROOM_FINDINGS_TAKEN: usize = 48;
/// What a room that gave no answer is counted as, in this object's own record. It is no answer to any caller.
const UNANSWERED: &str = "room_unanswered";

/// How one key's or one script's step ended, when it didn't end well.
enum Stopped {
    /// Something failed.
    Failed(ApiError),
    /// The room that had to answer gave no answer.
    Unanswered,
}

impl From<ApiError> for Stopped {
    fn from(error: ApiError) -> Self {
        Stopped::Failed(error)
    }
}

type Step = std::result::Result<(), Stopped>;

/// How long a pass may go on starting new steps over its list, and how long the walk may. Test builds also read a
/// table a test makes in the object, `test_reconcile_budget`, so each bound can be shown without waiting it out.
fn budget(sql: &SqlStorage, name: &str, default: i64) -> i64 {
    #[cfg(feature = "failpoints")]
    if let Ok(found) = rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_reconcile_budget'",
        vec![],
    ) {
        if !found.is_empty() {
            if let Some(row) = rows(
                sql,
                "SELECT ms FROM test_reconcile_budget WHERE name = ?",
                vec![name.into()],
            )
            .ok()
            .and_then(|found| found.into_iter().next())
            {
                return int(&row["ms"]);
            }
        }
    }
    let _ = (sql, name);
    default
}

/// Findings kept at once. Past it a new one isn't kept, and one row says the record is full.
const MAX_FINDINGS: i64 = 1000;
/// Findings an operator reads at once, most recently seen first.
const FINDINGS_PAGE: i64 = 200;
/// A finding nothing has seen again for this long is forgotten.
const FINDING_KEPT_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Scripts asked about in one hourly pass.
const SCRIPT_BATCH: usize = 100;
/// Rooms woken in one pass, from the lookup table.
const WAKE_BATCH: i64 = 50;
/// How long one pass may go on starting new steps over what it listed.
const PASS_BUDGET_MS: i64 = 20_000;
/// How long the walk that wakes rooms may go on starting new steps. Its own, counted from when the walk starts, so
/// a provider that was slow over the list leaves the walk its whole time.
const WAKE_BUDGET_MS: i64 = 10_000;
const SUBJECT_MAX: usize = 253;

fn now_ms() -> i64 {
    Date::now().as_millis() as i64
}

/// Keeps one finding, or counts it again. A subject is cut to what a hostname may be, and an empty one is dropped.
fn record(sql: &SqlStorage, code: &str, subject: &str, detail: Option<&str>, now: i64) -> R<()> {
    let subject: String = subject.chars().take(SUBJECT_MAX).collect();
    let code_ok = (1..=64).contains(&code.len())
        && code
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    if subject.is_empty() || !code_ok {
        return Ok(());
    }
    let detail = detail
        .filter(|detail| (1..=64).contains(&detail.len()))
        .map(str::to_owned);
    let known = !rows(
        sql,
        "SELECT 1 AS known FROM takedown_finding WHERE code = ? AND subject = ?",
        vec![code.into(), subject.as_str().into()],
    )?
    .is_empty();
    // A kind with room of its own is counted alone. Everything else shares the rest. Each up to the cap.
    let own = OWN_ROOM.contains(&code);
    let held = if own {
        rows(
            sql,
            "SELECT count(*) AS n FROM takedown_finding WHERE code = ?",
            vec![code.into()],
        )?
    } else {
        rows(
            sql,
            &format!(
                "SELECT count(*) AS n FROM takedown_finding WHERE code NOT IN ({})",
                vec!["?"; OWN_ROOM.len()].join(", ")
            ),
            OWN_ROOM.iter().map(|code| (*code).into()).collect(),
        )?
    }
    .first()
    .map_or(0, |row| int(&row["n"]));
    let (code, subject, detail) = if !known && held >= MAX_FINDINGS {
        // One row for each kind that is full, named by the kind, or `other` for the shared rest.
        let which = if own { code } else { "other" };
        ("findings_full", which.to_owned(), None)
    } else {
        (code, subject, detail)
    };
    exec(
        sql,
        "INSERT INTO takedown_finding (code, subject, detail, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (code, subject) DO UPDATE SET detail = excluded.detail, last_seen_at = excluded.last_seen_at, seen = seen + 1",
        vec![
            code.into(),
            subject.into(),
            detail.into(),
            now.into(),
            now.into(),
        ],
    )
}

/// `{ code, subject, detail? }` from another object of the Worker's: kept as [`record`] keeps one.
pub(crate) fn keep(sql: &SqlStorage, body: &Value, now: i64) -> R<()> {
    let (Some(code), Some(subject)) = (body["code"].as_str(), body["subject"].as_str()) else {
        return Err(ApiError::invalid_argument());
    };
    record(sql, code, subject, body["detail"].as_str(), now)
}

/// What an operator reads: `{ findings: [{ code, subject, detail, first_seen_at, last_seen_at, seen }] }`, the most
/// recently seen first. No room's ID is among them.
pub(crate) fn list(sql: &SqlStorage) -> R<Value> {
    let findings = rows(
        sql,
        "SELECT code, subject, detail, first_seen_at, last_seen_at, seen FROM takedown_finding ORDER BY last_seen_at DESC, code, subject LIMIT ?",
        vec![FINDINGS_PAGE.into()],
    )?;
    Ok(json!({ "findings": findings }))
}

struct Pass {
    cursor: Option<String>,
    skip: usize,
    stop_seen: bool,
}

fn pass(sql: &SqlStorage, name: &str) -> R<Pass> {
    Ok(rows(
        sql,
        "SELECT cursor, skip, stop_seen FROM reconcile_pass WHERE pass = ?",
        vec![name.into()],
    )?
    .first()
    .map_or(
        Pass {
            cursor: None,
            skip: 0,
            stop_seen: false,
        },
        |row| Pass {
            cursor: text(&row["cursor"]),
            skip: int(&row["skip"]).max(0) as usize,
            stop_seen: int(&row["stop_seen"]) == 1,
        },
    ))
}

fn set_pass(sql: &SqlStorage, name: &str, at: &Pass, code: Option<&str>, now: i64) -> R<()> {
    exec(
        sql,
        "INSERT INTO reconcile_pass (pass, cursor, skip, stop_seen, last_run_at, last_code) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (pass) DO UPDATE SET cursor = excluded.cursor, skip = excluded.skip, stop_seen = excluded.stop_seen,
             last_run_at = excluded.last_run_at, last_code = excluded.last_code",
        vec![
            name.into(),
            at.cursor.clone().into(),
            (at.skip as i64).into(),
            i64::from(at.stop_seen).into(),
            now.into(),
            code.map(str::to_owned).into(),
        ],
    )
}

/// Asks one room the reconcile's question. `None` when the room gave no answer to read.
async fn ask_room(env: &Env, room: &str, question: Value) -> Option<Value> {
    let asked = async {
        let stub = env
            .durable_object("WORKSPACE")?
            .id_from_name(room)?
            .get_stub()?;
        let mut response = forward(
            stub,
            crate::workspace::INTERNAL_TAKEDOWN_CHECK,
            "",
            Headers::new(),
            Method::Post,
            Some(question.to_string()),
        )
        .await?;
        if response.status_code() != 200 {
            return Err(ApiError::internal("room didn't answer"));
        }
        Ok::<Value, ApiError>(response.json().await?)
    };
    asked.await.ok()
}

/// The room that holds a custom hostname's claim, by the hostname's own object, which is also woken.
async fn room_for_hostname(env: &Env, hostname: &str) -> Option<Option<String>> {
    let asked = async {
        let stub = env
            .durable_object("HOSTNAME_CLAIM")?
            .id_from_name(hostname)?
            .get_stub()?;
        let mut response = forward(
            stub,
            crate::hostname_claim::INTERNAL_WAKE,
            "",
            Headers::new(),
            Method::Post,
            None,
        )
        .await?;
        if response.status_code() != 200 {
            return Err(ApiError::internal("claim didn't answer"));
        }
        Ok::<Value, ApiError>(response.json().await?)
    };
    let held = asked.await.ok()?;
    Some(held["claim"]["workspace_id"].as_str().map(str::to_owned))
}

#[derive(Default)]
struct Counts {
    asked: u32,
    changed: u32,
    found: u32,
    unanswered: u32,
    /// Steps that failed and were skipped: one key, one script or one room. The pass goes on past each.
    errors: u32,
    /// Entries the provider gave no readable answer for. Told as one finding, however many.
    unread: u32,
}

impl Counts {
    /// Takes a room's answer: what changed, and what it has for operators.
    fn take(&mut self, sql: &SqlStorage, answer: &Value, now: i64) -> R<()> {
        self.asked += 1;
        if answer["changed"] == true {
            self.changed += 1;
        }
        for finding in answer["findings"]
            .as_array()
            .into_iter()
            .flatten()
            .take(ROOM_FINDINGS_TAKEN)
        {
            if let (Some(code), Some(subject)) =
                (finding["code"].as_str(), finding["subject"].as_str())
            {
                record(sql, code, subject, finding["detail"].as_str(), now)?;
                self.found += 1;
            }
        }
        Ok(())
    }

    fn finding(&mut self, sql: &SqlStorage, code: &str, subject: &str, now: i64) -> R<()> {
        self.found += 1;
        record(sql, code, subject, None, now)
    }

    /// One step failed. It is counted and logged by its code, and the pass goes on: one bad key never stalls its
    /// page, the stop key's check, the walk or the object's alarm.
    fn skipped(&mut self, step: R<()>) {
        if let Err(error) = step {
            self.errors += 1;
            console_error!(
                "reconcile: a step was skipped: code={}",
                error.code().unwrap_or("internal_error")
            );
        }
    }

    /// One key's or one script's step is over. A failure, a room that gave no answer among them, is counted for
    /// that name, pass after pass: at the third in a row operators are told, by the name and the code, and again on
    /// each failure after. A step that worked forgets the count.
    fn settled(&mut self, sql: &SqlStorage, kind: &str, subject: &str, step: Step, now: i64) {
        let subject: String = subject.chars().take(SUBJECT_MAX).collect();
        let code = match step {
            Ok(()) => {
                let forgotten = exec(
                    sql,
                    "DELETE FROM reconcile_failure WHERE kind = ? AND subject = ?",
                    vec![kind.into(), subject.into()],
                );
                return self.skipped(forgotten);
            }
            Err(Stopped::Unanswered) => {
                self.unanswered += 1;
                UNANSWERED
            }
            Err(Stopped::Failed(error)) => {
                let code = error.code().unwrap_or("internal_error");
                self.skipped(Err(error));
                code
            }
        };
        if subject.is_empty() {
            return;
        }
        let counted = (|| -> R<()> {
            let known = rows(
                sql,
                "SELECT failures FROM reconcile_failure WHERE kind = ? AND subject = ?",
                vec![kind.into(), subject.as_str().into()],
            )?
            .first()
            .map(|row| int(&row["failures"]));
            let held = rows(sql, "SELECT count(*) AS n FROM reconcile_failure", vec![])?
                .first()
                .map_or(0, |row| int(&row["n"]));
            if known.is_none() && held >= MAX_FAILING {
                return record(sql, "failures_full", "reconcile_failure", None, now);
            }
            let failures = known.unwrap_or(0) + 1;
            exec(
                sql,
                "INSERT INTO reconcile_failure (kind, subject, failures, last_code, last_at) VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT (kind, subject) DO UPDATE SET failures = excluded.failures, last_code = excluded.last_code, last_at = excluded.last_at",
                vec![
                    kind.into(),
                    subject.as_str().into(),
                    failures.into(),
                    code.into(),
                    now.into(),
                ],
            )?;
            if failures >= FAILURES_TOLD {
                self.found += 1;
                let told = if kind == "script" {
                    "script_keeps_failing"
                } else {
                    "entry_keeps_failing"
                };
                record(sql, told, &subject, Some(code), now)?;
            }
            Ok(())
        })();
        self.skipped(counted);
    }
}

/// Whose a key is, without asking anyone.
enum Key<'a> {
    Stop,
    /// `<label>.<content domain>`: an app's default host, with its label.
    Default(&'a str),
    /// A name off the content domain, written as Podster writes names.
    Custom,
    /// Anything else: not a host Podster would have written an entry for.
    Foreign,
}

fn key_of<'a>(provider: &Provider, key: &'a str) -> Key<'a> {
    if key == crate::content_provider::STOP_KEY {
        return Key::Stop;
    }
    if podster_core::hostnames::normalize(key).ok().as_deref() != Some(key) {
        return Key::Foreign;
    }
    match provider.default_host_label(key) {
        Some(label) => Key::Default(label),
        None if provider.on_content_domain(key) => Key::Foreign,
        None => Key::Custom,
    }
}

/// One serve entry. Its room is found, the entry is read, and the room is asked.
async fn entry(
    sql: &SqlStorage,
    env: &Env,
    provider: &Provider,
    host: &str,
    room: Option<String>,
    counts: &mut Counts,
) -> Step {
    let Some(room) = room else {
        return Ok(counts.finding(sql, "entry_without_room", host, now_ms())?);
    };
    let found = match provider.read_entry(host).await {
        // Gone since it was listed: nothing to ask about.
        Entry::Absent => return Ok(()),
        Entry::Present(script) => Some(script),
        // There, and not a script's name Rust made: something else wrote it. Operators are told, by the host, and
        // the room is asked as for one that differs from anything it could want.
        Entry::Foreign => {
            counts.finding(sql, "entry_unreadable", host, now_ms())?;
            None
        }
        // No answer that says what is there. The room is asked the same way, which can only make it write again.
        // It is counted, and the pass tells operators once, however many: an outage of the provider's reads would
        // otherwise write one finding for every host.
        Entry::Unknown => {
            counts.unread += 1;
            None
        }
    };
    let Some(answer) = ask_room(
        env,
        &room,
        json!({ "kind": "entry", "host": host, "found": found }),
    )
    .await
    else {
        return Err(Stopped::Unanswered);
    };
    let now = now_ms();
    counts.take(sql, &answer, now)?;
    if answer["known"] != true {
        counts.finding(sql, "entry_without_room", host, now)?;
    }
    Ok(())
}

/// Wakes a slice of the rooms the lookup table names, from where the last pass stopped, and takes what each has for
/// operators. The table only says which rooms to ask: a room that isn't there answers that it knows nothing.
async fn wake_rooms(sql: &SqlStorage, env: &Env, counts: &mut Counts) -> R<u32> {
    let deadline = now_ms() + budget(sql, "wake", WAKE_BUDGET_MS);
    let mut at = pass(sql, "wake")?;
    let listed = env
        .d1("DB")?
        .prepare("SELECT label, workspace_id FROM app_label_index WHERE label > ? ORDER BY label LIMIT ?")
        .bind(&[
            at.cursor.clone().unwrap_or_default().into(),
            (WAKE_BATCH as f64).into(),
        ])?
        .all()
        .await?
        .results::<Value>()?;
    let mut woken = 0;
    let mut reached_end = (listed.len() as i64) < WAKE_BATCH;
    for row in &listed {
        if now_ms() > deadline {
            reached_end = false;
            break;
        }
        let (Some(label), Some(room)) = (row["label"].as_str(), row["workspace_id"].as_str())
        else {
            continue;
        };
        match ask_room(env, room, json!({ "kind": "wake" })).await {
            Some(answer) => {
                let taken = counts.take(sql, &answer, now_ms());
                counts.skipped(taken);
            }
            None => counts.unanswered += 1,
        }
        woken += 1;
        at.cursor = Some(label.to_owned());
    }
    if reached_end {
        at.cursor = None;
    }
    set_pass(sql, "wake", &at, None, now_ms())?;
    Ok(woken)
}

fn summary(pass: &str, code: &str, listed: usize, counts: &Counts, woken: u32) -> Value {
    console_log!(
        "reconcile: pass={} code={} listed={} asked={} changed={} findings={} unanswered={} errors={} woken={}",
        pass,
        code,
        listed,
        counts.asked,
        counts.changed,
        counts.found,
        counts.unanswered,
        counts.errors,
        woken
    );
    json!({
        "ran": code != "no_provider", "code": code, "listed": listed, "asked": counts.asked, "changed": counts.changed,
        "findings": counts.found, "unanswered": counts.unanswered, "errors": counts.errors, "woken": woken,
    })
}

/// The walk, with a failure of its own counted and never passed on: it doesn't undo the pass that came before it.
async fn wake(sql: &SqlStorage, env: &Env, counts: &mut Counts) -> u32 {
    match wake_rooms(sql, env, counts).await {
        Ok(woken) => woken,
        Err(error) => {
            counts.skipped(Err(error));
            0
        }
    }
}

/// One listed key: whose it is, and what its room says.
async fn one_key(
    sql: &SqlStorage,
    env: &Env,
    provider: &Provider,
    key: &str,
    counts: &mut Counts,
) -> Step {
    match key_of(provider, key) {
        // The caller remembers it.
        Key::Stop => Ok(()),
        Key::Foreign => Ok(counts.finding(sql, "entry_foreign_name", key, now_ms())?),
        Key::Default(label) => {
            let room = crate::releases::room_for_label(env, label).await?;
            entry(sql, env, provider, key, room, counts).await
        }
        Key::Custom => match room_for_hostname(env, key).await {
            Some(room) => entry(sql, env, provider, key, room, counts).await,
            None => Err(Stopped::Unanswered),
        },
    }
}

/// One listed script. Core decides. With no room yet: a name Podster didn't make is told and left alone, and for any
/// other the room is found and asked. Only the label's own room, from its current state, can make a script deletable.
async fn one_script(
    sql: &SqlStorage,
    env: &Env,
    id: &str,
    listed_at: i64,
    counts: &mut Counts,
) -> Step {
    let now = now_ms();
    if reconcile_script(id, RoomClaim::NoRoom, now) == ScriptReconcile::ReportForeign {
        return Ok(counts.finding(sql, "script_foreign_name", id, now)?);
    }
    let label = id.split('.').next().unwrap_or_default();
    let Some(room) = crate::releases::room_for_label(env, label).await? else {
        return Ok(counts.finding(sql, "script_without_room", id, now)?);
    };
    // With when the list was read: a script the room counted gone since then is in the list only because the list is
    // older than the deletion, and isn't found again.
    match ask_room(
        env,
        &room,
        json!({ "kind": "script", "script": id, "listed_at": listed_at }),
    )
    .await
    {
        Some(answer) => {
            counts.take(sql, &answer, now_ms())?;
            if answer["known"] != true {
                counts.finding(sql, "script_without_room", id, now_ms())?;
            }
            Ok(())
        }
        None => Err(Stopped::Unanswered),
    }
}

/// What the pass is recorded as having been, once the walk is over too: a pass that skipped a step, or met a room
/// that gave no answer, never reads as plain `ok`.
fn finish(sql: &SqlStorage, name: &str, code: &'static str, counts: &Counts) -> &'static str {
    if code != "ok" || (counts.errors == 0 && counts.unanswered == 0) {
        return code;
    }
    if let Err(error) = exec(
        sql,
        "UPDATE reconcile_pass SET last_code = 'errors' WHERE pass = ?",
        vec![name.into()],
    ) {
        console_error!(
            "reconcile: a pass's outcome wasn't recorded: code={}",
            error.code().unwrap_or("internal_error")
        );
    }
    "errors"
}

/// A deployment whose release setting, `RELEASES`, is neither exactly `true` nor exactly `false` (M6 step 6): nothing
/// is released and nothing taken down, and operators are told once by each pass, by one finding, until it is set
/// one way or the other. The code is logged, with no ID. **The first pass that reads it decided takes the finding
/// away,** so operators' record says only what is so now.
async fn tell_undecided_setting(sql: &SqlStorage, env: &Env) {
    if crate::releases::setting(env).await != podster_core::release::DeploymentRelease::Undecided {
        if let Err(error) = exec(
            sql,
            "DELETE FROM takedown_finding WHERE code = 'release_setting_undecided' AND subject = 'RELEASES'",
            vec![],
        ) {
            console_error!(
                "reconcile: a decided release setting's finding wasn't cleared: code={}",
                error.code().unwrap_or("internal_error")
            );
        }
        return;
    }
    console_error!("reconcile: the deployment's release setting is neither true nor false: code=release_setting_undecided");
    if let Err(error) = record(sql, "release_setting_undecided", "RELEASES", None, now_ms()) {
        console_error!(
            "reconcile: an undecided release setting wasn't kept for operators: code={}",
            error.code().unwrap_or("internal_error")
        );
    }
}

/// The 5-minute pass, in the `Moderation` object: one page of serve entries against their rooms, the stop key
/// against the stop, and a slice of rooms woken.
pub(crate) async fn entries(sql: &SqlStorage, env: &Env) -> R<Value> {
    let mut counts = Counts::default();
    let Some(provider) = content_stop::provider(env, sql) else {
        console_log!("reconcile: no provider is configured, so no serve entry was read");
        return Ok(summary("entries", "no_provider", 0, &counts, 0));
    };
    tell_undecided_setting(sql, env).await;
    let started = now_ms();
    let deadline = started + budget(sql, "pass", PASS_BUDGET_MS);
    for table in [
        "DELETE FROM takedown_finding WHERE last_seen_at < ?",
        "DELETE FROM reconcile_failure WHERE last_at < ?",
    ] {
        let pruned = exec(sql, table, vec![(started - FINDING_KEPT_MS).into()]);
        counts.skipped(pruned);
    }
    let mut at = pass(sql, "entries")?;
    let Some(page) = provider.list_entries(at.cursor.as_deref()).await else {
        // No list, or a cursor the provider no longer takes: the next pass starts the list again.
        let start = Pass {
            cursor: None,
            skip: 0,
            stop_seen: false,
        };
        set_pass(sql, "entries", &start, Some("list_failed"), now_ms())?;
        let woken = wake(sql, env, &mut counts).await;
        return Ok(summary("entries", "list_failed", 0, &counts, woken));
    };
    let mut done = at.skip.min(page.keys.len());
    let mut stopped_early = false;
    for key in page.keys.iter().skip(done) {
        if now_ms() > deadline {
            stopped_early = true;
            break;
        }
        if key == crate::content_provider::STOP_KEY {
            at.stop_seen = true;
        }
        let step = one_key(sql, env, &provider, key, &mut counts).await;
        counts.settled(sql, "entry", key, step, now_ms());
        done += 1;
    }
    let mut code = "ok";
    if stopped_early {
        // The same page again next time, from the key this pass didn't reach.
        at.skip = done;
        code = "out_of_time";
    } else if page.cursor.is_some() {
        at.cursor = page.cursor;
        at.skip = 0;
    } else {
        // The whole list has been read, over one pass or several. Only now is the stop key known to be there or not.
        match content_stop::recheck_key(sql, at.stop_seen) {
            Ok(Some(differs)) => {
                counts.changed += 1;
                let told =
                    counts.finding(sql, differs, crate::content_provider::STOP_KEY, now_ms());
                counts.skipped(told);
            }
            Ok(None) => {}
            Err(error) => counts.skipped(Err(error)),
        }
        at = Pass {
            cursor: None,
            skip: 0,
            stop_seen: false,
        };
    }
    if counts.unread > 0 {
        // One finding for the pass, with how many: the provider's reads are failing.
        let told = record(
            sql,
            "entry_reads_failing",
            "serve-entries",
            Some(&counts.unread.to_string()),
            now_ms(),
        );
        counts.found += 1;
        counts.skipped(told);
    }
    set_pass(sql, "entries", &at, Some(code), now_ms())?;
    let woken = wake(sql, env, &mut counts).await;
    let code = finish(sql, "entries", code, &counts);
    Ok(summary("entries", code, page.keys.len(), &counts, woken))
}

/// The hourly pass, in the `Moderation` object: a slice of the namespace's scripts against their rooms, and a slice
/// of rooms woken.
pub(crate) async fn scripts(sql: &SqlStorage, env: &Env) -> R<Value> {
    let mut counts = Counts::default();
    let Some(provider) = content_stop::provider(env, sql) else {
        console_log!("reconcile: no provider is configured, so no script was listed");
        return Ok(summary("scripts", "no_provider", 0, &counts, 0));
    };
    tell_undecided_setting(sql, env).await;
    let started = now_ms();
    let deadline = started + budget(sql, "pass", PASS_BUDGET_MS);
    let mut at = pass(sql, "scripts")?;
    // Taken before the list is asked for: whatever the list holds, the provider read it after this.
    let listed_at = now_ms();
    let Some(list) = provider.list_scripts().await else {
        set_pass(sql, "scripts", &at, Some("list_failed"), now_ms())?;
        let woken = wake(sql, env, &mut counts).await;
        return Ok(summary("scripts", "list_failed", 0, &counts, woken));
    };
    let mut code = "ok";
    if !list.complete {
        // More scripts than this answer held, and how the list pages was never seen. What was listed is still asked
        // about: nothing here deletes on a list's word, so a short list can only miss a script, never lose one.
        let told = counts.finding(sql, "script_list_incomplete", "namespace", now_ms());
        counts.skipped(told);
        code = "list_incomplete";
    }
    let mut ids = list.ids;
    ids.sort();
    ids.dedup();
    let after = at.cursor.clone().unwrap_or_default();
    let todo: Vec<&String> = ids
        .iter()
        .filter(|id| id.as_str() > after.as_str())
        .take(SCRIPT_BATCH)
        .collect();
    let mut reached_end =
        ids.iter().filter(|id| id.as_str() > after.as_str()).count() <= SCRIPT_BATCH;
    for id in todo {
        if now_ms() > deadline {
            reached_end = false;
            code = "out_of_time";
            break;
        }
        at.cursor = Some(id.clone());
        let step = one_script(sql, env, id, listed_at, &mut counts).await;
        counts.settled(sql, "script", id, step, now_ms());
    }
    if reached_end {
        at.cursor = None;
    }
    set_pass(sql, "scripts", &at, Some(code), now_ms())?;
    let woken = wake(sql, env, &mut counts).await;
    let code = finish(sql, "scripts", code, &counts);
    Ok(summary("scripts", code, ids.len(), &counts, woken))
}

/// The Worker's scheduled handler, on the two schedules in `wrangler.jsonc` (M6 step 6). **It runs whenever a
/// content provider is configured, whatever `RELEASES` says,** so a deployment that switches release off still has
/// its rooms woken, and each takes its app down at the walk's question (ADR 0010's deployment trigger). **With no
/// provider configured, which is every deployment today, it returns before it calls any Durable Object:** the cron's
/// own invocation is all it costs. It does nothing for a schedule it doesn't know.
#[event(scheduled)]
pub async fn scheduled(event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    if Provider::from_env(&env).is_none() {
        return;
    }
    let path = match event.cron().as_str() {
        ENTRIES_CRON => ENTRIES_PATH,
        SCRIPTS_CRON => SCRIPTS_PATH,
        _ => {
            console_error!("reconcile: a schedule nothing answers to fired: code=unknown_schedule");
            return;
        }
    };
    let ran = crate::moderation::call(&env, path, Method::Post, None)
        .await
        .is_ok_and(|response| response.status_code() == 200);
    if !ran {
        console_error!("reconcile: a pass didn't run: code=pass_failed");
    }
}

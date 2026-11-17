//! The room's custom hostname: its request, its challenge, and the claim (M6 step 8's first PR; ADR 0010's "Custom
//! domains", steps 0 to 4; decisions 201 and 207). `getAppHostname`, `requestAppHostname` and `removeAppHostname`,
//! and the room's proof job.
//!
//! **Who and where** are `podster_policy::release::authorize_custom_hostname`: the room's owner or an admin, as a
//! person, with that authority holding, and never an agent. Asking needs everything a change to the release
//! configuration needs, release switched on in the room among them; removing is always theirs, since it only takes
//! down.
//!
//! **Asking** normalizes the name and refuses what `podster_core::hostnames::mappable` refuses, the name's suspension
//! read from the hostname's own object first. It commits a pending request with a random value made for it alone and
//! the name's generation as the object gave it. **A pending request reserves nothing.**
//!
//! **The proof job,** from the room's alarm, while release is switched on for the deployment and in the room and a
//! resolver is configured, which no environment has: it reads the TXT records at `_podster-challenge.<hostname>`, and
//! only when one is the request's own value does it record the proof and then ask the hostname's object for the claim.
//! An ask whose answer was lost is asked again whatever the switches say since. The object's answer is recorded only
//! for a request still pending (`podster_core::hostname_requests::after_ask`).
//!
//! **The ask is never taken back by the room's own clock.** Once the proof was recorded, the object may already have
//! given the claim, so only its answer, or a withdrawal it has recorded, ends that request. A request removed, or set
//! ending by a suspension's notice, before the room committed a claim is **withdrawn** at the object, which frees any
//! claim it gave for it and never grants it after. A claim the room committed ends the long way, which is the next
//! PRs': the room stops serving on the name here, and the custom hostname at Cloudflare is deleted and read until gone
//! before the claim is freed: built in 8b, in `custom_hostname`.
//!
//! **An answer of suspended or ending goes `ending`, not refused** (`after_ask`): either is decided before whose the
//! claim is, so the object may hold one it gave this very request on an ask whose answer was lost, and the job
//! withdraws it. **Before each look and each ask** the job reads the room's own facts again
//! (`podster_policy::release::hostname_proof_room`): one read and failing ends the request, withdrawn at the object if
//! its proof was taken there; one that can't be read makes it wait. An ask or a withdrawal that got no answer is tried
//! again after a wait that doubles from a minute up to an hour (`retry_wait_ms`), and never given up.
//!
//! **The gate on claims, [`HOSTNAME_CLAIMS_COMPLETE`], false: closed everywhere until 8b and 8d.** While it is false,
//! every build and environment refuses every ask for a hostname as a route that isn't built (`release_not_available`),
//! whatever the provider, the resolver, the Public Suffix List or `RELEASES` say, and its proof job neither looks nor
//! asks the object, each saying so in one log line by its code. Only a test build opens it, for a room a test opts in.
//! It is flipped only once a committed claim can end the long way (8b) and claims are rechecked (8d). A request whose
//! proof was recorded and whose granted answer was lost stays held at the object while the gate is closed, which fails
//! closed, until a removal withdraws it.
//!
//! **What this doesn't do:** write a serve entry for a custom hostname, or recheck a claim. Nothing here serves. A
//! committed claim's custom hostname at Cloudflare and its long end are `custom_hostname`'s (8b), and so is routing
//! (8c), whose entry only the applier writes (`takedown`).
//!
//! Logs carry IDs and codes only, never a hostname or a challenge's value.
use super::*;
use crate::hostname_proof::Resolver;
use podster_core::hostname_requests::{
    after_ask, claimed_read_wait_ms, request_rate_allows, unmap, HostnameRequestState, Unmap,
};
use podster_core::hostnames::{
    challenge_record_name, challenge_value, mappable, next_proof_check, normalize, proof_matches,
    public_suffix_rules, request_expired, ClaimDecision, HostnameRefusal, PENDING_TTL_MS,
};
use podster_policy::release::{
    authorize_custom_hostname, hostname_proof_room, HostnameChange, HostnameProofRoom,
    HostnameProofStep, ReleaseRoom,
};
use release_config::ConfigReads;

/// A hostname request's ID begins with this, then 32 lower-case hexadecimal digits.
pub(crate) const HOSTNAME_REQUEST_PREFIX: &str = "hnr_";
/// The setting that holds the Public Suffix List's rules, as the list writes them. Bound in no environment: with none,
/// every name is refused `hostname_unavailable`.
const PUBLIC_SUFFIX_RULES: &str = "PUBLIC_SUFFIX_RULES";
/// **Whether custom hostname claims are complete.** False until 8b (a committed claim's long end) and 8d (the daily
/// recheck) have both merged, and this is the only place it is set. While false, every build and environment refuses
/// every ask for a hostname and its proof job neither looks nor asks (`Workspace::hostname_claims_open`); only a test
/// build opens it, for a room a test opts in. What must be true first is in `docs/m6-plan.md`, under "Step 8: the build plan".
pub(crate) const HOSTNAME_CLAIMS_COMPLETE: bool = false;
/// The rolling window [`request_rate_allows`] counts a room's new requests in.
const RATE_WINDOW_MS: i64 = 60 * 60 * 1000;

/// What a request asks for, read before anything outside the room is asked.
pub(super) struct Asked {
    /// The name as the caller wrote it, for `mappable`.
    input: String,
    /// The same name normalized, which names the hostname's object.
    pub(super) name: String,
}

/// What `PUT app-hostname` reads outside the room before its transaction.
pub(super) struct RequestReads {
    config: ConfigReads,
    /// The hostname's object's answer for the normalized name: whether it is suspended, and its generation. `None`
    /// when it couldn't be read.
    object: Option<(bool, u64)>,
    domain: Option<String>,
    rules: Option<String>,
}

/// Who may ask for or remove a custom hostname, by the room's rows: checked first, so nobody else makes the room ask
/// anything outside it, and again before a stored answer is replayed.
pub(super) fn may_change(who: &Participant) -> R<()> {
    authorize_custom_hostname(
        &who.caller,
        true,
        &ReleaseRoom::OPEN,
        HostnameChange::Remove,
    )
    .map_err(release_config::denial)
}

fn refusal(refusal: HostnameRefusal) -> ApiError {
    let status = match refusal {
        HostnameRefusal::Invalid
        | HostnameRefusal::Wildcard
        | HostnameRefusal::IpAddress
        | HostnameRefusal::SingleLabel => 400,
        _ => 409,
    };
    // `HostnameRefusal::code` is marked reasons, since its codes are data elsewhere too. These are its codes.
    let code = refusal.code();
    // error-codes: hostname_invalid, hostname_wildcard, hostname_ip_address, hostname_single_label, hostname_reserved, hostname_public_suffix, hostname_suspended, hostname_limit, hostname_unavailable
    ApiError::api(status, code)
}

/// The body: `{ hostname }`, and nothing else. The name is normalized here, so a name that can't be one is refused
/// before anything is asked.
pub(super) fn asked(body: &Value) -> R<Asked> {
    let fields = body.as_object().ok_or_else(ApiError::invalid_argument)?;
    if fields.keys().any(|key| key != "hostname") {
        return Err(ApiError::invalid_argument());
    }
    let input = body["hostname"]
        .as_str()
        .filter(|name| name.chars().count() <= 253)
        .ok_or_else(ApiError::invalid_argument)?;
    let name = normalize(input).map_err(refusal)?;
    Ok(Asked {
        input: input.to_owned(),
        name,
    })
}

fn now_ms() -> i64 {
    Date::now().as_millis() as i64
}

/// The proof job's clock. Test builds only: a room a test gave `test_hostname_clock (now)` reads that, so a wait's edge
/// is shown to the millisecond with no real time spent (review standard 1).
fn job_now(sql: &SqlStorage) -> i64 {
    #[cfg(feature = "failpoints")]
    if let Some(now) = rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_hostname_clock'",
        vec![],
    )
    .ok()
    .filter(|found| !found.is_empty())
    .and_then(|_| rows(sql, "SELECT now FROM test_hostname_clock", vec![]).ok())
    .and_then(|found| found.first().map(|row| int(&row["now"])))
    {
        return now;
    }
    let _ = sql;
    now_ms()
}

/// One request as the contract's `AppHostnameRequest` gives it. A pending request past its 72 hours whose proof was
/// never taken to the object reads as `expired`, as the job will record it.
fn request_view(row: &Value, now: i64) -> Value {
    let hostname = text(&row["hostname"]).unwrap_or_default();
    let stored = row["state"].as_str().and_then(HostnameRequestState::parse);
    let expired = stored.is_some_and(|state| {
        request_expired(
            state,
            !row["proved_at"].is_null(),
            int(&row["requested_at"]),
            now,
        )
    });
    let (state, end_reason) = if expired {
        (
            HostnameRequestState::Expired.name().to_owned(),
            json!(ClaimDecision::Expired.code()),
        )
    } else {
        (
            text(&row["state"]).unwrap_or_default(),
            row["end_reason"].clone(),
        )
    };
    json!({
        "id": row["id"],
        "hostname": hostname,
        "state": state,
        "challenge_name": challenge_record_name(&hostname),
        "challenge_value": row["challenge"],
        "requested_by": row["requested_by"],
        "requested_at": row["requested_at"],
        "expires_at": row["expires_at"],
        "end_reason": end_reason,
    })
}

const COLUMNS: &str = "id, hostname, state, challenge, generation, requested_by, requested_at, expires_at, claimed_at, proved_at, checked_at, end_reason, updated_at";

/// The room's open request, if it has one: at most one, by the table's own constraint.
fn open_request(sql: &SqlStorage) -> R<Option<Value>> {
    Ok(rows(
        sql,
        &format!("SELECT {COLUMNS} FROM hostname_request WHERE open = 1"),
        vec![],
    )?
    .into_iter()
    .next())
}

/// `GET app-hostname`'s answer: the open request, or else the latest, or null.
fn view(sql: &SqlStorage, now: i64) -> R<Value> {
    let latest = match open_request(sql)? {
        Some(row) => Some(row),
        None => rows(
            sql,
            &format!(
                "SELECT {COLUMNS} FROM hostname_request ORDER BY requested_at DESC, id DESC LIMIT 1"
            ),
            vec![],
        )?
        .into_iter()
        .next(),
    };
    Ok(json!({ "request": latest.map(|row| request_view(&row, now)) }))
}

/// A command's answer: the open request, ending or not, or null.
fn open_view(sql: &SqlStorage, now: i64) -> R<Value> {
    Ok(json!({ "request": open_request(sql)?.map(|row| request_view(&row, now)) }))
}

/// `GET app-hostname`: for the room's owner or an admin, as a person, by the room's rows. A read grants nothing.
pub(super) fn read(sql: &SqlStorage, who: &Participant, now: i64) -> R<Value> {
    use podster_policy::release::{release_view, ReleaseView};
    if release_view(&who.caller, true, false, false) != ReleaseView::Full {
        return Err(ApiError::not_allowed());
    }
    view(sql, now)
}

/// Ends every pending request whose 72 hours are over and whose proof was never taken to the object, in the caller's
/// transaction. A request whose proof was taken there waits for the object's answer.
fn sweep_expired(sql: &SqlStorage, now: i64) -> R<()> {
    exec(
        sql,
        "UPDATE hostname_request SET state = 'expired', open = NULL, end_reason = 'hostname_request_expired', ended_at = ?, updated_at = ?
           WHERE state = 'pending' AND proved_at IS NULL AND requested_at <= ?",
        vec![now.into(), now.into(), now.saturating_sub(PENDING_TTL_MS).into()],
    )
}

/// 32 random bytes from the Worker's own `crypto.getRandomValues`, for one challenge, or for an app's label
/// (`release_request`).
pub(super) fn random_32() -> R<[u8; 32]> {
    use wasm_bindgen::JsCast;
    let crypto = js_sys::Reflect::get(&js_sys::global(), &"crypto".into())
        .map_err(|_| ApiError::internal("no crypto"))?;
    let fill: js_sys::Function = js_sys::Reflect::get(&crypto, &"getRandomValues".into())
        .ok()
        .and_then(|f| f.dyn_into().ok())
        .ok_or_else(|| ApiError::internal("no getRandomValues"))?;
    let array = js_sys::Uint8Array::new_with_length(32);
    fill.call1(&crypto, &array)
        .map_err(|_| ApiError::internal("getRandomValues failed"))?;
    array
        .to_vec()
        .try_into()
        .map_err(|_| ApiError::internal("getRandomValues gave the wrong length"))
}

/// `PUT app-hostname`, in the room's transaction, after [`Workspace::hostname_request_reads`].
pub(super) fn handle_request(
    sql: &SqlStorage,
    who: &Participant,
    body: &Value,
    reads: &RequestReads,
    now: i64,
) -> R<Value> {
    may_change(who)?;
    let asked = asked(body)?;
    let holds = release_config::caller_holds(sql, &reads.config, &who.caller.id)?;
    let room = release_config::on_room(sql, &reads.config)?;
    authorize_custom_hostname(&who.caller, holds, &room, HostnameChange::Request)
        .map_err(release_config::denial)?;
    sweep_expired(sql, now)?;
    let open = rows(
        sql,
        "SELECT count(*) AS n FROM hostname_request WHERE open = 1",
        vec![],
    )?
    .first()
    .map_or(0, |row| int(&row["n"]));
    // The object's answer is about the name it was asked for, which is this one: both come from this body. Unread, the
    // name's suspension is unknown, and nothing is written.
    let (suspended, generation) = reads
        .object
        .ok_or_else(super::release_recheck::standing_unknown)?;
    let rules = reads.rules.as_deref().unwrap_or("");
    let name = mappable(
        &asked.input,
        reads.domain.as_deref().unwrap_or(""),
        &public_suffix_rules(rules),
        suspended,
        usize::try_from(open).unwrap_or(usize::MAX),
    )
    .map_err(refusal)?;
    if name != asked.name {
        return Err(ApiError::internal("the name was read two ways"));
    }
    // **Proposed:** at most five new requests a room in any hour, whatever became of them, so removing and asking
    // again can't churn challenges and lookups.
    let made = rows(
        sql,
        "SELECT count(*) AS n FROM hostname_request WHERE requested_at > ?",
        vec![now.saturating_sub(RATE_WINDOW_MS).into()],
    )?
    .first()
    .map_or(0, |row| int(&row["n"]));
    if !request_rate_allows(usize::try_from(made).unwrap_or(usize::MAX)) {
        return Err(ApiError::api(429, "hostname_rate_limited"));
    }
    let id = format!("{HOSTNAME_REQUEST_PREFIX}{}", uuid::Uuid::new_v4().simple());
    let challenge = challenge_value(random_32()?);
    exec(
        sql,
        "INSERT INTO hostname_request (id, hostname, state, open, challenge, generation, requested_by, requested_at, expires_at, updated_at)
           VALUES (?, ?, 'pending', 1, ?, ?, ?, ?, ?, ?)",
        vec![
            id.as_str().into(),
            name.as_str().into(),
            challenge.into(),
            i64::try_from(generation).unwrap_or(i64::MAX).into(),
            who.caller.id.as_str().into(),
            now.into(),
            now.saturating_add(PENDING_TTL_MS).into(),
            now.into(),
        ],
    )?;
    // The room's release epoch with it, so an unpublish after it ends any claim it gets (8b).
    super::custom_hostname::record_epoch(sql, &id)?;
    audit(
        sql,
        &who.caller,
        "app_hostname.requested",
        "app_hostname",
        None,
        Some(json!({ "request_id": id, "state": "pending" }).to_string()),
        now,
    )?;
    record_event(
        sql,
        "app_hostname.requested",
        &who.caller.id,
        None,
        &Transition::NONE,
        roles::room_managers(sql, &who.caller.id)?,
        now,
    )?;
    open_view(sql, now)
}

/// `DELETE app-hostname`, in the room's transaction (`podster_core::hostname_requests::unmap`). A pending request
/// nobody was asked about is over at once. One whose proof was taken to the object goes `ending`, and the job
/// withdraws it there before it is over. A committed claim goes `ending` and the room stops serving on the name in this
/// same transaction; the job then ends it the long way (8b, `custom_hostname`). Asking again changes nothing.
pub(super) fn handle_remove(
    sql: &SqlStorage,
    who: &Participant,
    reads: &ConfigReads,
    now: i64,
) -> R<Value> {
    may_change(who)?;
    let holds = release_config::caller_holds(sql, reads, &who.caller.id)?;
    authorize_custom_hostname(
        &who.caller,
        holds,
        &ReleaseRoom::OPEN,
        HostnameChange::Remove,
    )
    .map_err(release_config::denial)?;
    sweep_expired(sql, now)?;
    let Some(row) = open_request(sql)? else {
        return open_view(sql, now);
    };
    let id = text(&row["id"]).unwrap_or_default();
    let state = row["state"]
        .as_str()
        .and_then(HostnameRequestState::parse)
        .ok_or_else(|| ApiError::internal("a request in no known state"))?;
    let plan = unmap(
        state,
        !row["proved_at"].is_null(),
        !row["claimed_at"].is_null(),
    );
    match plan {
        Unmap::Nothing => return open_view(sql, now),
        Unmap::Drop => exec(
            sql,
            "UPDATE hostname_request SET state = 'ended', open = NULL, end_reason = 'hostname_unmapped', ended_at = ?, updated_at = ? WHERE id = ?",
            vec![now.into(), now.into(), id.as_str().into()],
        )?,
        Unmap::Withdraw | Unmap::EndClaim => {
            exec(
                sql,
                "UPDATE hostname_request SET state = 'ending', end_reason = 'hostname_unmapped', updated_at = ? WHERE id = ?",
                vec![now.into(), id.as_str().into()],
            )?;
            if plan == Unmap::EndClaim {
                let hostname = text(&row["hostname"]).unwrap_or_default();
                takedown::close_custom_host(sql, &hostname, now)?;
            }
        }
    }
    audit(
        sql,
        &who.caller,
        "app_hostname.removed",
        "app_hostname",
        Some(json!({ "request_id": id, "state": state.name() }).to_string()),
        Some(json!({ "request_id": id, "state": if plan == Unmap::Drop { "ended" } else { "ending" } }).to_string()),
        now,
    )?;
    record_event(
        sql,
        "app_hostname.removed",
        &who.caller.id,
        None,
        &Transition::NONE,
        roles::room_managers(sql, &who.caller.id)?,
        now,
    )?;
    open_view(sql, now)
}

/// The deployment's Public Suffix List rules, if it holds them. No environment does.
fn rules(env: &Env) -> Option<String> {
    match crate::setting(env, PUBLIC_SUFFIX_RULES) {
        crate::Setting::Text(rules) => Some(rules),
        _ => None,
    }
}

/// The deployment's resolver, if one is configured. No environment has one. Test builds can also take it away from one
/// room, while the room holds a table named `test_hostname_resolver_off`, so the unconfigured case can be shown beside
/// the configured one.
fn resolver(sql: &SqlStorage, env: &Env) -> Option<Resolver> {
    #[cfg(feature = "failpoints")]
    if rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_hostname_resolver_off'",
        vec![],
    )
    .map_or(true, |found| !found.is_empty())
    {
        return None;
    }
    #[cfg(not(feature = "failpoints"))]
    let _ = sql;
    Resolver::from_env(env)
}

/// When the job is next due for the room's open request, if anything is owed: a pending request's expiry, its next
/// look for the challenge while a resolver is configured, an ask or a withdrawal that got no answer, and a committed
/// claim's next step at Cloudflare or of its long end (8b, `custom_hostname`), at the same doubling wait.
pub(super) fn next_due(sql: &SqlStorage, env: &Env) -> R<Option<i64>> {
    let Some(row) = open_request(sql)? else {
        return Ok(None);
    };
    let state = row["state"].as_str().and_then(HostnameRequestState::parse);
    let checked = (!row["checked_at"].is_null()).then(|| int(&row["checked_at"]));
    // An ask or a withdrawal that got no answer waits as long as has gone by since the request last changed, which
    // `checked` never moves, so the wait doubles from a minute up to an hour.
    // A committed claim whose custom hostname reads `active` and is routed is read less often (8c, the deep review's
    // D5): routing gives the read its purpose, and once routed it only has to notice a change. A host the applier
    // refused isn't routed in that sense: it is read again at the shortest wait, so it opens again once the cause clears
    // (the review of PR #404, S3).
    let routed_active = state == Some(HostnameRequestState::Claimed)
        && !rows(
            sql,
            "SELECT 1 AS r FROM hostname_provider p JOIN serve_state s ON s.host = ? AND s.kind = 'custom' AND s.closed = 0
               WHERE p.request_id = ? AND p.provider_status = 'active'
                 AND NOT EXISTS (SELECT 1 FROM serve_apply a WHERE a.host = s.host AND a.refused_version = s.version)",
            vec![
                row["hostname"].as_str().unwrap_or_default().into(),
                row["id"].as_str().unwrap_or_default().into(),
            ],
        )?
        .is_empty();
    let retry = checked.map_or(0, |at| {
        at.saturating_add(claimed_read_wait_ms(
            int(&row["updated_at"]),
            at,
            routed_active,
        ))
    });
    Ok(match state {
        Some(HostnameRequestState::Pending) if row["proved_at"].is_null() => {
            let requested_at = int(&row["requested_at"]);
            let expiry = requested_at.saturating_add(PENDING_TTL_MS);
            Some(match resolver(sql, env) {
                Some(_) => expiry.min(next_proof_check(requested_at, checked)),
                None => expiry,
            })
        }
        // An ask or a withdrawal out; a committed claim's custom hostname, created or read (8b); and every ending,
        // withdrawn or the long way.
        Some(
            HostnameRequestState::Pending
            | HostnameRequestState::Claimed
            | HostnameRequestState::Ending,
        ) => Some(retry),
        _ => None,
    })
}

/// What one pass of the job does next for the open request.
enum Step {
    Look,
    Ask,
    Withdraw,
}

impl Workspace {
    /// Everything `PUT app-hostname` reads outside the room, before its transaction: what switching release on reads,
    /// and the hostname's own object, for the name's suspension and generation.
    pub(super) async fn hostname_request_reads(
        &self,
        caller_id: &str,
        asked: &Asked,
    ) -> R<RequestReads> {
        if !self.hostname_claims_open() {
            let sql = self.state.storage().sql();
            let room = rows(&sql, "SELECT id FROM workspace", vec![])?
                .first()
                .and_then(|row| text(&row["id"]))
                .unwrap_or_default();
            console_error!(
                "hostname: an ask for a hostname was refused: room={} code=hostname_claims_incomplete",
                room
            );
            return Err(crate::releases::release_not_available());
        }
        let config = self.config_reads(caller_id, true).await?;
        let object = self
            .claim_object(&asked.name, Method::Get, "/internal/state", None)
            .await
            .ok()
            .and_then(|answer| {
                Some((
                    answer["suspended"].as_bool()?,
                    answer["generation"].as_u64()?,
                ))
            });
        // Test builds only: the hostname's object can't be read, as if it hadn't answered.
        #[cfg(feature = "failpoints")]
        let object = object.filter(|_| {
            rows(
                &self.state.storage().sql(),
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_hostname_object_unread'",
                vec![],
            )
            .is_ok_and(|found| found.is_empty())
        });
        Ok(RequestReads {
            config,
            object,
            domain: crate::content_provider::content_domain(&self.env),
            rules: rules(&self.env),
        })
    }

    /// **The gate on claims** ([`HOSTNAME_CLAIMS_COMPLETE`]): whether a hostname may be asked for and its proof job may
    /// look and ask. **Closed everywhere until claims are complete,** whatever the provider, the resolver, the Public
    /// Suffix List or `RELEASES` say: a claim is permanent until 8b can end one and 8d rechecks it. Test builds only: a
    /// room a test gave the table `test_hostname_claims_open` has it open, so the rest of the path can be shown. A
    /// build without the `failpoints` feature never reads that table.
    pub(super) fn hostname_claims_open(&self) -> bool {
        claims_open(&self.state.storage().sql())
    }

    /// One call to a hostname's own object, by its normalized name. Its answer, or an error for anything but `200`.
    pub(super) async fn claim_object(
        &self,
        hostname: &str,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> R<Value> {
        super::custom_hostname::claim_call(&self.env, hostname, method, path, body).await
    }

    /// The room's proof job, one pass from its alarm. Expired requests are ended; then the open request, if its turn
    /// has come, is looked for in DNS, taken to the object, or withdrawn there. Each outcome commits in a transaction
    /// of its own; nothing is held across a call.
    pub(super) async fn hostname_upkeep(&self) -> R<()> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? || store::needs_migration(&sql)? {
            return Ok(());
        }
        let now = job_now(&sql);
        let store = sql.clone();
        transaction_sync(&self.state, move || sweep_expired(&store, now))?;
        let Some(row) = open_request(&sql)? else {
            return Ok(());
        };
        if next_due(&sql, &self.env)?.is_none_or(|due| due > now) {
            return Ok(());
        }
        let id = text(&row["id"]).unwrap_or_default();
        let hostname = text(&row["hostname"]).unwrap_or_default();
        let state = row["state"].as_str().and_then(HostnameRequestState::parse);
        // A committed claim: its custom hostname at Cloudflare, and its long end (8b).
        match state {
            Some(HostnameRequestState::Claimed) => {
                return self.claimed_upkeep(&sql, &row, now).await
            }
            Some(HostnameRequestState::Ending) if !row["claimed_at"].is_null() => {
                return self.long_end_upkeep(&sql, &row, now).await
            }
            _ => {}
        }
        let step = match state {
            Some(HostnameRequestState::Pending) if row["proved_at"].is_null() => Step::Look,
            Some(HostnameRequestState::Pending) => Step::Ask,
            Some(HostnameRequestState::Ending) if row["claimed_at"].is_null() => Step::Withdraw,
            _ => return Ok(()),
        };
        let room = rows(&sql, "SELECT id FROM workspace", vec![])?
            .first()
            .and_then(|row| text(&row["id"]))
            .unwrap_or_default();
        if let Step::Withdraw = step {
            // Only ever releases, so it never waits on the switch.
            let body = json!({ "hostname": hostname, "workspace_id": room, "request_id": id });
            let withdrawn = self
                .claim_object(
                    &hostname,
                    Method::Post,
                    crate::hostname_claim::INTERNAL_WITHDRAW,
                    Some(body),
                )
                .await
                .is_ok_and(|answer| answer["withdrawn"].as_bool() == Some(true));
            let store = sql.clone();
            return transaction_sync(&self.state, move || {
                withdrawn_recorded(&store, &id, withdrawn, now)
            });
        }
        // Before a look or an ask: the gate on claims, then the room's own facts, read again now.
        if !self.hostname_claims_open() {
            console_error!(
                "hostname: the proof job didn't go on: room={} request={} code=hostname_claims_incomplete",
                room,
                id
            );
            let store = sql.clone();
            return transaction_sync(&self.state, move || checked(&store, &id, now));
        }
        match hostname_proof_room(&proof_room(&sql)?) {
            HostnameProofStep::Go => {}
            HostnameProofStep::Wait => {
                console_error!(
                    "hostname: the proof job waits on what it couldn't read: room={} request={} code=standing_unknown",
                    room,
                    id
                );
                let store = sql.clone();
                return transaction_sync(&self.state, move || checked(&store, &id, now));
            }
            HostnameProofStep::End(denial) => {
                let store = sql.clone();
                return transaction_sync(&self.state, move || {
                    room_refused(&store, &id, denial.code(), now)
                });
            }
        }
        if let Step::Look = step {
            // A new proof is looked for only while release is switched on for the deployment and in the room. Off,
            // the request waits its turn, and expires. An ask already out is finished whatever the switches say:
            // the object may have given the claim, and only its answer settles the request.
            let room_on = rows(&sql, "SELECT enabled FROM release_config", vec![])?
                .first()
                .is_some_and(|row| int(&row["enabled"]) == 1);
            if !room_on || !crate::releases::switched_on(&self.env).await {
                let store = sql.clone();
                return transaction_sync(&self.state, move || checked(&store, &id, now));
            }
            let Some(resolver) = resolver(&sql, &self.env) else {
                return Ok(());
            };
            let values = resolver.txt(&challenge_record_name(&hostname)).await;
            let expected = text(&row["challenge"]).unwrap_or_default();
            let matched = values.as_ref().is_some_and(|values| {
                let values: Vec<&str> = values.iter().map(String::as_str).collect();
                proof_matches(&values, &expected)
            });
            if values.is_none() {
                console_error!("hostname: the challenge couldn't be read: room={} request={} code=resolver_no_answer", room, id);
            }
            let store = sql.clone();
            let look_id = id.clone();
            let still = Rc::new(RefCell::new(false));
            let slot = still.clone();
            transaction_sync(&self.state, move || {
                checked(&store, &look_id, now)?;
                if matched {
                    *slot.borrow_mut() = proved(&store, &look_id, now)?;
                }
                Ok(())
            })?;
            if !*still.borrow() {
                return Ok(());
            }
        }
        // The proof is recorded, so the object may be asked. Its answer is recorded only for a request still pending.
        let requested_at = int(&row["requested_at"]);
        let generation = int(&row["generation"]).max(0);
        let body = json!({
            "hostname": hostname, "workspace_id": room, "request_id": id,
            "requested_at": requested_at, "generation": generation,
        });
        let decision = self
            .claim_object(
                &hostname,
                Method::Post,
                crate::hostname_claim::INTERNAL_CLAIM,
                Some(body),
            )
            .await
            .ok()
            .and_then(|answer| {
                answer["decision"]
                    .as_str()
                    .and_then(ClaimDecision::from_code)
            });
        let Some(decision) = decision else {
            console_error!(
                "hostname: the claim wasn't answered: room={} request={} code=claim_no_answer",
                room,
                id
            );
            let store = sql.clone();
            return transaction_sync(&self.state, move || checked(&store, &id, now));
        };
        let store = sql.clone();
        transaction_sync(&self.state, move || answered(&store, &id, decision, now))
    }
}

/// **The gate on claims** ([`HOSTNAME_CLAIMS_COMPLETE`]), from the room's own storage, as
/// [`Workspace::hostname_claims_open`] reads it: for the applier too, which is no method of the room's.
pub(super) fn claims_open(sql: &SqlStorage) -> bool {
    if HOSTNAME_CLAIMS_COMPLETE {
        return true;
    }
    #[cfg(feature = "failpoints")]
    {
        rows(
            sql,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_hostname_claims_open'",
            vec![],
        )
        .is_ok_and(|found| !found.is_empty())
    }
    #[cfg(not(feature = "failpoints"))]
    {
        let _ = sql;
        false
    }
}

/// Records that the job looked at a request now, so its next look waits its turn. It isn't a change to the request,
/// so `updated_at` stays, which is what an unanswered try's wait is measured from.
pub(super) fn checked(sql: &SqlStorage, id: &str, now: i64) -> R<()> {
    exec(
        sql,
        "UPDATE hostname_request SET checked_at = ? WHERE id = ?",
        vec![now.into(), id.into()],
    )
}

/// The room's own facts the proof job reads before each look and each ask, as asking read them. The organization's
/// release switch is the one the room last applied; one that can't be read is unknown.
pub(super) fn proof_room(sql: &SqlStorage) -> R<HostnameProofRoom> {
    let facts = super::release_recheck::room_facts(sql, true, true)?;
    let switch = super::release_switch::applied(sql)?;
    Ok(HostnameProofRoom {
        organization_exists: facts.organization_exists,
        organization_may_release: switch.well_formed().then_some(switch.granted),
        deleted: facts.deleted,
        public: facts.public,
        archived: facts.archived,
        public_surface_suspended: facts.public_surface_suspended,
        app_suspended: facts.app_suspended,
    })
}

/// The room's own facts no longer allow a pending request, by `code`. One whose proof was never taken to the object is
/// over at once; one whose proof was is set `ending`, never committed, so the job withdraws it there.
fn room_refused(sql: &SqlStorage, id: &str, code: &'static str, now: i64) -> R<()> {
    let found = rows(
        sql,
        "SELECT proved_at FROM hostname_request WHERE id = ? AND state = 'pending'",
        vec![id.into()],
    )?;
    let Some(row) = found.first() else {
        return Ok(());
    };
    let state = if row["proved_at"].is_null() {
        exec(
            sql,
            "UPDATE hostname_request SET state = 'ended', open = NULL, end_reason = ?, ended_at = ?, updated_at = ? WHERE id = ?",
            vec![code.into(), now.into(), now.into(), id.into()],
        )?;
        HostnameRequestState::Ended
    } else {
        exec(
            sql,
            "UPDATE hostname_request SET state = 'ending', end_reason = ?, updated_at = ? WHERE id = ?",
            vec![code.into(), now.into(), id.into()],
        )?;
        HostnameRequestState::Ending
    };
    audit_as(
        sql,
        moderation::PODSTER,
        moderation::PODSTER_KIND,
        "app_hostname.refused",
        "app_hostname",
        None,
        Some(json!({ "request_id": id, "state": state.name(), "reason": code }).to_string()),
        now,
    )?;
    record_event(
        sql,
        "app_hostname.refused",
        moderation::PODSTER,
        None,
        &Transition::NONE,
        roles::room_managers(sql, moderation::PODSTER)?,
        now,
    )
}

/// Records the proof for a request still pending, before the object is asked. Answers whether it did: a request
/// removed meanwhile, or set ending by a notice, isn't asked for.
fn proved(sql: &SqlStorage, id: &str, now: i64) -> R<bool> {
    let pending = !rows(
        sql,
        "SELECT 1 AS p FROM hostname_request WHERE id = ? AND state = 'pending' AND proved_at IS NULL",
        vec![id.into()],
    )?
    .is_empty();
    if pending {
        exec(
            sql,
            "UPDATE hostname_request SET proved_at = ?, updated_at = ? WHERE id = ?",
            vec![now.into(), now.into(), id.into()],
        )?;
    }
    Ok(pending)
}

/// Records the object's answer, for a request still pending (`podster_core::hostname_requests::after_ask`). For any
/// other, nothing: a claim given for a request removed meanwhile is withdrawn by the job, never committed.
fn answered(sql: &SqlStorage, id: &str, decision: ClaimDecision, now: i64) -> R<()> {
    let found = rows(
        sql,
        "SELECT state FROM hostname_request WHERE id = ?",
        vec![id.into()],
    )?;
    let Some(state) = found
        .first()
        .and_then(|row| row["state"].as_str())
        .and_then(HostnameRequestState::parse)
    else {
        return Ok(());
    };
    checked(sql, id, now)?;
    let Some(outcome) = after_ask(state, decision) else {
        return Ok(());
    };
    let claimed = outcome.state == HostnameRequestState::Claimed;
    exec(
        sql,
        "UPDATE hostname_request SET state = ?, open = CASE WHEN ? THEN 1 ELSE NULL END, end_reason = ?,
           claimed_at = CASE WHEN ? THEN ? ELSE claimed_at END, ended_at = CASE WHEN ? THEN NULL ELSE ? END, updated_at = ? WHERE id = ?",
        vec![
            outcome.state.name().into(),
            i64::from(outcome.state.is_open()).into(),
            outcome.end_reason.into(),
            i64::from(claimed).into(),
            now.into(),
            i64::from(outcome.state.is_open()).into(),
            now.into(),
            now.into(),
            id.into(),
        ],
    )?;
    let kind = if claimed {
        "app_hostname.claimed"
    } else {
        "app_hostname.refused"
    };
    audit_as(
        sql,
        moderation::PODSTER,
        moderation::PODSTER_KIND,
        kind,
        "app_hostname",
        None,
        Some(json!({ "request_id": id, "state": outcome.state.name(), "reason": outcome.end_reason }).to_string()),
        now,
    )?;
    record_event(
        sql,
        kind,
        moderation::PODSTER,
        None,
        &Transition::NONE,
        roles::room_managers(sql, moderation::PODSTER)?,
        now,
    )
}

/// Records a withdrawal's outcome: the object recorded it, so the request is over, `ended`, keeping the reason it was
/// set ending for; or there was no answer, and the job tries again in its turn.
fn withdrawn_recorded(sql: &SqlStorage, id: &str, withdrawn: bool, now: i64) -> R<()> {
    checked(sql, id, now)?;
    if withdrawn {
        exec(
            sql,
            "UPDATE hostname_request SET state = 'ended', open = NULL, end_reason = coalesce(end_reason, 'hostname_unmapped'), ended_at = ?, updated_at = ?
               WHERE id = ? AND state = 'ending' AND claimed_at IS NULL",
            vec![now.into(), now.into(), id.into()],
        )?;
    }
    Ok(())
}

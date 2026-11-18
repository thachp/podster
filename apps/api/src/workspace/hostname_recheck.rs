//! The daily recheck of a committed claim's challenge (M6 step 8d; ADR 0010's "Custom domains", step 7). From the
//! room's proof job, as one step of a committed claim's upkeep (`custom_hostname`), after the room's release epoch and
//! its own facts were read again, exactly as before every other step of it.
//!
//! **A look a day,** and never later than seven days after the last match (`podster_core::hostname_recheck::
//! next_recheck_at`): the job asks the resolver for the challenge's TXT records and core reads the answer into a match,
//! a definite no or no answer (`read_challenge`). Core then decides (`podster_core::hostnames::recheck_claim`): a match
//! resets both counts; two definite noes at least 24 hours apart, with no match between, end the claim
//! `hostname_challenge_removed`; no answer counts toward neither, and any look but a match ends a claim with no match
//! for seven days `hostname_proof_lapsed`. **A claim ends the one way every committed claim does** (8b): the request
//! goes `ending` and its host is cleared and closed in the same transaction, then the hostname's object is told, the
//! custom hostname is deleted at Cloudflare and read until gone, the applier confirms the entry gone, and only then is
//! the claim freed.
//!
//! **A look needs the gate on claims open and a resolver** (`no_look`), as the proof job's do; without either the look
//! is recorded as no answer, by its code, so it never ends a claim quickly and a claim nobody can look at ends after
//! seven days. **It doesn't wait on the release switches:** it only keeps or takes down, and switching release off is
//! an unpublish, which ends the claim on its own.
//!
//! Logs carry the room's and the request's IDs and a code, never a hostname or a challenge's value.
use super::*;
use podster_core::hostname_recheck::{next_recheck_at, no_look};
use podster_core::hostnames::{
    challenge_record_name, recheck_claim, ProofHistory, RecheckDecision, RecheckOutcome,
};

/// The request's last match: its proof, then each matching recheck. A claimed request always has one; if one ever
/// didn't, its claim time stands in.
fn last_success(row: &Value) -> i64 {
    if row["proved_at"].is_null() {
        int(&row["claimed_at"])
    } else {
        int(&row["proved_at"])
    }
}

/// When a committed claim's next recheck is due, from its row and the record of its last look (`hostname_recheck`).
pub(super) fn recheck_due_at(sql: &SqlStorage, row: &Value) -> R<i64> {
    let rechecked = rows(
        sql,
        "SELECT rechecked_at FROM hostname_recheck WHERE request_id = ?",
        vec![row["id"].as_str().unwrap_or_default().into()],
    )?
    .first()
    .map(|found| int(&found["rechecked_at"]));
    Ok(next_recheck_at(last_success(row), rechecked))
}

impl Workspace {
    /// One recheck of the committed claim in `row`, if its turn has come: whether it ran, so the pass ends there.
    pub(super) async fn recheck_if_due(&self, sql: &SqlStorage, row: &Value, now: i64) -> R<bool> {
        if recheck_due_at(sql, row)? > now {
            return Ok(false);
        }
        let id = text(&row["id"]).unwrap_or_default();
        let hostname = text(&row["hostname"]).unwrap_or_default();
        let room = rows(sql, "SELECT id FROM workspace", vec![])?
            .first()
            .and_then(|row| text(&row["id"]))
            .unwrap_or_default();
        let resolver = super::hostname::resolver(sql, &self.env);
        let outcome = match (
            no_look(self.hostname_claims_open(), resolver.is_some()),
            resolver,
        ) {
            (None, Some(resolver)) => {
                let expected = text(&row["challenge"]).unwrap_or_default();
                resolver
                    .look(&challenge_record_name(&hostname), &expected)
                    .await
            }
            (cause, _) => {
                console_error!(
                    "hostname: the recheck couldn't look: room={} request={} code={}",
                    room,
                    id,
                    cause.unwrap_or("hostname_resolver_missing")
                );
                RecheckOutcome::ResolverError
            }
        };
        let code = match outcome {
            RecheckOutcome::Match => "recheck_match",
            RecheckOutcome::DefiniteNo => "recheck_definite_no",
            RecheckOutcome::ResolverError => "resolver_no_answer",
        };
        console_log!(
            "hostname: a claim's recheck: room={} request={} code={}",
            room,
            id,
            code
        );
        let history = ProofHistory {
            last_success_at: last_success(row),
            definite_no_since: (!row["definite_no_since"].is_null())
                .then(|| int(&row["definite_no_since"])),
        };
        let decision = recheck_claim(history, outcome, now);
        let (store, request) = (sql.clone(), id.clone());
        transaction_sync(&self.state, move || {
            recorded(&store, &request, &hostname, decision, now)
        })?;
        Ok(true)
    }
}

/// Records a recheck's decision for a request still `claimed`, in the caller's transaction: kept, with its counts and
/// when it looked; or ended, the long way, by core's code. For any other request, nothing: it changed while the look
/// was out, and whatever changed it decides.
fn recorded(
    sql: &SqlStorage,
    id: &str,
    hostname: &str,
    decision: RecheckDecision,
    now: i64,
) -> R<()> {
    let still = !rows(
        sql,
        "SELECT 1 AS c FROM hostname_request WHERE id = ? AND state = 'claimed'",
        vec![id.into()],
    )?
    .is_empty();
    if !still {
        return Ok(());
    }
    exec(
        sql,
        "INSERT INTO hostname_recheck (request_id, rechecked_at) VALUES (?, ?)
           ON CONFLICT (request_id) DO UPDATE SET rechecked_at = excluded.rechecked_at",
        vec![id.into(), now.into()],
    )?;
    match decision {
        RecheckDecision::Keep(history) => exec(
            sql,
            "UPDATE hostname_request SET proved_at = ?, definite_no_since = ? WHERE id = ?",
            vec![
                history.last_success_at.into(),
                history.definite_no_since.map_or(V::Null, V::from),
                id.into(),
            ],
        ),
        RecheckDecision::End(end) => {
            super::custom_hostname::end_committed(sql, id, hostname, end.code(), now)
        }
    }
}

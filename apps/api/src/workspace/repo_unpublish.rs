//! Unpublishing the room's app for its repository's link, under the deployment's ceiling (M6 step 6; decided by the
//! architect on 2026-11-14, for the owner to review).
//!
//! A link no longer ready takes the room's app down (ADR 0010, ruling 1 of `docs/m6-step6-plan.md`). An unpublish retires
//! the app's label for good, and a GitHub incident, or the provisioning App's installation suspended or removed, could
//! make every link read as not ready at once. So two guards stand before it:
//!
//! - **The installation check** (`Workspace::readiness`): a repository read as gone counts toward "gone" only while the
//!   App's own installation reads healthy. Otherwise the read is undecided: nothing is degraded, the room logs its ID and
//!   a code, and operators are told by one finding, `installation_unconfirmed`, however many rooms meet it.
//! - **The ceiling** (`crate::repo_ceiling`, in the `Moderation` object, which every room asks): each room reads its own
//!   link, so there is no shared pass, and the one object that sees every room counts by time. **A room asks it before
//!   it unpublishes for this cause, and the object decides in one transaction of its own,** so two rooms asking at once
//!   can't both take the last place. Past the ceiling the rest are held, with one finding, until an operator's recheck
//!   of a held room confirms it, or the cause clears there.
//!
//! **Degrading never waits for this.** The link is degraded, and agents' tokens marked for revocation, in the
//! transaction that finds the difference, as before. Only the unpublish waits for the ceiling's answer, asked outside any
//! transaction; then the room checks again, in one transaction, that its link is still not ready and something is
//! still up, and unpublishes there. Every other unpublish trigger is untouched and still acts at once.
//!
//! When the room asks:
//! - in its alarm, after a job of that pass took the link off ready (the merge job, the daily read-back, a pull
//!   request's read);
//! - at an operator's recheck, which is that operator's confirmation for this room;
//! - after the reconcile's walk woke it with an unpublish still owed, and, after a hold or no answer, again an hour on.
//!
//! Logs carry the room's ID and codes, nothing else.
use super::*;
use podster_core::release::{repo_unpublish_owed, RepoUnpublishPermit, UnpublishTrigger};
use podster_core::repositories::LinkStatus;

/// How long a room that was held, or got no answer, waits before it asks again by itself. An operator's recheck asks at
/// once. Proposed.
const ASK_AGAIN_MS: i64 = 60 * 60 * 1000;

/// The finding a room's undecided "gone" raises, one for the deployment, with the installation's reading in `detail`.
const INSTALLATION_FINDING: &str = "installation_unconfirmed";
const INSTALLATION_SUBJECT: &str = "provisioning_installation";

/// The room's GitHub link's status, if it has one. A status the room can't read is no link here: nothing is owed on it.
pub(super) fn link_status(sql: &SqlStorage) -> R<Option<(LinkStatus, Option<String>)>> {
    Ok(rows(
        sql,
        "SELECT status, status_reason FROM repo_link WHERE provider = 'github'",
        vec![],
    )?
    .first()
    .and_then(|row| {
        row["status"]
            .as_str()
            .and_then(LinkStatus::from_name)
            .map(|status| (status, text(&row["status_reason"])))
    }))
}

/// The reason the room's app is owed an unpublish for its link, or `None` when it isn't: core's
/// `repo_unpublish_owed`, on the link's status and whether anything is up.
pub(super) fn owed(sql: &SqlStorage) -> R<Option<String>> {
    let Some((status, reason)) = link_status(sql)? else {
        return Ok(None);
    };
    if status == LinkStatus::Ready {
        return Ok(None);
    }
    Ok(
        repo_unpublish_owed(status, release_switch::has_anything_up(sql)?)
            .then(|| reason.unwrap_or_else(|| status.name().to_owned())),
    )
}

/// When the room's alarm should next ask, if it owes an unpublish it has been told to ask about again: after the walk
/// woke it, or once the wait after a hold or no answer is over. `None` otherwise.
pub(super) fn next_due(sql: &SqlStorage, ask_after: i64, now: i64) -> R<Option<i64>> {
    if ask_after == 0 || owed(sql)?.is_none() {
        return Ok(None);
    }
    Ok(Some(ask_after.max(now + 10)))
}

fn room_id(sql: &SqlStorage) -> String {
    rows(sql, "SELECT id FROM workspace", vec![])
        .ok()
        .and_then(|found| found.first().and_then(|row| text(&row["id"])))
        .unwrap_or_default()
}

/// The ceiling's answer to one room, or `None` when it gave none that reads as one of its three.
async fn ask(env: &Env, room: &str, operator: bool) -> Option<RepoUnpublishPermit> {
    let body = json!({ "room": room, "wanted": true, "operator": operator });
    let mut response =
        crate::moderation::call(env, crate::repo_ceiling::PATH, Method::Post, Some(body))
            .await
            .ok()?;
    if response.status_code() != 200 {
        return None;
    }
    let answer: Value = response.json().await.ok()?;
    match answer["permit"].as_str()? {
        "grant" => Some(RepoUnpublishPermit::Grant),
        "hold" => Some(RepoUnpublishPermit::Hold),
        "undecided" => Some(RepoUnpublishPermit::Undecided),
        _ => None,
    }
}

impl Workspace {
    /// The room's alarm, after its jobs: asks if a job of this pass took the link off ready (`before` is the status the
    /// pass began with), or if the room was told to ask again and the wait is over.
    pub(super) async fn repo_unpublish_after_alarm(&self, before: Option<LinkStatus>) {
        let sql = self.state.storage().sql();
        let now = now_ms();
        let went_off = before == Some(LinkStatus::Ready)
            && link_status(&sql)
                .ok()
                .flatten()
                .is_some_and(|(status, _)| status != LinkStatus::Ready);
        let ask_after = self.repo_ask_after.get();
        if went_off || (ask_after != 0 && ask_after <= now) {
            self.repo_unpublish(false).await;
        }
    }

    /// The reconcile's walk woke the room: if an unpublish is owed for its link, its alarm asks the ceiling. Asked from
    /// the alarm, never from inside the walk's own call, so the deployment's object is never asked while it is waiting
    /// on this room.
    pub(super) fn repo_unpublish_woken(&self, owed: bool) {
        if owed && self.repo_ask_after.get() == 0 {
            self.repo_ask_after.set(now_ms());
        }
    }

    /// Asks the ceiling, then unpublishes as `RepositoryNotReady` if it granted and an unpublish is still owed, checked
    /// again in the transaction that unpublishes. `operator` is an operator's recheck of this room, which confirms it.
    /// With nothing owed, an operator's recheck tells the ceiling so, which releases the room from a hold. A failure is
    /// logged by the room's ID and a code and changes nothing; the room asks again an hour on.
    pub(super) async fn repo_unpublish(&self, operator: bool) {
        if let Err(error) = self.try_repo_unpublish(operator).await {
            // Asked again once the wait is over, as after a hold: the unpublish was its own transaction, and left nothing.
            self.repo_ask_after.set(now_ms() + ASK_AGAIN_MS);
            let sql = self.state.storage().sql();
            console_error!(
                "{}",
                json!({ "event": "repository.unpublish_failed", "ws": room_id(&sql), "code": error.code().unwrap_or("internal_error") })
            );
        }
    }

    async fn try_repo_unpublish(&self, operator: bool) -> R<()> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? || store::needs_migration(&sql)? {
            return Ok(());
        }
        let room = room_id(&sql);
        if owed(&sql)?.is_none() {
            self.repo_ask_after.set(0);
            if operator {
                // The cause cleared here, or nothing is up: the room is no longer waiting on the ceiling.
                let body = json!({ "room": room, "wanted": false, "operator": true });
                let told = crate::moderation::call(
                    &self.env,
                    crate::repo_ceiling::PATH,
                    Method::Post,
                    Some(body),
                )
                .await
                .is_ok_and(|response| response.status_code() == 200);
                if !told {
                    console_error!(
                        "{}",
                        json!({ "event": "repository.unpublish_noted", "ws": room, "code": "ceiling_unanswered" })
                    );
                }
            }
            return Ok(());
        }
        let permit = ask(&self.env, &room, operator)
            .await
            .unwrap_or(RepoUnpublishPermit::Undecided);
        if permit != RepoUnpublishPermit::Grant {
            self.repo_ask_after.set(now_ms() + ASK_AGAIN_MS);
            console_log!(
                "{}",
                json!({ "event": "repository.unpublish_held", "ws": room, "code": permit.code() })
            );
            return Ok(());
        }
        // Granted: checked again, in the transaction that unpublishes, since the room may have changed while it asked.
        let store = sql.clone();
        transaction_sync(&self.state, move || {
            if let Some(reason) = owed(&store)? {
                takedown::unpublish_for(
                    &store,
                    UnpublishTrigger::RepositoryNotReady,
                    json!({ "cause": reason }),
                    now_ms(),
                )?;
            }
            Ok(())
        })?;
        self.repo_ask_after.set(0);
        Ok(())
    }

    /// The installation's own reading, before a repository's "gone" is acted on. Test builds read a stand-in's answer
    /// from the room's `test_installation_answer` table when a test made it, through the same `core` judgement.
    pub(super) async fn installation_read(
        &self,
        provider: &crate::github::GitHubApp,
    ) -> podster_core::provisioning::InstallationRead {
        #[cfg(feature = "failpoints")]
        {
            let sql = self.state.storage().sql();
            let made = rows(
                &sql,
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_installation_answer'",
                vec![],
            )
            .map(|found| !found.is_empty())
            .unwrap_or(false);
            if made {
                let row = rows(
                    &sql,
                    "SELECT status, id_matches, suspended FROM test_installation_answer",
                    vec![],
                )
                .ok()
                .and_then(|found| found.into_iter().next());
                return match row {
                    Some(row) => podster_core::provisioning::installation_read(
                        row["status"].as_i64().and_then(|n| u16::try_from(n).ok()),
                        row["id_matches"].as_i64() == Some(1),
                        row["suspended"].as_i64().map(|n| n == 1),
                    ),
                    None => podster_core::provisioning::InstallationRead::Unreadable,
                };
            }
        }
        use crate::github::Provider;
        provider.installation().await
    }

    /// A repository read as gone while the installation couldn't be confirmed healthy: undecided. Logged by the room's
    /// ID and the reading's code, and told to operators as one finding for the deployment, whichever room meets it.
    /// Telling them is best effort: the read is undecided whether or not it is told.
    pub(super) async fn installation_unconfirmed(
        &self,
        room: &str,
        read: podster_core::provisioning::InstallationRead,
    ) {
        console_error!(
            "{}",
            json!({ "event": "repository.gone_undecided", "ws": room, "code": read.code() })
        );
        let finding = json!({ "code": INSTALLATION_FINDING, "subject": INSTALLATION_SUBJECT, "detail": read.code() });
        let kept = crate::moderation::call(
            &self.env,
            crate::reconcile::FINDING_PATH,
            Method::Post,
            Some(finding),
        )
        .await
        .is_ok_and(|response| response.status_code() == 200);
        if !kept {
            console_error!(
                "{}",
                json!({ "event": "repository.gone_undecided", "ws": room, "code": "finding_not_kept" })
            );
        }
    }
}

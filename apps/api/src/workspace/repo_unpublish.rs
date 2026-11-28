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
//!   link, so there is no shared pass, and the one object that sees every room counts a rolling hour. **A room asks it
//!   before it unpublishes for this cause, and the object decides in one transaction of its own,** so two rooms asking
//!   at once can't both take the last place. Past the ceiling the rest are held, each named by its room's ID in a
//!   finding, until an operator's recheck of a held room confirms it, or the cause clears there.
//!
//! **Degrading never waits for this.** The link is degraded, and agents' tokens marked for revocation, in the
//! transaction that finds the difference, as before. Only the unpublish waits for the ceiling's answer, asked outside any
//! transaction; then the room checks again, in one transaction, that its link is still not ready and something is
//! still up, and unpublishes there. Every other unpublish trigger is untouched and still acts at once.
//!
//! **Nothing here lives in memory.** Whether an unpublish is owed is worked out from the room's own rows each time
//! ([`owed`]): a link off ready with something up. When the room's ask didn't end it (held, undecided, no answer, or a
//! grant whose unpublish failed), the time it asks again is kept in the object's durable storage, under
//! [`RETRY_KEY`], which needs no schema step. While anything is owed, or that key is there, the room's alarm is armed
//! for it, so a restart between any two steps loses nothing. A room whose cause cleared while the key was there tells
//! the ceiling so, which releases it from a hold.
//!
//! An ask that got no answer, or a granted unpublish that failed, is told to operators as `repo_unpublish_stalled`, by
//! the room's ID; the ceiling records an undecided one itself, and takes the finding away at its next answer.
//!
//! Logs carry the room's ID and codes, nothing else.
use super::*;
use podster_core::release::{repo_unpublish_owed, RepoUnpublishPermit, UnpublishTrigger};
use podster_core::repositories::LinkStatus;

/// How long a room whose ask didn't end it waits before it asks again by itself. An operator's recheck asks at once.
/// Proposed.
const ASK_AGAIN_MS: i64 = 60 * 60 * 1000;

/// The key in the room's durable storage that holds when it next asks the ceiling, while an ask hasn't ended it.
pub(super) const RETRY_KEY: &str = "repo_unpublish_retry_at";

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
/// `repo_unpublish_owed`, on the link's status and whether anything is up **or a label is current**, since a current
/// label with nothing up is retired for good too, under the same ceiling (the review of PR #567, 2026-11-23). Durable
/// state alone decides it.
pub(super) fn owed(sql: &SqlStorage) -> R<Option<String>> {
    let Some((status, reason)) = link_status(sql)? else {
        return Ok(None);
    };
    if status == LinkStatus::Ready {
        return Ok(None);
    }
    Ok(repo_unpublish_owed(
        status,
        release_switch::has_anything_up(sql)?
            || release_switch::has_current_label(sql)?
            // A preview is deleted by a repository lost too (M8 step 6; the preview plan's 3.3).
            || super::preview::current(sql)?.is_some(),
    )
    .then(|| reason.unwrap_or_else(|| status.name().to_owned())))
}

/// When the room's alarm should next come for this: while an unpublish is owed, at once or when the kept retry time
/// comes; with nothing owed and a retry kept, at once, to tell the ceiling the room no longer waits. `None` otherwise.
pub(super) fn next_due(sql: &SqlStorage, retry_at: Option<i64>, now: i64) -> R<Option<i64>> {
    Ok(match (owed(sql)?.is_some(), retry_at) {
        (true, retry_at) => Some(retry_at.unwrap_or(0).max(now + 10)),
        (false, Some(_)) => Some(now + 10),
        (false, None) => None,
    })
}

fn room_id(sql: &SqlStorage) -> String {
    rows(sql, "SELECT id FROM workspace", vec![])
        .ok()
        .and_then(|found| found.first().and_then(|row| text(&row["id"])))
        .unwrap_or_default()
}

#[cfg(feature = "failpoints")]
fn test_table(sql: &SqlStorage, name: &str) -> bool {
    rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        vec![name.into()],
    )
    .is_ok_and(|found| !found.is_empty())
}

/// The ceiling's answer to one room, or `None` when it gave none that reads as one of its three. Test builds give no
/// answer while the room holds `test_ceiling_unanswered`.
async fn ask(
    env: &Env,
    sql: &SqlStorage,
    room: &str,
    operator: bool,
) -> Option<RepoUnpublishPermit> {
    #[cfg(feature = "failpoints")]
    if test_table(sql, "test_ceiling_unanswered") {
        return None;
    }
    let _ = sql;
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

/// Tells operators, by the room's ID, that its ask stalled: `no_answer` or `unpublish_failed`. Best effort.
async fn tell_stalled(env: &Env, room: &str, detail: &str) {
    let finding =
        json!({ "code": crate::repo_ceiling::STALLED, "subject": room, "detail": detail });
    let kept = crate::moderation::call(
        env,
        crate::reconcile::FINDING_PATH,
        Method::Post,
        Some(finding),
    )
    .await
    .is_ok_and(|response| response.status_code() == 200);
    if !kept {
        console_error!(
            "{}",
            json!({ "event": "repository.unpublish_stalled", "ws": room, "code": "finding_not_kept" })
        );
    }
}

impl Workspace {
    async fn retry_at(&self) -> Option<i64> {
        self.state
            .storage()
            .get::<i64>(RETRY_KEY)
            .await
            .ok()
            .flatten()
    }

    async fn retry_later(&self) {
        if self
            .state
            .storage()
            .put(RETRY_KEY, now_ms() + ASK_AGAIN_MS)
            .await
            .is_err()
        {
            console_error!("repository unpublish: the retry time wasn't kept: code=storage_failed");
        }
    }

    /// When the room's alarm should next come for an unpublish owed for its link, or to release it from a hold.
    pub(super) async fn repo_unpublish_due(&self, sql: &SqlStorage, now: i64) -> R<Option<i64>> {
        next_due(sql, self.retry_at().await, now)
    }

    /// The room's alarm: asks the ceiling while an unpublish is owed and no kept retry time is still ahead, or, with
    /// nothing owed and a retry kept, tells the ceiling the room no longer waits.
    pub(super) async fn repo_unpublish_from_alarm(&self) {
        let sql = self.state.storage().sql();
        let Ok(owed) = owed(&sql) else {
            return;
        };
        let retry_at = self.retry_at().await;
        match (owed.is_some(), retry_at) {
            (true, Some(at)) if at > now_ms() => {}
            (true, _) => self.repo_unpublish(false).await,
            (false, Some(_)) => self.repo_unpublish(false).await,
            (false, None) => {}
        }
    }

    /// Asks the ceiling, then unpublishes as `RepositoryNotReady` if it granted and an unpublish is still owed, checked
    /// again in the transaction that unpublishes. `operator` is an operator's recheck of this room, which confirms it.
    /// With nothing owed, the ceiling is told so if an operator asked or the room had an ask outstanding, which releases
    /// it from a hold. Whatever didn't end it keeps a retry time; a failure is logged by the room's ID and a code.
    pub(super) async fn repo_unpublish(&self, operator: bool) {
        if let Err(error) = self.try_repo_unpublish(operator).await {
            self.retry_later().await;
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
            if !operator && self.retry_at().await.is_none() {
                return Ok(());
            }
            // The cause cleared here, or nothing is up: the room is no longer waiting on the ceiling.
            let body = json!({ "room": room, "wanted": false, "operator": operator });
            let told = crate::moderation::call(
                &self.env,
                crate::repo_ceiling::PATH,
                Method::Post,
                Some(body),
            )
            .await
            .is_ok_and(|response| response.status_code() == 200);
            if told {
                self.state.storage().delete(RETRY_KEY).await?;
            } else {
                self.retry_later().await;
                console_error!(
                    "{}",
                    json!({ "event": "repository.unpublish_noted", "ws": room, "code": "ceiling_unanswered" })
                );
            }
            return Ok(());
        }
        let Some(permit) = ask(&self.env, &sql, &room, operator).await else {
            self.retry_later().await;
            console_error!(
                "{}",
                json!({ "event": "repository.unpublish_held", "ws": room, "code": "no_answer" })
            );
            tell_stalled(&self.env, &room, "no_answer").await;
            return Ok(());
        };
        if permit != RepoUnpublishPermit::Grant {
            self.retry_later().await;
            console_log!(
                "{}",
                json!({ "event": "repository.unpublish_held", "ws": room, "code": permit.code() })
            );
            return Ok(());
        }
        // Test builds only: a test changes the room here, between the grant and the unpublish's own check.
        #[cfg(feature = "failpoints")]
        self.test_hold(&sql, "test_hold_before_unpublish").await;
        // Granted: checked again, in the transaction that unpublishes, since the room may have changed while it asked.
        let store = sql.clone();
        let unpublished = transaction_sync(&self.state, move || {
            if let Some(reason) = owed(&store)? {
                // Nothing up, only a current label: it is retired, its store owed, and nothing is unpublished.
                if !release_switch::has_anything_up(&store)? {
                    super::preview::on_unpublish(
                        &store,
                        UnpublishTrigger::RepositoryNotReady,
                        now_ms(),
                    )?;
                    return takedown::retire_current_label(&store, now_ms());
                }
                takedown::unpublish_for(
                    &store,
                    UnpublishTrigger::RepositoryNotReady,
                    json!({ "cause": reason }),
                    now_ms(),
                )?;
            }
            Ok(())
        });
        if let Err(error) = unpublished {
            tell_stalled(&self.env, &room, "unpublish_failed").await;
            return Err(error);
        }
        self.state.storage().delete(RETRY_KEY).await?;
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

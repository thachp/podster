//! Making an app's store (M6 stage 1, S2 of the store plan; ADR 0010's revision, section 3.3; the architect's ruling
//! on the store, 2026-11-16). **The release job makes it, never approval:** for a release whose manifest asks for one
//! (`podster_core::app_code::asks_for_store`), once its recheck holds and before its upload. What it decides is pure,
//! in `podster_core::app_store` ([`make_step`], [`settles_first`], [`create_answer`], [`settle`]); here is only what it
//! reads, writes and calls. Behind `RELEASES`, since only the release job's upload step calls it.
//!
//! - **One store for one label.** The room's record (`app_store`, keyed by the label) holds the name the room drew and,
//!   while a create may have been sent and isn't settled, `create_sent_at`. Nothing sends a create while one is
//!   outstanding or once the store is recorded made.
//! - **Recorded before it is sent.** The name and `create_sent_at` are written in the room's own transaction, the same
//!   one that runs the whole recheck again on fresh outside reads, before the create goes out. So a create whose answer
//!   is lost always leaves the name it can be found by.
//! - **The create's gate** is the release path's constant, `release_commit::RELEASE_PATH_COMPLETE`, alone, as a custom
//!   hostname's create is (8b): closed everywhere while it is false, whatever is configured. Only a test build opens
//!   it, for a room a test gives `test_app_store_create_open`. Lists are never gated: they only settle.
//! - **A lost answer is settled by a whole list read by the name.** Found: its ID is recorded made. Not found on two
//!   whole lists at least ten minutes apart, the first ten minutes after the create: the create is no longer
//!   outstanding, and the next release step that asks for the store creates it again, under the same name. A list that
//!   isn't whole decides nothing. **Only a release that asks for its store is held by a create outstanding** (the deep
//!   review of PR #416, item 1): a release that asks for none, a static one among them, uploads as before. A release
//!   that asks settles it after its read; and, once its own last step waited on its store (`STORE_WAITS`), before
//!   anything else its next step does, reading nothing from GitHub, with no upload slot taken by the driver's lease
//!   (`release_driver::lease`). If the record changed between that lease and the step, so settling is no longer due,
//!   the step reads nothing without a slot and ends (`store_upload_slot_needed`).
//! - **A definite refusal fails the release** by `store_create_refused`. The create stays outstanding, so whatever it
//!   may have met is settled by the list before another is sent. A conflict, or D1 saying the name is taken
//!   (`D1_NAME_TAKEN`, **Proposed**), is no refusal: it may be an earlier create of this very name, so it is settled by
//!   the list too.
//! - **Only this module writes `app_store`** (a test reads every source for it), since while a create is outstanding
//!   its `updated_at` is when the first counted list without it was read. S4's schema step adds `first_gone_at`.
//! - **A create recorded and never sent:** if the alarm can't be set after the record's transaction commits (`arm`),
//!   or the step dies before sending, the record says a create is outstanding that never went out. It settles like a
//!   lost one, created again after two lists about twenty minutes on. **So D1 and the room may each hold a name with
//!   no ID:** S4 and S5 must resolve every such record by listing by its name, never by its ID alone.
//! - **The list's reach:** it counts every D1 database in the account, up to `MAX_LIST_PAGES` pages of `LIST_PAGE`.
//!   Past that it is no list, and settling can't decide; S5 must use a list filtered by name, or raise the bound,
//!   before about a thousand apps. A list is sent only for a create recorded, but many rooms settling at once could
//!   press on the account's API rate limit.
//!
//! Logs carry the room's and the release's IDs and codes: never a store's name, its ID or a token.
use super::release_commit::{upload_ready, UploadReady};
use super::release_recheck::release_now;
use super::*;
use crate::app_stores::StoreProvider;
use podster_core::app_store::{
    make_step, settle, settles_first, store_name, CreateAnswer, MakeStep, Settle, StoreRecord,
    STORE_CREATE_INCOMPLETE, STORE_CREATE_OWED, STORE_CREATE_REFUSED, STORE_CREATE_UNANSWERED,
    STORE_LIST_UNKNOWN, STORE_PROVIDER_MISSING, STORE_SETTLED, STORE_SLOT_NEEDED, STORE_UNSETTLED,
};

/// The room's record of one label's store, as its row holds it.
pub(super) struct Kept {
    kind: Option<String>,
    name: Option<String>,
    id: Option<String>,
    made_at: Option<i64>,
    create_sent_at: Option<i64>,
    delete_owed_at: Option<i64>,
    gone_at: Option<i64>,
    updated_at: i64,
}

impl Kept {
    fn record(&self) -> StoreRecord<'_> {
        StoreRecord {
            kind: self.kind.as_deref(),
            name: self.name.as_deref(),
            id: self.id.as_deref(),
            made_at: self.made_at,
            delete_owed_at: self.delete_owed_at,
            gone_at: self.gone_at,
        }
    }
}

/// The record of `label`'s store, or `None` when the room holds none.
fn kept(sql: &SqlStorage, label: &str) -> R<Option<Kept>> {
    Ok(rows(
        sql,
        "SELECT kind, store_name, store_id, made_at, create_sent_at, delete_owed_at, gone_at, updated_at FROM app_store WHERE label = ?",
        vec![label.into()],
    )?
    .first()
    .map(|row| Kept {
        kind: text(&row["kind"]),
        name: text(&row["store_name"]),
        id: text(&row["store_id"]),
        made_at: row["made_at"].as_i64(),
        create_sent_at: row["create_sent_at"].as_i64(),
        delete_owed_at: row["delete_owed_at"].as_i64(),
        gone_at: row["gone_at"].as_i64(),
        updated_at: int(&row["updated_at"]),
    }))
}

fn label_of(sql: &SqlStorage, release_id: &str) -> R<Option<String>> {
    Ok(rows(
        sql,
        "SELECT label FROM release WHERE id = ?",
        vec![release_id.into()],
    )?
    .first()
    .and_then(|row| text(&row["label"])))
}

/// What the release's own last step answered, as the driver's job recorded it.
fn last_code(sql: &SqlStorage, release_id: &str) -> R<Option<String>> {
    Ok(rows(
        sql,
        "SELECT last_code FROM release_job WHERE release_id = ?",
        vec![release_id.into()],
    )?
    .first()
    .and_then(|row| text(&row["last_code"])))
}

/// Whether the release's upload step settles its label's create outstanding first, reading nothing from GitHub
/// (`podster_core::app_store::settles_first`): only for a release whose own last step waited on its store. The
/// driver's lease takes no upload slot for such a step.
pub(super) fn settles_first_for(sql: &SqlStorage, release_id: &str) -> R<bool> {
    let Some(label) = label_of(sql, release_id)? else {
        return Ok(false);
    };
    let last = last_code(sql, release_id)?;
    Ok(kept(sql, &label)?.is_some_and(|kept| {
        settles_first(Some(&kept.record()), kept.create_sent_at, last.as_deref())
    }))
}

/// Whether the lease the step holds took an upload slot: the room's upload attempt recorded at the lease's own time.
fn lease_took_slot(sql: &SqlStorage, release_id: &str) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT 1 AS c FROM release_upload_attempt a JOIN release_job j ON j.release_id = a.release_id
           WHERE a.release_id = ? AND a.at = j.updated_at AND j.leased_step IS NOT NULL",
        vec![release_id.into()],
    )?
    .is_empty())
}

/// What the store step came to, for the upload that called it.
pub(super) enum StoreOutcome {
    /// The upload goes on.
    Go,
    /// The upload waits under this code, not before this time if one is given.
    Wait(&'static str, Option<i64>),
    /// The release fails by this code.
    Fail(&'static str),
    /// The command ends with this answer: the recheck ended the release, or found it no longer uploading.
    Answer(Value),
}

fn log(sql: &SqlStorage, release_id: &str, code: &str) {
    console_log!(
        "release: the app's store: room={} release={} code={}",
        release_driver::room_id(sql),
        release_id,
        code
    );
}

impl Workspace {
    /// **The gate on making a store,** the release path's constant (`release_commit::RELEASE_PATH_COMPLETE`), alone:
    /// closed everywhere while it is false, whatever the providers and `RELEASES` say. Test builds only: a room a test
    /// gave the table `test_app_store_create_open` has it open. A build without the `failpoints` feature never reads
    /// that table.
    fn store_create_open(&self) -> bool {
        if release_commit::RELEASE_PATH_COMPLETE {
            return true;
        }
        #[cfg(feature = "failpoints")]
        {
            rows(
                &self.state.storage().sql(),
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_app_store_create_open'",
                vec![],
            )
            .is_ok_and(|found| !found.is_empty())
        }
        #[cfg(not(feature = "failpoints"))]
        {
            false
        }
    }

    /// The store provider. Test builds only: a room a test gave `test_app_store_provider_off` has none, since the test
    /// Worker has one.
    fn store_provider(&self) -> Option<StoreProvider> {
        #[cfg(feature = "failpoints")]
        if rows(
            &self.state.storage().sql(),
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_app_store_provider_off'",
            vec![],
        )
        .is_ok_and(|found| !found.is_empty())
        {
            return None;
        }
        StoreProvider::from_env(&self.env)
    }

    /// **Before anything else of the upload,** once its recheck holds, for a release whose own last step waited on its
    /// store: its label's create outstanding is settled by the list, and the step ends there, reading nothing from
    /// GitHub. A driven step whose lease took no upload slot for that, and which finds settling no longer due, ends too,
    /// reading nothing ([`STORE_SLOT_NEEDED`]). `None` when the upload goes on.
    pub(super) async fn store_settle_first(
        &self,
        release_id: &str,
        label: &str,
        lease: Option<&release_driver::StepLease>,
    ) -> R<Option<StoreOutcome>> {
        let sql = self.state.storage().sql();
        #[cfg(feature = "failpoints")]
        release_driver::test_at(&sql, "store_first");
        let last = last_code(&sql, release_id)?;
        let due = kept(&sql, label)?.and_then(|kept| {
            let due = settles_first(Some(&kept.record()), kept.create_sent_at, last.as_deref());
            match (due, kept.create_sent_at, kept.name.clone()) {
                (true, Some(sent), Some(name)) => Some((name, sent, kept.updated_at)),
                _ => None,
            }
        });
        let Some((name, sent, last_change)) = due else {
            // The lease took no slot because settling was due when it was taken: nothing is read without one.
            if lease.is_some() && !lease_took_slot(&sql, release_id)? {
                log(&sql, release_id, STORE_SLOT_NEEDED);
                return Ok(Some(StoreOutcome::Wait(STORE_SLOT_NEEDED, None)));
            }
            return Ok(None);
        };
        let outcome = self
            .settle_store(release_id, label, &name, sent, last_change, lease)
            .await?;
        // Found and recorded made: the upload is the next step's, with its own upload slot.
        Ok(Some(match outcome {
            StoreOutcome::Go => StoreOutcome::Wait(STORE_SETTLED, None),
            other => other,
        }))
    }

    /// **After the release's files are read once and before anything is sent to the content provider:** the store, for
    /// a release that asks for one (`wants`). See the module's note.
    pub(super) async fn store_before_upload(
        &self,
        release_id: &str,
        label: &str,
        wants: bool,
        lease: Option<&release_driver::StepLease>,
    ) -> R<StoreOutcome> {
        let sql = self.state.storage().sql();
        let kept = kept(&sql, label)?;
        let step = make_step(
            wants,
            kept.as_ref().map(Kept::record).as_ref(),
            kept.as_ref().and_then(|kept| kept.create_sent_at),
        );
        match step {
            MakeStep::Nothing | MakeStep::Made => Ok(StoreOutcome::Go),
            MakeStep::Fail(why) => {
                log(&sql, release_id, why.code());
                Ok(StoreOutcome::Fail(why.code()))
            }
            // A create outstanding, for a release that asks: settled by the list now, after its read. Found, the upload
            // goes on; settled as having made nothing, it is created again at once.
            MakeStep::Settle => {
                let Some(kept) = kept else {
                    return Err(ApiError::internal("a store to settle with no record"));
                };
                let (Some(name), Some(sent)) = (kept.name.clone(), kept.create_sent_at) else {
                    return Err(ApiError::internal("a store to settle with no create"));
                };
                match self
                    .settle_store(release_id, label, &name, sent, kept.updated_at, lease)
                    .await?
                {
                    StoreOutcome::Wait(STORE_CREATE_OWED, _) => {
                        self.create_store(release_id, label, lease).await
                    }
                    other => Ok(other),
                }
            }
            MakeStep::Create => self.create_store(release_id, label, lease).await,
        }
    }

    /// Records the name and `create_sent_at`, in the transaction that runs the whole recheck again, then sends the
    /// create, behind the gate and a provider.
    async fn create_store(
        &self,
        release_id: &str,
        label: &str,
        lease: Option<&release_driver::StepLease>,
    ) -> R<StoreOutcome> {
        let sql = self.state.storage().sql();
        if !self.store_create_open() {
            log(&sql, release_id, STORE_CREATE_INCOMPLETE);
            return Ok(StoreOutcome::Wait(STORE_CREATE_INCOMPLETE, None));
        }
        let Some(provider) = self.store_provider() else {
            log(&sql, release_id, STORE_PROVIDER_MISSING);
            return Ok(StoreOutcome::Wait(STORE_PROVIDER_MISSING, None));
        };
        if !release_driver::may_go_on(&sql, lease) {
            return Ok(StoreOutcome::Wait(release_driver::LEASE_LOST, None));
        }
        let reads = self.release_reads(release_id).await?;
        let drawn = super::hostname::random_32()?;
        let mut suffix = [0_u8; 16];
        suffix.copy_from_slice(drawn.get(..16).unwrap_or(&[0; 16]));
        let drawn = store_name(u128::from_be_bytes(suffix));
        enum Recorded {
            Sent { name: String, at: i64 },
            Outcome(StoreOutcome),
        }
        let recorded: Rc<RefCell<Option<Recorded>>> = Rc::new(RefCell::new(None));
        let (slot, store, id, label_owned) = (
            recorded.clone(),
            sql.clone(),
            release_id.to_owned(),
            label.to_owned(),
        );
        let lease_owned = lease.cloned();
        transaction_sync(&self.state, move || {
            let now = release_now(&store);
            let outcome = |o: StoreOutcome| Some(Recorded::Outcome(o));
            // The whole recheck again, on the outside facts just read and the room's rows now.
            if let UploadReady::Answer(answer) = upload_ready(&store, &id, &reads, true, now)? {
                *slot.borrow_mut() = outcome(StoreOutcome::Answer(answer));
                return Ok(());
            }
            if !release_driver::may_go_on(&store, lease_owned.as_ref()) {
                *slot.borrow_mut() = outcome(StoreOutcome::Wait(release_driver::LEASE_LOST, None));
                return Ok(());
            }
            // The record again: a create is sent only while the rule still says so.
            let kept = kept(&store, &label_owned)?;
            let step = make_step(
                true,
                kept.as_ref().map(Kept::record).as_ref(),
                kept.as_ref().and_then(|kept| kept.create_sent_at),
            );
            if step != MakeStep::Create {
                *slot.borrow_mut() = outcome(StoreOutcome::Wait(STORE_UNSETTLED, None));
                return Ok(());
            }
            let name = match kept.and_then(|kept| kept.name) {
                Some(name) => {
                    exec(
                        &store,
                        "UPDATE app_store SET create_sent_at = ?, updated_at = ? WHERE label = ? AND store_id IS NULL AND create_sent_at IS NULL",
                        vec![now.into(), now.into(), label_owned.as_str().into()],
                    )?;
                    name
                }
                None => {
                    exec(
                        &store,
                        "INSERT INTO app_store (label, kind, store_name, recorded_at, create_sent_at, updated_at) VALUES (?, 'd1', ?, ?, ?, ?)",
                        vec![
                            label_owned.as_str().into(),
                            drawn.as_str().into(),
                            now.into(),
                            now.into(),
                            now.into(),
                        ],
                    )?;
                    drawn
                }
            };
            *slot.borrow_mut() = Some(Recorded::Sent { name, at: now });
            Ok(())
        })?;
        self.arm(false, false).await?;
        let recorded = recorded.borrow_mut().take();
        let (name, sent) = match recorded {
            Some(Recorded::Sent { name, at }) => (name, at),
            Some(Recorded::Outcome(outcome)) => return Ok(outcome),
            None => return Err(ApiError::internal("a store's record that answered nothing")),
        };
        // Recorded: only now is the create sent.
        match provider.create(&name).await {
            CreateAnswer::Made(store_id) => {
                self.record_made(label, &name, &store_id)?;
                log(&sql, release_id, "store_made");
                Ok(StoreOutcome::Go)
            }
            CreateAnswer::Refused => {
                log(&sql, release_id, STORE_CREATE_REFUSED);
                Ok(StoreOutcome::Fail(STORE_CREATE_REFUSED))
            }
            CreateAnswer::Unknown => {
                log(&sql, release_id, STORE_CREATE_UNANSWERED);
                // The list may find it already; anything short of that waits, under the create's code.
                match self
                    .settle_store(release_id, label, &name, sent, sent, lease)
                    .await?
                {
                    StoreOutcome::Wait(code, at)
                        if code == STORE_UNSETTLED || code == STORE_LIST_UNKNOWN =>
                    {
                        Ok(StoreOutcome::Wait(STORE_CREATE_UNANSWERED, at))
                    }
                    other => Ok(other),
                }
            }
        }
    }

    /// Records the store made, by the ID D1 gave it, on the record of the name the create was sent under. It is D1's
    /// fact, so it is recorded whether or not the step's lease still holds.
    fn record_made(&self, label: &str, name: &str, store_id: &str) -> R<()> {
        let (store, label, name, store_id) = (
            self.state.storage().sql(),
            label.to_owned(),
            name.to_owned(),
            store_id.to_owned(),
        );
        transaction_sync(&self.state, move || {
            let now = release_now(&store);
            exec(
                &store,
                "UPDATE app_store SET store_id = ?, made_at = ?, updated_at = ? WHERE label = ? AND store_name = ? AND store_id IS NULL AND create_sent_at IS NOT NULL",
                vec![
                    store_id.into(),
                    now.into(),
                    now.into(),
                    label.into(),
                    name.into(),
                ],
            )
        })
    }

    /// One whole list, read for a create of `name` sent at `sent`, whose record last changed at `last_change`: found,
    /// recorded made ([`StoreOutcome::Go`]); otherwise a wait, the first list without it that counts noted, or, on the
    /// second, the create no longer outstanding.
    async fn settle_store(
        &self,
        release_id: &str,
        label: &str,
        name: &str,
        sent: i64,
        last_change: i64,
        lease: Option<&release_driver::StepLease>,
    ) -> R<StoreOutcome> {
        let sql = self.state.storage().sql();
        let Some(provider) = self.store_provider() else {
            log(&sql, release_id, STORE_PROVIDER_MISSING);
            return Ok(StoreOutcome::Wait(STORE_PROVIDER_MISSING, None));
        };
        if !release_driver::may_go_on(&sql, lease) {
            return Ok(StoreOutcome::Wait(release_driver::LEASE_LOST, None));
        }
        let list = provider.list().await;
        let now = release_now(&sql);
        let settled = settle(list.as_deref(), name, sent, last_change, now);
        // Test builds only: a test changes the room between the list and what is written of it.
        #[cfg(feature = "failpoints")]
        release_driver::test_at(&sql, "store_listed");
        let outcome = match settled {
            Settle::Found(store_id) => {
                self.record_made(label, name, &store_id)?;
                log(&sql, release_id, "store_found");
                return Ok(StoreOutcome::Go);
            }
            Settle::Unknown => StoreOutcome::Wait(STORE_LIST_UNKNOWN, None),
            Settle::Wait { at, note_gone } => {
                // A first list that counts and can't be noted (the lease ran out) counts for nothing: the step says so.
                if note_gone
                    && !self.unsettled_write(label, name, sent, lease, "updated_at = ?", now)?
                {
                    return Ok(StoreOutcome::Wait(release_driver::LEASE_LOST, None));
                }
                StoreOutcome::Wait(STORE_UNSETTLED, Some(at))
            }
            Settle::CreateAgain => {
                if !self.unsettled_write(
                    label,
                    name,
                    sent,
                    lease,
                    "create_sent_at = NULL, updated_at = ?",
                    now,
                )? {
                    return Ok(StoreOutcome::Wait(release_driver::LEASE_LOST, None));
                }
                StoreOutcome::Wait(STORE_CREATE_OWED, None)
            }
        };
        if let StoreOutcome::Wait(code, _) = &outcome {
            log(&sql, release_id, code);
        }
        Ok(outcome)
    }

    /// A write to a create still outstanding, exactly as it was read (`sent`, `name`, nothing made), and only while the
    /// step's lease holds. Whether it was written.
    fn unsettled_write(
        &self,
        label: &str,
        name: &str,
        sent: i64,
        lease: Option<&release_driver::StepLease>,
        assignments: &'static str,
        now: i64,
    ) -> R<bool> {
        let written = Rc::new(RefCell::new(false));
        let (slot, store, label, name, lease) = (
            written.clone(),
            self.state.storage().sql(),
            label.to_owned(),
            name.to_owned(),
            lease.cloned(),
        );
        transaction_sync(&self.state, move || {
            if !release_driver::may_go_on(&store, lease.as_ref()) {
                return Ok(());
            }
            let still = !rows(
                &store,
                "SELECT 1 AS c FROM app_store WHERE label = ? AND store_name = ? AND store_id IS NULL AND create_sent_at = ?",
                vec![label.as_str().into(), name.as_str().into(), sent.into()],
            )?
            .is_empty();
            if still {
                exec(
                    &store,
                    &format!("UPDATE app_store SET {assignments} WHERE label = ?"),
                    vec![now.into(), label.as_str().into()],
                )?;
                *slot.borrow_mut() = true;
            }
            Ok(())
        })?;
        let written = *written.borrow();
        Ok(written)
    }
}

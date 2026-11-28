//! The deployment's preview switch (M8 step 6; the preview plan, `docs/m8-preview-plan.md`, 3.3 and 9.1; decisions 250
//! to 259). Read as `RELEASES` is (`crate::releases::setting`), by core's one rule
//! (`podster_core::preview::deployment_previews`): exactly `true` is on; exactly `false` is off, and only that deletes
//! every preview (the plan's 3.3, "Added for previews"); anything else, unset included, is undecided, which refuses new
//! previews as off does and deletes nothing.
//!
//! **Set nowhere.** No environment sets `PREVIEWS`: `apps/api/wrangler.jsonc` carries it for staging commented out, as
//! pending the owner's wizard for the preview dispatch namespace (decision 258). Every preview route also needs
//! `RELEASES` on, since a preview is a release record (the plan's 2): while release is off the room answers each as a
//! route nobody defined, and while release is on and previews aren't, `previews_off` (409), after who is asking.
//!
//! Test builds can also be switched on while D1 holds a table named `test_previews_on`, or given any setting as written
//! while D1 holds `test_previews_setting` (`value`, null for unset), which a test makes and drops, as for `RELEASES`.
//! Nothing here reads or writes a room, and nothing is logged.
use podster_core::preview::{deployment_previews, DeploymentPreviews};
use worker::*;

/// The Worker variable that switches previews on for a deployment. Set nowhere.
const SWITCH_VAR: &str = "PREVIEWS";

/// The deployment's preview setting, by core's rule.
pub(crate) async fn setting(env: &Env) -> DeploymentPreviews {
    let written = env.var(SWITCH_VAR).ok().map(|value| value.to_string());
    #[cfg(feature = "failpoints")]
    if let Ok(db) = env.d1("DB") {
        if test_table(&db, "test_previews_on").await {
            return DeploymentPreviews::On;
        }
        if test_table(&db, "test_previews_setting").await {
            let value = db
                .prepare("SELECT value FROM test_previews_setting LIMIT 1")
                .first::<serde_json::Value>(None)
                .await
                .ok()
                .flatten()
                .and_then(|row| row["value"].as_str().map(str::to_owned));
            return deployment_previews(value.as_deref());
        }
    }
    deployment_previews(written.as_deref())
}

/// Test builds only: whether D1 holds a table of this name.
#[cfg(feature = "failpoints")]
async fn test_table(db: &D1Database, name: &str) -> bool {
    let Ok(statement) = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .bind(&[name.into()])
    else {
        return false;
    };
    matches!(
        statement.first::<serde_json::Value>(None).await,
        Ok(Some(_))
    )
}

//! Stable error codes. Internal details are logged, never returned.
use podster_core::CoreError;
use podster_policy::Verdict;
use worker::{console_error, Response, Result};

#[derive(Debug)]
pub enum ApiError {
    Api {
        status: u16,
        code: &'static str,
    },
    /// A refusal whose message says more than its code: a fixed sentence the contract names, never anything a caller sent.
    Explained {
        status: u16,
        code: &'static str,
        message: &'static str,
    },
    Internal(String),
}

impl ApiError {
    pub const fn api(status: u16, code: &'static str) -> ApiError {
        ApiError::Api { status, code }
    }
    pub const fn explained(status: u16, code: &'static str, message: &'static str) -> ApiError {
        ApiError::Explained {
            status,
            code,
            message,
        }
    }
    pub fn invalid_assertion() -> ApiError {
        ApiError::api(401, "invalid_assertion")
    }
    pub fn workspace_not_found() -> ApiError {
        ApiError::api(404, "workspace_not_found")
    }
    pub fn access_revoked() -> ApiError {
        ApiError::api(403, "access_revoked")
    }
    pub fn not_allowed() -> ApiError {
        ApiError::api(403, "not_allowed")
    }
    pub fn task_not_found() -> ApiError {
        ApiError::api(404, "task_not_found")
    }
    pub fn role_not_found() -> ApiError {
        ApiError::api(404, "role_not_found")
    }
    pub fn role_full() -> ApiError {
        ApiError::api(409, "role_full")
    }
    pub fn already_claimed() -> ApiError {
        ApiError::api(409, "already_claimed")
    }
    pub fn lead_exists() -> ApiError {
        ApiError::api(409, "lead_exists")
    }
    pub fn plan_conflict() -> ApiError {
        ApiError::api(409, "plan_conflict")
    }
    pub fn dependency_cycle() -> ApiError {
        ApiError::api(409, "dependency_cycle")
    }
    pub fn relationship_exists() -> ApiError {
        ApiError::api(409, "relationship_exists")
    }
    pub fn relationship_not_found() -> ApiError {
        ApiError::api(404, "relationship_not_found")
    }
    pub fn not_found() -> ApiError {
        ApiError::api(404, "not_found")
    }
    pub fn invalid_wake_url() -> ApiError {
        ApiError::api(400, "invalid_wake_url")
    }
    pub fn jwt_replay() -> ApiError {
        ApiError::api(401, "jwt_replay")
    }
    pub fn ack_beyond_inbox() -> ApiError {
        ApiError::api(409, "ack_beyond_inbox")
    }
    pub fn invalid_argument() -> ApiError {
        ApiError::api(400, "invalid_argument")
    }
    pub fn agent_disconnected() -> ApiError {
        ApiError::api(403, "agent_disconnected")
    }
    pub fn agent_not_found() -> ApiError {
        ApiError::api(404, "agent_not_found")
    }
    pub fn invitation_not_found() -> ApiError {
        ApiError::api(404, "invitation_not_found")
    }
    pub fn invitation_required() -> ApiError {
        ApiError::api(403, "invitation_required")
    }
    pub fn not_in_organization() -> ApiError {
        ApiError::api(400, "not_in_organization")
    }
    pub fn workspace_archived() -> ApiError {
        ApiError::api(409, "workspace_archived")
    }
    pub fn already_member() -> ApiError {
        ApiError::api(409, "already_member")
    }
    pub fn limit_exceeded() -> ApiError {
        ApiError::api(409, "limit_exceeded")
    }
    pub fn idempotency_required() -> ApiError {
        ApiError::api(400, "idempotency_key_required")
    }
    pub fn idempotency_mismatch() -> ApiError {
        ApiError::api(422, "idempotency_mismatch")
    }
    pub fn internal(detail: &str) -> ApiError {
        ApiError::Internal(detail.to_string())
    }

    pub fn from_core(error: &CoreError) -> ApiError {
        let status = match error {
            CoreError::InvalidTransition
            | CoreError::VersionConflict
            | CoreError::CommitChanged
            | CoreError::SubmissionMismatch => 409,
            CoreError::SelfSignOff => 422,
            CoreError::NotAllowed => 403,
            CoreError::InvalidArgument(_) => 400,
            // The room skipped a check it must run. Nothing a client sent causes it.
            CoreError::FilesNotChecked => 500,
        };
        ApiError::api(status, error.code())
    }

    pub fn from_verdict(verdict: Verdict) -> std::result::Result<(), ApiError> {
        match verdict {
            Verdict::Allow => Ok(()),
            Verdict::Forbidden => Err(ApiError::not_allowed()),
            Verdict::Hidden => Err(ApiError::task_not_found()),
            // Kernel rooms are private, so a non-participant learns nothing about them.
            Verdict::NotParticipant => Err(ApiError::workspace_not_found()),
        }
    }

    pub fn status_and_code(&self) -> (u16, &'static str) {
        match self {
            ApiError::Api { status, code } | ApiError::Explained { status, code, .. } => {
                (*status, code)
            }
            ApiError::Internal(_) => (500, "internal_error"),
        }
    }

    /// The stable code, for a refusal. An internal error has none.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            ApiError::Api { code, .. } | ApiError::Explained { code, .. } => Some(code),
            ApiError::Internal(_) => None,
        }
    }

    pub fn into_response(self) -> Result<Response> {
        if let ApiError::Internal(detail) = &self {
            console_error!("internal error: {detail}");
        }
        let (status, code) = self.status_and_code();
        let message = match &self {
            ApiError::Explained { message, .. } => message,
            _ => code,
        };
        Ok(Response::from_json(
            &serde_json::json!({ "error": { "code": code, "message": message } }),
        )?
        .with_status(status))
    }
}

impl From<worker::Error> for ApiError {
    fn from(error: worker::Error) -> ApiError {
        ApiError::Internal(error.to_string())
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(error: serde_json::Error) -> ApiError {
        ApiError::Internal(error.to_string())
    }
}

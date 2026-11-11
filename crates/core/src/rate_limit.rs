//! Whether a GitHub answer is a rate limit, and how long to wait if it is (M5 security review, F1, F5 and F9). No I/O.
//!
//! A rate limit is its own outcome. It is never a refused credential, and never the provider refusing the request on
//! its merits: it says nothing about Podster's key, the installation, or the repository.
//!
//! The signals are GitHub's documented ones, in "Rate limits for the REST API", section "Exceeding the rate limit"
//! (<https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit>), and
//! "Best practices for using the REST API", section "Handle rate limit errors appropriately"
//! (<https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#handle-rate-limit-errors-appropriately>):
//!
//! - **Primary limit:** a `403` or `429`, with `x-ratelimit-remaining` at `0`. Wait until `x-ratelimit-reset`, which is
//!   in UTC epoch seconds.
//! - **Secondary limit:** a `403` or `429` whose error message says a secondary rate limit was exceeded. If
//!   `retry-after` is there, wait that many seconds. Otherwise wait at least one minute.
//! - In that order: `retry-after` first, then a spent `x-ratelimit-remaining`, then a minute.
//!
//! GitHub doesn't document the secondary limit's exact message. Its pages describe it as a message saying "you exceeded
//! a secondary rate limit", so the marker read here is that phrase, ignoring case.
//!
//! A `429` is "too many requests" by its definition, so it's a limit even with no header. A `403` is a limit only with
//! one of the signals above. Without them it stays what it was: a refusal.

/// The phrase GitHub's documentation uses for a secondary limit's error message. Matched without regard to case.
pub const SECONDARY_LIMIT_MARKER: &str = "secondary rate limit";
/// The wait when GitHub says it's a limit and gives no time: "at least one minute".
pub const DEFAULT_LIMIT_WAIT_MS: i64 = 60 * 1000;
/// The shortest wait taken, so a `retry-after: 0` or a reset already past doesn't turn into a tight loop.
pub const MIN_LIMIT_WAIT_MS: i64 = 1000;
/// The longest wait taken, whatever the headers say. A primary limit resets within the hour, so a longer time is
/// either a clock that's wrong or an answer that isn't GitHub's, and neither should park a room for longer.
pub const MAX_LIMIT_WAIT_MS: i64 = 60 * 60 * 1000;

/// What an answer said about limits: its status, the headers GitHub documents, and whether its error message carried
/// the secondary-limit marker. Header values are kept as text, as they came.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LimitSignals {
    pub status: u16,
    pub retry_after: Option<String>,
    pub remaining: Option<String>,
    pub reset: Option<String>,
    pub secondary_marker: bool,
}

/// Whether an error message carries the secondary-limit marker.
pub fn has_secondary_marker(message: &str) -> bool {
    message
        .to_ascii_lowercase()
        .contains(SECONDARY_LIMIT_MARKER)
}

fn number(value: Option<&String>) -> Option<i64> {
    value.and_then(|v| v.trim().parse::<i64>().ok())
}

/// `Some(wait in milliseconds)` if the answer is a rate limit, bounded to `[MIN_LIMIT_WAIT_MS, MAX_LIMIT_WAIT_MS]`, or
/// `None` if it isn't one. `now_ms` is the time the answer came.
pub fn rate_limit_wait_ms(signals: &LimitSignals, now_ms: i64) -> Option<i64> {
    if !matches!(signals.status, 403 | 429) {
        return None;
    }
    let retry_after = number(signals.retry_after.as_ref()).filter(|s| *s >= 0);
    let spent = number(signals.remaining.as_ref()) == Some(0);
    let reset = number(signals.reset.as_ref()).filter(|_| spent);
    let limited =
        signals.status == 429 || retry_after.is_some() || spent || signals.secondary_marker;
    if !limited {
        return None;
    }
    let wait = if let Some(seconds) = retry_after {
        seconds.saturating_mul(1000)
    } else if let Some(reset) = reset {
        reset.saturating_mul(1000).saturating_sub(now_ms)
    } else {
        DEFAULT_LIMIT_WAIT_MS
    };
    Some(wait.clamp(MIN_LIMIT_WAIT_MS, MAX_LIMIT_WAIT_MS))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_700_000_000_000;

    fn signals(status: u16) -> LimitSignals {
        LimitSignals {
            status,
            ..LimitSignals::default()
        }
    }

    #[test]
    fn a_primary_limit_waits_until_the_reset_github_gives() {
        let spent = LimitSignals {
            remaining: Some("0".into()),
            reset: Some(((NOW / 1000) + 120).to_string()),
            ..signals(403)
        };
        assert_eq!(rate_limit_wait_ms(&spent, NOW), Some(120_000));
        assert_eq!(
            rate_limit_wait_ms(
                &LimitSignals {
                    status: 429,
                    ..spent.clone()
                },
                NOW
            ),
            Some(120_000)
        );
    }

    #[test]
    fn retry_after_comes_first() {
        let both = LimitSignals {
            retry_after: Some("30".into()),
            remaining: Some("0".into()),
            reset: Some(((NOW / 1000) + 600).to_string()),
            ..signals(403)
        };
        assert_eq!(rate_limit_wait_ms(&both, NOW), Some(30_000));
    }

    #[test]
    fn a_secondary_limit_with_no_time_waits_a_minute() {
        let secondary = LimitSignals {
            secondary_marker: true,
            ..signals(403)
        };
        assert_eq!(
            rate_limit_wait_ms(&secondary, NOW),
            Some(DEFAULT_LIMIT_WAIT_MS)
        );
        assert!(has_secondary_marker(
            "You have exceeded a Secondary Rate Limit. Please wait."
        ));
        assert!(!has_secondary_marker(
            "Resource not accessible by integration"
        ));
    }

    #[test]
    fn a_429_is_a_limit_even_with_no_header() {
        assert_eq!(
            rate_limit_wait_ms(&signals(429), NOW),
            Some(DEFAULT_LIMIT_WAIT_MS)
        );
    }

    #[test]
    fn a_403_with_no_signal_stays_a_refusal() {
        assert_eq!(rate_limit_wait_ms(&signals(403), NOW), None);
        // Requests left: not spent, whatever the reset says.
        let left = LimitSignals {
            remaining: Some("4999".into()),
            reset: Some(((NOW / 1000) + 60).to_string()),
            ..signals(403)
        };
        assert_eq!(rate_limit_wait_ms(&left, NOW), None);
        // Unreadable headers say nothing.
        let garbled = LimitSignals {
            retry_after: Some("soon".into()),
            remaining: Some("none".into()),
            ..signals(403)
        };
        assert_eq!(rate_limit_wait_ms(&garbled, NOW), None);
    }

    #[test]
    fn other_statuses_are_never_a_limit() {
        for status in [200, 201, 204, 401, 404, 422, 500, 502, 503] {
            let everything = LimitSignals {
                retry_after: Some("30".into()),
                remaining: Some("0".into()),
                reset: Some(((NOW / 1000) + 30).to_string()),
                secondary_marker: true,
                status,
            };
            assert_eq!(rate_limit_wait_ms(&everything, NOW), None, "{status}");
        }
    }

    #[test]
    fn the_wait_is_bounded_both_ways() {
        let far = LimitSignals {
            retry_after: Some("86400".into()),
            ..signals(429)
        };
        assert_eq!(rate_limit_wait_ms(&far, NOW), Some(MAX_LIMIT_WAIT_MS));
        let past = LimitSignals {
            remaining: Some("0".into()),
            reset: Some(((NOW / 1000) - 600).to_string()),
            ..signals(403)
        };
        assert_eq!(rate_limit_wait_ms(&past, NOW), Some(MIN_LIMIT_WAIT_MS));
        let zero = LimitSignals {
            retry_after: Some("0".into()),
            ..signals(403)
        };
        assert_eq!(rate_limit_wait_ms(&zero, NOW), Some(MIN_LIMIT_WAIT_MS));
        let huge = LimitSignals {
            retry_after: Some(i64::MAX.to_string()),
            ..signals(403)
        };
        assert_eq!(rate_limit_wait_ms(&huge, NOW), Some(MAX_LIMIT_WAIT_MS));
    }
}

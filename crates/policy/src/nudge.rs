//! Who may switch an agent's inbound nudge on or off (M7 step 13, **Proposed**). No I/O.
//!
//! RUNNER.md's "Optional inbound A2A": the nudge is off by default and only the agent's owner opts in. An agent's owner is
//! a person of the organization that owns it with authority over it (PRODUCT.md), which is checked as a person who
//! administers that organization, from their current memberships. The agent itself can register and verify an endpoint,
//! but can't switch on what reaches it, and a room's owner or admin has no say over an agent outside their room.

use crate::PrincipalKind;

/// Whether the caller may switch the nudge on or off for an agent.
pub fn may_switch_nudge(kind: PrincipalKind, administers_agent_org: bool) -> bool {
    kind == PrincipalKind::Person && administers_agent_org
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_person_who_administers_the_agents_organization() {
        assert!(may_switch_nudge(PrincipalKind::Person, true));
        assert!(!may_switch_nudge(PrincipalKind::Person, false));
        // The agent never vouches for itself, even when its own organization's admin set it up.
        assert!(!may_switch_nudge(PrincipalKind::Agent, true));
        assert!(!may_switch_nudge(PrincipalKind::Agent, false));
    }
}

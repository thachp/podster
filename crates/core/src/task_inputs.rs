//! A task's prompt inputs, and which of them a decision wrote (M7 step 4; RUNNER.md, "Prompt inputs"; decision 228).
//!
//! A run's prompt is exactly the task's title, instructions and acceptance criteria, plus, on a rerun, the reviewer's latest
//! change request. Runner's run policy lets the least-trusted author of any of them decide, so the room records who last
//! wrote each one, from the decision that wrote it and nothing a client sends. This only says which inputs a decision
//! wrote; who wrote them is the actor the room already authenticated, and who may read that is `podster_policy::provenance`.

use crate::{Decision, EventKind, Task};

/// One prompt input. The names are the room's stored values and the API's, and never change.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PromptInput {
    Title,
    Instructions,
    AcceptanceCriteria,
    /// The reviewer's latest change request, which is its `task.changes_requested` event's reason.
    ChangeRequest,
}

impl PromptInput {
    /// In the order a reader is shown them.
    pub const ALL: [PromptInput; 4] = [
        PromptInput::Title,
        PromptInput::Instructions,
        PromptInput::AcceptanceCriteria,
        PromptInput::ChangeRequest,
    ];

    pub fn name(self) -> &'static str {
        match self {
            PromptInput::Title => "title",
            PromptInput::Instructions => "instructions",
            PromptInput::AcceptanceCriteria => "acceptance_criteria",
            PromptInput::ChangeRequest => "change_request",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        PromptInput::ALL.into_iter().find(|i| i.name() == name)
    }
}

/// The inputs `decision` wrote, in [`PromptInput::ALL`]'s order. `before` is the task as it was, or `None` for a task the
/// decision created, which wrote every input it has. Otherwise an input was written only if its text changed: the same
/// text written again leaves it with whoever wrote it, since the words are still theirs. A change request is written by
/// the decision that records one.
pub fn written(before: Option<&Task>, decision: &Decision) -> Vec<PromptInput> {
    let after = &decision.task;
    let changed = |input: PromptInput| match (input, before) {
        (PromptInput::ChangeRequest, _) => decision
            .events
            .iter()
            .any(|e| e.kind == EventKind::TaskChangesRequested),
        (PromptInput::AcceptanceCriteria, None) => after.acceptance_criteria.is_some(),
        (_, None) => true,
        (PromptInput::Title, Some(b)) => b.title != after.title,
        (PromptInput::Instructions, Some(b)) => b.instructions != after.instructions,
        (PromptInput::AcceptanceCriteria, Some(b)) => {
            after.acceptance_criteria.is_some()
                && b.acceptance_criteria != after.acceptance_criteria
        }
    };
    PromptInput::ALL
        .into_iter()
        .filter(|i| changed(*i))
        .collect()
}

/// Whether `decision` made someone the task's requester: its creation, or a change of requester. The room records the
/// requester's organization then, so it means the same as an input author's: the organization when they took the part.
pub fn requester_set(before: Option<&Task>, decision: &Decision) -> bool {
    before.is_none_or(|b| b.requester != decision.task.requester)
}

/// The longest author ID or organization the room records, as its column checks allow.
pub const MAX_AUTHOR_BYTES: usize = 128;

/// Whether the room can record this author. A command whose author it can't record is refused before anything is written,
/// rather than failing on the table's checks partway through. An empty organization is never recorded: say none instead.
pub fn recordable_author(id: &str, org: Option<&str>) -> bool {
    let fits = |s: &str| !s.is_empty() && s.len() <= MAX_AUTHOR_BYTES;
    fits(id) && org.is_none_or(fits)
}

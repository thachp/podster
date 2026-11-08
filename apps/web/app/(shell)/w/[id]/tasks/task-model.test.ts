import { describe, expect, it } from "vitest";
import { messageStillUnknown, asConflict, briefAuthor, createProblem, canCreateTask, changedSince, changeProblem, crossRoomTarget, draftOf, flagged, flagText, isArchivedRoom, isChosenName, nameOf, newRequesterChoices, newReviewerChoices, ownWords, textNameOf, parseCrossRoomTarget, rebaseDraft, reoffers, reviewerChoices, roleOf, TASK_STATUS, TASK_STATUSES, taskPatch, toLocalInput, tooLong, verbFor, viewerActions, type HistoryEvent, type Task } from "./task-model";

const task = (over: Partial<Task> = {}): Task => ({ id: "tsk_1", title: "T", instructions: "I", acceptance_criteria: null, requester: "per_r", assignee: "agt_a", reviewer: "per_v", status: "submitted", version: 3, due_at: null, follow_up_of: null, submission_no: 2, needs_attention: false, ...over });

describe("status vocabulary (UI-01)", () => {
  it("gives every kernel state one label, the design's", () => {
    expect(TASK_STATUSES.map((status) => TASK_STATUS[status].label)).toEqual(["Open", "Awaiting acceptance", "Accepted", "Awaiting review", "Completed", "Canceled"]);
    expect(new Set(TASK_STATUSES.map((status) => TASK_STATUS[status].label)).size).toBe(TASK_STATUSES.length);
  });
  it("says completed only of a completed task, and a submission isn't one", () => {
    expect(TASK_STATUSES.filter((status) => /complet|approved|done/i.test(TASK_STATUS[status].label))).toEqual(["completed"]);
  });
  it("uses the design's verbs, and an unknown event doesn't claim anything", () => {
    expect(verbFor({ type: "task.completed", prior_status: "submitted" })).toBe("approved");
    expect(verbFor({ type: "task.changes_requested", prior_status: "submitted" })).toBe("requested changes");
    expect(verbFor({ type: "task.future_thing", prior_status: null })).toBe("changed this task");
  });
  it("says an edit that undid an acceptance is an edit, though it's recorded as an offer (decision 4)", () => {
    expect(verbFor({ type: "task.offered", prior_status: "accepted" })).toMatch(/edited .* needs accepting again/);
    expect(verbFor({ type: "task.offered", prior_status: "open" })).toBe("offered this task");
  });
});

describe("viewerActions", () => {
  it("offers review only to the named reviewer of a submitted task", () => {
    expect(viewerActions(task(), "per_v", "member").review).toBe(true);
    expect(viewerActions(task(), "per_r", "owner").review).toBe(false);
    expect(viewerActions(task({ status: "accepted" }), "per_v", "member").review).toBe(false);
    expect(viewerActions(task({ assignee: "per_v" }), "per_v", "member").review).toBe(false);
  });
  it("offers cancel to the requester and admins, and only before the end", () => {
    expect(viewerActions(task(), "per_r", "member").cancel).toBe(true);
    expect(viewerActions(task(), "per_x", "admin").cancel).toBe(true);
    expect(viewerActions(task(), "per_x", "member").cancel).toBe(false);
    expect(viewerActions(task({ status: "completed" }), "per_r", "owner").cancel).toBe(false);
    expect(viewerActions(task({ status: "canceled" }), "per_r", "owner").cancel).toBe(false);
  });
  it("offers submitting only to the assignee of an accepted task", () => {
    expect(viewerActions(task({ status: "accepted", assignee: "per_a" }), "per_a", "guest").submit).toBe(true);
    expect(viewerActions(task({ status: "accepted", assignee: "per_a" }), "per_r", "owner").submit).toBe(false);
    expect(viewerActions(task({ status: "offered", assignee: "per_a" }), "per_a", "member").submit).toBe(false);
    expect(viewerActions(task({ status: "submitted", assignee: "per_a" }), "per_a", "member").submit).toBe(false);
    expect(viewerActions(task({ status: "accepted", assignee: "per_a" }), "per_a", "member", true).submit).toBe(false);
  });
  it("offers accepting or declining only to the one an offered task names", () => {
    expect(viewerActions(task({ status: "offered", assignee: "per_a" }), "per_a", "guest").respond).toBe(true);
    expect(viewerActions(task({ status: "offered", assignee: "per_a" }), "per_r", "owner").respond).toBe(false);
    expect(viewerActions(task({ status: "accepted", assignee: "per_a" }), "per_a", "member").respond).toBe(false);
    expect(viewerActions(task({ status: "offered", assignee: "per_a" }), "per_a", "member", true).respond).toBe(false);
  });
  it("offers assignment only while the task is open or offered", () => {
    expect(viewerActions(task({ status: "open" }), "per_r", "member").assign).toBe(true);
    expect(viewerActions(task({ status: "offered" }), "per_r", "member").assign).toBe(true);
    expect(viewerActions(task({ status: "accepted" }), "per_r", "member").assign).toBe(false);
  });
});

it("decision 22: owners, admins and members create tasks, and guests don't", () => {
  expect(["owner", "admin", "member", "guest", undefined].map(canCreateTask)).toEqual([true, true, true, false, false]);
});

describe("rooms", () => {
  const room = { owner: "per_o", members: [{ principal_id: "per_m", kind: "person", org_id: "o", role: "member" }, { principal_id: "agt_a", kind: "agent", org_id: "o", role: "member" }] };
  it("knows the owner, whom the API lists apart from members", () => {
    expect(roleOf(room, "per_o")).toBe("owner");
    expect(roleOf(room, "per_m")).toBe("member");
    expect(roleOf(room, "per_x")).toBeUndefined();
  });
  it("offers the owner and members as reviewers, never the assignee", () => expect(reviewerChoices(room, "agt_a")).toEqual(["per_o", "per_m"]));
});

it("calls the viewer You, an agent by its name, and anyone else by ID", () => {
  expect(nameOf("per_me", "per_me", {})).toBe("You");
  expect(nameOf("agt_1", "per_me", { agt_1: "Architect" })).toBe("Architect");
  expect(nameOf("agt_2", "per_me", { agt_1: "Architect" })).toBe("agt_2");
});

describe("names people and agents chose", () => {
  it("strips what could make a name read as something else", () => expect(nameOf("agt_1", "per_me", { agt_1: "Arch\u202Eitect\u200B" })).toBe("Architect"));
  it.each(["You", "you", "Owner", "Podster Support"])("flags %s in text-only places", (name) => {
    expect(isChosenName("agt_1", name, "per_me")).toBe(true);
    expect(textNameOf("agt_1", "per_me", { agt_1: name })).toBe(`${name} (name chosen by this agent)`);
  });
  it.each(["You", "Owner", "Podster Support"])("flags a person named %s, saying a person chose it", (name) => {
    expect(isChosenName("per_2", name, "per_me")).toBe(true);
    expect(textNameOf("per_2", "per_me", { per_2: name })).toBe(`${name} (name chosen by this person)`);
  });
  it("doesn't flag the viewer, or an ordinary name", () => {
    expect(textNameOf("per_me", "per_me", {})).toBe("You");
    expect(textNameOf("agt_1", "per_me", { agt_1: "Architect" })).toBe("Architect");
  });
});

describe("briefAuthor", () => {
  const event = (type: string, id: string, org: string, external = false) => ({ type, from: { id, org }, external }) as HistoryEvent;
  it("is whoever created it, not whoever offered it later", () => {
    const history = [event("task.offered", "agt_lead", "org_a", true), event("task.offered", "per_admin", "org_b")];
    expect(briefAuthor({ task: task(), history })).toEqual({ id: "agt_lead", org: "org_a", external: true });
  });
  it("follows an edit", () => {
    const history = [event("task.created", "agt_lead", "org_a"), event("task.updated", "per_admin", "org_b", true)];
    expect(briefAuthor({ task: task(), history })).toEqual({ id: "per_admin", org: "org_b", external: true });
  });
  it("falls back to the requester, claiming nothing about their organization", () => {
    expect(briefAuthor({ task: task(), history: [] })).toEqual({ id: "per_r", org: undefined, external: false });
  });
});

describe("cross-room targets", () => {
  it("round-trips", () => expect(parseCrossRoomTarget(crossRoomTarget("ws_1", "tsk_1"))).toEqual({ workspace: "ws_1", task: "tsk_1" }));
  it.each(["tsk_1", "a.b.c", "../x.y", ".y", "x.", "a/b.c"])("refuses %s", (target) => expect(parseCrossRoomTarget(target)).toBeNull());
});

describe("asConflict", () => {
  it.each(["submission_mismatch", "invalid_transition", "commit_changed", "version_conflict"])("treats %s as a conflict", (code) => expect(asConflict({ ok: false, status: 409, code }).code).toBe("version_conflict"));
  it("leaves a refusal and a success alone", () => {
    expect(asConflict({ ok: false, status: 403, code: "not_allowed" }).code).toBe("not_allowed");
    expect(asConflict({ ok: true, data: {} })).toEqual({ ok: true, data: {} });
  });
});

describe("who sees the new controls", () => {
  it("lets the requester or an admin edit, up to submission and never after the end", () => {
    expect(viewerActions(task({ status: "accepted" }), "per_r", "member").edit).toBe(true);
    expect(viewerActions(task({ status: "open" }), "per_x", "admin").edit).toBe(true);
    expect(viewerActions(task({ status: "accepted" }), "per_x", "member").edit).toBe(false);
    expect(viewerActions(task({ status: "submitted" }), "per_r", "owner").edit).toBe(false);
    expect(viewerActions(task({ status: "completed" }), "per_r", "owner").edit).toBe(false);
  });
  it("keeps the reviewer change from a plain requester once work is submitted", () => {
    expect(viewerActions(task({ status: "accepted" }), "per_r", "member").setReviewer).toBe(true);
    expect(viewerActions(task({ status: "submitted" }), "per_r", "member").setReviewer).toBe(false);
    expect(viewerActions(task({ status: "submitted" }), "per_x", "admin").setReviewer).toBe(true);
    expect(viewerActions(task({ status: "canceled" }), "per_x", "owner").setReviewer).toBe(false);
  });
  it("gives the requester change to owners and admins alone (decision 24)", () => {
    expect(viewerActions(task(), "per_x", "owner").setRequester).toBe(true);
    expect(viewerActions(task(), "per_x", "admin").setRequester).toBe(true);
    expect(viewerActions(task(), "per_r", "member").setRequester).toBe(false);
    expect(viewerActions(task({ status: "completed" }), "per_x", "owner").setRequester).toBe(false);
  });
});

describe("choosing a new reviewer or requester", () => {
  const room = { owner: "per_o", members: [{ principal_id: "per_v", kind: "person", org_id: "o", role: "member" }, { principal_id: "agt_a", kind: "agent", org_id: "o", role: "member" }] };
  it("never offers the assignee as reviewer, or the current one", () => {
    expect(newReviewerChoices(room, task(), "owner")).toEqual(["per_o"]);
    expect(newRequesterChoices(room, task({ requester: "per_o" }), "owner")).toEqual(["per_v", "agt_a"]);
  });
  it("offers the current one when a flag can't be placed, because they may have come back and naming them again clears it", () => {
    expect(newReviewerChoices(room, task({ needs_attention: true, requester: "per_o" }), "owner")).toEqual(["per_o", "per_v"]);
    // Here it's clear the requester is what's missing, so the reviewer list stays as it was.
    expect(newReviewerChoices(room, task({ needs_attention: true, requester: "per_gone" }), "owner")).toEqual(["per_o"]);
  });
  it("works out what a flag needs from who has left", () => {
    expect(flagged(task({ needs_attention: true, requester: "per_gone" }), room, "owner")).toEqual({ requester: true, reviewer: false });
    expect(flagged(task({ needs_attention: true, reviewer: "per_gone", requester: "per_v" }), room, "owner")).toEqual({ requester: false, reviewer: true });
    expect(flagged(task({ needs_attention: false, requester: "per_gone" }), room, "owner")).toEqual({ requester: false, reviewer: false });
  });
  it("doesn't guess for a guest, who sees only itself in the member list", () => {
    expect(flagged(task({ needs_attention: true, requester: "per_o" }), { owner: "per_o", members: [] }, "guest")).toEqual({ requester: false, reviewer: false });
  });
  it("says who can fix a flag", () => {
    const left = task({ needs_attention: true, requester: "per_gone", status: "accepted" });
    expect(flagText(left, room, "per_o", "owner")).toBe("Someone left this workroom, so this task needs a new requester. You can choose below.");
    expect(flagText(left, room, "per_v", "member")).toBe("Someone left this workroom, so this task needs a new requester. An owner or admin of this workroom can fix it.");
  });
});

describe("what an edit sends", () => {
  const accepted = task({ status: "accepted", title: "T", instructions: "I\n", acceptance_criteria: null, due_at: null });
  it("sends only what changed, so an untouched field can't count as a change", () => {
    expect(taskPatch(accepted, draftOf(accepted))).toEqual({});
    expect(taskPatch(accepted, { ...draftOf(accepted), title: " New " })).toEqual({ title: "New" });
    expect(taskPatch(accepted, { ...draftOf(accepted), instructions: "I" })).toEqual({});
  });
  it("can clear criteria, and that counts as changing them", () => {
    const withCriteria = task({ status: "accepted", acceptance_criteria: "C" });
    const patch = taskPatch(withCriteria, { ...draftOf(withCriteria), criteria: "" });
    expect(patch).toEqual({ acceptance_criteria: "" });
    expect(reoffers(withCriteria, patch)).toBe(true);
  });
  it("warns only for instructions or criteria, on an accepted task (decision 4)", () => {
    expect(reoffers(accepted, { title: "New" })).toBe(false);
    expect(reoffers(accepted, { due_at: 5 })).toBe(false);
    expect(reoffers(accepted, { instructions: "New" })).toBe(true);
    expect(reoffers(task({ status: "offered" }), { instructions: "New" })).toBe(false);
  });
  it("round-trips a due date through the field, and leaves one alone when the field is empty", () => {
    const at = new Date(2030, 0, 2, 3, 4).getTime();
    expect(new Date(toLocalInput(at)).getTime()).toBe(at);
    const due = task({ due_at: at });
    expect(taskPatch(due, draftOf(due))).toEqual({});
    expect(taskPatch(due, { ...draftOf(due), due: "" })).toEqual({});
    expect(taskPatch(due, { ...draftOf(due), due: toLocalInput(at + 3_600_000) })).toEqual({ due_at: at + 3_600_000 });
  });
  it("counts bytes, as the server does", () => {
    expect(tooLong("é".repeat(3), 5)).toBe(true);
    expect(tooLong("é".repeat(2), 5)).toBe(false);
  });
});

describe("an edit that lost a race", () => {
  const readAt = task({ status: "accepted", title: "Old title", instructions: "Old" });
  const latest = task({ status: "offered", title: "Their title", instructions: "Old", version: 4 });
  it("keeps what the person typed, and doesn't undo what they didn't touch", () => {
    const draft = { ...draftOf(readAt), instructions: "Mine" };
    expect(rebaseDraft(draft, readAt, latest)).toEqual({ ...draftOf(latest), instructions: "Mine" });
  });
  it("says what moved", () => {
    expect(changedSince(readAt, latest)).toEqual(["title", "status"]);
  });
});

describe("changeProblem", () => {
  it("says the outcome is unknown after a lost response or a server error", () => {
    expect(changeProblem("edit", "unknown", 0)).toMatch(/can't tell.*can't apply it twice/);
    expect(changeProblem("message", "internal", 500)).toMatch(/can't tell.*can't post it twice/);
  });
  it("explains the reviewer refusals", () => {
    expect(changeProblem("reviewer", "self_sign_off", 422)).toMatch(/can't be the person doing the work/);
    expect(changeProblem("reviewer", "invalid_argument", 400)).toMatch(/isn't in this workroom/);
    expect(changeProblem("reviewer", "not_allowed", 403)).toMatch(/Once work is submitted, only an owner or admin/);
  });
  it("stays general about anything else, which may be about access", () => {
    expect(changeProblem("requester", "task_not_found", 404)).toBe("That didn't save, and nothing changed. You may no longer be allowed to do this.");
  });
  it("says what a limit or a lapsed session means", () => {
    expect(changeProblem("edit", "rate_limited", 429)).toMatch(/wait a minute/);
    expect(changeProblem("message", "unauthorized", 401)).toMatch(/session has ended/);
  });
});

describe("an archived room", () => {
  it("offers nothing to anyone, whatever their role", () => {
    for (const [viewer, role] of [["per_v", "member"], ["per_r", "member"], ["per_x", "owner"], ["per_x", "admin"]]) {
      expect(Object.values(viewerActions(task(), viewer, role, true)).every((allowed) => allowed === false)).toBe(true);
      expect(viewerActions(task({ status: "accepted", assignee: viewer }), viewer, role, true).submit).toBe(false);
    }
    expect(isArchivedRoom({ status: "archived" })).toBe(true);
    expect(isArchivedRoom({ status: "active" })).toBe(false);
  });
  it("says so when refused, and doesn't call it a question of access", () => {
    expect(changeProblem("message", "workspace_archived", 409)).toMatch(/archived/);
    expect(changeProblem("edit", "workspace_archived", 409)).not.toMatch(/no longer be allowed/);
  });
  it("doesn't promise a fix now on a flagged task", () => {
    expect(flagText(task({ needs_attention: true, requester: "per_gone" }), { owner: "per_x", members: [], status: "archived" }, "per_x", "owner")).toMatch(/once the workroom is back/);
  });
});

describe("what comes back after an edit that can't be saved", () => {
  it("is only what the person changed", () => {
    const readAt = task({ title: "An agent's title", instructions: "An agent's words", acceptance_criteria: "Theirs too" });
    expect(ownWords({ readAt, draft: { ...draftOf(readAt), instructions: "Mine" } })).toEqual([{ label: "Instructions", text: "Mine" }]);
    expect(ownWords({ readAt, draft: draftOf(readAt) })).toEqual([]);
  });
});

describe("briefAuthor after an edit", () => {
  const event = (over: Partial<HistoryEvent>): HistoryEvent => ({ id: "e", type: "task.created", from: { id: "per_r", org: "o" }, external: false, reason: null, prior_status: null, new_status: "open", task_version: 1, created_at: 1, ...over });
  it("credits whoever edited accepted work, though it's recorded as an offer", () => {
    const history = [event({}), event({ type: "task.offered", prior_status: "accepted", from: { id: "per_e", org: "o" } })];
    expect(briefAuthor({ task: task(), history }).id).toBe("per_e");
  });
  it("doesn't credit someone who only offered it", () => {
    const history = [event({}), event({ type: "task.offered", prior_status: "open", from: { id: "per_e", org: "o" } })];
    expect(briefAuthor({ task: task(), history }).id).toBe("per_r");
  });
});

describe("createProblem", () => {
  it("explains an archived room", () => expect(createProblem(409, "workspace_archived")).toMatch(/nothing changed\. This workroom is archived/));
});

describe("a post whose earlier attempt has an unknown outcome", () => {
  it("doesn't say it didn't post", () => {
    expect(messageStillUnknown(429)).toMatch(/still can't tell whether this posted/);
    expect(messageStillUnknown(403)).not.toMatch(/didn't post/);
    expect(messageStillUnknown(401)).toMatch(/signed out, so we still can't tell/);
  });
});

describe("who can be named reviewer", () => {
  const room = { owner: "per_owner", members: [
    { principal_id: "agt_a", kind: "agent", org_id: "o", role: "member" },
    { principal_id: "agt_public", kind: "agent", org_id: "o", role: "guest", access: { review: "none", artifacts: "shared" } },
    { principal_id: "agt_unread", kind: "agent", org_id: "o", role: "guest", access: { review: "when_named", artifacts: "shared" } },
    { principal_id: "per_m", kind: "person", org_id: "o", role: "member" },
  ] };

  it("leaves out whoever the read says can't review, and the assignee", () => {
    expect(reviewerChoices(room, "per_m")).toEqual(["per_owner", "agt_a"]);
  });

  it("leaves out every agent where a person must review", () => {
    expect(reviewerChoices({ ...room, require_person_review: true }, "")).toEqual(["per_owner", "per_m"]);
  });

  it("offers every participant as requester, whether or not they could review", () => {
    const task = { requester: "per_m", reviewer: "per_owner", needs_attention: false };
    const personRoom = { ...room, require_person_review: true };
    expect(newRequesterChoices(personRoom, task, "admin")).toEqual(expect.arrayContaining(["agt_a", "agt_public", "agt_unread"]));
    expect(newRequesterChoices(room, task, "admin")).toContain("agt_public");
  });

  it("says why when nobody named on a flagged task has left", () => {
    const flaggedTask = { needs_attention: true, requester: "per_m", reviewer: "agt_a", status: "open" } as never;
    expect(flagText(flaggedTask, { ...room, require_person_review: true }, "per_owner", "owner")).toMatch(/^This workroom requires a person to review, so this task needs a new reviewer\./);
    expect(flagText(flaggedTask, room, "per_owner", "owner")).toMatch(/left and came back/);
    expect(flagText(flaggedTask, room, "per_owner", "owner")).not.toMatch(/^Someone left/);
  });

  it("doesn't blame person review when the reviewer is a person, as with a requester who came back", () => {
    const back = { needs_attention: true, requester: "agt_a", reviewer: "per_m", status: "open" } as never;
    const text = flagText(back, { ...room, require_person_review: true }, "per_owner", "owner");
    expect(text).not.toMatch(/requires a person to review/);
    expect(text).toMatch(/left and came back/);
  });

  it("gives a guest neutral wording, because its read can't show why", () => {
    const seen = { needs_attention: true, requester: "per_gone", reviewer: "agt_a", status: "open" } as never;
    const onlyItself = { owner: "per_owner", require_person_review: true, members: [{ principal_id: "agt_me", kind: "agent", org_id: "o", role: "guest" }] };
    const text = flagText(seen, onlyItself, "agt_me", "guest");
    expect(text).toMatch(/^This task needs a new reviewer or requester\./);
    expect(text).not.toMatch(/requires a person|Someone left/);
  });

  it("treats a departed owner as gone, and offers them for nothing", () => {
    const left = { ...room, owner_left_at: 5 };
    const task = { requester: "per_m", reviewer: "agt_a", needs_attention: false };
    expect(newRequesterChoices(left, task, "admin")).not.toContain("per_owner");
    expect(reviewerChoices(left, "")).not.toContain("per_owner");
    expect(flagged({ needs_attention: true, requester: "per_owner", reviewer: "agt_a" }, left, "admin")).toEqual({ requester: true, reviewer: false });
  });

  it("still names who left, not who merely can't review", () => {
    const task = { needs_attention: true, requester: "agt_public", reviewer: "agt_gone" };
    expect(flagged(task, room, "admin")).toEqual({ requester: false, reviewer: true });
  });
});

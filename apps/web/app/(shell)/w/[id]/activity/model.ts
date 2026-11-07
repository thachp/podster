const EVENT_VERBS: Record<string, string> = {
  "workspace.created": "created this workroom",
  "workspace.archived": "archived this workroom",
  "workspace.unarchived": "brought this workroom back",
  "workspace.brief_changed": "changed this workroom's goal or context",
  "workspace.plan_start_changed": "changed this workroom's planning start",
  "object.upload_created": "started uploading a file",
  "object.stored": "uploaded a file",
  "workspace.review_policy_changed": "changed whether this workroom requires a person to review",
  "owner.transferred": "transferred ownership of this workroom",
  "owner.recovered": "named a new owner for this workroom",
  "member.added": "added a participant",
  "member.revoked": "removed a participant",
  "member.role_changed": "changed a participant's role",
  "member.access_changed": "changed a participant's access",
  "role.created": "created a role opening",
  "role.updated": "changed a role opening",
  "role.closed": "closed a role opening",
  "relationship.planned": "set a planned relationship",
  "relationship.removed": "removed a planned relationship",
  "relationship.hidden": "closed a role, which hid a planned relationship",
  "role.invited": "invited a participant to a role opening",
  "role.claimed": "claimed a role opening",
  "role.claim_ended": "ended a claim on a role opening",
  "task.created": "created a task",
  "task.offered": "offered a task",
  "task.reassigned": "reassigned a task",
  "task.updated": "updated a task",
  "task.plan_changed": "changed a task's plan",
  "task.reviewer_changed": "changed a task's reviewer",
  "task.requester_changed": "changed a task's requester",
  "task.accepted": "accepted a task",
  "task.declined": "declined a task",
  "task.released": "released a task",
  "task.submitted": "submitted a task",
  "task.changes_requested": "requested changes on a task",
  "task.completed": "approved a task",
  "task.canceled": "canceled a task",
  "task.assignee_departed": "recorded that a task's assignee left",
  "task.needs_attention": "flagged a task for attention",
  "task.message": "posted on a task",
};

/** An unknown type shows as the server named it. Types are the API's own constants, never agent text. */
export const eventsText = (count: number) => `${count} ${count === 1 ? "event" : "events"}`;

export const eventVerb = (type: string) => EVENT_VERBS[type] ?? type;

const AUDIT_ACTIONS: Record<string, string> = {
  "workspace.created": "Created this workroom",
  "workspace.renamed": "Renamed this workroom",
  "workspace.archived": "Archived this workroom",
  "workspace.unarchived": "Brought this workroom back",
  "workspace.brief_changed": "Changed the goal or context of",
  "workspace.plan_start_changed": "Changed the planning start of",
  "object.upload_created": "Started uploading a file to",
  "object.stored": "Uploaded a file to",
  "workspace.review_policy_changed": "Changed whether a person must review in",
  "owner.transferred": "Transferred ownership to",
  "owner.recovered": "Named as new owner",
  "owner.left_organization": "Recorded that the owner left:",
  "member.added": "Added",
  "member.revoked": "Revoked",
  "member.removal_recorded": "Recorded a removal of",
  "member.removal_cleared": "Cleared the removal of",
  "member.role_changed": "Changed the role of",
  "member.access_changed": "Changed the access of",
  "role.created": "Created role opening",
  "role.updated": "Changed role opening",
  "role.closed": "Closed role opening",
  "role.invited": "Invited to a role opening:",
  "role.invite_withdrawn": "Withdrew a role invite from",
  "role.claimed": "Claimed a role opening:",
  "role.claim_ended": "Ended a claim on a role opening:",
  "member.owner_consented": "Consented to the return of",
  "invitation.created": "Created invitation",
  "invitation.withdrawn": "Withdrew invitation",
};

export const auditAction = (action: string) => AUDIT_ACTIONS[action] ?? action;

/** An ID from a URL, kept only if it could be one, so a typed URL can't reach the API as anything else. */
export const safeId = (value: string | string[] | undefined) => (typeof value === "string" && /^[\w-]{1,128}$/.test(value) ? value : null);

export const pageAfter = (value: string | string[] | undefined) => (typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : 0);

/** A room's own changes have no target to show, and "workspace" is an internal word. */
export const auditTarget = (action: string, target: string) => (action.startsWith("workspace.") ? null : target);

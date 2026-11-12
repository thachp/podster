-- Which room an app's host label belongs to (M6 step 2, ADR 0010), so an operator's suspension of an app by its label,
-- and the reconciles, can find the room to ask. IDs only: the label and the room's ID. A read model: it never
-- authorizes and never decides what is served. The room's own state gives every answer, and an entry or script whose
-- room this table can't name is reported to an operator, never deleted on this table's word. A label is never used
-- again, so a row is never updated to another room. Nothing writes this table yet.
CREATE TABLE app_label_index (
  label TEXT PRIMARY KEY CHECK (length(label) BETWEEN 1 AND 26 AND label NOT GLOB '*[^a-z0-9]*'),
  workspace_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Which kind of label each `app_label_index` label is (M8 step 5; docs/m8-preview-plan.md, 3.1 and 9.4; decision 250):
-- a room's production label or its preview label, both drawn from the one never-reused space the index holds. A label
-- with no row here is `production`, so every label indexed before previews stays production's. IDs only. A read model
-- that only routes: it never authorizes and never decides what is served. The host's kind comes from its serve entry
-- and the room's own state, never from this table or the host's name. A label's kind never changes, so a row is never
-- updated. Nothing writes this table yet.
CREATE TABLE app_label_kind (
  label TEXT PRIMARY KEY CHECK (length(label) BETWEEN 1 AND 26 AND label NOT GLOB '*[^a-z0-9]*'),
  kind TEXT NOT NULL CHECK (kind IN ('production', 'preview'))
) WITHOUT ROWID;

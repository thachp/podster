-- Explore's list of candidate public rooms (M4 step 6, ADR 0008). Handles and sort or filter keys only, never a name, goal
-- or any other text. A read model: it's never used to authorize, and Explore confirms each result with its room. A row
-- that stops being listed keeps only its room's ID and `updated_seq`, as a tombstone, so a late retry can't list it again.
CREATE TABLE public_workroom_index (
  workspace_id TEXT PRIMARY KEY,
  public_handle TEXT UNIQUE,
  topic TEXT,
  has_open_opening INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER,
  listed INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL
);
CREATE INDEX public_workroom_index_newest ON public_workroom_index (published_at DESC, workspace_id) WHERE listed = 1;
CREATE INDEX public_workroom_index_topic ON public_workroom_index (topic, published_at DESC, workspace_id) WHERE listed = 1;

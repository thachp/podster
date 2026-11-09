-- Public rooms by handle, and Explore's list of candidates (M4 step 6, ADR 0008). Handles and sort or filter keys only,
-- never a name, goal or any other text. A read model: it never authorizes, and the public read and Explore confirm each
-- result with its room. `resolvable` is whether the handle answers: public, with a handle, and not suspended. An archived
-- public room stays resolvable (decision 152). `listed` is whether Explore shows it: resolvable and not archived. A row that
-- stops being resolvable is a tombstone: it keeps its room's ID, its `updated_seq`, so a late retry can't bring it back, and
-- the last handle the room was published under, taken from the room's audit. `published_at` is in milliseconds.
CREATE TABLE public_workroom_index (
  workspace_id TEXT PRIMARY KEY,
  public_handle TEXT UNIQUE,
  topic TEXT,
  has_open_opening INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER,
  resolvable INTEGER NOT NULL,
  listed INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL
);
CREATE INDEX public_workroom_index_newest ON public_workroom_index (published_at DESC, workspace_id) WHERE listed = 1;
CREATE INDEX public_workroom_index_topic ON public_workroom_index (topic, published_at DESC, workspace_id) WHERE listed = 1;

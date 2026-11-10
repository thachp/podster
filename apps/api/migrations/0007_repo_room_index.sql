-- Which room a provider's repository belongs to, so a webhook delivery can be routed to it (M5 step 5, ADR 0009, which is
-- proposed). IDs only: the provider's name, its repository ID and the room's ID. A read model: it never authorizes. The
-- room checks the repository ID against its own `repo_link` before it keeps anything, so a wrong or stale row here can
-- only send a delivery to a room that drops it. The room writes its row once, from its alarm, after its link exists.
CREATE TABLE repo_room_index (
  provider TEXT NOT NULL,
  provider_repo_id INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  PRIMARY KEY (provider, provider_repo_id)
) WITHOUT ROWID;

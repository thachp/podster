-- Runner pairing's plugin hosts (M7 step 5(c), ruling M1 on #453): written by the gateway when the API has started a
-- session, so the expiry sweep is driven by Podster's own record of who started it, never the plugin's `userId`. A row
-- goes when the session is canceled, settled by the sweep or found ended; an activated session's row stays, marked with
-- the plugin agent it linked, so the claim can refuse the host's other agents.
CREATE TABLE pairing_host (host_id TEXT PRIMARY KEY, person_id TEXT NOT NULL, agent_id TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, next_sweep_at INTEGER NOT NULL DEFAULT 0, linked_agent_id TEXT);
CREATE INDEX pairing_host_due ON pairing_host (expires_at) WHERE linked_agent_id IS NULL;

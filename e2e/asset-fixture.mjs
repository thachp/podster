// INPUT ASSET FIXTURE (screen 9a). Test-only: it exists so axe sees input asset rows in every state, the Task Sheet's attached
// files and the attach picker, in a real browser on the real Workers.
//
// Files are really uploaded and really attached to a task through the gateway. Only the scan verdicts are written by hand:
// locally there's no scanner, and the API takes a verdict only from it, on an internal route with its secret that the local
// stack doesn't expose. So after seeding, run-a11y.mjs stops the Workers, sets those files' state in the room's stored
// SQLite, as apps/api's own tests do, the way the API's own scan paths leave each row, and starts them again. Every state written is checked against the names
// `ObjectState::name` gives in crates/core/src/files.rs, so this can't produce a state the API never does.
//
// Screen 9b adds submission files after this block. Keep the two apart.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ok } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** The states the API itself writes, read from the one place they're named. */
export function apiFileStates() {
  const source = readFileSync(join(here, "../crates/core/src/files.rs"), "utf8");
  const body = source.slice(source.indexOf("pub fn name(self)"), source.indexOf("pub fn from_name"));
  const names = [...body.matchAll(/ObjectState::\w+ => "([a-z_]+)"/g)].map((match) => match[1]);
  ok(names.includes("ready") && names.includes("scanning"), "couldn't read the API's file states from crates/core/src/files.rs");
  return new Set(names);
}

/** What the fixture leaves each file as. `scanning` is what an upload really ends in here, so it needs no change. */
export const ASSET_FILES = [
  { name: "Asset fixture brief.txt", state: "ready", attach: true },
  { name: "Asset fixture notes.txt", state: "scanning", attach: true },
  { name: "Asset fixture blocked.txt", state: "blocked" },
  { name: "Asset fixture failed.txt", state: "failed" },
];

/**
 * Uploads each fixture file as the owner and attaches the marked ones to `task`. Returns the IDs and the states to set, for
 * run-a11y.mjs to write while the Workers are stopped.
 */
export async function seedInputAssets({ gatewayBase, owner, room, task }) {
  const states = apiFileStates();
  const made = [];
  for (const file of ASSET_FILES) {
    ok(states.has(file.state), `the asset fixture wants a state the API never writes: ${file.state}`);
    const bytes = Buffer.from(`${file.name}\nPlain text for the accessibility run.\n`);
    const upload = await owner.must("POST", `/v1/workspaces/${room}/uploads`, { name: file.name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    const sent = await fetch(`${gatewayBase}${upload.upload_path}`, { method: "PUT", headers: { authorization: `Bearer ${upload.token}` }, body: bytes });
    const answer = await sent.json().catch(() => null);
    ok(sent.ok && answer?.state === "scanning", `uploading ${file.name} answered ${sent.status} ${answer?.error?.code ?? answer?.state ?? ""}`);
    if (file.attach) await owner.must("POST", `/v1/workspaces/${room}/files/${upload.id}/links`, { task_id: task });
    made.push({ id: upload.id, name: file.name, state: file.state });
  }
  return { files: made, changes: made.filter((file) => file.state !== "scanning").map(({ id, state }) => ({ id, state })) };
}

/** Marked as the fixture's, so a row written here can't be mistaken for a real scan. */
const FIXTURE_SCAN_DATABASE = JSON.stringify({ engine: "a11y-fixture", version: "0", built_at: new Date().toISOString() });

/**
 * Writes each verdict into the stopped room's SQLite as the API's own paths leave the row (apps/api/src/workspace/objects.rs):
 * a scanner's report (ready, blocked) sets the state with its reason, the SHA-256 it scanned, the signature database and the time;
 * an hour with no report (failed) sets only the state. Nothing reads the scan columns yet, so they don't change what's shown.
 */
export async function writeFileStates(persist, changes) {
  const states = apiFileStates();
  for (const change of changes) ok(states.has(change.state) && change.state !== "uploading", `refusing to write file state ${change.state}`);
  const { DatabaseSync } = await import("node:sqlite");
  const root = join(persist, "v3", "do");
  const files = readdirSync(root, { recursive: true }).filter((path) => String(path).endsWith(".sqlite") && !String(path).endsWith("metadata.sqlite"));
  const left = new Map(changes.map((change) => [change.id, change.state]));
  for (const path of files) {
    if (left.size === 0) break;
    const db = new DatabaseSync(join(root, String(path)));
    try {
      const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stored_object'").get();
      if (!hasTable) continue;
      for (const [id, state] of [...left]) {
        const changed =
          state === "failed"
            ? db.prepare("UPDATE stored_object SET state = ? WHERE id = ? AND state = 'scanning'").run(state, id)
            : db
                .prepare("UPDATE stored_object SET state = ?, scan_reason = ?, scan_sha256 = sha256, scan_database_json = ?, scanned_at = ? WHERE id = ? AND state = 'scanning'")
                .run(state, state === "blocked" ? "Fixture finding" : "", FIXTURE_SCAN_DATABASE, Date.now(), id);
        if (changed.changes === 1) left.delete(id);
      }
    } finally {
      db.close();
    }
  }
  ok(left.size === 0, `couldn't find the room's files to set: ${[...left.keys()].join(", ")}`);
}

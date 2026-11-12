#!/usr/bin/env node
// Spike only. Uploads one test app as spike-m6-c-<label> into the namespace and prints the calls' shapes, IDs only.
// Creates a resource, so run it only after the go. --dry-run reads the app and prints the manifest, calling nothing.
import { join } from "node:path";
import { manifestOf, readApp, record, scriptFor, uploadApp } from "./lib.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (flag("--help") || !value("--label") || !value("--app")) {
  console.log("usage: node upload.mjs --label <a-z0-9, up to 20> --app <probe|plain> [--assets-only] [--headers-in-config] [--dry-run]");
  process.exit(flag("--help") ? 0 : 2);
}
// Only the spike's own apps: a value from the command line never becomes part of a path.
const APPS = { probe: "probe", plain: "plain" };
const app = Object.prototype.hasOwnProperty.call(APPS, value("--app")) ? APPS[value("--app")] : null;
if (!app) {
  console.error(`--app must be one of: ${Object.keys(APPS).join(", ")}`);
  process.exit(2);
}
const script = scriptFor(value("--label"));
const dir = join(import.meta.dirname, "apps", app);
if (flag("--dry-run")) {
  console.log(JSON.stringify({ script, manifest: manifestOf(readApp(dir)) }, null, 2));
  process.exit(0);
}
const report = await uploadApp(script, dir, { assetsOnly: flag("--assets-only"), headersInConfig: flag("--headers-in-config") });
record({ action: report.ok ? "created" : "create-failed", kind: "namespace script", name: script });
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);

// Pure helpers for the builds-actions spike. No I/O here, so spike.test.mjs can cover them.

import { createPrivateKey, createSign } from "node:crypto";

export const ORG = "podsterdev";
export const PREFIX = "builds-spike-";

// Actions the person's workflows use, each pinned by full commit sha (read from
// GitHub's latest releases on 2026-11-21).
export const PINNED = {
  checkout: { repo: "actions/checkout", tag: "v7.0.1", sha: "3d3c42e5aac5ba805825da76410c181273ba90b1" },
  upload: { repo: "actions/upload-artifact", tag: "v7.0.2", sha: "cf430e030ddbb5b0abf93d22962f4752f3646cd9" },
};

export const isFullSha = (s) => typeof s === "string" && /^[0-9a-f]{40}$/.test(s);

// Both variables must name the one organization the owner allowed, exactly.
export function orgAllowed(env) {
  return env?.BUILDS_ORG === ORG && env?.BUILDS_CONFIRM_ORG === ORG;
}

export function appJwt(appId, pem, now = Math.floor(Date.now() / 1000)) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  const sig = createSign("RSA-SHA256").update(body).sign(createPrivateKey(pem)).toString("base64url");
  return `${body}.${sig}`;
}

// Remove anything that looks like a GitHub token or a URL query string before it is recorded.
export function scrub(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/\b(ghs|ghp|gho|ghu|ghr|github_pat)_[A-Za-z0-9_]+/g, "[token]")
    .replace(/(https?:\/\/[^\s?"']+)\?[^\s"']*/g, "$1?[query]")
    .replace(/(Authorization:\s*)(\S+\s+)?\S+/gi, "$1[redacted]");
}

// What may be recorded about a signed download URL: its host, whether it carries an
// expiry, and which expiry parameter names it uses. Never the URL itself.
export function locationSummary(location) {
  if (!location) return { host: null, has_expiry: false, expiry_params: [] };
  let u;
  try {
    u = new URL(location);
  } catch {
    return { host: "unparseable", has_expiry: false, expiry_params: [] };
  }
  const expiryNames = ["se", "expires", "x-amz-expires", "x-goog-expires", "exp", "expiry"];
  const found = [...u.searchParams.keys()].filter((k) => expiryNames.includes(k.toLowerCase()));
  return { host: u.host, has_expiry: found.length > 0, expiry_params: found };
}

// The GITHUB_TOKEN permissions GitHub prints in a job's "Set up job" log section,
// as { contents: "read", ... }. Returns null if the section isn't there.
export function parseTokenPermissions(log) {
  if (typeof log !== "string") return null;
  const lines = log.split(/\r?\n/).map((l) => l.replace(/^\S+Z\s/, "").replace(/^##\[group\]|^##\[endgroup\]/, ""));
  const start = lines.findIndex((l) => /GITHUB_TOKEN Permissions/.test(l));
  if (start < 0) return null;
  const out = {};
  for (const l of lines.slice(start + 1)) {
    const m = l.match(/^\s*([A-Za-z]+):\s*(read|write|none)\s*$/);
    if (!m) break;
    out[m[1]] = m[2];
  }
  return out;
}

// Lines the workflows print as "SPIKE key=value", gathered as an object.
export function parseSpikeLines(log) {
  const out = {};
  for (const l of String(log ?? "").split(/\r?\n/)) {
    const m = l.match(/SPIKE ([a-z_]+)=(\S+)\s*$/);
    if (m && !l.includes("printf")) out[m[1]] = m[2];
  }
  return out;
}

// The workflow a person adds on the default branch. With `permissions` null the file
// has no `permissions:` key, so the run gets the repository's default.
export function probeWorkflow({ name, permissions }) {
  const perms = permissions ? `permissions:\n${Object.entries(permissions).map(([k, v]) => `  ${k}: ${v}`).join("\n")}\n` : "";
  return `name: ${name}
on:
  push:
    branches: ["podster/**"]
${perms}jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - uses: ${PINNED.checkout.repo}@${PINNED.checkout.sha} # ${PINNED.checkout.tag}
        with:
          persist-credentials: false
      - name: try writes with GITHUB_TOKEN
        env:
          GH_TOKEN: \${{ github.token }}
          REPO: \${{ github.repository }}
          SHA: \${{ github.sha }}
          RUN: \${{ github.run_id }}
        run: |
          set +x
          api() { curl -s -o /dev/null -w '%{http_code}' -X "$1" -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO/$2" -d "$3"; }
          s=$(api POST "statuses/$SHA" '{"state":"success","context":"spike/write-test"}')
          r=$(api POST "git/refs" "{\\"ref\\":\\"refs/heads/spike-write-$RUN\\",\\"sha\\":\\"$SHA\\"}")
          printf 'SPIKE status_write=%s\\n' "$s"
          printf 'SPIKE ref_write=%s\\n' "$r"
          mkdir -p out && printf '{"status_write":%s,"ref_write":%s}\\n' "$s" "$r" > out/result.json
      - uses: ${PINNED.upload.repo}@${PINNED.upload.sha} # ${PINNED.upload.tag}
        with:
          name: probe-result
          path: out/result.json
          retention-days: 1
`;
}

// A workflow that only says it ran, for the event triggers in checks (e) and (f).
export function eventWorkflow({ name, on }) {
  return `name: ${name}
on:
${on}
permissions:
  contents: read
jobs:
  ran:
    runs-on: ubuntu-latest
    steps:
      - run: printf 'SPIKE event=%s\\n' "\${{ github.event_name }}"
`;
}

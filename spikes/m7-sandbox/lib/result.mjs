// Runner's bound on a run's final structured result, pure. The SDK validates against the schema too;
// Runner checks again and never trusts the SDK or the model to have kept the bounds.

export function boundResult(value) {
  const problems = [];
  let size = 0;
  try {
    size = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    problems.push("not-serialisable");
  }
  if (size > 4096) problems.push("too-large");
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, problems: [...problems, "not-object"], size };
  const extra = Object.keys(value).filter((k) => !["status", "summary", "files"].includes(k));
  if (extra.length) problems.push("extra-fields");
  if (!["done", "failed"].includes(value.status)) problems.push("bad-status");
  if (typeof value.summary !== "string" || value.summary.length > 200) problems.push("bad-summary");
  if (!Array.isArray(value.files) || value.files.length > 10 || value.files.some((f) => typeof f !== "string" || f.length > 200 || f.includes(".."))) problems.push("bad-files");
  return { ok: problems.length === 0, problems, size };
}


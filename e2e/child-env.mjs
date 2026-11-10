// The environment a third-party program gets from these scripts: the kit, fasta2a, LangGraph. Only what a program needs to
// start, plus its own named settings, and never anything of ours that's secret, whatever the caller passes.

/** Names a child process may inherit from ours. */
const INHERITED = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM"];

/** Never passed on, even if named: our secrets and anything shaped like one. */
const FORBIDDEN = [/^PODSTER_E2E_/, /^CLOUDFLARE_/, /SECRET/i, /TOKEN/i, /KEY/i, /PASSWORD/i, /COOKIE/i, /CREDENTIAL/i];

export const forbidden = (name) => FORBIDDEN.some((pattern) => pattern.test(name));

/** The allow-listed environment: the inherited basics from `from`, plus `own`, the tool's own settings. */
export function childEnv(own = {}, from = process.env) {
  const env = {};
  for (const name of INHERITED) if (from[name] !== undefined) env[name] = from[name];
  for (const [name, value] of Object.entries(own)) {
    if (forbidden(name)) throw new Error(`refusing to pass ${name} to a third-party program`);
    env[name] = String(value);
  }
  return env;
}

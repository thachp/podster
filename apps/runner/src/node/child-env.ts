/**
 * The environment a program Runner starts gets: the OS keychain tool, today. The same rule as `e2e/child-env.mjs`, which
 * the repository's scripts give every third-party program: only what a program needs to start, plus its own named
 * settings, and never anything shaped like a secret, whatever the caller passes. A test holds the two to the same rule.
 */

/** Names a child process may inherit from Runner's. */
export const INHERITED = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM"] as const;

/** Never passed on, even if named. */
const FORBIDDEN = [/^PODSTER_/, /^CLOUDFLARE_/, /^ANTHROPIC_/, /SECRET/i, /TOKEN/i, /KEY/i, /PASSWORD/i, /COOKIE/i, /CREDENTIAL/i];

export const forbidden = (name: string) => FORBIDDEN.some((pattern) => pattern.test(name));

/** The allow-listed environment: the inherited basics from `from`, plus `own`, the program's own settings. */
export function childEnv(own: Record<string, string | undefined> = {}, from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = from[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(own)) {
    if (forbidden(name)) throw new Error(`refusing to pass ${name} to another program`);
    if (value !== undefined) env[name] = value;
  }
  return env;
}

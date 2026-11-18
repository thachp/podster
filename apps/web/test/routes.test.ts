import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const app = join(root, "app");

/** Every route in docs/spec/DESIGN.md section 2. */
const SHELL = ["attention", "workrooms", "workrooms/explore", "workrooms/new", "w/[id]/overview", "w/[id]/tasks", "w/[id]/team", "w/[id]/collaboration", "w/[id]/activity", "w/[id]/artifacts", "w/[id]/settings", "agents", "agents/connect", "settings/profile", "settings/organization", "settings/notifications"];
const FOCUSED = ["invitations/[token]", "claim", "oauth/consent", "pairing/new", "pairing/[agent]"];

const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]));

describe("routes", () => {
  it.each(SHELL)("%s is inside the shell", (route) => expect(existsSync(join(app, "(shell)", route, "page.tsx"))).toBe(true));
  it.each(FOCUSED)("%s has no Sidebar", (route) => {
    expect(existsSync(join(app, "(focused)", route, "page.tsx"))).toBe(true);
    expect(readFileSync(join(app, "(focused)/layout.tsx"), "utf8")).not.toContain("AppShell");
  });

  it("no code in the app reaches for anything but the gateway", () => {
    const wrangler = readFileSync(join(root, "wrangler.jsonc"), "utf8");
    expect(wrangler).not.toMatch(/d1_databases|durable_objects|kv_namespaces|"service":\s*"podster-api/);
    for (const file of files(app).concat(files(join(root, "lib")))) {
      if (!/\.tsx?$/.test(file) || file.endsWith(".test.ts")) continue;
      expect(readFileSync(file, "utf8"), file).not.toMatch(/dangerouslySetInnerHTML|podster-api|env\.API\b/);
    }
  });
});

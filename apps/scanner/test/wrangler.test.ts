import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Plain JSON once comments are gone. No value here has `//` in it. */
const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""));
const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const dockerfile = readFileSync(new URL("../container/Dockerfile", import.meta.url), "utf8");

describe("what the scanner can reach", () => {
  it("has no route or address", () => {
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.routes).toBeUndefined();
    expect(config.env.staging.routes).toBeUndefined();
  });

  it("has no outbound traffic from the Container, and no allowlist to widen", () => {
    expect(source).toContain("enableInternet = false");
    expect(source).not.toMatch(/allowedHosts|interceptHttps/);
  });

  it("gives the Container no secret and no binding", () => {
    expect(source).not.toMatch(/envVars|entrypoint/);
    // Named only as what the Worker reads for itself.
    expect(source.match(/SCANNER_SECRET/g)).toHaveLength(2);
    expect(JSON.stringify(config)).not.toContain("SECRET");
    expect(dockerfile).not.toMatch(/^\s*(ENV|ARG)\s.*(KEY|SECRET|TOKEN)/im);
  });

  it("removes the updater from the image, and fails the build without current signatures", () => {
    expect(dockerfile).toMatch(/RUN freshclam /);
    expect(dockerfile).toMatch(/RUN python3 -m scanner\.check_image/);
    expect(dockerfile.indexOf("check_image")).toBeLessThan(dockerfile.indexOf('rm -f "$(command -v freshclam)"'));
    expect(dockerfile).toMatch(/^USER clamav$/m);
    expect(dockerfile.trim().split("\n").filter((line) => line.startsWith("USER ")).at(-1)).toBe("USER clamav");
  });

  it("runs on standard-1, one file at a time, with a dead-letter queue", () => {
    for (const scope of [config, config.env.staging]) {
      expect(scope.containers[0].instance_type).toBe("standard-1");
      const [main, dead] = scope.queues.consumers;
      expect(main).toMatchObject({ max_batch_size: 1, max_concurrency: 1 });
      expect(main.dead_letter_queue).toBe(dead.queue);
      // Retries end inside the hour the room allows.
      expect((main.max_retries * main.retry_delay) / 60).toBeLessThan(60);
    }
  });
});

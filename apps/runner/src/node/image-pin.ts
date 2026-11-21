/**
 * How Runner reads Docker's answer to `docker image inspect` of a pinned image: an image it says it doesn't have is
 * rebuilt and re-pinned; any other failure stops (security review L4 on #470). Shared by the base images
 * (`claude-engine.ts`) and the toolchain images (`toolchain-images.ts`).
 */
import type { DockerResult } from "./docker-sandbox.js";

/** Docker's own answer for an image it doesn't have, from `docker image inspect`. */
export const NO_SUCH_IMAGE = /^(Error: |Error response from daemon: )?No such image: /m;

const JSON_NO_SUCH_IMAGE_PREFIX = "Error response from daemon: ";

/**
 * Docker 28.5.1 answers a missing image as `Error response from daemon: {"message":"No such image: <id>"}`. Accepted
 * only as one JSON object whose single key is `message` and whose value is "No such image: " plus the pinned ID or its
 * short form; anything else is not Docker's answer for this image.
 */
function isJsonNoSuchImage(stderr: string, pinnedId: string): boolean {
  const text = stderr.trim();
  if (!text.startsWith(JSON_NO_SUCH_IMAGE_PREFIX)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(JSON_NO_SUCH_IMAGE_PREFIX.length));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "message") return false;
  const message = (parsed as { message: unknown }).message;
  const hex = pinnedId.replace(/^sha256:/, "");
  return typeof message === "string" && [pinnedId, hex, hex.slice(0, 12)].some((id) => message === `No such image: ${id}`);
}

/**
 * True only for Docker's own "No such image" for this pin: exit 1, output not cut, and the plain or JSON-wrapped form.
 * Anything else is not Docker saying it hasn't the image.
 */
export function noSuchImage(result: DockerResult, pinnedId: string): boolean {
  return result.code === 1 && !result.cut && (NO_SUCH_IMAGE.test(result.stderr) || isJsonNoSuchImage(result.stderr, pinnedId));
}

/**
 * Runner's toolchain images (the owner's ruling of 2026-11-20: no single large task image). A room that names
 * toolchains runs in the base task image with those toolchains layered on, one Dockerfile each, in sorted order: for
 * `["python", "rust"]`, Python's image is built FROM the base task image and Rust's FROM that. Each step is pinned by its
 * image ID in Runner's home, like `task-image`: `toolchain-image-python`, then `toolchain-image-python-rust`.
 *
 * - **Built on first need**, like `ensureImage`: a missing pin, or one naming an image Docker says it hasn't, is built
 *   from the Dockerfile in Runner's own package and pinned. A pin that isn't an image ID, or is a link, is refused, not
 *   replaced; a failure to check an image stops, with nothing built.
 * - **Bound to what it was built from.** Each image carries a recipe label: a SHA-256 over its parent's image ID, the
 *   toolchain's name and its Dockerfile's SHA-256. A pinned image whose label isn't the recipe now (the base was rebuilt,
 *   or a new Runner moved a pin), or whose layers don't start with its parent's, is stale and rebuilt. The layers are
 *   checked after every build too, so the image is exactly the parent plus the toolchain's own layers.
 * - **The parent by tag.** BuildKit can't build `FROM` an image ID, so the parent is tagged
 *   `podster-runner-base:<its full ID's hex>` and the Dockerfile's `FROM ${BASE}` names that tag; the layer check above
 *   is what binds the result to the parent's ID, whatever the tag names. The tag is left in place: removing an image's
 *   only tag would delete an image built with none, such as the pinned base, and it keeps the parent from being pruned
 *   as dangling.
 *
 * - **One architecture.** The build gets ARCH, the Engine's architecture (`aarch64` or `x86_64`), and fetches only that
 *   architecture's tarballs; any other architecture refuses the build.
 *
 * The `docker` program goes through Runner's own `DockerCli`. Nothing from the task or Podster reaches a build: the names
 * are the policy's known toolchains, and every argument is fixed or an image ID.
 */
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isToolchainList, TOOLCHAIN_INFO, type Toolchain } from "../core/toolchains.js";
import { IMAGE_ID, type DockerCli } from "./docker-sandbox.js";
import { noSuchImage } from "./image-pin.js";
import { readNoFollow, writeNew } from "./safe-fs.js";

/** Each toolchain's build folder, in Runner's own package: its Dockerfile, which copies nothing from the folder. */
export const TOOLCHAIN_SOURCES: Readonly<Record<Toolchain, string>> = Object.freeze({
  python: fileURLToPath(new URL("../../toolchains/python", import.meta.url)),
  rust: fileURLToPath(new URL("../../toolchains/rust", import.meta.url)),
});

/** The label naming what an image was built from. */
export const LABEL_RECIPE = "dev.podster.runner.recipe";
/** The tag a parent image gets so a Dockerfile can build FROM it. */
export const BASE_TAG = "podster-runner-base";
/** Bumped when the recipe's form changes, so every image is rebuilt. */
const RECIPE_VERSION = "podster-runner-toolchain-v1";
/** A build's bound: Rust's tarballs and Debian's packages take minutes on a slow link. */
const BUILD_TIMEOUT_MS = 30 * 60_000;

/** The pin file for a sorted set of toolchains, such as `toolchain-image-python-rust`. */
export const pinName = (set: readonly Toolchain[]) => `toolchain-image-${set.join("-")}`;

const words = (set: readonly Toolchain[]) => {
  const labels = set.map((t) => TOOLCHAIN_INFO[t].label);
  return labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
};
/** The fixed line said before a build. */
export const buildingLine = (set: readonly Toolchain[]) => `Building Runner's task image with the ${words(set)} toolchain${set.length === 1 ? "" : "s"}, from its packaged Dockerfile${set.length === 1 ? "" : "s"}, for a room that names ${set.length === 1 ? "it" : "them"}. This happens once and takes a few minutes.`;
/** The fixed messages a failure stops with. Docker's own output never reaches them. */
export const TOOLCHAIN_BUILD_FAILED = "Runner couldn't build a toolchain image, so the run didn't start. Check that Docker Desktop is running and this machine can reach the toolchain's download sites, then try again.";
export const TOOLCHAIN_INSPECT_FAILED = "Runner couldn't check a toolchain image with Docker, so the run didn't start. Check that Docker Desktop is running, then try again.";
export const TOOLCHAIN_PIN_INVALID = "A toolchain image pin in Runner's home isn't an image ID (sha256:…), so the run didn't start. Remove the toolchain-image-… file named for the room's toolchains, and Runner builds it again.";

/** The recipe an image built for `name` on `parent` carries, from the Dockerfile's exact bytes. */
export async function recipeOf(parent: string, name: Toolchain, readSource: (name: Toolchain) => Promise<Buffer> = (n) => readFile(join(TOOLCHAIN_SOURCES[n], "Dockerfile"))): Promise<string> {
  const source = createHash("sha256").update(await readSource(name)).digest("hex");
  return createHash("sha256").update(`${RECIPE_VERSION}\n${parent}\n${name}\n${source}\n`).digest("hex");
}

type Inspected = { recipe: string | null; layers: string[] };
/**
 * One JSON object: Docker's own `json` of each field, so no label can break the form. The image's `.Id` isn't read:
 * with Docker 29's containerd image store it can differ from the ID `docker build --quiet` printed, which is what a pin
 * holds, so an image is matched by the ID it was asked for, its recipe and its layers.
 */
const INSPECT_FORMAT = '{"labels":{{json .Config.Labels}},"layers":{{json .RootFS.Layers}}}';

/** An image's recipe label and layers; "missing" only on Docker's own "No such image". Anything else throws. */
async function inspect(docker: DockerCli, id: string, signal?: AbortSignal): Promise<Inspected | "missing"> {
  const r = await docker(["image", "inspect", "--format", INSPECT_FORMAT, id], { signal, timeoutMs: 60_000, maxOutputBytes: 64 * 1024 });
  if (r.code !== 0) {
    if (noSuchImage(r, id)) return "missing";
    throw new Error(TOOLCHAIN_INSPECT_FAILED);
  }
  if (r.cut) throw new Error(TOOLCHAIN_INSPECT_FAILED);
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new Error(TOOLCHAIN_INSPECT_FAILED);
  }
  const { labels, layers } = (typeof parsed === "object" && parsed !== null ? parsed : {}) as { labels?: unknown; layers?: unknown };
  if (!Array.isArray(layers) || layers.length === 0 || !layers.every((l) => typeof l === "string" && IMAGE_ID.test(l))) throw new Error(TOOLCHAIN_INSPECT_FAILED);
  if (labels !== null && (typeof labels !== "object" || Array.isArray(labels))) throw new Error(TOOLCHAIN_INSPECT_FAILED);
  const recipe = labels !== null && Object.hasOwn(labels, LABEL_RECIPE) ? (labels as Record<string, unknown>)[LABEL_RECIPE] : null;
  return { recipe: typeof recipe === "string" ? recipe : null, layers };
}

/** The child's layers start with every one of the parent's and add at least one: it was built FROM the parent. */
export function builtOn(parent: readonly string[], child: readonly string[]): boolean {
  return child.length > parent.length && parent.every((layer, i) => child[i] === layer);
}

/** Docker's names for the architectures the toolchains ship for, and the names their tarballs use. */
export const ARCHES: Readonly<Record<string, string>> = Object.freeze({ arm64: "aarch64", amd64: "x86_64" });

/**
 * The Docker Engine's architecture, as the toolchains' tarballs name it, from `docker version`. Passed to the build as
 * ARCH so it fetches only that architecture's tarballs, whichever of Docker's builders runs it (Runner's own
 * `DOCKER_CONFIG` has no buildx plugin, so on a Mac it's the classic builder, which has no TARGETARCH).
 */
async function engineArch(docker: DockerCli, signal?: AbortSignal): Promise<string> {
  const r = await docker(["version", "--format", "{{.Server.Arch}}"], { signal, timeoutMs: 60_000, maxOutputBytes: 4096 });
  const arch = r.stdout.trim();
  if (r.code !== 0 || r.cut || !Object.hasOwn(ARCHES, arch)) throw new Error(TOOLCHAIN_BUILD_FAILED);
  return ARCHES[arch];
}

type Opts = { home: string; docker: DockerCli; notify: (line: string) => void; base: string; signal?: AbortSignal; readSource?: (name: Toolchain) => Promise<Buffer> };
/** How a step runs: `run` with the signal its build should end on. The default runs it at once, on the caller's signal. */
export type StepGate = (pin: string, run: (signal: AbortSignal | undefined) => Promise<string>) => Promise<string>;

/** One step: the image for `set`, built FROM `parent` with `set`'s last toolchain added. */
async function ensureStep(set: Toolchain[], parent: string, opts: Opts): Promise<string> {
  const path = join(opts.home, pinName(set));
  const name = set[set.length - 1];
  const recipe = await recipeOf(parent, name, opts.readSource);
  const parentInfo = await inspect(opts.docker, parent, opts.signal);
  if (parentInfo === "missing") throw new Error(TOOLCHAIN_INSPECT_FAILED);
  const fits = (info: Inspected | "missing") => info !== "missing" && info.recipe === recipe && builtOn(parentInfo.layers, info.layers);
  const pinned = (await readNoFollow(path, 256))?.trim();
  if (pinned) {
    if (!IMAGE_ID.test(pinned)) throw new Error(TOOLCHAIN_PIN_INVALID);
    // A missing image, or a stale one (another parent or Dockerfile), is built again; a failed check stops.
    if (fits(await inspect(opts.docker, pinned, opts.signal))) return pinned;
  }
  opts.notify(buildingLine(set));
  const arch = await engineArch(opts.docker, opts.signal);
  const tag = `${BASE_TAG}:${parent.slice("sha256:".length)}`;
  const tagged = await opts.docker(["tag", parent, tag], { signal: opts.signal, timeoutMs: 60_000, maxOutputBytes: 4096 });
  if (tagged.code !== 0) throw new Error(TOOLCHAIN_BUILD_FAILED);
  const built = await opts.docker(["build", "--quiet", "--pull=false", "--build-arg", `BASE=${tag}`, "--build-arg", `ARCH=${arch}`, "--label", `${LABEL_RECIPE}=${recipe}`, TOOLCHAIN_SOURCES[name]], { signal: opts.signal, timeoutMs: BUILD_TIMEOUT_MS, maxOutputBytes: 64 * 1024 });
  const id = built.stdout.trim();
  if (built.code !== 0 || built.cut || !IMAGE_ID.test(id)) throw new Error(TOOLCHAIN_BUILD_FAILED);
  // Exactly the parent plus this toolchain's layers, with this recipe, whatever the tag named during the build.
  if (!fits(await inspect(opts.docker, id, opts.signal))) throw new Error(TOOLCHAIN_BUILD_FAILED);
  await rm(path, { force: true });
  await writeNew(path, `${id}\n`);
  return id;
}

/**
 * The image for a room's toolchains (sorted, each once, at least one), on the pinned base task image `base`: each
 * prefix of the set built and pinned in turn, so `["python", "rust"]` reuses `["python"]`'s image.
 */
export async function ensureToolchainImage(set: readonly Toolchain[], opts: Opts & { gate?: StepGate }): Promise<string> {
  if (!isToolchainList(set) || set.length === 0 || !IMAGE_ID.test(opts.base)) throw new Error(TOOLCHAIN_BUILD_FAILED);
  const gate: StepGate = opts.gate ?? ((_pin, run) => run(opts.signal));
  let parent = opts.base;
  for (let i = 1; i <= set.length; i++) {
    const step = set.slice(0, i);
    const from = parent;
    parent = await gate(pinName(step), (signal) => ensureStep(step, from, { ...opts, signal }));
  }
  return parent;
}

/**
 * Builds shared by everyone waiting on them, one per key (a pin name), so two sets sharing a step, such as `["python"]`
 * and `["python", "rust"]`, never build or pin `toolchain-image-python` at once (review item 3 on #497). Each waiter's own
 * signal ends only its own wait; the build goes on while anyone still waits, bounded by its own time limit, and is
 * aborted only when the last waiter leaves (review item 2 on #497), so a halted run never fails another.
 */
export class SharedBuilds {
  private readonly running = new Map<string, { promise: Promise<string>; controller: AbortController; waiters: number }>();

  join(key: string, start: (signal: AbortSignal) => Promise<string>, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(new Error("halted"));
    let entry = this.running.get(key);
    if (!entry) {
      const controller = new AbortController();
      const made: { promise: Promise<string>; controller: AbortController; waiters: number } = { promise: Promise.resolve(""), controller, waiters: 0 };
      made.promise = start(controller.signal).finally(() => {
        if (this.running.get(key) === made) this.running.delete(key);
      });
      made.promise.catch(() => undefined);
      this.running.set(key, made);
      entry = made;
    }
    const joined = entry;
    joined.waiters += 1;
    return new Promise<string>((resolve, reject) => {
      let left = false;
      const leave = () => {
        if (left) return false;
        left = true;
        signal?.removeEventListener("abort", onAbort);
        joined.waiters -= 1;
        return true;
      };
      const onAbort = () => {
        if (!leave()) return;
        // The last waiter gone: the build ends, and a later ask starts afresh rather than joining one being stopped.
        if (joined.waiters === 0) {
          if (this.running.get(key) === joined) this.running.delete(key);
          joined.controller.abort();
        }
        reject(new Error("halted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      joined.promise.then(
        (value) => leave() && resolve(value),
        (error: unknown) => leave() && reject(error),
      );
    });
  }

  /** How many builds are running, for tests. */
  get size(): number {
    return this.running.size;
  }
}

/**
 * Runner's source of toolchain images for its sandbox: each step built once at a time through `SharedBuilds`, on the
 * pinned base task image.
 */
export function toolchainImages(opts: Omit<Opts, "signal">): (set: readonly Toolchain[], signal: AbortSignal) => Promise<string> {
  const builds = new SharedBuilds();
  return (set, signal) => ensureToolchainImage(set, { ...opts, signal, gate: (pin, run) => builds.join(pin, run, signal) });
}

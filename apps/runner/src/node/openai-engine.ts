/**
 * The run engine for the experimental OpenAI adapter (RUNNER-OPENAI.md; built 2026-11-22, off by default, not verified
 * for support). `cli.ts` builds it instead of the Claude engine only when policy.json names `adapter: "openai_agents"`
 * with `experimental_openai: true`; it then prints `OPENAI_WARNING`.
 *
 * Before anything runs, it refuses unless:
 * - Runner's environment holds no `OPENAI_` name but the three that only switch things off, and no Anthropic key or base
 *   URL (S-54): the SDK and its client read those as defaults, and no provider key belongs anywhere but the key file;
 * - the installed `@openai/agents-core`, `@openai/agents-openai` and `openai` are exactly the pinned versions (S-58);
 * - the key file passes the same checks as the Claude engine's (`readKeyFile`), and holds an OpenAI project key, not
 *   another provider's (S-54);
 * - no proxy or TLS trust would be taken from the environment (the transport's own checks);
 * - Docker answers, and the task and egress proxy images are pinned or built, as for Claude. There is no Claude Code
 *   image, relay or listener: the SDK's loop runs in Runner's process.
 *
 * The key is read once into the transport and never logged, written, put in an error or passed to another program.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { OPENAI_PROFILE, openaiEnvRefusals, PINNED_OPENAI_PACKAGES } from "../core/openai-profile.js";
import type { Logger } from "../core/runtime.js";
import { ensureImage, readKeyFile } from "./claude-engine.js";
import { DockerSandbox, dockerCli, dockerHost, findDocker, type DockerCli, type ToolchainImages } from "./docker-sandbox.js";
import { loadProxyProgram } from "./egress-network.js";
import { OpenAIDriver } from "./openai-driver.js";
import { dockerReachable, homeRefusal, isWsl, linuxCheckFailure, readMounts, readProcVersion, relayModeFor, resolvedPath } from "./platform.js";
import { ProviderKeyTransport } from "./provider-transport.js";
import type { RunEngine } from "./run-command.js";
import { ensureFolder } from "./safe-fs.js";
import { toolchainImages } from "./toolchain-images.js";

/** A package's own manifest, found by walking up from its resolved entry to the folder whose package.json names it. */
async function manifestVersion(name: string, resolve: (id: string) => string): Promise<unknown> {
  let dir = dirname(resolve(name));
  for (let i = 0; i < 8; i++) {
    try {
      const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
      if (manifest.name === name) return manifest.version;
    } catch {
      // No manifest here: look one folder up.
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** The installed OpenAI packages' versions, each from its own manifest. */
export async function installedOpenAIVersions(): Promise<Record<string, unknown>> {
  const require = createRequire(import.meta.url);
  const found: Record<string, unknown> = {};
  for (const name of Object.keys(PINNED_OPENAI_PACKAGES)) {
    try {
      found[name] = await manifestVersion(name, (id) => require.resolve(id));
    } catch {
      found[name] = null;
    }
  }
  return found;
}

/** Why Runner's environment can't start the OpenAI adapter, in fixed words naming the variables, never their values. */
export function openaiEnvRefusal(env: NodeJS.ProcessEnv): string | null {
  const names = openaiEnvRefusals(env);
  if (names.length === 0) return null;
  return `Runner won't start the OpenAI adapter with ${names.join(", ")} in its environment: the SDK would read ${names.length === 1 ? "it" : "them"} as a default, and the provider key is read only from the key file. Unset ${names.length === 1 ? "it" : "them"} and start again.`;
}

export type OpenAIEngine = RunEngine & { reap(): Promise<void> };

export async function openaiEngine(opts: {
  home: string;
  key_file: string;
  log: Logger;
  notify?: (line: string) => void;
  docker?: DockerCli;
  dockerProgram?: string;
  env?: NodeJS.ProcessEnv;
  execArgv?: readonly string[];
  platform?: NodeJS.Platform;
  wait?: (ms: number) => Promise<void>;
  mounts?: string | null;
  procVersion?: string | null;
  /** For tests: the installed versions, read from the packages when left out. */
  installed?: Record<string, unknown>;
}): Promise<OpenAIEngine> {
  const platform = opts.platform ?? process.platform;
  // The same systems as the Claude engine: macOS, and Linux (with WSL2); Windows itself points to WSL2.
  const mode = relayModeFor(platform);
  const env = opts.env ?? process.env;
  const refusedEnv = openaiEnvRefusal(env);
  if (refusedEnv) throw new Error(refusedEnv);
  const driver = new OpenAIDriver({ installed: opts.installed ?? (await installedOpenAIVersions()), log: opts.log });
  const mounts = mode === "unix" ? (opts.mounts !== undefined ? opts.mounts : readMounts()) : null;
  if (mode === "unix") {
    const refused = homeRefusal(opts.home, mounts, await resolvedPath(opts.home));
    if (refused) throw new Error(refused);
  }
  const key = await readKeyFile(opts.key_file);
  const transport = new ProviderKeyTransport(OPENAI_PROFILE, key, { env: opts.env, execArgv: opts.execArgv });
  const program = opts.dockerProgram ?? findDocker();
  if (!program) throw new Error("Runner needs Docker for the task's container, and found none.");
  const config = join(opts.home, "docker-config");
  const host = dockerHost(env, platform);
  const docker = opts.docker ?? dockerCli(program, { config_dir: await ensureFolder(opts.home, config), host });
  if (mode === "unix") {
    const wsl = isWsl(env, opts.procVersion !== undefined ? opts.procVersion : readProcVersion());
    if (!(await dockerReachable(docker))) throw linuxCheckFailure("docker", wsl);
  }
  const notify = opts.notify ?? (() => undefined);
  const image = await ensureImage("task-image", { home: opts.home, docker, notify });
  const pxImage = await ensureImage("proxy-image", { home: opts.home, docker, notify });
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  const toolchainImage: ToolchainImages = toolchainImages({ home: opts.home, docker, notify, base: image });
  const sandbox = new DockerSandbox({ docker, image, uid, gid, home: opts.home, wait: opts.wait, log: opts.log, proxy: { image: pxImage, program: () => loadProxyProgram() }, toolchainImage, ...(mode === "unix" ? { mounts: () => (opts.mounts !== undefined ? opts.mounts : readMounts()) } : {}) });
  return {
    drivers: { openai_agents: driver },
    sandbox,
    transports: { [OPENAI_PROFILE.provider]: transport },
    async reap() {
      const containers = await sandbox.reapAll();
      opts.log("adapter.reap", "done", { count: containers });
    },
  };
}

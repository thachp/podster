// The stand-ins bounded-selftest.mjs starts. Fixed text: what each one does comes from its arguments, never from source
// built by the test.
//
//   node bounded-selftest-child.mjs script       never exits, ignores SIGTERM, and starts a "browser" in a group of its own
//   node bounded-selftest-child.mjs browser      never exits, ignores SIGTERM, and prints its pid
//   node bounded-selftest-child.mjs exit <n>     prints the names in its environment and exits with <n>
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const [role, value] = process.argv.slice(2);
const stay = () => {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
};

if (role === "script") {
  // Detached, as Playwright starts a browser, so it isn't in this script's group.
  spawn(process.execPath, [fileURLToPath(import.meta.url), "browser"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
  stay();
} else if (role === "browser") {
  console.log(process.pid);
  stay();
} else if (role === "exit") {
  process.stdout.write(JSON.stringify(Object.keys(process.env).sort()));
  process.exitCode = Number(value);
} else {
  console.error("Started by bounded-selftest.mjs, as script, browser or exit <n>.");
  process.exitCode = 2;
}

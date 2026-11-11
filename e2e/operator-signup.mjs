// Signs up the person a local rehearsal's stack will name as its operator, and writes their ID and session to the file
// given, for run-local.mjs alone. The stack is then restarted with that ID in OPERATORS.
//
//   node operator-signup.mjs --base-url http://localhost:8787 --out <file>
import { writeFileSync } from "node:fs";
import { Person, Target } from "./lib.mjs";

const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const [base, out] = [arg("--base-url"), arg("--out")];
if (!base || !/^http:\/\/localhost:\d+$/.test(base) || !out) {
  console.error("Give --base-url http://localhost:<port> and --out <file>. This is for a local stack only.");
  process.exit(2);
}
const operator = await Person.signUp(new Target(base, { pollMs: 500 }), "Operator");
writeFileSync(out, JSON.stringify({ id: operator.id, cookie: operator.cookie }), { mode: 0o600 });

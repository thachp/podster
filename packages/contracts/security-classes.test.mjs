// The own-assertion classes' check, on inputs of its own: an operation in a class lists exactly its scheme and nothing
// else, and no operation outside the class lists it, so "no problems" in check.mjs means something.
import { exclusiveSchemeProblems } from "./security-classes.mjs";

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

const ops = (entries) => new Map(Object.entries(entries).map(([id, security]) => [id, { op: security === undefined ? {} : { security } }]));
const classes = [
  { name: "pairing_only", ids: ["redeem"], scheme: "pairingRedeem" },
  { name: "provider_only", ids: ["deliver"], scheme: "providerDelivery" },
  { name: "service_only", ids: ["sweep"], scheme: "pairingSweep" },
];
const run = (entries) => exclusiveSchemeProblems(ops(entries), classes);
const good = { redeem: [{ pairingRedeem: [] }], deliver: [{ providerDelivery: [] }], sweep: [{ pairingSweep: [] }], other: undefined };

check(run(good).length === 0, "each class's operation listing only its scheme passes");
check(run({ ...good, redeem: undefined }).some((p) => p.startsWith("redeem:")), "an operation in a class that inherits the identity assertion is a problem");
check(run({ ...good, redeem: [{ pairingRedeem: [] }, { assertion: [] }] }).some((p) => p.startsWith("redeem:")), "an alternative scheme beside the class's is a problem");
check(run({ ...good, redeem: [{ pairingRedeem: [], assertion: [] }] }).some((p) => p.startsWith("redeem:")), "a second scheme in the same requirement is a problem");
check(run({ ...good, redeem: [] }).some((p) => p.startsWith("redeem:")), "an empty security list, which means none, is a problem");
check(run({ ...good, deliver: [{ providerDelivery: [] }, { pairingRedeem: [] }] }).some((p) => p.startsWith("deliver:")), "a provider operation that also takes the pairing assertion is a problem");
check(run({ ...good, other: [{ pairingRedeem: [] }] }).some((p) => p.startsWith("other:")), "an operation outside the class that takes its scheme is a problem");
check(run({ ...good, other: [{ assertion: [] }, { providerDelivery: [] }] }).some((p) => p.startsWith("other:")), "taking a class's scheme as one alternative outside the class is a problem");
check(run({ ...good, sweep: [{ pairingSweep: [] }, { assertion: [] }] }).some((p) => p.startsWith("sweep:")), "a service operation that a person's assertion could also reach is a problem");
check(run({ ...good, other: [{ pairingSweep: [] }] }).some((p) => p.startsWith("other:")), "an operation outside the service class that takes its scheme is a problem");
check(run({ deliver: good.deliver }).some((p) => p.startsWith("redeem:")), "a class naming an operation that doesn't exist is a problem");
// The file's own `security:` default reaches every operation that lists none, so it may name no class's scheme.
const withDefault = (security) => exclusiveSchemeProblems(ops(good), classes, security);
check(withDefault([{ assertion: [] }]).length === 0, "a file default of the identity assertion passes");
check(withDefault(undefined).length === 0, "no file default passes");
check(withDefault([{ pairingRedeem: [] }]).some((p) => p.startsWith("security:")), "a file default naming the pairing scheme is a problem");
check(withDefault([{ assertion: [] }, { providerDelivery: [] }]).some((p) => p.startsWith("security:")), "a file default offering a class's scheme as one alternative is a problem");
check(withDefault([{ assertion: [], pairingRedeem: [] }]).some((p) => p.startsWith("security:")), "a file default pairing a class's scheme with another is a problem");

if (failed) { console.error(`security-classes selftest: ${failed} failed`); process.exit(1); }
console.log("security-classes selftest passed");

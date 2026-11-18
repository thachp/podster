// Self-tests for gateway-wiring.mjs: what counts as the passthrough refusing a prefix, and as a handler being called.
import { blank, calls, passthroughRefuses } from "./gateway-wiring.mjs";

let failed = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
};
const passthrough = (body) => `export function allowedPassthrough(path: string) {\n${body}\n}\n`;

check("comments are blanked, strings kept", blank('a // "x"\nb /* c */ "d // e"'), 'a       \nb         "d // e"');
check("a regular expression's quote or slashes start nothing", blank('const r = /[&<>"\']/g; x = /^\\/a\\//.test(y); // gone'), 'const r = /[&<>"\']/g; x = /^\\/a\\//.test(y);        ');
check("division isn't a regular expression", blank("a = b / c; // gone"), "a = b / c;        ");
check("a real refusal passes", passthroughRefuses(passthrough('  return !path.startsWith("/v1/agents") && !path.startsWith("/v1/pairing");'), "/v1/pairing"), true);
check("an array entry passes", passthroughRefuses(passthrough('  return !["/v1/agents", "/v1/pairing"].some((p) => path.startsWith(p));'), "/v1/pairing"), true);
check("a refusal in a line comment doesn't count", passthroughRefuses(passthrough('  // !path.startsWith("/v1/pairing")\n  return true;'), "/v1/pairing"), false);
check("a refusal in a block comment doesn't count", passthroughRefuses(passthrough('  /* !path.startsWith("/v1/pairing") */ return true;'), "/v1/pairing"), false);
check("a longer prefix doesn't count", passthroughRefuses(passthrough('  return !path.startsWith("/v1/pairings");'), "/v1/pairing"), false);
check("a refusal outside the function doesn't count", passthroughRefuses(`const x = !path.startsWith("/v1/pairing");\n${passthrough("  return true;")}`, "/v1/pairing"), false);
check("a string holding the refusal doesn't count", passthroughRefuses(passthrough('  const note = "!path.startsWith(\\"/v1/pairing\\")";\n  return true;'), "/v1/pairing"), false);
check("no function, no refusal", passthroughRefuses('const allowedPassthrough = () => !path.startsWith("/v1/pairing");', "/v1/pairing"), false);
check("a real call passes", calls("const r = await handlePairing(request, url, env, identity);", "handlePairing"), true);
check("an import isn't a call", calls('import { handlePairing } from "./pairing";', "handlePairing"), false);
check("a call in a comment doesn't count", calls("// handlePairing(request)\n/* handlePairing(x) */", "handlePairing"), false);
check("a call in a string doesn't count", calls('const s = "handlePairing(request)";', "handlePairing"), false);
check("a longer name doesn't count", calls("handlePairingRedeem(request, url, env);", "handlePairing"), false);
check("a member of something else doesn't count", calls("other.handlePairing(request);", "handlePairing"), false);
check("a declaration isn't a call", calls("export async function handlePairing(request: Request) {}", "handlePairing"), false);

if (failed) {
  console.error(`gateway-wiring selftest: ${failed} failed`);
  process.exit(1);
}
console.log("gateway-wiring selftest passed");

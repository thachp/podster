// The reader of core's closed sets, checked on sources of its own: it must refuse what it can't read whole, so a
// variant added to the rules without a name, or left out of `ALL`, can't pass as "no drift".
import { columnCheck, constant, coreSets, enumNames } from "./core-sets.mjs";

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };
const throws = (run) => { try { run(); return false; } catch { return true; } };

const source = (variants, arms, all) => `
pub enum Colour {
${variants.map((v) => `    /// A colour.\n    ${v},`).join("\n")}
}
impl Colour {
    pub fn name(self) -> &'static str {
        match self {
${arms.map(([v, text]) => `            Colour::${v} => "${text}",`).join("\n")}
        }
    }
    pub const ALL: [Colour; ${all}] = [];
}
pub enum Other { A, }
impl Other {
    pub fn name(self) -> &'static str {
        match self {
            Other::A => "a",
        }
    }
}
pub const LIMIT: usize = 26;
pub const WORD: &str = "rel_";
`;
const good = source(["Red", "DarkBlue"], [["Red", "red"], ["DarkBlue", "dark_blue"]], 2);
check(enumNames(good, "Colour", "name").join() === "red,dark_blue", "an enum's names come out in declaration order");
check(enumNames(good, "Other", "name").join() === "a", "a second enum in the same file is read by its own arms");
check(throws(() => enumNames(source(["Red", "DarkBlue"], [["Red", "red"]], 2), "Colour", "name")), "a variant with no name is refused");
check(throws(() => enumNames(source(["Red"], [["Red", "red"], ["DarkBlue", "dark_blue"]], 1), "Colour", "name")), "a name for no variant is refused");
check(throws(() => enumNames(source(["Red", "DarkBlue"], [["Red", "red"], ["DarkBlue", "dark_blue"]], 1), "Colour", "name")), "an ALL that leaves a variant out is refused");
check(throws(() => enumNames(source(["Red", "DarkBlue"], [["Red", "red"], ["DarkBlue", "red"]], 2), "Colour", "name")), "two variants sharing a name are refused");
check(throws(() => enumNames(good, "Missing", "name")) && throws(() => enumNames(good, "Colour", "code")), "an unknown enum or method is refused");
check(constant(good, "LIMIT") === "26" && constant(good, "WORD") === "rel_" && throws(() => constant(good, "NOPE")), "constants are read, and a missing one is refused");

const store = "CREATE TABLE paint (id TEXT, colour TEXT NOT NULL CHECK (colour IN ('red', 'dark_blue')), open INTEGER, CHECK ((open IS NOT NULL) = (colour IN ('red'))));\n";
check(columnCheck(store, "paint", "colour").join() === "red,dark_blue", "a column's closed check is read, and a tie that names the column isn't taken for it");
check(throws(() => columnCheck(store, "paint", "id")) && throws(() => columnCheck(store, "canvas", "colour")), "a column with no closed check, and a missing table, are refused");

// The real sources read whole.
const real = coreSets(new URL("../../", import.meta.url));
check(real.releaseStates.length >= 10 && real.unpublishCauses.length >= 11 && real.hostnameRequestStates.length === 6 && real.openHostnameRequestStates.length === 3, "core's own sets are read");

if (failed) { console.error(`${failed} core-sets check(s) failed`); process.exit(1); }
console.log("core-sets selftest passed");

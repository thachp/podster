// The IDs a spec file gives the shared stand-ins, `fake-github.ts` and `fake-github-release.ts`, and the label prefix it
// gives `fake-content.ts`'s upload part. Those stand-ins run once, in the test run's own process, for every spec file at
// the same time, and keep what they hold by repository ID or by script name. Two files that use the same ID reset, seed
// and fault each other's world mid-test, and pass or fail by timing: `release-read` and `release-driver` once both used
// 987650777.
//
// So each spec file that keys a stand-in gets a block of its own here, by its file name, and takes every such ID from
// `fakeIds("<its name>")`. Blocks don't overlap, and `e2e/fake-ids-check.mjs` (CI's `e2e` job) fails when a block or a
// tag is used twice, when a file that keys a stand-in doesn't take its IDs here under its own name, or when it writes
// such an ID as a number of its own or computes one from another (`REPO + 1`): it takes another from its block instead.

const FIRST = 600_000_000;
/** How many IDs a block holds. The last is below 2^31, as GitHub's repository IDs have been. */
const BLOCK = 10_000_000;
/** The first IDs of a block are fixed, by number; the rest are handed out by `next()`. */
const FIXED = 1_000;

/** Each spec file's block, and its label tag: two lowercase letters, so one label prefix is never the start of another. */
export const FAKE_ID_BLOCKS = {
  "merge-task": { block: 1, tag: "mt" },
  "provisioning": { block: 2, tag: "pv" },
  "release-driver": { block: 3, tag: "rd" },
  "release-read": { block: 4, tag: "rr" },
  "release-upload": { block: 5, tag: "ru" },
  "repo-access": { block: 6, tag: "ra" },
  "repo-readiness": { block: 7, tag: "ry" },
  "task-change": { block: 8, tag: "tc" },
} as const;

export function fakeIds(spec: keyof typeof FAKE_ID_BLOCKS) {
  const { block, tag } = FAKE_ID_BLOCKS[spec];
  const first = FIRST + block * BLOCK;
  // A different start on every run, so a rerun in the same process (watch mode) never meets the last run's state.
  let last = first + FIXED + Math.floor(Math.random() * (BLOCK / 2 / 10)) * 10;
  return {
    /** This file's fixed ID number `n`. */
    id(n: number): number {
      if (!Number.isInteger(n) || n < 0 || n >= FIXED) throw new Error(`fake ID ${n} is outside ${spec}'s fixed IDs`);
      return first + n;
    },
    /** An ID nothing else in this run has had: one more than the last. */
    next(): number {
      if (++last >= first + BLOCK) throw new Error(`${spec} ran out of fake IDs`);
      return last;
    },
    /** The start of every app label this file makes, for the stand-in's scripts, which are named by label. */
    tag,
  };
}

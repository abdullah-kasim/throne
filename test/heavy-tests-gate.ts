// Gate for the expensive real-infrastructure tests (Lord-ordered
// 2026-08-19): the real-systemd rollback proof and every `.canary.test.ts`
// (real agent spawns, real herdr tabs, real worktrees). These are VERY
// important tests — each exists because a cheaper fake once lied — but far
// too expensive for the default suite's inner loop, so `npm test` skips
// them and `npm run test:heavy` runs them.
//
// AUTHORIZATION LAW: no agent (Regent, Stager, Alpha, Shadow) may run
// `npm run test:heavy` or set THRONE_HEAVY_TESTS without the Lord's DIRECT
// order in the current session. A standing preference, an inherited brief,
// or "the suite felt incomplete" is not an order. See AGENTS.md, "Hard
// rules of the court".

const HEAVY_TESTS_ENV = "THRONE_HEAVY_TESTS";

/**
 * Call as the first statement of a heavy test file. When the gate env is
 * absent the process exits 0 before any test registers — under node's
 * per-file test processes the file reports clean with zero tests, and the
 * skip notice lands in the runner output. When set to exactly "1", the file
 * runs normally.
 */
export function gateHeavyTestFile(): void {
  if (process.env[HEAVY_TESTS_ENV] === "1") return;
  console.log(
    "# heavy real-infrastructure test gated out of the default suite — " +
      "run via `npm run test:heavy` ONLY on the Lord's direct order",
  );
  process.exit(0);
}

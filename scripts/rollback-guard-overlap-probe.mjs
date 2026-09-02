#!/usr/bin/env node
/**
 * Empirical proof that N pairs of `rollback-guard-real-systemd.spec.ts` can
 * run genuinely concurrently (overlapping in wall-clock time, not merely
 * sequential-but-close) without one run's `systemctl --user daemon-reload`
 * perturbing another run's in-flight `Restart=on-failure` retry timing.
 *
 * Drives the REAL spec file, unmodified, via `node --test`. Never forks a
 * modified copy and never bypasses the spec's own "no systemd --user here"
 * self-skip -- if every run in a pair skips, that pair is recorded SKIP, not
 * PASS.
 *
 * Usage: node scripts/rollback-guard-overlap-probe.mjs [pairCount]
 * Exit code: 0 for PASS or SKIP, 1 for FLAKE (or any run error).
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const SPEC_PATH = path.join(
  REPO_ROOT,
  "src/throne-backend/rollback-guard-real-systemd.spec.ts",
);
const REGISTER_PATH = path.join(REPO_ROOT, "test/register-typescript.mjs");

const PAIR_COUNT = Number.parseInt(process.argv[2] ?? "5", 10);
if (!Number.isInteger(PAIR_COUNT) || PAIR_COUNT < 1) {
  console.error(`invalid pair count: ${process.argv[2]}`);
  process.exit(1);
}

/**
 * One `node --test` invocation of the real spec file. Resolves with the
 * captured summary counts and raw output; never rejects (a non-zero exit is
 * itself a data point, not a probe failure) except for a spawn-level error.
 */
function runOneSpecInstance(label) {
  return new Promise((resolve, reject) => {
    const startedAtMs = Date.now();
    const child = spawn(
      process.execPath,
      [
        "--import",
        REGISTER_PATH,
        "--test",
        "--test-timeout=60000",
        SPEC_PATH,
      ],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const durationMs = Date.now() - startedAtMs;
      const combined = `${stdout}\n${stderr}`;
      const pass = /^ℹ pass (\d+)$/m.exec(combined);
      const fail = /^ℹ fail (\d+)$/m.exec(combined);
      const skipped = /^ℹ skipped (\d+)$/m.exec(combined);
      const passCount = pass ? Number.parseInt(pass[1], 10) : 0;
      const failCount = fail ? Number.parseInt(fail[1], 10) : 0;
      const skippedCount = skipped ? Number.parseInt(skipped[1], 10) : 0;
      resolve({
        label,
        code,
        durationMs,
        startedAtMs,
        passCount,
        failCount,
        skippedCount,
        // Only the tail is kept for a healthy run; a failing run keeps the
        // full transcript so the caller can read the exact assertion.
        output: code === 0 && failCount === 0 ? combined.slice(-2000) : combined,
      });
    });
  });
}

/** Two genuinely concurrent instances started back-to-back with no await between them. */
function runOverlappingPair(pairIndex) {
  const a = runOneSpecInstance(`pair${pairIndex}.a`);
  const b = runOneSpecInstance(`pair${pairIndex}.b`);
  return Promise.all([a, b]).then(([resultA, resultB]) => ({
    pairIndex,
    resultA,
    resultB,
    // "genuinely overlapping" evidence: the two runs' wall-clock windows
    // intersect, not merely started within the same event-loop tick.
    windowsOverlapped:
      resultA.startedAtMs < resultB.startedAtMs + resultB.durationMs &&
      resultB.startedAtMs < resultA.startedAtMs + resultA.durationMs,
  }));
}

function verdictForRun(result) {
  if (result.skippedCount > 0 && result.passCount === 0 && result.failCount === 0) {
    return "skip";
  }
  if (result.code === 0 && result.failCount === 0 && result.passCount > 0) {
    return "pass";
  }
  return "fail";
}

async function main() {
  console.log(
    `Launching ${PAIR_COUNT} overlapping pair(s) of ${path.relative(REPO_ROOT, SPEC_PATH)}...`,
  );

  // All pairs are themselves launched concurrently -- this is a stronger
  // overlap condition than running pairs one at a time, and still leaves
  // each pair's own two runs directly comparable.
  const pairs = await Promise.all(
    Array.from({ length: PAIR_COUNT }, (_, i) => runOverlappingPair(i + 1)),
  );

  let passPairs = 0;
  let skipPairs = 0;
  let flakePairs = 0;
  const flakeDetails = [];
  const nonOverlapping = [];

  for (const pair of pairs) {
    const verdictA = verdictForRun(pair.resultA);
    const verdictB = verdictForRun(pair.resultB);
    console.log(
      `pair ${pair.pairIndex}: a=${verdictA} (${pair.resultA.durationMs}ms) ` +
        `b=${verdictB} (${pair.resultB.durationMs}ms) overlapped=${pair.windowsOverlapped}`,
    );

    if (!pair.windowsOverlapped) {
      nonOverlapping.push(pair.pairIndex);
    }

    if (verdictA === "skip" && verdictB === "skip") {
      skipPairs += 1;
      continue;
    }
    if (verdictA === "pass" && verdictB === "pass") {
      passPairs += 1;
      continue;
    }
    flakePairs += 1;
    flakeDetails.push({
      pairIndex: pair.pairIndex,
      a: { verdict: verdictA, ...pair.resultA },
      b: { verdict: verdictB, ...pair.resultB },
    });
  }

  console.log("");
  let overallVerdict;
  if (skipPairs === PAIR_COUNT) {
    overallVerdict = "SKIP";
    console.log(
      `SKIP: systemd --user is unreachable on this host -- all ${PAIR_COUNT}/${PAIR_COUNT} pairs self-skipped.`,
    );
  } else if (flakePairs > 0) {
    overallVerdict = "FLAKE";
    console.log(
      `FLAKE: ${flakePairs}/${PAIR_COUNT} pairs did not cleanly double-pass (skip=${skipPairs}, pass=${passPairs}).`,
    );
    for (const detail of flakeDetails) {
      console.log(`\n--- pair ${detail.pairIndex} failure detail ---`);
      for (const side of [detail.a, detail.b]) {
        if (side.verdict !== "pass" && side.verdict !== "skip") {
          console.log(`[${side.label}] exit=${side.code} pass=${side.passCount} fail=${side.failCount}`);
          console.log(side.output);
        }
      }
    }
  } else {
    overallVerdict = "PASS";
    console.log(
      `PASS: ${passPairs}/${PAIR_COUNT} overlapping pairs passed cleanly, zero flakes ` +
        `(${skipPairs} pair(s) self-skipped due to no systemd --user).`,
    );
  }

  if (nonOverlapping.length > 0) {
    console.log(
      `\nWARNING: pair(s) [${nonOverlapping.join(", ")}] did not actually overlap in wall-clock ` +
        `time -- treat their result as weaker evidence than the overlapping pairs.`,
    );
  }

  console.log(`\nVERDICT_JSON=${JSON.stringify({ verdict: overallVerdict, pairCount: PAIR_COUNT, passPairs, skipPairs, flakePairs, nonOverlapping })}`);

  process.exit(overallVerdict === "FLAKE" ? 1 : 0);
}

main().catch((error) => {
  console.error("probe crashed:", error);
  process.exit(1);
});

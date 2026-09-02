#!/usr/bin/env node
// Compares a suite run's actual non-passing test names against the checked-in
// known-failure manifest (test/known-failures.json), so a gate can read a
// file instead of re-deriving the standing-red set by hand. This tooling
// NEVER writes to the manifest — adding an entry stays an ordinary reviewed
// commit (000_current_questions.md Q1/Q2 in the baseline-manifest bundle).
//
//   node scripts/check-known-failures.mjs <suite-log-path> [manifest-path]
//
// Exits nonzero when the run reports a failing/cancelled name absent from
// the manifest (the loud-fail case a gate acts on). Exits zero otherwise,
// even when the manifest lists names the run didn't see fail — tests can
// pass under low contention, so an unseen manifest entry is informational,
// not a failure.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST_PATH = path.join(
  HERE,
  "..",
  "test",
  "known-failures.json",
);

const NOT_OK_LINE = /^not ok \d+ - (.+)$/gm;
const FAIL_SUMMARY = /^# fail (\d+)$/m;
const CANCELLED_SUMMARY = /^# cancelled (\d+)$/m;

export function parseNonPassingTestNames(suiteOutput) {
  const names = new Set();
  for (const match of suiteOutput.matchAll(NOT_OK_LINE)) {
    names.add(match[1]);
  }
  return names;
}

export function parseSuiteFailCancelledCounts(suiteOutput) {
  const fail = suiteOutput.match(FAIL_SUMMARY);
  const cancelled = suiteOutput.match(CANCELLED_SUMMARY);
  return {
    failed: fail ? Number(fail[1]) : undefined,
    cancelled: cancelled ? Number(cancelled[1]) : undefined,
  };
}

export function loadKnownFailureManifest(manifestPath) {
  const raw = readFileSync(manifestPath, "utf8");
  const entries = JSON.parse(raw);
  return new Set(entries.map((entry) => entry.name));
}

export function formatNonPassingTotal({ failed, cancelled }) {
  const total = (failed ?? 0) + (cancelled ?? 0);
  return `${total} non-passing (${failed ?? 0} failed, ${cancelled ?? 0} cancelled)`;
}

/**
 * The comparison contract: every non-passing name absent from the manifest
 * is an unlisted failure (the loud-fail case); every manifest name not seen
 * failing in this run is informational only.
 */
export function compareAgainstKnownFailures(suiteOutput, manifestNames) {
  const nonPassingNames = parseNonPassingTestNames(suiteOutput);
  const unlistedNames = [...nonPassingNames].filter(
    (name) => !manifestNames.has(name),
  );
  const namesNotSeenFailing = [...manifestNames].filter(
    (name) => !nonPassingNames.has(name),
  );
  return {
    nonPassingNames,
    unlistedNames,
    namesNotSeenFailing,
    counts: parseSuiteFailCancelledCounts(suiteOutput),
  };
}

function reportComparison(comparison) {
  process.stdout.write(
    `check-known-failures: ${formatNonPassingTotal(comparison.counts)}\n`,
  );
  if (comparison.namesNotSeenFailing.length > 0) {
    process.stdout.write(
      `check-known-failures: ${comparison.namesNotSeenFailing.length} manifest entr${
        comparison.namesNotSeenFailing.length === 1 ? "y" : "ies"
      } not seen failing this run (informational):\n`,
    );
    for (const name of comparison.namesNotSeenFailing) {
      process.stdout.write(`  - ${name}\n`);
    }
  }
  if (comparison.unlistedNames.length === 0) {
    process.stdout.write(
      "check-known-failures: clean — every non-passing name is in the manifest\n",
    );
    return 0;
  }
  process.stderr.write(
    `check-known-failures: ${comparison.unlistedNames.length} non-passing name(s) are NOT in the manifest:\n`,
  );
  for (const name of comparison.unlistedNames) {
    process.stderr.write(`  - ${name}\n`);
  }
  return 1;
}

function parseCliArgs(argv) {
  const [suiteLogPath, manifestPath] = argv;
  if (!suiteLogPath) {
    throw new Error(
      "usage: check-known-failures.mjs <suite-log-path> [manifest-path]",
    );
  }
  return {
    suiteLogPath,
    manifestPath: manifestPath ?? DEFAULT_MANIFEST_PATH,
  };
}

function main() {
  const { suiteLogPath, manifestPath } = parseCliArgs(process.argv.slice(2));
  const suiteOutput = readFileSync(suiteLogPath, "utf8");
  const manifestNames = loadKnownFailureManifest(manifestPath);
  const comparison = compareAgainstKnownFailures(suiteOutput, manifestNames);
  process.exit(reportComparison(comparison));
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

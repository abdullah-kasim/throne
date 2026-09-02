// Builds and verifies the REFUSED diagnostic for the suite concurrency guard
// (scripts/suite-concurrency-guard.mjs). Extracted into its own module so
// tests can prove the holder-name verification and message construction
// directly, without needing the guard's own kernel-flock wait to actually
// expire.

/**
 * Cross-checks the holder metadata against the kernel rather than trusting
 * it on its own: the recorded pid must actually be alive, AND the lock file
 * must still be genuinely unattainable (a non-blocking flock attempt must
 * fail to acquire it). If a non-blocking attempt SUCCEEDS, the lock is free
 * regardless of what the JSON claims — treat this as no real conflict, not
 * as grounds to print a fabricated holder identity.
 */
export function isHolderVerified(meta, lockPath, spawnSync) {
  if (!meta?.pid) return false;

  const psResult = spawnSync("ps", ["-p", String(meta.pid)]);
  const pidAlive = psResult.status === 0;
  if (!pidAlive) return false;

  const flockResult = spawnSync("flock", ["-n", lockPath, "-c", "true"]);
  const lockGenuinelyHeld = flockResult.status !== 0;
  return lockGenuinelyHeld;
}

export function describeAge(startedAtIso, now) {
  const started = Date.parse(startedAtIso ?? "");
  if (Number.isNaN(started)) return "unknown";
  const ms = now - started;
  if (ms < 1000) return "just now";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

/**
 * The lines identifying the holder in the REFUSED message. When `verified`
 * is false, the holder identity from `meta` is deliberately never printed —
 * unverified metadata (stale or from an unrelated prior run) must never be
 * presented as a real holder name.
 */
export function buildHolderReportLines(meta, verified, now) {
  if (!verified) {
    return [
      "  Holder:      unverifiable (stale or missing metadata — the kernel",
      "               lock refused this run regardless, so something is",
      "               still holding it even though we can't confirm who)",
    ];
  }

  return [
    `  Holder:      ${meta.holder ?? "an unknown holder"} (pid ${meta.pid ?? "?"})`,
    `  Where:       ${meta.cwd ?? "an unknown location"}`,
    `  Running for: ${describeAge(meta.startedAt, now)}`,
  ];
}

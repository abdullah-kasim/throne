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

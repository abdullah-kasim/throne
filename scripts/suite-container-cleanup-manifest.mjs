// Resumable manifest for suite-container-cleanup.mjs's apply runs. Persists
// the full classified candidate list to disk before any removal begins, so
// an interrupted run's boundary is auditable from the manifest rather than
// only from stdout.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_MANIFEST_PATH = join(
  tmpdir(),
  "throne-suite-container-cleanup-manifest.json",
);

/**
 * @param {Array<{name: string, projectName: string | null, verdict: string, reason: string}>} decisions
 * @param {string} manifestPath
 * @returns {Array<{name: string, projectName: string | null, verdict: string, reason: string, completed: boolean}>}
 */
export function writeResumableManifest(decisions, manifestPath) {
  const entries = decisions.map((entry) => ({
    name: entry.name,
    projectName: entry.projectName,
    verdict: entry.verdict,
    reason: entry.reason,
    completed: false,
  }));
  writeFileSync(manifestPath, JSON.stringify({ entries }, null, 2));
  return entries;
}

/**
 * Flips one manifest entry to `completed: true` and rewrites the manifest
 * file, so a removal's boundary is recorded on disk as it happens.
 */
export function markManifestEntryComplete(
  manifestEntries,
  projectName,
  manifestPath,
) {
  for (const entry of manifestEntries) {
    if (entry.projectName === projectName) entry.completed = true;
  }
  writeFileSync(
    manifestPath,
    JSON.stringify({ entries: manifestEntries }, null, 2),
  );
}

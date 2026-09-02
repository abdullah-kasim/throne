import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  BUILD_SOURCE_FINGERPRINT_MARKER_FILENAME,
  computeBuildInputManifest,
} from './source-content-fingerprint.mjs';

// Production executes compiled JavaScript from `dist/`. Node's native
// TypeScript type stripping (used when running `.ts` sources directly, e.g.
// in dev/test) is a convenience only -- it does not provide the Nest
// decorator transform or the runtime metadata this codebase depends on. A
// `dist/` that is absent, or that no longer reflects the current build-input
// content, means the compiled output no longer reflects the current source:
// running tests (or anything else) against it silently exercises the wrong
// code. This guard fails loud in that case instead of letting it pass as
// green.
//
// Freshness is decided by content, not by filesystem timestamps: compilation
// rewrites `src/` bytes into different `dist/` bytes, so the two trees'
// hashes are never directly comparable. Instead, each published generation
// records a manifest (path + content hash + build-time mtime) of the
// build-input content that produced it (see `scripts/build-and-publish-dist.mjs`),
// and this guard compares that manifest's aggregate fingerprint against a
// fresh fingerprint of the current source. A metadata-only touch (same
// bytes, new mtime) does not change the fingerprint and does not block.
//
// Two-stage ordering, deliberate and not reversible: (1) CONTENT decides
// membership -- which build-input paths actually differ between the
// recorded and current manifests; a merely-touched, byte-identical path is
// never a member no matter how new its mtime. (2) mtime ranks *within* that
// content-proven set only, to report the single newest offender as the most
// actionable diagnosis when several paths changed. Reversing the order --
// letting mtime decide staleness, or letting mtime pull in an unchanged
// path -- recreates the original mtime-only false-positive this guard
// exists to fix.

const FIX_MESSAGE_SUFFIX =
  'Production executes compiled JavaScript from dist/ -- Node\'s native ' +
  'TypeScript type stripping is a dev convenience only and does not provide ' +
  'the Nest decorator transform or runtime metadata this codebase depends ' +
  'on, so a missing or stale dist/ means tests would silently run against ' +
  'the wrong code.';

function readBuildSourceFingerprintManifest(distDir) {
  let raw;
  try {
    raw = readFileSync(path.join(distDir, BUILD_SOURCE_FINGERPRINT_MARKER_FILENAME), 'utf8');
  } catch {
    return undefined; // absent or unreadable
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined; // corrupt -- do not fabricate a manifest out of unparsable evidence
  }
  if (
    !parsed ||
    typeof parsed.fingerprint !== 'string' ||
    !Array.isArray(parsed.files) ||
    !parsed.files.every(
      (entry) =>
        entry &&
        typeof entry.path === 'string' &&
        typeof entry.sha256 === 'string' &&
        typeof entry.mtimeMs === 'number',
    )
  ) {
    return undefined; // missing/invalid shape -- same: fail honestly, do not guess
  }
  return parsed;
}

/** Reads the current on-disk mtime of a build-input path, or `null` if it no longer exists. */
function currentMtimeMs(repoRoot, relativePath) {
  try {
    return statSync(path.join(repoRoot, relativePath)).mtimeMs;
  } catch {
    return null;
  }
}

// Content alone decides *membership* in the offender set: every build-input
// path whose recorded and current content evidence disagree -- by content
// hash, or by one side missing the path entirely -- with an unchanged-bytes,
// merely-touched path (recorded hash == current hash) never a candidate no
// matter how new its mtime is. mtime is used only to rank *within* that
// content-proven set, picking the offender whose current mtime is newest --
// the most likely proximate cause of the mismatch -- never to decide whether
// a path belongs in the set at all, and never to pick a path outside it.
function findAllChangedBuildInputs(repoRoot, recordedManifest, currentManifest) {
  const recordedByPath = new Map(recordedManifest.files.map((entry) => [entry.path, entry]));
  const currentByPath = new Map(currentManifest.files.map((entry) => [entry.path, entry]));
  const allPaths = Array.from(new Set([...recordedByPath.keys(), ...currentByPath.keys()])).sort();

  const offenders = [];
  for (const relativePath of allPaths) {
    const recorded = recordedByPath.get(relativePath);
    const current = currentByPath.get(relativePath);
    if (recorded && current && recorded.sha256 === current.sha256) continue;
    offenders.push({
      path: relativePath,
      recordedMtimeMs: recorded ? recorded.mtimeMs : null,
      currentMtimeMs: current ? current.mtimeMs : currentMtimeMs(repoRoot, relativePath),
    });
  }
  return offenders;
}

// Among the content-proven offender set, name the one with the newest
// current mtime -- deterministic tie-break by path when mtimes are equal (or
// both absent). A deleted build-input path currently has no mtime at all
// (`currentMtimeMs === null`); it ranks below every offender whose current
// bytes actually exist, on the reasoning that "no longer present" is not a
// more recent *edit* than a real, dated one -- it only wins when every
// offender in the set is itself a deletion, at which point the tie-break is
// purely by path.
function pickNewestChangedBuildInput(offenders) {
  if (offenders.length === 0) return null;
  const ranked = [...offenders].sort((a, b) => {
    if (a.currentMtimeMs !== b.currentMtimeMs) {
      if (a.currentMtimeMs === null) return 1;
      if (b.currentMtimeMs === null) return -1;
      return b.currentMtimeMs - a.currentMtimeMs;
    }
    return a.path.localeCompare(b.path);
  });
  return ranked[0];
}

function findNewestChangedBuildInput(repoRoot, recordedManifest, currentManifest) {
  const offenders = findAllChangedBuildInputs(repoRoot, recordedManifest, currentManifest);
  return pickNewestChangedBuildInput(offenders); // null iff aggregate fingerprints differed but no per-file entry did -- see caller
}

function formatMtime(mtimeMs) {
  return mtimeMs === null ? 'absent' : new Date(mtimeMs).toISOString();
}

/**
 * Checks whether `distDir` is a trustworthy build of `repoRoot`'s current
 * build-input content. Returns one of three typed outcomes, `kind` always
 * set and `measuredTree` always naming the absolute `repoRoot` that was
 * actually audited:
 *
 * - `{ ok: true, kind: 'fresh', measuredTree, message }` -- `dist/` is
 *   present and its recorded manifest's fingerprint matches current content.
 * - `{ ok: false, kind: 'absent', measuredTree, message }` -- `dist/` is
 *   missing, or its fingerprint marker is missing/unreadable/malformed, so
 *   there is no trustworthy evidence to audit at all.
 * - `{ ok: false, kind: 'stale', measuredTree, changedPath, recordedMtimeMs,
 *   currentMtimeMs, message }` -- a valid recorded manifest exists but no
 *   longer matches current content; `changedPath` names the newest (by
 *   current mtime) build-input path among those whose recorded and current
 *   content evidence disagree -- content alone decides which paths are in
 *   that set, mtime only ranks within it.
 */
export function checkDistIsFresh(repoRoot, distDir) {
  const measuredTree = path.resolve(repoRoot);
  const measuredDistDir = path.resolve(distDir);

  if (!existsSync(distDir)) {
    return {
      ok: false,
      kind: 'absent',
      measuredTree,
      message:
        `dist/ is missing at ${measuredDistDir} (measured tree: ${measuredTree}): run \`npm run build\`.\n` +
        FIX_MESSAGE_SUFFIX,
    };
  }

  const recordedManifest = readBuildSourceFingerprintManifest(distDir);
  if (!recordedManifest) {
    return {
      ok: false,
      kind: 'absent',
      measuredTree,
      message:
        `dist/ at ${measuredDistDir} (measured tree: ${measuredTree}) has no valid build-source ` +
        `fingerprint marker: run \`npm run build\`.\n${FIX_MESSAGE_SUFFIX}`,
    };
  }

  const currentManifest = computeBuildInputManifest(repoRoot);
  if (currentManifest.fingerprint === recordedManifest.fingerprint) {
    return {
      ok: true,
      kind: 'fresh',
      measuredTree,
      message: `dist/ at ${measuredDistDir} is fresh (measured tree: ${measuredTree}).`,
    };
  }

  const changed = findNewestChangedBuildInput(repoRoot, recordedManifest, currentManifest);
  if (!changed) {
    // Aggregate fingerprints disagree but no per-file entry does -- the
    // recorded evidence itself cannot be trusted to diagnose. Fail honestly
    // rather than fabricate a changed path.
    return {
      ok: false,
      kind: 'stale',
      measuredTree,
      changedPath: null,
      recordedMtimeMs: null,
      currentMtimeMs: null,
      message:
        `dist/ at ${measuredDistDir} is stale (measured tree: ${measuredTree}): recorded build-input ` +
        `content no longer matches current content, but no single differing path could be identified ` +
        `from the recorded evidence. Run \`npm run build\`.\n${FIX_MESSAGE_SUFFIX}`,
    };
  }

  return {
    ok: false,
    kind: 'stale',
    measuredTree,
    changedPath: changed.path,
    recordedMtimeMs: changed.recordedMtimeMs,
    currentMtimeMs: changed.currentMtimeMs,
    message:
      `dist/ at ${measuredDistDir} is stale (measured tree: ${measuredTree}): build-input ` +
      `\`${changed.path}\` differs from the recorded build (recorded mtime ` +
      `${formatMtime(changed.recordedMtimeMs)}, current mtime ${formatMtime(changed.currentMtimeMs)}). ` +
      `Run \`npm run build\`.\n${FIX_MESSAGE_SUFFIX}`,
  };
}

function printUsageAndExit() {
  console.error(
    'usage: node scripts/dist-staleness-guard.mjs <checkout-root>\n' +
      'The checkout root to audit must be named explicitly -- it is never inferred from the ' +
      'caller\'s current working directory.',
  );
  process.exit(1);
}

function main() {
  const target = process.argv[2];
  if (!target) {
    printUsageAndExit();
    return;
  }
  const repoRoot = path.resolve(process.cwd(), target);
  const result = checkDistIsFresh(repoRoot, path.join(repoRoot, 'dist'));
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  console.log(result.message);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

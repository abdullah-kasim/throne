import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Canonical "what counts as build input" list. `SelfRebuildHostedWorker`'s
// path+mtime+size debounce fingerprint (src/throne-backend/self-rebuild.hosted-worker.ts)
// imports this same list rather than keeping its own copy -- one inventory,
// two independent hashing strategies (its cheap metadata debounce, this
// module's content identity) reading it.
export const BUILD_INPUT_ENTRIES = [
  'src',
  'package.json',
  'package-lock.json',
  'nest-cli.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'tsconfig.mutex-fixture.json',
  'systemd',
  // Not a compile input, but a shipped runtime dependency: `buildAndPublishDist`
  // copies this exact file into every generation (see build-and-publish-dist.mjs)
  // because the compiled watcher imports it by real relative path. Without this
  // entry, editing this file's bytes without a rebuild would leave a stale
  // copied helper in dist/ while an unchanged fingerprint still certified the
  // generation fresh. Deliberately just this one file, not all of `scripts/` --
  // no evidence any other script is a shipped runtime dependency.
  path.join('scripts', 'source-content-fingerprint.mjs'),
];

const IGNORED_DIR_NAMES = new Set(['node_modules', '.git']);

export const BUILD_SOURCE_FINGERPRINT_MARKER_FILENAME = '.build-source-fingerprint';

// Frames a field with a fixed-width length prefix before hashing it, so two
// fields hashed back to back can never be reinterpreted at a different
// boundary (e.g. path `"ab"` + content `"c"` colliding with path `"a"` +
// content `"bc"`) -- unlike bare concatenation, a length-prefixed sequence
// has exactly one valid parse.
function updateHashWithFramedField(hash, fieldBuffer) {
  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeUInt32BE(fieldBuffer.length, 0);
  hash.update(lengthPrefix);
  hash.update(fieldBuffer);
}

function updateHashWithFramedPathAndContents(hash, relativePath, contents) {
  updateHashWithFramedField(hash, Buffer.from(relativePath, 'utf8'));
  updateHashWithFramedField(hash, contents);
}

function hashFileContents(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function collectBuildInputFilesRecursive(files, dirPath, relativeTo) {
  let entries;
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return; // vanished mid-scan -- caller sees a fingerprint over what still existed
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (IGNORED_DIR_NAMES.has(entry.name)) continue;
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectBuildInputFilesRecursive(files, entryPath, relativeTo);
      continue;
    }
    let contents;
    let stat;
    try {
      contents = readFileSync(entryPath);
      stat = statSync(entryPath);
    } catch {
      continue; // vanished mid-scan
    }
    files.push({
      relativePath: path.relative(relativeTo, entryPath),
      contents,
      mtimeMs: stat.mtimeMs,
    });
  }
}

/**
 * Every build-input file under `repoRoot`, as `{ relativePath, contents,
 * mtimeMs }` records, in sorted traversal order (directories depth-first,
 * entries within a directory alphabetically). This is the single canonical
 * enumeration both the aggregate content fingerprint and the per-file
 * diagnostic manifest are derived from -- one inventory walk, not two that
 * could drift apart.
 */
function collectBuildInputFiles(repoRoot) {
  const files = [];
  for (const entryName of BUILD_INPUT_ENTRIES) {
    const entryPath = path.join(repoRoot, entryName);
    let stat;
    try {
      stat = statSync(entryPath);
    } catch {
      continue; // e.g. an optional tsconfig variant that doesn't exist on this checkout
    }
    if (stat.isDirectory()) {
      collectBuildInputFilesRecursive(files, entryPath, repoRoot);
    } else {
      let contents;
      try {
        contents = readFileSync(entryPath);
      } catch {
        continue; // vanished between stat and read
      }
      files.push({ relativePath: entryName, contents, mtimeMs: stat.mtimeMs });
    }
  }
  return files;
}

/**
 * Deterministic content identity of every build-input byte under
 * `repoRoot`: relative path plus file bytes for each watched entry, in
 * sorted traversal order, each field length-framed before hashing. Unlike a
 * timestamp, this is unaffected by a metadata-only touch and only changes
 * when a watched file's bytes or relative path actually change.
 */
export function fingerprintSourceContent(repoRoot) {
  const hash = createHash('sha256');
  for (const { relativePath, contents } of collectBuildInputFiles(repoRoot)) {
    updateHashWithFramedPathAndContents(hash, relativePath, contents);
  }
  return hash.digest('hex');
}

/**
 * The same aggregate fingerprint as `fingerprintSourceContent`, plus a
 * per-file manifest (`{ path, sha256, mtimeMs }` for every build-input
 * file, sorted by path) that lets a consumer diagnose exactly *which* input
 * changed and when, without ever using mtime to decide freshness itself --
 * mtime here is diagnostic evidence attached to a content-proven mismatch,
 * never the mismatch signal.
 */
export function computeBuildInputManifest(repoRoot) {
  const files = collectBuildInputFiles(repoRoot);
  const hash = createHash('sha256');
  const entries = [];
  for (const { relativePath, contents, mtimeMs } of files) {
    updateHashWithFramedPathAndContents(hash, relativePath, contents);
    entries.push({ path: relativePath, sha256: hashFileContents(contents), mtimeMs });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { fingerprint: hash.digest('hex'), files: entries };
}

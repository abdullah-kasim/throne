import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readServiceGenerationMarker,
  SERVICE_GENERATION_MARKER_DIR,
} from "../src/status/service-generation-marker.ts";
import {
  BUILD_SOURCE_FINGERPRINT_MARKER_FILENAME,
  computeBuildInputManifest,
} from "./source-content-fingerprint.mjs";

// `dist/` must never be observable mid-rewrite by a concurrent `throne`
// invocation: every compile step below writes into a freshly named staging
// directory the tracked `dist` path never resolves through, and the switch
// from the previous complete tree to the new complete tree is a single
// `rename(2)` of a symlink over the `dist` path. POSIX `rename()` cannot
// atomically replace a non-empty directory with another non-empty directory,
// which is why `dist` is published as a symlink to a uniquely named
// generation directory rather than as a plain directory rebuilt in place.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const generationDirPrefix = "dist.build.";

// A test process (or a test-spawned subprocess) that needs the real
// publish/prune mechanics without sharing the live checkout's real
// `dist.build.*`/`dist` tree points this at a throwaway root. Read lazily
// (per call), never cached at module-import time: an ESM import runs before
// any of an importing test file's own top-level statements, so a module-level
// constant computed from `process.env` here could never see an env var the
// test file sets after its own `import` line executes. Unset, this resolves
// to the exact same real `repoRoot` every production build/deploy already
// uses -- production behavior is unchanged.
function resolveGenerationRoot() {
  return process.env.THRONE_BUILD_GENERATION_ROOT || repoRoot;
}

function resolveDistLinkPath(generationRoot) {
  return path.join(generationRoot, "dist");
}

const expectedGenerationArtifacts = [
  path.join("src", "tools.js"),
  path.join("test", "fixtures", "send-agent-process-mutex-runner.js"),
  "systemd",
  BUILD_SOURCE_FINGERPRINT_MARKER_FILENAME,
  path.join("scripts", "source-content-fingerprint.mjs"),
];

function computeGenerationName() {
  return `${generationDirPrefix}${Date.now()}-${process.pid}`;
}

function parseGenerationOwnerPid(generationName) {
  const match = /-(\d+)$/.exec(generationName);
  return match ? Number(match[1]) : null;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
}

function computeScratchDirName(generationName) {
  return `.dist-scratch.${generationName.slice(generationDirPrefix.length)}`;
}

// A generation superseded by an overlapping build can still be the one a
// short-lived, unmarked reader (a spawned CLI invocation, a subprocess-based
// test) resolved `dist` into and is still executing against, even after its
// own builder process has exited and even though it is neither the pruning
// build's `current` nor its `previous` pointer. This grace window bounds how
// long such a generation survives pure pid-death pruning. It is deliberately
// NOT sized to cover a long-running service holding a generation for hours —
// that is `generationNamesProtectedByLiveServiceMarkers`' job below.
const generationGraceWindowMs = 30_000;

function parseGenerationTimestamp(generationName) {
  const match = /^(\d+)-\d+$/.exec(generationName.slice(generationDirPrefix.length));
  return match ? Number(match[1]) : null;
}

function isGenerationWithinGraceWindow(generationName) {
  const generationTimestamp = parseGenerationTimestamp(generationName);
  return (
    generationTimestamp !== null &&
    Date.now() - generationTimestamp < generationGraceWindowMs
  );
}

// A long-running service (`throne-work`, `throne-backend`) resolves `dist`
// once at its own startup and holds that generation for its entire life —
// hours, sometimes. No grace window can safely cover that, so a live
// service's stamped marker is read as ground truth instead: it names exactly
// the generation that service is still running from. A marker whose `pid`
// has exited is stale evidence and protects nothing.
function generationNamesProtectedByLiveServiceMarkers(
  markerDir = SERVICE_GENERATION_MARKER_DIR,
) {
  const protectedGenerationNames = new Set();
  let markerFileNames;
  try {
    markerFileNames = readdirSync(markerDir);
  } catch {
    return protectedGenerationNames; // no marker directory yet -- no evidence, not an error
  }
  for (const markerFileName of markerFileNames) {
    if (!markerFileName.endsWith(".json")) {
      continue;
    }
    const unitName = markerFileName.slice(0, -".json".length);
    const marker = readServiceGenerationMarker(unitName, markerDir);
    if (marker && isProcessAlive(marker.pid)) {
      protectedGenerationNames.add(marker.generation);
    }
  }
  return protectedGenerationNames;
}

function runCommandOrThrow(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with code ${result.status}`,
    );
  }
}

function writeTsconfigOverridingOutDir(baseTsconfigPath, outDir, scratchDir) {
  const overridePath = path.join(
    scratchDir,
    `${path.basename(baseTsconfigPath, ".json")}.staging.json`,
  );
  writeFileSync(
    overridePath,
    JSON.stringify({
      extends: path.resolve(repoRoot, baseTsconfigPath),
      compilerOptions: { outDir },
    }),
  );
  // nest-cli's own tsconfig resolution (unlike tsc's) only finds `-p` paths
  // given relative to the workspace root; an absolute path is reported as
  // "Could not find TypeScript configuration file" even when it exists.
  return path.relative(repoRoot, overridePath);
}

function compileNestIntoStaging(stagingDir, scratchDir) {
  const overrideTsconfig = writeTsconfigOverridingOutDir(
    "tsconfig.build.json",
    stagingDir,
    scratchDir,
  );
  runCommandOrThrow(
    path.join("node_modules", ".bin", "nest"),
    ["build", "-p", overrideTsconfig],
  );
}

function compileMutexFixtureIntoStaging(stagingDir, scratchDir) {
  const overrideTsconfig = writeTsconfigOverridingOutDir(
    "tsconfig.mutex-fixture.json",
    stagingDir,
    scratchDir,
  );
  runCommandOrThrow(
    path.join("node_modules", ".bin", "tsc"),
    ["-p", overrideTsconfig],
  );
}

function copySystemdIntoStaging(stagingDir) {
  cpSync(path.join(repoRoot, "systemd"), path.join(stagingDir, "systemd"), {
    recursive: true,
  });
}

// `SelfRebuildHostedWorker` (compiled into `dist/src/throne-backend/`) imports
// this module by its real relative path (`../../scripts/source-content-fingerprint.mjs`)
// so it keeps resolving the same "what counts as build input" list -- `nest
// build` does not rewrite that plain-JS relative specifier, and it never
// compiles `scripts/` in the first place. Called unconditionally from
// `buildAndPublishDist` itself (like `recordBuildSourceFingerprint`), not
// from the real compile-step populate function, so every generation --
// including ones built by a test's fake `populateStagingDir` -- ships this
// module at the same relative depth its compiled importer expects.
// Otherwise every production generation's compiled worker would fail to
// resolve this import at runtime.
function copySourceContentFingerprintModuleIntoStaging(stagingDir) {
  mkdirSync(path.join(stagingDir, "scripts"), { recursive: true });
  cpSync(
    path.join(repoRoot, "scripts", "source-content-fingerprint.mjs"),
    path.join(stagingDir, "scripts", "source-content-fingerprint.mjs"),
  );
}

function readCurrentGenerationNameIfPublished(
  generationRoot = resolveGenerationRoot(),
) {
  const distLinkPath = resolveDistLinkPath(generationRoot);
  if (!existsSync(distLinkPath)) {
    return null;
  }
  const distStat = lstatSync(distLinkPath);
  if (!distStat.isSymbolicLink()) {
    // A `dist/` left by the pre-atomic build script is a plain directory,
    // not a generation symlink. `rename()` cannot replace a non-empty
    // directory with a symlink, so migrate it out of the way once; every
    // publish after this one goes through the symlink swap below.
    rmSync(distLinkPath, { recursive: true, force: true });
    return null;
  }
  return path.basename(readlinkSync(distLinkPath));
}

function publishStagingAsDist(
  generationName,
  generationRoot = resolveGenerationRoot(),
) {
  const temporaryLinkPath = path.join(
    generationRoot,
    `${generationName}.publishing`,
  );
  symlinkSync(generationName, temporaryLinkPath);
  renameSync(temporaryLinkPath, resolveDistLinkPath(generationRoot));
}

// A margin, not a fix: retaining the most-recently-published generations by
// count widens the safety window for a reader that predates marker-stamping
// (or predates this process gaining the stamp call) and so is invisible to
// `generationNamesProtectedByLiveServiceMarkers` — but it does NOT close that
// class. A long-running service can hold a single generation across many
// publishes (observed: ~7 hours, spanning far more than this many builds), and
// any fixed count is beatable by a reader that outlives it. Do not treat
// survival past this floor as proof a generation is still referenced, and do
// not remove the marker-based protection above on the mistaken belief this
// floor already covers what it covers.
const recentGenerationCountFloor = 5;

function countFloorProtectedGenerationNames(generationRoot) {
  const timestampedNames = readdirSync(generationRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(generationDirPrefix))
    .map((entry) => ({ name: entry.name, timestamp: parseGenerationTimestamp(entry.name) }))
    .filter(({ timestamp }) => timestamp !== null)
    .sort((a, b) => b.timestamp - a.timestamp);
  return new Set(timestampedNames.slice(0, recentGenerationCountFloor).map(({ name }) => name));
}

// `generationRoot` and `markerDir` default to the real `dist.build.*` home and
// the real service-marker home, so `buildAndPublishDist`'s production call
// below is behaviorally unchanged. A caller proving prune mechanics in
// isolation (see the marker-liveness test) passes its own fixture directories
// instead, so it is structurally incapable of touching the live checkout's
// real generation tree.
function pruneOldGenerations(
  generationNamesToKeep,
  generationRoot = resolveGenerationRoot(),
  markerDir = SERVICE_GENERATION_MARKER_DIR,
) {
  const generationNamesProtectedByLiveMarkers =
    generationNamesProtectedByLiveServiceMarkers(markerDir);
  const generationNamesProtectedByCountFloor =
    countFloorProtectedGenerationNames(generationRoot);
  for (const entry of readdirSync(generationRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(generationDirPrefix)) {
      continue;
    }
    if (generationNamesToKeep.has(entry.name)) {
      continue;
    }
    if (generationNamesProtectedByLiveMarkers.has(entry.name)) {
      continue;
    }
    if (generationNamesProtectedByCountFloor.has(entry.name)) {
      continue;
    }
    const ownerPid = parseGenerationOwnerPid(entry.name);
    if (ownerPid !== null && isProcessAlive(ownerPid)) {
      continue;
    }
    if (isGenerationWithinGraceWindow(entry.name)) {
      continue;
    }
    rmSync(path.join(generationRoot, entry.name), { recursive: true, force: true });
  }
}

// Stamped into the staging generation before it is published, never into the
// live `dist` symlink target directly, so `dist-staleness-guard.mjs` never
// observes a generation whose fingerprint marker lags its compiled output.
// Records the full per-file manifest (path + content hash + build-time
// mtime), not just the aggregate fingerprint, so a later staleness mismatch
// can name exactly which build-input path changed and report its recorded
// vs. current mtime -- diagnostic evidence layered on top of the same
// content proof that already decides staleness.
function recordBuildSourceFingerprint(stagingDir, manifest) {
  writeFileSync(
    path.join(stagingDir, BUILD_SOURCE_FINGERPRINT_MARKER_FILENAME),
    `${JSON.stringify(manifest)}\n`,
  );
}

function verifyPublishedGenerationComplete(generationDir) {
  for (const relativeArtifactPath of expectedGenerationArtifacts) {
    const artifactPath = path.join(generationDir, relativeArtifactPath);
    if (!existsSync(artifactPath)) {
      throw new Error(
        `Published generation ${generationDir} is missing expected build output: ${relativeArtifactPath}`,
      );
    }
  }
}

function populateStagingDirWithCompiledOutput(stagingDir, scratchDir) {
  compileNestIntoStaging(stagingDir, scratchDir);
  compileMutexFixtureIntoStaging(stagingDir, scratchDir);
  copySystemdIntoStaging(stagingDir);
}

// `populateStagingDir` defaults to the real `nest`/`tsc` compile steps; a
// test exercising only the publish/prune/concurrency mechanics may inject a
// fast, deterministic stand-in instead. `generationRoot` defaults to the same
// lazily-resolved decision every other publish/prune entry point uses, so an
// isolated caller (in-process, via this parameter, or a subprocess reading
// `THRONE_BUILD_GENERATION_ROOT`) never touches the real checkout's tree.
// `sourceRoot` defaults to the real checkout (`repoRoot`, fixed) --
// deliberately independent of where the generation output lands, exactly
// like the compile step itself -- and exists as a parameter only so a test
// can fingerprint (and mutate) an isolated fixture tree instead of the real
// checkout's `src/`.
async function buildAndPublishDist(
  populateStagingDir = populateStagingDirWithCompiledOutput,
  generationRoot = resolveGenerationRoot(),
  sourceRoot = repoRoot,
) {
  const previousGenerationName = readCurrentGenerationNameIfPublished(generationRoot);
  const generationName = computeGenerationName();
  const stagingDir = path.join(generationRoot, generationName);
  const scratchDir = path.join(generationRoot, computeScratchDirName(generationName));
  mkdirSync(scratchDir, { recursive: true });

  try {
    // Captured BEFORE compilation, not after: the fingerprint must name the
    // exact content the compiler read. Fingerprinting after `populateStagingDir`
    // returns would let a source edit that lands mid-compile get certified as
    // the fingerprint of bytes the compiler never actually saw.
    const preBuildManifest = computeBuildInputManifest(sourceRoot);
    await populateStagingDir(stagingDir, scratchDir);
    const postBuildFingerprint = computeBuildInputManifest(sourceRoot).fingerprint;
    if (postBuildFingerprint !== preBuildManifest.fingerprint) {
      throw new Error(
        "build-input content changed while compiling -- refusing to publish a generation " +
          "that would be falsely certified fresh for either the pre- or post-change source",
      );
    }
    recordBuildSourceFingerprint(stagingDir, preBuildManifest);
    copySourceContentFingerprintModuleIntoStaging(stagingDir);
    publishStagingAsDist(generationName, generationRoot);
    verifyPublishedGenerationComplete(stagingDir);
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }

  const generationNamesToKeep = new Set([generationName]);
  if (previousGenerationName) {
    generationNamesToKeep.add(previousGenerationName);
  }
  pruneOldGenerations(generationNamesToKeep, generationRoot);
}

function isMainModule() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMainModule()) {
  await buildAndPublishDist();
}

export {
  repoRoot,
  generationDirPrefix,
  buildAndPublishDist,
  pruneOldGenerations,
  publishStagingAsDist,
  readCurrentGenerationNameIfPublished,
};

import { access } from "node:fs/promises";
import path from "node:path";
import type { DependencyHydrationPlan } from "./dependency-hydration-fingerprint.ts";

// What `hydrateDependencies` actually did, so a caller (e.g.
// `GitTreeCreationService.create()`) can record how a tree came to have its
// dependency directories without re-deriving it from filesystem evidence:
// "reflink" copied a trusted source snapshot, "install" ran a real installer
// because no trusted snapshot was available, "skipped" found nothing to
// hydrate at all.
export type DependencyHydrationMode = "reflink" | "install" | "skipped";

export interface DependencyHydrationResult extends DependencyHydrationPlan {
  readonly mode: DependencyHydrationMode;
}

export interface DependencyInstallPlatform {
  install(destinationProjectDir: string): Promise<void>;
}

export class NpmInstallPlatform implements DependencyInstallPlatform {
  async install(destinationProjectDir: string): Promise<void> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("npm", ["install"], {
      cwd: destinationProjectDir,
    });
  }
}

/**
 * The single place the "can this dependency directory be safely reflinked
 * from the source?" decision is answered: only when the source's declared
 * dependencies are the SAME declared state as the destination's (including
 * the case where neither declares any manifest at all). A `false` answer
 * does not by itself mean refusal — callers decide what to do about it.
 */
export function isReflinkTrustworthy(
  sourceFingerprint: string | undefined,
  destinationFingerprint: string | undefined,
): boolean {
  return sourceFingerprint === destinationFingerprint;
}

export async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function divergentSnapshotError(
  sourceProjectDir: string,
  destinationProjectDir: string,
): Error {
  return new Error(
    `dependency hydration refuses a divergent snapshot: "${sourceProjectDir}"'s ` +
      `declared dependencies do not match "${destinationProjectDir}"'s — the ` +
      "source's node_modules (or other dependency directory) would not reflect " +
      "what the destination tree actually needs, and no safe destination install " +
      "fallback is available for this dependency plan.",
  );
}

/**
 * Decides which paths `hydrateDependencies` must actually visit once a
 * trustworthy reflink is off the table. The guard's throw is preserved as
 * the trigger, not deleted: only the npm ecosystem gets an install fallback
 * (00's scope boundary). Any other ecosystem in the plan still refuses
 * outright, atomically, before anything is copied or installed. A real
 * install fallback only has somewhere useful to land when the destination
 * itself declares npm dependencies — this also covers the no-manifest-at-
 * source case, where `planPaths` (derived from the SOURCE) never even
 * mentions `node_modules`.
 */
export async function resolveInstallFallbackPaths(
  sourceProjectDir: string,
  destinationProjectDir: string,
  planPaths: readonly string[],
  npmDependencyPath: string,
): Promise<readonly string[]> {
  const hasNonNpmPath = planPaths.some(
    (relativePath) => relativePath !== npmDependencyPath,
  );
  if (hasNonNpmPath) {
    throw divergentSnapshotError(sourceProjectDir, destinationProjectDir);
  }
  if (!(await pathExists(path.join(destinationProjectDir, "package.json")))) {
    throw divergentSnapshotError(sourceProjectDir, destinationProjectDir);
  }
  return [...new Set([...planPaths, npmDependencyPath])];
}

/**
 * Hydrates a single dependency path with no trustworthy reflink source by
 * really installing into the destination. Signals the slow path on stderr
 * before running, and leaves no half-populated destination directory behind
 * when the install itself genuinely fails.
 */
export async function installFallbackPath(
  destinationProjectDir: string,
  relativePath: string,
  installer: DependencyInstallPlatform,
): Promise<void> {
  const { rm } = await import("node:fs/promises");
  const destination = path.join(destinationProjectDir, relativePath);
  process.stderr.write(
    `dependency hydration: no trustworthy reflink source for "${relativePath}" ` +
      `— falling back to a real install in "${destinationProjectDir}" (slower ` +
      "than a reflink).\n",
  );
  try {
    await installer.install(destinationProjectDir);
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

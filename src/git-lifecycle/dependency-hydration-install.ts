import { access } from "node:fs/promises";
import path from "node:path";
import {
  runForgeProcess,
  type ProcessResult,
  type ProcessRunner,
} from "../forge/forge-dependencies.ts";
import { readPinnedNodeVersion } from "../install-services/pinned-node-version.ts";
import type { DependencyHydrationPlan } from "./dependency-hydration-fingerprint.ts";
import { THRONE_PROJECT_DIR } from "./git-worktree.service.ts";
import { MiseNodeReleases } from "./mise-node-releases.ts";
import { nodeForProject, type NodeChoice } from "./node-for-project.ts";

export type { NodeChoice } from "./node-for-project.ts";

// What `hydrateDependencies` actually did, so a caller (e.g.
// `GitTreeCreationService.create()`) can record how a tree came to have its
// dependency directories without re-deriving it from filesystem evidence:
// "reflink" copied a trusted source snapshot, "install" ran a real installer
// because no trusted snapshot was available, "skipped" found nothing to
// hydrate at all.
export type DependencyHydrationMode = "reflink" | "install" | "skipped";

export interface DependencyHydrationResult extends DependencyHydrationPlan {
  readonly mode: DependencyHydrationMode;
  readonly node?: NodeChoice;
}

export interface DependencyInstallPlatform {
  chooseNode(destinationProjectDir: string): Promise<NodeChoice>;
  install(destinationProjectDir: string, node: NodeChoice): Promise<void>;
}

const ENGINE_REFUSAL = /EBADENGINE|Unsupported engine/;
const NPM_ENGINE_REQUIREMENT = /Required:\s*(.+)/;

function isEngineRefusal(result: ProcessResult): boolean {
  return ENGINE_REFUSAL.test(result.stderr);
}

function engineRefusalError(
  destinationProjectDir: string,
  node: NodeChoice,
  npmOutput: string,
): Error {
  const requirement =
    NPM_ENGINE_REQUIREMENT.exec(npmOutput)?.[1]?.trim() ?? "not stated by npm";
  return new Error(
    `npm install in "${destinationProjectDir}" refused the Node engine: the ` +
      `project declares ${node.declared ?? "none"}, the install used Node ` +
      `${node.version} from "${node.binDirectory}", and npm requires ` +
      `${requirement}. It was not retried on another Node.\n${npmOutput.trim()}`,
  );
}

function pathStartingWith(binDirectory: string): string {
  return [binDirectory, process.env.PATH ?? ""].join(path.delimiter);
}

export class NpmInstallPlatform implements DependencyInstallPlatform {
  private readonly runProcess: ProcessRunner;
  private readonly throneRoot: string;

  constructor(
    runProcess: ProcessRunner = runForgeProcess,
    throneRoot: string = THRONE_PROJECT_DIR,
  ) {
    this.runProcess = runProcess;
    this.throneRoot = throneRoot;
  }

  chooseNode(destinationProjectDir: string): Promise<NodeChoice> {
    return nodeForProject(
      destinationProjectDir,
      new MiseNodeReleases(destinationProjectDir, this.runProcess),
      readPinnedNodeVersion(this.throneRoot),
    );
  }

  async install(
    destinationProjectDir: string,
    node: NodeChoice,
  ): Promise<void> {
    const result = await this.runProcess("npm", ["install"], {
      cwd: destinationProjectDir,
      environment: {
        ...process.env,
        PATH: pathStartingWith(node.binDirectory),
      },
    });
    if (result.exitCode === 0) return;
    if (isEngineRefusal(result)) {
      throw engineRefusalError(destinationProjectDir, node, result.stderr);
    }
    throw new Error(
      `npm install failed in "${destinationProjectDir}" with Node ` +
        `${node.version}: ${result.stderr.trim()}`,
    );
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
): Promise<NodeChoice> {
  const { rm } = await import("node:fs/promises");
  const destination = path.join(destinationProjectDir, relativePath);
  process.stderr.write(
    `dependency hydration: no trustworthy reflink source for "${relativePath}" ` +
      `— falling back to a real install in "${destinationProjectDir}" (slower ` +
      "than a reflink).\n",
  );
  const node = await installer.chooseNode(destinationProjectDir);
  process.stderr.write(
    `dependency hydration: installing with Node ${node.version} from ` +
      `"${node.binDirectory}" — ${node.reason}.\n`,
  );
  try {
    await installer.install(destinationProjectDir, node);
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return node;
}

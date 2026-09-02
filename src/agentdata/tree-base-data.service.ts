import { Injectable } from "@nestjs/common";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DATA_DIR } from "./spawn-data-contracts.ts";
import type { DependencyHydrationMode } from "../git-lifecycle/dependency-hydration.ts";

export interface TreeBase {
  name: string;
  base: string;
  branch: string;
  commit: string;
  repo?: string;
  /** Canonical repository root; `repo` remains the requested project path. */
  repoRoot?: string;
  /** Nested project directory relative to `repoRoot`, or `.` at the root. */
  projectDir?: string;
  notedAt: string;
  nonCampaign?: true;
  /** Which mode `hydrateDependencies` actually used for this tree's dependency dirs. */
  dependencyHydration?: DependencyHydrationMode;
}

const TREE_BASE_BASENAME = "tree-base.json";
export const CANCELLED_UNMERGED_TREE_BASE_BASENAME =
  "tree-base.cancelled-unmerged.json";

export interface CancelledUnmergedTreeBaseAuthority {
  record: TreeBase;
  bytes: Buffer;
  source: "live" | "preserved";
}

type OptionalFileBytes =
  { status: "absent" } | { status: "present"; bytes: Buffer };

async function readOptionalFileBytes(
  filePath: string,
): Promise<OptionalFileBytes> {
  try {
    return { status: "present", bytes: await readFile(filePath) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { status: "absent" };
    throw new Error(
      `cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseTreeBaseAuthority(
  name: string,
  basename: string,
  bytes: Buffer,
): TreeBase {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(
      `data/${name}/${basename} contains invalid JSON; refusing teardown`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `data/${name}/${basename} must contain a JSON object; refusing teardown`,
    );
  }
  return parsed as TreeBase;
}

@Injectable()
export class TreeBaseDataService {
  readonly cancelledUnmergedBasename = CANCELLED_UNMERGED_TREE_BASE_BASENAME;

  async read(
    name: string,
    baseDir: string = DEFAULT_DATA_DIR,
  ): Promise<TreeBase | null> {
    try {
      const raw = await readFile(
        path.join(baseDir, name, TREE_BASE_BASENAME),
        "utf8",
      );
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
        ? (parsed as TreeBase)
        : null;
    } catch {
      return null;
    }
  }

  async readForCancelledUnmerged(
    name: string,
    baseDir: string = DEFAULT_DATA_DIR,
  ): Promise<CancelledUnmergedTreeBaseAuthority> {
    const dir = path.join(baseDir, name);
    const [live, preserved] = await Promise.all([
      readOptionalFileBytes(path.join(dir, TREE_BASE_BASENAME)),
      readOptionalFileBytes(
        path.join(dir, CANCELLED_UNMERGED_TREE_BASE_BASENAME),
      ),
    ]);
    if (live.status === "present" && preserved.status === "present")
      throw new Error(
        `data/${name} contains both ${TREE_BASE_BASENAME} and ${CANCELLED_UNMERGED_TREE_BASE_BASENAME}; refusing ambiguous teardown`,
      );
    if (live.status === "absent" && preserved.status === "absent")
      throw new Error(
        `data/${name} has no ${TREE_BASE_BASENAME} or ${CANCELLED_UNMERGED_TREE_BASE_BASENAME}; cancelled-unmerged archival requires exact provenance`,
      );
    if (live.status === "present")
      return {
        record: parseTreeBaseAuthority(name, TREE_BASE_BASENAME, live.bytes),
        bytes: live.bytes,
        source: "live",
      };
    if (preserved.status === "present")
      return {
        record: parseTreeBaseAuthority(
          name,
          CANCELLED_UNMERGED_TREE_BASE_BASENAME,
          preserved.bytes,
        ),
        bytes: preserved.bytes,
        source: "preserved",
      };
    throw new Error(`data/${name} cancelled-unmerged provenance vanished`);
  }

  async preserveForCancelledUnmerged(
    name: string,
    authority: CancelledUnmergedTreeBaseAuthority,
    baseDir: string = DEFAULT_DATA_DIR,
  ): Promise<"preserved" | "already-preserved"> {
    const dir = path.join(baseDir, name);
    const livePath = path.join(dir, TREE_BASE_BASENAME);
    const preservedPath = path.join(dir, CANCELLED_UNMERGED_TREE_BASE_BASENAME);
    const [live, preserved] = await Promise.all([
      readOptionalFileBytes(livePath),
      readOptionalFileBytes(preservedPath),
    ]);
    if (authority.source === "preserved") {
      if (
        live.status === "present" ||
        preserved.status === "absent" ||
        !preserved.bytes.equals(authority.bytes)
      )
        throw new Error(
          `data/${name} cancelled-unmerged provenance changed after preflight`,
        );
      return "already-preserved";
    }
    if (
      live.status === "absent" ||
      preserved.status === "present" ||
      !live.bytes.equals(authority.bytes)
    )
      throw new Error(
        `data/${name} cancelled-unmerged provenance changed after preflight`,
      );
    await rename(livePath, preservedPath);
    const moved = await readOptionalFileBytes(preservedPath);
    if (moved.status === "absent" || !moved.bytes.equals(authority.bytes))
      throw new Error(
        `data/${name}/${CANCELLED_UNMERGED_TREE_BASE_BASENAME} was not preserved byte-for-byte`,
      );
    return "preserved";
  }

  async write(
    name: string,
    base: TreeBase,
    baseDir: string = DEFAULT_DATA_DIR,
  ): Promise<void> {
    const dir = path.join(baseDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, TREE_BASE_BASENAME),
      `${JSON.stringify(base, null, 2)}\n`,
      "utf8",
    );
  }

  async remove(
    name: string,
    baseDir: string = DEFAULT_DATA_DIR,
  ): Promise<void> {
    await rm(path.join(baseDir, name, TREE_BASE_BASENAME), { force: true });
  }

  async readForBranchCleanup(
    name: string,
    baseDir: string = DEFAULT_DATA_DIR,
  ): Promise<TreeBase | null> {
    const preserved = await readOptionalFileBytes(
      path.join(baseDir, name, CANCELLED_UNMERGED_TREE_BASE_BASENAME),
    );
    let raw: string;
    try {
      raw = await readFile(
        path.join(baseDir, name, TREE_BASE_BASENAME),
        "utf8",
      );
    } catch {
      if (preserved.status === "present")
        throw new Error(
          `data/${name}/${CANCELLED_UNMERGED_TREE_BASE_BASENAME} marks an in-progress cancelled-unmerged lifecycle; retry reap-agent with --reason cancelled --archive-cancelled-unmerged`,
        );
      return null;
    }
    if (preserved.status === "present")
      throw new Error(
        `data/${name} contains both ${TREE_BASE_BASENAME} and ${CANCELLED_UNMERGED_TREE_BASE_BASENAME}; refusing ambiguous branch cleanup`,
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `data/${name}/tree-base.json contains invalid JSON; refusing branch cleanup`,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error(
        `data/${name}/tree-base.json must contain a JSON object; refusing branch cleanup`,
      );
    return parsed as TreeBase;
  }
}

export const TREE_BASE_DATA = new TreeBaseDataService();

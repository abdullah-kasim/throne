import path from "node:path";
import type { ProcessRunner } from "../forge/forge-dependencies.ts";
import { canonicalPath } from "./git-command.service.ts";
import type { NodeReleaseCandidates } from "./node-release-choice.ts";

export interface NodeDeclaration {
  readonly requested: string;
  readonly resolvedVersion: string;
  readonly sourceFile: string;
}

export interface ProjectNodeReleases extends NodeReleaseCandidates {
  projectDeclaration(): Promise<NodeDeclaration | null>;
  install(version: string): Promise<void>;
  binDirectory(version: string): Promise<string>;
}

interface MiseNodeEntry {
  readonly version: string;
  readonly requested_version?: string;
  readonly source?: { readonly path?: string };
}

const MISE_COMMAND = "mise";
const NODE_TOOL = "node";

async function isInsideProject(
  file: string,
  projectDir: string,
): Promise<boolean> {
  const [canonicalFile, canonicalProject] = await Promise.all([
    canonicalPath(file),
    canonicalPath(projectDir),
  ]);
  const relative = path.relative(canonicalProject, canonicalFile);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export class MiseNodeReleases implements ProjectNodeReleases {
  private readonly projectDir: string;
  private readonly runProcess: ProcessRunner;

  constructor(projectDir: string, runProcess: ProcessRunner) {
    this.projectDir = projectDir;
    this.runProcess = runProcess;
  }

  async projectDeclaration(): Promise<NodeDeclaration | null> {
    const entries = JSON.parse(
      await this.runMise(["ls", "--current", "--json", NODE_TOOL]),
    ) as MiseNodeEntry[];
    for (const entry of entries) {
      const sourceFile = entry.source?.path;
      if (
        sourceFile !== undefined &&
        entry.requested_version !== undefined &&
        (await isInsideProject(sourceFile, this.projectDir))
      ) {
        return {
          requested: entry.requested_version,
          resolvedVersion: entry.version,
          sourceFile,
        };
      }
    }
    return null;
  }

  async installedVersions(): Promise<readonly string[]> {
    const entries = JSON.parse(
      await this.runMise(["ls", "--installed", "--json", NODE_TOOL]),
    ) as MiseNodeEntry[];
    return entries.map((entry) => entry.version);
  }

  async availableVersions(): Promise<readonly string[]> {
    const listing = await this.runMise(["ls-remote", NODE_TOOL]);
    return listing
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  }

  async newestLtsVersion(): Promise<string> {
    return (await this.runMise(["latest", `${NODE_TOOL}@lts`])).trim();
  }

  async install(version: string): Promise<void> {
    await this.runMise(["install", `${NODE_TOOL}@${version}`]);
  }

  async binDirectory(version: string): Promise<string> {
    const installPath = await this.runMise([
      "where",
      `${NODE_TOOL}@${version}`,
    ]);
    return path.join(installPath.trim(), "bin");
  }

  private async runMise(args: readonly string[]): Promise<string> {
    const result = await this.runProcess(MISE_COMMAND, args, {
      cwd: this.projectDir,
      environment: {
        ...process.env,
        MISE_IDIOMATIC_VERSION_FILE_ENABLE_TOOLS: NODE_TOOL,
        MISE_TRUSTED_CONFIG_PATHS: this.projectDir,
      },
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `mise ${args.join(" ")} failed in "${this.projectDir}" while choosing ` +
          `the Node for its dependency install: ${result.stderr.trim()}`,
      );
    }
    return result.stdout;
  }
}

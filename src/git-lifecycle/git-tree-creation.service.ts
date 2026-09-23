import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import { GitLifecycleService, repoRoot } from "./git-command.service.ts";
import {
  managedWorktreeRoot,
  repoWorktreesHome,
  THRONE_PROJECT_DIR,
  type TreePath,
} from "./git-worktree.service.ts";
import {
  hydrateDependencies,
  type DependencyHydrationMode,
} from "./dependency-hydration.ts";

export interface CreatedTree {
  readonly treePath: TreePath;
  readonly dependencyHydration: DependencyHydrationMode;
  readonly tookOverLeftover: LeftoverTree;
}

export type LeftoverTree = "none" | "branch-without-worktree" | "worktree-on-branch";

@Injectable()
export class GitTreeCreationService {
  private readonly git: GitLifecycleService;

  constructor(
    @Inject(GitLifecycleService)
    git: GitLifecycleService = new GitLifecycleService(),
  ) {
    this.git = git;
  }

  async create(
    name: string,
    base?: string,
    projectDir: string = THRONE_PROJECT_DIR,
  ): Promise<CreatedTree> {
    const root = await repoRoot(projectDir);
    const baseRef =
      base ??
      (await this.git.run(["rev-parse", "HEAD"], projectDir)).stdout.trim();
    const [canonicalRoot, canonicalProject] = await Promise.all([
      realpath(root),
      realpath(projectDir),
    ]);
    const projectSubpath = path.relative(canonicalRoot, canonicalProject);
    const worktreeRoot = managedWorktreeRoot(canonicalRoot, name);
    const treeProjectDir = path.join(worktreeRoot, projectSubpath);
    await mkdir(repoWorktreesHome(canonicalRoot), { recursive: true });
    const leftover = await this.leftoverTree(name, worktreeRoot, canonicalRoot);
    if (leftover === "worktree-on-branch") {
      await this.fastForwardCleanLeftover(worktreeRoot, baseRef);
    } else if (leftover === "branch-without-worktree") {
      await this.git.run(["worktree", "add", worktreeRoot, name], canonicalRoot);
    } else {
      await this.git.run(
        ["worktree", "add", "-b", name, worktreeRoot, baseRef],
        canonicalRoot,
      );
    }
    try {
      const hydration = await hydrateDependencies(
        canonicalProject,
        treeProjectDir,
      );
      return {
        treePath: treeProjectDir,
        dependencyHydration: hydration.mode,
        tookOverLeftover: leftover,
      };
    } catch (error) {
      if (leftover === "none") {
        await this.git
          .run(["worktree", "remove", "--force", worktreeRoot], canonicalRoot)
          .catch(() => undefined);
        await this.git
          .run(["branch", "-D", name], canonicalRoot)
          .catch(() => undefined);
      }
      throw error;
    }
  }

  private async leftoverTree(
    name: string,
    worktreeRoot: string,
    canonicalRoot: string,
  ): Promise<LeftoverTree> {
    const branch = await this.git.status(
      ["show-ref", "--verify", "--quiet", `refs/heads/${name}`],
      canonicalRoot,
    );
    if (branch.code !== 0) return "none";
    await this.git.run(["worktree", "prune"], canonicalRoot);
    const listing = await this.git.run(
      ["worktree", "list", "--porcelain"],
      canonicalRoot,
    );
    const expectedRoot = await realpath(worktreeRoot).catch(() => worktreeRoot);
    const registeredOnBranch = listing.stdout
      .split("\n\n")
      .map((entry) => entry.split("\n"))
      .some(
        (lines) =>
          lines.includes(`worktree ${expectedRoot}`) &&
          lines.includes(`branch refs/heads/${name}`),
      );
    return registeredOnBranch ? "worktree-on-branch" : "branch-without-worktree";
  }

  private async fastForwardCleanLeftover(
    worktreeRoot: string,
    baseRef: string,
  ): Promise<void> {
    const changes = await this.git.run(["status", "--porcelain"], worktreeRoot);
    if (changes.stdout.trim() !== "") return;
    const behindBase = await this.git.status(
      ["merge-base", "--is-ancestor", "HEAD", baseRef],
      worktreeRoot,
    );
    if (behindBase.code !== 0) return;
    await this.git.run(["merge", "--ff-only", baseRef], worktreeRoot);
  }
}

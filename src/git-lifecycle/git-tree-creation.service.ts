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
}

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
    await this.git.run(
      ["worktree", "add", "-b", name, worktreeRoot, baseRef],
      canonicalRoot,
    );
    try {
      const hydration = await hydrateDependencies(
        canonicalProject,
        treeProjectDir,
      );
      return { treePath: treeProjectDir, dependencyHydration: hydration.mode };
    } catch (error) {
      await this.git
        .run(["worktree", "remove", "--force", worktreeRoot], canonicalRoot)
        .catch(() => undefined);
      await this.git
        .run(["branch", "-D", name], canonicalRoot)
        .catch(() => undefined);
      throw error;
    }
  }
}

import { access } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { RUNTIME_THRONE_ROOT } from '../shared-policy/runtime-throne-root.ts';
import { repoRoot, GitLifecycleService } from './git-command.service.ts';

export type TreePath = string;

export const THRONE_PROJECT_DIR = RUNTIME_THRONE_ROOT;

export function worktreesHome(): string {
  return process.env.THRONE_WORKTREES_HOME ?? path.join(homedir(), '.throne', 'worktrees');
}

export function repoWorktreesHome(canonicalRepoRoot: string): string {
  return path.join(worktreesHome(), path.basename(canonicalRepoRoot));
}

export function managedWorktreeRoot(
  canonicalRepoRoot: string,
  treeName: string,
): string {
  return path.join(repoWorktreesHome(canonicalRepoRoot), treeName);
}

/**
 * Resolves a path's real filesystem identity for comparison, tolerating
 * `/home` vs `/var/home`-style symlink spelling differences. Falls back to
 * the unresolved (`path.resolve`d) value when the path doesn't exist yet
 * (`fs.realpathSync` throws), preserving today's behavior for speculative
 * paths computed before their worktree is created.
 */
export function realIdentity(target: string): string {
  const resolved = path.resolve(target);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function treeNameFromPath(
  candidate: string,
  home: string = worktreesHome(),
): string | undefined {
  const relative = path.relative(realIdentity(home), realIdentity(candidate));
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }
  const segments = relative.split(path.sep);
  return segments.length >= 2 ? segments[1] : undefined;
}

export interface Worktree {
  path: string;
  branch?: string;
}

export function parseWorktreeList(porcelain: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let current: Worktree | undefined;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length).trim() };
      worktrees.push(current);
    } else if (line.startsWith('branch ') && current) {
      const ref = line.slice('branch '.length).trim();
      current.branch = ref.replace(/^refs\/heads\//, '');
    }
  }
  return worktrees.filter((worktree) => worktree.path.length > 0);
}

function commandStdout(result: { stdout: string } | string): string {
  return typeof result === 'string' ? result : result.stdout;
}

export class GitWorktreeService {
  private readonly git: GitLifecycleService;

  constructor(git = new GitLifecycleService()) {
    this.git = git;
  }

  async list(root: string): Promise<Worktree[]> {
    const result = await this.git.run(['worktree', 'list', '--porcelain'], root);
    return parseWorktreeList(commandStdout(result));
  }

  async remove(
    name: string,
    projectDir: string = THRONE_PROJECT_DIR,
  ): Promise<boolean> {
    const root = await repoRoot(projectDir);
    const match = (await this.list(root)).find((worktree) => worktree.branch === name);

    if (match === undefined) {
      await this.git.run(['worktree', 'prune'], root).catch(() => undefined);
      return false;
    }

    try {
      await access(match.path);
    } catch {
      await this.git.run(['worktree', 'prune'], root).catch(() => undefined);
      return true;
    }

    await this.git.run(['worktree', 'remove', '--force', match.path], root);
    await this.git.run(['worktree', 'prune'], root).catch(() => undefined);
    return true;
  }
}

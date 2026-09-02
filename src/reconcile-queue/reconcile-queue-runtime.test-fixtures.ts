import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const scratchRoot = path.join(homedir(), "tmp");
mkdirSync(scratchRoot, { recursive: true });

export function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

export function createRepo(): { repo: string; base: string; delivery: string } {
  const repo = mkdtempSync(path.join(scratchRoot, "reconcile-queue-git-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Queue Test");
  git(repo, "config", "user.email", "queue@example.invalid");
  execFileSync("sh", ["-c", "printf base > evidence.txt"], { cwd: repo });
  git(repo, "add", "evidence.txt");
  git(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  execFileSync("sh", ["-c", "printf delivered > evidence.txt"], { cwd: repo });
  git(repo, "commit", "-am", "Deliver alpha-rowdrift-fixture");
  return { repo, base, delivery: git(repo, "rev-parse", "HEAD") };
}

/** A repo shaped like the throne repository (`package.json` name "throne"
 * plus `src/tools.ts`) — the one repo the mainline-branch default applies to. */
export function createThroneShapedRepo(): string {
  const repo = mkdtempSync(path.join(scratchRoot, "reconcile-queue-throne-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Queue Test");
  git(repo, "config", "user.email", "queue@example.invalid");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  execFileSync(
    "sh",
    ["-c", 'printf "" > src/tools.ts; printf \'{"name":"throne"}\' > package.json'],
    { cwd: repo },
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "base");
  return repo;
}

export const emptyMirror = {
  verdict: "unknown" as const,
  deliveryCommit: null,
  targetRepo: null,
  targetBranch: null,
  treeIdentity: null,
  checkedAt: null,
  reason: null,
};

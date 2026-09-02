import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `git ${args.join(" ")} failed: ${stderr.trim() || error.message}`,
            ),
          );
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

export async function initRepo(root: string): Promise<void> {
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@throne.local"]);
  await git(root, ["config", "user.name", "Throne Test"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(root, "base.txt"), "base\n", "utf8");
  await git(root, ["add", "base.txt"]);
  await git(root, ["commit", "--no-gpg-sign", "-m", "base"]);
}

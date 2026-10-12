import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.join(import.meta.dirname, "..");

export async function readPinnedNodeVersion(): Promise<string> {
  return /node = "([^"]+)"/.exec(await readFile(path.join(REPO_ROOT, "mise.toml"), "utf8"))![1];
}

export function pinnedNodePath(home: string, version: string): string {
  return path.join(home, ".local", "share", "mise", "installs", "node", version, "bin", "node");
}

export async function provisionPinnedNode(throneRoot: string, home: string): Promise<void> {
  await mkdir(path.join(throneRoot, "bin"), { recursive: true });
  for (const pinnedFile of ["mise.toml", path.join("bin", "pinned-node-lib.sh")]) {
    await copyFile(path.join(REPO_ROOT, pinnedFile), path.join(throneRoot, pinnedFile));
  }
  await installPinnedNode(home);
}

export async function installPinnedNode(home: string): Promise<void> {
  const nodePath = pinnedNodePath(home, await readPinnedNodeVersion());
  await mkdir(path.dirname(nodePath), { recursive: true });
  await writeFile(nodePath, `#!/usr/bin/env bash\nexec ${process.execPath} "$@"\n`, { mode: 0o755 });
}

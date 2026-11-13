import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.join(import.meta.dirname, "..");

export async function readPinnedBunVersion(): Promise<string> {
  return /bun = "([^"]+)"/.exec(await readFile(path.join(REPO_ROOT, "mise.toml"), "utf8"))![1];
}

export function pinnedBunPath(home: string, version: string): string {
  return path.join(home, ".local", "share", "mise", "installs", "bun", version, "bin", "bun");
}

export async function installPinnedBun(home: string): Promise<void> {
  const bunPath = pinnedBunPath(home, await readPinnedBunVersion());
  await mkdir(path.dirname(bunPath), { recursive: true });
  const thisRuntime = [process.execPath, ...process.execArgv].map((word) => `'${word}'`).join(" ");
  await writeFile(bunPath, `#!/usr/bin/env bash\nexec ${thisRuntime} "$@"\n`, { mode: 0o755 });
}

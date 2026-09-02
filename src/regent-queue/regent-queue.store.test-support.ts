import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "regent-queue-store-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

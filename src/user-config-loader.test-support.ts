import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

export async function scratchUserConfig(
  t: TestContext,
  directoryPrefix: string,
  configSource: string | null,
): Promise<{ directory: string; configPath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), directoryPrefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "package.json"), '{"type":"module"}\n');
  const configPath = path.join(directory, "config.user.ts");
  if (configSource !== null) await writeFile(configPath, configSource);
  return { directory, configPath };
}

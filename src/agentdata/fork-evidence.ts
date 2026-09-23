import { listRegisteredAgentNames } from "../agent-statuses/agent-statuses-registry.ts";
import { DEFAULT_DATA_DIR, readSpawnSpec } from "./spawn-data-contracts.ts";

export async function listForkedAgentNames(
  baseDir: string = DEFAULT_DATA_DIR,
): Promise<ReadonlySet<string>> {
  const names = await listRegisteredAgentNames(baseDir);
  const forked = new Set<string>();
  for (const name of names) {
    const spec = await readSpawnSpec(name, baseDir);
    if (spec?.forked_from !== undefined) forked.add(name.toLowerCase());
  }
  return forked;
}

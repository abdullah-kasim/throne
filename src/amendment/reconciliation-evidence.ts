import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DATA_DIR, readSpawnSpec } from "../agentdata/spawn-data-contracts.ts";

export const PLAN_BUNDLE_PREFIX = "todo-";
export const PLAN_OVERVIEW_FILE = "00_overview.md";

export type ReconciliationEvidence =
  | { readonly kind: "not-a-queued-campaign" }
  | { readonly kind: "evidence-file"; readonly objectiveCode: string; readonly filePath: string }
  | { readonly kind: "no-plan-yet"; readonly objectiveCode: string; readonly ledger: string };

export async function readEvidenceText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

export async function latestPlanBundle(ledger: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(ledger);
  } catch {
    return undefined;
  }
  return entries
    .filter((entry) => entry.startsWith(PLAN_BUNDLE_PREFIX))
    .sort()
    .at(-1);
}

export async function locateReconciliationEvidence(
  agentName: string,
  dataDir: string = DEFAULT_DATA_DIR,
): Promise<ReconciliationEvidence> {
  const spawn = await readSpawnSpec(agentName, dataDir);
  const objectiveCode = spawn?.objective_code;
  if (typeof objectiveCode !== "string" || objectiveCode === "") {
    return { kind: "not-a-queued-campaign" };
  }
  const ledger = path.join(dataDir, agentName);
  const bundle = await latestPlanBundle(ledger);
  if (bundle === undefined) return { kind: "no-plan-yet", objectiveCode, ledger };
  return {
    kind: "evidence-file",
    objectiveCode,
    filePath: path.join(ledger, bundle, PLAN_OVERVIEW_FILE),
  };
}

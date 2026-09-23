import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DATA_DIR } from "../agentdata/spawn-data-contracts.ts";
import {
  activePlanPresetName,
  modelPairInPool,
  planRolePool,
  type ModelPair,
  type PlanPresetName,
} from "../config.ts";
import {
  EVERY_CAMPAIGN_RECIPIENT,
  type DurableBypassAuthorizationRegistry,
} from "./durable-bypass-authorization.ts";

export const MODEL_BYPASS_REGISTRY_FILE_NAME = "bypass-model-authorizations.json";
export const USAGE_BYPASS_REGISTRY_FILE_NAME = "bypass-usage-authorizations.json";
const FILED_AUTHORIZATION_LIFETIME_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;

export function modelHintNeedsBypassAuthorization(
  modelHint: ModelPair | undefined,
  preset: PlanPresetName = activePlanPresetName(),
): modelHint is ModelPair {
  return (
    modelHint !== undefined &&
    !modelPairInPool(planRolePool("Alpha", preset), modelHint)
  );
}

async function readRegistryOrEmpty(
  file: string,
): Promise<DurableBypassAuthorizationRegistry> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, authorizations: [] };
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<DurableBypassAuthorizationRegistry>;
  if (parsed.version !== 1 || !Array.isArray(parsed.authorizations)) {
    throw new Error(`${file} is not a version 1 authorization registry; left untouched`);
  }
  return parsed as DurableBypassAuthorizationRegistry;
}

async function recordInRegistry(opts: {
  file: string;
  objectiveCode: string;
  evidenceLocator: string;
  expiresAt: string;
}): Promise<void> {
  const registry = await readRegistryOrEmpty(opts.file);
  const otherEntries = registry.authorizations.filter(
    (entry) =>
      !(
        entry.objective_code === opts.objectiveCode &&
        entry.recipient === EVERY_CAMPAIGN_RECIPIENT
      ),
  );
  const updated: DurableBypassAuthorizationRegistry = {
    version: 1,
    authorizations: [
      ...otherEntries,
      {
        authorizer: "Lord",
        objective_code: opts.objectiveCode,
        recipient: EVERY_CAMPAIGN_RECIPIENT,
        evidence_locator: opts.evidenceLocator,
        expires_at: opts.expiresAt,
      },
    ],
  };
  await mkdir(path.dirname(opts.file), { recursive: true });
  const pendingFile = `${opts.file}.${process.pid}.pending`;
  await writeFile(pendingFile, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  await rename(pendingFile, opts.file);
}

export async function recordFiledModelHintAuthorizations(opts: {
  objectiveCode: string;
  queueItemId: string;
  modelHint: ModelPair;
  now: number;
  dataDir?: string;
}): Promise<void> {
  const regentDir = path.join(opts.dataDir ?? DEFAULT_DATA_DIR, "regent");
  const evidenceLocator =
    `regent-queue row ${opts.queueItemId} (objective ${opts.objectiveCode}) ` +
    `filed by a Stager on the Lord's word with --model-hint ` +
    `${opts.modelHint.harness}/${opts.modelHint.model}; RULINGS in the row body`;
  const expiresAt = new Date(
    opts.now + FILED_AUTHORIZATION_LIFETIME_MILLISECONDS,
  ).toISOString();
  for (const fileName of [
    MODEL_BYPASS_REGISTRY_FILE_NAME,
    USAGE_BYPASS_REGISTRY_FILE_NAME,
  ]) {
    await recordInRegistry({
      file: path.join(regentDir, fileName),
      objectiveCode: opts.objectiveCode,
      evidenceLocator,
      expiresAt,
    });
  }
}

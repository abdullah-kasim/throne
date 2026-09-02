import { readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DATA_DIR } from "./legacy-spawn-data-contracts.ts";
import type { ModelPair, ModelPairPool } from "../config.ts";
import type { ObjectiveContract } from "../shared-policy/objective-contract.ts";

const ALLOWLIST_VERSION = 1;
export const MODEL_ALLOWLIST_FILE_NAME = "model-allowlist.json";

interface ModelAllowlistFile {
  version: 1;
  pairs: ModelPairPool;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isAllowlistedModelPair(value: unknown): value is ModelPair {
  if (typeof value !== "object" || value === null) return false;
  const pair = value as Record<string, unknown>;
  return (
    isNonEmptyString(pair.harness) &&
    isNonEmptyString(pair.model) &&
    Object.keys(pair).every((key) => ["harness", "model"].includes(key))
  );
}

function isModelAllowlistFile(value: unknown): value is ModelAllowlistFile {
  if (typeof value !== "object" || value === null) return false;
  const file = value as Record<string, unknown>;
  return (
    file.version === ALLOWLIST_VERSION &&
    Array.isArray(file.pairs) &&
    file.pairs.every(isAllowlistedModelPair) &&
    Object.keys(file).every((key) => ["version", "pairs"].includes(key))
  );
}

export async function readModelAllowlist(
  ownerAlphaName: string,
  dataDir: string = DEFAULT_DATA_DIR,
): Promise<ModelPairPool | undefined> {
  let parsed: unknown;
  try {
    const raw = await readFile(
      path.join(dataDir, ownerAlphaName, MODEL_ALLOWLIST_FILE_NAME),
      "utf8",
    );
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isModelAllowlistFile(parsed) || parsed.pairs.length === 0) {
    return undefined;
  }
  return parsed.pairs;
}

export function modelAllowlistOwner(opts: {
  role: string;
  name: string;
  supervisor: string | undefined;
  objectiveContract: ObjectiveContract | undefined;
}): string | undefined {
  if (opts.objectiveContract?.kind !== "campaign") return undefined;
  const role = opts.role.trim().toLowerCase();
  if (role === "alpha") return opts.name;
  if (role === "shadow") return opts.supervisor;
  return undefined;
}

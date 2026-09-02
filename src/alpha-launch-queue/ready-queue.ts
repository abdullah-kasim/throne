import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { QueuedAlphaCandidate } from "../keep-going/alpha-capacity.ts";
import type { ModelPair } from "../config.ts";

/**
 * On-disk ready-queue contract: one JSON file per candidate directly under
 * the queue directory (never one giant prose file whose markers go stale).
 * Only files ending in `.json` are read as entries; anything else present
 * is ignored. Each file's top-level object extends `QueuedAlphaCandidate`
 * (`name`, `target`, `dependencyReady`, `executableWork`) with what
 * `create-agent` needs to actually launch the candidate: `harness`,
 * `model`, `objectiveCode`, `targetRepo`, `targetBranch`, `baseCommit`, and
 * the exact queue-body `objective` payload.
 */
export interface LaunchQueueCandidate extends QueuedAlphaCandidate {
  readonly harness: string;
  readonly model: string;
  readonly objectiveCode: string;
  readonly targetRepo: string;
  readonly targetBranch: string;
  readonly baseCommit: string;
  readonly objective: string;
  readonly modelHint?: ModelPair | null;
  /** When set, targetBranch is a PR branch: spawn-git-tree creates it at baseCommit
   *  (forked from this mainline branch) if it does not exist locally yet. */
  readonly createTargetFromBranch?: string;
}

export type ReadyQueueResult =
  | { readonly state: "candidates"; readonly candidates: LaunchQueueCandidate[] }
  | { readonly state: "positively-empty" }
  | { readonly state: "ineligible"; readonly reasons: string[] }
  | { readonly state: "unknown"; readonly reason: string };

function isLaunchQueueCandidate(value: unknown): value is LaunchQueueCandidate {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    record.name !== "" &&
    typeof record.target === "string" &&
    record.target !== "" &&
    typeof record.dependencyReady === "boolean" &&
    typeof record.executableWork === "boolean" &&
    typeof record.harness === "string" &&
    record.harness !== "" &&
    typeof record.model === "string" &&
    record.model !== "" &&
    typeof record.objectiveCode === "string" &&
    record.objectiveCode !== "" &&
    typeof record.targetRepo === "string" &&
    record.targetRepo !== "" &&
    typeof record.targetBranch === "string" &&
    record.targetBranch !== "" &&
    typeof record.baseCommit === "string" &&
    record.baseCommit !== "" &&
    typeof record.objective === "string" &&
    record.objective !== ""
  );
}

/**
 * Reads the ready-queue directory as a tri-state result: `candidates` (one
 * or more valid pre-briefed entries), `positively-empty` (the directory
 * exists, is readable, and has zero `.json` entries), or `unknown` (the
 * directory is missing/unreadable, or ANY present entry fails to parse or
 * validate). A single malformed entry makes the whole read `unknown` — a
 * partial list that silently dropped a bad entry would be indistinguishable
 * from a broken parser reporting "queue empty".
 */
export async function readReadyQueue(queueDir: string): Promise<ReadyQueueResult> {
  let filenames: string[];
  try {
    filenames = (await readdir(queueDir)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    return {
      state: "unknown",
      reason: `ready-queue directory "${queueDir}" is unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (filenames.length === 0) {
    return { state: "positively-empty" };
  }
  const candidates: LaunchQueueCandidate[] = [];
  for (const filename of filenames) {
    const filePath = path.join(queueDir, filename);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      return {
        state: "unknown",
        reason: `ready-queue entry "${filePath}" is unparseable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (!isLaunchQueueCandidate(parsed)) {
      return {
        state: "unknown",
        reason: `ready-queue entry "${filePath}" does not match the launch-candidate contract`,
      };
    }
    candidates.push(parsed);
  }
  return { state: "candidates", candidates };
}

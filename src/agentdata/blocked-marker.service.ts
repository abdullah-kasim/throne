import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { LedgerDataService } from "./ledger-data.service.ts";

const ledgerData = new LedgerDataService();

export type BlockedMarkerOrigin = "agent" | "regent";

export interface BlockedMarker {
  blockedAt: string;
  reason?: string;
  origin?: BlockedMarkerOrigin;
  // The child agent name(s) this block names, parsed from the agent's own
  // `__BLOCKED_BY_<name>__` marker(s) at first observation. Durable: this
  // list is the record the no-idling sweep checks against ledger truth on
  // every later sweep, never re-derived from a fresh pane read.
  blockedBy?: readonly string[];
}

function blockedMarkerPath(name: string, baseDir?: string): string {
  const dir = baseDir === undefined ? ledgerData.agentDir(name) : path.join(baseDir, name);
  return path.join(dir, "blocked.json");
}

function isBlockedMarker(value: unknown): value is BlockedMarker {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.blockedAt !== "string") return false;
  if (record.reason !== undefined && typeof record.reason !== "string") return false;
  if (record.origin !== undefined && record.origin !== "agent" && record.origin !== "regent") {
    return false;
  }
  return (
    record.blockedBy === undefined ||
    (Array.isArray(record.blockedBy) &&
      record.blockedBy.every((entry) => typeof entry === "string"))
  );
}

export async function writeBlockedMarker(
  name: string,
  opts?: { reason?: string; origin?: BlockedMarkerOrigin; blockedBy?: readonly string[] },
  baseDir?: string,
): Promise<void> {
  const marker: BlockedMarker = {
    blockedAt: new Date().toISOString(),
    ...(opts?.reason === undefined ? {} : { reason: opts.reason }),
    ...(opts?.origin === undefined ? {} : { origin: opts.origin }),
    ...(opts?.blockedBy === undefined ? {} : { blockedBy: opts.blockedBy }),
  };
  await writeFile(
    blockedMarkerPath(name, baseDir),
    JSON.stringify(marker),
    "utf8",
  );
}

export async function readBlockedMarker(
  name: string,
  baseDir?: string,
): Promise<BlockedMarker | null> {
  let contents: string;
  try {
    contents = await readFile(blockedMarkerPath(name, baseDir), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  return isBlockedMarker(parsed) ? parsed : null;
}

export async function clearBlockedMarker(
  name: string,
  baseDir?: string,
): Promise<void> {
  try {
    await rm(blockedMarkerPath(name, baseDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

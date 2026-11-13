import { statfs } from "node:fs/promises";
import path from "node:path";
import {
  SCRATCH_DIR_REMOVAL_OUTCOMES,
  type ScratchDirRemovalOutcome,
} from "../tmp-scratch-lifecycle/tmp-scratch-lifecycle.types.ts";

const RANDOM_SUFFIX = /[-._][A-Za-z0-9]{6}$|[-._]\d+$/;

export interface RootUse {
  inodesInUse: number;
  bytesInUse: number;
}

export interface UnreadableRoot {
  errorCode: string;
}

export interface MeasuredEntry {
  entryPath: string;
  outcome: ScratchDirRemovalOutcome;
}

export function familyOfEntryName(name: string): string {
  const family = name.replace(RANDOM_SUFFIX, "");
  return family === "" ? name : family;
}

export async function readRootUseAfterSweep(root: string): Promise<RootUse | UnreadableRoot> {
  try {
    return await readRootUse(root);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "UNKNOWN";
    return { errorCode: code };
  }
}

export async function readRootUse(root: string): Promise<RootUse> {
  const filesystem = await statfs(root);
  return {
    inodesInUse: filesystem.files - filesystem.ffree,
    bytesInUse: (filesystem.blocks - filesystem.bfree) * filesystem.bsize,
  };
}

function countsByFamily(entries: MeasuredEntry[]): Map<string, Map<string, number>> {
  const families = new Map<string, Map<string, number>>();
  for (const entry of entries) {
    const family = familyOfEntryName(path.basename(entry.entryPath));
    const counts = families.get(family) ?? new Map<string, number>();
    counts.set(entry.outcome, (counts.get(entry.outcome) ?? 0) + 1);
    families.set(family, counts);
  }
  return families;
}

function countLabel(outcome: ScratchDirRemovalOutcome, apply: boolean): string {
  return outcome === SCRATCH_DIR_REMOVAL_OUTCOMES.REMOVED && !apply ? "would-remove" : outcome;
}

function renderCounts(counts: Map<string, number>, apply: boolean): string {
  return Object.values(SCRATCH_DIR_REMOVAL_OUTCOMES)
    .filter((outcome) => counts.has(outcome))
    .map((outcome) => `${countLabel(outcome, apply)} ${counts.get(outcome)}`)
    .join(", ");
}

function renderRootUse(use: RootUse | UnreadableRoot): string {
  if ("errorCode" in use) return `unreadable (${use.errorCode})`;
  return `${use.inodesInUse} inodes, ${use.bytesInUse} bytes in use`;
}

export function renderMeasure(
  root: string,
  entries: MeasuredEntry[],
  apply: boolean,
  before: RootUse,
  after: RootUse | UnreadableRoot,
): string[] {
  const families = [...countsByFamily(entries)].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return [
    ...families.map(([family, counts]) => `measure ${family}: ${renderCounts(counts, apply)}`),
    `measure ${root} before: ${renderRootUse(before)}`,
    `measure ${root} after: ${renderRootUse(after)}`,
  ];
}

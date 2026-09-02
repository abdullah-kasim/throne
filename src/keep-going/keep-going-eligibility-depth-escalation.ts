// Tracks how long the eligibility-depth shortfall condition (depth<4 with a
// nonempty backlog) has held continuously, so the tick can escalate to the
// Lord only past 6h of sustained shortfall. Mirrors
// `outage-marker.store.ts`'s file-per-concern pattern: one small durable
// marker recording a first-seen timestamp, cleared the instant the
// condition stops holding. The clock is injected -- no bare `Date.now()` --
// so tests can pin exact elapsed durations.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNTIME_DATA_DIR } from "../shared-policy/runtime-data-home.ts";

/** The durable marker read/write surface, for injecting a fake in tests. */
export interface EligibilityDepthShortfallMarkerStore {
  readEligibilityDepthShortfallMarker(): Promise<number | undefined>;
  writeEligibilityDepthShortfallMarker(sinceMs: number | undefined): Promise<void>;
}

interface EligibilityDepthShortfallMarkerFile {
  readonly sinceMs: number;
}

export function eligibilityDepthShortfallMarkerPath(
  dataDir: string = RUNTIME_DATA_DIR,
): string {
  return path.join(dataDir, "keep-going-eligibility-depth-shortfall-marker.json");
}

export function openEligibilityDepthShortfallMarkerStore(
  filePath: string = eligibilityDepthShortfallMarkerPath(),
): EligibilityDepthShortfallMarkerStore {
  return {
    async readEligibilityDepthShortfallMarker(): Promise<number | undefined> {
      let contents: string;
      try {
        contents = await readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      const parsed = JSON.parse(contents) as EligibilityDepthShortfallMarkerFile;
      return parsed.sinceMs;
    },
    async writeEligibilityDepthShortfallMarker(
      sinceMs: number | undefined,
    ): Promise<void> {
      if (sinceMs === undefined) {
        await rm(filePath, { force: true });
        return;
      }
      await mkdir(path.dirname(filePath), { recursive: true });
      const marker: EligibilityDepthShortfallMarkerFile = { sinceMs };
      await writeFile(filePath, JSON.stringify(marker));
    },
  };
}

/**
 * Records one tick's reading of the shortfall condition against the durable
 * marker and returns the timestamp the condition has held continuously
 * since (`undefined` if it does not currently hold). The first `true`
 * reading stamps `nowMs`; subsequent `true` readings leave that timestamp
 * unchanged; a `false` reading clears the marker.
 */
export async function recordEligibilityDepthShortfallReading(
  store: EligibilityDepthShortfallMarkerStore,
  conditionHolds: boolean,
  nowMs: number,
): Promise<number | undefined> {
  if (!conditionHolds) {
    await store.writeEligibilityDepthShortfallMarker(undefined);
    return undefined;
  }
  const existingSinceMs = await store.readEligibilityDepthShortfallMarker();
  if (existingSinceMs !== undefined) return existingSinceMs;
  await store.writeEligibilityDepthShortfallMarker(nowMs);
  return nowMs;
}

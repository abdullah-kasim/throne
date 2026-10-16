import { readSpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import {
  SPAWN_STARTING_BOUND_MS,
  isSpawnStillStarting,
} from "../agentdata/spawn-starting.ts";
import { spawnedAtAgeMs } from "../no-idling/idle-family.ts";
import { FORCE_FLAG, SPAWN_PROCESS_GONE_FLAG } from "./input.ts";
import type { ReapDeps, ReapRequest } from "./reap-agent.types.ts";

function currentTimeMs(deps: ReapDeps): number {
  return deps.now === undefined ? Date.now() : Date.parse(deps.now());
}

function wholeSeconds(milliseconds: number): number {
  return Math.round(milliseconds / 1000);
}

export async function refuseReapOfStartingSpawn(
  request: ReapRequest,
  deps: ReapDeps,
): Promise<boolean> {
  if (request.spawnProcessGone === true) {
    return false;
  }
  const spec = await (deps.readSpawnSpec ?? readSpawnSpec)(request.name);
  const nowMs = currentTimeMs(deps);
  if (!isSpawnStillStarting(spec, nowMs)) {
    return false;
  }
  const ageMs = spawnedAtAgeMs(spec?.spawned_at, nowMs) ?? 0;
  process.stderr.write(
    `reap-agent: refusing to reap "${request.name}" — its spawn is still starting ` +
      `(${wholeSeconds(ageMs)} s since spawn, no opening prompt recorded yet; a spawn ` +
      `counts as starting for ${wholeSeconds(SPAWN_STARTING_BOUND_MS)} s). An empty ` +
      `composer is not a failed launch. ${FORCE_FLAG} does not override this; pass ` +
      `${SPAWN_PROCESS_GONE_FLAG} only when its create-agent process is gone. ` +
      `Nothing was torn down.\n`,
  );
  return true;
}

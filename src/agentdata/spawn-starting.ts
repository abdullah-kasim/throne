import { spawnedAtAgeMs } from "../no-idling/idle-family.ts";
import type { SpawnSpec } from "./spawn-data-contracts.ts";

export const SPAWN_STARTING_BOUND_MS = 300_000;

function spawnIsRunning(spec: SpawnSpec): boolean {
  return spec.spawn_finished_at === null;
}

function openingPromptWasTasked(spec: SpawnSpec): boolean {
  return typeof spec.tasked_at === "string";
}

function spawnIsYoungerThanStartingBound(spec: SpawnSpec, nowMs: number): boolean {
  const ageMs = spawnedAtAgeMs(spec.spawned_at, nowMs);
  return ageMs !== undefined && ageMs < SPAWN_STARTING_BOUND_MS;
}

export function isSpawnStillStarting(spec: SpawnSpec | null, nowMs: number): boolean {
  return (
    spec !== null &&
    spawnIsRunning(spec) &&
    !openingPromptWasTasked(spec) &&
    spawnIsYoungerThanStartingBound(spec, nowMs)
  );
}

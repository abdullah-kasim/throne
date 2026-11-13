import type { SpawnSpec } from "./spawn-data-contracts.ts";

export const SPAWN_STARTING_BOUND_MS = 300_000;
export const AGENT_MIN_AGE_MS = 90_000;

export function spawnedAtAgeMs(
  spawnedAt: string | undefined,
  nowMs: number,
): number | undefined {
  if (spawnedAt === undefined) return undefined;
  const spawnedAtMs = Date.parse(spawnedAt);
  return Number.isNaN(spawnedAtMs) ? undefined : nowMs - spawnedAtMs;
}

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

function isYoungerThanMinimumAge(timestamp: string | null | undefined, nowMs: number): boolean {
  const ageMs = spawnedAtAgeMs(timestamp ?? undefined, nowMs);
  return ageMs !== undefined && ageMs < AGENT_MIN_AGE_MS;
}

export function isWithinSpawnGrace(spec: SpawnSpec | null, nowMs: number): boolean {
  return (
    isYoungerThanMinimumAge(spec?.spawned_at, nowMs) ||
    isYoungerThanMinimumAge(spec?.spawn_finished_at, nowMs) ||
    isSpawnStillStarting(spec, nowMs)
  );
}

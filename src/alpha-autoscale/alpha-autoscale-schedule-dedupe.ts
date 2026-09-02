import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { RUNTIME_DATA_DIR } from "../shared-policy/runtime-data-home.ts";

export const ALPHA_AUTOSCALE_SPAWN_INTERVAL_MS = 10 * 60 * 1000;

interface AlphaAutoscaleSpawnState {
  readonly lastSuccessfulSpawnAtMs: number;
}

export type AlphaAutoscaleCooldownStatus =
  | { readonly elapsed: true }
  | { readonly elapsed: false; readonly reason: string };

export function alphaAutoscaleSpawnStatePath(
  dataDir: string = RUNTIME_DATA_DIR,
): string {
  return path.join(dataDir, "regent", "alpha-autoscale-last-spawn.json");
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function parseSpawnState(bytes: string): AlphaAutoscaleSpawnState | undefined {
  const parsed = JSON.parse(bytes) as unknown;
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const timestamp = (parsed as Record<string, unknown>).lastSuccessfulSpawnAtMs;
  if (!Number.isSafeInteger(timestamp) || (timestamp as number) < 0)
    return undefined;
  return { lastSuccessfulSpawnAtMs: timestamp as number };
}

export function readAlphaAutoscaleCooldown(
  nowMs: number = Date.now(),
  statePath: string = alphaAutoscaleSpawnStatePath(),
): AlphaAutoscaleCooldownStatus {
  let bytes: string;
  try {
    bytes = readFileSync(statePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { elapsed: true };
    return {
      elapsed: false,
      reason: `Alpha spawn limiter state is unreadable at ${statePath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let state: AlphaAutoscaleSpawnState | undefined;
  try {
    state = parseSpawnState(bytes);
  } catch {
    state = undefined;
  }
  if (state === undefined) {
    return {
      elapsed: false,
      reason: `Alpha spawn limiter state is malformed at ${statePath}`,
    };
  }
  if (state.lastSuccessfulSpawnAtMs > nowMs) {
    return {
      elapsed: false,
      reason: `Alpha spawn limiter state is from the future at ${statePath}: ${state.lastSuccessfulSpawnAtMs} > ${nowMs}`,
    };
  }
  const elapsedMs = nowMs - state.lastSuccessfulSpawnAtMs;
  if (elapsedMs < ALPHA_AUTOSCALE_SPAWN_INTERVAL_MS) {
    return {
      elapsed: false,
      reason: `Alpha spawn cooldown has ${ALPHA_AUTOSCALE_SPAWN_INTERVAL_MS - elapsedMs}ms remaining`,
    };
  }
  return { elapsed: true };
}

export function recordSuccessfulAlphaAutoscaleSpawn(
  spawnedAtMs: number = Date.now(),
  statePath: string = alphaAutoscaleSpawnStatePath(),
): void {
  if (!Number.isSafeInteger(spawnedAtMs) || spawnedAtMs < 0) {
    throw new Error(
      `Alpha spawn timestamp must be a non-negative safe integer, got ${spawnedAtMs}`,
    );
  }
  const directory = path.dirname(statePath);
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ lastSuccessfulSpawnAtMs: spawnedAtMs }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    renameSync(temporaryPath, statePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

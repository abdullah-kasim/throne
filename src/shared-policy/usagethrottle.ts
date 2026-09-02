import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  readHarnessUsage,
  type UsagePayloadLike,
} from "../harness-routing/policy/usage.ts";
import { UsageReadersService } from "./usage-readers.service.ts";
import { realPlanUsageRemainingService } from "../plan-usage-remaining/plan-usage-remaining.service.ts";
import { REGENT_DIR } from "../regent-state/regent-state.service.ts";
import { readRegentRoute, type RegentRoute } from "../regent-state/regent-state.service.ts";
import { HARNESSES, HARNESS_NAMES, type Harness } from "../harness-routing/harness.ts";
import { registryEntry } from "../harness-routing/model-registry.ts";

const REAL_USAGE_READERS = new UsageReadersService(
  undefined,
  undefined,
  realPlanUsageRemainingService(),
);

export type ThrottleBandName = "NORMAL" | "CAUTION" | "LOW" | "CRITICAL";

export interface ThrottleBand {
  name: ThrottleBandName;
  order: number;
  enterAtOrBelow: number;
  exitAbove: number;
  minIntervalMs: number;
  advisory: string;
}

export const THROTTLE_BANDS: readonly ThrottleBand[] = [
  {
    name: "NORMAL",
    order: 0,
    enterAtOrBelow: Infinity,
    exitAbove: -Infinity,
    minIntervalMs: 0,
    advisory: "",
  },
  {
    name: "CAUTION",
    order: 1,
    enterAtOrBelow: 25,
    exitAbove: 30,
    minIntervalMs: 55 * 60 * 1000,
    advisory: "pace to ≤2 concurrent Alphas",
  },
  {
    name: "LOW",
    order: 2,
    enterAtOrBelow: 10,
    exitAbove: 15,
    minIntervalMs: 115 * 60 * 1000,
    advisory: "hold to ≤1 new Alpha at a time",
  },
  {
    name: "CRITICAL",
    order: 3,
    enterAtOrBelow: 5,
    exitAbove: 10,
    minIntervalMs: 235 * 60 * 1000,
    advisory:
      "run exactly ONE objective serially; work continues at reduced cadence — do NOT halt dispatch",
  },
];

export const THROTTLE_STATE_BASENAME = "throttle-state.json";

export type ThrottleSignal =
  | {
      driverHarness: Harness;
      status: "fresh";
      keyPct: number;
    }
  | {
      driverHarness: Harness;
      status: "unavailable";
      keyPct: null;
    }
  | {
      driverHarness: string;
      status: "unsupported";
      keyPct: null;
    }
  | {
      driverHarness: null;
      status: "unknown";
      keyPct: null;
    };

export interface ThrottleState {
  band: ThrottleBandName;
  lastNudgeAt: string | null;
  signal?: ThrottleSignal;
}

export interface ThrottleEvaluation {
  band: ThrottleBand;
  shouldNudge: boolean;
  signal: ThrottleSignal;
}

export interface ThrottleDeps {
  readThrottleState: (dir: string) => Promise<ThrottleState>;
  writeThrottleState: (state: ThrottleState, dir: string) => Promise<void>;
  getClaudeUsagePayload: () => Promise<UsagePayloadLike>;
  getCodexUsagePayload: () => Promise<UsagePayloadLike>;
  getOpenCodeGoUsagePayload: () => Promise<UsagePayloadLike>;
  readRegentRoute: (dir: string) => Promise<RegentRoute | undefined>;
  now: () => Date;
  regentDir: string;
}

function defaultThrottleState(): ThrottleState {
  return {
    band: "NORMAL",
    lastNudgeAt: null,
    signal: { driverHarness: null, status: "unknown", keyPct: null },
  };
}

function isThrottleBandName(value: unknown): value is ThrottleBandName {
  return THROTTLE_BANDS.some((band) => band.name === value);
}

function isSupportedThrottleHarness(value: string): value is Harness {
  return HARNESSES.some((harness) => harness === value);
}

function isLastNudgeAt(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && !Number.isNaN(Date.parse(value)))
  );
}

function isThrottleSignal(value: unknown): value is ThrottleSignal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.status === "fresh") {
    return (
      typeof candidate.driverHarness === "string" &&
      isSupportedThrottleHarness(candidate.driverHarness) &&
      typeof candidate.keyPct === "number" &&
      Number.isFinite(candidate.keyPct)
    );
  }
  if (candidate.status === "unavailable") {
    return (
      typeof candidate.driverHarness === "string" &&
      isSupportedThrottleHarness(candidate.driverHarness) &&
      candidate.keyPct === null
    );
  }
  if (candidate.status === "unsupported") {
    return (
      typeof candidate.driverHarness === "string" &&
      !isSupportedThrottleHarness(candidate.driverHarness) &&
      candidate.keyPct === null
    );
  }
  return (
    candidate.status === "unknown" &&
    candidate.driverHarness === null &&
    candidate.keyPct === null
  );
}

function normalizeThrottleState(value: unknown): ThrottleState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return defaultThrottleState();
  }
  const candidate = value as Record<string, unknown>;
  if (
    !isThrottleBandName(candidate.band) ||
    !isLastNudgeAt(candidate.lastNudgeAt)
  ) {
    return defaultThrottleState();
  }
  if (candidate.signal === undefined) {
    return {
      band: candidate.band,
      lastNudgeAt: candidate.lastNudgeAt,
    };
  }
  if (!isThrottleSignal(candidate.signal)) {
    return defaultThrottleState();
  }
  if (candidate.signal.status === "unknown") {
    return defaultThrottleState();
  }
  return {
    band: candidate.band,
    lastNudgeAt: candidate.lastNudgeAt,
    signal: candidate.signal,
  };
}

function bandByName(name: ThrottleBandName): ThrottleBand {
  const band = THROTTLE_BANDS.find((candidate) => candidate.name === name);
  if (band === undefined) {
    throw new Error(`unknown throttle band: ${name}`);
  }
  return band;
}

export function usageKey(payload: UsagePayloadLike): number | null {
  const usage = readHarnessUsage(payload);
  if (!usage.ok || usage.weeklyPct === undefined) {
    return null;
  }
  return usage.sessionPct === undefined
    ? usage.weeklyPct
    : Math.min(usage.weeklyPct, usage.sessionPct);
}

export function computeBand(
  prev: ThrottleBandName,
  key: number | null,
): ThrottleBandName {
  if (key === null) {
    return prev;
  }

  const previousBand = bandByName(prev);
  let deteriorated: ThrottleBand | undefined;
  for (const candidate of THROTTLE_BANDS) {
    if (
      candidate.order > previousBand.order &&
      key <= candidate.enterAtOrBelow
    ) {
      deteriorated = candidate;
    }
  }
  if (deteriorated !== undefined) {
    return deteriorated.name;
  }

  let recovered = previousBand;
  while (recovered.order > 0 && key > recovered.exitAbove) {
    recovered = THROTTLE_BANDS[recovered.order - 1]!;
  }
  return recovered.name;
}

export async function readThrottleState(
  dir: string = REGENT_DIR,
): Promise<ThrottleState> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(dir, THROTTLE_STATE_BASENAME), "utf8"),
    );
    return normalizeThrottleState(parsed);
  } catch {
    return defaultThrottleState();
  }
}

export async function writeThrottleState(
  state: ThrottleState,
  dir: string = REGENT_DIR,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, THROTTLE_STATE_BASENAME),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
}

export const REAL_DEPS: ThrottleDeps = {
  readThrottleState,
  writeThrottleState,
  getClaudeUsagePayload: REAL_USAGE_READERS.claude,
  getCodexUsagePayload: REAL_USAGE_READERS.codex,
  getOpenCodeGoUsagePayload: REAL_USAGE_READERS.opencodeGo,
  readRegentRoute,
  now: () => new Date(),
  regentDir: REGENT_DIR,
};

export async function evaluateThrottle(
  regentHarness: string,
  deps: ThrottleDeps = REAL_DEPS,
): Promise<ThrottleEvaluation> {
  if (typeof regentHarness !== "string") {
    throw new TypeError("Regent harness label must be a string");
  }

  let stateReadFailed = false;
  let state: ThrottleState;
  try {
    state = await deps.readThrottleState(deps.regentDir);
  } catch {
    stateReadFailed = true;
    state = defaultThrottleState();
  }

  const now = deps.now();
  let exactRoute: RegentRoute | undefined;
  try {
    exactRoute = await deps.readRegentRoute(deps.regentDir);
  } catch {
    exactRoute = undefined;
  }
  const routeDriverHarness = exactRoute === undefined
    ? regentHarness
    : registryEntry(exactRoute.model)?.harness;
  if (routeDriverHarness === undefined || !isSupportedThrottleHarness(routeDriverHarness)) {
    const signal: ThrottleSignal = {
      driverHarness: routeDriverHarness ?? regentHarness,
      status: "unsupported",
      keyPct: null,
    };
    try {
      await deps.writeThrottleState(
        {
          band: "NORMAL",
          lastNudgeAt: now.toISOString(),
          signal,
        },
        deps.regentDir,
      );
    } catch {
      return { band: bandByName("NORMAL"), shouldNudge: true, signal };
    }
    return { band: bandByName("NORMAL"), shouldNudge: true, signal };
  }

  const usageSource =
    routeDriverHarness === HARNESS_NAMES.CLAUDE
      ? deps.getClaudeUsagePayload
      : routeDriverHarness === HARNESS_NAMES.OPENCODE
        ? deps.getOpenCodeGoUsagePayload
        : deps.getCodexUsagePayload;

  const stateMatchesHarness =
    state.signal?.driverHarness === routeDriverHarness &&
    (state.signal.status === "fresh" || state.signal.status === "unavailable");
  const previousBand = stateMatchesHarness ? state.band : "NORMAL";
  const previousLastNudgeAt = stateMatchesHarness ? state.lastNudgeAt : null;

  let signal: ThrottleSignal = {
    driverHarness: routeDriverHarness,
    status: "unavailable",
    keyPct: null,
  };
  try {
    const keyPct = usageKey(await usageSource());
    if (keyPct !== null) {
      signal = {
        driverHarness: routeDriverHarness,
        status: "fresh",
        keyPct,
      };
    }
  } catch {
    signal = {
      driverHarness: routeDriverHarness,
      status: "unavailable",
      keyPct: null,
    };
  }

  const band = bandByName(computeBand(previousBand, signal.keyPct));
  const shouldNudgeForInterval =
    previousLastNudgeAt === null ||
    now.getTime() - Date.parse(previousLastNudgeAt) >= band.minIntervalMs;
  const shouldSuppressExactZeroNudge =
    !stateReadFailed &&
    exactRoute !== undefined &&
    signal.status === "fresh" &&
    signal.keyPct === 0;
  let shouldNudge =
    (stateReadFailed || shouldNudgeForInterval) && !shouldSuppressExactZeroNudge;
  const nextState: ThrottleState = {
    band: band.name,
    lastNudgeAt: shouldNudge ? now.toISOString() : previousLastNudgeAt,
    signal,
  };

  let stateWriteFailed = false;
  try {
    await deps.writeThrottleState(nextState, deps.regentDir);
  } catch {
    stateWriteFailed = true;
    shouldNudge = true;
  }

  return { band, shouldNudge, signal };
}

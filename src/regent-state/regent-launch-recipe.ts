import path from "node:path";
import { sessionNameAtLaunch } from "../agent-settings/agent-settings-decision.ts";
import { AGENT_ROLES } from "../agent-settings/agent-settings.types.ts";
import {
  longRunningLaunchAccountOption,
  type ReadAccountsConfig,
} from "../account/agent-account.ts";
import { readSpawnSpec, writeSpawnSpec, type SpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { resolveTargetEffort } from "../config.ts";
import {
  HARNESS_NAMES,
  buildLaunchArgv,
  resolveModel,
  throneLauncherPath,
} from "../harness-routing/harness.ts";
import { parseHarness } from "../harness-routing/model-registry.ts";
import { modelEffortRange } from "../harness-routing/policy/capabilities.ts";
import type { StartOptions } from "../herdr/herdr-create.contracts.ts";
import {
  activeRegentRoute,
  targetEffortForRole,
  type CustomPlanPresetPair,
} from "../steering-user-config.ts";
import { REGENT_NAME } from "./regent-liveness.ts";
import type { RegentHarness, RegentRoute } from "./regent-state.service.ts";

export interface RegentLaunch extends RegentRoute {
  readonly effort: number;
}

export function resolveConfiguredRegentLaunch(
  route: CustomPlanPresetPair | undefined,
  targetEffort: number,
): RegentLaunch | undefined {
  if (route === undefined) return undefined;
  const harness = parseHarness(route.harness);
  const model = resolveModel(harness, route.model);
  const range = modelEffortRange(harness, model);
  if (range === undefined) {
    throw new Error(
      `steering.regentRoute ${harness}/${model} has no registered effort range`,
    );
  }
  return { harness, model, effort: resolveTargetEffort(targetEffort, range) };
}

export function configuredRegentLaunch(): RegentLaunch | undefined {
  return resolveConfiguredRegentLaunch(
    activeRegentRoute(),
    targetEffortForRole("regent"),
  );
}

const EFFORT_OF_A_RECORDED_ROUTE = 1;

export function regentLaunchArgv(
  configured: RegentLaunch | undefined,
  recordedRoute: RegentRoute | undefined,
  recordedHarness: RegentHarness,
): string[] {
  const route = configured ?? recordedRoute;
  if (route !== undefined) {
    return buildLaunchArgv({
      harness: route.harness,
      model: route.model,
      effort: configured?.effort ?? EFFORT_OF_A_RECORDED_ROUTE,
      sessionName: sessionNameAtLaunch(
        REGENT_NAME,
        AGENT_ROLES.REGENT,
        route.harness,
      ),
    });
  }
  return [
    throneLauncherPath(
      recordedHarness === HARNESS_NAMES.CODEX ? "codexy" : "claudey",
    ),
  ];
}

export function regentFreshLaunchOptions(
  throneRoot: string,
  argv: string[],
  readConfig: ReadAccountsConfig,
): StartOptions {
  return { cwd: throneRoot, argv, ...longRunningLaunchAccountOption(readConfig) };
}

const MODEL_OF_AN_UNROUTED_LAUNCH = "unknown";

export interface RegentLaunchRecord {
  readonly regentDir: string;
  readonly harness: RegentHarness;
  readonly route: RegentRoute | undefined;
  readonly effort: number | undefined;
  readonly cwd: string;
  readonly account: string | undefined;
  readonly launchedAt: Date;
}

function freshRegentSpawnSpec(record: RegentLaunchRecord): SpawnSpec {
  return {
    harness: record.harness,
    model: record.route?.model ?? MODEL_OF_AN_UNROUTED_LAUNCH,
    effort: record.effort ?? EFFORT_OF_A_RECORDED_ROUTE,
    cwd: record.cwd,
    spawned_at: record.launchedAt.toISOString(),
  };
}

export async function recordRegentLaunchAccount(record: RegentLaunchRecord): Promise<void> {
  const { account } = record;
  if (account === undefined) return;
  const name = path.basename(record.regentDir);
  const ledgerDirectory = path.dirname(record.regentDir);
  const existing = await readSpawnSpec(name, ledgerDirectory);
  await writeSpawnSpec(name, { ...(existing ?? freshRegentSpawnSpec(record)), account }, ledgerDirectory);
}

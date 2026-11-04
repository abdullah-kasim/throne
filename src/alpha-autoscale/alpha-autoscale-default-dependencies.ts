import os from "node:os";
import { readCapacityPressure } from "../keep-going/keep-going-pressure-report.ts";
import { readLaunchLedger } from "../alpha-launch-queue/launch-ledger-reader.ts";
import { DEFAULT_LAUNCH_LEDGER_PATH } from "../alpha-launch-queue/paths.ts";
import { sweepResponsiveness } from "../pressure-baseline/sweep-responsiveness.ts";
import { resolveThroneHome } from "../shared-policy/throne-home.ts";
import { resolveRepoRootAndGenerationFromModuleUrl } from "../status/dist-generation.ts";
import type { AlphaAutoscaleDependencies } from "./alpha-autoscale.hosted-worker.ts";
import { readAutoscaleQueueFromStore, stageEligibleLaunchBriefsFromStore } from "./regent-queue-feed.ts";
import { isAutoscaleKillSwitchOn, readAutoscaleEnabledInUserConfig } from "./kill-switch.ts";
import {
  readAlphaAutoscaleCooldown,
  recordSuccessfulAlphaAutoscaleSpawn,
} from "./alpha-autoscale-schedule-dedupe.ts";
import { readActiveAlphaCapacityInputs } from "./active-alpha-roster.ts";
import { invokeThroneCliWithRetry } from "./retryable-cli-invoke.ts";
import { recoverIdleWork } from "./idle-recovery.ts";
import { notifyRegentOfIdleRecovery, REAL_ALPHA_FLOOR_BREACH_NOTIFY_DEPS } from "./alpha-floor-notify.ts";
import { readBypassFlagsAuthorizedForAlpha } from "./authorized-bypass-flags.ts";
import { ALPHA_AUTOSCALE_SWEEP_LOCK_PATH, acquireSweepLock } from "./alpha-autoscale-sweep-lock.ts";

/**
 * The real production dependency bag, exported so the manual-trigger REST
 * route (`alpha-autoscale-route.ts`) can construct its own
 * `AlphaAutoscaleHostedWorker` instance observing the exact same production
 * wiring the scheduled cron tick uses, layering only its own captured-output
 * `log` override on top -- mirrors how `resolveKeepGoingDependencies` /
 * `resolveNoIdlingDependencies` keep their own manual triggers off a second,
 * divergent copy of that wiring.
 */
export const ALPHA_AUTOSCALE_DEFAULT_DEPENDENCIES: AlphaAutoscaleDependencies = {
  log: (message) => console.log(`[alpha-autoscale] ${message}`),
  acquireSweepLock: () => acquireSweepLock({ lockPath: ALPHA_AUTOSCALE_SWEEP_LOCK_PATH }),
  notifyOfFloorBreach: REAL_ALPHA_FLOOR_BREACH_NOTIFY_DEPS,
  // The admission gate reads cpu PSI, memory PSI, the busiest physical disk's
  // busy time and the run queue, graded inside `classifyPressure`, so
  // `decideAutoscaleAction`'s existing "skip unless positively take-more-work"
  // rule enforces every one of them with no change of its own. Routed through
  // the SHARED `readCapacityPressure` rather than assembling the inputs here:
  // this file and keep-going's report drifting apart on which signals the gate
  // reads is exactly how a report ends up disagreeing with the decision.
  readPressure: () => readCapacityPressure(),
  recoverIdleWork: () => recoverIdleWork(),
  notifyOfIdleRecovery: notifyRegentOfIdleRecovery,
  readReadyQueue: readAutoscaleQueueFromStore,
  autoBriefEligibleItems: stageEligibleLaunchBriefsFromStore,
  readKillSwitch: isAutoscaleKillSwitchOn,
  readAutoscaleEnabledInConfig: readAutoscaleEnabledInUserConfig,
  readSpawnCooldown: readAlphaAutoscaleCooldown,
  recordSuccessfulSpawn: recordSuccessfulAlphaAutoscaleSpawn,
  readActiveCapacityInputs: readActiveAlphaCapacityInputs,
  readLaunchLedger: (objectiveCode) =>
    readLaunchLedger(DEFAULT_LAUNCH_LEDGER_PATH, { objectiveCode }),
  resolvePublishedRuntime: () =>
    resolveRepoRootAndGenerationFromModuleUrl(import.meta.url),
  invokeCli: invokeThroneCliWithRetry,
  readAuthorizedBypassFlags: readBypassFlagsAuthorizedForAlpha,
  sweepResponsiveness: () =>
    sweepResponsiveness({ dataHome: resolveThroneHome(), userHome: os.homedir() }),
};

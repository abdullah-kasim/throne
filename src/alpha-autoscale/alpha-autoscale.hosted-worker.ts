import { CronExpression } from "@nestjs/schedule";
import { Injectable, Optional } from "@nestjs/common";
import type { CronHostedWorker } from "../throne-backend/hosted-worker.types.ts";
import {
  createAlphaArguments,
  publishedCliEntrypoint,
  spawnGitTreeArguments,
} from "./alpha-spawn-arguments.ts";
import type { AutoBriefResult } from "./regent-queue-feed.ts";
import type { AlphaAutoscaleCooldownStatus } from "./alpha-autoscale-schedule-dedupe.ts";
import { buildIdleRecoveryNotice, type IdleRecoveryOutcome } from "./idle-recovery.ts";
import {
  notifyRegentOfFloorBreach,
  type AlphaFloorBreachNotifyDeps,
} from "./alpha-floor-notify.ts";
import {
  resolveFloorAwareAutoscaleTick,
  type AlphaFloorSpawnOutcome,
} from "./alpha-floor-breach-snapshot.ts";
import type { PressureClassification } from "../pressure-signal/classify-pressure.ts";
import type { ReadyQueueResult } from "../alpha-launch-queue/ready-queue.ts";
import type { LaunchLedgerResult } from "../alpha-launch-queue/launch-ledger-reader.ts";
import type { ActiveAlphaCapacityInputs } from "./active-alpha-roster.ts";
import type { CliInvocationOutcome } from "./retryable-cli-invoke.ts";
import {
  ALPHA_AUTOSCALE_BOUNDS,
  alphaLaunchBudgetForPressure,
  effectiveAlphaCapacity,
} from "./alpha-autoscale-bounds.ts";
import { decideAutoscaleActionWithFloor } from "./decide-autoscale-action.ts";
import { alphaAutoscaleExecutionGate } from "./alpha-autoscale-execution-gate.ts";
import {
  autoBriefUnknownReason,
  launchLedgerUnknownReason,
  launchStopReason,
  skipReasonForDecision,
  unresolvedLaunchHistoryMessage,
} from "./autoscale-skip-wording.ts";
import {
  describeHeldSweepLock,
  describeLostSweepLock,
  describeReplacedSweepLock,
  type SweepLockAcquisition,
  type SweepLockLease,
} from "./alpha-autoscale-sweep-lock.ts";
import { ALPHA_AUTOSCALE_DEFAULT_DEPENDENCIES } from "./alpha-autoscale-default-dependencies.ts";

export const ALPHA_AUTOSCALE_HOSTED_WORKER_NAME = "alpha-autoscale";

export interface AlphaAutoscaleDependencies {
  log: (message: string) => void;
  acquireSweepLock: () => Promise<SweepLockAcquisition>;
  notifyOfFloorBreach: AlphaFloorBreachNotifyDeps;
  readPressure: () => PressureClassification;
  recoverIdleWork: () => IdleRecoveryOutcome;
  /** Announces a recovery to the Regent. Recovery is a correct action taken in
   *  an ambiguous situation, so it is never silent. */
  notifyOfIdleRecovery: (message: string) => Promise<void>;
  readReadyQueue: () => ReadyQueueResult;
  autoBriefEligibleItems: () => AutoBriefResult;
  readKillSwitch: () => boolean;
  /** The operator pause, `steering.autoscaleEnabled` in the live
   *  `config.user.ts`, read fresh per tick. OPTIONAL only so the many
   *  existing test dependency bags need no change: absent means enabled,
   *  which is also what an absent config file means. Production always
   *  supplies it. */
  readAutoscaleEnabledInConfig?: () => Promise<
    { readonly enabled: true } | { readonly enabled: false; readonly reason: string }
  >;
  readSpawnCooldown: () => AlphaAutoscaleCooldownStatus;
  recordSuccessfulSpawn: () => void;
  readActiveCapacityInputs: () => Promise<ActiveAlphaCapacityInputs>;
  readLaunchLedger: (objectiveCode: string) => Promise<LaunchLedgerResult>;
  resolvePublishedRuntime: () =>
    { repoRoot: string; generation: string } | undefined;
  invokeCli: (
    executablePath: string,
    argv: readonly string[],
  ) => Promise<CliInvocationOutcome>;
  readAuthorizedBypassFlags?: (
    objectiveCode: string,
    alphaName: string,
  ) => Promise<readonly string[]>;
  sweepResponsiveness?: () => Promise<string>;
}

let productionDependencies: AlphaAutoscaleDependencies | undefined;

/**
 * Test-only override seam, mirroring `configureKeepGoingDependencies` /
 * `configureNoIdlingDependencies`: lets a test replace the real dependency
 * bag every in-process caller (the cron provider, the REST route handler)
 * resolves against, so neither ever has to touch real PSI/queue/roster reads
 * or real `create-agent` spawns in a test.
 */
export function configureAlphaAutoscaleDependencies(
  dependencies: AlphaAutoscaleDependencies,
): void {
  productionDependencies = dependencies;
}

/**
 * The dependency bag any in-process caller should resolve against: whatever
 * `configureAlphaAutoscaleDependencies` installed, else the real bag, with
 * `overrides` (the route's own captured-output `log`) layered on top.
 * Mirrors `resolveKeepGoingDependencies` / `resolveNoIdlingDependencies`.
 */
export function resolveAlphaAutoscaleDependencies(
  overrides: Partial<AlphaAutoscaleDependencies> = {},
): AlphaAutoscaleDependencies {
  return { ...(productionDependencies ?? ALPHA_AUTOSCALE_DEFAULT_DEPENDENCIES), ...overrides };
}

/**
 * The separate, ceiling-and-kill-switch-gated actor: combines every prior
 * signals, plus the live-Alpha floor, into one spawn/refuse decision
 * via `resolveFloorAwareAutoscaleTick` and, only on `action: 'spawn'`,
 * invokes `create-agent` (which itself
 * appends the launch-ledger record -- this worker never duplicates that
 * write). A new `CronHostedWorker`, distinct from keep-going, which only
 * OBSERVES and REPORTS the same pressure signal and never spawns.
 */
@Injectable()
export class AlphaAutoscaleHostedWorker implements CronHostedWorker {
  readonly kind = "cron" as const;
  readonly workerName = ALPHA_AUTOSCALE_HOSTED_WORKER_NAME;
  readonly cronExpression = CronExpression.EVERY_5_MINUTES;

  constructor(
    @Optional()
    private readonly injectedDependencies?: AlphaAutoscaleDependencies,
  ) {}

  private get dependencies(): AlphaAutoscaleDependencies {
    return this.injectedDependencies ?? resolveAlphaAutoscaleDependencies();
  }

  async runOnce(options: { readonly bypassPressure?: boolean } = {}): Promise<void> {
    const acquisition = await this.dependencies.acquireSweepLock();
    if (acquisition.outcome === "held") {
      this.dependencies.log(describeHeldSweepLock(acquisition));
      return;
    }
    const lease = acquisition.lease;
    if (acquisition.replaced !== undefined) {
      this.dependencies.log(describeReplacedSweepLock(lease.lockPath, acquisition.replaced));
    }
    try {
      await alphaAutoscaleExecutionGate.run(() =>
        this.runOnceInternal(lease, options.bypassPressure === true),
      );
    } finally {
      await lease.release();
    }
  }

  private async runOnceInternal(lease: SweepLockLease, bypassPressure: boolean): Promise<void> {
    // Stager actuation deliberately absent: autoscale/autodispatch touch
    // Alphas and Shadows ONLY (Lord ruling 2026-08-19). The Stager-floor
    // effect lives solely in the backend's court liveness worker.
    const responsiveness = await this.dependencies.sweepResponsiveness?.();
    if (responsiveness !== undefined) this.dependencies.log(responsiveness);
    const pause = await this.dependencies.readAutoscaleEnabledInConfig?.();
    if (pause !== undefined && !pause.enabled) {
      this.dependencies.log(`skip: ${pause.reason}`);
      return;
    }
    const autoBrief = this.dependencies.autoBriefEligibleItems();
    if (autoBrief.state === "unknown") {
      this.dependencies.log(`skip: ${autoBriefUnknownReason(autoBrief.reason)}`);
      return;
    } else if (autoBrief.state === "ineligible") {
      this.dependencies.log(
        `auto-brief found ineligible items: ${autoBrief.reasons.join(", ")}`,
      );
    }
    const recoveryNotice = buildIdleRecoveryNotice(this.dependencies.recoverIdleWork());
    if (recoveryNotice !== undefined) {
      await this.dependencies.notifyOfIdleRecovery(recoveryNotice);
    }
    const readPressure = bypassPressure
      ? () => this.pressureBypassed(this.dependencies.readPressure())
      : () => this.dependencies.readPressure();
    let launchBudget: number | undefined;
    const launchedThisTick = new Set<string>();
    for (
      let launchesThisTick = 0;
      launchesThisTick < ALPHA_AUTOSCALE_BOUNDS.hardMaximum;
      launchesThisTick += 1
    ) {
      if (!(await lease.isStillHeld())) {
        this.dependencies.log(describeLostSweepLock(lease.lockPath));
        return;
      }
      const pressure = readPressure();
      launchBudget ??= bypassPressure ? 1 : alphaLaunchBudgetForPressure(pressure.pressure);
      const launched = await this.launchNextAlpha(
        pressure,
        launchedThisTick,
        launchBudget,
        readPressure,
      );
      if (!launched) return;
    }
    this.dependencies.log(
      `stop: this tick launched the hard maximum of ${ALPHA_AUTOSCALE_BOUNDS.hardMaximum} Alphas`,
    );
  }

  private pressureBypassed(observed: PressureClassification): PressureClassification {
    this.dependencies.log(
      `pressure bypassed by --bypass: observed verdict "${observed.verdict}" at ${observed.pressure ?? "unknown"}; this run launches at most one Alpha`,
    );
    return { ...observed, verdict: "take-more-work" };
  }

  private async launchNextAlpha(
    pressure: PressureClassification,
    launchedThisTick: Set<string>,
    launchBudget: number,
    readPressure: () => PressureClassification,
  ): Promise<boolean> {
    const readyQueue = this.dependencies.readReadyQueue();
    const killSwitchOn = this.dependencies.readKillSwitch();
    const cooldown = this.dependencies.readSpawnCooldown();
    const { activeRecords, mutatingTargets } =
      await this.dependencies.readActiveCapacityInputs();

    let selectedCandidateLedgerEntry;
    if (readyQueue.state === "candidates") {
      const objectiveCode = readyQueue.candidates[0]!.objectiveCode;
      const ledger = await this.dependencies.readLaunchLedger(objectiveCode);
      if (ledger.state === "unknown") {
        this.dependencies.log(`skip: ${launchLedgerUnknownReason(ledger.reason)}`);
        return false;
      }
      selectedCandidateLedgerEntry = ledger.entries.find(
        (entry) => entry.objectiveCode === objectiveCode,
      );
    }

    const tick = resolveFloorAwareAutoscaleTick({
      pressure,
      readyQueue,
      selectedCandidateLedgerEntry,
      cooldownElapsed: cooldown.elapsed,
      killSwitchOn,
      activeRecords,
      mutatingTargets,
      capacity: effectiveAlphaCapacity(pressure),
    });
    const decision = tick.decision;

    const breached = tick.liveAlphaCount < tick.floorMinimum;
    if (breached) {
      this.dependencies.log(
        `floor breach: live=${tick.liveAlphaCount} floor=${tick.floorMinimum} durationMs=${tick.breachDurationMs}`,
      );
    }

    // The breach page is sent HERE, at the tick's exit, rather than at the
    // moment the breach was detected. It used to be sent immediately above,
    // before any spawn work ran, which made `This tick spawned "X"` a claim
    // about an INTENTION -- every failure path below still produced a page
    // asserting the Alpha existed. Deferring the send is what makes the
    // clause an observation. Every `return` between here and the end of this
    // method must therefore go through `reportBreach` with the outcome it
    // actually reached; a return that forgets renders as an explicit
    // "reported no spawn outcome" defect notice rather than a false success.
    const reportBreach = async (
      spawnOutcome?: AlphaFloorSpawnOutcome,
    ): Promise<void> => {
      if (!breached) return;
      await notifyRegentOfFloorBreach(
        { ...tick, spawnOutcome },
        this.dependencies.notifyOfFloorBreach,
      );
    };

    if (decision.action === "skip") {
      this.dependencies.log(`skip: ${skipReasonForDecision(decision, cooldown)}`);
      await reportBreach();
      return false;
    }
    if (decision.action === "unresolved") {
      this.dependencies.log(unresolvedLaunchHistoryMessage(decision.name));
      await reportBreach();
      return false;
    }

    const stopReason = launchStopReason(launchedThisTick, launchBudget, pressure, decision.candidate.name);
    if (stopReason !== undefined) {
      this.dependencies.log(`skip: ${stopReason}`);
      if (launchedThisTick.size === 0) {
        await reportBreach({ kind: "refused", reason: stopReason });
      }
      return false;
    }

    const resolved = this.dependencies.resolvePublishedRuntime();
    if (!resolved) {
      this.dependencies.log(
        "skip: could not resolve this worker's own published dist location",
      );
      await reportBreach({
        kind: "failed",
        stage: "resolving this worker's own published dist location",
        detail: "resolvePublishedRuntime returned nothing",
      });
      return false;
    }
    const cliEntrypoint = publishedCliEntrypoint(resolved.repoRoot);
    const candidate = decision.candidate;
    const treeArguments = spawnGitTreeArguments(cliEntrypoint, candidate);

    const dispatchPressure = readPressure();
    const dispatchDecision = decideAutoscaleActionWithFloor({
      pressure: dispatchPressure,
      readyQueue,
      selectedCandidateLedgerEntry,
      cooldownElapsed: cooldown.elapsed,
      killSwitchOn,
      activeRecords,
      mutatingTargets,
      capacity: effectiveAlphaCapacity(dispatchPressure),
      liveAlphaCount: tick.liveAlphaCount,
      floorMinimum: tick.floorMinimum,
      hardMaximum: ALPHA_AUTOSCALE_BOUNDS.hardMaximum,
    });
    if (dispatchDecision.action === "skip") {
      this.dependencies.log(`skip at dispatch pressure check: ${dispatchDecision.reason}`);
      await reportBreach({
        kind: "refused",
        reason: `dispatch pressure re-check said ${dispatchDecision.reason}`,
      });
      return false;
    }
    if (dispatchDecision.action === "unresolved") {
      this.dependencies.log(
        `launch history unresolved for "${dispatchDecision.name}" at dispatch pressure check -- refusing to spawn`,
      );
      await reportBreach({
        kind: "refused",
        reason: `launch history unresolved for "${dispatchDecision.name}" at the dispatch pressure re-check`,
      });
      return false;
    }

    const treeOutcome = await this.dependencies.invokeCli(process.execPath, treeArguments);
    if (treeOutcome.outcome !== "success") {
      const result =
        treeOutcome.outcome === "retryable-failure-exhausted"
          ? treeOutcome.lastResult
          : treeOutcome.result;
      this.dependencies.log(
        `spawn tree preparation for "${candidate.name}" failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
      await reportBreach({
        kind: "failed",
        stage: "spawn-git-tree",
        detail: `exit ${result.exitCode}: ${result.stderr.trim()}`,
      });
      return false;
    }
    const candidateCwd = treeOutcome.result.stdout.trim().split("\n").at(-1);
    if (!candidateCwd) {
      this.dependencies.log(
        `spawn tree preparation for "${candidate.name}" returned no worktree path`,
      );
      await reportBreach({
        kind: "failed",
        stage: "spawn-git-tree",
        detail: "succeeded but printed no worktree path",
      });
      return false;
    }

    const authorizedBypassFlags =
      (await this.dependencies.readAuthorizedBypassFlags?.(
        candidate.objectiveCode,
        candidate.name,
      )) ?? [];
    const outcome = await this.dependencies.invokeCli(
      process.execPath,
      createAlphaArguments(cliEntrypoint, candidate, authorizedBypassFlags, candidateCwd),
    );

    if (outcome.outcome === "retryable-failure-exhausted") {
      this.dependencies.log(
        `LOUD FAILURE: create-agent for "${candidate.name}" failed with a retryable error twice in a row -- ${outcome.lastResult.stderr.trim()}`,
      );
      await reportBreach({
        kind: "failed",
        stage: "create-agent (retryable, exhausted after two attempts)",
        detail: outcome.lastResult.stderr.trim(),
      });
      return false;
    }
    if (outcome.outcome === "failure") {
      // A failed spawn attempt is logged and picked up again on this
      // worker's next tick, not retried inline -- out of
      // scope for this worker.
      this.dependencies.log(
        `spawn attempt for "${candidate.name}" failed (exit ${outcome.result.exitCode}): ${outcome.result.stderr.trim()}`,
      );
      await reportBreach({
        kind: "failed",
        stage: "create-agent",
        detail: `exit ${outcome.result.exitCode}: ${outcome.result.stderr.trim()}`,
      });
      return false;
    }

    try {
      this.dependencies.recordSuccessfulSpawn();
    } catch (error) {
      this.dependencies.log(
        `LOUD FAILURE: spawned "${candidate.name}" but could not persist the Alpha spawn limiter: ${error instanceof Error ? error.message : String(error)}`,
      );
      // The Alpha DOES exist here -- `create-agent` returned success and only
      // the limiter write failed -- so this reports `spawned`, not `failed`.
      // Claiming a failed spawn would be the same class of lie in the other
      // direction, and would have the Regent hunt for an Alpha that is
      // running.
      await reportBreach({ kind: "spawned" });
      return false;
    }
    launchedThisTick.add(candidate.name);
    this.dependencies.log(
      `spawned "${candidate.name}" for objective "${candidate.objectiveCode}"`,
    );
    await reportBreach({ kind: "spawned" });
    return true;
  }
}

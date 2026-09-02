import { CronExpression } from "@nestjs/schedule";
import { Injectable, Optional } from "@nestjs/common";
import path from "node:path";
import type { CronHostedWorker } from "../throne-backend/hosted-worker.types.ts";
import { readPsiPressure } from "../pressure-signal/psi-pressure-reader.ts";
import { classifyPressure } from "../pressure-signal/classify-pressure.ts";
import {
  readCapacityPressure,
} from "../keep-going/keep-going-pressure-report.ts";
import { readLaunchLedger } from "../alpha-launch-queue/launch-ledger-reader.ts";
import { DEFAULT_LAUNCH_LEDGER_PATH } from "../alpha-launch-queue/paths.ts";
import {
  readAutoscaleQueueFromStore,
  stageEligibleLaunchBriefsFromStore,
  type AutoBriefResult,
} from "./regent-queue-feed.ts";
import {
  isAutoscaleKillSwitchOn,
  readAutoscaleEnabledInUserConfig,
} from "./kill-switch.ts";
import {
  readAlphaAutoscaleCooldown,
  recordSuccessfulAlphaAutoscaleSpawn,
  type AlphaAutoscaleCooldownStatus,
} from "./alpha-autoscale-schedule-dedupe.ts";
import { readActiveAlphaCapacityInputs } from "./active-alpha-roster.ts";
import { invokeThroneCliWithRetry } from "./retryable-cli-invoke.ts";
import { resolveRepoRootAndGenerationFromModuleUrl } from "../status/dist-generation.ts";
import {
  buildIdleRecoveryNotice,
  promoteDeferredWork,
  type DeferralPromotionOutcome,
} from "./deferral-promotion.ts";
import {
  notifyRegentOfIdleRecovery,
  notifyRegentOfFloorBreach,
  REAL_ALPHA_FLOOR_BREACH_NOTIFY_DEPS,
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
  effectiveAlphaCapacity,
} from "./alpha-autoscale-bounds.ts";
import { decideAutoscaleActionWithFloor } from "./decide-autoscale-action.ts";
import { alphaAutoscaleExecutionGate } from "./alpha-autoscale-execution-gate.ts";

export const ALPHA_AUTOSCALE_HOSTED_WORKER_NAME = "alpha-autoscale";

/** Hard ceiling of concurrent executable-active Alphas, independent of and
 *  in addition to the pressure signal -- the Lord's own number. */
export const ALPHA_AUTOSCALE_CEILING = ALPHA_AUTOSCALE_BOUNDS.ceiling;

const CPU_PRESSURE_PATH = "/proc/pressure/cpu";
const MEMORY_PRESSURE_PATH = "/proc/pressure/memory";

export interface AlphaAutoscaleDependencies {
  log: (message: string) => void;
  notifyOfFloorBreach: AlphaFloorBreachNotifyDeps;
  readPressure: () => PressureClassification;
  /** Releases deferred work whose dependencies finished, and — only when that
   *  leaves nothing launchable — promotes one held row as idle recovery. */
  promoteDeferredWork: () => DeferralPromotionOutcome;
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
  notifyOfFloorBreach: REAL_ALPHA_FLOOR_BREACH_NOTIFY_DEPS,
  // The admission gate reads cpu PSI, memory PSI, io PSI (`full` line) and the
  // run queue, merged into one figure inside `classifyPressure`, so
  // `decideAutoscaleAction`'s existing "skip unless positively take-more-work"
  // rule enforces every one of them with no change of its own. Routed through
  // the SHARED `readCapacityPressure` rather than assembling the inputs here:
  // this file and keep-going's report drifting apart on which signals the gate
  // reads is exactly how a report ends up disagreeing with the decision.
  readPressure: () => readCapacityPressure(),
  promoteDeferredWork: () => promoteDeferredWork(),
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
};

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

  /**
   * Funnels the entire sweep through `alphaAutoscaleExecutionGate` so this
   * scheduled cron tick can never execute concurrently with a manual REST
   * trigger of the same sweep against the same `throne-backend` process (see
   * that gate's own doc comment). The real sweep body is `runOnceInternal`;
   * `runOnce` itself does nothing but gate it, so every caller -- the cron
   * provider registered in `ThroneBackendModule` and the route handler's own
   * freshly constructed worker instance -- observes the same serialization
   * without either having to call the gate itself.
   */
  async runOnce(): Promise<void> {
    return alphaAutoscaleExecutionGate.run(() => this.runOnceInternal());
  }

  private async runOnceInternal(): Promise<void> {
    // Stager actuation deliberately absent: autoscale/autodispatch touch
    // Alphas and Shadows ONLY (Lord ruling 2026-08-19). The Stager-floor
    // effect lives solely in throne-startup's Regent boot reconciliation.
    //
    // THE OPERATOR PAUSE comes first, before auto-brief or deferral
    // promotion mutate a single queue row: a paused court is inert, not
    // "inert except for the bookkeeping". No floor-breach page either --
    // the breach is the operator's deliberate state, and paging the Regent
    // about it every five minutes would be noise about a decision already
    // made. The log line is the record.
    const pause = await this.dependencies.readAutoscaleEnabledInConfig?.();
    if (pause !== undefined && !pause.enabled) {
      this.dependencies.log(`skip: ${pause.reason}`);
      return;
    }
    const autoBrief = this.dependencies.autoBriefEligibleItems();
    if (autoBrief.state === "unknown") {
      this.dependencies.log(`skip: auto-brief unknown: ${autoBrief.reason}`);
      return;
    } else if (autoBrief.state === "ineligible") {
      this.dependencies.log(
        `auto-brief found ineligible items: ${autoBrief.reasons.join(", ")}`,
      );
    }
    // Promote held work BEFORE reading the ready queue, so a hold whose
    // condition cleared is launchable on the same tick it cleared rather than
    // the next one. Nothing downstream knows this ran: it only changes which
    // rows the `status === "open"` filter can see, so there is still exactly
    // one way an Alpha is born. See `deferral-promotion.ts`.
    const promotion = this.dependencies.promoteDeferredWork();
    const recoveryNotice = buildIdleRecoveryNotice(promotion);
    if (recoveryNotice !== undefined) {
      await this.dependencies.notifyOfIdleRecovery(recoveryNotice);
    }
    const pressure = this.dependencies.readPressure();
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
        this.dependencies.log(`skip: launch ledger unknown: ${ledger.reason}`);
        return;
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
      const reason =
        decision.reason === "cooldown not yet elapsed since last spawn" &&
        !cooldown.elapsed
          ? cooldown.reason
          : decision.reason;
      this.dependencies.log(`skip: ${reason}`);
      await reportBreach();
      return;
    }
    if (decision.action === "unresolved") {
      this.dependencies.log(
        `launch history unresolved for "${decision.name}" -- refusing to spawn (distinct from an empty queue)`,
      );
      await reportBreach();
      return;
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
      return;
    }
    const cliEntrypoint = path.join(
      resolved.repoRoot,
      "dist",
      "src",
      "tools.js",
    );
    const candidate = decision.candidate;
    const treeArguments = [
      cliEntrypoint,
      "spawn-git-tree",
      candidate.name,
      "--repo",
      candidate.targetRepo,
      "--base",
      candidate.baseCommit,
      "--target-branch",
      candidate.targetBranch,
      // PR-mode: permit creating the (PR) target branch at the authorized
      // base when it does not exist locally yet, forked from the mainline.
      ...(candidate.createTargetFromBranch === undefined
        ? []
        : ["--create-target-from", candidate.createTargetFromBranch]),
    ];

    const dispatchPressure = this.dependencies.readPressure();
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
      return;
    }
    if (dispatchDecision.action === "unresolved") {
      this.dependencies.log(
        `launch history unresolved for "${dispatchDecision.name}" at dispatch pressure check -- refusing to spawn`,
      );
      await reportBreach({
        kind: "refused",
        reason: `launch history unresolved for "${dispatchDecision.name}" at the dispatch pressure re-check`,
      });
      return;
    }

    const treeOutcome = await this.dependencies.invokeCli(
      process.execPath,
      treeArguments,
    );
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
      return;
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
      return;
    }

    const outcome = await this.dependencies.invokeCli(process.execPath, [
      cliEntrypoint,
      "create-agent",
      "--model",
      candidate.model,
      ...(candidate.modelHint === null || candidate.modelHint === undefined
        ? []
        : ["--model-hint", `${candidate.modelHint.harness}/${candidate.modelHint.model}`]),
      ...(candidate.deliverableShape === null || candidate.deliverableShape === undefined
        ? []
        : ["--deliverable-shape", candidate.deliverableShape]),
      "--role",
      "Alpha",
      "--supervisor",
      "Regent",
      "--cwd",
      candidateCwd,
      "--name",
      candidate.name,
      "--objective-code",
      candidate.objectiveCode,
      "--prompt",
      candidate.objective,
    ]);

    if (outcome.outcome === "retryable-failure-exhausted") {
      this.dependencies.log(
        `LOUD FAILURE: create-agent for "${candidate.name}" failed with a retryable error twice in a row -- ${outcome.lastResult.stderr.trim()}`,
      );
      await reportBreach({
        kind: "failed",
        stage: "create-agent (retryable, exhausted after two attempts)",
        detail: outcome.lastResult.stderr.trim(),
      });
      return;
    }
    if (outcome.outcome === "failure") {
      // A failed spawn attempt is logged and picked up again on this
      // worker's next tick after its cooldown, not retried inline -- out of
      // scope for this worker.
      this.dependencies.log(
        `spawn attempt for "${candidate.name}" failed (exit ${outcome.result.exitCode}): ${outcome.result.stderr.trim()}`,
      );
      await reportBreach({
        kind: "failed",
        stage: "create-agent",
        detail: `exit ${outcome.result.exitCode}: ${outcome.result.stderr.trim()}`,
      });
      return;
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
      return;
    }
    this.dependencies.log(
      `spawned "${candidate.name}" for objective "${candidate.objectiveCode}"`,
    );
    await reportBreach({ kind: "spawned" });
  }
}

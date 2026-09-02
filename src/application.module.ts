import "reflect-metadata";
import { Module } from "@nestjs/common";
import { AgentStatsCommand } from "./agent-stats/agent-stats.command.ts";
import { AgentStatusesCommand } from "./agent-statuses/agent-statuses.command.ts";
import { AgentLogsCommand } from "./agent-logs/agent-logs.command.ts";
import { AssertHerdrCommand } from "./assert-herdr/assert-herdr.command.ts";
import { ReadPayloadCommand } from "./read-payload/read-payload.command.ts";
import { SendAgentCommand } from "./send-agent/send-agent.command.ts";
import { SendAgentLegacyCommand } from "./send-agent-legacy/send-agent-legacy.command.ts";
import { MessageStatusCommand } from "./message-status/message-status.command.ts";
import { CancelMessageCommand } from "./cancel-message/cancel-message.command.ts";
import { DeliveryFailuresCommand } from "./delivery-failures/delivery-failures.command.ts";
import { ThroneBackendCommand } from "./throne-backend/throne-backend.command.ts";
import { QueueHealthCommand } from "./throne-work/queue-health.command.ts";
import { VerifyDeliveryPathCommand } from "./message-queue/verify-delivery-path.command.ts";
import { VerifyAlphaFloorDeliveryCommand } from "./alpha-autoscale/verify-alpha-floor-delivery.command.ts";
import {
  AlphaAutoscaleTickCommand,
  AutoscaleNowCommand,
} from "./alpha-autoscale/alpha-autoscale-tick.command.ts";
import { AlphaAutoscaleHostedWorker } from "./alpha-autoscale/alpha-autoscale.hosted-worker.ts";
import { CreateAgentCommand } from "./create-agent/create-agent.command.ts";
import { KeepGoingCommand } from "./keep-going/keep-going.command.ts";
import { NoIdlingCommand } from "./no-idling/no-idling.command.ts";
import { UsageRateCommand } from "./usage-rate/usage-rate.command.ts";
import { DeriveShadowNameFromAlphaCommand } from "./derive-shadow-name-from-alpha/derive-shadow-name-from-alpha.command.ts";
import { NotifyLordCommand } from "./notify-lord/notify-lord.command.ts";
import { ListHarnessesAndModelsCommand } from "./list-harnesses-and-models/list-harnesses-and-models.command.ts";
import { SwitchPersonaCommand } from "./switch-persona/switch-persona.command.ts";
import { AgentStatusesModule } from "./agent-statuses/agent-statuses.module.ts";
import { CreateAgentModule } from "./create-agent/create-agent.module.ts";
import { KeepGoingModule } from "./keep-going/keep-going.module.ts";
import { NoIdlingModule } from "./no-idling/no-idling.module.ts";
import { ReadPayloadModule } from "./read-payload/read-payload.module.ts";
import { SwitchAgentModelCommand } from "./switch-agent-model/switch-agent-model.command-registration.ts";
import { SwitchAgentModelModule } from "./switch-agent-model/switch-agent-model.module.ts";
import { FindUntaskedAgentsCommand } from "./no-idling/find-untasked-agents.command.ts";
import { CompleteAgentCommand } from "./complete-agent/complete-agent.command.ts";
import { ReapAgentCommand } from "./reap-agent/reap-agent.command.ts";
import { SpawnGitTreeCommand } from "./spawn-git-tree/spawn-git-tree.command.ts";
import { MergeGitTreeCommand } from "./merge-git-tree/merge-git-tree.command.ts";
import { MakeSquashCommitCommand } from "./make-squash-commit/make-squash-commit.command.ts";
import { LintSliceAssignmentCommand } from "./slice-assignment/lint-slice-assignment.command.ts";
import { AbsorbGitTreeCommand } from "./absorb-git-tree/absorb-git-tree.command.ts";
import { VerifyDeliveryCommand } from "./verify-delivery/verify-delivery.command.ts";
import { ValidateDeliveryCommand } from "./validate-delivery/validate-delivery.command.ts";
import { CheckMainIntegrityCommand } from "./check-main-integrity/check-main-integrity.command.ts";
import { TrimQueueCommand } from "./trim-queue/trim-queue.command.ts";
import { RegentQueueMigrateCommand } from "./regent-queue/regent-queue-migrate.command.ts";
import { AddToQueueCommand } from "./add-to-queue/add-to-queue.command.ts";
import { UpdateQueueCommand } from "./update-queue/update-queue.command.ts";
import { MarkQueueLaunchEligibleCommand } from "./mark-queue-launch-eligible/mark-queue-launch-eligible.command.ts";
import { ReconcileQueueCommand } from "./reconcile-queue/reconcile-queue.command.ts";
import { StageLaunchBriefCommand } from "./stage-launch-brief/stage-launch-brief.command.ts";
import { RegentQueueRenderCommand } from "./regent-queue/regent-queue-render.command.ts";
import { InstallServicesCommand } from "./install-services/install-services.command.ts";
import { AttachThroneHerdrCommand } from "./attach-throne-herdr/attach-throne-herdr.command.ts";
import { ThroneStartupCommand } from "./throne-startup/throne-startup.command.ts";
import { DismissRegentCommand } from "./dismiss-regent/dismiss-regent.command.ts";
import { SummonRegentCommand } from "./summon-regent/summon-regent.command.ts";
import { RecordSuiteHoldCommand } from "./regent-fencing/record-suite-hold.command.ts";
import { RecordSuiteReleaseCommand } from "./regent-fencing/record-suite-release.command.ts";
import { ReadSuiteArbitrationCommand } from "./regent-fencing/read-suite-arbitration.command.ts";
import { ConsumeFenceHandoffOnStartCommand } from "./regent-fencing/consume-fence-handoff-on-start.command.ts";
import { OpenCodeGoUsageRemainingCommand } from "./opencode-go-usage-remaining/opencode-go-usage-remaining.command.ts";
import { PlanUsageRemainingCommand } from "./plan-usage-remaining/plan-usage-remaining.command.ts";
import { PlanUsageRemainingService } from "./plan-usage-remaining/plan-usage-remaining.service.ts";
import { PlanUsageAuthenticationService } from "./plan-usage-remaining/plan-usage-authentication.service.ts";
import { PlanUsageHistoryService } from "./plan-usage-remaining/plan-usage-history.service.ts";
import { CampaignEvidenceCommand } from "./campaign-evidence/campaign-evidence.command.ts";
import { SweepTmpScratchCommand } from "./sweep-tmp-scratch/sweep-tmp-scratch.command.ts";
import { ReclaimAgentScratchpadsCommand } from "./reclaim-agent-scratchpads/reclaim-agent-scratchpads.command.ts";
import {
  CodexUsageDependenciesService,
  CodexUsageRemainingCommand,
} from "./codex-usage-remaining/codex-usage-remaining.command.ts";
import { REAL_CODEX_USAGE_DEPS } from "./shared-policy/codex-usage.service.ts";
import { ResourcePressureCommand } from "./resource-pressure/resource-pressure.command.ts";
import { TokenBalanceCommand } from "./token-balance/token-balance.command.ts";
import { LintQueuePlanCommand } from "./lint-queue-plan/lint-queue-plan.command.ts";
import {
  DisableThroneCommand,
  EnableThroneCommand,
} from "./throne-lifecycle/throne-lifecycle.command.ts";
import {
  ForecastSampleService,
  PlanUsageTelemetryService,
  UsageCacheService,
  UsageLogService,
  WeeklyResetService,
} from "./plan-usage-remaining/plan-usage-telemetry.service.ts";
import { FeatureFlagsService } from "./shared-policy/feature-flags.service.ts";
import { ApplicationConfigService } from "./application-config.service.ts";
import { NotificationService } from "./notify-lord/notification.service.ts";
import { ServiceUnitRenderer } from "./install-services/service-unit-renderer.service.ts";
import { HerdrReleaseService } from "./install-services/herdr-release.service.ts";
import {
  THRONE_STARTUP_DEPS,
  ThroneStartupService,
} from "./throne-startup/throne-startup.service.ts";
import { REAL_DEPS as REAL_THRONE_STARTUP_DEPS } from "./throne-startup/throne-startup.ts";
import { CustomHarnessService } from "./create-agent/custom-harness.service.ts";
import { ThroneLifecycleService } from "./throne-lifecycle/throne-lifecycle.service.ts";
import { ModelPresentationService } from "./shared-policy/model-presentation.ts";
import { HarnessRegistryService } from "./shared-policy/harness-registry.service.ts";
import { UsageReadersService } from "./shared-policy/usage-readers.service.ts";
import { UsageAdaptersService } from "./shared-policy/usage-adapters.service.ts";
import { ThroneStartupReconciliationService } from "./throne-startup/throne-startup-reconciliation.service.ts";
import { UsageRateCalculationService } from "./shared-policy/usage-rate-calculation.service.ts";
import { UsageRateOutputService } from "./shared-policy/usage-rate-output.service.ts";
import { ThrottlePersistenceService } from "./shared-policy/throttle-persistence.service.ts";
import { ThrottleSteeringService } from "./shared-policy/throttle-steering.service.ts";
import { LedgerDataService } from "./agentdata/ledger-data.service.ts";
import { IdentityDataService } from "./agentdata/identity-data.service.ts";
import { TreeBaseDataService } from "./agentdata/tree-base-data.service.ts";
import { SpawnDataService } from "./agentdata/spawn-data.service.ts";
import { SessionService } from "./session/session.service.ts";
import { CodexSessionStoreService } from "./session/codex-session-store.service.ts";
import { RecipientPaneLockService } from "./shared-policy/recipient-pane-lock.service.ts";
import { CodexTrustModule } from "./codex-trust/codex-trust.module.ts";
import { CodexTrustService } from "./codex-trust/codex-trust.service.ts";
import { CodexScreenModule } from "./codex-screen/codex-screen.module.ts";
import { CodexScreenService } from "./codex-screen/codex-screen.ts";
import { AgentStatsService } from "./agent-stats/agent-stats.service.ts";
import { RegentStateService } from "./regent-state/regent-state.service.ts";
import { HerdrClientService } from "./herdr/herdr-client.ts";
import { HerdrTabService } from "./herdr/herdr-tab.service.ts";
import { HerdrSessionService } from "./herdr/herdr-session.service.ts";
import { HerdrIdentityService } from "./herdr/herdr-identity.service.ts";
import { HerdrInventoryService } from "./herdr/herdr-inventory.service.ts";
import { HerdrCreateService } from "./herdr/herdr-create.service.ts";
import { RestoredTabInspectionService } from "./herdr/herdr-restored-tab-inspection.ts";
import { RestoredAgentRecoveryService } from "./herdr/herdr-agent-recovery.ts";
import { HerdrCreationOrchestrationService } from "./herdr/herdr-creation-orchestration.ts";
import { HerdrHarnessService } from "./herdr/herdr-harness.service.ts";
import { HerdrRuntimeService } from "./herdr/herdr-runtime.service.ts";
import { HerdrScreenService } from "./herdr/herdr-screen.service.ts";
import { HerdrClaudeService } from "./herdr/herdr-claude.service.ts";
import { HerdrCodexService } from "./herdr/herdr-codex.service.ts";
import { HerdrOpencodeService } from "./herdr/herdr-opencode.service.ts";
import { OpenCodeGoUsageService } from "./opencode-go-usage-remaining/opencode-go-usage.service.ts";
import { GitLifecycleService } from "./git-lifecycle/git-command.service.ts";
import { GitWorktreeService } from "./git-lifecycle/git-worktree.service.ts";
import { GitTreeCreationService } from "./git-lifecycle/git-tree-creation.service.ts";
import { HarnessService } from "./harness-routing/harness.ts";
import { PlanUsagePlatformService } from "./plan-usage-remaining/plan-usage-platform.service.ts";
import { PlanUsagePresentationService } from "./plan-usage-remaining/plan-usage-presentation.service.ts";
import { HarnessRoutingPolicyService } from "./harness-routing/harness-routing-policy.service.ts";
import { COMMAND_REGISTRY_PROVIDERS } from "./shared-policy/command-registry.ts";

// The command-name/visibility/migrated-flag side of "what commands exist" is
// owned by COMMAND_REGISTRY (see src/shared-policy/command-registry.ts); this
// is just that same provider list plus the one non-command DI provider
// (THRONE_STARTUP_DEPS) exported for the foundation test to assert against.
export const NEST_COMMANDER_COMMAND_PROVIDERS = [
  ...COMMAND_REGISTRY_PROVIDERS,
  {
    provide: THRONE_STARTUP_DEPS,
    useFactory: () => ({ ...REAL_THRONE_STARTUP_DEPS }),
  },
] as const;

@Module({
  imports: [
    AgentStatusesModule,
    CreateAgentModule,
    KeepGoingModule,
    NoIdlingModule,
    ReadPayloadModule,
    SwitchAgentModelModule,
    CodexTrustModule,
    CodexScreenModule,
  ],
  providers: [
    AssertHerdrCommand,
    {
      provide: AgentLogsCommand,
      useFactory: () => new AgentLogsCommand(),
    },
    {
      provide: AgentStatsCommand,
      useFactory: () => new AgentStatsCommand(),
    },
    {
      provide: UsageRateCommand,
      useFactory: () => new UsageRateCommand(),
    },
    DeriveShadowNameFromAlphaCommand,
    {
      provide: SendAgentCommand,
      useFactory: () => new SendAgentCommand(),
    },
    {
      provide: SendAgentLegacyCommand,
      useFactory: () => new SendAgentLegacyCommand(),
    },
    {
      provide: MessageStatusCommand,
      useFactory: () => new MessageStatusCommand(),
    },
    {
      provide: CancelMessageCommand,
      useFactory: () => new CancelMessageCommand(),
    },
    {
      provide: DeliveryFailuresCommand,
      useFactory: () => new DeliveryFailuresCommand(),
    },
    {
      provide: ThroneBackendCommand,
      useFactory: () => new ThroneBackendCommand(),
    },
    {
      provide: QueueHealthCommand,
      useFactory: () => new QueueHealthCommand(),
    },
    {
      provide: VerifyDeliveryPathCommand,
      useFactory: () => new VerifyDeliveryPathCommand(),
    },
    {
      provide: VerifyAlphaFloorDeliveryCommand,
      useFactory: () => new VerifyAlphaFloorDeliveryCommand(),
    },
    {
      provide: AlphaAutoscaleTickCommand,
      inject: [AlphaAutoscaleHostedWorker],
      useFactory: (worker: AlphaAutoscaleHostedWorker) =>
        new AlphaAutoscaleTickCommand(worker),
    },
    {
      provide: AutoscaleNowCommand,
      inject: [AlphaAutoscaleHostedWorker],
      useFactory: (worker: AlphaAutoscaleHostedWorker) =>
        new AutoscaleNowCommand(worker),
    },
    AlphaAutoscaleHostedWorker,
    {
      provide: NotifyLordCommand,
      useFactory: () => new NotifyLordCommand(),
    },
    {
      provide: ListHarnessesAndModelsCommand,
      useFactory: () => new ListHarnessesAndModelsCommand(),
    },
    {
      provide: CompleteAgentCommand,
      useFactory: () => new CompleteAgentCommand(),
    },
    {
      provide: ReapAgentCommand,
      useFactory: () => new ReapAgentCommand(),
    },
    SpawnGitTreeCommand,
    MergeGitTreeCommand,
    MakeSquashCommitCommand,
    LintSliceAssignmentCommand,
    AbsorbGitTreeCommand,
    VerifyDeliveryCommand,
    ValidateDeliveryCommand,
    CheckMainIntegrityCommand,
    TrimQueueCommand,
    RegentQueueMigrateCommand,
    AddToQueueCommand,
    UpdateQueueCommand,
    MarkQueueLaunchEligibleCommand,
    ReconcileQueueCommand,
    StageLaunchBriefCommand,
    RegentQueueRenderCommand,
    InstallServicesCommand,
    AttachThroneHerdrCommand,
    ThroneStartupCommand,
    DismissRegentCommand,
    SummonRegentCommand,
    RecordSuiteHoldCommand,
    RecordSuiteReleaseCommand,
    ReadSuiteArbitrationCommand,
    ConsumeFenceHandoffOnStartCommand,
    FindUntaskedAgentsCommand,
    {
      provide: OpenCodeGoUsageRemainingCommand,
      useFactory: () => new OpenCodeGoUsageRemainingCommand(),
    },
    PlanUsageRemainingCommand,
    {
      provide: CodexUsageDependenciesService,
      useFactory: () =>
        new CodexUsageDependenciesService(REAL_CODEX_USAGE_DEPS),
    },
    CodexUsageRemainingCommand,
    ResourcePressureCommand,
    TokenBalanceCommand,
    LintQueuePlanCommand,
    CampaignEvidenceCommand,
    SweepTmpScratchCommand,
    ReclaimAgentScratchpadsCommand,
    SwitchPersonaCommand,
    DisableThroneCommand,
    EnableThroneCommand,
    FeatureFlagsService,
    ApplicationConfigService,
    NotificationService,
    ServiceUnitRenderer,
    HerdrReleaseService,
    ThroneStartupService,
    {
      provide: ThroneStartupReconciliationService,
      useFactory: () => new ThroneStartupReconciliationService(),
    },
    {
      provide: THRONE_STARTUP_DEPS,
      useFactory: () => ({ ...REAL_THRONE_STARTUP_DEPS }),
    },
    CustomHarnessService,
    ThroneLifecycleService,
    {
      provide: ModelPresentationService,
      inject: [HarnessRegistryService],
      useFactory: (registry: HarnessRegistryService) =>
        new ModelPresentationService(registry),
    },
    HarnessRegistryService,
    HarnessRoutingPolicyService,
    UsageReadersService,
    {
      provide: UsageAdaptersService,
      inject: [OpenCodeGoUsageService],
      useFactory: (opencodeGoUsage: OpenCodeGoUsageService) =>
        new UsageAdaptersService(opencodeGoUsage),
    },
    {
      provide: PlanUsageRemainingService,
      inject: [
        PlanUsagePlatformService,
        PlanUsageTelemetryService,
        PlanUsageAuthenticationService,
      ],
      useFactory: (
        platform: PlanUsagePlatformService,
        telemetry: PlanUsageTelemetryService,
        authentication: PlanUsageAuthenticationService,
      ) =>
        new PlanUsageRemainingService(
          platform.runtime,
          telemetry,
          authentication,
        ),
    },
    {
      provide: PlanUsageAuthenticationService,
      inject: [PlanUsagePlatformService],
      useFactory: (platform: PlanUsagePlatformService) =>
        new PlanUsageAuthenticationService(platform),
    },
    {
      provide: PlanUsageHistoryService,
      inject: [PlanUsagePlatformService],
      useFactory: (platform: PlanUsagePlatformService) =>
        new PlanUsageHistoryService(platform),
    },
    UsageRateCalculationService,
    UsageRateOutputService,
    ThrottlePersistenceService,
    ThrottleSteeringService,
    {
      provide: LedgerDataService,
      useFactory: () => new LedgerDataService(),
    },
    IdentityDataService,
    TreeBaseDataService,
    SpawnDataService,
    SessionService,
    CodexSessionStoreService,
    RecipientPaneLockService,
    AgentStatsService,
    RegentStateService,
    {
      provide: HerdrClientService,
      useFactory: () => new HerdrClientService(),
    },
    HerdrSessionService,
    HerdrInventoryService,
    {
      provide: HerdrTabService,
      useFactory: () => new HerdrTabService(),
    },
    HerdrCreateService,
    HerdrHarnessService,
    HerdrRuntimeService,
    HerdrScreenService,
    HerdrClaudeService,
    HerdrCodexService,
    HerdrOpencodeService,
    OpenCodeGoUsageService,
    {
      provide: GitLifecycleService,
      useFactory: () => new GitLifecycleService(),
    },
    GitTreeCreationService,
    GitWorktreeService,
    CodexTrustService,
    CodexScreenService,
    ForecastSampleService,
    WeeklyResetService,
    PlanUsagePlatformService,
    PlanUsagePresentationService,
    {
      provide: UsageCacheService,
      inject: [PlanUsagePlatformService],
      useFactory: (platform: PlanUsagePlatformService) =>
        new UsageCacheService(platform.runtime),
    },
    {
      provide: UsageLogService,
      inject: [PlanUsageHistoryService],
      useFactory: (history: PlanUsageHistoryService) =>
        new UsageLogService(history),
    },
    {
      provide: PlanUsageTelemetryService,
      inject: [
        UsageCacheService,
        UsageLogService,
        ForecastSampleService,
        WeeklyResetService,
      ],
      useFactory: (
        cache: UsageCacheService,
        log: UsageLogService,
        forecast: ForecastSampleService,
        weeklyReset: WeeklyResetService,
      ) => new PlanUsageTelemetryService(cache, log, forecast, weeklyReset),
    },
  ],
})
export class NestCommanderApplicationModule {}

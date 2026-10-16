import "reflect-metadata";
import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { HOSTED_WORKERS } from "./hosted-worker.types.ts";
import { HostedWorkerRegistrarService } from "./hosted-worker-registrar.service.ts";
import { NoIdlingHostedWorker } from "./no-idling.hosted-worker.ts";
import { SqliteQueueDrainHostedWorker } from "./sqlite-queue-drain.hosted-worker.ts";
import { ServiceGenerationMarkerRefreshHostedWorker } from "./service-generation-marker-refresh.hosted-worker.ts";
import { KeepGoingHostedWorker } from "./keep-going.hosted-worker.ts";
import { AlphaAutoscaleHostedWorker } from "../alpha-autoscale/alpha-autoscale.hosted-worker.ts";
import { TransportRouteDispatcherHostedWorker } from "./transport-route-dispatcher.ts";
import { BlockedAgentPagingHostedWorker } from "../blocked-paging/blocked-agent-paging.hosted-worker.ts";
import { AutoreapHostedWorker } from "../autoreap/autoreap.hosted-worker.ts";
import { ProcwatchHostedWorker } from "../procwatch/procwatch.hosted-worker.ts";
import { ForgejoBranchSyncHostedWorker } from "./forgejo-branch-sync.hosted-worker.ts";
import { CourtLivenessHostedWorker } from "./court-liveness.hosted-worker.ts";
import { AgentSettingsHostedWorker } from "../agent-settings/agent-settings.hosted-worker.ts";

/**
 * The long-lived `throne-backend` server: a real bootstrapped Nest
 * application (not `nest-commander`'s one-shot `CommandFactory`), hosting
 * exactly eleven in-process workers — no-idling, the SQLite queue drain, the
 * service-generation-marker refresher, the dispatcher, the blocked-agent
 * paging subscriber, the alpha-autoscale cron
 * (`AlphaAutoscaleHostedWorker`, the kill-switch-gated actor that spawns
 * pre-briefed Alphas off the CPU/memory pressure signal -- separate from and
 * with no spawn authority granted to keep-going's own tick), the claimed-agent
 * autoreap cron, the hourly procwatch — `ProcwatchHostedWorker`, which
 * FINDS long-running high-CPU and owner-less processes and ASKS the Regent to
 * launch an Opus-level investigator for each; it never kills, never spawns,
 * and never decides killability), the ten-minute Forgejo branch mirror
 * (`ForgejoBranchSyncHostedWorker`), and the every-minute court liveness
 * check (`CourtLivenessHostedWorker`) — behind the uniform `HostedWorker`
 * registration shape.
 *
 * REBUILDING IS NO LONGER ONE OF THESE WORKERS (2026-08-26). A self-rebuild
 * worker used to fingerprint sources every 5s, publish an immutable
 * generation, and `systemctl restart` its own unit. That reload path is why
 * the court could vanish for four hours: a self-issued restart is a
 * DELIBERATE stop, so `Restart=always` correctly declines to undo it, and a
 * generation that never reached READY=1 left nothing running — including the
 * Regent resurrection tick that would otherwise have noticed.
 *
 * The unit now runs `nest start --watch`, so the watcher is the unit's own
 * long-lived process and this app is its child. Rebuilds and relaunches
 * happen outside the app entirely, a bad build crash-loops the child instead
 * of stopping the service, and fixing the source recovers without a human.
 * A worker that restarts the process it lives in cannot supervise that
 * restart; the CLI, which outlives it, can.
 * The standalone `throne-keep-going` systemd timer stays installed and
 * enabled as an independent fallback alongside this in-process worker, so a
 * dead `throne-backend` process never silently stops the Regent heartbeat;
 * `resurrectRegent()` stays idempotent against both paths firing in the same
 * window. A future herdr-remote relay registers here the same way — one more
 * entry in the `HOSTED_WORKERS` provider, no new systemd unit.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [
    NoIdlingHostedWorker,
    SqliteQueueDrainHostedWorker,
    ServiceGenerationMarkerRefreshHostedWorker,
    KeepGoingHostedWorker,
    TransportRouteDispatcherHostedWorker,
    BlockedAgentPagingHostedWorker,
    AlphaAutoscaleHostedWorker,
    AutoreapHostedWorker,
    ProcwatchHostedWorker,
    ForgejoBranchSyncHostedWorker,
    CourtLivenessHostedWorker,
    AgentSettingsHostedWorker,
    {
      provide: HOSTED_WORKERS,
      inject: [
        NoIdlingHostedWorker,
        SqliteQueueDrainHostedWorker,
        ServiceGenerationMarkerRefreshHostedWorker,
        KeepGoingHostedWorker,
        TransportRouteDispatcherHostedWorker,
        BlockedAgentPagingHostedWorker,
        AlphaAutoscaleHostedWorker,
        AutoreapHostedWorker,
        ProcwatchHostedWorker,
        ForgejoBranchSyncHostedWorker,
        CourtLivenessHostedWorker,
        AgentSettingsHostedWorker,
      ],
      useFactory: (
        noIdling: NoIdlingHostedWorker,
        sqliteQueueDrain: SqliteQueueDrainHostedWorker,
        serviceGenerationMarkerRefresh: ServiceGenerationMarkerRefreshHostedWorker,
        keepGoing: KeepGoingHostedWorker,
        transportRouteDispatcher: TransportRouteDispatcherHostedWorker,
        blockedAgentPaging: BlockedAgentPagingHostedWorker,
        alphaAutoscale: AlphaAutoscaleHostedWorker,
        autoreap: AutoreapHostedWorker,
        procwatch: ProcwatchHostedWorker,
        forgejoBranchSync: ForgejoBranchSyncHostedWorker,
        courtLiveness: CourtLivenessHostedWorker,
        agentSettings: AgentSettingsHostedWorker,
      ) => [
        noIdling,
        sqliteQueueDrain,
        serviceGenerationMarkerRefresh,
        keepGoing,
        transportRouteDispatcher,
        blockedAgentPaging,
        alphaAutoscale,
        autoreap,
        procwatch,
        forgejoBranchSync,
        courtLiveness,
        agentSettings,
      ],
    },
    HostedWorkerRegistrarService,
  ],
  exports: [HostedWorkerRegistrarService],
})
export class ThroneBackendModule {}

import { Injectable, Optional } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import type { CronHostedWorker } from '../throne-backend/hosted-worker.types.ts';
import type { HerdrAgent } from '../herdr/herdr-inventory.service.ts';
import { agentStatusAcceptsInput } from '../herdr/herdr-inventory.service.ts';
import { listAgents, resolveAgent } from '../herdr/herdr-runtime.service.ts';
import { LedgerDataService } from '../agentdata/ledger-data.service.ts';
import { submitToAgentViaQueue } from '../throne-work/enqueue-heartbeat-message.ts';
import {
  DEFAULT_CLOCK_TICKS_PER_SECOND,
  DEFAULT_PROC_ROOT,
  readBootTimeEpochSeconds,
} from '../process-inspection/proc-scan.ts';
import {
  REAL_CPU_SAMPLE_DEPS,
  sampleProcessCpu,
  type SampledProcess,
} from '../process-inspection/cpu-sampling.ts';
import { resolveNeverTouchPids } from './never-touch.ts';
import { resolveProtectedUnitFacts, type ProtectedUnitFacts } from './protected-units.ts';
import { detectOffenders } from './detect.ts';
import { scanSuiteContainers, type ContainerScanResult } from './container-scan.ts';
import {
  containerKey,
  readReportLedger,
  selectOffendersToReport,
  selectToReport,
  procwatchLedgerPath,
  writeReportLedger,
  type ReportLedger,
} from './report-ledger.ts';
import { buildProcwatchRequest } from './report.ts';
import {
  clearedCandidatesPath,
  isCleared,
  readClearedCandidates,
} from './cleared-candidates.ts';

export const PROCWATCH_HOSTED_WORKER_NAME = 'procwatch';
const NOTICE_RECIPIENT_NAME = 'Regent';

const LEDGER_DATA = new LedgerDataService();

export interface ProcwatchDependencies {
  log: (message: string) => void;
  sampleCpu: () => Promise<SampledProcess[]>;
  readBootTime: () => Promise<number | undefined>;
  resolveProtectedUnits: () => Promise<ProtectedUnitFacts>;
  listLiveAgents: () => Promise<HerdrAgent[]>;
  listRegisteredAgents: () => Promise<string[]>;
  scanContainers: (nowEpochSeconds: number) => Promise<ContainerScanResult>;
  readLedger: () => Promise<ReportLedger>;
  /** `undefined` means the clearance file exists but could not be read — an
   *  UNKNOWN clearance state, which refuses the tick. It never degrades into
   *  "nothing was ever cleared". */
  readCleared: () => Promise<ReadonlySet<string> | undefined>;
  writeLedger: (ledger: ReportLedger) => Promise<void>;
  /** Sends the Regent the investigation REQUEST. procwatch never spawns the
   *  investigator itself: spawning is the Regent's prerogative, exactly as
   *  the 2026-08-19 ruling excising Stager actuation from alpha-autoscale
   *  established. */
  requestInvestigation: (body: string) => Promise<void>;
  now: () => number;
  selfPid: number;
  clockTicksPerSecond: number;
  /** The host platform. procwatch's detector is built on `/proc` (per-pid
   *  stat deltas, io syscall counts, VmRSS, cgroups, fd/1 targets); none of
   *  that exists on darwin, and `sampleCpu` would reject on the missing
   *  directory and fail the whole tick every hour. The tick skips with a
   *  stated reason instead. This is a KNOWN GAP, not mac support: the
   *  autoscaler-family signals (pressure, worktree process scan) are
   *  dual-platform as of 2026-09-02; the hourly runaway-process detector is
   *  not yet. */
  platform: NodeJS.Platform;
}

const DEFAULT_DEPENDENCIES: ProcwatchDependencies = {
  log: (message) => console.log(`[${PROCWATCH_HOSTED_WORKER_NAME}] ${message}`),
  sampleCpu: () => sampleProcessCpu(REAL_CPU_SAMPLE_DEPS),
  readBootTime: () => readBootTimeEpochSeconds(DEFAULT_PROC_ROOT),
  resolveProtectedUnits: () => resolveProtectedUnitFacts(),
  listLiveAgents: () => listAgents(),
  listRegisteredAgents: () => LEDGER_DATA.listRegisteredAgents(),
  scanContainers: (nowEpochSeconds) => scanSuiteContainers(nowEpochSeconds),
  readLedger: () => readReportLedger(procwatchLedgerPath()),
  readCleared: () => readClearedCandidates(clearedCandidatesPath()),
  writeLedger: (ledger) => writeReportLedger(procwatchLedgerPath(), ledger),
  requestInvestigation: async (body) => {
    const regent = await resolveAgent(NOTICE_RECIPIENT_NAME);
    if (!agentStatusAcceptsInput(regent.agentStatus) && regent.agentStatus !== 'working') return;
    await submitToAgentViaQueue(regent, PROCWATCH_HOSTED_WORKER_NAME, body);
  },
  now: () => Date.now(),
  selfPid: process.pid,
  clockTicksPerSecond: DEFAULT_CLOCK_TICKS_PER_SECOND,
  platform: process.platform,
};

/**
 * procwatch, hourly, inside `throne-backend`. It has exactly two
 * responsibilities, in this order: FIND processes past the age threshold
 * that are also sustaining current CPU, and ROUTE each one to the Regent as
 * a request to launch an Opus-level investigator. It never kills, never
 * spawns, and never decides killability.
 *
 * The split is the point: detection is mechanical and cheap, while deciding
 * whether a process is genuinely wedged or a legitimate long-running job is
 * JUDGEMENT, and judgement is what gets the expensive model. Nothing in the
 * court was watching processes at all before this -- `no-idling` inspects
 * agents, and an orphan's owning agent no longer exists -- which is how an
 * orphaned `python3` held a full core for 55 hours and a wedged `npm ci`
 * held 41% for 18.6 hours on 2026-08-20.
 *
 * NOT a systemd timer: every user unit except `throne-herdr.service` and
 * `throne-backend.service` was deleted on 2026-08-19, so a hosted worker is
 * the only admissible home.
 */
@Injectable()
export class ProcwatchHostedWorker implements CronHostedWorker {
  readonly kind = 'cron' as const;
  readonly workerName = PROCWATCH_HOSTED_WORKER_NAME;
  readonly cronExpression = CronExpression.EVERY_HOUR;

  constructor(
    @Optional()
    private readonly injectedDependencies?: ProcwatchDependencies,
  ) {}

  private get dependencies(): ProcwatchDependencies {
    return this.injectedDependencies ?? DEFAULT_DEPENDENCIES;
  }

  async runOnce(): Promise<void> {
    const deps = this.dependencies;
    if (deps.platform === 'darwin') {
      deps.log(
        'skip: procwatch reads /proc (per-pid cpu deltas, io syscalls, VmRSS, cgroups) and has no darwin implementation yet; ' +
          'the autoscaler pressure signal and reap-agent process scan ARE dual-platform -- this hourly runaway-process detector is the remaining gap',
      );
      return;
    }
    const [sampled, bootTime, protectedUnits, liveAgents, registered] = await Promise.all([
      deps.sampleCpu(),
      deps.readBootTime(),
      deps.resolveProtectedUnits(),
      deps.listLiveAgents(),
      deps.listRegisteredAgents(),
    ]);
    if (bootTime === undefined) {
      deps.log('skip: could not read /proc/stat btime, so no process age is knowable');
      return;
    }
    const neverTouch = resolveNeverTouchPids({
      snapshots: sampled.map((sample) => sample.snapshot),
      protectedCommands: protectedUnits.commands,
      protectedPids: protectedUnits.pids,
      liveAgentCwds: liveAgents.map((agent) => agent.cwd ?? ''),
      selfPid: deps.selfPid,
    });
    if (neverTouch.state === 'unresolved') {
      deps.log(`skip: ${neverTouch.reason}`);
      return;
    }
    const nowMs = deps.now();
    const detected = detectOffenders({
      sampled,
      neverTouchPids: neverTouch.pids,
      bootTimeEpochSeconds: bootTime,
      nowEpochSeconds: nowMs / 1_000,
      clockTicksPerSecond: deps.clockTicksPerSecond,
      liveAgentNames: new Set(
        liveAgents.flatMap((agent) => {
          const name = agent.tabLabel ?? agent.name;
          return name === undefined ? [] : [name];
        }),
      ),
      registeredAgentNames: new Set(registered),
    });
    const cleared = await deps.readCleared();
    if (cleared === undefined) {
      deps.log(
        'skip: the cleared-candidates file exists but could not be parsed; refusing to ' +
          're-request investigations the court may already have paid for',
      );
      return;
    }
    // Ruling 5: never ask for a second investigator on a family one has
    // already judged and cleared as a legitimate long-running job. A family
    // is cleared by its ROOT, the identity the request was raised under.
    const unclearedTrees = detected.stuckTrees.filter((tree) => !isCleared(tree.root, cleared));
    const unclearedOrphans = detected.orphans.filter((orphan) => !isCleared(orphan, cleared));
    const ledger = await deps.readLedger();
    const treeSelection = selectOffendersToReport(
      unclearedTrees.map((tree) => ({ ...tree, ...tree.root, tree })),
      ledger,
      nowMs,
    );
    const orphanSelection = selectOffendersToReport(unclearedOrphans, ledger, nowMs);
    // Containers are scanned on every tick, not only when a process offender
    // exists: 22 leaked fixture containers with no stuck process alongside
    // them is exactly the shape seen on 2026-08-20, and gating the scan on a
    // process finding would have reported none of them.
    const containers = await deps.scanContainers(nowMs / 1_000);
    const agedContainers = containers.state === 'scanned' ? containers.aged : [];
    const containerSelection = selectToReport(
      agedContainers,
      (container) => containerKey(container.name),
      ledger,
      nowMs,
    );
    // The ledger is written on EVERY tick, including quiet ones: that write
    // is what forgets an offender that has gone away, so its next appearance
    // is a fresh first report rather than a stale escalation.
    await deps.writeLedger({
      ...treeSelection.nextLedger,
      ...orphanSelection.nextLedger,
      ...containerSelection.nextLedger,
    });
    const reportedTrees = treeSelection.report.map((entry) => entry.tree);
    if (
      reportedTrees.length === 0 &&
      orphanSelection.report.length === 0 &&
      containerSelection.report.length === 0
    ) {
      deps.log(
        `nothing new (${detected.stuckTrees.length} stuck famil(ies), ` +
          `${detected.orphans.length} orphan(s) and ${agedContainers.length} container(s) ` +
          `still matching, ${neverTouch.pids.size} pid(s) never-touch)`,
      );
      return;
    }
    await deps.requestInvestigation(
      buildProcwatchRequest(
        reportedTrees,
        orphanSelection.report,
        new Set([...treeSelection.escalations, ...orphanSelection.escalations]),
        ledger,
        {
          ...containers,
          ...(containers.state === 'scanned' ? { aged: containerSelection.report } : {}),
        } as typeof containers,
      ),
    );
    deps.log(
      `asked the Regent to investigate ${reportedTrees.length} process famil(ies), reported ` +
        `${orphanSelection.report.length} orphan(s) and ${containerSelection.report.length} ` +
        `aged container(s)`,
    );
  }
}

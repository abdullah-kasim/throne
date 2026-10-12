import { Injectable, Optional } from "@nestjs/common";
import { CronExpression } from "@nestjs/schedule";
import { getAgentStatusesRoster } from "../agent-statuses/agent-statuses-roster.ts";
import type { AgentStatusesRosterEntry } from "../agent-statuses/agent-statuses.types.ts";
import { listForkedAgentNames } from "../agentdata/fork-evidence.ts";
import { ensureLiveStager } from "../alpha-autoscale/stager-floor.ts";
import {
  REAL_STAGER_REUSE_EFFECTS,
  STAGER_REUSE_OUTCOMES,
  reuseRegisteredStager,
  type StagerReuseOutcome,
} from "../alpha-autoscale/stager-reuse.ts";
import { findRestoredAgentTab } from "../herdr/restored-agent-tab.ts";
import {
  readDesiredState,
  type DesiredState,
} from "../regent-state/regent-state.service.ts";
import { errorText } from "../shared-policy/error-text.ts";
import { enqueueRegentResurrection } from "../throne-work/regent-resurrection.ts";
import {
  createCourtLivenessAlert,
  type ReportCourtLivenessTick,
} from "./court-liveness-alert.ts";
import {
  COURT_ROLE_LIVENESS,
  decideCourtLiveness,
  type CourtLiveness,
} from "./court-liveness.ts";
import type { CronHostedWorker } from "./hosted-worker.types.ts";

export const COURT_LIVENESS_HOSTED_WORKER_NAME = "court-liveness";

export interface CourtLivenessDependencies {
  readonly readDesiredState: () => Promise<DesiredState>;
  readonly readRoster: () => Promise<readonly AgentStatusesRosterEntry[]>;
  readonly readForkedAgentNames: () => Promise<ReadonlySet<string>>;
  readonly enqueueRegentResurrection: () => Promise<unknown>;
  readonly reuseRegisteredStager: () => Promise<StagerReuseOutcome>;
  readonly ensureLiveStager: () => Promise<unknown>;
  readonly reportTick: ReportCourtLivenessTick;
}

const DEFAULT_DEPENDENCIES: CourtLivenessDependencies = {
  readDesiredState: () => readDesiredState(),
  readRoster: () => getAgentStatusesRoster(),
  readForkedAgentNames: () => listForkedAgentNames(),
  enqueueRegentResurrection: () => enqueueRegentResurrection(),
  reuseRegisteredStager: () =>
    reuseRegisteredStager({
      ...REAL_STAGER_REUSE_EFFECTS,
      findRestoredAgentTab: (label) => findRestoredAgentTab(label),
    }),
  ensureLiveStager: () => ensureLiveStager(),
  reportTick: createCourtLivenessAlert(),
};

interface RosterRead {
  readonly entries: readonly AgentStatusesRosterEntry[];
  readonly failure: string | undefined;
}

function rosterUnreadableFailure(reason: string): string {
  return `the agent roster could not be read: ${reason}`;
}

function regentIsMissing(liveness: CourtLiveness): boolean {
  return liveness.regent === COURT_ROLE_LIVENESS.MISSING;
}

function stagerIsMissingBesideALiveRegent(liveness: CourtLiveness): boolean {
  return (
    liveness.regent === COURT_ROLE_LIVENESS.LIVE &&
    liveness.stager === COURT_ROLE_LIVENESS.MISSING
  );
}

function livenessIsUnknown(liveness: CourtLiveness): boolean {
  return (
    liveness.regent === COURT_ROLE_LIVENESS.UNKNOWN ||
    liveness.stager === COURT_ROLE_LIVENESS.UNKNOWN
  );
}

@Injectable()
export class CourtLivenessHostedWorker implements CronHostedWorker {
  readonly kind = "cron" as const;
  readonly workerName = COURT_LIVENESS_HOSTED_WORKER_NAME;
  readonly cronExpression = CronExpression.EVERY_MINUTE;
  readonly runsAtStart = true;

  private previousTickIsStillGoing = false;

  constructor(
    @Optional()
    private readonly dependencies: CourtLivenessDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  async runOnce(): Promise<void> {
    if (this.previousTickIsStillGoing) return;
    this.previousTickIsStillGoing = true;
    try {
      await this.dependencies.reportTick(await this.failureOfThisTick());
    } finally {
      this.previousTickIsStillGoing = false;
    }
  }

  private async failureOfThisTick(): Promise<string | undefined> {
    try {
      const rosterRead = await this.readRoster();
      const liveness = decideCourtLiveness({
        desiredState: await this.dependencies.readDesiredState(),
        rosterEntries: rosterRead.entries,
        rosterReadThrew: rosterRead.failure !== undefined,
        forkedAgentNames: await this.dependencies.readForkedAgentNames(),
      });
      if (livenessIsUnknown(liveness)) return rosterRead.failure;
      await this.raiseWhicheverRoleIsMissing(liveness);
      return undefined;
    } catch (error) {
      return errorText(error);
    }
  }

  private async readRoster(): Promise<RosterRead> {
    try {
      return {
        entries: await this.dependencies.readRoster(),
        failure: undefined,
      };
    } catch (error) {
      return { entries: [], failure: rosterUnreadableFailure(errorText(error)) };
    }
  }

  private async raiseWhicheverRoleIsMissing(
    liveness: CourtLiveness,
  ): Promise<void> {
    if (regentIsMissing(liveness)) {
      await this.dependencies.enqueueRegentResurrection();
    }
    if (stagerIsMissingBesideALiveRegent(liveness)) {
      await this.bringBackOrCreateAStager();
    }
  }

  private async bringBackOrCreateAStager(): Promise<void> {
    const reuse = await this.dependencies.reuseRegisteredStager();
    if (reuse.kind === STAGER_REUSE_OUTCOMES.NONE_REUSABLE) {
      await this.dependencies.ensureLiveStager();
    }
  }
}

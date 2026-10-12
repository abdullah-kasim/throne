import { Injectable, Optional } from "@nestjs/common";
import { CronExpression } from "@nestjs/schedule";
import type { CronHostedWorker } from "./hosted-worker.types.ts";
import { syncForgejoBranches, type BranchSyncReport } from "../forge/branch-sync.ts";
import { PRODUCTION_FORGE_DEPENDENCIES, type ForgeDependencies } from "../forge/forge-dependencies.ts";
import { messageOf } from "../forge/forge-refusal.ts";
import type { ForgejoApi } from "../forge/forgejo-api.ts";
import { forgejoCopyName } from "../forge/forgejo-checkouts.ts";
import { forgejoCopiesWithCheckouts, type ForgejoCopy } from "../forge/forgejo-copies.ts";
import { decideHostForge, FORGE } from "../forge/host-forge.ts";
import { openForgejoApiOnThisHost } from "../forge/pull-request-operations.ts";

export const FORGEJO_BRANCH_SYNC_HOSTED_WORKER_NAME = "forgejo-branch-sync";

export interface ForgejoBranchSyncDependencies {
  readonly forge: ForgeDependencies;
  readonly log: (message: string) => void;
}

const DEFAULT_DEPENDENCIES: ForgejoBranchSyncDependencies = {
  forge: PRODUCTION_FORGE_DEPENDENCIES,
  log: (message) => console.log(`[${FORGEJO_BRANCH_SYNC_HOSTED_WORKER_NAME}] ${message}`),
};

function openPullRequestsNotCurrentSummary(report: BranchSyncReport): string {
  if (report.openPullRequestsNotCurrent.length === 0) return "every open pull request base is current";
  const pulls = report.openPullRequestsNotCurrent.map((pull) => `#${pull.number} (${pull.base}, ${pull.why})`);
  return `open pull requests whose base is not current: ${pulls.join(", ")}`;
}

function branchSyncSummary(report: BranchSyncReport): string {
  return (
    `created ${report.created.length}, fast-forwarded ${report.fastForwarded.length}, ` +
    `diverged ${report.diverged.length}, failed ${report.failed.length}; ${openPullRequestsNotCurrentSummary(report)}`
  );
}

@Injectable()
export class ForgejoBranchSyncHostedWorker implements CronHostedWorker {
  readonly kind = "cron" as const;
  readonly workerName = FORGEJO_BRANCH_SYNC_HOSTED_WORKER_NAME;
  readonly cronExpression = CronExpression.EVERY_10_MINUTES;
  readonly runsAtStart = true;

  private previousRunIsStillGoing = false;

  constructor(@Optional() private readonly dependencies: ForgejoBranchSyncDependencies = DEFAULT_DEPENDENCIES) {}

  async runOnce(): Promise<void> {
    if (this.previousRunIsStillGoing) {
      this.dependencies.log("skipped: the previous branch mirror run is still going");
      return;
    }
    this.previousRunIsStillGoing = true;
    try {
      await this.syncEveryForgejoCopy();
    } catch (error) {
      this.dependencies.log(`branch mirror run failed: ${messageOf(error)}`);
    } finally {
      this.previousRunIsStillGoing = false;
    }
  }

  private async syncEveryForgejoCopy(): Promise<void> {
    const host = await decideHostForge(this.dependencies.forge);
    if (host.forge === FORGE.github) return;
    const api = await openForgejoApiOnThisHost(this.dependencies.forge);
    for (const copy of await forgejoCopiesWithCheckouts(api, this.dependencies.forge)) {
      await this.syncForgejoCopy(copy, api);
    }
  }

  private async syncForgejoCopy(copy: ForgejoCopy, api: ForgejoApi): Promise<void> {
    const name = forgejoCopyName(copy.repository);
    if (copy.checkout === undefined) {
      this.dependencies.log(`${name}: skipped, no recorded checkout that still has a forgejo remote`);
      return;
    }
    try {
      const report = await syncForgejoBranches(copy.checkout, api, this.dependencies.forge);
      this.dependencies.log(`${name}: ${branchSyncSummary(report)}`);
    } catch (error) {
      this.dependencies.log(`${name}: branch sync failed: ${messageOf(error)}`);
    }
  }
}

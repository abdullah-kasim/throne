import { Injectable, Optional } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import path from 'node:path';
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import { getAgentStatusesRoster } from '../agent-statuses/agent-statuses-roster.ts';
import {
  readAgentSupervisor,
  IdentityLineReadStatus,
  type IdentityLineRead,
} from '../agentdata/identity-data.service.ts';
import { readAgent, resolveAgent } from '../herdr/herdr-runtime.service.ts';
import { agentStatusAcceptsInput } from '../herdr/herdr-inventory.service.ts';
import {
  lastMessageBlock,
  readReapabilityClaimStatus,
} from '../no-idling/idle-pane-tag-classification.ts';
import { resolveRepoRootAndGenerationFromModuleUrl } from '../status/dist-generation.ts';
import type { CronHostedWorker } from '../throne-backend/hosted-worker.types.ts';
import { submitToAgentViaQueue } from '../throne-work/enqueue-heartbeat-message.ts';
import {
  invokeThroneCliWithRetry,
  type CliInvocationOutcome,
} from '../alpha-autoscale/retryable-cli-invoke.ts';
import { isAutoreapEnabled } from './autoreap-enable-switch.ts';
import { AutoreapRefusalCooldown } from './refusal-cooldown.ts';
import { clearClaimedButRefused, recordClaimedButRefused } from './refusal-evidence.ts';
import { canEvaluateReapabilityClaim } from './supervising-wait.ts';

export const AUTOREAP_HOSTED_WORKER_NAME = 'claimed-agent-autoreap';
const CLAIM_READ_LINES = 300;
const refusalCooldown = new AutoreapRefusalCooldown();

function isAutomaticReapReason(
  status: ReturnType<typeof readReapabilityClaimStatus>,
): status is 'completed' | 'cancelled' {
  return status === 'completed' || status === 'cancelled';
}

export interface AutoreapDependencies {
  readEnabled: () => boolean;
  getRoster: () => Promise<AgentStatusesRosterEntry[]>;
  readLatest: (name: string) => Promise<string>;
  readSupervisor: (name: string) => Promise<IdentityLineRead>;
  resolvePublishedRuntime: () => { repoRoot: string; generation: string } | undefined;
  invokeCli: (executable: string, argv: readonly string[]) => Promise<CliInvocationOutcome>;
  isCoolingDown: (name: string) => boolean;
  recordCooldown: (name: string) => void;
  clearCooldown: (name: string) => void;
  recordRefusal: (name: string, reason: string) => void;
  clearRefusal: (name: string) => void;
  notifyRegent: (name: string, reason: string) => Promise<void>;
  log: (message: string) => void;
}

const DEFAULT_DEPENDENCIES: AutoreapDependencies = {
  readEnabled: isAutoreapEnabled,
  getRoster: () => getAgentStatusesRoster(),
  readLatest: (name) => readAgent(name, { source: 'recent', lines: CLAIM_READ_LINES }),
  readSupervisor: (name) => readAgentSupervisor(name),
  resolvePublishedRuntime: () => resolveRepoRootAndGenerationFromModuleUrl(import.meta.url),
  invokeCli: invokeThroneCliWithRetry,
  isCoolingDown: (name) => refusalCooldown.isCoolingDown(name),
  recordCooldown: (name) => refusalCooldown.record(name),
  clearCooldown: (name) => refusalCooldown.clear(name),
  recordRefusal: recordClaimedButRefused,
  clearRefusal: clearClaimedButRefused,
  notifyRegent: async (name, reason) => {
    const regent = await resolveAgent('Regent');
    if (!agentStatusAcceptsInput(regent.agentStatus) && regent.agentStatus !== 'working') return;
    await submitToAgentViaQueue(
      regent,
      AUTOREAP_HOSTED_WORKER_NAME,
      `LOUD FAILURE: autoreap refused claimed agent ${name}: ${reason}`,
      { key: `autoreap-refused:${name}` },
    );
  },
  log: (message) => console.log(`[${AUTOREAP_HOSTED_WORKER_NAME}] ${message}`),
};

@Injectable()
export class AutoreapHostedWorker implements CronHostedWorker {
  readonly kind = 'cron' as const;
  readonly workerName = AUTOREAP_HOSTED_WORKER_NAME;
  readonly cronExpression = CronExpression.EVERY_MINUTE;

  constructor(@Optional() private readonly injected?: AutoreapDependencies) {}

  private get deps(): AutoreapDependencies {
    return this.injected ?? DEFAULT_DEPENDENCIES;
  }

  async runOnce(): Promise<void> {
    if (!this.deps.readEnabled()) {
      this.deps.log('skip: kill switch is off');
      return;
    }
    const roster = await this.deps.getRoster();
    const live = roster.filter((entry) => entry.lifecycle === 'live');
    // canEvaluateReapabilityClaim/supervising-wait.ts (out of this slice's
    // scope) still take a plain ReadonlyMap<string, string> -- resolve the
    // tristate down to a name at this one boundary, the same
    // Found-else-"" collapse the pre-tristate read already produced on any
    // failure, so an unreadable identity.md never falsely widens or
    // narrows which candidates this map matches.
    const supervisors = new Map<string, string>();
    for (const entry of live) {
      const supervisorRead = await this.deps.readSupervisor(entry.name);
      supervisors.set(
        entry.name,
        supervisorRead.status === IdentityLineReadStatus.Found
          ? supervisorRead.value
          : '',
      );
    }

    for (const candidate of live.filter((entry) => entry.liveStatus === 'done')) {
      if (this.deps.isCoolingDown(candidate.name)) continue;
      if (!canEvaluateReapabilityClaim(candidate, live, supervisors)) continue;
      const firstClaim = readReapabilityClaimStatus(lastMessageBlock(await this.deps.readLatest(candidate.name)));
      if (!isAutomaticReapReason(firstClaim)) continue;
      if (live.some((entry) => supervisors.get(entry.name) === candidate.name)) continue;

      const currentClaim = readReapabilityClaimStatus(lastMessageBlock(await this.deps.readLatest(candidate.name)));
      if (!isAutomaticReapReason(currentClaim) || currentClaim !== firstClaim) continue;
      const runtime = this.deps.resolvePublishedRuntime();
      if (runtime === undefined) {
        this.deps.log(`skip: published runtime unavailable for ${candidate.name}`);
        continue;
      }
      const argv = [
        path.join(runtime.repoRoot, 'dist', 'src', 'tools.js'),
        'reap-agent',
        candidate.name,
        '--reason',
        currentClaim,
      ];
      const outcome = await this.deps.invokeCli(process.execPath, argv);
      if (outcome.outcome === 'success') {
        this.deps.clearCooldown(candidate.name);
        this.deps.clearRefusal(candidate.name);
        this.deps.log(`reaped ${candidate.name}`);
        continue;
      }
      const result = outcome.outcome === 'retryable-failure-exhausted' ? outcome.lastResult : outcome.result;
      const reason = `exit ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`;
      this.deps.recordCooldown(candidate.name);
      this.deps.recordRefusal(candidate.name, reason);
      await this.deps.notifyRegent(candidate.name, reason);
      this.deps.log(`refused ${candidate.name}: ${reason}`);
    }
  }
}

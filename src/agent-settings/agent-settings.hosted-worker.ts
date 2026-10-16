import { Injectable, Optional } from "@nestjs/common";
import { CronExpression } from "@nestjs/schedule";
import type { CronHostedWorker } from "../throne-backend/hosted-worker.types.ts";
import { runAgentSettingsTick } from "./agent-settings-tick.ts";

export const AGENT_SETTINGS_HOSTED_WORKER_NAME = "agent-settings";

export interface AgentSettingsWorkerDependencies {
  readonly runTick: () => Promise<readonly string[]>;
  readonly log: (line: string) => void;
}

const DEFAULT_DEPENDENCIES: AgentSettingsWorkerDependencies = {
  runTick: () => runAgentSettingsTick({ dryRun: false }),
  log: (line) => console.log(`[${AGENT_SETTINGS_HOSTED_WORKER_NAME}] ${line}`),
};

@Injectable()
export class AgentSettingsHostedWorker implements CronHostedWorker {
  readonly kind = "cron" as const;
  readonly workerName = AGENT_SETTINGS_HOSTED_WORKER_NAME;
  readonly cronExpression = CronExpression.EVERY_5_MINUTES;

  private previousTickIsStillGoing = false;

  constructor(
    @Optional()
    private readonly dependencies: AgentSettingsWorkerDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  async runOnce(): Promise<void> {
    if (this.previousTickIsStillGoing) return;
    this.previousTickIsStillGoing = true;
    try {
      for (const line of await this.dependencies.runTick()) {
        this.dependencies.log(line);
      }
    } finally {
      this.previousTickIsStillGoing = false;
    }
  }
}

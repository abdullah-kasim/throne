import { Injectable, Optional } from "@nestjs/common";
import { CronExpression } from "@nestjs/schedule";
import path from "node:path";
import type { CronHostedWorker } from "../throne-backend/hosted-worker.types.ts";
import { errorText } from "../shared-policy/error-text.ts";
import { resolveThroneHome } from "../shared-policy/throne-home.ts";
import type { TailnetPublishingDependencies } from "./tailnet-publishing.ts";
import { webListenerPort } from "./web-listener-address.ts";

export const TAILNET_PUBLISHING_HOSTED_WORKER_NAME = "tailnet-publishing";

const TAILSCALE_COMMAND = "tailscale";

export function productionTailnetPublishingDependencies(): TailnetPublishingDependencies {
  return {
    tailscaleCommand: TAILSCALE_COMMAND,
    ledgerPath: path.join(resolveThroneHome(), "state", "tailnet-routes.json"),
    listenerPort: webListenerPort(),
    log: (message) => console.log(`[${TAILNET_PUBLISHING_HOSTED_WORKER_NAME}] ${message}`),
  };
}

function loadTailnetPublishing(): Promise<typeof import("./tailnet-publishing.ts")> {
  return import("./tailnet-publishing.ts");
}

@Injectable()
export class TailnetPublishingHostedWorker implements CronHostedWorker {
  readonly kind = "cron" as const;
  readonly workerName = TAILNET_PUBLISHING_HOSTED_WORKER_NAME;
  readonly cronExpression = CronExpression.EVERY_MINUTE;
  readonly runsAtStart = true;

  private previousRunIsStillGoing = false;

  constructor(
    @Optional() private readonly dependencies: TailnetPublishingDependencies = productionTailnetPublishingDependencies(),
  ) {}

  async runOnce(): Promise<void> {
    if (this.previousRunIsStillGoing) return;
    this.previousRunIsStillGoing = true;
    try {
      const { publishWantedTailnetRoutes } = await loadTailnetPublishing();
      await publishWantedTailnetRoutes(this.dependencies);
    } catch (error) {
      this.dependencies.log(`nothing published this run: ${errorText(error)}`);
    } finally {
      this.previousRunIsStillGoing = false;
    }
  }
}

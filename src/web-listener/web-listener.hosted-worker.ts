import { Injectable, Optional } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { LongLivedHostedWorker } from "../throne-backend/hosted-worker.types.ts";
import { errorText } from "../shared-policy/error-text.ts";
import { RUNTIME_THRONE_ROOT } from "../shared-policy/runtime-throne-root.ts";
import { webListenerPort } from "./web-listener-address.ts";
import type { WebListenerOptions } from "./web-listener-app.ts";

export const WEB_LISTENER_HOSTED_WORKER_NAME = "web-listener";

const STOP_CHECK_INTERVAL_MS = 200;

export interface WebListenerDependencies extends WebListenerOptions {
  readonly log: (message: string) => void;
}

function productionDependencies(): WebListenerDependencies {
  return {
    port: webListenerPort(),
    webRoot: path.join(RUNTIME_THRONE_ROOT, "dist", "web"),
    log: (message) => console.log(`[${WEB_LISTENER_HOSTED_WORKER_NAME}] ${message}`),
  };
}

function loadWebListenerApp(): Promise<typeof import("./web-listener-app.ts")> {
  return import("./web-listener-app.ts");
}

@Injectable()
export class WebListenerHostedWorker implements LongLivedHostedWorker {
  readonly kind = "long-lived" as const;
  readonly workerName = WEB_LISTENER_HOSTED_WORKER_NAME;

  constructor(@Optional() private readonly dependencies: WebListenerDependencies = productionDependencies()) {}

  async start(shouldStop: () => boolean): Promise<void> {
    const { log, port } = this.dependencies;
    let listener: NestExpressApplication;
    try {
      const { startWebListener } = await loadWebListenerApp();
      listener = await startWebListener(this.dependencies);
    } catch (error) {
      log(`not listening on port ${port}: ${errorText(error)}`);
      return;
    }
    while (!shouldStop()) {
      await sleep(STOP_CHECK_INTERVAL_MS);
    }
    await listener.close();
  }
}
